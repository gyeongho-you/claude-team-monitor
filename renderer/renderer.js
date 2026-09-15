// --- 다크/라이트 테마 ---
// localStorage는 뷰어(이 창)별로 따로 노는 값이라 여러 사용자 간 공유될 일이 없고, 그냥 "이 PC의
// 이 앱 창은 어떤 테마로 보고 싶은지"라는 순수 UI 취향이라 딱 맞는 용도다.
const THEME_KEY = 'claude-team-monitor-theme';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
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
const endWorkBtn = document.getElementById('end-work-btn');
const endWorkPanelEl = document.getElementById('end-work-panel');
const endWorkConfirmBtn = document.getElementById('end-work-confirm-btn');
const endWorkCancelBtn = document.getElementById('end-work-cancel-btn');
const endWorkStatusEl = document.getElementById('end-work-status');
const modalBackdropEl = document.getElementById('modal-backdrop');
const fileListPanelEl = document.getElementById('file-list-panel');
const fileListCloseBtn = document.getElementById('file-list-close-btn');
const fileListContentEl = document.getElementById('file-list-content');
const ALL_MODAL_PANELS = () => [restartLeadPanelEl, endWorkPanelEl, fileListPanelEl];

// "새 작업 시작"/"작업 종료"/"변경 파일" 같은 확인창·상세창은 대화창 아래쪽에 인라인으로 뜨면
// 스크롤 밖이라 눈에 안 띄어서(사용자 피드백), 화면 가운데 팝업(모달)으로 띄운다 — 배경을
// 어둡게 깔고 그 위에 패널을 얹는다.
function showModal(panelEl) {
  panelEl.hidden = false;
  modalBackdropEl.hidden = false;
}

function hideModal(panelEl) {
  panelEl.hidden = true;
  if (ALL_MODAL_PANELS().every(p => p.hidden)) modalBackdropEl.hidden = true;
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
const lastUpdatedEl = document.getElementById('last-updated');

const historyListEl = document.getElementById('history-list');
const refreshHistoryBtn = document.getElementById('refresh-history-btn');
let lastRows = [];

const addMemberBtn = document.getElementById('add-member-btn');
const addMemberPanelEl = document.getElementById('add-member-panel');
const memberTemplateSelect = document.getElementById('member-template-select');
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
const launchBtn = document.getElementById('launch-btn');
const launchStatusEl = document.getElementById('launch-status');

const adoptableSelect = document.getElementById('adoptable-select');
const refreshAdoptableBtn = document.getElementById('refresh-adoptable-btn');
const adoptBtn = document.getElementById('adopt-btn');
const adoptStatusEl = document.getElementById('adopt-status');
let adoptableEntriesByValue = new Map(); // 드롭다운 value -> {kind:'background', id} | {kind:'interactive', sessionId, cwd}

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
const newTplRoleCustom = document.getElementById('new-tpl-role-custom');
const newTplInstruction = document.getElementById('new-tpl-instruction');
const tplAddBtn = document.getElementById('tpl-add-btn');
const memberTemplatesListEl = document.getElementById('member-templates-list');

let customPickedDir = null;       // 등록 안 된, 방금 고른 1회성 디렉토리(팀장 대상)
let memberCustomPickedDir = null; // 등록 안 된, 방금 고른 1회성 디렉토리(직접 추가 팀원 대상)
let tplCustomPickedDir = null;    // 등록 안 된, 방금 고른 1회성 디렉토리(팀원 등록 대상)
let selectedLeadId = null;  // 지금 대화창에 띄운 팀장
let formMode = 'none';      // 'none' | 'launch' | 'adopt'
let showAddMember = false;
let lastLeadIds = new Set();
// 지금 메인 프로세스에서 stop/resume류 작업(채팅 전송/요청 승인·거부/재시작)이 진행 중인 leadId 모음 —
// 같은 팀장에 여러 조작이 겹치면 세션이 갈라질 수 있어서(main.ts의 leadId 큐 참고), 진행 중엔 관련
// 버튼을 비활성화해 사용자가 겹쳐서 누르는 걸 막는다.
const busyLeadIds = new Set();
// 팀장이 busy라 곧바로 stop→resume하지 못하고 큐에 쌓아둔(main.ts send-to-lead 참고) 메시지 원문 —
// leadId당 하나씩만 기억한다. renderChat()이 폴링마다 이 안내를 대화창 맨 아래에 다시 붙여줘서,
// 무한정 응답을 기다리는 것처럼 보이지 않게 한다. 실제로 전달돼서 트랜스크립트에 같은 프롬프트가
// 나타나면 renderChat()이 알아서 지운다.
const queuedChatMessages = new Map();

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

function statusClass(row) {
  if (row.offline) return 'status-offline';
  const s = row.state === 'done' ? 'done' : (row.status || row.state || '').toLowerCase();
  if (['idle', 'busy', 'blocked', 'done'].includes(s)) return `status-${s}`;
  return '';
}

function statusLabelKo(row) {
  if (row.offline) return '오프라인';
  const s = row.state === 'done' ? 'done' : (row.status || row.state || '').toLowerCase();
  if (s === 'busy') return '● 작업 중';
  if (s === 'blocked') return '⚠ 확인 필요';
  if (s === 'done') return '완료';
  if (s === 'idle') return '대기 중';
  return '알수없음';
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dirLabel(dir) {
  return dir.split(/[\\/]/).pop();
}

// window.api.* 호출이 실패했을 때(메인 프로세스 예외 등) 화면에 보여줄 메시지를 뽑아낸다.
function errMsg(err) {
  return (err && err.message) ? err.message : String(err);
}

// 지금 선택된 팀장 카드 관련 버튼(전송/재시작)과, 요청 목록에서 같은 팀장에 걸린 승인/거부 버튼을
// busyLeadIds 상태에 맞춰 켜고 끈다 — 폴링으로 화면이 다시 그려져도 매번 다시 적용해야 한다.
function updateBusyUI() {
  const selectedBusy = !!selectedLeadId && busyLeadIds.has(selectedLeadId);
  chatSendBtn.disabled = selectedBusy;
  restartLeadBtn.disabled = selectedBusy;
  endWorkBtn.disabled = selectedBusy;
  document.querySelectorAll('[data-team-lead]').forEach(btn => {
    if (busyLeadIds.has(btn.dataset.teamLead)) btn.disabled = true;
  });
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
  return lastRows.some(r => !r.isLead && r.leadId === leadId && (r.status || r.state || '').toLowerCase() === 'busy');
}

function renderLeadCard(row) {
  const ownStatus = row.offline ? '' : (row.state === 'done' ? 'done' : (row.status || row.state || '').toLowerCase());
  const waitingOnMember = !row.offline && (ownStatus === 'idle' || ownStatus === 'done') && hasBusyMember(row.id);
  const statusLabel = waitingOnMember ? '⏳ 팀원 작업 대기중' : statusLabelKo(row);
  const cardStatusClass = waitingOnMember ? 'status-busy' : statusClass(row);
  const selected = row.id === selectedLeadId ? 'selected' : '';
  return `
    <div class="session-card lead-card ${cardStatusClass} ${selected}" data-lead="${escapeHtml(row.id)}">
      <div class="top-line">
        <input class="lead-label-input" data-lead-label="${escapeHtml(row.id)}" value="${escapeHtml(row.label || '')}" placeholder="${escapeHtml(row.projectName)}" />
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

// 팀장이 팀원 보고를 요약해서 최종 답변에 적어줘도 "그래서 뭐가 바뀌었는데?"는 여전히 안 보인다 —
// 굳이 팀원 카드까지 내려가서 찾지 않아도, 팀장 대화창 바로 위에서 소속 팀원별 변경 파일을 바로
// 열어볼 수 있게 한다(터미널 열기처럼 원본을 다 보여주는 게 아니라, 훑어보기 용도로 가볍게).
function renderLeadMemberChips() {
  if (!selectedLeadId) { leadMembersChipsEl.innerHTML = ''; return; }
  const members = lastRows.filter(r => !r.isLead && r.leadId === selectedLeadId);
  leadMembersChipsEl.innerHTML = members.length
    ? members.map(m => `
        <button class="member-chip" data-files="${escapeHtml(m.cwd)}">
          ${escapeHtml(dirLabel(m.cwd))}${m.role ? ` · ${escapeHtml(m.role)}` : ''} — 커밋 대상
        </button>
      `).join('')
    : '';
}

// 위 chip은 renderChat()이 돌 때마다(폴링 포함) innerHTML이 통째로 새로 그려지므로, 개별
// addEventListener 대신 부모에 한 번만 위임 리스너를 건다.
leadMembersChipsEl.addEventListener('click', e => {
  const btn = e.target.closest('[data-files]');
  if (btn) showFileList(btn.dataset.files);
});

async function renderChat() {
  renderLeadMemberChips();
  if (!selectedLeadId) {
    chatTranscriptEl.innerHTML = ''; // 선택이 풀렸는데 예전 대화가 그대로 남아있으면 안 된다
    return;
  }
  let transcript;
  try {
    transcript = await window.api.getLeadTranscript(selectedLeadId);
  } catch (err) {
    chatTranscriptEl.innerHTML = `<p style="color:#f14c4c">대화 기록을 불러오지 못했습니다: ${escapeHtml(errMsg(err))}</p>`;
    return;
  }

  // 대기열에 넣어둔 메시지가 실제로 전달됐는지 확인한다 — resumeLead는 메시지를 가공 없이 그대로
  // 프롬프트로 쓰므로, 트랜스크립트에 똑같은 prompt가 나타나면 전달된 것으로 판단할 수 있다.
  const queuedForThisLead = queuedChatMessages.get(selectedLeadId);
  if (queuedForThisLead && transcript.some(t => t.prompt === queuedForThisLead)) {
    queuedChatMessages.delete(selectedLeadId);
  }

  const row = lastRows.find(r => r.isLead && r.id === selectedLeadId);
  const ownStatus = row && !row.offline ? (row.status || row.state || '').toLowerCase() : '';
  const isBusy = ownStatus === 'busy';
  const waitingOnMember = !isBusy && !!row && (ownStatus === 'idle' || ownStatus === 'done') && hasBusyMember(row.id);
  const busyBanner = isBusy
    ? '<div class="chat-working">● 작업 중...</div>'
    : waitingOnMember
      ? '<div class="chat-working">⏳ 팀원 작업 대기중...</div>'
      : '';

  const stillQueued = queuedChatMessages.get(selectedLeadId);
  const queuedTurnHtml = stillQueued ? `
    <div class="chat-turn">
      <div class="chat-prompt">▸ ${escapeHtml(stillQueued)}</div>
      <div class="chat-answer chat-pending">팀장이 작업 중이라 메시지를 대기열에 넣었습니다 — 완료되면 자동으로 전달됩니다.</div>
    </div>
  ` : '';

  // 3초마다 도는 폴링 갱신마다 무조건 맨 아래로 스크롤하면, 옛날 대화를 읽으려고 위로 스크롤해둔 걸
  // 계속 끌어내린다 — 이미 맨 아래 근처에 있을 때만("계속 따라가기") 다시 맨 아래로 붙인다.
  const wasNearBottom = chatTranscriptEl.scrollHeight - chatTranscriptEl.scrollTop - chatTranscriptEl.clientHeight < 40;

  if (!transcript || transcript.length === 0) {
    chatTranscriptEl.innerHTML = '<p style="color:#777">아직 대화 기록이 없습니다 (첫 응답을 기다리는 중일 수 있습니다).</p>' + queuedTurnHtml + busyBanner;
  } else {
    chatTranscriptEl.innerHTML = transcript.map(t => `
      <div class="chat-turn">
        <div class="chat-time">${escapeHtml(t.time)}</div>
        <div class="chat-prompt">▸ ${escapeHtml(cleanPrompt(t.prompt))}</div>
        <div class="chat-answer">${escapeHtml(t.answer)}</div>
      </div>
    `).join('') + queuedTurnHtml + busyBanner;
  }
  if (wasNearBottom) chatTranscriptEl.scrollTop = chatTranscriptEl.scrollHeight;
  updateBusyUI();
}

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

adoptLeadBtn.addEventListener('click', () => {
  formMode = 'adopt';
  updateLeadSectionVisibility();
  renderAdoptableSessions();
});

cancelAdoptBtn.addEventListener('click', () => {
  formMode = 'none';
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

  // 응답이 올 때까지(길게는 수십 초) 방금 보낸 메시지가 화면에 전혀 안 보이면 전송이 안 된 것처럼
  // 보인다 — 실제 응답이 오기 전까지 낙관적으로 먼저 채팅창에 얹어서 보여준다. 응답이 오면
  // renderChat()이 서버 기록 기준으로 다시 그리면서 이 임시 말풍선을 자연스럽게 대체한다.
  const wasNearBottom = chatTranscriptEl.scrollHeight - chatTranscriptEl.scrollTop - chatTranscriptEl.clientHeight < 40;
  const optimisticTurn = document.createElement('div');
  optimisticTurn.className = 'chat-turn';
  optimisticTurn.innerHTML = `
    <div class="chat-time">${escapeHtml(new Date().toLocaleTimeString('ko-KR'))}</div>
    <div class="chat-prompt">▸ ${escapeHtml(message)}</div>
    <div class="chat-answer chat-pending">응답을 기다리는 중...</div>
  `;
  chatTranscriptEl.appendChild(optimisticTurn);
  if (wasNearBottom) chatTranscriptEl.scrollTop = chatTranscriptEl.scrollHeight;

  try {
    const result = await window.api.sendToLead(leadId, message);
    if (!result || result.status === 'not-found') {
      // 오프라인 팀장을 이어하려다 실패한 경우(세션 만료 등) 여기서 걸린다 — 조용히 넘어가지 않는다.
      optimisticTurn.remove();
      chatTranscriptEl.insertAdjacentHTML('beforeend', '<p style="color:#f14c4c">이어하기에 실패했습니다 — 세션이 만료됐거나 claude CLI 실행에 문제가 있을 수 있습니다.</p>');
      return;
    }
    if (result.status === 'queued') {
      // 팀장이 지금 작업 중이면 claude CLI 자체에 실행 중인 세션에 끼어들어 입력만 추가하는 기능이
      // 없어서(claude --help 확인) stop→resume으로 끊는 수밖에 없다 — main.ts가 끊지 않고 큐에
      // 담아뒀다가 팀장이 idle/blocked가 되면 자동으로 전달한다. 그때까지 무한정 기다리는 것처럼
      // 보이지 않도록 안내로 바꾸고, queuedChatMessages에 기억해서 renderChat이 폴링마다 계속
      // 보여주게 한다(전달되면 자동으로 사라짐).
      queuedChatMessages.set(leadId, message);
      const answerEl = optimisticTurn.querySelector('.chat-answer');
      if (answerEl) answerEl.textContent = '팀장이 작업 중이라 메시지를 대기열에 넣었습니다 — 완료되면 자동으로 전달됩니다.';
      return;
    }
    // resumeLead가 다른 짧은 id로 깨어날 수 있다(main.ts resumeLead 주석 참고) — 반영하지 않으면
    // 대화창 선택이 풀려서 방금 보낸 대화가 사라진 것처럼 보인다.
    selectedLeadId = result.id;
    await renderChat();
  } catch (err) {
    optimisticTurn.remove();
    chatTranscriptEl.insertAdjacentHTML('beforeend', `<p style="color:#f14c4c">이어하기 중 오류가 발생했습니다: ${escapeHtml(errMsg(err))}</p>`);
  } finally {
    busyLeadIds.delete(leadId);
    updateBusyUI();
  }
}

restartLeadBtn.addEventListener('click', () => {
  showModal(restartLeadPanelEl);
  restartInstructionEl.value = '';
  restartStatusEl.textContent = '';
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
    const id = await window.api.restartLead(leadId, restartInstructionEl.value.trim());
    if (id) {
      selectedLeadId = id;
      hideModal(restartLeadPanelEl);
      restartStatusEl.textContent = '';
      await renderChat();
      renderMemberRow(); // 새 세션이라 소속 팀원이 없을 테니, 폴링 안 기다리고 바로 비워서 보여준다
    } else {
      restartStatusEl.textContent = '새 세션 시작에 실패했습니다.';
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
    const ok = await window.api.endLeadWork(leadId);
    if (ok) {
      hideModal(endWorkPanelEl);
      endWorkStatusEl.textContent = '';
      await refreshBoardNow();
    } else {
      endWorkStatusEl.textContent = '작업 종료에 실패했습니다.';
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
  adoptBtn.disabled = true;
  adoptStatusEl.textContent = adoptableEntriesByValue.size === 0
    ? '연결할 수 있는 세션이 없습니다.'
    : '';
}

refreshAdoptableBtn.addEventListener('click', renderAdoptableSessions);

adoptableSelect.addEventListener('change', () => {
  adoptBtn.disabled = !adoptableSelect.value;
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

// ---------------- 세션 정리 탭 ----------------

function tagLabel(tag) {
  return tag === 'lead' ? '팀장' : tag === 'member' ? '팀원' : '미등록';
}

async function renderCleanupSessions() {
  let sessions;
  try {
    sessions = await window.api.getAllBackgroundSessions();
  } catch (err) {
    cleanupListEl.innerHTML = `<div class="empty-hint">세션 목록을 불러오지 못했습니다: ${escapeHtml(errMsg(err))}</div>`;
    return;
  }
  cleanupListEl.innerHTML = sessions.length ? sessions.map(s => `
    <div class="cleanup-item ${statusClass(s)}">
      <div class="cleanup-info">
        <div class="cleanup-top">${escapeHtml(dirLabel(s.cwd))}<span class="cleanup-tag">${tagLabel(s.tag)}</span></div>
        <div class="cleanup-meta">${escapeHtml(s.cwd)} · ${relativeAge(s.startedAt)} · ${escapeHtml(s.status || s.state || '')}</div>
      </div>
      <button class="stop-btn" data-stop-bg="${escapeHtml(s.id)}">종료</button>
    </div>
  `).join('') : '<div class="empty-hint">떠있는 백그라운드 세션이 없습니다.</div>';

  cleanupListEl.querySelectorAll('[data-stop-bg]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await window.api.stopBackgroundSession(btn.dataset.stopBg);
      } catch (err) {
        console.error('세션 종료 실패:', err);
      } finally {
        await renderCleanupSessions();
      }
    });
  });
}

refreshCleanupBtn.addEventListener('click', renderCleanupSessions);

document.querySelector('.tab-btn[data-tab="cleanup"]').addEventListener('click', renderCleanupSessions);

// ---------------- 히스토리 탭 (오프라인 팀장 모음 + 이어하기) ----------------

// resume 유효기간이 공식적으로 알려진 게 없어서 정확한 컷오프는 못 정한다 — 그냥 "오래됐다"는 걸
// 경고 색으로만 알려주고, 실제 이어짐 여부는 시도해봐야 안다(sendChatMessage의 실패 처리 참고).
// daily-journal이 남기는 summary([F]/[T]/[S] 구조로 파일·도구·핵심을 정리한 것)가 있으면 그걸 쓰고,
// 없으면 prompt/answer 원문을 잘라서 보여준다.
function formatPreview(preview, promptLen, answerLen) {
  if (!preview) return '(대화 기록 없음)';
  if (preview.summary) return escapeHtml(preview.summary);
  return `${escapeHtml(preview.prompt).slice(0, promptLen)}\n→ ${escapeHtml(preview.answer).slice(0, answerLen)}`;
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
        ${row.name ? `<span class="history-topic">${escapeHtml(row.name)}</span>` : ''}
        ${historyRiskBadge(row)}
      </div>
      <div class="history-meta">${escapeHtml(row.cwd)} · ${relativeAge(row.startedAt)} 시작</div>
      ${row.preview ? `<div class="history-preview">${formatPreview(row.preview, 80, 160)}</div>` : ''}
      <div class="history-hint">눌러서 이어하기 — 작업 탭으로 이동해 대화창에서 메시지를 보내면 다시 깨어납니다</div>
    </div>
  `;
}

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
}

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
        <span>${escapeHtml(row.projectName)}</span>
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

  // 선택된 팀장이 없어졌으면(종료됨) 남아있는 첫 팀장으로, 없으면 선택 해제
  if (selectedLeadId && !lastLeadIds.has(selectedLeadId)) selectedLeadId = null;
  if (!selectedLeadId && onlineLeads.length > 0 && formMode === 'none') selectedLeadId = onlineLeads[0].id;

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
    const { rows, requests } = await window.api.refreshBoard();
    renderBoard(rows || []);
    renderRequests(requests || []);
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
  memberDirSelect.value = '';
  memberTemplateSelect.value = '';
  setRoleValue(memberRoleSelect, memberRoleCustom, '');
  memberInstructionEl.value = '';
  addMemberSubmitBtn.disabled = true;
  updateMemberSectionVisibility();
});

cancelAddMemberBtn.addEventListener('click', () => {
  showAddMember = false;
  updateMemberSectionVisibility();
});

memberTemplateSelect.addEventListener('change', async () => {
  if (!memberTemplateSelect.value) return;
  try {
    const templates = await window.api.getMemberTemplates();
    const tpl = templates.find(t => t.id === memberTemplateSelect.value);
    if (!tpl) return;
    setRoleValue(memberRoleSelect, memberRoleCustom, tpl.role);
    memberInstructionEl.value = tpl.instruction;
    if (tpl.path) {
      // 디렉토리가 고정된 템플릿은 그대로 채운다 — 그 경로가 즐겨찾기에 등록 안 돼있으면
      // memberDirSelect 옵션 목록에 아예 없어서 .value 대입이 조용히 실패하니, customDir로
      // 넣어서 옵션에 강제로 포함시킨 뒤 채운다.
      memberCustomPickedDir = tpl.path;
      await renderFavorites(); // 드롭다운을 다시 그려서 tpl.path가 선택 가능한 상태로 만든 뒤
      memberDirSelect.value = tpl.path;
    }
    // 디렉토리가 없는 템플릿은 memberDirSelect를 그대로 두고 사용자가 직접 고르게 한다.
    addMemberSubmitBtn.disabled = !memberDirSelect.value;
  } catch (err) {
    addMemberStatusEl.textContent = `템플릿을 불러오지 못했습니다: ${errMsg(err)}`;
  }
});

memberDirSelect.addEventListener('change', () => {
  addMemberSubmitBtn.disabled = !memberDirSelect.value;
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
  if (!memberInstructionEl.value.trim()) {
    addMemberStatusEl.textContent = '이 팀원에게 줄 지시를 입력해주세요.';
    return;
  }
  addMemberSubmitBtn.disabled = true;
  addMemberStatusEl.textContent = '추가하는 중...';
  try {
    const id = await window.api.launchMember(selectedLeadId, memberDirSelect.value, memberInstructionEl.value.trim(), getRoleValue(memberRoleSelect, memberRoleCustom));
    if (id) {
      addMemberStatusEl.textContent = `팀원을 추가했습니다(${id}).`;
      memberInstructionEl.value = '';
      setRoleValue(memberRoleSelect, memberRoleCustom, '');
      memberTemplateSelect.value = '';
      showAddMember = false;
      updateMemberSectionVisibility();
    } else {
      addMemberStatusEl.textContent = '팀원 추가에 실패했습니다 — claude CLI 실행 결과를 확인해주세요.';
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
    const title = isStop ? `팀원 종료 요청 — ${req.memberId}` : (req.requestedDir || '');
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
      await apiCall();
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

window.api.onAgentsUpdate(({ rows, requests }) => {
  renderBoard(rows || []);
  renderRequests(requests || []);
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
  launchBtn.disabled = !targetDirSelect.value;

  setSelectValuePreserving(memberDirSelect, buildDirOptionsHtml(favs, memberCustomPickedDir, '-- 등록된 디렉토리에서 선택 --'), memberCustomPickedDir);
  addMemberSubmitBtn.disabled = !memberDirSelect.value;

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
  launchBtn.disabled = !targetDirSelect.value;
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
    const id = await window.api.launchTeamLead(targetDirSelect.value, instructionEl.value);
    if (id) {
      launchStatusEl.textContent = `팀장 세션(${id})을 시작했습니다.`;
      formMode = 'none';
      selectedLeadId = id;
      renderMemberRow(); // 새 팀장이라 소속 팀원이 없을 테니, 폴링 안 기다리고 바로 비워서 보여준다
    } else {
      launchStatusEl.textContent = '팀장 세션 시작에 실패했습니다 — claude CLI 실행 결과를 확인해주세요.';
    }
  } catch (err) {
    launchStatusEl.textContent = `팀장 세션 시작 중 오류가 발생했습니다: ${errMsg(err)}`;
  } finally {
    launchBtn.disabled = false;
  }
});

// ---------------- 설정 탭 ②: 팀원 등록(역할 템플릿) ----------------

function renderTemplateCard(t, favNameByPath) {
  const dirLine = t.path
    ? `<div class="tpl-path">${escapeHtml(favNameByPath.get(t.path) || t.path)}</div>`
    : '<div class="tpl-path">(쓸 때마다 대상 디렉토리를 고름)</div>';
  return `
    <div class="template-card ${t.approved ? 'approved' : ''}">
      <div class="tpl-top">
        <input class="tpl-name" data-name="${escapeHtml(t.id)}" value="${escapeHtml(t.name)}" />
        <input class="tpl-role" value="${escapeHtml(t.role)}" placeholder="역할" readonly title="등록 후에는 역할을 바꿀 수 없습니다 — 새로 등록해주세요" />
        <span class="remove" data-remove-tpl="${escapeHtml(t.id)}">×</span>
      </div>
      ${dirLine}
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
    await window.api.addMemberTemplate(scope, newTplDirSelect.value, newTplName.value.trim(), getRoleValue(newTplRoleSelect, newTplRoleCustom), newTplInstruction.value.trim());
    newTplName.value = '';
    setRoleValue(newTplRoleSelect, newTplRoleCustom, '');
    newTplInstruction.value = '';
    newTplDirSelect.value = '';
    newTplScopeSelect.value = 'shared';
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
