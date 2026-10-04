//! Small, bounded native diagnostics. Never accepts project contents, URLs or arbitrary log text.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, Runtime};

#[cfg(windows)]
#[path = "diagnostics_windows.rs"]
mod platform;

const DAY_MS: u64 = 86_400_000;
const RETENTION_MS: u64 = 7 * DAY_MS;
const SEGMENT_BYTES: u64 = 1024 * 1024;
const LOG_LIMIT: u64 = 16 * 1024 * 1024;
const DUMP_LIMIT: u64 = 64 * 1024 * 1024;
const DUMP_COUNT: usize = 3;

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    SaveStart,
    SaveStage,
    SaveSerialized,
    SaveSuccess,
    SaveFailed,
    FrontendError,
    Context,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveSource {
    Autosave,
    Manual,
    Checkpoint,
    Switch,
    Unknown,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventMode {
    Canvas,
    Table,
    Rtc,
    Other,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SaveStage {
    Snapshot,
    Normalize,
    Serialize,
    Write,
    Finish,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorClass {
    RangeError,
    TypeError,
    SyntaxError,
    ReferenceError,
    AbortError,
    QuotaExceeded,
    IoError,
    Unknown,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientDiagnosticEvent {
    pub kind: EventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SaveSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<SaveStage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<EventMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_class: Option<ErrorClass>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub save_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serialize_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub write_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json_chars: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edge_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub past_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub future_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heap_used_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heap_total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heap_limit_bytes: Option<u64>,
}

impl ClientDiagnosticEvent {
    fn validate(&self) -> Result<(), String> {
        if [self.duration_ms, self.serialize_ms, self.write_ms]
            .into_iter()
            .flatten()
            .any(|v| !v.is_finite() || !(0.0..=86_400_000.0).contains(&v))
            || [
                self.bytes,
                self.json_chars,
                self.heap_used_bytes,
                self.heap_total_bytes,
                self.heap_limit_bytes,
            ]
            .into_iter()
            .flatten()
            .any(|v| v > 1_099_511_627_776)
            || [
                self.node_count,
                self.edge_count,
                self.history_count,
                self.past_count,
                self.future_count,
            ]
            .into_iter()
            .flatten()
            .any(|v| v > 10_000_000)
            || self.save_id.is_some_and(|v| v > 9_007_199_254_740_991)
        {
            return Err("诊断字段超出范围".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct Diagnostics(pub(super) Arc<Inner>);
pub(super) struct Inner {
    root: PathBuf,
    session: String,
    version: String,
    io: Mutex<()>,
    pub(super) webviews: Mutex<Vec<WebviewInfo>>,
    stopped: AtomicBool,
    exporting: AtomicBool,
}
#[derive(Clone)]
pub(super) struct WebviewInfo {
    pub label: String,
    pub runtime: String,
    pub dump_folder: Option<PathBuf>,
    pub hook_ready: bool,
}

#[derive(Clone)]
struct Candidate {
    path: PathBuf,
    size: u64,
    modified: u64,
}

fn files_in(directory: &Path, extension: &str) -> Vec<Candidate> {
    // Only this directory, never recursively walks a browser profile or user home.
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .take(4096)
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !entry.file_type().ok()?.is_file()
                || entry.path().extension()?.to_str()? != extension
            {
                return None;
            }
            Some(Candidate {
                path: entry.path(),
                size: meta.len(),
                modified: meta
                    .modified()
                    .ok()?
                    .duration_since(UNIX_EPOCH)
                    .ok()?
                    .as_millis() as u64,
            })
        })
        .collect()
}

fn prune_logs(root: &Path, now: u64, budget: u64) {
    let mut files = files_in(root, "jsonl");
    files.sort_by_key(|f| std::cmp::Reverse(f.modified));
    let mut kept = 0;
    for file in files {
        if file.modified < now.saturating_sub(RETENTION_MS) || kept + file.size > budget {
            let _ = fs::remove_file(file.path);
        } else {
            kept += file.size;
        }
    }
}

impl Diagnostics {
    fn new(root: PathBuf, version: String) -> std::io::Result<Self> {
        fs::create_dir_all(&root)?;
        let session = format!("{}-{}", now_ms(), std::process::id());
        let previous_unclean = root.join("session-open").exists();
        let state = Self(Arc::new(Inner {
            root,
            session,
            version,
            io: Mutex::new(()),
            webviews: Mutex::new(Vec::new()),
            stopped: AtomicBool::new(false),
            exporting: AtomicBool::new(false),
        }));
        state.record(json!({"kind":"native_start", "previousUncleanExit":previous_unclean, "clientVersion":state.0.version, "pid":std::process::id()}))?;
        fs::write(
            state.0.root.join("session-open"),
            state.0.session.as_bytes(),
        )?;
        Ok(state)
    }

    pub(super) fn record(&self, mut event: Value) -> std::io::Result<()> {
        let _lock = self
            .0
            .io
            .lock()
            .map_err(|_| std::io::Error::other("diagnostics lock"))?;
        let now = now_ms();
        event["atMs"] = json!(now);
        event["session"] = json!(self.0.session);
        let mut bytes = serde_json::to_vec(&event)?;
        if bytes.len() > 64 * 1024 {
            return Err(std::io::Error::other("diagnostic too large"));
        }
        bytes.push(b'\n');
        prune_logs(
            &self.0.root,
            now,
            LOG_LIMIT.saturating_sub(bytes.len() as u64),
        );
        let day = now / DAY_MS;
        let mut segment = 0;
        let path = loop {
            let path = self.0.root.join(format!("events-{day}-{segment}.jsonl"));
            if fs::metadata(&path)
                .map(|m| m.len() + bytes.len() as u64 <= SEGMENT_BYTES)
                .unwrap_or(true)
            {
                break path;
            }
            segment += 1;
        };
        let mut output = OpenOptions::new().create(true).append(true).open(path)?;
        output.write_all(&bytes)?;
        // Save breadcrumbs are durable before the JS heavy stage starts.
        output.sync_data()
    }

    fn stop(&self) {
        self.0.stopped.store(true, Ordering::Relaxed);
        if self.record(json!({"kind":"native_exit"})).is_ok() {
            let _ = fs::remove_file(self.0.root.join("session-open"));
        }
    }

    fn start_sampler(&self) {
        let weak = Arc::downgrade(&self.0);
        std::thread::spawn(move || loop {
            let Some(inner) = weak.upgrade() else {
                break;
            };
            if inner.stopped.load(Ordering::Relaxed) {
                break;
            }
            let diagnostics = Diagnostics(inner);
            #[cfg(windows)]
            let _ = diagnostics.record(platform::memory_sample());
            drop(diagnostics);
            std::thread::sleep(Duration::from_secs(15));
        });
    }

    fn dump_candidates(&self, now: u64) -> Vec<Candidate> {
        let infos = self
            .0
            .webviews
            .lock()
            .map(|v| v.clone())
            .unwrap_or_default();
        let mut candidates = Vec::new();
        for folder in infos.iter().filter_map(|v| v.dump_folder.as_ref()) {
            candidates.extend(files_in(folder, "dmp"));
            // Runtime versions can return a Crashpad root or its reports directory.
            if folder.file_name().is_some_and(|v| v == "Crashpad") {
                candidates.extend(files_in(&folder.join("reports"), "dmp"));
                candidates.extend(files_in(&folder.join("pending"), "dmp"));
            }
        }
        let mut seen = std::collections::HashSet::new();
        candidates.retain(|f| {
            f.modified >= now.saturating_sub(RETENTION_MS)
                && f.size <= DUMP_LIMIT
                && seen.insert(f.path.clone())
        });
        candidates.sort_by_key(|f| std::cmp::Reverse(f.modified));
        let mut total = 0;
        candidates
            .into_iter()
            .filter(|f| {
                if total + f.size <= DUMP_LIMIT {
                    total += f.size;
                    true
                } else {
                    false
                }
            })
            .take(DUMP_COUNT)
            .collect()
    }

    fn export(&self, target: &Path) -> Result<String, String> {
        if !target.is_absolute()
            || target
                .extension()
                .and_then(|v| v.to_str())
                .map(|v| !v.eq_ignore_ascii_case("zip"))
                .unwrap_or(true)
        {
            return Err("请选择 ZIP 文件的绝对保存路径".into());
        }
        let parent = target
            .parent()
            .and_then(|p| p.canonicalize().ok())
            .ok_or("保存目录不存在")?;
        let root = self.0.root.canonicalize().map_err(|_| "诊断目录不可读")?;
        if parent.starts_with(root) {
            return Err("请将诊断包保存在诊断目录之外".into());
        }
        let temp = parent.join(format!(".qiji-diagnostics-{}.tmp", self.0.session));
        let result = self.write_zip(&temp).and_then(|_| {
            // Preserve an existing export until the complete new ZIP is durable.
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                use windows::{
                    core::PCWSTR,
                    Win32::Storage::FileSystem::{
                        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
                    },
                };
                let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
                let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
                unsafe {
                    MoveFileExW(
                        PCWSTR(from.as_ptr()),
                        PCWSTR(to.as_ptr()),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                    .map_err(|_| "诊断包保存失败".to_string())?;
                }
            }
            #[cfg(not(windows))]
            fs::rename(&temp, target).map_err(|_| "诊断包保存失败".to_string())?;
            Ok(target.to_string_lossy().into_owned())
        });
        if result.is_err() {
            let _ = fs::remove_file(temp);
        }
        result
    }

    fn write_zip(&self, temp: &Path) -> Result<(), String> {
        use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temp)
            .map_err(|_| "无法创建诊断包")?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let now = now_ms();
        // Snapshot lengths at complete JSONL boundaries, then release the writer lock.
        // Streaming large dumps must not block autosave breadcrumbs or crash callbacks.
        let mut logs = {
            let _guard = self.0.io.lock().map_err(|_| "诊断读取失败")?;
            prune_logs(&self.0.root, now, LOG_LIMIT);
            files_in(&self.0.root, "jsonl")
        };
        logs.sort_by_key(|f| f.modified);
        let mut entries = Vec::new();
        let mut missing = 0;
        for (index, candidate) in logs.iter().enumerate() {
            let Ok(mut source) = File::open(&candidate.path) else {
                missing += 1;
                continue;
            };
            let name = format!("logs/events-{index:02}.jsonl");
            zip.start_file(&name, options).map_err(|_| "ZIP 写入失败")?;
            let copied = std::io::copy(
                &mut Read::by_ref(&mut source).take(candidate.size.min(SEGMENT_BYTES)),
                &mut zip,
            )
            .map_err(|_| "日志读取失败")?;
            entries.push(json!({"entry":name,"bytes":copied}));
        }
        let mut dump_count = 0;
        for candidate in self.dump_candidates(now) {
            let Ok(source) = File::open(&candidate.path) else {
                missing += 1;
                continue;
            };
            let name = format!("dumps/webview-{:02}.dmp", dump_count + 1);
            zip.start_file(&name, options).map_err(|_| "ZIP 写入失败")?;
            let copied = std::io::copy(&mut source.take(candidate.size), &mut zip)
                .map_err(|_| "崩溃转储读取失败")?;
            entries.push(json!({"entry":name,"bytes":copied,"modifiedAtMs":candidate.modified}));
            dump_count += 1;
        }
        let webviews: Vec<Value> = self.0.webviews.lock().map(|v| v.iter().map(|w| json!({"label":w.label,"runtime":w.runtime,"processFailedHookReady":w.hook_ready,"dumpFolderAvailable":w.dump_folder.is_some()})).collect()).unwrap_or_default();
        #[cfg(windows)]
        let os_version = platform::os_version();
        #[cfg(not(windows))]
        let os_version = Value::Null;
        let manifest = json!({
            "schemaVersion":1,"exportedAtMs":now,"clientVersion":self.0.version,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,
            "osVersion":os_version,
            "session":self.0.session,"webviews":webviews,"files":entries,"dumpCount":dump_count,"unreadableFiles":missing,
            "limits":{"retentionDays":7,"logBytes":LOG_LIMIT,"exportDumpBytes":DUMP_LIMIT,"exportDumpCount":DUMP_COUNT},
            "memoryScope":"Windows host and descendant msedgewebview2 processes; working set/private bytes; shared pages may be counted more than once; no GPU dedicated-memory measurement",
            "dumpStatus":if dump_count == 0 { "No eligible dump was available; logs remain useful. WebView2 creates dumps independently; absence does not prove absence of a crash." } else { "Included recent WebView2 dumps; they can contain process memory. Review before sharing." },
            "privacy":"Structured logs contain no project contents, project paths, prompts, keys or URLs. Dumps may contain process memory. No automatic upload.",
            "retentionScope":"Retention bounds Qiji diagnostic JSONL only. Runtime-owned crash dumps are read with export limits and never deleted by Qiji.",
            "processFailedKinds":{"0":"browser_process_exited","1":"render_process_exited","2":"render_process_unresponsive","3":"frame_render_process_exited","4":"utility_process_exited","5":"sandbox_helper_process_exited","6":"gpu_process_exited","7":"ppapi_plugin_process_exited","8":"ppapi_broker_process_exited","9":"unknown_process_exited"},
            "processFailedReasons":{"0":"unexpected","1":"unresponsive","2":"terminated","3":"crashed","4":"launch_failed","5":"out_of_memory","6":"profile_deleted"}
        });
        zip.start_file("manifest.json", options)
            .map_err(|_| "ZIP 写入失败")?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(|_| "诊断摘要失败")?)
            .map_err(|_| "ZIP 写入失败")?;
        zip.start_file("README.txt", options)
            .map_err(|_| "ZIP 写入失败")?;
        zip.write_all("Qiji 客户端诊断包\n先阅读 manifest.json，再按 atMs/session/window/saveId 对齐 logs 中保存阶段、内存与 webview_process_failed。\n最后出现 save_stage 并不独立证明保存导致崩溃；需结合退出原因、内存与转储。\n无转储时仍包含日志。转储可能含进程内存，分享前请确认。\n".as_bytes()).map_err(|_| "ZIP 写入失败")?;
        zip.finish()
            .map_err(|_| "ZIP 完成失败")?
            .sync_all()
            .map_err(|_| "ZIP 刷盘失败".to_string())
    }
}

#[tauri::command]
pub async fn record_client_diagnostic(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Diagnostics>,
    event: ClientDiagnosticEvent,
) -> Result<(), String> {
    event.validate()?;
    let diagnostics = state.inner().clone();
    let mut payload = serde_json::to_value(event).map_err(|_| "诊断字段无效")?;
    payload["window"] = json!(window.label());
    tauri::async_runtime::spawn_blocking(move || {
        diagnostics
            .record(payload)
            .map_err(|_| "诊断日志写入失败".to_string())
    })
    .await
    .map_err(|_| "诊断任务失败")?
}

#[tauri::command]
pub async fn export_client_diagnostics(
    state: tauri::State<'_, Diagnostics>,
    path: String,
) -> Result<String, String> {
    let diagnostics = state.inner().clone();
    if diagnostics.0.exporting.swap(true, Ordering::AcqRel) {
        return Err("正在导出诊断包".into());
    }
    struct ExportGuard(Diagnostics);
    impl Drop for ExportGuard {
        fn drop(&mut self) {
            self.0 .0.exporting.store(false, Ordering::Release);
        }
    }
    let guard = ExportGuard(diagnostics.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        diagnostics.export(Path::new(&path))
    })
    .await
    .map_err(|_| "诊断导出任务失败")?
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    init_at(None)
}

fn init_at<R: Runtime>(root_override: Option<PathBuf>) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("qiji-diagnostics")
        .setup(move |app, _| {
            // Diagnostics must never prevent the editor from starting (e.g. a full disk).
            let diagnostics = match root_override
                .or_else(|| {
                    app.path()
                        .app_local_data_dir()
                        .ok()
                        .map(|p| p.join("diagnostics"))
                })
                .and_then(|p| Diagnostics::new(p, app.package_info().version.to_string()).ok())
            {
                Some(diagnostics) => diagnostics,
                None => {
                    eprintln!("Qiji diagnostics unavailable");
                    return Ok(());
                }
            };
            diagnostics.start_sampler();
            let panic_diagnostics = diagnostics.clone();
            let previous_hook = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                // Avoid re-entering a lock when the panic originated in diagnostics itself.
                if panic_diagnostics.0.io.try_lock().is_ok() {
                    let _ = panic_diagnostics.record(json!({"kind":"native_panic"}));
                }
                previous_hook(info);
            }));
            app.manage(diagnostics);
            Ok(())
        })
        .on_webview_ready(|webview| {
            #[cfg(windows)]
            platform::attach(&webview);
            #[cfg(not(windows))]
            let _ = webview;
        })
        .on_event(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(d) = app.try_state::<Diagnostics>() {
                    d.stop();
                }
            }
        })
        .build()
}

#[cfg(all(test, feature = "diagnostics-smoke"))]
#[path = "diagnostics_smoke.rs"]
mod smoke;

#[cfg(test)]
mod tests {
    use super::*;
    static TEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "qiji-diag-test-{}-{}-{}",
                now_ms(),
                std::process::id(),
                TEST_ID.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn rejects_content_and_unbounded_numbers() {
        assert!(serde_json::from_value::<ClientDiagnosticEvent>(
            json!({"kind":"frontend_error","message":"secret"})
        )
        .is_err());
        assert!(serde_json::from_value::<ClientDiagnosticEvent>(
            json!({"kind":"save_stage","stage":"prompt"})
        )
        .is_err());
        let event: ClientDiagnosticEvent =
            serde_json::from_value(json!({"kind":"save_success","durationMs":-1})).unwrap();
        assert!(event.validate().is_err());
        let event: ClientDiagnosticEvent = serde_json::from_value(
            json!({"kind":"save_stage","stage":"serialize","saveId":2,"jsonChars":52428800}),
        )
        .unwrap();
        assert!(event.validate().is_ok());
    }
    #[test]
    fn rotates_full_segment_and_keeps_event_complete() {
        let dir = TestDir::new();
        let root = dir.0.join("logs");
        let diagnostics = Diagnostics::new(root.clone(), "test".into()).unwrap();
        let first = files_in(&root, "jsonl")[0].path.clone();
        OpenOptions::new()
            .write(true)
            .open(&first)
            .unwrap()
            .set_len(SEGMENT_BYTES)
            .unwrap();
        diagnostics
            .record(json!({"kind":"save_stage", "stage":"write"}))
            .unwrap();
        let files = files_in(&root, "jsonl");
        assert_eq!(files.len(), 2);
        let next = files.iter().find(|f| f.path != first).unwrap();
        let event: Value = serde_json::from_slice(&fs::read(&next.path).unwrap()).unwrap();
        assert_eq!(event["stage"], "write");
        assert!(next.size < SEGMENT_BYTES);
    }
    #[cfg(windows)]
    #[test]
    fn native_sample_contains_live_host_memory() {
        let sample = platform::memory_sample();
        let host = sample["processes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["scope"] == "host")
            .unwrap();
        assert_eq!(host["pid"], std::process::id());
        assert!(host["workingSetBytes"].as_u64().unwrap() > 0);
        assert!(host["privateBytes"].as_u64().unwrap() > 0);
    }
    #[test]
    fn durable_records_and_export_without_dumps() {
        let dir = TestDir::new();
        let root = dir.0.join("logs");
        let diagnostics = Diagnostics::new(root.clone(), "test".into()).unwrap();
        diagnostics
            .record(json!({"kind":"save_stage","stage":"serialize","saveId":42}))
            .unwrap();
        let target = dir.0.join("result.zip");
        diagnostics.export(&target).unwrap();
        let mut archive = zip::ZipArchive::new(File::open(&target).unwrap()).unwrap();
        let mut manifest = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        let manifest: Value = serde_json::from_str(&manifest).unwrap();
        assert_eq!(manifest["dumpCount"], 0);
        let mut logs = String::new();
        archive
            .by_name("logs/events-00.jsonl")
            .unwrap()
            .read_to_string(&mut logs)
            .unwrap();
        assert!(logs.contains("serialize"));
        assert!(logs.contains("42"));
        diagnostics.stop();
        assert!(!root.join("session-open").exists());
    }
    #[test]
    fn detects_unclean_session_and_prunes_by_capacity_and_age() {
        let dir = TestDir::new();
        let root = dir.0.join("logs");
        Diagnostics::new(root.clone(), "test".into()).unwrap();
        Diagnostics::new(root.clone(), "test".into()).unwrap();
        let logs = files_in(&root, "jsonl");
        let content = fs::read_to_string(&logs[0].path).unwrap();
        assert!(content.contains("\"previousUncleanExit\":true"));
        fs::write(root.join("extra.jsonl"), vec![b'x'; 1024]).unwrap();
        prune_logs(&root, now_ms(), 1024);
        assert!(files_in(&root, "jsonl").iter().map(|f| f.size).sum::<u64>() <= 1024);
        prune_logs(&root, now_ms() + RETENTION_MS + 1000, LOG_LIMIT);
        assert!(files_in(&root, "jsonl").is_empty());
    }
    #[test]
    fn export_is_bounded_and_does_not_include_unrelated_profile_files() {
        let dir = TestDir::new();
        let root = dir.0.join("logs");
        let dumps = dir.0.join("reports");
        fs::create_dir(&dumps).unwrap();
        for n in 0..5 {
            fs::write(dumps.join(format!("{n}.dmp")), b"dump").unwrap();
        }
        fs::write(dumps.join("Cookies"), b"private").unwrap();
        let diagnostics = Diagnostics::new(root, "test".into()).unwrap();
        diagnostics.0.webviews.lock().unwrap().push(WebviewInfo {
            label: "main".into(),
            runtime: "1.2".into(),
            dump_folder: Some(dumps),
            hook_ready: true,
        });
        // Multiple windows share the same WebView2 profile; never export a dump twice.
        let mut second = diagnostics.0.webviews.lock().unwrap()[0].clone();
        second.label = "main-2".into();
        diagnostics.0.webviews.lock().unwrap().push(second);
        let candidates = diagnostics.dump_candidates(now_ms());
        assert_eq!(
            candidates
                .iter()
                .map(|c| c.path.clone())
                .collect::<std::collections::HashSet<_>>()
                .len(),
            DUMP_COUNT
        );
        let target = dir.0.join("result.zip");
        diagnostics.export(&target).unwrap();
        let mut archive = zip::ZipArchive::new(File::open(target).unwrap()).unwrap();
        let mut manifest = String::new();
        archive
            .by_name("manifest.json")
            .unwrap()
            .read_to_string(&mut manifest)
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&manifest).unwrap()["dumpCount"],
            3
        );
        assert!(archive.by_name("Cookies").is_err());
        assert!(diagnostics.export(&dir.0.join("logs/result.zip")).is_err());
    }
}
