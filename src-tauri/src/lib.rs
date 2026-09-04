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

// ── 视频截取：用「随包内置」的 ffmpeg 原生处理，绕开 webview 的 CORS/MediaRecorder 限制 ──
// src 可为本地文件路径或 https URL（ffmpeg 均可直读，无浏览器跨域问题）。
// 命令为 async + spawn_blocking：不阻塞主线程/UI（旧版同步下载致卡死已弃用）。
// 输出到系统临时目录，返回路径；前端读字节后删临时文件。

/// 解析 ffmpeg 可执行路径：优先「打包内置」(resources/ffmpeg/…)，开发态回退源码树，最后兜底 PATH。
fn resolve_ffmpeg(app: &tauri::AppHandle) -> PathBuf {
    use tauri::path::BaseDirectory;
    use tauri::Manager;
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    // 1) 生产：随包资源目录
    if let Ok(p) = app
        .path()
        .resolve(format!("resources/ffmpeg/{name}"), BaseDirectory::Resource)
    {
        if p.is_file() {
            return p;
        }
    }
    // 2) 开发：源码树 src-tauri/resources/ffmpeg/（CARGO_MANIFEST_DIR 编译期 = src-tauri 绝对路径）
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("ffmpeg")
        .join(name);
    if dev.is_file() {
        return dev;
    }
    // 3) 兜底：PATH 上的 ffmpeg（缺失时 run_ffmpeg 报清晰错误）
    PathBuf::from("ffmpeg")
}

/// 系统临时目录下的唯一输出文件名（按纳秒时间戳）。
fn temp_out(ext: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut p = std::env::temp_dir();
    p.push(format!("qiji-capture-{nanos}.{ext}"));
    p.to_string_lossy().into_owned()
}

/// 运行 ffmpeg（Windows 下隐藏控制台窗口）。失败回传 stderr 末尾片段作提示。
fn run_ffmpeg(ff: &std::path::Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new(ff);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("ffmpeg 执行失败（请确认已内置 ffmpeg）：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.lines().rev().take(3).collect::<Vec<_>>().join(" | ");
        Err(format!("ffmpeg 退出码 {:?}：{tail}", out.status.code()))
    }
}

/// 截取单帧为 PNG，返回临时文件路径。
#[tauri::command]
async fn extract_video_frame(
    app: tauri::AppHandle,
    src: String,
    time_sec: f64,
) -> Result<String, String> {
    let ff = resolve_ffmpeg(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let secs = if time_sec.is_finite() { time_sec.max(0.0) } else { 0.0 };
        let t = format!("{secs:.3}");
        let out = temp_out("png");
        // -ss 在 -i 之后 = 输出定位：自起始解码、帧级精确，目标在时长内必出一帧（避免输入定位越界 0 帧、exit 0 却无文件）
        run_ffmpeg(
            &ff,
            &["-y", "-i", &src, "-ss", &t, "-frames:v", "1", "-update", "1", "-q:v", "2", &out],
        )?;
        if !std::path::Path::new(&out).is_file() {
            return Err("ffmpeg 未产出帧（定位时间可能超出视频时长，请换一帧重试）".into());
        }
        Ok::<String, String>(out)
    })
    .await
    .map_err(|e| format!("截帧任务失败：{e}"))?
}

/// 截取从 start_sec 起、时长 dur_sec 的片段为 mp4，返回临时文件路径。
#[tauri::command]
async fn extract_video_clip(
    app: tauri::AppHandle,
    src: String,
    start_sec: f64,
    dur_sec: f64,
) -> Result<String, String> {
    let ff = resolve_ffmpeg(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let ss = format!("{:.3}", start_sec.max(0.0));
        let t = format!("{:.3}", dur_sec.max(0.1));
        let out = temp_out("mp4");
        // 重编码（非 -c copy）以保证任意起点可切、关键帧对齐；yuv420p + faststart 兼容广。
        run_ffmpeg(
            &ff,
            &[
                "-y", "-ss", &ss, "-i", &src, "-t", &t,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
                &out,
            ],
        )?;
        if !std::path::Path::new(&out).is_file() {
            return Err("ffmpeg 未产出片段（起始时间可能超出视频时长）".into());
        }
        Ok::<String, String>(out)
    })
    .await
    .map_err(|e| format!("截取片段任务失败：{e}"))?
}

/// 音频分离：抽出视频的音轨为 m4a，返回文件路径。
/// ① 先试 `-c:a copy`（无损、秒级；成片绝大多数是 AAC，可直接装进 m4a）；
/// ② 容器/编码装不下时（opus/vorbis 等）回退重编码 aac 192k。
/// dest：可选输出路径（须为 .m4a）；省略=系统临时目录（前端读字节后自行删除，同截帧/截片段）。
#[tauri::command]
async fn extract_video_audio(
    app: tauri::AppHandle,
    src: String,
    dest: Option<String>,
) -> Result<String, String> {
    let ff = resolve_ffmpeg(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let out = match dest {
            Some(d) if !d.trim().is_empty() => d,
            _ => temp_out("m4a"),
        };
        // ① 无损抽取
        let copy_err = run_ffmpeg(&ff, &["-y", "-i", &src, "-vn", "-c:a", "copy", &out]).err();
        let copied = copy_err.is_none() && std::path::Path::new(&out).is_file();
        if !copied {
            // ② 回退重编码（-y 覆盖 ① 可能留下的半成品）
            let enc_err = run_ffmpeg(
                &ff,
                &["-y", "-i", &src, "-vn", "-c:a", "aac", "-b:a", "192k", &out],
            )
            .err();
            if enc_err.is_some() || !std::path::Path::new(&out).is_file() {
                let detail = enc_err.or(copy_err).unwrap_or_default();
                // 最常见原因是源视频压根没有音轨——给用户能看懂的话，而不是 ffmpeg 原文
                if detail.contains("does not contain any stream") || detail.contains("Output file is empty") {
                    return Err("该视频没有音轨，无法分离音频".into());
                }
                return Err(format!("音频分离失败：{detail}"));
            }
        }
        Ok::<String, String>(out)
    })
    .await
    .map_err(|e| format!("音频分离任务失败：{e}"))?
}

/// 倒放媒体（第三批·实时剪辑）：kind="video" 画面+音频同时倒放（重编码 mp4），
/// kind="audio" 仅音频倒放（m4a）。返回临时文件路径（前端读字节后自行删除，同截帧/截片段）。
/// ⚠ ffmpeg 的 reverse/areverse 滤镜会把整段素材缓冲进内存——长视频转码慢且占内存（前端已提示）。
/// 视频先按「带音轨」跑（-vf reverse -af areverse）；源无音轨时该命令报错 → 回退纯视频倒放（-an）。
#[tauri::command]
async fn reverse_media(app: tauri::AppHandle, src: String, kind: String) -> Result<String, String> {
    let ff = resolve_ffmpeg(&app);
    tauri::async_runtime::spawn_blocking(move || {
        if kind == "audio" {
            let out = temp_out("m4a");
            run_ffmpeg(
                &ff,
                &["-y", "-i", &src, "-vn", "-af", "areverse", "-c:a", "aac", "-b:a", "192k", &out],
            )?;
            if !std::path::Path::new(&out).is_file() {
                return Err("ffmpeg 未产出倒放音频（源可能没有音轨）".into());
            }
            return Ok::<String, String>(out);
        }
        let out = temp_out("mp4");
        // ① 画面+音频同倒放
        let first_err = run_ffmpeg(
            &ff,
            &[
                "-y", "-i", &src, "-vf", "reverse", "-af", "areverse",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart",
                &out,
            ],
        )
        .err();
        if first_err.is_none() && std::path::Path::new(&out).is_file() {
            return Ok::<String, String>(out);
        }
        // ② 回退：源无音轨时 -af 会失败 → 纯视频倒放（-y 覆盖 ① 可能留下的半成品）
        let second_err = run_ffmpeg(
            &ff,
            &[
                "-y", "-i", &src, "-an", "-vf", "reverse",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                &out,
            ],
        )
        .err();
        if second_err.is_some() || !std::path::Path::new(&out).is_file() {
            let detail = second_err.or(first_err).unwrap_or_default();
            return Err(format!("倒放转码失败：{detail}"));
        }
        Ok::<String, String>(out)
    })
    .await
    .map_err(|e| format!("倒放任务失败：{e}"))?
}

// ── 原生下载：绕过 webview 的 CORS，把上游直链（r2.dev / 简梦 6h 链接等）落成本地文件 ──
// 前端 <video src=https> 受 CSP media-src 限制无法直播；且 webview fetch 受源站 CORS 限制常失败。
// 用原生 HTTP 客户端下载到系统临时文件、返回路径 + content-type，前端再写入项目 assets 目录并删临时。

#[derive(serde::Serialize)]
struct DownloadResult {
    path: String,
    content_type: String,
}

/// 由 content-type（优先）/ url 末尾扩展名 推断文件扩展名（asset:// 按扩展名定 Content-Type，必须匹配媒体类型）。
fn ext_from(ct: &str, url: &str) -> String {
    let base = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let by_ct = match base.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        _ => "",
    };
    if !by_ct.is_empty() {
        return by_ct.to_string();
    }
    let no_q = url.split(['?', '#']).next().unwrap_or(url);
    if let Some((_, e)) = no_q.rsplit_once('.') {
        if (2..=5).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric()) {
            return e.to_ascii_lowercase();
        }
    }
    "bin".to_string()
}

/// 原生下载远程 url 到系统临时文件；返回临时路径 + content-type。失败回传错误信息。
/// timeout_secs：单次超时秒数（缺省 180；第158轮原始直链结果的快重试用 30，夹在 [5,600]）。
#[tauri::command]
async fn download_url(url: String, timeout_secs: Option<u64>) -> Result<DownloadResult, String> {
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(
            timeout_secs.unwrap_or(180).clamp(5, 600),
        ))
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载 HTTP {}", resp.status().as_u16()));
    }
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let ext = ext_from(&ct, &url);
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取字节失败：{e}"))?;
    let out = temp_out(&ext);
    std::fs::write(&out, &bytes).map_err(|e| format!("写入临时文件失败：{e}"))?;
    Ok(DownloadResult { path: out, content_type: ct })
}

#[derive(serde::Serialize)]
struct DownloadToResult {
    bytes: u64,
    /// 目标已存在且非空 → 本次跳过（批量续跑友好：重跑只补没下到的）
    skipped: bool,
}

/// 批量下载（第232轮）：把 url 直接落到指定绝对路径，自动建父目录。
///
/// 与 `download_url` 的区别：那个落系统临时文件供前端接管；这个直落用户选定的目标路径，
/// 且**流式写入**——批量抓成片时几百 MB 的文件不会整个进内存。
///
/// ⚠ 先写 `<dest>.part` 完成后再 rename：中断/断网不会留下半截文件冒充成品，
///   配合 `skip_existing` 重跑时才能正确「只补没下到的」。
#[tauri::command]
async fn download_to(
    url: String,
    dest: String,
    timeout_secs: Option<u64>,
    skip_existing: Option<bool>,
) -> Result<DownloadToResult, String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let path = PathBuf::from(&dest);
    if skip_existing.unwrap_or(false) {
        if let Ok(md) = std::fs::metadata(&path) {
            if md.len() > 0 {
                return Ok(DownloadToResult { bytes: md.len(), skipped: true });
            }
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(
            timeout_secs.unwrap_or(600).clamp(5, 3600),
        ))
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载 HTTP {}", resp.status().as_u16()));
    }
    let part = PathBuf::from(format!("{dest}.part"));
    let mut f = std::fs::File::create(&part).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut written: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("读取字节失败：{e}")
        })?;
        f.write_all(&chunk).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("写入失败：{e}")
        })?;
        written += chunk.len() as u64;
    }
    f.flush().map_err(|e| format!("落盘失败：{e}"))?;
    drop(f);
    // 目标已存在（覆盖场景）先删，否则 Windows 上 rename 会失败
    let _ = std::fs::remove_file(&path);
    std::fs::rename(&part, &path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("重命名失败：{e}")
    })?;
    Ok(DownloadToResult { bytes: written, skipped: false })
}

// ── nyxen 稳定渠道素材加速：客户端原生流式接力，绕过 WebView CORS，也不经过 Qiji 服务端。──

#[tauri::command]
async fn nyxen_accelerate_upload(source_url: String, kind: String) -> Result<String, String> {
    const UPLOAD_ENDPOINT: &str = "https://api.nyxen.sbs/v1/upload";
    const MAX_BYTES: u64 = 250 * 1024 * 1024;
    let upload_key = option_env!("NYXEN_UPLOAD_KEY")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "客户端未配置稳定加速桶上传密钥，请重新打包安装".to_string())?;
    if !source_url.starts_with("https://") && !source_url.starts_with("http://") {
        return Err("素材地址必须是 http(s) 公网地址".to_string());
    }
    let fallback_type = match kind.as_str() {
        "image" => "image/jpeg",
        "video" => "video/mp4",
        "audio" => "audio/mpeg",
        _ => return Err("不支持的素材类型".to_string()),
    };

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("初始化上传连接失败：{e}"))?;
    let source = client
        .get(&source_url)
        .timeout(std::time::Duration::from_secs(900))
        .send()
        .await
        .map_err(|e| format!("读取原素材失败：{e}"))?;
    if !source.status().is_success() {
        return Err(format!("读取原素材 HTTP {}", source.status().as_u16()));
    }
    if let Some(length) = source.content_length() {
        if length > MAX_BYTES {
            return Err(format!(
                "素材过大（{:.1}MB > 250MB 上限）",
                length as f64 / 1048576.0
            ));
        }
    }
    let source_type = source
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "application/octet-stream")
        .unwrap_or(fallback_type)
        .to_string();
    let source_length = source.content_length();
    let stream = source.bytes_stream();
    let mut request = client
        .post(UPLOAD_ENDPOINT)
        .bearer_auth(upload_key)
        .header(reqwest::header::CONTENT_TYPE, source_type)
        .body(reqwest::Body::wrap_stream(stream))
        .timeout(std::time::Duration::from_secs(900));
    if let Some(length) = source_length {
        request = request.header(reqwest::header::CONTENT_LENGTH, length);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("上传请求失败：{e}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取上传响应失败：{e}"))?;
    if !status.is_success() {
        return Err(format!("上传 HTTP {}：{}", status.as_u16(), text.chars().take(300).collect::<String>()));
    }
    let url = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|body| body.get("url").and_then(|value| value.as_str()).map(str::to_string))
        .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
        .ok_or_else(|| "加速桶响应缺少有效 URL".to_string())?;
    Ok(url)
}

// ── ComfyUI 直连（第三方本地渠道）：webview 受 CORS 约束（ComfyUI 默认不带 CORS 头），
//    与 download_url 同理走 Rust 原生收发；地址由前端从用户绑定的 ComfyUI 地址拼好传入。──

/// ComfyUI 直连 JSON 请求（GET/POST；绕 webview CORS——ComfyUI 默认不带 CORS 头）。
/// 返回 { status, body }：非 2xx 也原样返回（前端判 status）；body 解析不了 JSON 时为 null。
/// timeout_secs 缺省 30s，夹在 [5,600]。
#[tauri::command]
async fn comfy_http_json(
    method: String,
    url: String,
    body: Option<serde_json::Value>,
    timeout_secs: Option<u64>,
) -> Result<serde_json::Value, String> {
    let m = method.trim().to_ascii_uppercase();
    if m != "GET" && m != "POST" {
        return Err(format!("不支持的请求方法：{method}（只接受 GET/POST）"));
    }
    let client = reqwest::Client::new();
    let mut req = if m == "GET" { client.get(&url) } else { client.post(&url) };
    req = req.timeout(std::time::Duration::from_secs(
        timeout_secs.unwrap_or(30).clamp(5, 600),
    ));
    if m == "POST" {
        if let Some(b) = &body {
            req = req.json(b);
        }
    }
    let resp = req.send().await.map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    // body 解析不了 JSON（如 HTML 错误页/空体）→ null，由前端按 status 判断
    let parsed = serde_json::from_str::<serde_json::Value>(&text).unwrap_or(serde_json::Value::Null);
    Ok(serde_json::json!({ "status": status, "body": parsed }))
}

/// ComfyUI 素材上传（multipart：文件字段 image=本地文件字节（文件名 field_filename）+ 文本字段 overwrite=true）。
/// url = 前端拼好的 {base}/upload/image；返回同 comfy_http_json 的 { status, body }。
/// timeout_secs 缺省 120s，夹在 [10,600]；文件读不到/超过 200MB 明确报错。
#[tauri::command]
async fn comfy_upload_file(
    url: String,
    field_filename: String,
    file_path: String,
    timeout_secs: Option<u64>,
) -> Result<serde_json::Value, String> {
    const MAX_BYTES: u64 = 200 * 1024 * 1024;
    let path = PathBuf::from(&file_path);
    let md = std::fs::metadata(&path).map_err(|e| format!("读取文件信息失败：{e}"))?;
    if !md.is_file() {
        return Err(format!("不是文件：{file_path}"));
    }
    if md.len() > MAX_BYTES {
        return Err(format!(
            "文件过大（{:.1}MB > 200MB 上限），拒绝上传",
            md.len() as f64 / 1048576.0
        ));
    }
    // spawn_blocking 读字节，不阻塞异步运行时（与 run_libtv 同惯例；不引入 tokio 直接依赖）
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path))
        .await
        .map_err(|e| format!("读取文件任务失败：{e}"))?
        .map_err(|e| format!("读取文件失败：{e}"))?;
    let part = reqwest::multipart::Part::bytes(bytes).file_name(field_filename);
    let form = reqwest::multipart::Form::new()
        .part("image", part)
        .text("overwrite", "true");
    let resp = reqwest::Client::new()
        .post(&url)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(
            timeout_secs.unwrap_or(120).clamp(10, 600),
        ))
        .send()
        .await
        .map_err(|e| format!("上传失败：{e}"))?;
    let status = resp.status().as_u16();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&text).unwrap_or(serde_json::Value::Null);
    Ok(serde_json::json!({ "status": status, "body": parsed }))
}

// ── LibTV CLI：随包内置 libtv.exe，供「个人中心 LibTV 授权 + Seedance 2.0 生成」原生调用 ──
// 凭据/本地状态目录固定为 LIBTV_CONFIG_DIR=<appData>/libtv（与用户自装的 ~/.libtv 隔离）；
// 前端一律显式传 -p <画布UUID>，不依赖 cwd 的 .libtv/project.json 状态。

/// 解析 libtv 可执行路径：优先「打包内置」(resources/libtv/…)，开发态回退源码树，最后兜底 PATH。
fn resolve_libtv(app: &tauri::AppHandle) -> PathBuf {
    use tauri::path::BaseDirectory;
    let name = if cfg!(windows) { "libtv.exe" } else { "libtv" };
    if let Ok(p) = app
        .path()
        .resolve(format!("resources/libtv/{name}"), BaseDirectory::Resource)
    {
        if p.is_file() {
            return p;
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("libtv")
        .join(name);
    if dev.is_file() {
        return dev;
    }
    PathBuf::from("libtv")
}

#[derive(serde::Serialize)]
struct CliResult {
    code: i32,
    stdout: String,
    stderr: String,
}

/// 运行 LibTV CLI（隐藏控制台窗口；spawn_blocking 不阻塞主线程）。
/// timeout_sec 到点杀进程报超时（登录等待回跳/视频 --run 由前端按场景传不同上限）。
/// 退出码非 0 不算 Err（stderr 里有业务错误原因，由前端解读），只有起不来/超时才 Err。
#[tauri::command]
async fn run_libtv(
    app: tauri::AppHandle,
    args: Vec<String>,
    timeout_sec: Option<u64>,
) -> Result<CliResult, String> {
    let exe = resolve_libtv(&app);
    let config_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法取得应用数据目录：{e}"))?
        .join("libtv");
    let _ = std::fs::create_dir_all(&config_dir);
    let timeout = std::time::Duration::from_secs(timeout_sec.unwrap_or(300).clamp(5, 3600));

    tauri::async_runtime::spawn_blocking(move || -> Result<CliResult, String> {
        use std::io::Read;
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(&args)
            .env("LIBTV_CONFIG_DIR", &config_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("libtv 启动失败（请确认已内置 LibTV CLI）：{e}"))?;
        // stdout/stderr 各起线程排空（防长进度日志塞满管道缓冲导致互相死锁）
        let mut out_pipe = child.stdout.take().ok_or("无法读取 stdout")?;
        let mut err_pipe = child.stderr.take().ok_or("无法读取 stderr")?;
        let out_h = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out_pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        });
        let err_h = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = err_pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        });
        let deadline = std::time::Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("libtv 执行超时（{} 秒），已中止", timeout.as_secs()));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(e) => return Err(format!("libtv 等待失败：{e}")),
            }
        };
        Ok(CliResult {
            code: status.code().unwrap_or(-1),
            stdout: out_h.join().unwrap_or_default(),
            stderr: err_h.join().unwrap_or_default(),
        })
    })
    .await
    .map_err(|e| format!("libtv 任务失败：{e}"))?
}

// ── 即梦（Dreamina）CLI：随包内置 dreamina.exe，供「个人中心 即梦授权 + Seedance 2.0 生成」原生调用 ──
// 与 LibTV 不同：dreamina 无凭据目录环境变量（实测重定向 USERPROFILE 后凭据仍读全局），
// 故**共用用户全局 `~/.dreamina_cli` 登录态**（用户在终端 curl 安装并登录过即直接可用）。

/// 解析 dreamina 可执行路径：优先「打包内置」(resources/dreamina/…)，开发态回退源码树，最后兜底 PATH。
fn resolve_dreamina(app: &tauri::AppHandle) -> PathBuf {
    use tauri::path::BaseDirectory;
    let name = if cfg!(windows) { "dreamina.exe" } else { "dreamina" };
    if let Ok(p) = app
        .path()
        .resolve(format!("resources/dreamina/{name}"), BaseDirectory::Resource)
    {
        if p.is_file() {
            return p;
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("dreamina")
        .join(name);
    if dev.is_file() {
        return dev;
    }
    PathBuf::from("dreamina")
}

/// 运行 即梦 CLI（隐藏控制台窗口；spawn_blocking 不阻塞主线程）。
/// 语义与 run_libtv 一致：退出码非 0 不算 Err（stderr 有业务原因，由前端解读），只有起不来/超时才 Err。
#[tauri::command]
async fn run_dreamina(
    app: tauri::AppHandle,
    args: Vec<String>,
    timeout_sec: Option<u64>,
) -> Result<CliResult, String> {
    let exe = resolve_dreamina(&app);
    let timeout = std::time::Duration::from_secs(timeout_sec.unwrap_or(300).clamp(5, 3600));

    tauri::async_runtime::spawn_blocking(move || -> Result<CliResult, String> {
        use std::io::Read;
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("dreamina 启动失败（请确认已内置 即梦 CLI）：{e}"))?;
        // stdout/stderr 各起线程排空（防长进度日志塞满管道缓冲导致互相死锁）
        let mut out_pipe = child.stdout.take().ok_or("无法读取 stdout")?;
        let mut err_pipe = child.stderr.take().ok_or("无法读取 stderr")?;
        let out_h = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out_pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        });
        let err_h = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = err_pipe.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        });
        let deadline = std::time::Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if std::time::Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("dreamina 执行超时（{} 秒），已中止", timeout.as_secs()));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(200));
                }
                Err(e) => return Err(format!("dreamina 等待失败：{e}")),
            }
        };
        Ok(CliResult {
            code: status.code().unwrap_or(-1),
            stdout: out_h.join().unwrap_or_default(),
            stderr: err_h.join().unwrap_or_default(),
        })
    })
    .await
    .map_err(|e| format!("dreamina 任务失败：{e}"))?
}

/// 用系统默认浏览器打开 http(s) 链接（即梦 OAuth 设备码登录的授权页）。
/// 只放行 http/https，防任意命令注入。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("仅允许打开 http(s) 链接".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败：{e}"))?;
    }
    Ok(())
}

/// 强制把文件数据刷到物理磁盘（fsync）。
/// 原子保存时，写完 .tmp 后必须调用它再 rename——否则 writeTextFile 只进系统写回缓存、
/// rename 只改 NTFS 元数据（元数据有日志、数据无），断电会让主文件与 .bak 同时被清零。
/// fsync 保证 rename 生效前数据已落盘：断电最坏是 .tmp 半截，主文件/.bak 完好。
#[tauri::command]
fn fsync_file(path: String) -> Result<(), String> {
    use std::fs::OpenOptions;
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .map_err(|e| format!("打开文件失败：{e}"))?;
    f.sync_all().map_err(|e| format!("刷盘失败：{e}"))?;
    Ok(())
}

// ── 剪映草稿导出（实时剪辑第三模式）：目录探测/建夹/素材复制/写盘全在命令层完成 ──
// 安全边界（红线）：写入恒限「剪映草稿根目录」之下；素材源文件读取恒限调用方给定的
// 项目 assets 目录之下；不向前端开放任意路径读写。

/// 剪映草稿根目录候选（Windows 剪映专业版默认位置）。
fn jianying_root_candidates() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        v.push(
            PathBuf::from(local)
                .join("JianyingPro")
                .join("User Data")
                .join("Projects")
                .join("com.lveditor.draft"),
        );
    }
    v
}

/// 解析草稿根目录；不存在时报错并附上全部已探测路径（上层直显给用户，P0 不做目录选择器）。
fn resolve_jianying_root() -> Result<PathBuf, String> {
    let candidates = jianying_root_candidates();
    for c in &candidates {
        if c.is_dir() {
            return Ok(c.clone());
        }
    }
    let probed = candidates
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("、");
    Err(format!(
        "未找到剪映草稿目录（请确认已安装剪映专业版并至少启动过一次）。已探测：{probed}"
    ))
}

/// 校验 child 规范化后确实位于 parent 之下（防路径穿越；两侧 canonicalize 消 ../符号链接）。
fn ensure_under(child: &std::path::Path, parent: &std::path::Path) -> Result<PathBuf, String> {
    let cp = child.canonicalize().map_err(|e| format!("路径不可用（{}）：{e}", child.display()))?;
    let pp = parent
        .canonicalize()
        .map_err(|e| format!("路径不可用（{}）：{e}", parent.display()))?;
    if cp.starts_with(&pp) {
        Ok(cp)
    } else {
        Err(format!("路径越界（{} 不在 {} 内）", cp.display(), pp.display()))
    }
}

/// 探测剪映草稿根目录：存在返回绝对路径；不存在返回带探测路径的明确错误。
#[tauri::command]
fn jianying_draft_root() -> Result<String, String> {
    resolve_jianying_root().map(|p| p.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
struct PreparedDraft {
    path: String,
    name: String,
}

/// 在草稿根目录下建草稿文件夹（含 assets 子目录）：消毒草稿名、重名自动加 -2/-3… 避让，
/// 返回最终路径与最终名（前端据此拼素材绝对路径写进 draft_content.json）。
#[tauri::command]
fn jianying_prepare_draft(draft_name: String) -> Result<PreparedDraft, String> {
    let root = resolve_jianying_root()?;
    // 消毒：Windows 非法字符/控制字符→_；去首尾空白与点；空名兜底
    let cleaned: String = draft_name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let base = cleaned.trim().trim_matches('.').trim();
    let base = if base.is_empty() { "Qiji剪辑" } else { base };
    let mut name = base.to_string();
    let mut n = 2;
    while root.join(&name).exists() {
        if n > 99 {
            return Err("同名草稿过多（超过 99 个），请先清理剪映草稿".into());
        }
        name = format!("{base}-{n}");
        n += 1;
    }
    let dir = root.join(&name);
    std::fs::create_dir_all(dir.join("assets")).map_err(|e| format!("创建草稿文件夹失败：{e}"))?;
    Ok(PreparedDraft { path: dir.to_string_lossy().into_owned(), name })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct JyCopyItem {
    src: String,
    file_name: String,
}

/// 素材复制进草稿文件夹 assets\：目标恒限草稿根目录下、源恒限给定的项目 assets 目录下。
/// 目标已存在且大小一致则跳过（同 assetId 只会有一份，重导出免重拷）。
#[tauri::command]
async fn jianying_copy_assets(
    draft_path: String,
    src_root: String,
    items: Vec<JyCopyItem>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let root = resolve_jianying_root()?;
        let draft = ensure_under(std::path::Path::new(&draft_path), &root)?;
        let src_root = PathBuf::from(&src_root);
        let assets = draft.join("assets");
        std::fs::create_dir_all(&assets).map_err(|e| format!("创建素材目录失败：{e}"))?;
        for it in &items {
            if it.file_name.is_empty() || it.file_name.contains(['\\', '/']) || it.file_name.contains("..") {
                return Err(format!("非法素材文件名：{}", it.file_name));
            }
            let src = ensure_under(std::path::Path::new(&it.src), &src_root)
                .map_err(|e| format!("素材源路径校验失败：{e}"))?;
            let dest = assets.join(&it.file_name);
            if let (Ok(sm), Ok(dm)) = (std::fs::metadata(&src), std::fs::metadata(&dest)) {
                if dm.len() == sm.len() && dm.len() > 0 {
                    continue; // 已复制过（大小一致）跳过
                }
            }
            std::fs::copy(&src, &dest).map_err(|e| format!("复制素材失败（{}）：{e}", it.file_name))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("复制素材任务失败：{e}"))?
}

/// subdraft 文件夹名的 UUID 形态校验（8-4-4-4-12 十六进制，大小写均可）——白名单的一部分，
/// 保证 `subdraft/<uuid>/` 路径段绝无 `..`/盘符/分隔符注入的可能。
fn is_subdraft_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *b != b'-' {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// 写草稿 JSON：文件名白名单 + 目标恒限草稿根目录下（canonicalize 双向限定，沿用 ensure_under）。
/// 第四批（复合片段）扩展的合法形态：
///   - `draft_content.json` / `draft_meta_info.json`（原有）
///   - `subdraft/draft_content.json` / `subdraft/sub_draft_config.json`（松散副本）
///   - `subdraft/<uuid 连字符形态>/draft_content.json|sub_draft_config.json`（子草稿本体）
#[tauri::command]
fn jianying_write_draft_file(draft_path: String, file_name: String, content: String) -> Result<(), String> {
    // 统一用正斜杠分段校验；反斜杠/空段/`..` 一律拒绝（uuid 段另有独立形态校验）
    if file_name.contains('\\') || file_name.contains("..") {
        return Err(format!("不允许写入的文件名：{file_name}"));
    }
    let parts: Vec<&str> = file_name.split('/').collect();
    let allowed = match parts.as_slice() {
        [n] => *n == "draft_content.json" || *n == "draft_meta_info.json",
        ["subdraft", n] => *n == "draft_content.json" || *n == "sub_draft_config.json",
        ["subdraft", u, n] => {
            is_subdraft_uuid(u) && (*n == "draft_content.json" || *n == "sub_draft_config.json")
        }
        _ => false,
    };
    if !allowed {
        return Err(format!("不允许写入的文件名：{file_name}"));
    }
    let root = resolve_jianying_root()?;
    let draft = ensure_under(std::path::Path::new(&draft_path), &root)?;
    // 按已校验的分段逐级拼接（不把整串 file_name 直接 join，杜绝任何路径语义歧义）
    let mut dest = draft.clone();
    for p in &parts {
        dest.push(p);
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建子草稿目录失败：{e}"))?;
    }
    std::fs::write(&dest, content.as_bytes()).map_err(|e| format!("写入 {file_name} 失败：{e}"))
}

// （第218轮：硬件指纹 get_hw_fingerprint 整体退役——身份=API 密钥，设备区分=前端随机 UUID，
//  不再采集任何硬件信息。）

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例（第205轮多窗口协同）：二次启动同一 exe（用户的「多开」）不再另起独立进程——
        // 独立进程各持项目内存态、整文件互相覆盖丢数据；改为在本进程新开一个完整应用窗口，
        // 窗口间经 Tauri 事件系统实时同步（见 src/services/projectSync.ts）。须注册在最前。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let label = format!(
                "main-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            );
            let _ = tauri::WebviewWindowBuilder::new(
                app,
                label,
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Qiji")
            .inner_size(1024.0, 768.0)
            .decorations(false)
            .disable_drag_drop_handler()
            .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --enable-features=WebGPU")
            .build();
        }))
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

            // 生产版禁用开发者工具：在 WebView2 层关掉 devtools + 浏览器加速键（F12/Ctrl+R 刷新/Ctrl+P 打印等）。
            // 只在 release 生效——dev/debug 版保留 F12 供开发调试。
            // 页面自身仍能收到 keydown 事件，故应用内快捷键（Ctrl+S/O/N、画布快捷键）不受影响。
            #[cfg(all(windows, not(debug_assertions)))]
            {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.with_webview(|webview| unsafe {
                        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                        use windows::core::Interface;
                        let controller = webview.controller();
                        if let Ok(core) = controller.CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                let _ = settings.SetAreDevToolsEnabled(false);
                                if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                                    let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                                }
                            }
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            asset_http_base,
            register_asset,
            extract_video_frame,
            extract_video_clip,
            extract_video_audio,
            reverse_media,
            download_url,
            download_to,
            nyxen_accelerate_upload,
            comfy_http_json,
            comfy_upload_file,
            run_libtv,
            run_dreamina,
            open_url,
            fsync_file,
            jianying_draft_root,
            jianying_prepare_draft,
            jianying_copy_assets,
            jianying_write_draft_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
