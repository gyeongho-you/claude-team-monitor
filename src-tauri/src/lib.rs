mod agents_json;
mod live_rows;
mod paths;
mod session_registry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      agents_json::get_agents_json,
      session_registry::get_all_background_sessions,
      session_registry::get_adoptable_sessions,
      live_rows::get_live_session_rows,
    ])
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
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
