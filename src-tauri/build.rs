fn main() {
    println!("cargo:rerun-if-env-changed=NYXEN_UPLOAD_KEY");
    tauri_build::build()
}
