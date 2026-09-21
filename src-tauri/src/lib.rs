mod agents_json;
mod board_state;
mod claude_bg_output;
mod claude_readiness;
mod concurrency;
mod daemon_state;
mod favorites;
mod git_diff;
mod json_file;
mod lead_admin;
mod lead_lifecycle;
mod live_rows;
mod logging;
mod long_prompt_guard;
mod member_requests;
mod member_templates;
mod native_dialog;
mod notice_queue;
mod paths;
mod resume;
mod session_registry;
mod settings;
mod stall_watchdog;
mod timing;
mod transcript;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // pick-directory(main.ts:2467, dialog.showOpenDialog)의 Tauri 대응 — 네이티브 폴더 선택
    // 다이얼로그는 tauri 코어가 아니라 공식 플러그인(tauri-plugin-dialog)으로 제공된다.
    .plugin(tauri_plugin_dialog::init())
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
      favorites::get_favorites_command,
      favorites::add_favorite_command,
      favorites::remove_favorite_command,
      favorites::update_favorite_name_command,
      session_registry::register_probable_member_command,
      session_registry::get_interactive_sessions_command,
      member_templates::get_member_templates_command,
      member_templates::add_member_template_command,
      member_templates::update_member_template_command,
      member_templates::toggle_member_template_approved_command,
      member_templates::delete_member_template_command,
      git_diff::get_changed_files_command,
      git_diff::get_file_diff_command,
      transcript::get_lead_transcript_command,
      daemon_state::get_pending_choice_command,
      daemon_state::get_chat_unresolvable_detail_command,
      lead_admin::delete_lead_history_command,
      lead_admin::set_lead_auto_stall_nudge_command,
      lead_admin::update_lead_label_command,
      settings::get_settings_command,
      settings::update_settings_command,
      live_rows::refresh_board_command,
      native_dialog::pick_directory_command,
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
