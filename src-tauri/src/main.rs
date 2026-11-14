#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod browser;
#[cfg(windows)]
mod browser_capture;
mod native;
mod terminal;

use bridge::RuntimeBridge;
use serde_json::Value;
use tauri::{Manager, Webview, WindowEvent};

#[tauri::command]
async fn rpc(
    webview: Webview,
    runtime: tauri::State<'_, RuntimeBridge>,
    method: String,
    input: Option<Value>,
) -> Result<Value, String> {
    // Main navigation is pinned to main_origin below and capabilities exclude
    // guests. Querying CoreWebView2's live URL on every RPC adds a synchronous
    // UI-thread hop, which can block replies during native browser operations.
    if webview.label() != "main" {
        return Err("Only the MemCode application view can call the local runtime.".into());
    }
    if method.len() > 100 || method == "runtime:shutdown" {
        return Err("This runtime operation is not exposed to the renderer.".into());
    }
    runtime.request(&method, input.unwrap_or(Value::Null)).await
}

fn main() {
    let browser = browser::BrowserState::new();
    let runtime = RuntimeBridge::new();
    tauri::Builder::default()
        .manage(runtime)
        .manage(native::PreviewState::default())
        .manage(browser)
        .manage(terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![rpc])
        .setup(|app| {
            let handle = app.handle().clone();
            let config = app
                .config()
                .app
                .windows
                .first()
                .ok_or("Missing main window configuration")?
                .clone();
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .focused(std::env::var_os("MEMCODE_NATIVE_TEST_PROFILE").is_none())
                .data_directory(native::profile_dir(app.handle()).map_err(std::io::Error::other)?)
                .on_navigation(native::main_origin)
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .disable_drag_drop_handler()
                .build()?;
            let runtime = app.state::<RuntimeBridge>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = runtime.launch(handle.clone()).await {
                    runtime.fail(error).await;
                }
                if let Some(window) = handle.get_window("main") {
                    let _ = window.show();
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let runtime = app.state::<RuntimeBridge>().inner().clone();
                if !runtime.is_closing() {
                    tauri::async_runtime::spawn(async move {
                        runtime.shutdown().await;
                        app.exit(0);
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("MemCode could not start its native desktop shell");
}
