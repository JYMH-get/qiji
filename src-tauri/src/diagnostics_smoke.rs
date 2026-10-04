//! Explicit opt-in test: two hidden, isolated WebViews; never uses the installed app/profile.
//! Compile with `cargo test --lib --features diagnostics-smoke --no-run`.
//! On Windows/MSVC, build.rs embeds the Common-Controls v6 dependency in this test EXE.
//! A restricted token may prevent WebView2 subprocess creation.
use super::*;
use std::borrow::Cow;
use std::sync::mpsc;
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};

struct SmokeAssets;
impl<R: Runtime> tauri::Assets<R> for SmokeAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        Some(Cow::Borrowed(
            b"<!doctype html><title>Isolated Qiji diagnostics test</title>",
        ))
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

#[cfg(windows)]
#[test]
#[ignore = "Creates isolated hidden WebView2 windows and deliberately crashes only their renderer"]
fn isolated_webview_crash_and_export() {
    let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("outputs/client-diagnostics-20261003");
    fs::create_dir_all(&output).unwrap();
    let root = output.join(format!("native-smoke-{}", now_ms()));
    fs::create_dir_all(&root).unwrap();
    let profile = root.join("profile");
    let logs = root.join("diagnostics");
    let zip = output.join("native-smoke.zip");
    let ipc_zip = root.join("native-ipc-export.zip");
    let report = output.join("native-smoke-result.json");
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().build.dev_url = None;
    context.config_mut().identifier = "com.qiji.diagnostics-smoke".into();
    context.set_assets(Box::new(SmokeAssets));
    let (sender, receiver) = mpsc::channel();
    let app = tauri::Builder::default().any_thread()
        .plugin(init_at(Some(logs.clone())))
        .invoke_handler(tauri::generate_handler![record_client_diagnostic,export_client_diagnostics])
        .setup(move |app| {
            let first = tauri::WebviewWindowBuilder::new(app, "smoke-main", tauri::WebviewUrl::App("index.html".into()))
                .data_directory(profile.clone()).title("Qiji isolated diagnostics smoke").visible(false)
                .initialization_script("setTimeout(() => window.__TAURI_INTERNALS__.invoke('record_client_diagnostic',{event:{kind:'save_stage',stage:'serialize',saveId:909,nodeCount:10}}).catch(()=>{}),100);")
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<Value,String> {
                    let second=tauri::WebviewWindowBuilder::new(&handle,"smoke-secondary",tauri::WebviewUrl::App("index.html".into()))
                        .data_directory(profile).visible(false).build().map_err(|e|e.to_string())?;
                    let diagnostics=handle.state::<Diagnostics>().inner().clone();
                    let read_logs=|| files_in(&logs,"jsonl").into_iter().filter_map(|f|fs::read_to_string(f.path).ok()).collect::<Vec<_>>().join("\n");
                    let mut hooked=false;
                    for _ in 0..100 {
                        if diagnostics.0.webviews.lock().unwrap().iter().filter(|w|w.hook_ready).count()==2 { hooked=true;break; }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    if !hooked { return Err("Both isolated window hooks were not registered".into()); }
                    let mut ipc_recorded=false;
                    for _ in 0..100 {
                        if read_logs().contains("\"saveId\":909") { ipc_recorded=true;break; }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    if !ipc_recorded { return Err("JS to native diagnostic IPC did not succeed".into()); }
                    let script=format!("window.__TAURI_INTERNALS__.invoke('export_client_diagnostics',{{path:{}}}).catch(()=>{{}})",serde_json::to_string(&ipc_zip.to_string_lossy()).unwrap());
                    first.eval(&script).map_err(|e|e.to_string())?;
                    let mut ipc_exported=false;
                    for _ in 0..100 {
                        if ipc_zip.exists() { ipc_exported=true;break; }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    if !ipc_exported { return Err("JS to native ZIP export IPC did not succeed".into()); }
                    // Exercise actual command functions too, retaining ordinary validation/blocking behavior.
                    let event=serde_json::from_value(json!({"kind":"save_stage","stage":"write","saveId":910})).unwrap();
                    tauri::async_runtime::block_on(record_client_diagnostic(first.clone(),handle.state(),event))?;
                    let sample=platform::memory_sample(); diagnostics.record(sample.clone()).map_err(|e|e.to_string())?;
                    first.navigate("edge://crash".parse().unwrap()).map_err(|e|e.to_string())?;
                    let mut crash_recorded=false;
                    for _ in 0..100 {
                        if read_logs().contains("webview_process_failed") { crash_recorded=true;break; }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    // Give WebView2 time to finish its crash report; logs remain valid without a dump.
                    std::thread::sleep(Duration::from_secs(2));
                    let zip_path=tauri::async_runtime::block_on(export_client_diagnostics(handle.state(),zip.to_string_lossy().into_owned()))?;
                    let result=json!({"twoWindowHooks":hooked,"javascriptIpcRecorded":ipc_recorded,"javascriptIpcExported":ipc_exported,"nativeCommandRecorded":read_logs().contains("\"saveId\":910"),"crashRecorded":crash_recorded,"nativeMemory":sample,"zip":zip_path});
                    fs::write(&report,serde_json::to_vec_pretty(&result).unwrap()).map_err(|e|e.to_string())?;
                    let _=second;
                    if !crash_recorded { return Err("Isolated edge://crash produced no ProcessFailed event; result JSON preserved".into()); }
                    Ok(result)
                }));
                let result=result.unwrap_or_else(|_|Err("Smoke thread panic".into()));
                let _=sender.send(result);
                handle.exit(0);
            });
            Ok(())
        }).build(context).unwrap();
    assert_eq!(app.run_return(|_, _| {}), 0);
    let result = receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}
