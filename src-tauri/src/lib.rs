#[tauri::command]
fn healthcheck() -> &'static str {
    "ready"
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![healthcheck])
        .run(tauri::generate_context!())
        .expect("error while running Moseek");
}
