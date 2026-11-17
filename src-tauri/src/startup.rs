//! A failed native window must produce an actionable error, not a silent exit.
//! These reports stay on this computer; they contain no account or workspace data.
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

fn data_dir() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MEMCODE_DATA_DIR").map(PathBuf::from) {
        return path.is_absolute().then_some(path);
    }
    std::env::var_os("APPDATA").map(|path| PathBuf::from(path).join("MemCode"))
}

pub fn record(stage: &str, error: &str) -> Option<PathBuf> {
    let directory = data_dir()?.join("diagnostics");
    fs::create_dir_all(&directory).ok()?;
    let path = directory.join("native-startup.json");
    // Refuse a redirected report file. A report must not overwrite another file.
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return None;
    }
    let executable = std::env::current_exe().ok();
    let resources = executable.as_deref().and_then(|path| path.parent());
    let report = json!({
        "product": "MemCode", "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS, "architecture": std::env::consts::ARCH,
        "capturedAtUnixMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
        "stage": stage, "error": error.chars().take(4096).collect::<String>(),
        "executable": executable,
        "bundledNodePresent": resources.is_some_and(|path| path.join("desktop-runtime/node.exe").is_file()),
        "localRuntimePresent": resources.is_some_and(|path| path.join("runtime/service.cjs").is_file()),
        "uploaded": false
    });
    fs::write(&path, serde_json::to_vec_pretty(&report).ok()?).ok()?;
    Some(path)
}

pub fn fatal(error: &str) {
    let report = record("native-window", error);
    eprintln!("MemCode could not open its native window: {error}");
    // Acceptance runs intentionally exercise a broken WebView2 environment.
    // Do not leave a blocking native dialog in an isolated unattended test.
    if std::env::var("MEMCODE_NATIVE_TEST_PROFILE").as_deref() == Ok("1")
        && std::env::var_os("MEMCODE_DATA_DIR")
            .map(PathBuf::from)
            .is_some_and(|path| path.is_absolute())
    {
        return;
    }
    let report_message = report
        .map(|path| format!("Startup report: {}", path.display()))
        .unwrap_or_else(|| "A startup report could not be saved.".into());
    let message = format!(
        "MemCode could not open its desktop window.\n\n{}\n\nRun the MemCode installer again to repair the application. Your projects and settings are kept separately.\n\n{report_message}",
        error.chars().take(1200).collect::<String>()
    );
    rfd::MessageDialog::new()
        .set_title("MemCode could not start")
        .set_level(rfd::MessageLevel::Error)
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}
