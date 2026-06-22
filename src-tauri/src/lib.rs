use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// 本地资产 HTTP 服务状态：仅服务"显式登记过"的 id→本地文件（安全，无路径穿越）。
#[derive(Clone)]
struct AssetServer {
    base: String,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
}

/// 返回本地资产服务基址（如 http://127.0.0.1:54321）；前端拖出软件外时拼 /a/<id>。
#[tauri::command]
fn asset_http_base(state: tauri::State<AssetServer>) -> String {
    state.base.clone()
}

/// 登记 id→本地原件路径，供 /a/<id> 取字节（拖出软件外=复制本地原件）。
#[tauri::command]
fn register_asset(id: String, path: String, state: tauri::State<AssetServer>) {
    if let Ok(mut m) = state.files.lock() {
        m.insert(id, PathBuf::from(path));
    }
}

fn mime_for(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}

/// 启动只绑 127.0.0.1 的本地文件服务；返回基址。失败返回空串（前端退回公网 url）。
fn start_asset_server(files: Arc<Mutex<HashMap<String, PathBuf>>>) -> String {
    let server = match tiny_http::Server::http("127.0.0.1:0") {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    if port == 0 {
        return String::new();
    }
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            // 路径形如 /a/<id>.<ext>；取 id（去前缀、去 query、去扩展）
            let url = req.url().to_string();
            let rest = url.trim_start_matches("/a/");
            let no_query = rest.split(['?', '#']).next().unwrap_or("");
            let id = no_query.rsplit_once('.').map(|(a, _)| a).unwrap_or(no_query).to_string();
            let path = files.lock().ok().and_then(|m| m.get(&id).cloned());
            match path {
                Some(p) if p.is_file() => match std::fs::read(&p) {
                    Ok(bytes) => {
                        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
                        let mut r = tiny_http::Response::from_data(bytes);
                        if let Ok(h) =
                            tiny_http::Header::from_bytes(&b"Content-Type"[..], mime_for(ext).as_bytes())
                        {
                            r = r.with_header(h);
                        }
                        let _ = req.respond(r);
                    }
                    Err(_) => {
                        let _ = req.respond(
                            tiny_http::Response::from_string("read error").with_status_code(500),
                        );
                    }
                },
                _ => {
                    let _ = req.respond(
                        tiny_http::Response::from_string("not found").with_status_code(404),
                    );
                }
            }
        }
    });
    format!("http://127.0.0.1:{}", port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // 本地资产 HTTP 服务（仅 127.0.0.1，服务登记过的原件；用于拖出软件外复制）
            let files: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));
            let base = start_asset_server(files.clone());
            app.manage(AssetServer { base, files });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![asset_http_base, register_asset])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
