mod agents_json;
mod attach_terminal;
mod board_state;
mod claude_bg_output;
mod claude_readiness;
mod concurrency;
mod json_file;
mod lead_lifecycle;
mod live_rows;
mod logging;
mod long_prompt_guard;
mod member_requests;
mod notice_queue;
mod paths;
mod resume;
mod session_registry;
mod stall_watchdog;
mod timing;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      agents_json::get_agents_json,
      session_registry::get_all_background_sessions,
      session_registry::get_adoptable_sessions,
      live_rows::get_live_session_rows,
      stall_watchdog::get_stall_alerts,
      stall_watchdog::confirm_stall_alert,
      stall_watchdog::dismiss_stall_alert,
      resume::resume_lead_command,
      lead_lifecycle::restart_lead_command,
      lead_lifecycle::end_lead_work_command,
      lead_lifecycle::launch_team_lead_command,
      lead_lifecycle::adopt_lead_command,
      lead_lifecycle::fork_session_as_lead_command,
      lead_lifecycle::launch_member_command,
      resume::stop_background_session_command,
      notice_queue::send_to_lead_command,
      notice_queue::cancel_queued_message_command,
      notice_queue::get_pending_notice_ids_command,
      notice_queue::approve_request_command,
      notice_queue::deny_request_command,
      attach_terminal::open_in_terminal_command,
      attach_terminal::open_terminal_for_approval_command,
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
