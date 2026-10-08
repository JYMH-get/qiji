use super::*;

static SAMPLE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn wait_for_query_exit() {
    let deadline = Instant::now() + Duration::from_secs(1);
    while ARGUMENT_QUERY_RUNNING.load(Ordering::Acquire) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert!(!ARGUMENT_QUERY_RUNNING.load(Ordering::Acquire));
}

fn flags(text: &str) -> serde_json::Value {
    let arguments = command_line_arguments(&text.encode_utf16().collect::<Vec<_>>()).unwrap();
    argument_flags(&arguments)
}

#[test]
fn records_only_fixed_booleans_and_respects_windows_quoting() {
    let result = flags(
        r#""C:\private folder\msedgewebview2.exe" --user-data-dir="C:\private --force-renderer-accessibility" --token=secret-token --disable-renderer-accessibility "--disable-features=Existing,AccessibilityBlockFlowIterator" --enable-features=Unrelated"#,
    );
    assert_eq!(
        result,
        json!({
            "disableRendererAccessibility":true,
            "forceRendererAccessibility":false,
            "blockFlowIteratorDisabled":true,
        })
    );
    let encoded = result.to_string();
    assert!(!encoded.contains("private"));
    assert!(!encoded.contains("secret-token"));
    assert!(!encoded.contains("Existing"));
    assert!(!encoded.contains("Unrelated"));
}

#[test]
fn duplicate_feature_switches_follow_the_last_value_without_substring_matches() {
    let result = flags("browser.exe --disable-features=AccessibilityBlockFlowIterator --disable-features=OtherAccessibilityBlockFlowIterator,AccessibilityBlockFlowIteratorExtra --force-renderer-accessibility=complete");
    assert_eq!(result["blockFlowIteratorDisabled"], false);
    assert_eq!(result["forceRendererAccessibility"], true);
    assert_eq!(result["disableRendererAccessibility"], false);
}

#[test]
fn feature_trial_syntax_and_both_renderer_switches_remain_visible() {
    let result = flags("browser.exe --disable-features=AccessibilityBlockFlowIterator<Trial --enable-features=AccessibilityBlockFlowIterator:param/value --disable-renderer-accessibility --force-renderer-accessibility");
    assert_eq!(result["blockFlowIteratorDisabled"], true);
    assert_eq!(result["disableRendererAccessibility"], true);
    assert_eq!(result["forceRendererAccessibility"], true);
}

#[test]
fn arguments_after_the_switch_terminator_are_not_policy_flags() {
    let result = flags("browser.exe -- --disable-renderer-accessibility --disable-features=AccessibilityBlockFlowIterator");
    assert_eq!(result["disableRendererAccessibility"], false);
    assert_eq!(result["blockFlowIteratorDisabled"], false);
}

#[test]
fn native_command_line_query_reads_only_the_test_process_without_ax_or_cdp() {
    // Exercise the exact NT buffer layout in a live local process. The queried
    // text is never printed or written; this creates no WebView or AX provider.
    let command_line = unsafe {
        let handle =
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, std::process::id()).unwrap();
        let result = read_command_line(handle);
        let _ = CloseHandle(handle);
        result
    }
    .unwrap();
    let arguments = command_line_arguments(&command_line).unwrap();
    assert!(!arguments.is_empty());
    assert!(!arguments[0].is_empty());
}

#[test]
fn browser_sampler_refuses_unowned_or_host_processes() {
    for pid in [0, std::process::id()] {
        let error = browser_argument_sample(pid).unwrap_err();
        assert_eq!(error.code, "browser_pid_not_owned");
    }
}

#[test]
fn unavailable_and_timeout_do_not_claim_flags_are_disabled() {
    let _test_lock = SAMPLE_TEST_LOCK.lock().unwrap();
    let unavailable = bounded_argument_sample(
        || Err(ArgumentReadError::native("test_failure", -1)),
        Duration::from_secs(1),
    );
    assert_eq!(unavailable["status"], "unavailable");
    assert_eq!(unavailable["nativeCode"], -1);
    assert!(unavailable.get("flags").is_none());
    wait_for_query_exit();
    let timeout = bounded_argument_sample(
        || {
            std::thread::sleep(Duration::from_millis(50));
            Ok(json!({"status":"ok"}))
        },
        Duration::from_millis(1),
    );
    assert_eq!(timeout["status"], "timeout");
    assert_eq!(timeout["failureCode"], "query_timeout");
    assert!(timeout.get("flags").is_none());
    wait_for_query_exit();
}

#[test]
fn timed_out_worker_keeps_the_process_wide_permit_until_it_exits() {
    let _test_lock = SAMPLE_TEST_LOCK.lock().unwrap();
    let (started_sender, started_receiver) = mpsc::sync_channel(1);
    let (release_sender, release_receiver) = mpsc::sync_channel(1);
    let waiter = std::thread::spawn(move || {
        bounded_argument_sample(
            move || {
                started_sender.send(()).unwrap();
                release_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap();
                Ok(json!({"status":"ok"}))
            },
            Duration::from_millis(10),
        )
    });
    started_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert_eq!(waiter.join().unwrap()["status"], "timeout");
    let busy = bounded_argument_sample(
        || panic!("busy sampler must not start another query"),
        Duration::from_secs(1),
    );
    assert_eq!(busy["failureCode"], "sampler_busy");
    assert!(busy.get("flags").is_none());
    release_sender.send(()).unwrap();
    wait_for_query_exit();
    let next = bounded_argument_sample(|| Ok(json!({"status":"ok"})), Duration::from_secs(1));
    assert_eq!(next["status"], "ok");
    wait_for_query_exit();
}
