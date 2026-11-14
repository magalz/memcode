use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{
    webview::{NewWindowResponse, PermissionResponse, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
};

#[derive(Clone, Copy, Default, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Default)]
pub struct PreviewState(
    pub Mutex<Option<(String, Bounds)>>,
    pub std::sync::atomic::AtomicBool,
);

pub fn profile_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(std::env::var_os("MEMCODE_DATA_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or(
            app.path()
                .config_dir()
                .map_err(|e| e.to_string())?
                .join("MemCode"),
        )
        .join("webview"))
}

pub fn main_origin(url: &Url) -> bool {
    matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost"))
            | ("http", Some("tauri.localhost"))
            | ("https", Some("tauri.localhost"))
    ) || (cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(5197))
}

fn loopback(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
        && url.username().is_empty()
        && url.password().is_none()
}

pub async fn host_call(app: AppHandle, method: &str, input: Value) -> Result<Value, String> {
    if method.starts_with("terminal_") {
        return crate::terminal::call(app, method, input).await;
    }
    if method.starts_with("browser_") {
        return crate::browser::call(app, method, input).await;
    }
    match method {
        "select_folder" => {
            let selected = tauri::async_runtime::spawn_blocking(|| {
                rfd::FileDialog::new()
                    .set_title("Choose a MemCode project folder")
                    .pick_folder()
            })
            .await
            .map_err(|e| e.to_string())?;
            Ok(selected
                .map(|p| json!(p.to_string_lossy()))
                .unwrap_or(Value::Null))
        }
        "window_action" => {
            // A preview makes this a multi-webview window. WebviewWindow lookup
            // only succeeds for windows containing a single matching webview.
            let window = app.get_window("main").ok_or("Main window is unavailable")?;
            match input["action"].as_str() {
                Some("minimize") => window.minimize().map_err(|e| e.to_string())?,
                Some("maximize") => {
                    if window.is_maximized().map_err(|e| e.to_string())? {
                        window.unmaximize().map_err(|e| e.to_string())?
                    } else {
                        window.maximize().map_err(|e| e.to_string())?
                    }
                }
                Some("close") => {
                    let _ = window.close();
                }
                _ => return Err("Unknown window action".into()),
            }
            Ok(Value::Null)
        }
        "open_path" => {
            let path = input["path"]
                .as_str()
                .ok_or("Missing folder path")?
                .to_owned();
            if !std::path::Path::new(&path).is_dir() {
                return Err("The project folder no longer exists".into());
            }
            tauri::async_runtime::spawn_blocking(move || open_folder(&path))
                .await
                .map_err(|e| e.to_string())??;
            Ok(Value::Null)
        }
        "preview_show" => {
            show_preview(&app, input).await?;
            Ok(Value::Null)
        }
        "preview_hide" => {
            if let Some(view) = app.get_webview("preview") {
                view.hide().map_err(|e| e.to_string())?;
            }
            app.state::<PreviewState>()
                .1
                .store(false, std::sync::atomic::Ordering::SeqCst);
            Ok(Value::Null)
        }
        "preview_action" => {
            let view = app
                .get_webview("preview")
                .ok_or("Open a local preview first")?;
            let script = match input["action"].as_str() {
                Some("back") => "history.back()",
                Some("forward") => "history.forward()",
                Some("reload") => "location.reload()",
                _ => return Err("Unknown preview action".into()),
            };
            view.eval(script).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "preview_capture" => {
            if !app
                .state::<PreviewState>()
                .1
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err("Open a visible preview before capturing it".into());
            }
            let bounds = input
                .get("bounds")
                .cloned()
                .filter(|v| !v.is_null())
                .map(serde_json::from_value)
                .transpose()
                .map_err(|e| e.to_string())?
                .or_else(|| {
                    app.state::<PreviewState>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|state| state.as_ref().map(|(_, bounds)| *bounds))
                })
                .ok_or("Open a visible preview first")?;
            let app_copy = app.clone();
            let png =
                tauri::async_runtime::spawn_blocking(move || capture_visible(&app_copy, bounds))
                    .await
                    .map_err(|e| e.to_string())??;
            Ok(json!({"pngBase64":base64::engine::general_purpose::STANDARD.encode(png)}))
        }
        _ => Err(format!("Unknown native host operation: {method}")),
    }
}

async fn show_preview(app: &AppHandle, input: Value) -> Result<(), String> {
    let url: Url = input["url"]
        .as_str()
        .ok_or("Missing preview URL")?
        .parse()
        .map_err(|_| "Invalid preview URL")?;
    if !loopback(&url) {
        return Err(
            "Preview navigation is limited to local development and artifact content".into(),
        );
    }
    let bounds: Bounds =
        serde_json::from_value(input["bounds"].clone()).map_err(|e| e.to_string())?;
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|n| n.is_finite())
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width < 1.0
        || bounds.height < 1.0
        || bounds.width > 10000.0
        || bounds.height > 10000.0
    {
        return Err("Invalid preview bounds".into());
    }
    let previous = app
        .state::<PreviewState>()
        .0
        .lock()
        .map_err(|_| "Preview state is unavailable")?
        .clone();
    if let Some(view) = app.get_webview("preview") {
        view.set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|e| e.to_string())?;
        view.set_size(LogicalSize::new(bounds.width, bounds.height))
            .map_err(|e| e.to_string())?;
        if previous.as_ref().map(|(previous, _)| previous.as_str()) != Some(url.as_str()) {
            view.navigate(url.clone()).map_err(|e| e.to_string())?;
        }
        view.show().map_err(|e| e.to_string())?;
    } else {
        let window = app.get_window("main").ok_or("Main window is unavailable")?;
        let titles = app.clone();
        let pages = app.clone();
        let builder=WebviewBuilder::new("preview",WebviewUrl::External(url.clone()))
            .data_directory(profile_dir(app)?)
            .disable_drag_drop_handler()
            .on_navigation(loopback)
            .on_new_window(|_,_|NewWindowResponse::Deny)
            .on_permission_request(|_,_|PermissionResponse::Deny)
            .on_download(|_,_|false)
            .on_document_title_changed(move |view,title|{let _=titles.emit_to(tauri::EventTarget::Webview {label:"main".into()},"preview:event",json!({"url":view.url().ok().map(|url|url.to_string()).unwrap_or_default(),"title":title}));})
            .on_page_load(move |view,payload|{let _=pages.emit_to(tauri::EventTarget::Webview {label:"main".into()},"preview:event",json!({"url":payload.url().to_string(),"title":"Local preview","event":format!("{:?}",payload.event()),"view":view.label()}));});
        window
            .add_child(
                builder,
                LogicalPosition::new(bounds.x, bounds.y),
                LogicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|e| e.to_string())?;
    }
    *app.state::<PreviewState>()
        .0
        .lock()
        .map_err(|_| "Preview state is unavailable")? = Some((url.to_string(), bounds));
    app.state::<PreviewState>()
        .1
        .store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

fn open_folder(path: &str) -> Result<(), String> {
    let mut command = std::process::Command::new(if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    });
    command.arg(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn capture_visible(app: &AppHandle, bounds: Bounds) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::POINT, Graphics::Gdi::*};
    let window = app.get_window("main").ok_or("Main window is unavailable")?;
    window.set_focus().map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(100));
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
    if unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() } != hwnd {
        return Err("Bring MemCode to the foreground before capturing its visible preview".into());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let x = (bounds.x * scale).round().max(0.0) as i32;
    let y = (bounds.y * scale).round().max(0.0) as i32;
    let width = (bounds.width * scale)
        .round()
        .min((size.width as i32 - x).max(0) as f64) as i32;
    let height = (bounds.height * scale)
        .round()
        .min((size.height as i32 - y).max(0) as f64) as i32;
    if width < 1 || height < 1 || width > 12000 || height > 12000 {
        return Err("The visible preview has no capturable area".into());
    }
    let mut origin = POINT { x: 0, y: 0 };
    // Capture the visible native preview region. This deliberately does not claim
    // to capture hidden/occluded content or a page larger than its viewport.
    unsafe {
        if ClientToScreen(hwnd, &mut origin) == 0 {
            return Err("Could not locate the preview on screen".into());
        }
        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("Could not access the screen surface".into());
        }
        let memory = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width, height);
        if memory.is_null() || bitmap.is_null() {
            if !memory.is_null() {
                DeleteDC(memory);
            }
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            ReleaseDC(std::ptr::null_mut(), screen);
            return Err("Could not allocate the preview capture".into());
        }
        let previous = SelectObject(memory, bitmap);
        let copied = BitBlt(
            memory,
            0,
            0,
            width,
            height,
            screen,
            origin.x + x,
            origin.y + y,
            SRCCOPY | CAPTUREBLT,
        );
        // GetDIBits requires the bitmap to be unselected from the device context.
        SelectObject(memory, previous);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width;
        info.bmiHeader.biHeight = -height;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let rows = if copied != 0 {
            GetDIBits(
                memory,
                bitmap,
                0,
                height as u32,
                pixels.as_mut_ptr() as _,
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut(), screen);
        if rows == 0 {
            return Err(
                "The preview could not be captured. Bring MemCode into view and try again.".into(),
            );
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        let image = image::RgbaImage::from_raw(width as u32, height as u32, pixels)
            .ok_or("Invalid capture pixels")?;
        let mut output = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut output, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(output.into_inner())
    }
}
#[cfg(not(windows))]
fn capture_visible(_app: &AppHandle, _bounds: Bounds) -> Result<Vec<u8>, String> {
    Err("Native visible-preview capture is currently implemented for Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn application_origin_is_exact() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/index.html",
        ] {
            assert!(main_origin(&url.parse().unwrap()));
        }
        for url in [
            "https://example.com",
            "http://tauri.localhost.evil/index.html",
            "http://127.0.0.1:9328",
            "file:///C:/secret",
        ] {
            assert!(!main_origin(&url.parse().unwrap()));
        }
    }
    #[test]
    fn preview_accepts_only_credential_free_loopback() {
        for url in [
            "http://localhost:3000",
            "http://127.0.0.1:8080/path",
            "http://[::1]:8080",
        ] {
            assert!(loopback(&url.parse().unwrap()));
        }
        for url in [
            "https://example.com",
            "http://localhost.evil",
            "http://user:pass@localhost:8080",
            "file:///C:/secret",
            "javascript:alert(1)",
        ] {
            assert!(!loopback(&url.parse().unwrap()));
        }
    }
}
