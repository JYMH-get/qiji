use super::{Diagnostics, WebviewInfo};
use serde_json::json;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, Runtime};
use webview2_com::{take_pwstr, Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};
use windows::{
    core::{Interface, PCWSTR, PWSTR},
    Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation},
    Win32::{
        Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL, UNICODE_STRING},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            ProcessStatus::{
                GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
            },
        },
        UI::Shell::CommandLineToArgvW,
    },
};

const BROWSER_ARGUMENT_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_COMMAND_LINE_BYTES: usize = 65_534;
static ARGUMENT_QUERY_RUNNING: AtomicBool = AtomicBool::new(false);

struct ArgumentQueryPermit;
impl Drop for ArgumentQueryPermit {
    fn drop(&mut self) {
        ARGUMENT_QUERY_RUNNING.store(false, Ordering::Release);
    }
}

#[derive(Debug)]
struct ArgumentReadError {
    code: &'static str,
    native_code: Option<i32>,
}

impl ArgumentReadError {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            native_code: None,
        }
    }
    fn native(code: &'static str, native_code: i32) -> Self {
        Self {
            code,
            native_code: Some(native_code),
        }
    }
    fn value(self) -> serde_json::Value {
        json!({"status":"unavailable","failureCode":self.code,"nativeCode":self.native_code})
    }
}

/// Restrict collection to the exact browser PID supplied by this WebView's API,
/// and verify that it is still a WebView2 descendant of this application.
fn owns_browser_pid(pid: u32) -> bool {
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut processes = Vec::new();
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let is_webview = String::from_utf16_lossy(&entry.szExeFile[..end])
                    .eq_ignore_ascii_case("msedgewebview2.exe");
                processes.push((entry.th32ProcessID, entry.th32ParentProcessID, is_webview));
                if processes.len() >= 32768 || Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        let mut cursor = pid;
        for _ in 0..16 {
            let Some((_, parent, true)) = processes
                .iter()
                .find(|(candidate, _, _)| *candidate == cursor)
            else {
                return false;
            };
            if *parent == std::process::id() {
                return true;
            }
            if *parent == cursor {
                return false;
            }
            cursor = *parent;
        }
        false
    }
}

/// The NT call returns a caller-owned UNICODE_STRING; validate its complete
/// range before reading. Neither that string nor process paths reach a log.
unsafe fn read_command_line(handle: HANDLE) -> Result<Vec<u16>, ArgumentReadError> {
    let mut required = 0u32;
    let first = NtQueryInformationProcess(
        handle,
        ProcessCommandLineInformation,
        std::ptr::null_mut(),
        0,
        &mut required,
    );
    let minimum = std::mem::size_of::<UNICODE_STRING>();
    let maximum = MAX_COMMAND_LINE_BYTES + minimum + 2;
    if required as usize <= minimum || required as usize > maximum {
        return Err(ArgumentReadError::native(
            "command_line_size_unavailable",
            first.0,
        ));
    }
    // usize backing storage keeps the UNICODE_STRING and pointer aligned.
    let mut buffer = vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
    let capacity = buffer.len() * std::mem::size_of::<usize>();
    let status = NtQueryInformationProcess(
        handle,
        ProcessCommandLineInformation,
        buffer.as_mut_ptr().cast(),
        capacity as u32,
        &mut required,
    );
    if status.0 < 0 {
        return Err(ArgumentReadError::native(
            "command_line_query_failed",
            status.0,
        ));
    }
    let unicode = std::ptr::read(buffer.as_ptr().cast::<UNICODE_STRING>());
    let start = buffer.as_ptr() as usize;
    let ptr = unicode.Buffer.0 as usize;
    let length = usize::from(unicode.Length);
    if length == 0
        || length > MAX_COMMAND_LINE_BYTES
        || length % 2 != 0
        || length > usize::from(unicode.MaximumLength)
        || ptr % std::mem::align_of::<u16>() != 0
        || ptr < start + minimum
        || ptr
            .checked_add(length)
            .map_or(true, |end| end > start + capacity)
    {
        return Err(ArgumentReadError::new("command_line_invalid_range"));
    }
    let command_line = std::slice::from_raw_parts(unicode.Buffer.0, length / 2).to_vec();
    if command_line.contains(&0) {
        return Err(ArgumentReadError::new("command_line_invalid_text"));
    }
    Ok(command_line)
}

fn command_line_arguments(command_line: &[u16]) -> Result<Vec<String>, ArgumentReadError> {
    let mut terminated = command_line.to_vec();
    terminated.push(0);
    unsafe {
        let mut count = 0;
        let argv = CommandLineToArgvW(PCWSTR(terminated.as_ptr()), &mut count);
        if argv.is_null() {
            return Err(ArgumentReadError::new("command_line_parse_failed"));
        }
        let result = if !(1..=4096).contains(&count) {
            Err(ArgumentReadError::new("command_line_argument_limit"))
        } else {
            std::slice::from_raw_parts(argv, count as usize)
                .iter()
                .map(|value| {
                    value
                        .to_string()
                        .map_err(|_| ArgumentReadError::new("command_line_invalid_text"))
                })
                .collect()
        };
        let _ = LocalFree(Some(HLOCAL(argv.cast())));
        result
    }
}

fn feature_present(list: Option<&str>, target: &str) -> bool {
    list.is_some_and(|list| {
        list.split(',')
            .any(|entry| entry.split(['<', ':']).next() == Some(target))
    })
}

/// Only a fixed allowlist is serialized. Respect the last occurrence of a
/// Chromium switch and never match text embedded inside paths/other values.
fn argument_flags(arguments: &[String]) -> serde_json::Value {
    let mut disabled = false;
    let mut forced = false;
    let mut disabled_features = None;
    for argument in arguments
        .iter()
        .skip(1)
        .take_while(|argument| argument.as_str() != "--")
    {
        let (name, value) = argument.split_once('=').unwrap_or((argument, ""));
        match name {
            "--disable-renderer-accessibility" => disabled = true,
            "--force-renderer-accessibility" => forced = true,
            "--disable-features" => disabled_features = Some(value),
            _ => {}
        }
    }
    json!({
        "disableRendererAccessibility":disabled,
        "forceRendererAccessibility":forced,
        "blockFlowIteratorDisabled":feature_present(disabled_features, "AccessibilityBlockFlowIterator"),
    })
}

fn browser_argument_sample(pid: u32) -> Result<serde_json::Value, ArgumentReadError> {
    if pid == 0 || pid == std::process::id() {
        return Err(ArgumentReadError::new("browser_pid_not_owned"));
    }
    unsafe {
        let handle =
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).map_err(|error| {
                ArgumentReadError::native("browser_process_open_failed", error.code().0)
            })?;
        let result = (|| {
            // Hold the process handle while checking ownership, so the queried
            // process identity cannot silently change after a PID-only check.
            if !owns_browser_pid(pid) {
                return Err(ArgumentReadError::new("browser_pid_not_owned"));
            }
            let mut image = vec![0u16; 32768];
            let mut length = image.len() as u32;
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(image.as_mut_ptr()),
                &mut length,
            )
            .map_err(|error| {
                ArgumentReadError::native("browser_identity_unavailable", error.code().0)
            })?;
            let image = String::from_utf16_lossy(&image[..length as usize]);
            if !image
                .rsplit(['\\', '/'])
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("msedgewebview2.exe"))
            {
                return Err(ArgumentReadError::new("browser_identity_mismatch"));
            }
            let text = read_command_line(handle)?;
            let arguments = command_line_arguments(&text)?;
            Ok(json!({"status":"ok","flags":argument_flags(&arguments)}))
        })();
        let _ = CloseHandle(handle);
        result
    }
}

fn bounded_argument_sample<F>(sample: F, timeout: Duration) -> serde_json::Value
where
    F: FnOnce() -> Result<serde_json::Value, ArgumentReadError> + Send + 'static,
{
    let started = Instant::now();
    // A timeout bounds the caller's wait, not the Windows syscall. The real
    // worker owns this permit until it exits, including after a timeout/panic.
    // A stuck provider therefore cannot create one blocked thread per window.
    if ARGUMENT_QUERY_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return json!({"status":"unavailable","failureCode":"sampler_busy","durationMs":0,"timeoutMs":timeout.as_millis() as u64});
    }
    let permit = ArgumentQueryPermit;
    let (sender, receiver) = mpsc::sync_channel(1);
    let spawn = std::thread::Builder::new()
        .name("qiji-browser-arguments-query".into())
        .spawn(move || {
            let _permit = permit;
            let _ = sender.send(sample());
        });
    let mut result = if spawn.is_err() {
        ArgumentReadError::new("query_worker_unavailable").value()
    } else {
        match receiver.recv_timeout(timeout) {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => error.value(),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                json!({"status":"timeout","failureCode":"query_timeout"})
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                ArgumentReadError::new("query_worker_unavailable").value()
            }
        }
    };
    result["durationMs"] = json!(started.elapsed().as_millis() as u64);
    result["timeoutMs"] = json!(timeout.as_millis() as u64);
    result
}

fn schedule_argument_sample(
    diagnostics: Diagnostics,
    label: String,
    runtime: String,
    browser_pid: u32,
) {
    let fallback = diagnostics.clone();
    let fallback_label = label.clone();
    let fallback_runtime = runtime.clone();
    let spawn = std::thread::Builder::new().name("qiji-browser-arguments".into()).spawn(move || {
        let sample = bounded_argument_sample(move || browser_argument_sample(browser_pid), BROWSER_ARGUMENT_TIMEOUT);
        let sampled_at = super::now_ms();
        let _ = diagnostics.record(json!({"kind":"webview_browser_arguments","window":label,"runtime":runtime,"browserProcessId":browser_pid,"browserArguments":sample}));
        if let Ok(mut views) = diagnostics.0.webviews.lock() {
            if let Some(info) = views.iter_mut().find(|info| info.label == label && info.browser_process_id == Some(browser_pid) && info.runtime == runtime) {
                info.browser_arguments = sample;
                info.browser_arguments_sampled_at_ms = Some(sampled_at);
            }
        }
    });
    if spawn.is_err() {
        let sample = ArgumentReadError::new("sampler_worker_unavailable").value();
        let _ = fallback.record(json!({"kind":"webview_browser_arguments","window":fallback_label,"runtime":fallback_runtime,"browserProcessId":browser_pid,"browserArguments":sample}));
        if let Ok(mut views) = fallback.0.webviews.lock() {
            if let Some(info) = views.iter_mut().find(|info| {
                info.label == fallback_label && info.browser_process_id == Some(browser_pid)
            }) {
                info.browser_arguments = sample;
                info.browser_arguments_sampled_at_ms = Some(super::now_ms());
            }
        }
    }
}

pub(super) fn os_version() -> serde_json::Value {
    let version = windows_version::OsVersion::current();
    json!({"major":version.major,"minor":version.minor,"build":version.build,"revision":windows_version::revision(),"server":windows_version::is_server()})
}

pub(super) fn attach<R: Runtime>(webview: &tauri::Webview<R>) {
    let Some(state) = webview.try_state::<Diagnostics>() else {
        return;
    };
    let diagnostics = state.inner().clone();
    let label = webview.label().to_owned();
    let failure_diagnostics = diagnostics.clone();
    let failure_label = label.clone();
    let result = webview.with_webview(move |view| unsafe {
        let result: windows::core::Result<()> = (|| {
            let core = view.controller().CoreWebView2()?;
            let mut browser_pid = 0;
            let browser_process_id = core.BrowserProcessId(&mut browser_pid).ok().and_then(|_| (browser_pid != 0).then_some(browser_pid));
            let mut info = WebviewInfo { label:label.clone(),runtime:"unavailable".into(),dump_folder:None,hook_ready:false,
                browser_process_id,browser_arguments:if browser_process_id.is_some() {json!({"status":"pending"})}else{json!({"status":"unavailable","failureCode":"browser_pid_unavailable"})},browser_arguments_sampled_at_ms:None };
            if let Ok(environment) = core.cast::<ICoreWebView2_2>().and_then(|c| c.Environment()) {
                let mut version = PWSTR::null();
                if environment.BrowserVersionString(&mut version).is_ok() { info.runtime = take_pwstr(version).chars().take(128).collect(); }
                if let Ok(environment11) = environment.cast::<ICoreWebView2Environment11>() {
                    let mut folder = PWSTR::null();
                    if environment11.FailureReportFolderPath(&mut folder).is_ok() {
                        let path = PathBuf::from(take_pwstr(folder));
                        if path.is_absolute() { info.dump_folder = Some(path); }
                    }
                }
            }
            let event_diagnostics = diagnostics.clone();
            let event_label = label.clone();
            let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                if let Some(args) = args {
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    let kind = args.ProcessFailedKind(&mut kind).ok().map(|_|kind.0);
                    let mut reason = None;
                    let mut exit_code = None;
                    if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                        let mut value = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                        reason = args2.Reason(&mut value).ok().map(|_|value.0);
                        let mut value = 0;
                        exit_code = args2.ExitCode(&mut value).ok().map(|_|value);
                    }
                    let _ = event_diagnostics.record(json!({"kind":"webview_process_failed","window":event_label,"browserProcessId":browser_process_id,"processFailedKind":kind,"reason":reason,"exitCode":exit_code,"exitCodeHex":exit_code.map(|v|format!("0x{:08X}",v as u32))}));
                    // Native sampling remains possible after the renderer has died.
                    let _ = event_diagnostics.record(memory_sample());
                }
                Ok(())
            }));
            let mut token = 0;
            let hook_result = core.add_ProcessFailed(&handler, &mut token);
            info.hook_ready = hook_result.is_ok();
            let runtime = info.runtime.clone();
            let _ = diagnostics.record(json!({"kind":"webview_ready","window":label,"runtime":info.runtime,"processFailedHookReady":info.hook_ready,"dumpFolderAvailable":info.dump_folder.is_some(),"browserProcessId":browser_process_id,"browserArguments":info.browser_arguments}));
            if let Ok(mut views) = diagnostics.0.webviews.lock() {
                views.retain(|w| w.label != label);
                views.push(info);
                if views.len() > 64 { views.remove(0); }
            }
            if let Some(pid) = browser_process_id {
                schedule_argument_sample(diagnostics.clone(), label.clone(), runtime, pid);
            }
            hook_result
        })();
        if let Err(error) = result {
            let _ = diagnostics.record(json!({"kind":"webview_hook_failed","window":label,"hresult":error.code().0}));
        }
    });
    if result.is_err() {
        let _ = failure_diagnostics
            .record(json!({"kind":"webview_hook_failed","window":failure_label}));
    }
}

/// Reads only PID/parent/executable identity to select this application's WebView2 subtree.
/// No process command lines, project paths, window titles, or GPU allocations are captured.
pub(super) fn memory_sample() -> serde_json::Value {
    unsafe {
        let own_pid = std::process::id();
        let mut processes = Vec::new();
        if let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let end = entry
                        .szExeFile
                        .iter()
                        .position(|c| *c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let is_webview = String::from_utf16_lossy(&entry.szExeFile[..end])
                        .eq_ignore_ascii_case("msedgewebview2.exe");
                    processes.push((entry.th32ProcessID, entry.th32ParentProcessID, is_webview));
                    if processes.len() >= 32768 || Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        let mut pids = HashSet::from([own_pid]);
        for _ in 0..16 {
            let count = pids.len();
            for (pid, parent, is_webview) in &processes {
                if *is_webview && pids.contains(parent) && pids.len() < 128 {
                    pids.insert(*pid);
                }
            }
            if count == pids.len() {
                break;
            }
        }
        let mut rows = Vec::new();
        let mut unavailable = 0;
        for pid in pids {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid)
            else {
                unavailable += 1;
                continue;
            };
            let mut counters = PROCESS_MEMORY_COUNTERS_EX {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                ..Default::default()
            };
            let result = GetProcessMemoryInfo(
                handle,
                (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX)
                    .cast::<PROCESS_MEMORY_COUNTERS>(),
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            );
            let _ = CloseHandle(handle);
            if result.is_ok() {
                rows.push(json!({"pid":pid,"scope":if pid==own_pid {"host"} else {"webview2_descendant"},"workingSetBytes":counters.WorkingSetSize,"privateBytes":counters.PrivateUsage,"peakWorkingSetBytes":counters.PeakWorkingSetSize}));
            } else {
                unavailable += 1;
            }
        }
        rows.sort_by_key(|v| v["pid"].as_u64());
        json!({"kind":"native_memory","processes":rows,"unavailableProcesses":unavailable,"scope":"host_and_descendant_webview2"})
    }
}

#[cfg(test)]
#[path = "diagnostics_windows_tests.rs"]
mod tests;
