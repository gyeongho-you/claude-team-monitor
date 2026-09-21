// Electron 버전은 preload.ts가 contextBridge로 window.api를 채워준다. Tauri 버전은 preload가
// 없으므로, window.__TAURI__가 있을 때(=Tauri 런타임)만 이 파일이 그 역할을 대신한다 — Electron으로
// 띄우면 window.__TAURI__가 없어서 아무 것도 하지 않고 그대로 preload.ts에게 맡긴다.
//
// IPC 핸들러는 기능 단위로 하나씩 Rust로 옮기는 중이다(TAURI_HANDOFF.md 참고). 아직 옮기지 않은
// 채널을 호출하면(renderer.js는 거의 모든 window.api.* 호출을 try/catch로 감싸므로) 콘솔에 경고만
// 남기고 빈 배열([])을 돌려준다 — []는 .length/.map은 물론 구조분해할당(`const {a} = []`)에도
// 안전해서, 아직 안 옮긴 기능 때문에 나머지 화면까지 죽지 않게 하는 최소한의 완충 장치다.
(function () {
  if (!window.__TAURI__) return;

  const { invoke } = window.__TAURI__.core;
  const warned = new Set();
  function stub(name) {
    return function () {
      if (!warned.has(name)) {
        warned.add(name);
        console.warn(`[tauri-bridge] '${name}'은 아직 Rust로 포팅되지 않았습니다.`);
      }
      return Promise.resolve([]);
    };
  }

  // ---- 여기까지 포팅됨: 세션 목록 조회 ----
  // main.ts의 getAllBackgroundSessions()/getAdoptableSessions()를 Rust 쪽(session_registry.rs)으로
  // 그대로 옮겼다 — claude agents --json 실행 + leads.json/members 등록 정보 대조(tag: lead/member/
  // untracked, probableLeadId, registeredDir)까지 전부 Rust에서 계산해서 내려준다.
  async function getAllBackgroundSessions() {
    return invoke('get_all_background_sessions').catch(() => []);
  }

  async function getAdoptableSessions() {
    return invoke('get_adoptable_sessions').catch(() => []);
  }

  // ---- 여기까지 포팅됨: 작업 탭 보드의 "라이브" rows ----
  // main.ts의 computeLiveRows()를 Rust 쪽(live_rows.rs)으로 옮겼다 — 지금 떠있고 leads.json/
  // members에 등록된(팀장이거나 팀원인) 세션만 SessionRow로 만들어 돌려준다. 오프라인 히스토리
  // (offline/그레이스 판정), 정체 감시(runStallWatchdog), 알림 큐(notifyLeadsOfFinishedMembers/
  // deliverPendingNotices)는 아직 안 옮겼다 — 다음 기능 단위. 그래서 이 함수가 돌려주는 rows에는
  // 오프라인 팀장 카드가 없고(늘 offline:false), requests/stallAlerts/unapprovedDirs는 항상 빈
  // 배열이다 — renderRequests/renderStallAlerts/renderUnapprovedDirs는 빈 배열을 안전하게 다룬다.
  async function fetchBoardSnapshot() {
    const rows = await invoke('get_live_session_rows').catch(() => []);
    return { rows, requests: [], stallAlerts: [], unapprovedDirs: [] };
  }

  async function refreshBoard() {
    return fetchBoardSnapshot();
  }

  // main.ts의 3초 폴링(POLL_INTERVAL_MS)과 같은 주기로 직접 폴링해서 'agents-update' push를
  // 흉내낸다 — Tauri 쪽엔 아직 이 이벤트를 실제로 emit하는 백그라운드 타이머가 없다(다음 기능
  // 단위: 정체 감시·알림 큐가 붙는 시점에 Rust 쪽 상시 타이머로 대체 예정).
  const AGENTS_UPDATE_POLL_MS = 3000;
  function onAgentsUpdate(callback) {
    const tick = () => {
      fetchBoardSnapshot()
        .then(callback)
        .catch(err => console.error('[tauri-bridge] get_live_session_rows 폴링 실패:', err));
    };
    tick();
    setInterval(tick, AGENTS_UPDATE_POLL_MS);
  }

  const implemented = { getAllBackgroundSessions, getAdoptableSessions, refreshBoard, onAgentsUpdate };

  window.api = new Proxy(implemented, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return stub(prop);
    },
  });
})();
