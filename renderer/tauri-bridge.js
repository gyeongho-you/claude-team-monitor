// Electron 버전은 preload.ts가 contextBridge로 window.api를 채워준다. Tauri 버전은 preload가
// 없으므로, window.__TAURI__가 있을 때(=Tauri 런타임)만 이 파일이 그 역할을 대신한다 — Electron으로
// 띄우면 window.__TAURI__가 없어서 아무 것도 하지 않고 그대로 preload.ts에게 맡긴다.
//
// src-tauri/src/lib.rs의 generate_handler! 목록(45개 커맨드)이 이제 preload.ts의 window.api 함수
// 43개(onAgentsUpdate 포함)를 전부 커버한다 — 이 파일은 src/preload.ts와 정확히 같은 window.api
// 표면을 invoke()로 다시 구현한다.
// 함수명(camelCase)·인자 순서는 preload.ts와 동일하게 맞췄다(renderer.js가 그 계약에 의존한다).
//
// Tauri v2 invoke(cmd, args)는 두 번째 인자가 객체이고, 그 키는 Rust 파라미터 이름의 camelCase
// 버전으로 자동 변환된다(예: Rust `fn confirm_stall_alert(alert_id: String)` → JS
// `invoke('confirm_stall_alert', { alertId })`) — 커맨드 이름 자체는 snake_case 그대로 둔다.
(function () {
  if (!window.__TAURI__) return;

  const { invoke } = window.__TAURI__.core;
  const warned = new Set();
  function stub(name) {
    return function () {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`[tauri-bridge] '${name}'에 대응하는 Rust 커맨드를 찾지 못했습니다(빠진 IPC 포팅일 수 있음).`);
      }
      return Promise.resolve([]);
    };
  }

  // ---- 세션 목록/정리 ----
  async function getAllBackgroundSessions() {
    return invoke('get_all_background_sessions');
  }

  async function getAdoptableSessions() {
    return invoke('get_adoptable_sessions');
  }

  async function stopBackgroundSession(shortId) {
    return invoke('stop_background_session_command', { shortId });
  }

  async function registerProbableMember(agentId, leadId) {
    return invoke('register_probable_member_command', { agentId, leadId });
  }

  async function getInteractiveSessions() {
    return invoke('get_interactive_sessions_command');
  }

  // ---- 작업 탭 보드 새로고침 ----
  // refresh_board_command 하나로 rows/requests/unapprovedDirs/stallAlerts 네 필드를 한 번에
  // 받아온다(main.ts의 `{...(await buildSessionRows()), stallAlerts: listStallAlertsForUi()}`와
  // 동일한 응답 모양 — 필드명도 이미 camelCase로 직렬화된다).
  async function refreshBoard() {
    return invoke('refresh_board_command');
  }

  // main.ts의 3초 폴링(POLL_INTERVAL_MS)과 같은 주기로 직접 폴링해서 'agents-update' push를
  // 흉내낸다 — Rust 쪽에 아직 이 이벤트를 실제로 emit하는 백그라운드 타이머가 없어서(리뷰 예정),
  // 폴링이 부르는 스냅샷도 refresh_board_command 기반으로 통일한다(get_live_session_rows/
  // get_stall_alerts를 따로 합치던 이전 방식 대신).
  const AGENTS_UPDATE_POLL_MS = 3000;
  function onAgentsUpdate(callback) {
    const tick = () => {
      refreshBoard()
        .then(callback)
        .catch(err => console.error('[tauri-bridge] refresh_board_command 폴링 실패:', err));
    };
    tick();
    setInterval(tick, AGENTS_UPDATE_POLL_MS);
  }

  // ---- 즐겨찾기(팀장 디렉토리) ----
  async function pickDirectory() {
    return invoke('pick_directory_command');
  }

  async function getFavorites() {
    return invoke('get_favorites_command');
  }

  async function addFavorite(dir) {
    return invoke('add_favorite_command', { dir });
  }

  async function removeFavorite(dir) {
    return invoke('remove_favorite_command', { dir });
  }

  async function updateFavoriteName(dir, name) {
    return invoke('update_favorite_name_command', { dir, name });
  }

  // ---- 팀장/팀원 라이프사이클 ----
  async function adoptLead(shortId) {
    return invoke('adopt_lead_command', { shortId });
  }

  async function forkSessionAsLead(sessionId, cwd) {
    return invoke('fork_session_as_lead_command', { sessionId, cwd });
  }

  async function launchTeamLead(targetDir, instruction, label, secret) {
    return invoke('launch_team_lead_command', { targetDir, instruction, label, secret });
  }

  async function launchMember(leadId, targetDir, instruction, role, label, model) {
    return invoke('launch_member_command', { leadId, targetDir, instruction, role, label, model });
  }

  async function restartLead(leadId, instruction) {
    return invoke('restart_lead_command', { leadId, instruction });
  }

  async function endLeadWork(leadId) {
    return invoke('end_lead_work_command', { leadId });
  }

  // ---- 팀원 템플릿 ----
  async function getMemberTemplates() {
    return invoke('get_member_templates_command');
  }

  async function addMemberTemplate(scope, dir, name, role, instruction, model) {
    // add_member_template_command의 dir/model은 Rust 쪽에서 Option<String>이다 — 빈 문자열을
    // 그대로 보내면 Some("")로 역직렬화돼(main.ts의 `dir || undefined`와 다르게) path:""가 저장될
    // 수 있으므로, 여기서 falsy를 null로 정규화해 None과 동일하게 맞춘다.
    return invoke('add_member_template_command', {
      scope,
      dir: dir || null,
      name,
      role,
      instruction,
      model: model || null,
    });
  }

  async function updateMemberTemplate(id, fields) {
    return invoke('update_member_template_command', { id, fields });
  }

  async function toggleMemberTemplateApproved(id) {
    return invoke('toggle_member_template_approved_command', { id });
  }

  async function deleteMemberTemplate(id) {
    return invoke('delete_member_template_command', { id });
  }

  // ---- 팀원 요청 승인/거부 ----
  async function approveRequest(requestId) {
    return invoke('approve_request_command', { requestId });
  }

  async function denyRequest(requestId) {
    return invoke('deny_request_command', { requestId });
  }

  // ---- 터미널 열기 ----
  async function openInTerminal(id) {
    return invoke('open_in_terminal_command', { sessionShortId: id });
  }

  async function openTerminalForApproval(targetDir) {
    return invoke('open_terminal_for_approval_command', { targetDir });
  }

  // ---- 대화/트랜스크립트 ----
  async function getLeadTranscript(leadId) {
    return invoke('get_lead_transcript_command', { leadId });
  }

  async function getPendingChoice(shortId) {
    return invoke('get_pending_choice_command', { shortId });
  }

  async function getChatUnresolvableDetail(shortId) {
    return invoke('get_chat_unresolvable_detail_command', { shortId });
  }

  // ---- 변경 파일 diff ----
  async function getChangedFiles(cwd) {
    return invoke('get_changed_files_command', { cwd });
  }

  async function getFileDiff(cwd, file) {
    return invoke('get_file_diff_command', { cwd, file });
  }

  // ---- 채팅(알림 큐) ----
  async function sendToLead(leadId, message) {
    return invoke('send_to_lead_command', { leadId, message });
  }

  async function cancelQueuedMessage(leadId, noticeId) {
    return invoke('cancel_queued_message_command', { leadId, noticeId });
  }

  async function getPendingNoticeIds(leadId) {
    return invoke('get_pending_notice_ids_command', { leadId });
  }

  // ---- 히스토리 삭제 ----
  async function deleteLeadHistory(internalId) {
    return invoke('delete_lead_history_command', { internalId });
  }

  // ---- 정체 감시 알림 ----
  async function getStallAlerts() {
    return invoke('get_stall_alerts');
  }

  async function confirmStallAlert(alertId) {
    return invoke('confirm_stall_alert', { alertId });
  }

  async function dismissStallAlert(alertId) {
    return invoke('dismiss_stall_alert', { alertId });
  }

  // ---- 설정 ----
  async function getSettings() {
    return invoke('get_settings_command');
  }

  async function updateSettings(partial) {
    return invoke('update_settings_command', { partial });
  }

  async function setLeadAutoStallNudge(leadId, value) {
    return invoke('set_lead_auto_stall_nudge_command', { leadId, value });
  }

  async function updateLeadLabel(leadId, label) {
    return invoke('update_lead_label_command', { leadId, label });
  }

  const implemented = {
    onAgentsUpdate,
    pickDirectory,
    getFavorites,
    addFavorite,
    removeFavorite,
    updateFavoriteName,
    getAdoptableSessions,
    getAllBackgroundSessions,
    stopBackgroundSession,
    registerProbableMember,
    refreshBoard,
    adoptLead,
    getInteractiveSessions,
    forkSessionAsLead,
    launchTeamLead,
    launchMember,
    getMemberTemplates,
    addMemberTemplate,
    updateMemberTemplate,
    toggleMemberTemplateApproved,
    deleteMemberTemplate,
    approveRequest,
    denyRequest,
    openInTerminal,
    openTerminalForApproval,
    getLeadTranscript,
    getPendingChoice,
    getChatUnresolvableDetail,
    getChangedFiles,
    getFileDiff,
    sendToLead,
    cancelQueuedMessage,
    deleteLeadHistory,
    getPendingNoticeIds,
    getStallAlerts,
    confirmStallAlert,
    dismissStallAlert,
    getSettings,
    updateSettings,
    setLeadAutoStallNudge,
    updateLeadLabel,
    restartLead,
    endLeadWork,
  };

  // preload.ts의 43개 함수를 전부 위에서 구현했다 — 이 Proxy의 stub 폴백은 "혹시 이후에 preload.ts에
  // 함수가 추가됐는데 여기 안 옮겨진" 경우를 위한 안전망일 뿐, 지금은 어떤 호출도 stub을 타지 않는다.
  window.api = new Proxy(implemented, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return stub(prop);
    },
  });
})();
