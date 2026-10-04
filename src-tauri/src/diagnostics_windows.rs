use super::{Diagnostics, WebviewInfo};
use serde_json::json;
use std::{collections::HashSet, path::PathBuf};
use tauri::{Manager, Runtime};
use webview2_com::{take_pwstr, Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};
use windows::{
    core::{Interface, PWSTR},
    Win32::{
        Foundation::CloseHandle,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            ProcessStatus::{
                GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
            },
            Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ},
        },
    },
};

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
            let mut info = WebviewInfo { label:label.clone(),runtime:"unavailable".into(),dump_folder:None,hook_ready:false };
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
                    let _ = event_diagnostics.record(json!({"kind":"webview_process_failed","window":event_label,"processFailedKind":kind,"reason":reason,"exitCode":exit_code,"exitCodeHex":exit_code.map(|v|format!("0x{:08X}",v as u32))}));
                    // Native sampling remains possible after the renderer has died.
                    let _ = event_diagnostics.record(memory_sample());
                }
                Ok(())
            }));
            let mut token = 0;
            let hook_result = core.add_ProcessFailed(&handler, &mut token);
            info.hook_ready = hook_result.is_ok();
            let _ = diagnostics.record(json!({"kind":"webview_ready","window":label,"runtime":info.runtime,"processFailedHookReady":info.hook_ready,"dumpFolderAvailable":info.dump_folder.is_some()}));
            if let Ok(mut views) = diagnostics.0.webviews.lock() {
                views.retain(|w| w.label != label);
                views.push(info);
                if views.len() > 64 { views.remove(0); }
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
