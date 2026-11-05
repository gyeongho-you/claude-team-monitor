mod agents_json;
mod attach_terminal;
mod board_state;
mod claude_bg_output;
mod claude_readiness;
mod concurrency;
mod daemon_state;
mod subagents;
mod activity;
mod app_skills;
mod daemon_reply;
mod pasted_images;
mod retired_members;
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
mod path_fix;
mod paths;
mod resume;
mod session_model;
mod session_registry;
mod panel_script;
mod side_panel;
mod settings;
mod stall_watchdog;
mod timing;
mod update_check;
mod transcript;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // macOS에서 Dock/Finder로 연 앱은 터미널의 PATH를 못 물려받아 claude/node를 못 찾는다 — 시작할 때 보정한다(path_fix.rs 설명 참고).
  path_fix::fix_path_env();
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
      lead_lifecycle::emergency_stop_lead_command,
      activity::get_member_activity_command,
      activity::get_subagent_activity_command,
      activity::get_background_tasks_command,
      activity::get_task_output_command,
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
      session_model::change_session_model_command,
      side_panel::get_panel_config_command,
      side_panel::set_panel_enabled_command,
      side_panel::save_panel_slot_command,
      side_panel::delete_panel_slot_command,
      side_panel::get_panel_content_command,
      side_panel::save_panel_content_command,
      side_panel::refresh_panel_slot_command,
      side_panel::open_external_url_command,
      side_panel::test_panel_script_command,
      side_panel::generate_panel_script_command,
      side_panel::get_panel_script_reference_command,
      side_panel::fix_panel_script_command,
      app_skills::get_app_skills_command,
      app_skills::add_app_skill_command,
      app_skills::update_app_skill_command,
      app_skills::toggle_app_skill_command,
      app_skills::toggle_app_skill_global_command,
      app_skills::delete_app_skill_command,
      app_skills::list_user_skills_command,
      app_skills::read_user_skill_command,
      update_check::get_app_version_command,
      update_check::check_for_update_command,
      update_check::open_release_page_command,
      daemon_state::get_blocked_needs_command,
      lead_admin::delete_lead_history_command,
      lead_admin::set_lead_auto_stall_nudge_command,
      lead_admin::update_lead_label_command,
      settings::get_settings_command,
      settings::update_settings_command,
      live_rows::refresh_board_command,
      native_dialog::pick_directory_command,
      native_dialog::pick_files_command,
      pasted_images::save_pasted_image_command,
      attach_terminal::open_in_terminal_command,
      attach_terminal::open_terminal_for_approval_command,
    ])
    .setup(|app| {
      // 3일 지난 붙여넣기 이미지 정리(pasted_images.rs 참고).
      pasted_images::purge_old_attachments();
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
