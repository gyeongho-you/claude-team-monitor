// --- 다크/라이트 테마 ---
// localStorage는 뷰어(이 창)별로 따로 노는 값이라 여러 사용자 간 공유될 일이 없고, 그냥 "이 PC의
// 이 앱 창은 어떤 테마로 보고 싶은지"라는 순수 UI 취향이라 딱 맞는 용도다.
const THEME_KEY = 'claude-team-monitor-theme';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('theme-toggle-btn');
  // '☀️'(U+2600 BLACK SUN WITH RAYS + VS16)는 실제 배포된 앱(Electron/Windows)에서 빈 네모로
  // 깨져 보임이 실측 확인됨(Playwright 크로미움에선 멀쩡히 렌더링돼서 그걸로는 못 잡았다 —
  // 실제 패키징된 앱 창을 직접 스크린샷해서 확인함) — 이미 멀쩡히 뜨는 '🌙'와 같은 세대(둘 다
  // supplementary plane emoji)인 '🌞'로 바꿔서 같은 폰트 경로를 타게 한다.
  if (btn) btn.textContent = theme === 'light' ? '🌞' : '🌙';
}
(function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* 접근 안 되면 기본값(dark) */ }
  applyTheme(saved);
})();
document.getElementById('theme-toggle-btn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* 저장 안 돼도 이번 세션 동안은 유지됨 */ }
});

// --- 정체 감시 설정(idle 임계값/쿨다운) ---
(function initAppSettings() {
  const btn = document.getElementById('app-settings-btn');
  const panel = document.getElementById('app-settings-panel');
  const idleInput = document.getElementById('stall-idle-threshold-input');
  const cooldownInput = document.getElementById('stall-cooldown-input');
  const statusEl = document.getElementById('app-settings-status');

  async function loadIntoInputs() {
    try {
      const settings = await window.api.getSettings();
      idleInput.value = settings.stallIdleThresholdMin;
      cooldownInput.value = settings.stallCooldownMin;
    } catch (err) {
      statusEl.textContent = `설정을 불러오지 못했습니다: ${err.message || err}`;
    }
  }

  btn.addEventListener('click', async () => {
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    if (willOpen) await loadIntoInputs();
  });

  document.addEventListener('click', e => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) panel.hidden = true;
  });

  async function saveField(key, input) {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value < 1) { statusEl.textContent = '1분 이상의 숫자를 입력하세요.'; return; }
    try {
      // 백엔드가 소수점 반올림·범위 클램프를 할 수 있어서(clampMinutes), 저장 후 실제 반영된
      // 값을 다시 받아와 입력창에 채운다 — 안 그러면 예를 들어 9999를 입력했을 때 "저장됨"은
      // 뜨지만 입력창은 여전히 9999를 보여줘서, 패널을 닫았다 열기 전까지 실제 값(1440으로
      // 클램프됨)과 화면이 다르게 보이는 문제가 있었다.
      const saved = await window.api.updateSettings({ [key]: value });
      idleInput.value = saved.stallIdleThresholdMin;
      cooldownInput.value = saved.stallCooldownMin;
      statusEl.textContent = '저장됨';
      setTimeout(() => { statusEl.textContent = ''; }, 1500);
    } catch (err) {
      statusEl.textContent = `저장 실패: ${err.message || err}`;
    }
  }
  idleInput.addEventListener('change', () => saveField('stallIdleThresholdMin', idleInput));
  cooldownInput.addEventListener('change', () => saveField('stallCooldownMin', cooldownInput));
})();

// --- 탭 전환 ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`${btn.dataset.tab}-tab`).classList.add('active');
  });
});

const leadRowEl = document.getElementById('lead-row');
const newLeadBtn = document.getElementById('new-lead-btn');
const adoptLeadBtn = document.getElementById('adopt-lead-btn');
const leadChatPanelEl = document.getElementById('lead-chat-panel');
const leadMembersChipsEl = document.getElementById('lead-members-chips');
const chatTranscriptEl = document.getElementById('chat-transcript');
const chatInputEl = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const restartLeadBtn = document.getElementById('restart-lead-btn');
const restartLeadPanelEl = document.getElementById('restart-lead-panel');
const restartInstructionEl = document.getElementById('restart-instruction');
const restartConfirmBtn = document.getElementById('restart-confirm-btn');
const restartCancelBtn = document.getElementById('restart-cancel-btn');
const restartStatusEl = document.getElementById('restart-status');
const restartPendingWarningEl = document.getElementById('restart-pending-warning');
const endWorkBtn = document.getElementById('end-work-btn');
const autoStallNudgeToggle = document.getElementById('auto-stall-nudge-toggle');
const endWorkPanelEl = document.getElementById('end-work-panel');
const endWorkConfirmBtn = document.getElementById('end-work-confirm-btn');
const endWorkCancelBtn = document.getElementById('end-work-cancel-btn');
const endWorkStatusEl = document.getElementById('end-work-status');
const endWorkPendingWarningEl = document.getElementById('end-work-pending-warning');
const modalBackdropEl = document.getElementById('modal-backdrop');
const fileListPanelEl = document.getElementById('file-list-panel');
const fileListCloseBtn = document.getElementById('file-list-close-btn');
const fileListContentEl = document.getElementById('file-list-content');
const cleanupStopPanelEl = document.getElementById('cleanup-stop-panel');
const cleanupStopInfoEl = document.getElementById('cleanup-stop-info');
const cleanupStopConfirmBtn = document.getElementById('cleanup-stop-confirm-btn');
const cleanupStopCancelBtn = document.getElementById('cleanup-stop-cancel-btn');
const historyDeletePanelEl = document.getElementById('history-delete-panel');
const historyDeleteInfoEl = document.getElementById('history-delete-info');
const historyDeleteConfirmBtn = document.getElementById('history-delete-confirm-btn');
const historyDeleteCancelBtn = document.getElementById('history-delete-cancel-btn');
const ALL_MODAL_PANELS = () => [restartLeadPanelEl, endWorkPanelEl, fileListPanelEl, cleanupStopPanelEl, historyDeletePanelEl];

// "새 작업 시작"/"작업 종료"/"변경 파일" 같은 확인창·상세창은 대화창 아래쪽에 인라인으로 뜨면
// 스크롤 밖이라 눈에 안 띄어서(사용자 피드백), 화면 가운데 팝업(모달)으로 띄운다 — 배경을
// 어둡게 깔고 그 위에 패널을 얹는다.
function showModal(panelEl) {
  panelEl.hidden = false;
  modalBackdropEl.hidden = false;
  // 모달 안 스크롤을 끝까지 내리면 스크롤 체이닝으로 배경(메인 화면)까지 같이 스크롤되던 문제 —
  // 모달이 하나라도 떠있는 동안엔 배경 스크롤 자체를 잠근다(overscroll-behavior는 CSS 쪽 이중 방어).
  document.body.classList.add('modal-open');
}

function hideModal(panelEl) {
  panelEl.hidden = true;
  if (ALL_MODAL_PANELS().every(p => p.hidden)) {
    modalBackdropEl.hidden = true;
    document.body.classList.remove('modal-open');
  }
}

modalBackdropEl.addEventListener('click', () => {
  ALL_MODAL_PANELS().forEach(hideModal);
});

// "지금 커밋+푸시하면 뭐가 들어가는지"를 보여주는 용도 — 그래서 git의 현재 미커밋 상태를 그대로
// 보여준다(git add -A로 커밋할 때 포함될 것과 정확히 같음). "이 세션이 건드린 것만" 걸러보려고
// mtime 필터를 넣었던 적이 있는데, 그건 원하는 질문과 달라서 다시 뺐다.
let fileListCwd = null; // 지금 열려있는 팝업이 어느 디렉토리 기준인지(파일 클릭 시 diff 조회, 뒤로가기용)

function gitStatusLabel(code) {
  const map = { M: '수정', A: '추가', D: '삭제', R: '이름변경', C: '복사', U: '충돌', '??': '새 파일' };
  return map[code] || code;
}

async function showFileList(cwd) {
  fileListCwd = cwd;
  showModal(fileListPanelEl);
  fileListContentEl.innerHTML = '<p style="color:#777">불러오는 중...</p>';
  try {
    const files = await window.api.getChangedFiles(cwd);
    fileListContentEl.innerHTML = files.length
      ? files.map(f => `
          <div class="file-list-item" data-diff-file="${escapeHtml(f.file)}">
            <span class="file-list-tool">${escapeHtml(gitStatusLabel(f.status))}</span>
            <span class="file-list-path">${escapeHtml(f.file)}</span>
          </div>
        `).join('')
      : '<p style="color:#777">지금 커밋 대상인 변경사항이 없습니다.</p>';
  } catch (err) {
    fileListContentEl.innerHTML = `<p style="color:#f14c4c">불러오지 못했습니다: ${escapeHtml(errMsg(err))}</p>`;
  }
}

// diff 텍스트를 한 줄씩 훑어서 +/-/@@ 기준으로 git처럼 색을 입힌다.
function renderDiffLines(diffText) {
  return diffText.split('\n').map(line => {
    let cls = 'diff-ctx';
    if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta';
    else if (line.startsWith('@@')) cls = 'diff-hunk';
    else if (line.startsWith('+')) cls = 'diff-add';
    else if (line.startsWith('-')) cls = 'diff-del';
    return `<div class="diff-line ${cls}">${escapeHtml(line) || '&nbsp;'}</div>`;
  }).join('');
}

async function showFileDiff(file) {
  const cwd = fileListCwd;
  fileListContentEl.innerHTML = `
    <button class="diff-back-btn">← 목록으로</button>
    <div class="diff-path">${escapeHtml(file)}</div>
    <p style="color:#777">불러오는 중...</p>
  `;
  try {
    const { diff, isNew, binary } = await window.api.getFileDiff(cwd, file);
    let body;
    if (binary) {
      body = '<p style="color:#777">바이너리 파일이라 내용을 보여줄 수 없습니다.</p>';
    } else if (!diff) {
      body = '<p style="color:#777">내용이 없거나 삭제된 파일입니다.</p>';
    } else if (isNew) {
      // 아직 git이 추적 안 하는 새 파일 — 비교 대상이 없으니 전체를 추가된 내용으로 보여준다.
      body = `<div class="diff-box">${diff.split('\n').map(l => `<div class="diff-line diff-add">+${escapeHtml(l) || '&nbsp;'}</div>`).join('')}</div>`;
    } else {
      body = `<div class="diff-box">${renderDiffLines(diff)}</div>`;
    }
    fileListContentEl.innerHTML = `
      <button class="diff-back-btn">← 목록으로</button>
      <div class="diff-path">${escapeHtml(file)}</div>
      ${body}
    `;
  } catch (err) {
    fileListContentEl.innerHTML = `
      <button class="diff-back-btn">← 목록으로</button>
      <p style="color:#f14c4c">불러오지 못했습니다: ${escapeHtml(errMsg(err))}</p>
    `;
  }
}

// 목록/diff 둘 다 fileListContentEl을 통째로 다시 그리는 구조라, 개별 리스너 대신 위임 하나로 처리한다.
fileListContentEl.addEventListener('click', e => {
  const backBtn = e.target.closest('.diff-back-btn');
  if (backBtn) { showFileList(fileListCwd); return; }
  const item = e.target.closest('[data-diff-file]');
  if (item) showFileDiff(item.dataset.diffFile);
});

fileListCloseBtn.addEventListener('click', () => hideModal(fileListPanelEl));
const launchFormPanelEl = document.getElementById('launch-form-panel');
const cancelFormBtn = document.getElementById('cancel-form-btn');
const adoptFormPanelEl = document.getElementById('adopt-form-panel');
const cancelAdoptBtn = document.getElementById('cancel-adopt-btn');

const memberRowEl = document.getElementById('member-row');
const requestsListEl = document.getElementById('requests-list');
const stallAlertsListEl = document.getElementById('stall-alerts-list');
const unapprovedDirListEl = document.getElementById('unapproved-dir-list');
const lastUpdatedEl = document.getElementById('last-updated');

const historyListEl = document.getElementById('history-list');
const refreshHistoryBtn = document.getElementById('refresh-history-btn');
let lastRows = [];

const addMemberBtn = document.getElementById('add-member-btn');
const addMemberPanelEl = document.getElementById('add-member-panel');
const memberTemplateSelect = document.getElementById('member-template-select');
const memberNameEl = document.getElementById('member-name');
const memberDirSelect = document.getElementById('member-dir-select');
const pickMemberDirBtn = document.getElementById('pick-member-dir-btn');
const memberRoleSelect = document.getElementById('member-role-select');
const memberRoleCustom = document.getElementById('member-role-custom');
const memberInstructionEl = document.getElementById('member-instruction');
const addMemberSubmitBtn = document.getElementById('add-member-submit-btn');
const cancelAddMemberBtn = document.getElementById('cancel-add-member-btn');
const addMemberStatusEl = document.getElementById('add-member-status');

const targetDirSelect = document.getElementById('target-dir-select');
const pickDirBtn = document.getElementById('pick-dir-btn');
const instructionEl = document.getElementById('instruction');
const launchSecretToggle = document.getElementById('launch-secret-toggle');
const launchBtn = document.getElementById('launch-btn');
const launchStatusEl = document.getElementById('launch-status');

const adoptableSelect = document.getElementById('adoptable-select');
const refreshAdoptableBtn = document.getElementById('refresh-adoptable-btn');
const adoptBtn = document.getElementById('adopt-btn');
const adoptStatusEl = document.getElementById('adopt-status');
let adoptableEntriesByValue = new Map(); // 드롭다운 value -> {kind:'background', id} | {kind:'interactive', sessionId, cwd}

// 목록(adoptable-select)은 지금 살아있는 세션만 보여준다 — 데몬 재시작 등으로 죽어서 agents 목록에서
// 빠진 세션은 아예 선택지에 안 뜨니 이 방법으로는 복구할 수 없다. 세션 ID(전체 UUID)를 이미 알고
// 있으면 직접 입력해서 이어할 수 있는 별도 입력칸을 둔다 — forkSessionAsLead(sessionId, cwd)는
// 원래 목록에서 고른 항목용이었지만 sessionId/cwd만 받으면 그만이라 그대로 재사용한다.
const manualSessionIdEl = document.getElementById('manual-session-id');
const manualSessionDirSelect = document.getElementById('manual-session-dir-select');
const pickManualSessionDirBtn = document.getElementById('pick-manual-session-dir-btn');
const manualSessionResumeBtn = document.getElementById('manual-session-resume-btn');
const manualSessionStatusEl = document.getElementById('manual-session-status');
let manualSessionCustomPickedDir = null;

const cleanupListEl = document.getElementById('cleanup-list');
const refreshCleanupBtn = document.getElementById('refresh-cleanup-btn');

const newFavDirInput = document.getElementById('new-fav-dir');
const browseFavBtn = document.getElementById('browse-fav-btn');
const favAddBtn = document.getElementById('fav-add-btn');
const favoritesListEl = document.getElementById('favorites-list');

const newTplScopeSelect = document.getElementById('new-tpl-scope-select');
const newTplDirSelect = document.getElementById('new-tpl-dir-select');
const pickTplDirBtn = document.getElementById('pick-tpl-dir-btn');
const newTplName = document.getElementById('new-tpl-name');
const newTplRoleSelect = document.getElementById('new-tpl-role-select');
const newTplModelSelect = document.getElementById('new-tpl-model-select');
const newTplRoleCustom = document.getElementById('new-tpl-role-custom');
const newTplInstruction = document.getElementById('new-tpl-instruction');
const tplAddBtn = document.getElementById('tpl-add-btn');
const memberTemplatesListEl = document.getElementById('member-templates-list');

let customPickedDir = null;       // 등록 안 된, 방금 고른 1회성 디렉토리(팀장 대상)
let memberCustomPickedDir = null; // 등록 안 된, 방금 고른 1회성 디렉토리(직접 추가 팀원 대상)
let selectedMemberModel = 'default'; // 템플릿을 고르면 그 템플릿의 model을 따라간다 — 별도 입력 UI는 없음
let tplCustomPickedDir = null;    // 등록 안 된, 방금 고른 1회성 디렉토리(팀원 등록 대상)
let selectedLeadId = null;  // 지금 대화창에 띄운 팀장
// selectedLeadId와 짝을 이루는 안정적인 식별자 — reconcileLeadIds가 폴링 중 짧은 id를 조용히
// 바꿔도(이 앱이 관여 안 한 재시작) 같은 팀장을 계속 따라가는 데 쓴다(renderBoard 참고). 7군데나
// 흩어진 "selectedLeadId = ..." 호출부를 전부 손대는 대신, renderBoard 한 곳에서만 매 폴링마다
// 선택된 팀장의 최신 internalId로 맞춰준다.
let selectedLeadInternalId = null;
let formMode = 'none';      // 'none' | 'launch' | 'adopt'
let showAddMember = false;
let lastLeadIds = new Set();
// 지금 메인 프로세스에서 stop/resume류 작업(채팅 전송/요청 승인·거부/재시작)이 진행 중인 leadId 모음 —
// 같은 팀장에 여러 조작이 겹치면 세션이 갈라질 수 있어서(main.ts의 leadId 큐 참고), 진행 중엔 관련
// 버튼을 비활성화해 사용자가 겹쳐서 누르는 걸 막는다.
const busyLeadIds = new Set();
// 서버 트랜스크립트에 아직 안 나타난(=응답이 안 끝난) 채팅 턴들 — leadId -> Array<{ id, message, kind }>.
// kind는 'queued'(팀장이 busy라 main.ts가 큐에 쌓아뒀다가 idle/blocked 되면 자동 전달 — id는
// main.ts PendingNotice.id라 취소 IPC에 쓰인다) 또는 'in-flight'(즉시 stop→resume으로 보내서 지금
// 응답을 기다리는 중 — 취소할 서버측 대상이 없다)다. 원래는 즉시 전송 건을 optimisticTurn이라는
// 별도 DOM 노드로 그냥 붙여서 처리했는데, 그 직후 refreshBoardNow()가 renderChat()으로 대화창을
// 서버 트랜스크립트로 통째로 덮어써버려서(아직 이 턴이 없으니) 화면이 순간적으로 예전 상태로
// 되돌아가는 버그가 있었다 — 그래서 대기열과 완전히 같은 메커니즘으로 합쳤다. 팀장 하나에게 여러
// 메시지가 겹쳐도 전부 화면에 남아있어야 해서 배열로 각각 독립적으로 추적하고, renderChat()이
// 폴링마다 이 안내들을 대화창 맨 아래에 다시 붙여줘서 무한정 기다리는 것처럼 보이지 않게 한다.
// 실제로 응답이 와서 트랜스크립트에 같은 프롬프트가 나타나면 그 항목만 renderChat()이 알아서 지운다.
const pendingChatTurns = new Map();

// 역할 선택(정해진 역할 드롭다운 + "직접 입력") 공용 헬퍼 — work 탭 팀원 직접 추가와 설정 탭
// 템플릿 등록 두 군데에서 똑같이 쓴다. 실제 값은 하나(select 값, 단 __custom__이면 custom input 값).
function wireRoleFields(selectEl, customEl) {
  selectEl.addEventListener('change', () => {
    customEl.hidden = selectEl.value !== '__custom__';
    if (selectEl.value === '__custom__') customEl.focus();
  });
}

function getRoleValue(selectEl, customEl) {
  return selectEl.value === '__custom__' ? customEl.value.trim() : selectEl.value;
}

// 템플릿을 불러오거나 폼을 초기화할 때, 저장된 role 문자열을 드롭다운/커스텀 입력 상태로 되돌린다.
function setRoleValue(selectEl, customEl, value) {
  const isPreset = [...selectEl.options].some(o => o.value === value && o.value !== '__custom__' && o.value !== '');
  if (!value) {
    selectEl.value = '';
    customEl.hidden = true;
    customEl.value = '';
  } else if (isPreset) {
    selectEl.value = value;
    customEl.hidden = true;
    customEl.value = '';
  } else {
    selectEl.value = '__custom__';
    customEl.hidden = false;
    customEl.value = value;
  }
}

wireRoleFields(memberRoleSelect, memberRoleCustom);
wireRoleFields(newTplRoleSelect, newTplRoleCustom);

// 인터랙티브 선택 프롬프트(AskUserQuestion)나 권한 확인창에 멈춰서 아무도 응답 못 하는 세션을
// 실제로 재현해서 claude agents --json을 확인해보니(claude stop으로 정리 완료), status는 그 사이
// 'waiting'으로 나오고(실측: 정상적으로 질문을 띄운 경우) state는 'blocked'로 잡혔다 — getStatus가
// state==='blocked'를 최우선 취급하도록 고쳤으니(status.js 참고) 보통은 여기 s==='blocked' 분기로
// 들어온다. 'waiting'은 getStatus가 예외적으로 state 없이 status만 이 값을 줄 때를 대비한
// 방어용 분기다 — 둘 다 같은 "사람이 봐야 한다" 경고로 취급한다.
function statusClass(row) {
  if (row.offline) return 'status-offline';
  const s = getStatus(row);
  if (['idle', 'busy', 'blocked', 'done'].includes(s)) return `status-${s}`;
  // 'waiting'을 포함해 그 외 처음 보는 값도 완전히 안심되는 무색보다는 경고색으로 — 최소한
  // 눈에 띄어야 사용자가 확인해볼 이유가 생긴다.
  return 'status-blocked';
}

function statusLabelKo(row) {
  if (row.offline) return '오프라인';
  const s = getStatus(row);
  if (s === 'busy') return '● 작업 중';
  // waitingFor==='input needed'는 AskUserQuestion처럼 구조화된 선택지로 멈춘 경우에만 claude
  // agents --json이 주는 값이다(실측 확인, readPendingChoiceQuestions 주석 참고) — 채팅창에 질문
  // 내용과 "터미널에서 직접 열기" 안내가 뜰 거라는 걸 라벨에서부터 구분해서 알려준다(그냥 "확인
  // 필요"라고만 하면 자연어 질문과 구분이 안 됐다).
  if (row.waitingFor === 'input needed') return '⚠ 선택지 응답 대기';
  if (s === 'blocked' || s === 'waiting') return '⚠ 확인 필요';
  if (s === 'done') return '완료';
  if (s === 'idle') return '대기 중';
  return '⚠ 확인 필요(원인 불명)';
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// cwd는 claude agents --json(외부 CLI 출력, 스키마 검증 없이 그대로 씀)에서 온다 — 타입상으로는
// 항상 string이라지만 실제로 비어있는 값이 들어오면 이 함수 하나가 던지는 예외가 여러 렌더
// 함수의 .map() 안에서 안 잡혀 그 탭 전체 렌더링이 멈춘다(예: 세션 정리 탭) — 방어적으로 처리한다.
function dirLabel(dir) {
  if (!dir) return '(경로 없음)';
  return dir.split(/[\\/]/).pop();
}

// window.api.* 호출이 실패했을 때(메인 프로세스 예외 등) 화면에 보여줄 메시지를 뽑아낸다.
// Electron의 ipcRenderer.invoke는 main 프로세스 핸들러가 던진 에러를
// "Error invoking remote method 'xxx': Error: <원본 메시지>"로 감싸서 reject한다 — 지금은 main.ts
// 쪽에서 IPC 핸들러가 직접 throw하는 경로가 없어 당장 눈에 보이진 않지만, 나중에 그런 경로가
// 생기면 이 접두사가 그대로 사용자에게 노출돼 영어/한국어가 섞인 어색한 이중 문구가 된다 —
// 미리 벗겨내서 어떤 IPC 에러든 원본 메시지만 보이게 한다.
function errMsg(err) {
  const raw = (err && err.message) ? err.message : String(err);
  const m = raw.match(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?(.*)$/s);
  return m ? m[1] : raw;
}

// 지금 선택된 팀장 카드 관련 버튼(전송/재시작)과, 요청 목록에서 같은 팀장에 걸린 승인/거부 버튼을
// busyLeadIds 상태에 맞춰 켜고 끈다 — 폴링으로 화면이 다시 그려져도 매번 다시 적용해야 한다.
// index.html에 이미 붙어있는 설명용 title(무슨 동작인지)을 busy로 잠겼을 때 잠깐 덮어썼다가,
// 안 잠겼을 때 원래대로 되돌리기 위해 최초 1회 기억해둔다.
const restartLeadBtnOriginalTitle = restartLeadBtn.title;
const endWorkBtnOriginalTitle = endWorkBtn.title;

function updateBusyUI() {
  const selectedBusy = !!selectedLeadId && busyLeadIds.has(selectedLeadId);
  // launchBtn/adoptBtn/addMemberSubmitBtn과 같은 "왜 비활성화됐는지" title 힌트 패턴을 여기도 적용한다.
  const busyTitle = '다른 작업이 진행 중입니다 — 끝난 뒤 다시 시도하세요';
  chatSendBtn.disabled = selectedBusy;
  restartLeadBtn.disabled = selectedBusy;
  restartLeadBtn.title = selectedBusy ? busyTitle : restartLeadBtnOriginalTitle;
  endWorkBtn.disabled = selectedBusy;
  endWorkBtn.title = selectedBusy ? busyTitle : endWorkBtnOriginalTitle;
  document.querySelectorAll('[data-team-lead]').forEach(btn => {
    if (busyLeadIds.has(btn.dataset.teamLead)) btn.disabled = true;
  });
}

// addMemberBtn에 이미 있던 "왜 비활성화됐는지" title 힌트 패턴을, 디렉토리/세션 미선택으로
// 비활성화되는 다른 버튼(launchBtn/adoptBtn/addMemberSubmitBtn)에도 똑같이 적용한다.
function syncLaunchBtnState() {
  launchBtn.disabled = !targetDirSelect.value;
  launchBtn.title = targetDirSelect.value ? '' : '먼저 디렉토리를 선택하세요';
}

function syncAdoptBtnState() {
  adoptBtn.disabled = !adoptableSelect.value;
  adoptBtn.title = adoptableSelect.value ? '' : '먼저 연결할 세션을 선택하세요';
}

function syncManualSessionResumeBtnState() {
  const hasSessionId = !!manualSessionIdEl.value.trim();
  const hasDir = !!manualSessionDirSelect.value;
  manualSessionResumeBtn.disabled = !hasSessionId || !hasDir;
  manualSessionResumeBtn.title = !hasSessionId ? '세션 ID를 입력하세요' : !hasDir ? '먼저 디렉토리를 선택하세요' : '';
}

function syncAddMemberSubmitBtnState() {
  const hasName = !!memberNameEl.value.trim();
  const hasDir = !!memberDirSelect.value;
  addMemberSubmitBtn.disabled = !hasName || !hasDir;
  addMemberSubmitBtn.title = !hasName ? '이름을 입력하세요' : !hasDir ? '먼저 디렉토리를 선택하세요' : '';
}

function buildDirOptionsHtml(favs, customDir, placeholder) {
  const options = [`<option value="">${placeholder}</option>`];
  favs.forEach(f => options.push(`<option value="${escapeHtml(f.path)}">${escapeHtml(f.name)} (${escapeHtml(f.path)})</option>`));
  if (customDir && !favs.some(f => f.path === customDir)) {
    options.push(`<option value="${escapeHtml(customDir)}">[선택함] ${escapeHtml(dirLabel(customDir))}</option>`);
  }
  return options.join('');
}

function setSelectValuePreserving(selectEl, options, preferredValue) {
  const prevValue = selectEl.value;
  selectEl.innerHTML = options;
  if (preferredValue && [...selectEl.options].some(o => o.value === preferredValue)) {
    selectEl.value = preferredValue;
  } else if ([...selectEl.options].some(o => o.value === prevValue)) {
    selectEl.value = prevValue;
  }
}

// ---------------- 작업 탭: 팀장 ----------------

// 팀장이 idle/완료 상태여도, 자기 팀원이 아직 작업 중이면 실제로는 "끝난 게" 아니라 그 결과를
// 기다리는 중이다 — 완료/대기 중이라고 뜨면 사용자가 "아 끝났나보다" 하고 놓치기 쉬우니 구분한다.
function hasBusyMember(leadId) {
  return lastRows.some(r => !r.isLead && r.leadId === leadId && getStatus(r) === 'busy');
}

function renderLeadCard(row) {
  const ownStatus = row.offline ? '' : getStatus(row);
  const waitingOnMember = !row.offline && (ownStatus === 'idle' || ownStatus === 'done') && hasBusyMember(row.id);
  const statusLabel = waitingOnMember ? '⏳ 팀원 작업 대기중' : statusLabelKo(row);
  const cardStatusClass = waitingOnMember ? 'status-busy' : statusClass(row);
  const selected = row.id === selectedLeadId ? 'selected' : '';
  return `
    <div class="session-card lead-card ${cardStatusClass} ${selected}" data-lead="${escapeHtml(row.id)}">
      <div class="top-line">
        <input class="lead-label-input" data-lead-label="${escapeHtml(row.id)}" value="${escapeHtml(row.label || '')}" placeholder="${escapeHtml(row.projectName)}" />
        ${row.secret ? '<span class="secret-badge" title="daily-journal 등 user-level 기록이 안 남는 시크릿 모드입니다">🔒</span>' : ''}
        <span>${escapeHtml(statusLabel)}</span>
      </div>
      ${row.name ? `<div class="lead-topic">${escapeHtml(row.name)}</div>` : ''}
      <div class="meta">${escapeHtml(row.cwd)}</div>
      ${row.offline ? '<div class="offline-hint">메시지를 보내면 다시 이어집니다</div>' : ''}
      <div class="actions">
        ${row.offline ? '' : `<button data-attach="${escapeHtml(row.id)}">터미널 열기</button>`}
        <button data-files="${escapeHtml(row.cwd)}">커밋 대상</button>
      </div>
    </div>
  `;
}

async function selectLead(leadId) {
  selectedLeadId = leadId;
  formMode = 'none';
  hideModal(restartLeadPanelEl);
  hideModal(endWorkPanelEl);
  chatTranscriptEl.innerHTML = ''; // 새 팀장의 대화를 불러오는 동안 이전 팀장의 대화가 잠깐 보이는 걸 막는다
  await renderChat();
  // "이 팀장 전용" 템플릿 드롭다운은 selectedLeadId 기준으로 걸러지므로, 팀장을 바꿀 때마다
  // 다시 그려야 한다 — 안 그러면 예전에 선택돼있던(혹은 없던) 팀장 기준으로 필터링된 채 굳어버린다.
  rebuildMemberTemplateSelect();
  renderMemberRow(); // 팀원 목록도 폴링 안 기다리고 바로 갱신 — lastRows 캐시 기준이라 즉시 가능
  updateLeadSectionVisibility();
  updateMemberSectionVisibility();
  document.querySelectorAll('[data-lead]').forEach(el => {
    el.classList.toggle('selected', el.dataset.lead === leadId);
  });
}

// 첫 실행 시 자동으로 붙는 "/team-lead" 접두어와 사전승인 브리핑 블록은 실제로 claude에 보내는
// 내용에는 필요하지만, 화면에는 사용자가 실제로 입력한 지시만 보이는 게 깔끔하다.
function cleanPrompt(prompt) {
  let p = (prompt || '').replace(/^\/team-lead\s*/, '');
  const idx = p.indexOf('사전 승인된 팀원');
  if (idx !== -1) p = p.slice(0, idx).trim();
  return p || '(초기 지시 없음)';
}

// 팀장 세션의 트랜스크립트에는 사용자가 직접 타이핑한 메시지 말고도, Claude Code 하네스가
// 자동으로 주입하는 백그라운드 작업 완료 알림이나(<task-notification> XML 블록), 이 앱 자신이
// queueLeadNotice로 큐에 쌓아뒀다가 전달하는 [알림] 문구가 그대로 prompt로 남는다(실측: 실제
// 팀장 세션 트랜스크립트에서 두 패턴 다 확인). 사용자가 보낸 것처럼 "▸ "로 보이면 헷갈리므로
// 구분해서 표시한다.
function isAutoInjectedPrompt(prompt) {
  const p = (prompt || '').trim();
  if (!p) return false;
  // 대기 메시지 묶음 배달(main.ts combinePendingNoticeMessages)로 여러 건이 번호가 매겨져 하나의
  // turn으로 합쳐지면 이 패턴들이 문자열 맨 앞이 아니라 중간(예: "2) <task-notification>...")에
  // 올 수 있다 — startsWith 대신 문자열 어디에든 있으면 자동주입으로 인정한다(묶인 항목 중
  // 하나라도 자동주입이면 턴 전체를 자동주입으로 표시한다는 뜻이기도 하다).
  return p.includes('<task-notification>') || p.includes('[알림]');
}

// <task-notification> 블록은 task-id/tool-use-id/output-file 경로 등 잡음이 많아 그대로 보여주면
// 너무 길다 — 나오는 블록마다 status/summary 태그만 뽑아서 한 줄로 줄인다(실측 포맷:
// <status>completed</status><summary>Background command "..." completed (exit code 0)</summary>).
// 대기 메시지 묶음 배달 때문에 이 블록이 번호 매겨진 항목들 사이 어딘가에 끼어있을 수 있어서,
// 문자열 전체에서 찾은 블록을 전부(하나든 여럿이든) 제자리에서 축약하고 나머지 텍스트(번호,
// 다른 항목, [알림] 문구 등)는 그대로 둔다. 블록이 하나도 없으면(예: [알림]만 있는 경우) 원문
// 그대로 돌려준다 — [알림] 문구는 이미 짧은 한국어 문장이라 축약이 필요 없다.
function summarizeAutoInjectedPrompt(prompt) {
  const p = (prompt || '').trim();
  return p.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, block => {
    const status = block.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim();
    const summary = block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
    if (summary) return status ? `[${status}] ${summary}` : summary;
    return block.length > 150 ? `${block.slice(0, 150)}…` : block;
  });
}

// 트랜스크립트 한 턴의 prompt 줄을 렌더링한다 — 자동 주입된 것이면 🔔 아이콘과 다른 스타일
// (.chat-prompt-auto)로, 사용자가 직접 친 것이면 기존과 동일하게 "▸ "로 보여준다.
function renderPromptLineHtml(prompt) {
  if (isAutoInjectedPrompt(prompt)) {
    return `<div class="chat-prompt chat-prompt-auto">🔔 ${escapeHtml(summarizeAutoInjectedPrompt(prompt))}</div>`;
  }
  return `<div class="chat-prompt">▸ ${escapeHtml(cleanPrompt(prompt))}</div>`;
}

// 팀장이 팀원 보고를 요약해서 최종 답변에 적어줘도 "그래서 뭐가 바뀌었는데?"는 여전히 안 보인다 —
// 굳이 팀원 카드까지 내려가서 찾지 않아도, 팀장 대화창 바로 위에서 소속 팀원별 변경 파일을 바로
// 열어볼 수 있게 한다(터미널 열기처럼 원본을 다 보여주는 게 아니라, 훑어보기 용도로 가볍게).
function renderLeadMemberChips() {
  syncAutoStallNudgeToggle();
  if (!selectedLeadId) { leadMembersChipsEl.innerHTML = ''; return; }
  const members = lastRows.filter(r => !r.isLead && r.leadId === selectedLeadId);
  leadMembersChipsEl.innerHTML = members.length
    ? members.map(m => `
        <button class="member-chip" data-files="${escapeHtml(m.cwd)}">
          ${escapeHtml(m.label || dirLabel(m.cwd))}${m.role ? ` · ${escapeHtml(m.role)}` : ''} — 커밋 대상
        </button>
      `).join('')
    : '';
}

// 정체 감시 자동 진행 여부는 팀장별 속성(LeadRecord.autoStallNudge)이라, 선택된 팀장이 바뀌거나
// 폴링으로 최신 rows가 들어올 때마다 체크박스 상태를 그 팀장 값에 맞춰 동기화한다. 사용자가 직접
// 클릭한 값을 폴링이 덮어쓰지 않아야 하는데, activeElement로 "지금 클릭한 직후인지"를 판단하면
// 안 된다 — change 핸들러가 요청 중에 disabled=true를 거는데, 폼 컨트롤을 disable하면 브라우저가
// 강제로 blur시켜서 activeElement가 곧바로 빠져나가버린다(리뷰에서 지적됨). 그러면 요청이 아직
// 안 끝났는데도 다음 폴링이 곧바로 체크박스를 원래 값으로 되돌리고 disabled까지 풀어버려서,
// 응답이 늦게 와도 사용자가 다시 누를 수 있는 상태로 보인다 — 아래 pendingAutoStallNudgeLeadId가
// 진짜 가드다(요청 중인 팀장 id를 직접 추적, 포커스 상태에 기대지 않는다).
let pendingAutoStallNudgeLeadId = null;

function syncAutoStallNudgeToggle() {
  if (pendingAutoStallNudgeLeadId) return; // 요청이 끝날 때까지 폴링이 값을 건드리지 않는다
  const lead = lastRows.find(r => r.isLead && r.id === selectedLeadId);
  autoStallNudgeToggle.checked = !!lead?.autoStallNudge;
  autoStallNudgeToggle.disabled = !lead;
}

// 위 chip은 renderChat()이 돌 때마다(폴링 포함) innerHTML이 통째로 새로 그려지므로, 개별
// addEventListener 대신 부모에 한 번만 위임 리스너를 건다.
leadMembersChipsEl.addEventListener('click', e => {
  const btn = e.target.closest('[data-files]');
  if (btn) showFileList(btn.dataset.files);
});

// 대기 중(큐/즉시전송 둘 다)인 메시지 중 실제로 전달된 게 있는지 항목별로 확인해서 로컬 상태를
// 갱신한다. kind별로 판단 방법이 다르다:
// - 'in-flight'(즉시 stop→resume으로 보낸 것)는 resumeLead가 메시지를 가공 없이 그대로
//   프롬프트로 쓰므로, 트랜스크립트에 똑같은 prompt가 나타나면 전달된 것으로 본다.
// - 'queued'(팀장이 busy라 main.ts pendingNotices에 쌓인 것)는 main.ts의 deliverPendingNotices가
//   같은 팀장 앞으로 쌓인 여러 건을 번호를 매겨 하나로 합쳐서 보낼 수 있어서, 더 이상 원문
//   메시지가 트랜스크립트 prompt와 정확히 일치하는지로 판단할 수 없다 — 대신 서버
//   (pendingNotices.json)에 그 notice id가 아직 남아있는지로 판단한다.
// get-lead-transcript는 그 세션(sessionId)의 "오늘"이 아니라 stop→resume으로 이어온 전체 기간의
// 기록을 통째로 돌려준다 — 실측으로 확인해보니 "그래", "커밋해줘", "이어서" 같은 짧고 흔한 지시는
// 몇 주에 걸쳐 같은 세션 안에서 수십 번씩 반복 등장한다. transcript 전체를 대상으로 "같은 prompt가
// 있는지"만 보면, 지금 막 보낸 메시지가 예전에 이미 보냈던 것과 문구가 같다는 이유만으로 응답이
// 오기도 전에 "이미 전달됨"으로 오판해서 pendingChatTurns에서 즉시 지워버린다 — 대기 중 말풍선이
// busy 배너와 함께 그려지지도 못하고 사라지는 버그가 바로 이것이다(실사용 재현: "busy 배너는 뜨는데
// 그 위에 말풍선이 안 뜬다"). 그래서 각 항목이 큐/즉시전송으로 넘어간 시점의 transcript 길이를
// item.transcriptBaselineLen에 한 번만 기록해두고(그 뒤로는 절대 안 바꿈), 그 길이 이후에 새로 추가된
// 항목에서만 일치를 찾는다 — 이미 지나간 과거 기록은 매칭 대상에서 아예 제외한다.
async function syncQueuedMessagesWithTranscript(leadId, transcript) {
  const listForLead = pendingChatTurns.get(leadId);
  if (!listForLead || !listForLead.length) return;

  let remainingQueuedIds = null;
  if (listForLead.some(item => item.kind === 'queued')) {
    try {
      // get-pending-notice-ids는 이제 {id, exhausted}를 돌려준다(exhausted: 자동 재시도
      // MAX_NOTICE_DELIVERY_ATTEMPTS회를 다 써서 더 이상 자동으로는 안 풀리는 항목) — id만
      // 있으면 되는 자리(존재 여부 확인)는 Map을 Set처럼 .has()로 그대로 쓰고, exhausted
      // 값이 필요한 자리는 .get()으로 꺼낸다.
      remainingQueuedIds = new Map((await window.api.getPendingNoticeIds(leadId)).map(n => [n.id, n.exhausted]));
    } catch (err) {
      console.error('대기열 상태 확인 실패:', err);
      // 조회 실패 시 성급하게 지우지 않고 다음 폴링에 다시 시도한다(remainingQueuedIds는 null로
      // 유지 — 아래에서 'queued' 항목을 그대로 보존하는 신호로 쓰인다).
    }
  }

  // 위 IPC await 도중에 다른 renderChat() 호출(다음 폴링 틱, 취소 버튼 클릭 등)이 먼저
  // pendingChatTurns를 갱신했을 수 있다 — await 전에 캡처해둔 listForLead로 필터링해서 그냥
  // 덮어쓰면, 그 사이 다른 호출이 이미 지운 항목을 되살려버릴 수 있다(예: 취소한 항목이 잠깐
  // 다시 나타났다 사라짐). await 이후 최신 상태를 다시 읽어서 그 위에 필터링한다.
  const currentList = pendingChatTurns.get(leadId);
  if (!currentList || !currentList.length) return;

  // main.ts의 deliverPendingNotices는 배달을 "시작"하는 순간(stop→resume을 걸며 resumeLead를
  // 큐잉하는 순간) pendingNotices.json에서 그 notice id를 바로 지운다 — 그런데 실제로 트랜스크립트에
  // 그 턴이 나타나기까지는 재기동+응답 생성 시간이 더 걸린다. id가 사라졌다고 여기서 곧바로
  // pendingChatTurns에서도 지우면, 그 사이 구간엔 대기열 placeholder도 없고 실제 트랜스크립트에도
  // 없어서 화면에 아무것도 안 보이는 공백이 생긴다(실사용 재현: "작업중인 메시지가 안 뜬다"). 그래서
  // id가 사라진 'queued' 항목은 지우지 않고 이미 있는 in-flight 처리로 전환해서 실제로 나타날
  // 때까지 계속 보여준다. 같은 팀장 앞으로 쌓인 여러 건이 한 번에 그룹으로 묶여 배달될 수 있어서
  // (main.ts combinePendingNoticeMessages) 각 원문은 실제 턴의 prompt 안에 번호가 매겨져 그대로
  // 포함되지만 정확히 같은 문자열은 아니다 — 그래서 전환된 항목은 정확히 일치가 아니라 "트랜스크립트
  // prompt 안에 원문이 포함돼있는지"로 판단한다(matchBySubstring). pendingChatTurns에 저장된
  // 객체를 직접 변형하므로(참조 공유) 별도로 다시 set() 안 해도 상태가 그대로 반영된다.
  if (remainingQueuedIds) {
    for (const item of currentList) {
      if (item.kind === 'queued' && !remainingQueuedIds.has(item.id)) {
        item.kind = 'in-flight';
        item.matchBySubstring = true;
        // 배달이 막 시작된 시점 — 이 시점까지 쌓인 기록은 전부 "이미 지나간 것"으로 보고 매칭
        // 대상에서 뺀다(아래 baseline 설명 참고).
        if (item.transcriptBaselineLen === undefined) item.transcriptBaselineLen = transcript.length;
      }
    }
  }

  const stillPending = currentList.filter(item => {
    if (item.kind === 'queued') {
      if (!remainingQueuedIds) return true;
      if (!remainingQueuedIds.has(item.id)) return false;
      item.exhausted = remainingQueuedIds.get(item.id);
      return true;
    }
    // 이 항목을 처음 보는 순간(즉시전송으로 push된 직후 첫 렌더)의 transcript 길이를 기준선으로
    // 고정한다 — 그 이후로는 절대 다시 계산하지 않는다. 항상 최신 transcript.length로 다시 계산하면
    // "아직 응답이 안 와서 길이가 그대로인" 정상적인 경우와 구별이 안 된다.
    if (item.transcriptBaselineLen === undefined) item.transcriptBaselineLen = transcript.length;
    const newEntries = transcript.slice(item.transcriptBaselineLen);
    const delivered = item.matchBySubstring
      ? newEntries.some(t => t.prompt.includes(item.message))
      : newEntries.some(t => t.prompt === item.message);
    return !delivered;
  });
  if (stillPending.length === currentList.length) return;
  if (stillPending.length) pendingChatTurns.set(leadId, stillPending);
  else pendingChatTurns.delete(leadId);
}

function removePendingChatTurn(leadId, itemId) {
  const list = pendingChatTurns.get(leadId) || [];
  const remaining = list.filter(item => item.id !== itemId);
  if (remaining.length) pendingChatTurns.set(leadId, remaining);
  else pendingChatTurns.delete(leadId);
}

function updatePendingChatTurn(leadId, itemId, patch) {
  const list = pendingChatTurns.get(leadId) || [];
  const item = list.find(i => i.id === itemId);
  if (item) Object.assign(item, patch);
}

// resumeLead가 다른 짧은 id로 깨어나면(main.ts 주석 참고) selectedLeadId가 바뀌는데,
// pendingChatTurns는 옛 id 밑에 남아있으면 새 id 기준으로 조회하는 renderChat()이 못 찾는다 —
// 그 lead의 대기 항목 전부를 새 id 밑으로 옮긴다.
function movePendingChatTurns(fromLeadId, toLeadId) {
  if (fromLeadId === toLeadId) return;
  const fromList = pendingChatTurns.get(fromLeadId);
  if (!fromList || !fromList.length) return;
  const toList = pendingChatTurns.get(toLeadId) || [];
  pendingChatTurns.set(toLeadId, toList.concat(fromList));
  pendingChatTurns.delete(fromLeadId);
}

// 팀장 자신이 busy인지, busy는 아니지만 소속 팀원이 아직 작업 중이라 사실상 대기 중인지를
// 배너 문구로 계산한다.
function computeBusyBannerHtml(row) {
  // resumeSpawnWithRetry가 daemon 레이스로 인한 크래시를 재시도하는 중이면(main.ts 참고) 다른 어떤
  // 상태보다도 먼저 보여준다 — 이 구간은 이 팀장이 잠깐 오프라인처럼 보일 수 있어서(stop 이후,
  // 재시도용 재spawn 전) 사용자가 "채팅이 안 간다"고 오해하기 딱 좋은 타이밍이다.
  if (row && row.resumeRetrying) {
    const { attempt, max } = row.resumeRetrying;
    return `<div class="chat-working">🔄 재연결 재시도 중 (${attempt}/${max})...</div>`;
  }
  const ownStatus = row && !row.offline ? getStatus(row) : '';
  const isBusy = ownStatus === 'busy';
  const waitingOnMember = !isBusy && !!row && (ownStatus === 'idle' || ownStatus === 'done') && hasBusyMember(row.id);
  if (isBusy) return '<div class="chat-working">● 작업 중...</div>';
  if (waitingOnMember) return '<div class="chat-working">⏳ 팀원 작업 대기중...</div>';
  return '';
}

// 대기 중인 항목 전부를(가장 오래된 것부터, 배열에 push한 순서 그대로) 각각 별도의 chat-turn으로
// 렌더링한다. kind==='queued'(팀장 busy라 큐에 쌓임)와 kind==='in-flight'(즉시 전송해서 응답
// 대기 중)는 안내 문구가 다르고, in-flight는 서버측에 취소할 대상이 없으므로 취소 버튼을 아예
// 안 보여준다. 취소 버튼 클릭은 chatTranscriptEl 위임 리스너 하나로 처리하므로(아래 참고) 여기선
// 매번 새로 안 걸어도 된다. .chat-answer에 white-space:pre-wrap이 걸려있어서, 이 템플릿을 여러
// 줄로 들여써서 만들면 그 들여쓰기/개행이 그대로 화면에 빈 줄로 보이고 취소 버튼도 엉뚱한 줄로
// 밀려난다 — 한 줄로 이어서 만든다.
function renderQueuedTurnsHtml(leadId) {
  const list = pendingChatTurns.get(leadId) || [];
  return list.map(item => {
    // exhausted(큐 자동 재시도를 MAX_NOTICE_DELIVERY_ATTEMPTS회 다 쓰고 포기한 상태)는 일반
    // 'queued'와 구분해서 보여준다 — 안 그러면 사실상 다시 안 풀리는 메시지가 "완료되면
    // 자동으로 전달됩니다"라고 계속 표시돼서 사용자가 영구 미배달을 알 수 없었다. "터미널에서
    // 직접 열기"로 인한 경합은 이제 attempts를 안 깎고 그냥 이번 폴링만 건너뛰므로(main.ts
    // deliverPendingNotices의 attachOpen 분기) 더 이상 exhausted의 주된 원인이 아니다 — 그래도
    // 다른 이유(daemon 일시적 오류 등)로 exhausted에 도달할 수 있으니, "팀장 복구" 같은 전용
    // 버튼은 이 앱에 없다는 전제로 실제로 있는 조치만 안내한다: 아래 취소 버튼으로 이 항목을
    // 빼고 다시 보내보거나, 계속되면 상단의 "새 작업 시작"으로 세션을 통째로 새로 띄운다.
    const statusText = item.exhausted
      ? '자동 재시도가 모두 실패해 전달을 멈췄습니다. 아래 취소 버튼으로 지우고 다시 보내보세요 — 계속 반복되면 "새 작업 시작"으로 세션을 새로 띄우세요.'
      : item.kind === 'queued'
        ? '팀장이 작업 중이라 메시지를 대기열에 넣었습니다 — 완료되면 자동으로 전달됩니다.'
        : '응답을 기다리는 중...';
    const answerClass = item.exhausted ? 'chat-answer chat-pending chat-pending-exhausted' : 'chat-answer chat-pending';
    const cancelBtnHtml = item.kind === 'queued'
      ? ` <button class="cancel-queued-btn" data-cancel-queued="${escapeHtml(item.id)}" data-cancel-lead="${escapeHtml(leadId)}">취소</button>`
      : '';
    return `<div class="chat-turn"><div class="chat-prompt">▸ ${escapeHtml(item.message)}</div><div class="${answerClass}">${statusText}${cancelBtnHtml}</div></div>`;
  }).join('');
}

// renderChat()은 3초 폴링(renderBoard)마다, 그리고 메시지를 보낼 때(sendChatMessage)마다 await 없이
// (fire-and-forget으로) 호출된다 — 그래서 같은 팀장에 대해 여러 renderChat() 호출이 동시에 실행 중일
// 수 있다. get-lead-transcript는 daily-journal 기록 전체를 매번 동기로 다시 읽고 파싱해서(캐시
// 없음) 프로젝트 기록이 쌓일수록 IPC 왕복 시간이 늘어나고 편차도 커지는데(실측: g1cl-mgt처럼 두 달치
// 기록이 쌓인 프로젝트는 회당 130~145ms), 즉시전송처럼 응답까지 수십 초가 걸리는 동안 3초 폴링이
// 여러 번 겹쳐 돌면 나중에 시작한 호출이 먼저 끝나고 더 먼저 시작했던(그래서 아직 새 턴이 반영 안 된
// 시점의 낡은 transcript를 쥔) 호출이 그 뒤에 끝나 화면을 덮어써버릴 수 있다 — 방금 보낸 메시지가
// 잠깐(다음 폴링까지) 화면에서 통째로 사라지는 버그가 바로 이 순서 역전 때문이다(실사용 재현: "즉시
// 작업 시작한 메시지가 화면에 안 뜬다"). renderChatSeq로 "가장 나중에 시작된 호출"만 실제로 화면을
// 쓰게 하고, 그 사이 더 최신 호출이 시작된 낡은 결과는 버린다. 또한 selectedLeadId는 각 await 사이에
// 바뀔 수 있는 전역 변수라 함수 안에서 여러 번 다시 읽으면(예전 코드) 같은 호출 안에서도 팀장이
// 뒤바뀔 수 있었다 — 시작할 때 leadId로 한 번만 캡처해서 끝까지 그 값만 쓴다.
let renderChatSeq = 0;

async function renderChat() {
  if (isInteractingWithChatTranscript || hasActiveSelectionInChatTranscript()) return; // 드래그 중이거나 선택이 아직 남아있으면 건너뛴다(위 리스너/함수 참고)
  const mySeq = ++renderChatSeq;
  renderLeadMemberChips();
  const leadId = selectedLeadId;
  if (!leadId) {
    chatTranscriptEl.innerHTML = ''; // 선택이 풀렸는데 예전 대화가 그대로 남아있으면 안 된다
    return;
  }
  let transcript;
  try {
    transcript = await window.api.getLeadTranscript(leadId);
  } catch (err) {
    if (mySeq !== renderChatSeq) return; // 더 최신 renderChat() 호출이 이미 시작됐다 — 이 결과는 버린다
    chatTranscriptEl.innerHTML = `<p style="color:#f14c4c">대화 기록을 불러오지 못했습니다: ${escapeHtml(errMsg(err))}</p>`;
    return;
  }

  await syncQueuedMessagesWithTranscript(leadId, transcript);
  if (mySeq !== renderChatSeq) return; // 위와 같은 이유로, 이 시점에도 더 최신 호출이 없을 때만 화면을 쓴다

  const row = lastRows.find(r => r.isLead && r.id === leadId);
  const busyBanner = computeBusyBannerHtml(row);
  const queuedTurnHtml = renderQueuedTurnsHtml(leadId);

  // waitingFor==='input needed'일 때만 조회한다 — 매 폴링마다 모든 팀장에 대해 파일을 읽을 필요는
  // 없고, 실제로 선택지 응답을 기다리는 이 팀장 하나만 필요할 때 가져온다(readPendingChoiceQuestions
  // 주석 참고). 조회 자체가 실패해도(파일 형식이 예상과 다르거나 이미 사라졌거나) 채팅창은 그대로
  // 정상 표시돼야 하므로 조용히 빈 값으로 넘어간다.
  //
  // 답변 버튼(채팅 전송)은 없앴다 — stop→resume으로 답을 보내봤더니 실사용에서 반복적으로 "User
  // declined to answer questions"로 잡혔다(2026-09-18, 실측 확인). 원인이 daemon의 자체 재기동
  // 타이밍이든 stop→resume 방식 자체든, 결과적으로 이 경로로는 확실하게 답이 전달된다고 보장할 수
  // 없다고 판단해 아예 버튼을 없애고 "터미널에서 직접 열기" 하나만 남겼다 — 세션을 죽이지 않고
  // 살아있는 프로세스에 바로 답하는 유일한 방법이다. 질문·선택지 내용은 참고용으로 텍스트로만 보여준다.
  const terminalBtnHtml = row && !row.offline
    ? `<button class="pending-choice-terminal-btn" data-attach="${escapeHtml(leadId)}">터미널에서 직접 열기</button>`
    : '';
  let pendingChoiceHtml = '';
  if (row && row.waitingFor === 'input needed') {
    let questions = null;
    try {
      questions = await window.api.getPendingChoice(leadId);
    } catch { /* 아래에서 questions가 null이면 그냥 안내를 안 보여준다 */ }
    if (mySeq !== renderChatSeq) return; // 위와 같은 이유로 최신 호출만 화면을 쓴다
    if (questions && questions.length) {
      // AskUserQuestion 한 번 호출에 질문이 여러 개 실릴 수 있다 — 예전엔 질문마다 카드를 통째로
      // 반복해서 "터미널에서 직접 열기" 버튼까지 여러 개 찍혔다(실사용 지적, 2026-09-18: 답은 터미널
      // 하나로만 하는데 버튼이 여러 개면 어느 걸 눌러야 하는지 헷갈림). 첫 질문만 카드로 보여주고,
      // 나머지는 "+N개 더"로 한 줄만 더 붙인다 — 버튼은 카드당 하나로 고정.
      const [first, ...rest] = questions;
      const extraBadge = rest.length ? `<span class="pending-choice-extra">+${rest.length}개 더</span>` : '';
      const restLineHtml = rest.length
        ? `<div class="pending-choice-detail">${rest.map(q => escapeHtml(q.question)).join(' · ')}</div>`
        : '';
      pendingChoiceHtml = `
        <div class="pending-choice">
          <div class="pending-choice-question">${escapeHtml(first.question)} ${extraBadge}</div>
          <div class="pending-choice-detail">선택지: ${first.options.map(o => escapeHtml(o.label)).join(' / ')}</div>
          ${restLineHtml}
          <div class="pending-choice-options">${terminalBtnHtml}</div>
        </div>
      `;
    }
  } else if (row && getStatus(row) === 'blocked') {
    // AskUserQuestion이 아니어도 채팅으로는 절대 못 푸는 blocked가 있다(예: 로그인 갱신 실패) —
    // readChatUnresolvableBlockDetail 주석 참고. 이것도 확인되면 "왜 막혔는지" 설명 + 터미널 버튼만
    // 보여준다(답변 버튼은 없음 — 애초에 채팅으로 답할 수 있는 종류가 아니므로).
    let unresolvableDetail = null;
    try {
      unresolvableDetail = await window.api.getChatUnresolvableDetail(leadId);
    } catch { /* 조회 실패 시 그냥 아무것도 안 보여준다 */ }
    if (mySeq !== renderChatSeq) return;
    if (unresolvableDetail) {
      pendingChoiceHtml = `
        <div class="pending-choice pending-choice-unresolvable">
          <div class="pending-choice-question">⚠ 채팅으로는 풀 수 없는 문제입니다 — 터미널에서 직접 확인하세요.</div>
          <div class="pending-choice-detail">${escapeHtml(unresolvableDetail)}</div>
          <div class="pending-choice-options">${terminalBtnHtml}</div>
        </div>
      `;
    }
  }

  // 3초마다 도는 폴링 갱신마다 무조건 맨 아래로 스크롤하면, 옛날 대화를 읽으려고 위로 스크롤해둔 걸
  // 계속 끌어내린다 — 이미 맨 아래 근처에 있을 때만("계속 따라가기") 다시 맨 아래로 붙인다.
  const wasNearBottom = chatTranscriptEl.scrollHeight - chatTranscriptEl.scrollTop - chatTranscriptEl.clientHeight < 40;

  if (!transcript || transcript.length === 0) {
    chatTranscriptEl.innerHTML = '<p style="color:#777">아직 대화 기록이 없습니다 (첫 응답을 기다리는 중일 수 있습니다).</p>' + queuedTurnHtml + busyBanner + pendingChoiceHtml;
  } else {
    chatTranscriptEl.innerHTML = transcript.map(t => `
      <div class="chat-turn">
        <div class="chat-time">${escapeHtml(t.time)}</div>
        ${renderPromptLineHtml(t.prompt)}
        <div class="chat-answer">${escapeHtml(t.answer)}</div>
      </div>
    `).join('') + queuedTurnHtml + busyBanner + pendingChoiceHtml;
  }
  if (wasNearBottom) chatTranscriptEl.scrollTop = chatTranscriptEl.scrollHeight;
  updateBusyUI();
}

// #chat-transcript 안에서 마우스로 뭔가를 하는 동안(텍스트를 드래그로 선택하거나, CSS
// resize:vertical 모서리를 드래그해 높이를 조절하거나) renderChat()의 3초 폴링이 innerHTML을
// 통째로 새로 그리면(위 renderChatSeq 주석 참고) 그 DOM을 건드리게 된다. 텍스트 선택 중이면
// 브라우저의 Selection이 물고 있던 옛 텍스트 노드가 통째로 사라지고 화면 같은 위치에 새 노드가
// 들어서면서 선택 앵커가 엉뚱한 지점을 잡아 위아래로 튀고(실사용 확인), 리사이즈 드래그 중이면
// 레이아웃 재계산 때문에 같은 증상이 난다.
//
// mousedown~mouseup(버튼을 누르고 있는 동안)만 막으면 부족하다 — 텍스트 선택은 마우스를 뗀
// 뒤에도(복사하려고 Ctrl+C를 누르기 전까지) 그대로 화면에 남아있어야 하는데, mouseup 순간 바로
// 가드를 꺼버리면 그 직후 폴링 틱이 선택을 통째로 날려버린다(실사용 확인: "드래그는 안 튀는데
// 떼고 나면 선택이 초기화된다"). 그래서 mouseup 이후에도 실제로 살아있는 선택(non-collapsed)이
// 이 요소 안에 있으면 계속 건너뛴다 — 사용자가 다른 곳을 클릭해 선택이 풀리면(브라우저가 알아서
// 선택을 지운다) 자연히 다음 폴링부터 다시 그려진다.
let isInteractingWithChatTranscript = false;
chatTranscriptEl.addEventListener('mousedown', () => { isInteractingWithChatTranscript = true; });
window.addEventListener('mouseup', () => { isInteractingWithChatTranscript = false; });

function hasActiveSelectionInChatTranscript() {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && chatTranscriptEl.contains(sel.anchorNode);
}

// 대기열 항목의 "취소" 버튼 — chatTranscriptEl이 폴링마다(그리고 renderChat 호출마다) innerHTML을
// 통째로 다시 그리므로, 다른 곳(leadMembersChipsEl/fileListContentEl)과 같은 패턴으로 위임 리스너
// 하나만 걸어둔다.
chatTranscriptEl.addEventListener('click', async e => {
  const btn = e.target.closest('[data-cancel-queued]');
  if (!btn) return;
  const leadId = btn.dataset.cancelLead;
  const noticeId = btn.dataset.cancelQueued;
  const answerEl = btn.closest('.chat-answer');
  btn.disabled = true;
  try {
    await window.api.cancelQueuedMessage(leadId, noticeId);
  } catch (err) {
    console.error('대기열 메시지 취소 실패:', err);
    // 실패를 콘솔에만 남기면 사용자는 버튼이 그냥 안 눌리는 것처럼 보인다 — 항목 옆에 짧게
    // 알려준다(다음 renderChat 때 자연스럽게 사라짐). 로컬 상태는 건드리지 않아서 다시 눌러 재시도할 수 있다.
    if (answerEl) {
      answerEl.insertAdjacentHTML('beforeend', `<div style="color:#f14c4c">취소 요청이 실패했습니다: ${escapeHtml(errMsg(err))}</div>`);
    }
    btn.disabled = false;
    return;
  }
  // main.ts 쪽 파일에서 못 찾았어도(이미 전달됐거나 이미 취소됨) 사용자가 취소를 누른 의도는
  // 그대로 반영한다 — 실제로 이미 전달된 경우라면 다음 renderChat에서 트랜스크립트 비교로도
  // 결국 지워지므로 여기서 먼저 지워도 안전하다.
  removePendingChatTurn(leadId, noticeId);
  await renderChat();
});

// formMode('none'/'launch'/'adopt')만으로는 "팀장이 0개라 launch 폼이 기본으로 뜬 상태"를 못
// 구분해서, 대화창/팀원 목록 양쪽에서 써야 하는 이 계산을 함수 하나로 뽑아둔다.
function getEffectiveLeadMode() {
  const hasLeads = lastLeadIds.size > 0;
  return formMode === 'none' && !hasLeads ? 'launch' : formMode;
}

function updateLeadSectionVisibility() {
  const hasLeads = lastLeadIds.size > 0;
  const effectiveMode = getEffectiveLeadMode();

  launchFormPanelEl.hidden = effectiveMode !== 'launch';
  adoptFormPanelEl.hidden = effectiveMode !== 'adopt';
  leadChatPanelEl.hidden = effectiveMode !== 'none' || !selectedLeadId;

  cancelFormBtn.hidden = !(effectiveMode === 'launch' && hasLeads);
  cancelAdoptBtn.hidden = false;
  // 각 버튼은 "자기 자신의 폼이 지금 보이고 있을 때만" 숨긴다 — 팀장이 0개라 launch 폼이 기본으로
  // 뜬 상태에서도 "터미널 세션 이어가기"는 여전히 눌러서 전환할 수 있어야 한다.
  newLeadBtn.hidden = effectiveMode === 'launch';
  adoptLeadBtn.hidden = effectiveMode === 'adopt';
}

newLeadBtn.addEventListener('click', () => {
  formMode = 'launch';
  updateLeadSectionVisibility();
});

cancelFormBtn.addEventListener('click', () => {
  formMode = 'none';
  updateLeadSectionVisibility();
});

// add-member-panel(addMemberBtn/cancelAddMemberBtn)은 열 때/취소할 때 입력값을 전부 비우는데,
// 이 폼은 그게 빠져있어서 세션 ID/디렉토리를 입력했다가 취소하고 나중에 다시 열어도 옛 값이
// 그대로 남아있었다 — 사용자가 새로 입력한다고 착각하고 옛 값 그대로 제출할 위험이 있어서
// 같은 패턴으로 맞춘다.
function resetManualSessionForm() {
  manualSessionIdEl.value = '';
  manualSessionCustomPickedDir = null;
  manualSessionDirSelect.value = '';
  manualSessionStatusEl.textContent = '';
  syncManualSessionResumeBtnState();
}

adoptLeadBtn.addEventListener('click', () => {
  formMode = 'adopt';
  resetManualSessionForm();
  updateLeadSectionVisibility();
  renderAdoptableSessions();
});

cancelAdoptBtn.addEventListener('click', () => {
  formMode = 'none';
  resetManualSessionForm();
  updateLeadSectionVisibility();
});

chatSendBtn.addEventListener('click', sendChatMessage);
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

async function sendChatMessage() {
  if (!selectedLeadId || busyLeadIds.has(selectedLeadId) || !chatInputEl.value.trim()) return;
  const leadId = selectedLeadId;
  const message = chatInputEl.value.trim();
  chatInputEl.value = '';
  busyLeadIds.add(leadId);
  updateBusyUI();

  // 서버 응답(sendToLead의 IPC 왕복)을 기다리는 동안에도 방금 보낸 메시지가 즉시 보여야 전송이
  // 된 것처럼 느껴진다 — 대기열(queued)과 완전히 같은 pendingChatTurns 구조에 우선 'in-flight'로
  // 넣어서 지금 바로 renderChat()으로 그려준다. 서버가 실제로는 큐에 넣었다고 하면 아래에서
  // kind를 'queued'로 바꾼다. 이렇게 하면 즉시 전송 건도 refreshBoardNow()가 renderChat()으로
  // 화면을 서버 트랜스크립트로 통째로 다시 그려도(아직 이 턴이 없으니) 계속 보인다 — 예전엔
  // optimisticTurn을 DOM에 직접 얹기만 해서, 그 직후 refreshBoardNow()가 화면을 덮어쓰며 이
  // 메시지가 잠깐 사라졌다 나중에 다시 뜨는 것처럼 보이는 버그가 있었다.
  const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const list = pendingChatTurns.get(leadId) || [];
  list.push({ id: localId, message, kind: 'in-flight' });
  pendingChatTurns.set(leadId, list);
  renderChat();

  // 버튼이 disabled로 회색이 되는 것만으로는(updateBusyUI) "전송 중"인지 "다른 이유로 잠김"인지
  // 구분이 잘 안 된다는 피드백이 있어서, 전송 자체가 진행 중인 동안엔 버튼 라벨도 짧게 바꿔준다.
  const originalSendLabel = chatSendBtn.textContent;
  chatSendBtn.textContent = '전송 중...';

  try {
    const result = await window.api.sendToLead(leadId, message);
    if (!result || result.status === 'not-found') {
      // 오프라인 팀장을 이어하려다 실패한 경우(세션 만료 등) 여기서 걸린다 — 조용히 넘어가지 않는다.
      removePendingChatTurn(leadId, localId);
      await renderChat(); // pendingChatTurns에서 지운 in-flight 항목을 화면에서도 지운다
      chatTranscriptEl.insertAdjacentHTML('beforeend', '<p style="color:#f14c4c">이어하기에 실패했습니다 — 세션이 만료됐거나 claude CLI 실행에 문제가 있을 수 있습니다.</p>');
      return;
    }
    if (result.status === 'attach-open') {
      // main.ts의 send-to-lead가 이 팀장에 "터미널에서 직접 열기"로 띄운 attach 창이 아직
      // 붙어있는 걸 감지하고 stop→resume 자체를 시도하지 않은 경우 — 그대로 보냈다간 attach의
      // 독립적인 재연결과 경합해서 세션이 갈라질 수 있다(실사용 재현). 'failed'와 달리 원인을
      // 정확히 알 수 있으니 그대로 알려준다.
      removePendingChatTurn(leadId, localId);
      await renderChat();
      chatTranscriptEl.insertAdjacentHTML('beforeend', '<p style="color:#f14c4c">이 팀장에 연결된 터미널 창(터미널에서 직접 열기)이 아직 열려있어 보내지 않았습니다 — 그 터미널을 닫고 다시 시도하세요.</p>');
      return;
    }
    if (result.status === 'failed') {
      // main.ts의 resumeLead가 null을 반환한 경우(정지 실패 등으로 resume 자체를 포기) — 예전엔
      // 이걸 'sent'로 뭉뚱그려서 selectedLeadId가 null로 덮어써지며 대화창이 조용히 사라지는 것처럼
      // 보이는 버그가 있었다. 'not-found'와 같은 방식으로 명확히 실패를 알린다.
      removePendingChatTurn(leadId, localId);
      await renderChat();
      chatTranscriptEl.insertAdjacentHTML('beforeend', '<p style="color:#f14c4c">전송에 실패했습니다 — 팀장 세션을 정지하지 못해 재개를 포기했습니다. 잠시 후 다시 시도해보세요.</p>');
      return;
    }
    if (result.status === 'queued') {
      // 팀장이 지금 작업 중이면 claude CLI 자체에 실행 중인 세션에 끼어들어 입력만 추가하는 기능이
      // 없어서(claude --help 확인) stop→resume으로 끊는 수밖에 없다 — main.ts가 끊지 않고 큐에
      // 담아뒀다가 팀장이 idle/blocked가 되면 자동으로 전달한다. 방금 'in-flight'로 넣어둔 항목을
      // 'queued'로 바꾸고 id도 main.ts가 발급한 PendingNotice.id로 갱신한다(이후 취소/전달완료
      // 판정에 쓰인다).
      updatePendingChatTurn(leadId, localId, { id: result.id, kind: 'queued' });
      // 3초 폴링을 기다리지 않고 팀장의 busy 표시 등을 바로 반영한다(카드 새로고침 버튼과 동일한 방식).
      await refreshBoardNow();
      return;
    }
    // resumeLead가 다른 짧은 id로 깨어날 수 있다(main.ts resumeLead 주석 참고) — 반영하지 않으면
    // 대화창 선택이 풀려서 방금 보낸 대화가 사라진 것처럼 보인다. pendingChatTurns도 새 id 밑으로
    // 옮겨야 renderChat()이 selectedLeadId 기준으로 계속 찾는다.
    movePendingChatTurns(leadId, result.id);
    selectedLeadId = result.id;
    // renderChat()만 부르면 대화 내용만 갱신되고, 카드의 busy 표시 등은 다음 3초 폴링까지 그대로다 —
    // refreshBoardNow()가 renderBoard()를 거쳐 renderChat()까지 알아서 호출해주므로 이걸로 대체한다.
    await refreshBoardNow();
  } catch (err) {
    removePendingChatTurn(leadId, localId);
    await renderChat(); // pendingChatTurns에서 지운 in-flight 항목을 화면에서도 지운다
    chatTranscriptEl.insertAdjacentHTML('beforeend', `<p style="color:#f14c4c">이어하기 중 오류가 발생했습니다: ${escapeHtml(errMsg(err))}</p>`);
  } finally {
    chatSendBtn.textContent = originalSendLabel;
    busyLeadIds.delete(leadId);
    updateBusyUI();
  }
}

// 재시작/작업종료 확인 모달을 열 때, 그 팀장에게 아직 전달 안 된 대기열 메시지가 있으면 몇 건
// 있는지 미리 경고해준다 — 재시작은 internalId가 그대로라 큐가 자연히 이어서 전달되지만, 작업종료는
// 세션 자체를 멈추므로 그 전에 사용자가 알고 결정할 수 있어야 한다.
async function updatePendingNoticeWarning(warningEl, leadId) {
  if (!leadId) { warningEl.hidden = true; return; }
  try {
    const count = (await window.api.getPendingNoticeIds(leadId)).length;
    if (count > 0) {
      warningEl.textContent = `⚠ 아직 전달되지 않은 대기열 메시지가 ${count}건 있습니다.`;
      warningEl.hidden = false;
    } else {
      warningEl.hidden = true;
    }
  } catch (err) {
    console.error('대기열 메시지 수 확인 실패:', err);
    warningEl.hidden = true;
  }
}

autoStallNudgeToggle.addEventListener('change', async () => {
  if (!selectedLeadId) return;
  const targetLeadId = selectedLeadId; // 요청 도중 사용자가 다른 팀장으로 바꿀 수 있어 스냅샷해둔다
  const value = autoStallNudgeToggle.checked;
  pendingAutoStallNudgeLeadId = targetLeadId;
  autoStallNudgeToggle.disabled = true;
  try {
    await window.api.setLeadAutoStallNudge(targetLeadId, value);
  } catch (err) {
    console.error('자동 진행 설정 변경 실패:', err);
    // 그 사이 사용자가 다른 팀장을 선택했으면, 지금 체크박스는 이미 다른 팀장을 나타내고 있다 —
    // 되돌리면 엉뚱한 팀장의 값을 건드리는 꼴이라 여전히 같은 팀장을 보고 있을 때만 되돌린다.
    if (selectedLeadId === targetLeadId) autoStallNudgeToggle.checked = !value;
  } finally {
    pendingAutoStallNudgeLeadId = null;
    if (selectedLeadId === targetLeadId) autoStallNudgeToggle.disabled = false;
    // 팀장이 바뀌었으면 여기서 손대지 않는다 — 다음 syncAutoStallNudgeToggle(폴링 등)이 지금
    // 선택된 팀장 값으로 알아서 다시 맞춰준다.
  }
});

restartLeadBtn.addEventListener('click', () => {
  showModal(restartLeadPanelEl);
  restartInstructionEl.value = '';
  restartStatusEl.textContent = '';
  updatePendingNoticeWarning(restartPendingWarningEl, selectedLeadId);
});

restartCancelBtn.addEventListener('click', () => {
  hideModal(restartLeadPanelEl);
});

restartConfirmBtn.addEventListener('click', async () => {
  if (!selectedLeadId || busyLeadIds.has(selectedLeadId)) return;
  const leadId = selectedLeadId;
  busyLeadIds.add(leadId);
  updateBusyUI();
  restartConfirmBtn.disabled = true;
  restartStatusEl.textContent = '새 세션을 시작하는 중...';
  try {
    const result = await window.api.restartLead(leadId, restartInstructionEl.value.trim());
    if (result && result.id) {
      selectedLeadId = result.id;
      hideModal(restartLeadPanelEl);
      restartStatusEl.textContent = '';
      await renderChat();
      renderMemberRow(); // 새 세션이라 소속 팀원이 없을 테니, 폴링 안 기다리고 바로 비워서 보여준다
    } else {
      // main.ts가 실패 사유(타임아웃/레코드 없음 등)를 함께 돌려주므로 그대로 보여준다 — "왜"를
      // 몰라 재현·진단이 안 되던 문제를 해결하기 위한 것이다.
      restartStatusEl.textContent = result && result.error
        ? `새 세션 시작에 실패했습니다 — ${result.error}`
        : '새 세션 시작에 실패했습니다.';
    }
  } catch (err) {
    restartStatusEl.textContent = `새 세션 시작 중 오류가 발생했습니다: ${errMsg(err)}`;
  } finally {
    busyLeadIds.delete(leadId);
    restartConfirmBtn.disabled = false;
    updateBusyUI();
  }
});

endWorkBtn.addEventListener('click', () => {
  showModal(endWorkPanelEl);
  endWorkStatusEl.textContent = '';
  updatePendingNoticeWarning(endWorkPendingWarningEl, selectedLeadId);
});

endWorkCancelBtn.addEventListener('click', () => {
  hideModal(endWorkPanelEl);
});

endWorkConfirmBtn.addEventListener('click', async () => {
  if (!selectedLeadId || busyLeadIds.has(selectedLeadId)) return;
  const leadId = selectedLeadId;
  busyLeadIds.add(leadId);
  updateBusyUI();
  endWorkConfirmBtn.disabled = true;
  endWorkStatusEl.textContent = '팀원부터 종료하는 중...';
  try {
    const result = await window.api.endLeadWork(leadId);
    if (result && result.success) {
      hideModal(endWorkPanelEl);
      endWorkStatusEl.textContent = '';
      await refreshBoardNow();
    } else if (result && result.memberFailures && result.memberFailures.length > 0) {
      endWorkStatusEl.textContent = `팀장 종료에 실패했습니다. (팀원 종료도 일부 실패: ${result.memberFailures.join(', ')})`;
    } else {
      endWorkStatusEl.textContent = '팀장 종료에 실패했습니다.';
    }
  } catch (err) {
    endWorkStatusEl.textContent = `작업 종료 중 오류가 발생했습니다: ${errMsg(err)}`;
  } finally {
    busyLeadIds.delete(leadId);
    endWorkConfirmBtn.disabled = false;
    updateBusyUI();
  }
});

// ---------------- 작업 탭: 기존 세션 연결 ----------------

function relativeAge(startedAt) {
  if (!startedAt) return '';
  const mins = Math.floor((Date.now() - startedAt) / 60000);
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

// 백그라운드 세션(그대로 연결)과 인터랙티브 세션(복사본을 만들어 연결)을 하나의 목록으로 합친다 —
// 사용자 입장에선 어느 쪽이든 "연결하기" 하나로 충분하고, 내부 처리 방식만 달라진다.
async function renderAdoptableSessions() {
  let bgSessions, itSessions;
  try {
    [bgSessions, itSessions] = await Promise.all([
      window.api.getAdoptableSessions(),  // 최신순 정렬됨(main.ts)
      window.api.getInteractiveSessions(),
    ]);
  } catch (err) {
    adoptableSelect.innerHTML = '<option value="">-- 연결할 세션 선택 --</option>';
    adoptStatusEl.textContent = `세션 목록을 불러오지 못했습니다: ${errMsg(err)}`;
    return;
  }
  adoptableEntriesByValue = new Map();
  const options = ['<option value="">-- 연결할 세션 선택 --</option>'];

  bgSessions.forEach(s => {
    const value = `bg:${s.id}`;
    adoptableEntriesByValue.set(value, { kind: 'background', id: s.id });
    const age = relativeAge(s.startedAt);
    const state = s.status || s.state || '';
    options.push(`<option value="${escapeHtml(value)}">${escapeHtml(dirLabel(s.cwd))} · ${age}${state ? ` · ${escapeHtml(state)}` : ''}</option>`);
  });
  itSessions.forEach(s => {
    const value = `it:${s.sessionId}`;
    adoptableEntriesByValue.set(value, { kind: 'interactive', sessionId: s.sessionId, cwd: s.cwd });
    const age = relativeAge(s.startedAt);
    options.push(`<option value="${escapeHtml(value)}">${escapeHtml(dirLabel(s.cwd))} · ${age} · 대화중(복사본 생성)</option>`);
  });

  adoptableSelect.innerHTML = options.join('');
  syncAdoptBtnState();
  adoptStatusEl.textContent = adoptableEntriesByValue.size === 0
    ? '연결할 수 있는 세션이 없습니다.'
    : '';
}

refreshAdoptableBtn.addEventListener('click', renderAdoptableSessions);

adoptableSelect.addEventListener('change', () => {
  syncAdoptBtnState();
});

adoptBtn.addEventListener('click', async () => {
  const entry = adoptableEntriesByValue.get(adoptableSelect.value);
  if (!entry) return;
  adoptBtn.disabled = true;
  adoptStatusEl.textContent = entry.kind === 'background' ? '연결하는 중...' : '복사본을 만드는 중...';
  try {
    const id = entry.kind === 'background'
      ? await window.api.adoptLead(entry.id)
      : await window.api.forkSessionAsLead(entry.sessionId, entry.cwd);
    if (id) {
      adoptStatusEl.textContent = entry.kind === 'background'
        ? `연결됐습니다(${id}).`
        : `복사본을 연결했습니다(${id}). 원본 세션은 그대로입니다.`;
      formMode = 'none';
      selectedLeadId = id;
      renderMemberRow(); // 폴링 안 기다리고 이 팀장 소속 팀원으로 바로 갱신
      updateLeadSectionVisibility();
    } else {
      adoptStatusEl.textContent = '연결에 실패했습니다 — 세션이 이미 종료됐을 수 있습니다.';
    }
  } catch (err) {
    adoptStatusEl.textContent = `연결 중 오류가 발생했습니다: ${errMsg(err)}`;
  } finally {
    adoptBtn.disabled = false;
  }
});

manualSessionIdEl.addEventListener('input', () => {
  syncManualSessionResumeBtnState();
});

manualSessionDirSelect.addEventListener('change', () => {
  syncManualSessionResumeBtnState();
});

pickManualSessionDirBtn.addEventListener('click', async () => {
  try {
    const dir = await window.api.pickDirectory();
    if (dir) {
      manualSessionCustomPickedDir = dir;
      await renderFavorites();
    }
  } catch (err) {
    manualSessionStatusEl.textContent = `폴더 선택에 실패했습니다: ${errMsg(err)}`;
  }
});

manualSessionResumeBtn.addEventListener('click', async () => {
  const sessionId = manualSessionIdEl.value.trim();
  const dir = manualSessionDirSelect.value;
  if (!sessionId || !dir) return;
  manualSessionResumeBtn.disabled = true;
  manualSessionStatusEl.textContent = '이어하는 중...';
  try {
    const id = await window.api.forkSessionAsLead(sessionId, dir);
    if (id) {
      // 원본 세션이 이미 죽어있었으면 그 세션 자체가 그대로 복구되고(같은 짧은 id로 재등록됨),
      // 아직 살아있었으면(예: 다른 터미널에서 대화 중) 복사본이 새로 생긴다 — CLI 자체의 동작이라
      // 여기서 미리 구분할 수 없어서 문구도 두 경우를 다 포괄해서 안내한다.
      manualSessionStatusEl.textContent = `이어졌습니다(${id}). 원래 세션이 죽어있었다면 그 세션이 그대로 복구된 것이고, 살아있었다면 복사본입니다.`;
      manualSessionIdEl.value = '';
      formMode = 'none';
      selectedLeadId = id;
      renderMemberRow(); // 폴링 안 기다리고 이 팀장 소속 팀원으로 바로 갱신
      updateLeadSectionVisibility();
    } else {
      manualSessionStatusEl.textContent = '이어하기에 실패했습니다 — 세션 ID가 정확한지, claude --version/claude --bg가 정상 동작하는지 확인해보세요.';
    }
  } catch (err) {
    manualSessionStatusEl.textContent = `이어하는 중 오류가 발생했습니다: ${errMsg(err)}`;
  } finally {
    manualSessionResumeBtn.disabled = false;
  }
});

// ---------------- 세션 정리 탭 ----------------

function tagLabel(s) {
  if (s.tag === 'lead') return '팀장';
  if (s.tag === 'member') return '팀원';
  // 등록은 안 됐지만(SKILL.md의 "띄우자마자 등록해라"를 놓친 경우 — 실사용에서 팀장 자신도
  // 이걸 깜빡한 적이 있다) 그 팀장의 승인된 디렉토리에서 그 팀장이 뜬 뒤 나타났다는 정황만으로
  // "이 팀장 소속일 수 있음"이라고 추정된 경우를 구분해서 보여준다(guessProbableLeadId, main.ts).
  return s.probableLeadId ? '미등록(추정 팀원)' : '미등록';
}

function cleanupItemHtml(s, indented) {
  const registerBtn = s.tag === 'untracked' && s.probableLeadId
    ? `<button class="register-probable-btn" data-register-probable="${escapeHtml(s.id)}" data-lead-id="${escapeHtml(s.probableLeadId)}" title="이 세션을 ${escapeHtml(s.probableLeadId)} 팀장의 정식 팀원으로 등록합니다">팀원으로 등록</button>`
    : '';
  // 팀장이 EnterWorktree로 잠깐 자리를 옮기면 s.cwd가 등록된 디렉토리와 달라진다 — 그걸로 제목을
  // 지으면 마치 새 팀장이 생긴 것처럼 보이므로(실사용 재현), 등록된 디렉토리(registeredDir)가 있으면
  // 그걸 제목으로 쓴다. cwd 자체는 메타 줄에 그대로 남겨서 "지금 어디 있는지"는 계속 보이게 한다.
  const titleDir = s.registeredDir || s.cwd;
  return `
    <div class="cleanup-item ${statusClass(s)}${indented ? ' cleanup-item-indented' : ''}">
      <div class="cleanup-info">
        <div class="cleanup-top">${escapeHtml(dirLabel(titleDir))}<span class="cleanup-tag">${tagLabel(s)}</span></div>
        <div class="cleanup-meta">${escapeHtml(s.cwd)} · ${relativeAge(s.startedAt)} · ${escapeHtml(s.status || s.state || '')}</div>
      </div>
      ${registerBtn}
      <button class="stop-btn" data-stop-bg="${escapeHtml(s.id)}">종료</button>
    </div>
  `;
}

// 팀장 카드 먼저, 그 아래 소속 팀원들을 들여쓴 카드로 묶어서 보여준다(cleanup-item-indented).
// 묶는 로직 자체는 lib/cleanupGrouping.js의 groupSessionsByTeam(순수 함수, 테스트 대상)이 맡고,
// 여기서는 그 결과를 HTML로만 옮긴다.
function groupCleanupSessions(sessions) {
  const { teams, orphans } = groupSessionsByTeam(sessions);
  const teamsHtml = teams
    .map(({ lead, members }) => cleanupItemHtml(lead, false) + members.map(m => cleanupItemHtml(m, true)).join(''))
    .join('');
  const orphansHtml = orphans.length
    ? `<div class="cleanup-group-label">소속 팀장이 없는 세션</div>${orphans.map(s => cleanupItemHtml(s, false)).join('')}`
    : '';
  return teamsHtml + orphansHtml;
}

// 이 탭이 보는 세션 목록은 "지금 이 프로세스가 아는 leads.json"에 등록됐는지로만 팀장/팀원/미등록을
// 가른다 — 그래서 같은 앱을 다른 --user-data-dir(예: 격리된 테스트 인스턴스)로 하나 더 띄우면, 그
// 인스턴스 입장에선 실제로는 다른 프로세스(원래 인스턴스)가 멀쩡히 쓰고 있는 세션도 전부 "소속 팀장이
// 없는 세션"으로 보여서 실수로 종료 버튼을 누르기 쉽다(실측 확인, 2026-09-17 UI 점검 중) — 이 탭 자체가
// "실수로 끄는 걸 막기 위해 작업 탭과 분리했다"는 목적을 갖고 있었는데, 정작 탭 안에서는 클릭 한 번으로
// 되돌릴 수 없이 즉시 종료돼버려서 그 목적을 절반만 채우고 있었다. 어느 세션인지 이름을 보여주고 한 번
// 더 확인받는 모달을 거치도록 한다.
let lastCleanupSessions = [];
let cleanupStopTargetId = null;

async function renderCleanupSessions() {
  let sessions;
  try {
    sessions = await window.api.getAllBackgroundSessions();
  } catch (err) {
    cleanupListEl.innerHTML = `<div class="empty-hint">세션 목록을 불러오지 못했습니다: ${escapeHtml(errMsg(err))}</div>`;
    return;
  }
  lastCleanupSessions = sessions;
  cleanupListEl.innerHTML = sessions.length ? groupCleanupSessions(sessions) : '<div class="empty-hint">떠있는 백그라운드 세션이 없습니다.</div>';

  cleanupListEl.querySelectorAll('[data-stop-bg]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.stopBg;
      const s = lastCleanupSessions.find(x => x.id === id);
      cleanupStopTargetId = id;
      cleanupStopInfoEl.textContent = s
        ? `${tagLabel(s)} · ${dirLabel(s.registeredDir || s.cwd)} (${s.cwd}) · ${s.status || s.state || ''}`
        : id;
      showModal(cleanupStopPanelEl);
    });
  });

  cleanupListEl.querySelectorAll('[data-register-probable]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const ok = await window.api.registerProbableMember(btn.dataset.registerProbable, btn.dataset.leadId);
        if (!ok) console.error('팀원 등록 실패 — 세션 또는 팀장이 이미 사라졌을 수 있습니다.');
      } catch (err) {
        console.error('팀원 등록 중 오류:', err);
      } finally {
        await renderCleanupSessions();
      }
    });
  });
}

refreshCleanupBtn.addEventListener('click', renderCleanupSessions);

document.querySelector('.tab-btn[data-tab="cleanup"]').addEventListener('click', renderCleanupSessions);

cleanupStopCancelBtn.addEventListener('click', () => {
  cleanupStopTargetId = null;
  hideModal(cleanupStopPanelEl);
});

cleanupStopConfirmBtn.addEventListener('click', async () => {
  if (!cleanupStopTargetId) return hideModal(cleanupStopPanelEl);
  const id = cleanupStopTargetId;
  cleanupStopConfirmBtn.disabled = true;
  try {
    await window.api.stopBackgroundSession(id);
  } catch (err) {
    console.error('세션 종료 실패:', err);
  } finally {
    cleanupStopConfirmBtn.disabled = false;
    cleanupStopTargetId = null;
    hideModal(cleanupStopPanelEl);
    await renderCleanupSessions();
  }
});

// ---------------- 히스토리 탭 (오프라인 팀장 모음 + 이어하기) ----------------

// resume 유효기간이 공식적으로 알려진 게 없어서 정확한 컷오프는 못 정한다 — 그냥 "오래됐다"는 걸
// 경고 색으로만 알려주고, 실제 이어짐 여부는 시도해봐야 안다(sendChatMessage의 실패 처리 참고).
// daily-journal이 남기는 summary([F]/[T]/[S] 구조로 파일·도구·핵심을 정리한 것)가 있으면 그걸 쓰고,
// 없으면 prompt/answer 원문을 잘라서 보여준다.
// 원본 문자열 기준으로 길이를 재서 자르고(이스케이프 후에 자르면 "&amp;" 같은 엔티티가 중간에
// 잘려 보일 수 있다), 잘렸을 때만 끝에 말줄임표를 붙인다 — 안 그러면 문장이 뚝 끊긴 것처럼 보인다.
function truncateForPreview(str, len) {
  if (!str) return '';
  return str.length > len ? `${escapeHtml(str.slice(0, len))}…` : escapeHtml(str);
}

function formatPreview(preview, promptLen, answerLen) {
  if (!preview) return '(대화 기록 없음)';
  if (preview.summary) return escapeHtml(preview.summary);
  return `${truncateForPreview(preview.prompt, promptLen)}\n→ ${truncateForPreview(preview.answer, answerLen)}`;
}

function historyRiskBadge(row) {
  const lastActive = row.preview?.time ? new Date(row.preview.time.replace(' ', 'T')) : new Date(row.startedAt);
  if (isNaN(lastActive.getTime())) return '';
  const days = Math.floor((Date.now() - lastActive.getTime()) / 86400000);
  if (days > 30) return `<span class="history-risk risk-high">${days}일 전 — 만료됐을 수 있음</span>`;
  if (days > 20) return `<span class="history-risk risk-mid">${days}일 전 — 곧 만료 위험</span>`;
  return '';
}

function renderHistoryCard(row) {
  return `
    <div class="history-item" data-history-lead="${escapeHtml(row.id)}">
      <div class="history-top">
        <span>${escapeHtml(row.label || row.projectName)}</span>
        ${row.secret ? '<span class="secret-badge" title="시크릿 모드로 띄웠던 팀장입니다">🔒</span>' : ''}
        ${row.name ? `<span class="history-topic">${escapeHtml(row.name)}</span>` : ''}
        ${historyRiskBadge(row)}
        <button class="history-delete-btn" data-delete-history="${escapeHtml(row.internalId || '')}" title="Team Monitor 히스토리에서만 삭제합니다(실제 대화 파일은 안 지움)">삭제</button>
      </div>
      <div class="history-meta">${escapeHtml(row.cwd)} · ${relativeAge(row.startedAt)} 시작</div>
      ${row.preview ? `<div class="history-preview">${formatPreview(row.preview, 80, 160)}</div>` : ''}
      <div class="history-hint">눌러서 이어하기 — 작업 탭으로 이동해 대화창에서 메시지를 보내면 다시 깨어나고, "새 작업 시작"을 누르면 이전 대화 없이 완전히 새로운 작업으로 다시 띄울 수도 있습니다</div>
    </div>
  `;
}

let historyDeleteTargetId = null;

function renderHistory() {
  const offlineLeads = lastRows.filter(r => r.isLead && r.offline);
  historyListEl.innerHTML = offlineLeads.length
    ? offlineLeads.map(renderHistoryCard).join('')
    : '<div class="empty-hint">이전에 작업한 팀장이 없습니다.</div>';

  historyListEl.querySelectorAll('[data-history-lead]').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelector('.tab-btn[data-tab="work"]').click();
      selectLead(el.dataset.historyLead);
    });
  });

  // "삭제" 버튼은 카드 전체의 클릭(이어하기로 이동)과 같은 영역에 있으므로 stopPropagation으로
  // 부모 카드의 클릭 리스너를 막는다 — 안 그러면 삭제 확인 모달을 열려다 작업 탭으로 튕겨나간다.
  historyListEl.querySelectorAll('[data-delete-history]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const internalId = btn.dataset.deleteHistory;
      const row = lastRows.find(r => r.isLead && r.internalId === internalId);
      historyDeleteTargetId = internalId;
      historyDeleteInfoEl.textContent = row ? `${row.label || row.projectName} · ${row.cwd}` : '';
      showModal(historyDeletePanelEl);
    });
  });
}

historyDeleteCancelBtn.addEventListener('click', () => {
  historyDeleteTargetId = null;
  hideModal(historyDeletePanelEl);
});

historyDeleteConfirmBtn.addEventListener('click', async () => {
  if (!historyDeleteTargetId) return hideModal(historyDeletePanelEl);
  const internalId = historyDeleteTargetId;
  historyDeleteConfirmBtn.disabled = true;
  try {
    const result = await window.api.deleteLeadHistory(internalId);
    if (!result || !result.success) {
      historyDeleteInfoEl.insertAdjacentHTML('beforeend', `<div style="color:#f14c4c">삭제 실패: ${escapeHtml((result && result.error) || '알 수 없는 오류')}</div>`);
      return;
    }
    historyDeleteTargetId = null;
    hideModal(historyDeletePanelEl);
    await renderHistory();
  } catch (err) {
    historyDeleteInfoEl.insertAdjacentHTML('beforeend', `<div style="color:#f14c4c">삭제 중 오류: ${escapeHtml(errMsg(err))}</div>`);
  } finally {
    historyDeleteConfirmBtn.disabled = false;
  }
});

refreshHistoryBtn.addEventListener('click', renderHistory);

document.querySelector('.tab-btn[data-tab="history"]').addEventListener('click', renderHistory);

// ---------------- 작업 탭: 보드(팀장 목록 / 팀원) ----------------

function renderMemberCard(row, leadLabelById) {
  const statusLabel = statusLabelKo(row);
  const preview = formatPreview(row.preview, 100, 220);
  const attachBtn = row.kind === 'background' && row.id
    ? `<button data-attach="${escapeHtml(row.id)}">터미널 열기</button>`
    : '';
  const leadDisplay = row.leadId ? (leadLabelById.get(row.leadId) || row.leadId) : '';
  return `
    <div class="session-card member-card ${statusClass(row)}">
      <div class="top-line">
        <span>${escapeHtml(row.label || row.projectName)}</span>
        ${row.secret ? '<span class="secret-badge" title="시크릿 팀장이 만든 팀원입니다">🔒</span>' : ''}
        <span>${escapeHtml(statusLabel)}</span>
      </div>
      ${row.leadId ? `<div class="member-of">소속 팀장: ${escapeHtml(leadDisplay)}${row.role ? ` · 역할: ${escapeHtml(row.role)}` : ''}</div>` : ''}
      <div class="meta">${escapeHtml(row.cwd)}</div>
      <div class="preview">${preview}</div>
      <div class="actions">
        ${attachBtn}
        <button data-files="${escapeHtml(row.cwd)}">커밋 대상</button>
        <button data-refresh-member="${escapeHtml(row.id)}" title="이 팀원 최신 상태 새로고침">⟳</button>
        <button class="stop-btn" data-stop-member="${escapeHtml(row.id)}" title="이 팀원 세션 종료">삭제</button>
      </div>
    </div>
  `;
}

function renderBoard(rows) {
  lastRows = rows;
  const leads = rows.filter(r => r.isLead);
  const onlineLeads = leads.filter(r => !r.offline);
  const members = rows.filter(r => !r.isLead);
  lastLeadIds = new Set(leads.map(r => r.id)); // 오프라인 포함 — 히스토리에서 골라도 선택 상태가 안 풀리게

  // 3초마다 도는 폴링 갱신이라, 이름표 입력 중에 그대로 다시 그리면 포커스/타이핑이 날아간다 —
  // 편집 중일 땐 이 영역만 건너뛰고 다음 폴링에서 다시 그린다.
  const editingLabel = document.activeElement && document.activeElement.classList.contains('lead-label-input');
  if (!editingLabel) {
    // 오프라인 팀장은 여기서 빼고 "히스토리" 탭에 모아서 보여준다 — 작업 보드가 계속 안 쓰는
    // 예전 팀장으로 지저분해지는 걸 막는다.
    leadRowEl.innerHTML = onlineLeads.length
      ? onlineLeads.map(renderLeadCard).join('')
      : '<div class="empty-hint">지금 띄운 팀장이 없습니다. (예전 팀장은 히스토리 탭에서 이어할 수 있습니다)</div>';

    leadRowEl.querySelectorAll('[data-lead]').forEach(el => {
      el.addEventListener('click', () => selectLead(el.dataset.lead));
    });

    leadRowEl.querySelectorAll('[data-lead-label]').forEach(input => {
      input.addEventListener('click', e => e.stopPropagation());
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
      input.addEventListener('change', async () => {
        try {
          await window.api.updateLeadLabel(input.dataset.leadLabel, input.value);
        } catch (err) {
          console.error('이름표 저장 실패:', err);
        }
      });
    });
  }

  // 선택된 팀장이 없어졌으면(종료됨) 남아있는 첫 팀장으로, 없으면 선택 해제 — 단, reconcileLeadIds가
  // 폴링 중 짧은 id만 조용히 바꾼 경우(이 앱이 관여 안 한 재시작)라면 진짜로 없어진 게 아니라
  // 같은 팀장이 새 id로 살아있는 것이므로, internalId로 찾아서 그 새 id로 조용히 따라간다.
  // 이게 없으면 팀장을 여러 개 띄워둔 상황에서 드리프트가 날 때마다 사용자 모르게 대화창이
  // 엉뚱한(그냥 첫 번째) 팀장으로 튀어버렸다.
  if (selectedLeadId && !lastLeadIds.has(selectedLeadId)) {
    const followed = selectedLeadInternalId && leads.find(l => l.internalId === selectedLeadInternalId);
    selectedLeadId = followed ? followed.id : null;
  }
  if (!selectedLeadId && onlineLeads.length > 0 && formMode === 'none') selectedLeadId = onlineLeads[0].id;
  // 다음 폴링에서도 계속 같은 팀장을 따라갈 수 있게, 지금 선택된 팀장의 internalId로 맞춰둔다 —
  // selectedLeadId를 직접 바꾸는 다른 7군데(selectLead/sendChatMessage/재시작 성공 처리 등)를
  // 전부 따로 고칠 필요 없이 여기 한 곳에서만 동기화하면 된다.
  selectedLeadInternalId = (leads.find(l => l.id === selectedLeadId) || {}).internalId || null;

  // 여기서도 selectedLeadId가 바뀔 수 있어서(자동 선택 등, selectLead()를 안 거침) 매 폴링마다
  // 다시 맞춰준다 — IPC 호출 없이 캐시만 쓰는 가벼운 함수라 3초마다 불러도 부담 없다.
  rebuildMemberTemplateSelect();

  updateLeadSectionVisibility();
  updateMemberSectionVisibility();
  if (selectedLeadId) renderChat();

  renderMemberRow();
}

// 팀장 선택이 바뀔 때(카드 클릭, 자동 선택, 재시작/작업종료 등) 3초 폴링을 기다리지 않고 바로
// 반영되도록 멤버 행 렌더링을 별도 함수로 뺐다 — lastRows는 이미 캐시돼있으니 IPC 없이 즉시
// 다시 그릴 수 있다. 버튼 클릭 리스너는 아래 workTabEl 위임 하나로 처리하므로 여기서 매번
// 새로 안 걸어도 된다(그래서 이 함수를 몇 번을 다시 불러도 리스너가 중복되지 않는다).
function renderMemberRow() {
  const leadLabelById = new Map(lastRows.filter(r => r.isLead).map(l => [l.id, l.label || l.projectName]));
  const members = lastRows.filter(r => !r.isLead);
  // 팀장을 바꿔도 팀원 목록이 그대로 다 보이면, 지금 보는 게 어느 팀장 소속 팀원인지 헷갈린다 —
  // 대화창의 "소속 팀원" chip과 마찬가지로 지금 선택된 팀장의 팀원만 보여준다. "+ 새 팀장"/"터미널
  // 세션 이어가기"처럼 새로 만드는 동작 중(대화창이 설정 폼으로 바뀌는 상태)엔 아직 어느 팀장도
  // "선택"된 게 아니므로 팀원 목록도 같이 비워서, 예전 팀장의 팀원이 계속 보이는 걸 막는다.
  const isCreatingLead = getEffectiveLeadMode() !== 'none';
  const visibleMembers = isCreatingLead ? [] : members.filter(m => m.leadId === selectedLeadId);
  memberRowEl.innerHTML = isCreatingLead
    ? ''
    : visibleMembers.length
      ? visibleMembers.map(row => renderMemberCard(row, leadLabelById)).join('')
      : '<div class="empty-hint">이 팀장 소속의 팀원이 없습니다.</div>';
}

// 팀장/팀원 카드의 액션 버튼들은 폴링·선택 변경마다 innerHTML이 통째로 다시 그려지므로, 매번
// addEventListener를 새로 걸면 예전 리스너가 안 지워진 채 쌓일 위험이 있다 — 그래서 작업 탭
// 전체에 한 번만 위임 리스너를 걸어서 이 문제 자체를 없앤다. capture:true로 걸어서, 팀장 카드
// 자체의 클릭(selectLead) 리스너보다 먼저 처리하고 stopPropagation으로 그쪽을 막을 수 있게 한다.
const workTabEl = document.getElementById('work-tab');
workTabEl.addEventListener('click', async e => {
  const attachBtn = e.target.closest('[data-attach]');
  if (attachBtn) {
    e.stopPropagation();
    try {
      await window.api.openInTerminal(attachBtn.dataset.attach);
    } catch (err) {
      console.error('터미널 열기 실패:', err);
    }
    return;
  }
  const filesBtn = e.target.closest('[data-files]');
  if (filesBtn) {
    e.stopPropagation();
    await showFileList(filesBtn.dataset.files);
    return;
  }
  const refreshBtn = e.target.closest('[data-refresh-member]');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    try {
      await refreshBoardNow();
    } catch (err) {
      console.error('새로고침 실패:', err);
    } finally {
      refreshBtn.disabled = false;
    }
    return;
  }
  const stopBtn = e.target.closest('[data-stop-member]');
  if (stopBtn) {
    stopBtn.disabled = true;
    try {
      await window.api.stopBackgroundSession(stopBtn.dataset.stopMember);
    } catch (err) {
      console.error('팀원 세션 종료 실패:', err);
    } finally {
      await refreshBoardNow();
    }
  }
}, true);

// 3초 폴링을 기다리지 않고 지금 바로 보드를 다시 그린다 — 카드의 새로고침/삭제 버튼에서 쓴다.
async function refreshBoardNow() {
  try {
    const { rows, requests, stallAlerts, unapprovedDirs } = await window.api.refreshBoard();
    renderBoard(rows || []);
    renderRequests(requests || []);
    renderStallAlerts(stallAlerts || []);
    renderUnapprovedDirs(unapprovedDirs || []);
    renderHistory();
    lastUpdatedEl.textContent = `마지막 갱신: ${new Date().toLocaleTimeString('ko-KR')}`;
  } catch (err) {
    console.error('보드 새로고침 실패:', err);
  }
}

// ---------------- 작업 탭: 팀원 직접 추가 ----------------

function updateMemberSectionVisibility() {
  const hasSelectedLead = !!selectedLeadId && getEffectiveLeadMode() === 'none';
  addMemberPanelEl.hidden = !showAddMember;
  addMemberBtn.hidden = showAddMember;
  addMemberBtn.disabled = !hasSelectedLead;
  addMemberBtn.title = hasSelectedLead ? '' : '먼저 위에서 팀장을 선택하세요';
}

addMemberBtn.addEventListener('click', () => {
  if (!selectedLeadId) return;
  showAddMember = true;
  // 디렉토리 선택은 이전에 뭘 골랐든 매번 새로 고르게 한다 — 안 그러면 예전 선택이 그대로 남아있어서
  // (예: 예전에 팀장 자신의 디렉토리에 팀원을 넣었던 기록) 실수로 엉뚱한 곳에 팀원이 뜬다.
  memberCustomPickedDir = null;
  memberNameEl.value = '';
  memberDirSelect.value = '';
  memberTemplateSelect.value = '';
  setRoleValue(memberRoleSelect, memberRoleCustom, '');
  memberInstructionEl.value = '';
  selectedMemberModel = 'default';
  syncAddMemberSubmitBtnState();
  updateMemberSectionVisibility();
});

cancelAddMemberBtn.addEventListener('click', () => {
  showAddMember = false;
  memberNameEl.value = '';
  updateMemberSectionVisibility();
});

memberNameEl.addEventListener('input', () => {
  syncAddMemberSubmitBtnState();
});

memberTemplateSelect.addEventListener('change', async () => {
  if (!memberTemplateSelect.value) return;
  try {
    const templates = await window.api.getMemberTemplates();
    const tpl = templates.find(t => t.id === memberTemplateSelect.value);
    if (!tpl) return;
    setRoleValue(memberRoleSelect, memberRoleCustom, tpl.role);
    memberInstructionEl.value = tpl.instruction;
    selectedMemberModel = tpl.model || 'default';
    if (tpl.path) {
      // 디렉토리가 고정된 템플릿은 그대로 채운다 — 그 경로가 즐겨찾기에 등록 안 돼있으면
      // memberDirSelect 옵션 목록에 아예 없어서 .value 대입이 조용히 실패하니, customDir로
      // 넣어서 옵션에 강제로 포함시킨 뒤 채운다.
      memberCustomPickedDir = tpl.path;
      await renderFavorites(); // 드롭다운을 다시 그려서 tpl.path가 선택 가능한 상태로 만든 뒤
      memberDirSelect.value = tpl.path;
    }
    // 디렉토리가 없는 템플릿은 memberDirSelect를 그대로 두고 사용자가 직접 고르게 한다.
    syncAddMemberSubmitBtnState();
  } catch (err) {
    addMemberStatusEl.textContent = `템플릿을 불러오지 못했습니다: ${errMsg(err)}`;
  }
});

memberDirSelect.addEventListener('change', () => {
  syncAddMemberSubmitBtnState();
});

pickMemberDirBtn.addEventListener('click', async () => {
  try {
    const dir = await window.api.pickDirectory();
    if (dir) {
      memberCustomPickedDir = dir;
      await renderFavorites();
    }
  } catch (err) {
    addMemberStatusEl.textContent = `폴더 선택에 실패했습니다: ${errMsg(err)}`;
  }
});

addMemberSubmitBtn.addEventListener('click', async () => {
  if (!memberDirSelect.value || !selectedLeadId) return;
  // 버튼이 disabled로 막고 있어야 정상이지만(syncAddMemberSubmitBtnState), 혹시 모를 경우를
  // 대비해 실제 제출 직전에도 한 번 더 확인한다 — 이름 없이 팀원이 추가되는 실수를 막는 게
  // 이 검증의 목적이라 이중으로 막아둔다.
  if (!memberNameEl.value.trim()) {
    addMemberStatusEl.textContent = '이 팀원을 구분할 이름을 입력해주세요.';
    return;
  }
  if (!memberInstructionEl.value.trim()) {
    addMemberStatusEl.textContent = '이 팀원에게 줄 지시를 입력해주세요.';
    return;
  }
  addMemberSubmitBtn.disabled = true;
  addMemberStatusEl.textContent = '추가하는 중...';
  try {
    const id = await window.api.launchMember(selectedLeadId, memberDirSelect.value, memberInstructionEl.value.trim(), getRoleValue(memberRoleSelect, memberRoleCustom), memberNameEl.value.trim(), selectedMemberModel);
    if (id) {
      addMemberStatusEl.textContent = `팀원을 추가했습니다(${id}).`;
      memberNameEl.value = '';
      memberInstructionEl.value = '';
      setRoleValue(memberRoleSelect, memberRoleCustom, '');
      memberTemplateSelect.value = '';
      selectedMemberModel = 'default';
      showAddMember = false;
      updateMemberSectionVisibility();
    } else {
      addMemberStatusEl.textContent = '팀원 추가에 실패했습니다 — 터미널을 직접 열어 claude --version, claude --bg가 정상 동작하는지 확인해보세요(CLI 미설치·PATH 문제·로그인 만료가 흔한 원인입니다).';
    }
  } catch (err) {
    addMemberStatusEl.textContent = `팀원 추가 중 오류가 발생했습니다: ${errMsg(err)}`;
  } finally {
    addMemberSubmitBtn.disabled = false;
  }
});

// ---------------- 작업 탭: 승인 대기 ----------------

function renderRequests(requests) {
  if (!requests || requests.length === 0) {
    requestsListEl.innerHTML = '';
    return;
  }
  requestsListEl.innerHTML = requests.map(req => {
    const isStop = req.type === 'stop-member';
    let title;
    if (isStop) {
      // req.memberId는 짧은 세션 id라 사람이 읽고 뭔지 알 수 없다 — 아직 떠있는 팀원이면
      // dirLabel/역할처럼 다른 곳에서 쓰는 것과 같은 방식으로 사람이 읽을 수 있게 바꿔서 보여준다.
      const memberRow = lastRows.find(r => !r.isLead && r.id === req.memberId);
      title = memberRow
        ? `팀원 종료 요청 — ${memberRow.label || dirLabel(memberRow.cwd)}${memberRow.role ? ` (${memberRow.role})` : ''}`
        : `팀원 종료 요청 — ${req.memberId}(이미 종료된 세션이라 상세 정보를 알 수 없음)`;
    } else {
      title = req.requestedDir || '';
    }
    return `
    <div class="request-card">
      <div class="req-dir">${isStop ? '⏹ ' : ''}${escapeHtml(title)}</div>
      <div class="req-reason">${escapeHtml(req.reason)}</div>
      <div class="req-meta">팀장: ${escapeHtml(req.teamLeadId)} · ${new Date(req.createdAt).toLocaleTimeString('ko-KR')}</div>
      <div class="req-actions">
        <button class="approve-btn" data-approve="${escapeHtml(req.id)}" data-team-lead="${escapeHtml(req.teamLeadId)}">승인</button>
        <button class="deny-btn" data-deny="${escapeHtml(req.id)}" data-team-lead="${escapeHtml(req.teamLeadId)}">거부</button>
      </div>
    </div>
  `;
  }).join('');

  // 같은 요청 카드를 승인/거부 버튼 연타로 중복 처리하지 않도록, 클릭 즉시 카드 전체를 비활성화한다.
  async function handleDecision(btn, apiCall) {
    const card = btn.closest('.request-card');
    const leadId = btn.dataset.teamLead;
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    if (leadId) { busyLeadIds.add(leadId); updateBusyUI(); }
    try {
      const result = await apiCall();
      // approve-request/deny-request는 이제 { decided, delivered }를 돌려준다 — decided는 결정
      // 자체가 기록됐는지, delivered는 그 결정을 팀장에게 실제로 전달했는지다. delivered가
      // false면 결정은 기록됐지만 팀장은 아직 모른다는 뜻이라 조용히 넘어가지 않고 알려준다.
      if (result && result.decided && !result.delivered) {
        card.insertAdjacentHTML('beforeend', '<div style="color:#f14c4c">결정은 기록됐지만 팀장에게 전달하지 못했습니다(세션 정지 실패 등) — 팀장이 이 결정을 모르고 있을 수 있습니다.</div>');
      } else if (result && !result.decided) {
        card.insertAdjacentHTML('beforeend', '<div style="color:#f14c4c">요청을 찾지 못해 처리하지 못했습니다.</div>');
      }
    } catch (err) {
      card.insertAdjacentHTML('beforeend', `<div style="color:#f14c4c">처리 중 오류가 발생했습니다: ${escapeHtml(errMsg(err))}</div>`);
    } finally {
      if (leadId) { busyLeadIds.delete(leadId); updateBusyUI(); }
      await refreshBoardNow();
    }
  }

  requestsListEl.querySelectorAll('[data-approve]').forEach(btn => {
    btn.addEventListener('click', () => handleDecision(btn, () => window.api.approveRequest(btn.dataset.approve)));
  });
  requestsListEl.querySelectorAll('[data-deny]').forEach(btn => {
    btn.addEventListener('click', () => handleDecision(btn, () => window.api.denyRequest(btn.dataset.deny)));
  });
  updateBusyUI();
}

// 정체 감시(백그라운드에서 Haiku가 판단)가 만들어낸 알림 — 사용자가 직접 "이어서 진행 지시"를
// 눌러야만 실제로 팀장에게 전달된다(반자동). 팀장/팀원 목록과 별개로 화면 어디서든 눈에 띄게
// 헤더 바로 아래에 띄운다.
function renderStallAlerts(alerts) {
  if (!alerts || alerts.length === 0) {
    stallAlertsListEl.innerHTML = '';
    return;
  }
  stallAlertsListEl.innerHTML = alerts.map(a => `
    <div class="stall-alert-card">
      <div class="stall-alert-title">⏸ 팀원 ${escapeHtml(a.memberId)}가 방치된 것 같습니다</div>
      <div class="stall-alert-reason">${escapeHtml(a.reason || '')}</div>
      <div class="stall-alert-meta">${new Date(a.createdAt).toLocaleTimeString('ko-KR')}</div>
      <div class="stall-alert-actions">
        <button class="stall-confirm-btn" data-confirm-stall="${escapeHtml(a.id)}">이어서 진행 지시</button>
        <button class="stall-dismiss-btn" data-dismiss-stall="${escapeHtml(a.id)}">무시</button>
      </div>
    </div>
  `).join('');

  async function handleStallDecision(btn, apiCall) {
    const card = btn.closest('.stall-alert-card');
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      await apiCall();
    } catch (err) {
      // 다른 곳(renderRequests 등)의 하드코딩된 #f14c4c는 다크모드 기준값이라 라이트모드에서
      // 대비가 떨어지는 기존 버그가 있다 — 새로 추가하는 이 카드는 처음부터 테마 토큰을 쓴다.
      card.insertAdjacentHTML('beforeend', `<div style="color:var(--danger)">처리 중 오류가 발생했습니다: ${escapeHtml(errMsg(err))}</div>`);
      card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      return;
    }
    await refreshBoardNow();
  }

  stallAlertsListEl.querySelectorAll('[data-confirm-stall]').forEach(btn => {
    btn.addEventListener('click', () => handleStallDecision(btn, () => window.api.confirmStallAlert(btn.dataset.confirmStall)));
  });
  stallAlertsListEl.querySelectorAll('[data-dismiss-stall]').forEach(btn => {
    btn.addEventListener('click', () => handleStallDecision(btn, () => window.api.dismissStallAlert(btn.dataset.dismissStall)));
  });
}

// claude CLI가 새 디렉토리에서 처음 뜰 때 요구하는 워크스페이스 신뢰/CLAUDE.md include 승인은
// headless(--bg) 세션이 절대 대신 클릭해줄 수 없다(아무도 답 못 해서 "시작 단계 다이얼로그에
// 멈춘 채" 영구 대기하게 된다, main.ts의 checkDirectoryClaudeReady 주석 참고) — 그래서 팀장/팀원
// 디렉토리 중 이 승인이 안 된 곳을 여기서 눈에 띄게 보여주고, "터미널에서 승인하기"를 누르면
// open-in-terminal과 같은 방식으로 그 디렉토리에서 claude를 인터랙티브로 새 창에 띄워서 사용자가
// 그 자리에서 바로 다이얼로그를 눌러 넘길 수 있게 한다.
function renderUnapprovedDirs(items) {
  if (!items || items.length === 0) {
    unapprovedDirListEl.innerHTML = '';
    return;
  }
  unapprovedDirListEl.innerHTML = items.map(u => `
    <div class="stall-alert-card">
      <div class="stall-alert-title">⚠ 최초 실행 승인이 안 된 디렉토리</div>
      <div class="stall-alert-reason">${escapeHtml(u.dir)} — ${escapeHtml(u.reason)}</div>
      <div class="stall-alert-actions">
        <button class="stall-confirm-btn" data-approve-dir="${escapeHtml(u.dir)}">터미널에서 승인하기</button>
      </div>
    </div>
  `).join('');

  unapprovedDirListEl.querySelectorAll('[data-approve-dir]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await window.api.openTerminalForApproval(btn.dataset.approveDir);
      } catch (err) {
        console.error('승인용 터미널 열기 실패:', err);
      } finally {
        // 승인 여부는 다음 폴링이 자동으로 다시 확인해서 목록에서 빼주므로, 여기서 직접 지우지
        // 않는다 — 사용자가 터미널에서 실제로 승인을 눌러야만 없어져야 한다.
        btn.disabled = false;
      }
    });
  });
}

window.api.onAgentsUpdate(({ rows, requests, stallAlerts, unapprovedDirs }) => {
  renderBoard(rows || []);
  renderRequests(requests || []);
  renderStallAlerts(stallAlerts || []);
  renderUnapprovedDirs(unapprovedDirs || []);
  // 히스토리 탭은 원래 탭을 클릭하거나 새로고침 버튼을 눌러야만 다시 그려졌다 — 앱을 껐다 켠
  // 직후 이미 죽어있던 팀장이 "아직 오프라인 확정 전" 상태로 잠깐 안 보이다가(콜드 스타트 유예,
  // computeOfflineLeads 참고) 뒤늦게 오프라인으로 확정돼도, 탭을 벗어났다 다시 들어오지 않는 한
  // 화면이 그 변화를 반영하지 못했다(실사용 재현: 팀장이 작업 탭에도 히스토리 탭에도 안 보여서
  // 세션 ID를 직접 찾아 수동으로 이어야 했음). 카드 자체엔 입력창처럼 보존해야 할 상태가 없어서
  // (renderRequests/renderStallAlerts와 마찬가지로) 매 폴링마다 다시 그려도 안전하다.
  renderHistory();
  lastUpdatedEl.textContent = `마지막 갱신: ${new Date().toLocaleTimeString('ko-KR')}`;
});

// ---------------- 설정 탭 ①: 팀장 디렉토리 + 작업 탭 드롭다운 연동 ----------------

async function renderFavorites() {
  let favs;
  try {
    favs = await window.api.getFavorites();
  } catch (err) {
    favoritesListEl.innerHTML = `<div class="empty-hint">디렉토리 목록을 불러오지 못했습니다: ${escapeHtml(errMsg(err))}</div>`;
    return;
  }

  favoritesListEl.innerHTML = favs.length ? favs.map(f => `
    <div class="fav-item">
      <div class="fav-lines">
        <input class="fav-name" data-name="${escapeHtml(f.path)}" value="${escapeHtml(f.name)}" />
        <div class="fav-path">${escapeHtml(f.path)}</div>
      </div>
      <span class="remove" data-remove="${escapeHtml(f.path)}">×</span>
    </div>
  `).join('') : '<div class="empty-hint">등록된 디렉토리가 없습니다.</div>';

  favoritesListEl.querySelectorAll('[data-remove]').forEach(el => {
    el.addEventListener('click', async () => {
      try {
        await window.api.removeFavorite(el.dataset.remove);
      } catch (err) {
        console.error('디렉토리 삭제 실패:', err);
      } finally {
        await renderFavorites();
      }
    });
  });
  favoritesListEl.querySelectorAll('[data-name]').forEach(input => {
    input.addEventListener('change', async () => {
      try {
        await window.api.updateFavoriteName(input.dataset.name, input.value);
      } catch (err) {
        console.error('디렉토리 이름 변경 실패:', err);
      } finally {
        await renderFavorites();
      }
    });
  });

  setSelectValuePreserving(targetDirSelect, buildDirOptionsHtml(favs, customPickedDir, '-- 등록된 디렉토리에서 선택 --'), customPickedDir);
  syncLaunchBtnState();

  setSelectValuePreserving(memberDirSelect, buildDirOptionsHtml(favs, memberCustomPickedDir, '-- 등록된 디렉토리에서 선택 --'), memberCustomPickedDir);
  syncAddMemberSubmitBtnState();

  setSelectValuePreserving(manualSessionDirSelect, buildDirOptionsHtml(favs, manualSessionCustomPickedDir, '-- 등록된 디렉토리에서 선택 --'), manualSessionCustomPickedDir);
  syncManualSessionResumeBtnState();

  setSelectValuePreserving(newTplDirSelect, buildDirOptionsHtml(favs, tplCustomPickedDir, '-- 이 팀원이 일할 디렉토리 선택 (비워도 됨) --'), tplCustomPickedDir);

  // "소속" — 공통(모든 팀장) 또는 등록된 팀장 디렉토리 중 하나(그 팀장 전용). 디렉토리(위 선택)와는
  // 독립적인 축이라 별도 목록으로 관리한다.
  const scopeOptions = ['<option value="shared">공통 (모든 팀장 사용 가능)</option>']
    .concat(favs.map(f => `<option value="${escapeHtml(f.path)}">${escapeHtml(f.name)} 팀장 전용</option>`))
    .join('');
  setSelectValuePreserving(newTplScopeSelect, scopeOptions, newTplScopeSelect.value);
}
renderFavorites();

targetDirSelect.addEventListener('change', () => {
  syncLaunchBtnState();
});

pickDirBtn.addEventListener('click', async () => {
  try {
    const dir = await window.api.pickDirectory();
    if (dir) {
      customPickedDir = dir;
      await renderFavorites();
    }
  } catch (err) {
    launchStatusEl.textContent = `폴더 선택에 실패했습니다: ${errMsg(err)}`;
  }
});

browseFavBtn.addEventListener('click', async () => {
  try {
    const dir = await window.api.pickDirectory();
    if (dir) newFavDirInput.value = dir;
  } catch (err) {
    console.error('폴더 선택 실패:', err);
  }
});

favAddBtn.addEventListener('click', async () => {
  if (!newFavDirInput.value) return;
  try {
    await window.api.addFavorite(newFavDirInput.value);
    newFavDirInput.value = '';
  } catch (err) {
    console.error('디렉토리 등록 실패:', err);
  } finally {
    await renderFavorites();
  }
});

launchBtn.addEventListener('click', async () => {
  if (!targetDirSelect.value) return;
  launchBtn.disabled = true;
  launchStatusEl.textContent = '띄우는 중...';
  try {
    const id = await window.api.launchTeamLead(targetDirSelect.value, instructionEl.value, launchSecretToggle.checked);
    if (id) {
      launchStatusEl.textContent = `팀장 세션(${id})을 시작했습니다.`;
      formMode = 'none';
      selectedLeadId = id;
      launchSecretToggle.checked = false; // 다음 팀장은 기본값(일반 모드)에서 다시 시작 — 매번 실수로 켜져 있으면 안 됨
      renderMemberRow(); // 새 팀장이라 소속 팀원이 없을 테니, 폴링 안 기다리고 바로 비워서 보여준다
    } else {
      launchStatusEl.textContent = '팀장 세션 시작에 실패했습니다 — 터미널을 직접 열어 claude --version, claude --bg가 정상 동작하는지 확인해보세요(CLI 미설치·PATH 문제·로그인 만료가 흔한 원인입니다).';
    }
  } catch (err) {
    launchStatusEl.textContent = `팀장 세션 시작 중 오류가 발생했습니다: ${errMsg(err)}`;
  } finally {
    launchBtn.disabled = false;
  }
});

// ---------------- 설정 탭 ②: 팀원 등록(역할 템플릿) ----------------

const MEMBER_MODEL_LABELS = { default: '기본 모델', haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

function renderTemplateCard(t, favNameByPath) {
  const dirLine = t.path
    ? `<div class="tpl-path">${escapeHtml(favNameByPath.get(t.path) || t.path)}</div>`
    : '<div class="tpl-path">(쓸 때마다 대상 디렉토리를 고름)</div>';
  const model = t.model || 'default';
  const modelSelect = `
    <select class="tpl-model" data-model="${escapeHtml(t.id)}" title="이 역할을 띄울 때 쓸 모델">
      ${Object.entries(MEMBER_MODEL_LABELS).map(([value, label]) =>
        `<option value="${value}" ${value === model ? 'selected' : ''}>${label}</option>`).join('')}
    </select>`;
  return `
    <div class="template-card ${t.approved ? 'approved' : ''}">
      <div class="tpl-top">
        <input class="tpl-name" data-name="${escapeHtml(t.id)}" value="${escapeHtml(t.name)}" />
        <input class="tpl-role" value="${escapeHtml(t.role)}" placeholder="역할" readonly title="등록 후에는 역할을 바꿀 수 없습니다 — 새로 등록해주세요" />
        ${modelSelect}
        <span class="remove" data-remove-tpl="${escapeHtml(t.id)}">×</span>
      </div>
      ${dirLine}
      <div class="readonly-hint">🔒 등록 후에는 역할·아래 지시를 수정할 수 없습니다 — 바꾸려면 새로 등록하세요</div>
      <textarea class="tpl-instruction" rows="2" readonly title="등록 후에는 기본 지시를 바꿀 수 없습니다 — 새로 등록해주세요">${escapeHtml(t.instruction)}</textarea>
      ${t.path ? `
      <div class="tpl-bottom">
        <label class="tpl-approved-label">
          <input type="checkbox" data-approve-tpl="${escapeHtml(t.id)}" ${t.approved ? 'checked' : ''} />
          사전승인 (소속 팀장에게 자동 안내)
        </label>
      </div>` : ''}
    </div>
  `;
}

function renderTplGroup(title, list, favNameByPath) {
  return `
    <div class="tpl-group">
      <div class="tpl-group-title">${escapeHtml(title)}</div>
      ${list.map(t => renderTemplateCard(t, favNameByPath)).join('')}
    </div>
  `;
}

// "소속"(공통 또는 특정 팀장 전용)으로 그룹을 묶어서 보여준다 — 어느 팀장이 쓸 수 있는 팀원인지
// 한눈에 구분되게. 팀원 자신이 일할 디렉토리(path)는 카드 안에 별도로 표시한다.
//
// 작업 탭 드롭다운(memberTemplateSelect)은 "지금 선택된 팀장"에 따라 필터링되는데, selectedLeadId는
// 팀장을 새로 띄우거나 카드를 클릭하거나 폴링으로 자동 선택되는 등 여러 경로로 바뀐다 — 그때마다
// 매번 이 무거운 함수(IPC 두 번 호출) 전체를 다시 부르는 대신, 마지막으로 불러온 템플릿 목록을
// 캐싱해두고 드롭다운만 즉시(동기적으로) 다시 그리는 rebuildMemberTemplateSelect를 따로 둔다.
let cachedTemplates = [];
let cachedFavNameByPath = new Map();

function rebuildMemberTemplateSelect() {
  const shared = cachedTemplates.filter(t => !t.scope || t.scope === 'shared');
  const byLead = new Map();
  cachedTemplates.filter(t => t.scope && t.scope !== 'shared').forEach(t => {
    if (!byLead.has(t.scope)) byLead.set(t.scope, []);
    byLead.get(t.scope).push(t);
  });

  const currentLeadDir = lastRows.find(r => r.isLead && r.id === selectedLeadId)?.cwd;
  const tplOption = t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.role ? ` (${escapeHtml(t.role)})` : ''}</option>`;
  const optgroups = [];
  if (shared.length) optgroups.push(`<optgroup label="공통">${shared.map(tplOption).join('')}</optgroup>`);
  [...byLead.entries()].forEach(([leadDir, list]) => {
    if (leadDir !== currentLeadDir) return;
    optgroups.push(`<optgroup label="${escapeHtml(cachedFavNameByPath.get(leadDir) || dirLabel(leadDir))} 팀장 전용">${list.map(tplOption).join('')}</optgroup>`);
  });
  // 3초 폴링마다 이 함수가 다시 불릴 수 있어서, innerHTML을 그냥 덮어쓰면 사용자가 방금 고른 값이
  // 매번 초기화돼버린다 — 다른 select들과 같은 패턴으로 지금 선택값을 보존한다.
  setSelectValuePreserving(
    memberTemplateSelect,
    `<option value="">-- 등록된 팀원 템플릿에서 불러오기 (선택) --</option>${optgroups.join('')}`,
    memberTemplateSelect.value,
  );
}

async function renderMemberTemplates() {
  let templates, favs;
  try {
    [templates, favs] = await Promise.all([window.api.getMemberTemplates(), window.api.getFavorites()]);
  } catch (err) {
    memberTemplatesListEl.innerHTML = `<div class="empty-hint">팀원 템플릿을 불러오지 못했습니다: ${escapeHtml(errMsg(err))}</div>`;
    return;
  }
  const favNameByPath = new Map(favs.map(f => [f.path, f.name]));
  cachedTemplates = templates;
  cachedFavNameByPath = favNameByPath;

  const shared = templates.filter(t => !t.scope || t.scope === 'shared');
  const byLead = new Map();
  templates.filter(t => t.scope && t.scope !== 'shared').forEach(t => {
    if (!byLead.has(t.scope)) byLead.set(t.scope, []);
    byLead.get(t.scope).push(t);
  });

  const groups = [];
  if (shared.length) groups.push(renderTplGroup('공통 (모든 팀장 사용 가능)', shared, favNameByPath));
  [...byLead.entries()].forEach(([leadDir, list]) => {
    groups.push(renderTplGroup(`${favNameByPath.get(leadDir) || dirLabel(leadDir)} 팀장 전용`, list, favNameByPath));
  });

  memberTemplatesListEl.innerHTML = groups.length ? groups.join('') : '<div class="empty-hint">등록된 팀원이 없습니다.</div>';

  memberTemplatesListEl.querySelectorAll('[data-name]').forEach(el => {
    el.addEventListener('change', async () => {
      try {
        await window.api.updateMemberTemplate(el.dataset.name, { name: el.value });
      } catch (err) {
        console.error('템플릿 이름 변경 실패:', err);
      } finally {
        await renderMemberTemplates();
      }
    });
  });
  memberTemplatesListEl.querySelectorAll('[data-model]').forEach(el => {
    el.addEventListener('change', async () => {
      try {
        await window.api.updateMemberTemplate(el.dataset.model, { model: el.value });
      } catch (err) {
        console.error('템플릿 모델 변경 실패:', err);
      } finally {
        await renderMemberTemplates();
      }
    });
  });
  memberTemplatesListEl.querySelectorAll('[data-approve-tpl]').forEach(el => {
    el.addEventListener('change', async () => {
      try {
        await window.api.toggleMemberTemplateApproved(el.dataset.approveTpl);
      } catch (err) {
        console.error('사전승인 토글 실패:', err);
      } finally {
        await renderMemberTemplates();
      }
    });
  });
  memberTemplatesListEl.querySelectorAll('[data-remove-tpl]').forEach(el => {
    el.addEventListener('click', async () => {
      try {
        await window.api.deleteMemberTemplate(el.dataset.removeTpl);
      } catch (err) {
        console.error('템플릿 삭제 실패:', err);
      } finally {
        await renderMemberTemplates();
      }
    });
  });

  // 작업 탭의 "등록된 팀원 템플릿에서 불러오기" 드롭다운도 같이 갱신 — 지금 선택된 팀장 전용
  // 템플릿 중 "다른 팀장 전용"인 건 빼고, 공통 + 이 팀장 전용만 보여준다.
  rebuildMemberTemplateSelect();
}
renderMemberTemplates();

pickTplDirBtn.addEventListener('click', async () => {
  try {
    const dir = await window.api.pickDirectory();
    if (dir) {
      tplCustomPickedDir = dir;
      await renderFavorites();
    }
  } catch (err) {
    console.error('폴더 선택 실패:', err);
  }
});

tplAddBtn.addEventListener('click', async () => {
  const scope = newTplScopeSelect.value || 'shared';
  try {
    await window.api.addMemberTemplate(scope, newTplDirSelect.value, newTplName.value.trim(), getRoleValue(newTplRoleSelect, newTplRoleCustom), newTplInstruction.value.trim(), newTplModelSelect.value);
    newTplName.value = '';
    setRoleValue(newTplRoleSelect, newTplRoleCustom, '');
    newTplInstruction.value = '';
    newTplDirSelect.value = '';
    newTplScopeSelect.value = 'shared';
    newTplModelSelect.value = 'default';
    tplCustomPickedDir = null;
  } catch (err) {
    console.error('팀원 템플릿 등록 실패:', err);
  } finally {
    await renderFavorites();
    await renderMemberTemplates();
  }
});

updateLeadSectionVisibility();
updateMemberSectionVisibility();
