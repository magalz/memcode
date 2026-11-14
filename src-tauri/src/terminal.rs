//! Local PTYs outlive a harness turn and are shared by the worker and card UI.
use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};

const BUFFER_LIMIT: usize = 512 * 1024;
#[derive(Default)]
struct Output {
    seq: u64,
    bytes: usize,
    chunks: VecDeque<(u64, Vec<u8>)>,
    exit: Option<u32>,
}
struct Session {
    meta: Value,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    output: Mutex<Output>,
}
#[derive(Clone, Default)]
pub struct TerminalState(Arc<Mutex<HashMap<String, Arc<Session>>>>);

fn lock<T>(value: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    value
        .lock()
        .map_err(|_| "Terminal state is unavailable.".into())
}
fn required<'a>(input: &'a Value, key: &str) -> Result<&'a str, String> {
    input[key]
        .as_str()
        .ok_or_else(|| format!("Missing terminal {key}."))
}
fn size(input: &Value) -> Result<PtySize, String> {
    let cols = input["cols"].as_u64().unwrap_or(110);
    let rows = input["rows"].as_u64().unwrap_or(28);
    if !(20..=400).contains(&cols) || !(5..=200).contains(&rows) {
        return Err("Terminal size is outside supported bounds.".into());
    }
    Ok(PtySize {
        rows: rows as u16,
        cols: cols as u16,
        pixel_width: 0,
        pixel_height: 0,
    })
}
fn metadata(session: &Session) -> Result<Value, String> {
    let output = lock(&session.output)?;
    let mut meta = session.meta.clone();
    meta["seq"] = json!(output.seq);
    meta["status"] = json!(if output.exit.is_some() {
        "exited"
    } else {
        "running"
    });
    if let Some(code) = output.exit {
        meta["exitCode"] = json!(code);
    }
    Ok(meta)
}
fn stop(session: &Session) -> Result<(), String> {
    if lock(&session.output)?.exit.is_some() {
        return Ok(());
    }
    #[cfg(windows)]
    if let Some(pid) = session.meta["pid"].as_u64() {
        use std::os::windows::process::CommandExt;
        // Only a PID created and still owned by this PTY is accepted.
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .output();
    }
    lock(&session.killer)?.kill().map_err(|e| e.to_string())
}

pub async fn call(app: AppHandle, method: &str, input: Value) -> Result<Value, String> {
    let state = app.state::<TerminalState>().inner().clone();
    let method = method.to_owned();
    tauri::async_runtime::spawn_blocking(move || operate(app, state, &method, input))
        .await
        .map_err(|e| e.to_string())?
}
fn operate(
    app: AppHandle,
    state: TerminalState,
    method: &str,
    input: Value,
) -> Result<Value, String> {
    if method == "terminal_close_all" {
        let sessions: Vec<_> = lock(&state.0)?.values().cloned().collect();
        for session in sessions {
            let _ = stop(&session);
        }
        lock(&state.0)?.clear();
        return Ok(Value::Null);
    }
    let task_id = required(&input, "taskId")?.to_owned();
    if method == "terminal_list" {
        let list: Result<Vec<_>, _> = lock(&state.0)?
            .values()
            .filter(|s| s.meta["taskId"] == task_id)
            .map(|s| metadata(s))
            .collect();
        return Ok(json!(list?));
    }
    if method == "terminal_start" {
        let id = required(&input, "id")?.to_owned();
        let cwd = required(&input, "cwd")?;
        let program = required(&input, "program")?;
        if id.len() > 100
            || task_id.len() > 200
            || !std::path::Path::new(cwd).is_dir()
            || !std::path::Path::new(program).is_file()
        {
            return Err("Invalid terminal session, folder or executable.".into());
        }
        let mut all = lock(&state.0)?;
        if all.contains_key(&id) {
            return Err("Terminal session already exists.".into());
        }
        if all.len() >= 256 {
            return Err(
                "Close an unused terminal before keeping another session in memory.".into(),
            );
        }
        let active: Vec<_> = all
            .values()
            .filter(|s| lock(&s.output).map(|o| o.exit.is_none()).unwrap_or(false))
            .collect();
        if active.len() >= 64
            || active
                .iter()
                .filter(|s| s.meta["taskId"] == task_id)
                .count()
                >= 8
        {
            return Err("Close an unused terminal before starting another session.".into());
        }
        let pair = native_pty_system()
            .openpty(size(&input)?)
            .map_err(|e| e.to_string())?;
        let mut command = CommandBuilder::new(program);
        let args: Vec<String> = input["args"]
            .as_array()
            .ok_or("Missing terminal arguments.")?
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .ok_or("Invalid terminal argument.")
            })
            .collect::<Result<_, _>>()?;
        command.args(&args);
        command.cwd(cwd);
        command.env_remove("CODEX_WINDOWS_REGISTERED_CORE");
        command.env_remove("CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY");
        command.env_remove("ELECTRON_RUN_AS_NODE");
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        if let Some(env) = input["env"].as_object() {
            for (key, value) in env {
                if let Some(value) = value.as_str() {
                    command.env(key, value);
                }
            }
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("Could not start terminal: {e}"))?;
        drop(pair.slave);
        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let meta = json!({
            "id":id,"taskId":task_id,"pid":pid,"cwd":cwd,"command":std::iter::once(program.to_owned()).chain(args).collect::<Vec<_>>(),
            "label":input["label"],"origin":input["origin"],"startedAt":input["startedAt"],"status":"running","seq":0
        });
        let session = Arc::new(Session {
            meta,
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            output: Mutex::new(Output::default()),
        });
        all.insert(id.clone(), session.clone());
        drop(all);
        let output_session = session.clone();
        let output_app = app.clone();
        let output_id = id.clone();
        let output_task = task_id.clone();
        std::thread::spawn(move || {
            let mut bytes = [0u8; 8192];
            let mut initial = Vec::new();
            let mut handshake = false;
            loop {
                let count = match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let data = if !handshake {
                    initial.extend_from_slice(&bytes[..count]);
                    // ConPTY waits for a cursor report even when no card UI is mounted.
                    // A new private PTY starts at row 1, column 1. Consume this one
                    // startup query so a later xterm attachment cannot answer it twice.
                    let query = b"\x1b[6n";
                    if initial.len() < query.len() && query.starts_with(&initial) {
                        continue;
                    }
                    handshake = true;
                    if initial.starts_with(query) {
                        if let Ok(mut writer) = output_session.writer.lock() {
                            let _ = writer.write_all(b"\x1b[1;1R").and_then(|_| writer.flush());
                        }
                        initial.drain(..query.len());
                    }
                    std::mem::take(&mut initial)
                } else {
                    bytes[..count].to_vec()
                };
                if data.is_empty() {
                    continue;
                }
                let seq = if let Ok(mut output) = output_session.output.lock() {
                    output.seq += 1;
                    let seq = output.seq;
                    output.bytes += data.len();
                    output.chunks.push_back((seq, data.clone()));
                    while output.bytes > BUFFER_LIMIT {
                        if let Some((_, old)) = output.chunks.pop_front() {
                            output.bytes -= old.len();
                        }
                    }
                    seq
                } else {
                    break;
                };
                let _ = output_app.emit_to("main", "terminal:output", json!({
                    "taskId":output_task,"sessionId":output_id,"seq":seq,"data":STANDARD.encode(&data)
                }));
            }
        });
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
            let seq = if let Ok(mut output) = session.output.lock() {
                output.exit = Some(code);
                output.seq
            } else {
                0
            };
            let _ = app.emit_to("main","terminal:output",json!({"taskId":task_id,"sessionId":id,"seq":seq,"status":"exited","exitCode":code}));
        });
        return metadata(all_session(&state, &input)?.as_ref());
    }
    let session = all_session(&state, &input)?;
    match method {
        "terminal_observe" => {
            let meta = metadata(&session)?;
            let output = lock(&session.output)?;
            let after = input["after"].as_u64().unwrap_or(0);
            let chunks: Vec<_> = output
                .chunks
                .iter()
                .filter(|(seq, _)| *seq > after)
                .map(|(seq, data)| json!({"seq":seq,"data":STANDARD.encode(data)}))
                .collect();
            Ok(
                json!({"session":meta,"chunks":chunks,"truncated":output.chunks.front().map(|(n,_)| after+1 < *n).unwrap_or(false)}),
            )
        }
        "terminal_write" => {
            if lock(&session.output)?.exit.is_some() {
                return Err("This terminal has exited.".into());
            }
            let bytes = STANDARD
                .decode(required(&input, "data")?)
                .map_err(|_| "Invalid terminal input.")?;
            if bytes.len() > 65536 {
                return Err("Terminal input is too large.".into());
            }
            let mut writer = lock(&session.writer)?;
            writer
                .write_all(&bytes)
                .and_then(|_| writer.flush())
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal_resize" => {
            lock(&session.master)?
                .resize(size(&input)?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "terminal_stop" => {
            stop(&session)?;
            Ok(Value::Null)
        }
        "terminal_close" => {
            stop(&session)?;
            lock(&state.0)?.remove(required(&input, "sessionId")?);
            Ok(Value::Null)
        }
        _ => Err("Unknown terminal operation.".into()),
    }
}
fn all_session(state: &TerminalState, input: &Value) -> Result<Arc<Session>, String> {
    let id = input["sessionId"]
        .as_str()
        .or(input["id"].as_str())
        .ok_or("Missing terminal session.")?;
    let session = lock(&state.0)?
        .get(id)
        .cloned()
        .ok_or("Terminal session was not found.")?;
    if session.meta["taskId"] != input["taskId"] {
        return Err("Terminal belongs to another work item.".into());
    }
    Ok(session)
}
