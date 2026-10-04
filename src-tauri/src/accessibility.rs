//! Application-local accessibility preference. The active mode is immutable for
//! this process: every WebView must use the same browser arguments until exit.
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

const PREFERENCE_FILE: &str = "accessibility.json";
const DEFAULT_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --enable-features=WebGPU";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Serialize)]
struct Preference {
    enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilitySettings {
    supported: bool,
    enabled: bool,
    active_enabled: bool,
    restart_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    preference_read_error: Option<String>,
}

pub struct AccessibilityState {
    supported: bool,
    path: Result<PathBuf, String>,
    active_enabled: bool,
    browser_args: String,
    /// Serializes reads and atomic replacements across every application window.
    preference_lock: Mutex<()>,
}

fn read_preference(path: &Path) -> Result<bool, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("读取无障碍设置失败：{error}")),
    };
    serde_json::from_slice::<Preference>(&bytes)
        .map(|preference| preference.enabled)
        .map_err(|error| format!("无障碍设置文件损坏，请重新保存此设置：{error}"))
}

fn browser_args(base: &str, supported: bool, enabled: bool) -> String {
    if !supported {
        return base.to_owned();
    }
    let mut arguments: Vec<&str> = base
        .split_whitespace()
        .filter(|argument| {
            !matches!(
                *argument,
                "--disable-renderer-accessibility" | "--force-renderer-accessibility"
            ) && !argument.starts_with("--force-renderer-accessibility=")
                && !argument.starts_with("--disable-renderer-accessibility=")
        })
        .collect();
    // Enabling restores WebView2's on-demand behavior. Forcing the full AX tree
    // would create work even when no assistive client has requested it.
    if !enabled {
        arguments.push("--disable-renderer-accessibility");
    }
    arguments.join(" ")
}

impl AccessibilityState {
    fn new(path: Result<PathBuf, String>, supported: bool, base_args: &str) -> Self {
        let active_enabled = supported
            && path
                .as_ref()
                .ok()
                .and_then(|path| read_preference(path).ok())
                .unwrap_or(false);
        Self {
            supported,
            path,
            active_enabled,
            browser_args: browser_args(base_args, supported, active_enabled),
            preference_lock: Mutex::new(()),
        }
    }

    fn status(&self, enabled: bool) -> AccessibilitySettings {
        AccessibilitySettings {
            supported: self.supported,
            enabled,
            active_enabled: self.active_enabled,
            restart_required: self.supported && enabled != self.active_enabled,
            preference_read_error: None,
        }
    }

    fn get(&self) -> Result<AccessibilitySettings, String> {
        if !self.supported {
            return Ok(self.status(false));
        }
        let path = self.path.as_ref().map_err(Clone::clone)?;
        let _lock = self
            .preference_lock
            .lock()
            .map_err(|_| "无障碍设置当前不可用，请重启 Qiji".to_owned())?;
        match read_preference(path) {
            Ok(enabled) => Ok(self.status(enabled)),
            Err(error) => {
                // A corrupt/unreadable preference is visible and repairable in
                // Settings; never claim it was saved or request a false restart.
                let mut status = self.status(false);
                status.restart_required = false;
                status.preference_read_error = Some(error);
                Ok(status)
            }
        }
    }

    fn set(&self, enabled: bool) -> Result<AccessibilitySettings, String> {
        if !self.supported {
            return Err("当前平台不支持此无障碍设置".to_owned());
        }
        let path = self.path.as_ref().map_err(Clone::clone)?;
        let _lock = self
            .preference_lock
            .lock()
            .map_err(|_| "无障碍设置当前不可用，请重启 Qiji".to_owned())?;
        write_preference(path, enabled)?;
        // Do not mutate active_enabled or browser_args. A new window in this
        // process must stay compatible with the already-running WebView2 host.
        Ok(self.status(enabled))
    }
}

fn write_preference(path: &Path, enabled: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "无障碍设置路径无效".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| format!("创建设置目录失败：{error}"))?;
    let temporary = parent.join(format!(
        ".accessibility-{}-{}.tmp",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let bytes = serde_json::to_vec(&Preference { enabled })
            .map_err(|error| format!("生成无障碍设置失败：{error}"))?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("创建临时设置文件失败：{error}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("写入无障碍设置失败：{error}"))?;
        drop(file);
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| format!("替换无障碍设置失败：{error}"))
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|error| format!("替换无障碍设置失败：{error}"))?;
    if let Some(parent) = to.parent() {
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("同步设置目录失败：{error}"))?;
    }
    Ok(())
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    init_with_path(None)
}

fn init_with_path<R: Runtime>(test_path: Option<PathBuf>) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("accessibility-settings")
        .setup(move |app, _| {
            let path = match test_path {
                Some(path) => Ok(path),
                None => app
                    .path()
                    .app_config_dir()
                    .map(|directory| directory.join(PREFERENCE_FILE))
                    .map_err(|error| format!("无法定位 Qiji 设置目录：{error}")),
            };
            let configured_args = app
                .config()
                .app
                .windows
                .first()
                .and_then(|window| window.additional_browser_args.as_deref())
                .unwrap_or(DEFAULT_BROWSER_ARGS);
            app.manage(AccessibilityState::new(
                path,
                cfg!(windows),
                configured_args,
            ));
            Ok(())
        })
        .build()
}

#[cfg(all(test, windows, feature = "diagnostics-smoke"))]
mod native_smoke {
    use super::*;
    use std::borrow::Cow;
    use std::os::windows::process::CommandExt;
    use std::sync::mpsc;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

    struct SmokeAssets;
    impl<R: Runtime> tauri::Assets<R> for SmokeAssets {
        fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
            Some(Cow::Borrowed(
                b"<!doctype html><title>Isolated accessibility smoke</title>",
            ))
        }
        fn iter(&self) -> Box<AssetsIter<'_>> {
            Box::new(std::iter::empty())
        }
        fn csp_hashes(&self, _path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
            Box::new(std::iter::empty())
        }
    }

    fn browser_pid(window: &tauri::WebviewWindow) -> Result<u32, String> {
        let (sender, receiver) = mpsc::channel();
        window
            .with_webview(move |webview| {
                let result = (|| unsafe {
                    let core = webview.controller().CoreWebView2()?;
                    let mut pid = 0;
                    core.BrowserProcessId(&mut pid)?;
                    Ok::<u32, windows::core::Error>(pid)
                })()
                .map_err(|error| error.to_string());
                let _ = sender.send(result);
            })
            .map_err(|error| error.to_string())?;
        receiver
            .recv_timeout(Duration::from_secs(10))
            .map_err(|error| error.to_string())?
    }

    fn run_smoke(enabled: bool) {
        let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("outputs/accessibility-toggle-20261004");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let root = output.join(format!("native-smoke-{enabled}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let preference = root.join(PREFERENCE_FILE);
        write_preference(&preference, enabled).unwrap();
        let profile = root.join("profile");
        let report = output.join(format!("native-smoke-{enabled}.json"));
        let mut context = tauri::generate_context!();
        context.config_mut().app.windows.clear();
        context.config_mut().build.dev_url = None;
        context.config_mut().identifier = "com.qiji.accessibility-smoke".into();
        context.set_assets(Box::new(SmokeAssets));
        let (sender, receiver) = mpsc::channel();
        let app = tauri::Builder::default().any_thread()
            .plugin(init_with_path(Some(preference)))
            .setup(move |app| {
                let initial_args = active_browser_args(app.handle()).map_err(std::io::Error::other)?;
                let first = tauri::WebviewWindowBuilder::new(app, "smoke-main", tauri::WebviewUrl::App("index.html".into()))
                    .data_directory(profile.clone()).visible(false)
                    .additional_browser_args(&initial_args).build()?;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<serde_json::Value, String> {
                        let state = handle.state::<AccessibilityState>();
                        let before = state.get()?;
                        let saved = state.set(!enabled)?;
                        let second_args = active_browser_args(&handle)?;
                        if second_args != initial_args || saved.active_enabled != enabled || !saved.restart_required {
                            return Err("Saved preference incorrectly changed this process's active policy".into());
                        }
                        let second = tauri::WebviewWindowBuilder::new(&handle, "smoke-secondary", tauri::WebviewUrl::App("index.html".into()))
                            .data_directory(profile).visible(false)
                            .additional_browser_args(&second_args).build().map_err(|error| error.to_string())?;
                        let first_pid = browser_pid(&first)?;
                        let second_pid = browser_pid(&second)?;
                        if first_pid == 0 || first_pid != second_pid {
                            return Err("Isolated windows did not share their WebView2 browser process".into());
                        }
                        // Read only our isolated browser's command line. Keep
                        // boolean evidence; do not record arbitrary process text.
                        let command = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={first_pid}').CommandLine");
                        let command_line = std::process::Command::new("powershell.exe")
                            .args(["-NoProfile", "-NonInteractive", "-Command", &command])
                            .creation_flags(0x0800_0000).output().map_err(|error| error.to_string())?;
                        if !command_line.status.success() { return Err("Unable to inspect isolated browser command line".into()); }
                        let actual = String::from_utf8_lossy(&command_line.stdout);
                        let actual_disabled = actual.contains("--disable-renderer-accessibility");
                        let actual_forced = actual.contains("--force-renderer-accessibility");
                        if actual.trim().is_empty() || actual_disabled == enabled || actual_forced {
                            return Err("Actual isolated WebView2 flags did not match the frozen policy".into());
                        }
                        let result = serde_json::json!({
                            "initialEnabled": enabled, "before": before, "saved": saved,
                            "initialBrowserArgs": initial_args, "secondBrowserArgs": second_args,
                            "firstBrowserPid": first_pid, "secondBrowserPid": second_pid,
                            "actualDisableRendererAccessibility": actual_disabled,
                            "actualForceRendererAccessibility": actual_forced,
                            "twoHiddenWindowsCreated": true,
                            "nextStartupEnabled": read_preference(&root.join(PREFERENCE_FILE))?,
                        });
                        fs::write(&report, serde_json::to_vec_pretty(&result).unwrap()).map_err(|error| error.to_string())?;
                        Ok(result)
                    })).unwrap_or_else(|_| Err("Isolated accessibility smoke panicked".into()));
                    let _ = sender.send(result);
                    handle.exit(0);
                });
                Ok(())
            }).build(context).unwrap();
        assert_eq!(app.run_return(|_, _| {}), 0);
        let result = receiver
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .unwrap();
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    }

    #[test]
    #[ignore = "Creates two hidden WebViews with an isolated profile; run separately from other native smoke tests"]
    fn isolated_disabled_windows_keep_active_mode_after_save() {
        run_smoke(false);
    }

    #[test]
    #[ignore = "Creates two hidden WebViews with an isolated profile; run separately from other native smoke tests"]
    fn isolated_enabled_windows_keep_active_mode_after_save() {
        run_smoke(true);
    }
}

pub fn active_browser_args<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    app.try_state::<AccessibilityState>()
        .map(|state| state.browser_args.clone())
        .ok_or_else(|| "无障碍设置尚未初始化，无法创建窗口".to_owned())
}

#[tauri::command]
pub fn get_accessibility_settings(
    state: tauri::State<AccessibilityState>,
) -> Result<AccessibilitySettings, String> {
    state.get()
}

#[tauri::command]
pub fn set_accessibility_settings(
    enabled: bool,
    state: tauri::State<AccessibilityState>,
) -> Result<AccessibilitySettings, String> {
    state.set(enabled)
}

#[tauri::command]
pub fn get_accessibility_browser_args(state: tauri::State<AccessibilityState>) -> String {
    state.browser_args.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "qiji-accessibility-test-{}-{}",
                std::process::id(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn preference(&self) -> PathBuf {
            self.0.join(PREFERENCE_FILE)
        }
        fn state(&self) -> AccessibilityState {
            AccessibilityState::new(Ok(self.preference()), true, DEFAULT_BROWSER_ARGS)
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn absent_preference_defaults_off_without_writing() {
        let directory = TestDirectory::new();
        let state = directory.state();
        let status = state.get().unwrap();
        assert!(status.supported);
        assert!(!status.enabled && !status.active_enabled && !status.restart_required);
        assert!(!directory.preference().exists());
        assert!(state
            .browser_args
            .ends_with("--disable-renderer-accessibility"));
    }

    #[test]
    fn saved_preference_only_changes_after_complete_restart() {
        let directory = TestDirectory::new();
        let state = directory.state();
        let original_args = state.browser_args.clone();
        let saved = state.set(true).unwrap();
        assert!(saved.enabled && saved.restart_required && !saved.active_enabled);
        assert_eq!(state.browser_args, original_args);
        assert!(state.get().unwrap().enabled);
        let restarted = directory.state();
        assert!(restarted.active_enabled);
        assert!(!restarted.browser_args.contains("renderer-accessibility"));
        assert!(!restarted.get().unwrap().restart_required);
        let disabled = restarted.set(false).unwrap();
        assert!(!disabled.enabled && disabled.active_enabled && disabled.restart_required);
        assert!(!restarted.browser_args.contains("renderer-accessibility"));
        assert!(!directory.state().active_enabled);
    }

    #[test]
    fn returning_to_active_setting_cancels_pending_restart() {
        let directory = TestDirectory::new();
        let state = directory.state();
        state.set(true).unwrap();
        assert!(!state.set(false).unwrap().restart_required);
    }

    #[test]
    fn corrupt_preference_is_visible_and_can_be_repaired_to_default() {
        let directory = TestDirectory::new();
        fs::write(directory.preference(), b"{broken").unwrap();
        let state = directory.state();
        let status = state.get().unwrap();
        assert!(!status.active_enabled && !status.enabled && !status.restart_required);
        assert!(status.preference_read_error.is_some());
        assert!(state.set(false).unwrap().preference_read_error.is_none());
        assert!(state.get().unwrap().preference_read_error.is_none());
        assert!(!read_preference(&directory.preference()).unwrap());
    }

    #[test]
    fn missing_or_wrong_type_enabled_is_an_explicit_read_error() {
        let directory = TestDirectory::new();
        for bytes in [b"{}".as_slice(), b"{\"enabled\":\"false\"}".as_slice()] {
            fs::write(directory.preference(), bytes).unwrap();
            assert!(directory
                .state()
                .get()
                .unwrap()
                .preference_read_error
                .is_some());
        }
    }

    #[test]
    fn unavailable_config_directory_is_an_error() {
        let state = AccessibilityState::new(Err("path unavailable".into()), true, "");
        assert_eq!(state.get().unwrap_err(), "path unavailable");
        assert_eq!(state.set(true).unwrap_err(), "path unavailable");
        assert!(!state.active_enabled);
    }

    #[test]
    fn failed_replace_does_not_report_saved_and_removes_its_temporary_file() {
        let directory = TestDirectory::new();
        fs::create_dir(directory.preference()).unwrap();
        let state = directory.state();
        assert!(state.set(true).is_err());
        assert!(!state.active_enabled);
        assert!(directory.preference().is_dir());
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
    }

    #[test]
    fn replacing_existing_file_persists_valid_json_without_leftover_temp() {
        let directory = TestDirectory::new();
        let state = directory.state();
        for enabled in [true, false, true] {
            state.set(enabled).unwrap();
            assert_eq!(read_preference(&directory.preference()).unwrap(), enabled);
            assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
        }
    }

    #[test]
    fn arguments_restore_on_demand_mode_or_disable_and_keep_existing_features() {
        let original = format!("{DEFAULT_BROWSER_ARGS} --force-renderer-accessibility=complete --disable-renderer-accessibility");
        for enabled in [true, false] {
            let args = browser_args(&original, true, enabled);
            assert!(args.starts_with(DEFAULT_BROWSER_ARGS));
            assert_eq!(
                args.matches("renderer-accessibility").count(),
                usize::from(!enabled)
            );
            assert!(!args.contains("--force-renderer-accessibility"));
            assert_eq!(args.contains("--disable-renderer-accessibility"), !enabled);
        }
    }

    #[test]
    fn unsupported_platform_neither_reads_nor_writes_preferences() {
        let state = AccessibilityState::new(Err("no path".into()), false, "--existing");
        let status = state.get().unwrap();
        assert!(!status.supported && !status.enabled && !status.active_enabled);
        assert_eq!(state.browser_args, "--existing");
        assert!(state.set(true).is_err());
    }
}
