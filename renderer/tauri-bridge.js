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
  // untracked, probableLeadId, registeredDir)까지 전부 Rust에서 계산해서 내려준다. "작업 탭"의 실시간
  // 보드(agents-update 이벤트 push, buildSessionRows)는 오프라인 히스토리·정체 감시·알림 큐 등 훨씬 큰
  // 상태 머신이 더 필요해서 아직 안 옮겼다 — 다음 기능 단위.
  async function getAllBackgroundSessions() {
    return invoke('get_all_background_sessions').catch(() => []);
  }

  async function getAdoptableSessions() {
    return invoke('get_adoptable_sessions').catch(() => []);
  }

  const implemented = { getAllBackgroundSessions, getAdoptableSessions };

  window.api = new Proxy(implemented, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'onAgentsUpdate') {
        // 작업 탭 실시간 보드(agents-update 이벤트 push)는 아직 안 옮겼다 — 콜백만 등록해두고
        // 아무 것도 보내지 않는다(호출 자체가 없으면 renderer.js top-level 문이 그대로 죽는다).
        return callback => {
          if (!warned.has('onAgentsUpdate')) {
            warned.add('onAgentsUpdate');
            console.warn('[tauri-bridge] \'onAgentsUpdate\'은 아직 Rust로 포팅되지 않았습니다.');
          }
          void callback;
        };
      }
      return stub(prop);
    },
  });
})();
