use base64::Engine;
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc};
use tokio::sync::oneshot;
use webview2_com::{
    CapturePreviewCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    },
};
use windows::Win32::{
    Foundation::HGLOBAL,
    System::Com::{
        IStream, StructuredStorage::CreateStreamOnHGlobal, STATFLAG_NONAME, STATSTG,
        STREAM_SEEK_SET,
    },
};

type Reply = oneshot::Sender<Result<Value, String>>;
fn read_stream(stream: &IStream, input: &Value) -> Result<Value, String> {
    let mut info = STATSTG::default();
    unsafe {
        stream
            .Stat(&mut info, STATFLAG_NONAME)
            .map_err(|e| e.to_string())?;
    }
    if info.cbSize > 24 * 1024 * 1024 {
        return Err("Native browser capture exceeds 24 MiB".into());
    }
    let mut bytes = vec![0u8; info.cbSize as usize];
    let mut read = 0u32;
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|e| e.to_string())?;
        stream
            .Read(bytes.as_mut_ptr() as _, bytes.len() as u32, Some(&mut read))
            .ok()
            .map_err(|e| e.to_string())?;
    }
    bytes.truncate(read as usize);
    if input["scale"] == "css" {
        let width = input["width"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 10000)
            .ok_or("Invalid browser capture width")? as u32;
        let height = input["height"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 10000)
            .ok_or("Invalid browser capture height")? as u32;
        let image = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        if image.width() != width || image.height() != height {
            let mut out = std::io::Cursor::new(Vec::new());
            image
                .resize_exact(width, height, image::imageops::FilterType::Lanczos3)
                .write_to(&mut out, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            bytes = out.into_inner();
        }
    }
    Ok(json!({"data":base64::engine::general_purpose::STANDARD.encode(bytes)}))
}
pub fn capture(core: ICoreWebView2, input: Value, reply: Reply, finished: Box<dyn FnOnce()>) {
    let sender = Rc::new(RefCell::new(Some(reply)));
    let callback_sender = sender.clone();
    let cleanup = Rc::new(RefCell::new(Some(finished)));
    let callback_cleanup = cleanup.clone();
    let started = (|| -> Result<(), String> {
        let stream =
            unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true).map_err(|e| e.to_string())? };
        let output = stream.clone();
        let handler = CapturePreviewCompletedHandler::create(Box::new(move |status| {
            let result = status
                .map_err(|e| e.to_string())
                .and_then(|_| read_stream(&output, &input));
            if let Some(finished) = callback_cleanup.borrow_mut().take() {
                finished();
            }
            if let Some(reply) = callback_sender.borrow_mut().take() {
                let _ = reply.send(result);
            }
            Ok(())
        }));
        unsafe {
            core.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(error) = started {
        if let Some(finished) = cleanup.borrow_mut().take() {
            finished();
        }
        if let Some(reply) = sender.borrow_mut().take() {
            let _ = reply.send(Err(error));
        }
    }
}
