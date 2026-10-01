// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod hardware;

#[tauri::command]
fn get_hardware_info() -> hardware::HardwareInfo {
    hardware::detect_hardware()
}
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, get_hardware_info])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
