//! Only the application webview can request signed desktop updates.
use crate::bridge::RuntimeBridge;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct UpdateState {
    operation: tokio::sync::Mutex<()>,
    pending: Mutex<Option<Update>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    development: bool,
    previous_error: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PreviousFailure {
    version: String,
    message: String,
}

fn failure_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::native::profile_dir(app)?.join("last-update-failure.json"))
}

fn previous_failure(app: &AppHandle) -> Option<String> {
    let path = failure_path(app).ok()?;
    if std::fs::metadata(&path).ok()?.len() > 4096 {
        return None;
    }
    let failure: PreviousFailure =
        serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    (failure.version == app.package_info().version.to_string())
        .then(|| failure.message.chars().take(1000).collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    version: String,
    notes: String,
    published_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

fn main_only(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("Only the MemCode application may manage updates.".into());
    }
    Ok(())
}

fn development() -> bool {
    cfg!(debug_assertions)
        || std::env::var_os("MEMCODE_NATIVE_TEST_PROFILE").is_some()
        || std::env::var_os("MEMCODE_APP_PATH").is_some()
        || std::env::var_os("MEMCODE_SERVICE_PATH").is_some()
}

fn installed_only() -> Result<(), String> {
    if development() {
        return Err("Development builds update through Git. Install a beta release to use signed app updates.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn app_update_info(webview: Webview, app: AppHandle) -> Result<UpdateInfo, String> {
    main_only(&webview)?;
    Ok(UpdateInfo {
        current_version: app.package_info().version.to_string(),
        development: development(),
        previous_error: previous_failure(&app),
    })
}

#[tauri::command]
pub async fn app_update_context(
    webview: Webview,
    runtime: tauri::State<'_, RuntimeBridge>,
    terminals: tauri::State<'_, crate::terminal::TerminalState>,
) -> Result<Value, String> {
    main_only(&webview)?;
    let mut context = runtime.request("app:update-context", Value::Null).await?;
    context["activeTerminals"] = serde_json::json!(terminals.active_count()?);
    Ok(context)
}

#[tauri::command]
pub async fn app_update_history(
    webview: Webview,
    runtime: tauri::State<'_, RuntimeBridge>,
) -> Result<Value, String> {
    main_only(&webview)?;
    runtime.request("app:update-history", Value::Null).await
}

#[tauri::command]
pub async fn app_update_check(
    webview: Webview,
    app: AppHandle,
    state: tauri::State<'_, UpdateState>,
    runtime: tauri::State<'_, RuntimeBridge>,
) -> Result<Option<Release>, String> {
    main_only(&webview)?;
    installed_only()?;
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    // A failed recheck must not leave an older announcement installable.
    *state
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")? = None;
    let runtime = runtime.inner().clone();
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(20))
        .on_before_exit(move || {
            // Windows closes this process within install(). Its upstream hook
            // runs before ShellExecuteW, so a launch failure must restart the
            // current app below rather than leave its sidecar stopped.
            tauri::async_runtime::block_on(runtime.shutdown());
        })
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(update) = &update {
        if update.download_url.scheme() != "https"
            || !update.download_url.username().is_empty()
            || update.download_url.password().is_some()
        {
            return Err("The release did not provide a secure download address.".into());
        }
    }
    let release = update.as_ref().map(|update| Release {
        version: update.version.clone(),
        notes: update
            .body
            .as_deref()
            .unwrap_or("")
            .chars()
            .take(32_000)
            .collect(),
        published_at: update
            .raw_json
            .get("pub_date")
            .and_then(Value::as_str)
            .map(str::to_owned),
    });
    *state
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")? = update;
    if let Ok(path) = failure_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    Ok(release)
}

#[tauri::command]
pub async fn app_update_install(
    webview: Webview,
    app: AppHandle,
    state: tauri::State<'_, UpdateState>,
    runtime: tauri::State<'_, RuntimeBridge>,
    version: String,
    channel: tauri::ipc::Channel<Progress>,
) -> Result<(), String> {
    main_only(&webview)?;
    installed_only()?;
    let _operation = state
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    let mut update = state
        .pending
        .lock()
        .map_err(|_| "Update state is unavailable.")?
        .as_ref()
        .filter(|update| update.version == version)
        .cloned()
        .ok_or("Check for this update again before installing it.")?;
    runtime.request("app:update-preflight", Value::Null).await?;
    update.timeout = Some(Duration::from_secs(300));
    let mut downloaded = 0_u64;
    let mut last = Instant::now();
    let progress = channel.clone();
    let _ = channel.send(Progress {
        phase: "downloading",
        downloaded: 0,
        total: None,
    });
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                if last.elapsed() >= Duration::from_millis(150) {
                    let _ = progress.send(Progress {
                        phase: "downloading",
                        downloaded,
                        total,
                    });
                    last = Instant::now();
                }
            },
            || {
                let _ = channel.send(Progress {
                    phase: "verifying",
                    downloaded: 0,
                    total: None,
                });
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    // A worker could have started during the download. Reserve the idle
    // runtime only after signature verification; this also gates queued starts.
    runtime.request("app:update-prepare", Value::Null).await?;
    let _ = channel.send(Progress {
        phase: "installing",
        downloaded: bytes.len() as u64,
        total: Some(bytes.len() as u64),
    });
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| e.to_string())
        .and_then(|result| result.map_err(|e| e.to_string()));
    if let Err(error) = installed {
        if runtime.is_closing() {
            let version = app.package_info().version.to_string();
            let failure = PreviousFailure { version: version.clone(), message: format!("The update could not be installed. MemCode reopened version {version}; saved work is preserved. {}", error.chars().take(600).collect::<String>()) };
            if let (Ok(path), Ok(json)) = (failure_path(&app), serde_json::to_vec(&failure)) {
                let _ = std::fs::write(path, json);
            }
            app.restart();
        }
        let _ = runtime.request("app:update-release", Value::Null).await;
        return Err(error);
    }
    // Windows exits within install(); macOS/Linux must close and relaunch.
    runtime.shutdown().await;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture_update(fixture: &Value, public_key: &str, version: &str) -> Update {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert("updater".into(), json!({
            "pubkey": public_key,
            "requireSignedVersion": true,
            "endpoints": ["https://www.memtrace.io/api/memcode/updates/{{target}}/{{arch}}/{{current_version}}"]
        }));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap();
        app.updater_builder()
            .build()
            .unwrap()
            .restore_update(json!({
                "version": version,
                "url": "https://example.invalid/signed-test-fixture.exe",
                "signature": fixture["signature"],
                "notes": "Synthetic test fixture; never installed or downloaded."
            }))
            .unwrap()
            .unwrap()
    }

    #[test]
    fn updater_verifies_real_signature_and_rejects_tampering_wrong_key_and_manifest_version() {
        // Generated by the actual Tauri signer using a discarded ephemeral
        // test key. This exercises the real plugin verifier, never an installer.
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/updater-signature.json"))
                .unwrap();
        let bytes = fixture["payload"].as_str().unwrap().as_bytes();
        let key = fixture["publicKey"].as_str().unwrap();
        let version = fixture["version"].as_str().unwrap();
        let update = fixture_update(&fixture, key, version);
        update
            .verify(bytes)
            .expect("Actual signer and updater must interoperate");
        assert!(update.verify(b"Tampered updater payload").is_err());
        let changed_version = fixture_update(&fixture, key, "0.4.0-beta.3");
        assert!(
            changed_version.verify(bytes).is_err(),
            "A manifest cannot relabel a signed older payload"
        );
        let production: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let wrong_key = fixture_update(
            &fixture,
            production["plugins"]["updater"]["pubkey"].as_str().unwrap(),
            version,
        );
        assert!(
            wrong_key.verify(bytes).is_err(),
            "An unrelated signing key must not be trusted"
        );
    }

    #[test]
    #[ignore = "Explicit release-candidate check; requires a real updater payload and its .sig file"]
    fn updater_verifies_packaged_candidate() {
        let path = std::path::PathBuf::from(
            std::env::var_os("MEMCODE_CANDIDATE_UPDATER")
                .expect("Provide the actual candidate updater path"),
        );
        assert!(path.is_absolute(), "Use an absolute candidate path");
        let bytes = std::fs::read(&path).expect("Candidate payload must exist");
        assert!(!bytes.is_empty(), "Candidate payload cannot be empty");
        let signature = std::fs::read_to_string(format!("{}.sig", path.display()))
            .expect("Candidate signature must exist");
        let production: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let key = production["plugins"]["updater"]["pubkey"].as_str().unwrap();
        let version = env!("CARGO_PKG_VERSION");
        assert_eq!(production["version"], version);
        let fixture = json!({"signature":signature.trim()});
        let update = fixture_update(&fixture, key, version);
        update
            .verify(&bytes)
            .expect("Actual artifact must verify against this release's public key and version");
        let mut changed = bytes.clone();
        changed[0] ^= 1;
        assert!(
            update.verify(&changed).is_err(),
            "Altered artifact must fail verification"
        );
        let relabelled = fixture_update(&fixture, key, "0.4.0-beta.999999");
        assert!(
            relabelled.verify(&bytes).is_err(),
            "Signed artifact cannot be relabelled as a different version"
        );
        let other: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/updater-signature.json"))
                .unwrap();
        let wrong_key = fixture_update(&fixture, other["publicKey"].as_str().unwrap(), version);
        assert!(
            wrong_key.verify(&bytes).is_err(),
            "Unrelated key must fail verification"
        );
        println!("Verified actual candidate payload ({} bytes), version {}, tamper rejection, key binding and version binding; no installation performed.",bytes.len(),version);
    }
}
