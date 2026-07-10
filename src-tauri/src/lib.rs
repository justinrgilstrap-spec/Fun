use tauri::Manager;

// Cross-platform: previously read the HOME env var directly, which isn't set
// on Windows (it uses USERPROFILE) and would panic there. Tauri's own path
// resolver knows the right "Documents" folder per OS (macOS: ~/Documents,
// Windows: C:\Users\<user>\Documents, Linux: ~/Documents or XDG equivalent),
// so this now works unmodified on every platform Tauri supports.
#[tauri::command]
fn get_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("Claude")
        .join("Footprint")
        .join("public")
        .join("data");
    Ok(dir.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_data_dir])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
