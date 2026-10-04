fn main() {
    println!("cargo:rerun-if-env-changed=NYXEN_UPLOAD_KEY");
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var("NYXEN_UPLOAD_KEY").map_or(true, |key| key.trim().is_empty())
    {
        panic!("NYXEN_UPLOAD_KEY is required for release builds; use scripts/package-client.ps1");
    }
    tauri_build::build();

    // Tauri embeds its Windows resources in binary targets only. The opt-in
    // WebView smoke test is a lib test executable and needs this dependency too.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && std::env::var_os("CARGO_FEATURE_DIAGNOSTICS_SMOKE").is_some()
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        // The app binary already has Tauri's manifest in resource.lib. Avoid a
        // duplicate manifest if this test-only feature is also used for a build.
        println!("cargo:rustc-link-arg-bin=app=/MANIFEST:NO");
    }
}
