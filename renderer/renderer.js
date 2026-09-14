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
const chatTranscriptEl = document.getElementById('chat-transcript');
const chatInputEl = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const restartLeadBtn = document.getElementById('restart-lead-btn');
const restartLeadPanelEl = document.getElementById('restart-lead-panel');
const restartInstructionEl = document.getElementById('restart-instruction');
const restartConfirmBtn = document.getElementById('restart-confirm-btn');
const restartCancelBtn = document.getElementById('restart-cancel-btn');
const restartStatusEl = document.getElementById('restart-status');
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
const memberRoleInput = document.getElementById('member-role');
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

const newTplDirSelect = document.getElementById('new-tpl-dir-select');
const pickTplDirBtn = document.getElementById('pick-tpl-dir-btn');
const newTplName = document.getElementById('new-tpl-name');
const newTplRole = document.getElementById('new-tpl-role');
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

function renderLeadCard(row) {
  const statusLabel = statusLabelKo(row);
  const selected = row.id === selectedLeadId ? 'selected' : '';
  return `
    <div class="session-card lead-card ${statusClass(row)} ${selected}" data-lead="${escapeHtml(row.id)}">
      <div class="top-line">
        <input class="lead-label-input" data-lead-label="${escapeHtml(row.id)}" value="${escapeHtml(row.label || '')}" placeholder="${escapeHtml(row.projectName)}" />
        <span>${escapeHtml(statusLabel)}</span>
      </div>
      ${row.name ? `<div class="lead-topic">${escapeHtml(row.name)}</div>` : ''}
      <div class="meta">${escapeHtml(row.cwd)}</div>
      ${row.offline ? '<div class="offline-hint">메시지를 보내면 다시 이어집니다</div>' : `<div class="actions"><button data-attach="${escapeHtml(row.id)}">터미널 열기</button></div>`}
    </div>
  `;
}

async function selectLead(leadId) {
  selectedLeadId = leadId;
  formMode = 'none';
  restartLeadPanelEl.hidden = true;
  await renderChat();
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

async function renderChat() {
  if (!selectedLeadId) return;
  let transcript;
  try {
    transcript = await window.api.getLeadTranscript(selectedLeadId);
  } catch (err) {
    chatTranscriptEl.innerHTML = `<p style="color:#f14c4c">대화 기록을 불러오지 못했습니다: ${escapeHtml(errMsg(err))}</p>`;
    return;
  }
  const row = lastRows.find(r => r.isLead && r.id === selectedLeadId);
  const isBusy = !!row && !row.offline && (row.status || row.state || '').toLowerCase() === 'busy';
  const busyBanner = isBusy ? '<div class="chat-working">● 작업 중...</div>' : '';

  // 3초마다 도는 폴링 갱신마다 무조건 맨 아래로 스크롤하면, 옛날 대화를 읽으려고 위로 스크롤해둔 걸
  // 계속 끌어내린다 — 이미 맨 아래 근처에 있을 때만("계속 따라가기") 다시 맨 아래로 붙인다.
  const wasNearBottom = chatTranscriptEl.scrollHeight - chatTranscriptEl.scrollTop - chatTranscriptEl.clientHeight < 40;

  if (!transcript || transcript.length === 0) {
    chatTranscriptEl.innerHTML = '<p style="color:#777">아직 대화 기록이 없습니다 (첫 응답을 기다리는 중일 수 있습니다).</p>' + busyBanner;
  } else {
    chatTranscriptEl.innerHTML = transcript.map(t => `
      <div class="chat-turn">
        <div class="chat-time">${escapeHtml(t.time)}</div>
        <div class="chat-prompt">▸ ${escapeHtml(cleanPrompt(t.prompt))}</div>
        <div class="chat-answer">${escapeHtml(t.answer)}</div>
      </div>
    `).join('') + busyBanner;
  }
  if (wasNearBottom) chatTranscriptEl.scrollTop = chatTranscriptEl.scrollHeight;
  updateBusyUI();
}

function updateLeadSectionVisibility() {
  const hasLeads = lastLeadIds.size > 0;
  const effectiveMode = formMode === 'none' && !hasLeads ? 'launch' : formMode;

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
  try {
    const id = await window.api.sendToLead(leadId, message);
    if (!id) {
      // 오프라인 팀장을 이어하려다 실패한 경우(세션 만료 등) 여기서 걸린다 — 조용히 넘어가지 않는다.
      chatTranscriptEl.insertAdjacentHTML('beforeend', '<p style="color:#f14c4c">이어하기에 실패했습니다 — 세션이 만료됐거나 claude CLI 실행에 문제가 있을 수 있습니다.</p>');
      return;
    }
    await renderChat();
  } catch (err) {
    chatTranscriptEl.insertAdjacentHTML('beforeend', `<p style="color:#f14c4c">이어하기 중 오류가 발생했습니다: ${escapeHtml(errMsg(err))}</p>`);
  } finally {
    busyLeadIds.delete(leadId);
    updateBusyUI();
  }
}

restartLeadBtn.addEventListener('click', () => {
  restartLeadPanelEl.hidden = false;
  restartInstructionEl.value = '';
  restartStatusEl.textContent = '';
});

restartCancelBtn.addEventListener('click', () => {
  restartLeadPanelEl.hidden = true;
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
      restartLeadPanelEl.hidden = true;
      restartStatusEl.textContent = '';
      await renderChat();
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
      ${row.preview ? `<div class="history-preview">${escapeHtml(row.preview.prompt).slice(0, 80)}\n→ ${escapeHtml(row.preview.answer).slice(0, 160)}</div>` : ''}
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
  const preview = row.preview
    ? `${escapeHtml(row.preview.prompt).slice(0, 100)}\n→ ${escapeHtml(row.preview.answer).slice(0, 220)}`
    : '(대화 기록 없음)';
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

  updateLeadSectionVisibility();
  updateMemberSectionVisibility();
  if (selectedLeadId) renderChat();

  const leadLabelById = new Map(leads.map(l => [l.id, l.label || l.projectName]));
  memberRowEl.innerHTML = members.length
    ? members.map(row => renderMemberCard(row, leadLabelById)).join('')
    : '<div class="empty-hint">떠있는 팀원이 없습니다.</div>';

  document.querySelectorAll('[data-attach]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation(); // 팀장 카드 안 버튼일 땐 카드 클릭(selectLead)까지 같이 안 타게
      try {
        await window.api.openInTerminal(btn.dataset.attach);
      } catch (err) {
        console.error('터미널 열기 실패:', err);
      }
    });
  });

  document.querySelectorAll('[data-refresh-member]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await refreshBoardNow();
      } catch (err) {
        console.error('새로고침 실패:', err);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('[data-stop-member]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await window.api.stopBackgroundSession(btn.dataset.stopMember);
      } catch (err) {
        console.error('팀원 세션 종료 실패:', err);
      } finally {
        await refreshBoardNow();
      }
    });
  });
}

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
  addMemberPanelEl.hidden = !showAddMember;
  addMemberBtn.hidden = showAddMember;
  addMemberBtn.disabled = !selectedLeadId;
  addMemberBtn.title = selectedLeadId ? '' : '먼저 위에서 팀장을 선택하세요';
}

addMemberBtn.addEventListener('click', () => {
  if (!selectedLeadId) return;
  showAddMember = true;
  // 디렉토리 선택은 이전에 뭘 골랐든 매번 새로 고르게 한다 — 안 그러면 예전 선택이 그대로 남아있어서
  // (예: 예전에 팀장 자신의 디렉토리에 팀원을 넣었던 기록) 실수로 엉뚱한 곳에 팀원이 뜬다.
  memberCustomPickedDir = null;
  memberDirSelect.value = '';
  memberTemplateSelect.value = '';
  memberRoleInput.value = '';
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
    memberRoleInput.value = tpl.role;
    memberInstructionEl.value = tpl.instruction;
    if (tpl.category === 'worker' && tpl.path) {
      // 일꾼 템플릿은 디렉토리가 고정돼 있으니 그대로 채운다.
      memberCustomPickedDir = null;
      await renderFavorites(); // 드롭다운을 다시 그려서 tpl.path가 선택 가능한 상태로 만든 뒤
      memberDirSelect.value = tpl.path;
    }
    // 전반 역할 템플릿은 디렉토리가 없으므로 memberDirSelect는 그대로 두고 사용자가 직접 고르게 한다.
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
    const id = await window.api.launchMember(selectedLeadId, memberDirSelect.value, memberInstructionEl.value.trim(), memberRoleInput.value.trim());
    if (id) {
      addMemberStatusEl.textContent = `팀원을 추가했습니다(${id}).`;
      memberInstructionEl.value = '';
      memberRoleInput.value = '';
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

  setSelectValuePreserving(newTplDirSelect, buildDirOptionsHtml(favs, tplCustomPickedDir, '-- 팀장 디렉토리에서 선택 (비우면 공용) --'), tplCustomPickedDir);
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

function renderTemplateCard(t) {
  return `
    <div class="template-card ${t.approved ? 'approved' : ''}">
      <div class="tpl-top">
        <input class="tpl-name" data-name="${escapeHtml(t.id)}" value="${escapeHtml(t.name)}" />
        <input class="tpl-role" value="${escapeHtml(t.role)}" placeholder="역할" readonly title="등록 후에는 역할을 바꿀 수 없습니다 — 새로 등록해주세요" />
        <span class="remove" data-remove-tpl="${escapeHtml(t.id)}">×</span>
      </div>
      <textarea class="tpl-instruction" rows="2" readonly title="등록 후에는 기본 지시를 바꿀 수 없습니다 — 새로 등록해주세요">${escapeHtml(t.instruction)}</textarea>
      ${t.category === 'worker' ? `
      <div class="tpl-bottom">
        <label class="tpl-approved-label">
          <input type="checkbox" data-approve-tpl="${escapeHtml(t.id)}" ${t.approved ? 'checked' : ''} />
          사전승인 (모든 팀장에게 자동 안내)
        </label>
      </div>` : ''}
    </div>
  `;
}

function renderTplGroup(title, path, list) {
  return `
    <div class="tpl-group">
      <div class="tpl-group-title">${escapeHtml(title)}${path ? `<span class="tpl-group-path">${escapeHtml(path)}</span>` : ''}</div>
      ${list.map(renderTemplateCard).join('')}
    </div>
  `;
}

// 팀장(프로젝트) 소속과 공용 역할을 그룹으로 묶어서 보여준다 — 어디서 쓰이는 팀원인지 한눈에 구분되게.
async function renderMemberTemplates() {
  let templates, favs;
  try {
    [templates, favs] = await Promise.all([window.api.getMemberTemplates(), window.api.getFavorites()]);
  } catch (err) {
    memberTemplatesListEl.innerHTML = `<div class="empty-hint">팀원 템플릿을 불러오지 못했습니다: ${escapeHtml(errMsg(err))}</div>`;
    return;
  }
  const favNameByPath = new Map(favs.map(f => [f.path, f.name]));

  const general = templates.filter(t => t.category === 'general');
  const byPath = new Map();
  templates.filter(t => t.category === 'worker').forEach(t => {
    const key = t.path || '';
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(t);
  });

  const groups = [];
  if (general.length) groups.push(renderTplGroup('공용 (프로젝트 안 가림)', null, general));
  [...byPath.entries()].forEach(([dirPath, list]) => {
    groups.push(renderTplGroup(favNameByPath.get(dirPath) || dirLabel(dirPath), dirPath, list));
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

  // 작업 탭의 "등록된 팀원 템플릿에서 불러오기" 드롭다운도 같이 갱신 — 여기도 소속(공용/프로젝트)별로 묶는다.
  const tplOption = t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.role ? ` (${escapeHtml(t.role)})` : ''}</option>`;
  const optgroups = [];
  if (general.length) optgroups.push(`<optgroup label="공용">${general.map(tplOption).join('')}</optgroup>`);
  [...byPath.entries()].forEach(([dirPath, list]) => {
    optgroups.push(`<optgroup label="${escapeHtml(favNameByPath.get(dirPath) || dirLabel(dirPath))}">${list.map(tplOption).join('')}</optgroup>`);
  });
  memberTemplateSelect.innerHTML = `<option value="">-- 등록된 팀원 템플릿에서 불러오기 (선택) --</option>${optgroups.join('')}`;
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
  const category = newTplDirSelect.value ? 'worker' : 'general';
  try {
    await window.api.addMemberTemplate(category, newTplDirSelect.value, newTplName.value.trim(), newTplRole.value.trim(), newTplInstruction.value.trim());
    newTplName.value = '';
    newTplRole.value = '';
    newTplInstruction.value = '';
    newTplDirSelect.value = '';
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
