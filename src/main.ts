import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec, spawn } from 'child_process';

const POLL_INTERVAL_MS = 3000;
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const SESSION_EDITS_DIR = path.join(CLAUDE_HOME, 'session-edits');
const JOURNAL_DATA_DIR = path.join(CLAUDE_HOME, 'daily-journal', 'data');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const SKILL_SRC = path.join(getResourcesRoot(), 'skills', 'team-lead', 'SKILL.md');
const SKILL_DEST_DIR = path.join(CLAUDE_HOME, 'skills', 'team-lead');
const FAVORITES_PATH = path.join(app.getPath('userData'), 'favorites.json');
const MEMBER_TEMPLATES_PATH = path.join(app.getPath('userData'), 'memberTemplates.json');
const LEADS_PATH = path.join(app.getPath('userData'), 'leads.json');
const PENDING_NOTICES_PATH = path.join(app.getPath('userData'), 'pendingNotices.json');
// 팀장 세션(claude 프로세스, 이 앱과 별개)도 알아야 하는 고정 경로라서 앱 userData가 아니라 ~/.claude 밑에 둔다.
const REQUESTS_DIR = path.join(CLAUDE_HOME, 'claude-team-monitor', 'requests');
// 팀장이 실제로 띄운 팀원을 등록해두는 곳 — 이게 있어야 "무관하게 떠있는 다른 세션"과 "진짜 내 팀원"을 구분한다.
const MEMBERS_DIR = path.join(CLAUDE_HOME, 'claude-team-monitor', 'members');

type AgentEntry = {
  id?: string;
  pid?: number;
  cwd: string;
  kind: 'interactive' | 'background';
  startedAt: number;
  sessionId: string;
  name?: string;
  status?: string;
  state?: string;
};

type SessionRow = AgentEntry & {
  projectName: string;
  preview?: { time: string; prompt: string; answer: string; summary?: string } | null;
  isLead: boolean;
  leadId?: string; // 팀원 카드일 때, 소속 팀장의 짧은 id
  role?: string;   // 팀원 카드일 때, 등록된 역할(예: reviewer)
  label?: string;  // 팀장 카드일 때, 사용자가 붙인 이름표(같은 디렉토리에서 여러 팀장을 구분하기 위함)
  offline?: boolean; // 팀장 카드일 때, 지금 프로세스가 떠있지 않음(재부팅 등) — 채팅으로 메시지를 보내면 다시 깨어남
};

type TranscriptEntry = { time: string; prompt: string; answer: string };

type MemberRecord = {
  memberId: string;
  leadId: string;
  dir: string;
  createdAt: number;
  role?: string; // 예: "reviewer" — 일반 구현 팀원과 구분해 화면에 표시하기 위한 선택 필드
};

// "팀장 디렉토리" — 팀장을 어디서 띄울지 고르는 용도의 단순 등록 목록. 팀원 관련 결정(역할·사전승인)은
// 별도의 MemberTemplate이 담당한다 — 둘을 하나로 묶지 않는다(등록 ≠ 역할부여 ≠ 사전승인).
type Favorite = { path: string; name: string };

// "팀원 등록(역할 템플릿)" — 재사용 가능한 팀원 정의. 두 종류가 있다:
// - worker(프로젝트 일꾼): 특정 디렉토리(path)에 고정된 팀원. approved가 true면 모든 팀장이 launch
//   시점에 자동으로 "그 디렉토리는 승인됨"으로 안내받는다(매번 체크박스를 다시 켤 필요 없음).
// - general(전반 역할): 코드리뷰·검수처럼 특정 프로젝트에 묶이지 않는 역할. path가 없고, 실제로 쓸 때
//   마다 대상 디렉토리를 그때그때 고른다 — 그래서 approved 개념(디렉토리 자동승인)이 적용되지 않는다.
type MemberTemplate = {
  id: string;
  category: 'worker' | 'general';
  path?: string; // worker만 있음
  name: string;
  role: string;
  instruction: string;
  approved: boolean; // worker에서만 의미 있음
};

type LeadRecord = {
  id: string; // claude --bg 가 돌려주는 짧은 id (claude agents --json 매칭·attach/logs/stop용)
  sessionId: string; // 전체 UUID (--resume은 반드시 이걸로 해야 같은 세션이 이어짐, 짧은 id를 주면 복사본이 갈라짐)
  targetDir: string;
  launchedAt: number;
  approvedMembers: string[];
  label?: string; // 사용자가 직접 붙인 이름표 — 같은 디렉토리에서 팀장을 여러 개 띄웠을 때 구분용
  aiTitle?: string; // claude가 자동 생성한 세션 주제(네이티브 --resume 목록에 뜨는 것과 같은 것) — 한 번 찾으면 캐싱
};

// 'dir-approval': 사전 승인 안 된 디렉토리에 팀원을 새로 띄우고 싶을 때(requestedDir 사용).
// 'stop-member': 팀장이 자기가 띄운 팀원을 종료하고 싶을 때(memberId 사용) — 사용자가 직접 지정해서
// 박아둔 팀원(+ 팀원 직접 추가로 만든 것)이 아닌 한, 팀장이 마음대로 끄지 못하게 이것도 승인을 거친다.
type MemberRequest = {
  id: string;
  teamLeadId: string;
  type?: 'dir-approval' | 'stop-member'; // 없으면 구버전 요청으로 간주해 dir-approval로 취급
  requestedDir?: string;
  memberId?: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
};

// 사용자가 "+ 팀원 직접 추가"로 팀장 몰래(?) 팀원을 붙였을 때, 팀장이 busy 상태에서 억지로
// 끊기지 않도록 알림을 큐에 쌓아뒀다가 idle/blocked일 때만 전달한다.
type PendingNotice = { leadId: string; message: string; createdAt: number };

function getResourcesRoot(): string {
  // app.getAppPath()는 개발 중엔 프로젝트 루트, electron-packager로 패키징한 뒤엔
  // resources/app(패키지 루트, package.json이 있는 곳)을 가리킨다 — 두 경우 다 그 밑에
  // resources/, renderer/가 그대로 있으므로 이 값 하나로 양쪽 다 해결된다.
  return path.join(app.getAppPath(), 'resources');
}

// daily-journal이 세션당 캐시해둔 프로젝트명을 그대로 재사용한다(getStableProjectName과 동일한 소스).
// 캐시가 아직 없으면(그 세션에서 Edit/Write가 한 번도 없었으면) cwd의 basename으로 근사한다.
function resolveProjectName(sessionId: string, cwd: string): string {
  try {
    const cacheFile = path.join(SESSION_EDITS_DIR, `${sessionId}.project.json`);
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (cached.projectName) return cached.projectName;
    }
  } catch {
    // 무시하고 근사치로 폴백
  }
  return path.basename(cwd);
}

// 팀장을 하루 넘겨 이어가는 경우가 있어서, 오늘 날짜뿐 아니라 daily-journal에 쌓인 모든 날짜의
// 기록을 (오래된 순으로) 훑어서 합친다 — 그래야 어제 이전 대화도 이어하기 후 대화창에 남아있다.
function readJournalEntries(projectName: string): any[] {
  try {
    if (!fs.existsSync(JOURNAL_DATA_DIR)) return [];
    const dates = fs.readdirSync(JOURNAL_DATA_DIR)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    const entries: any[] = [];
    for (const date of dates) {
      const file = path.join(JOURNAL_DATA_DIR, date, 'history', `${projectName}.jsonl`);
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf-8').trim();
      if (!content) continue;
      content.split('\n').filter(Boolean).forEach(l => {
        try { entries.push(JSON.parse(l)); } catch { /* 손상된 줄은 건너뜀 */ }
      });
    }
    return entries;
  } catch {
    return [];
  }
}

// 오늘자 daily-journal jsonl에서 그 프로젝트의 마지막 기록(가장 최근 대화)을 미리보기로 가져온다.
// projectName만으로 마지막 기록을 가져오면, 같은 디렉토리에서 예전에 지운 세션의 마지막 대화가
// 새로 띄운(아직 대화 기록이 없는) 세션 카드에 그대로 새어나온다 — 반드시 sessionId로 걸러야 한다.
function getLatestPreview(projectName: string, sessionId: string): SessionRow['preview'] {
  const entries = readJournalEntries(projectName).filter(e => e.sessionId === sessionId);
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1];
  // daily-journal이 prompt/answer 말고 요약([F]/[T]/[S] 구조로 파일·도구·핵심을 정리한 것)도 같이
  // 남긴다 — 원문 앞부분을 그냥 자르는 것보다 훨씬 읽기 좋아서 있으면 우선 쓴다.
  return { time: last.time ?? '', prompt: last.prompt ?? '', answer: last.answer ?? '', summary: last.summary || undefined };
}

// 팀장과의 "대화" 패널용 — 그 세션 id로 필터링한 전체 왕복 기록(오늘자).
function getTranscript(projectName: string, sessionId: string): TranscriptEntry[] {
  return readJournalEntries(projectName)
    .filter(e => e.sessionId === sessionId)
    .map(e => ({ time: e.time ?? '', prompt: e.prompt ?? '', answer: e.answer ?? '' }));
}

// claude 자신이 세션마다 자동으로 붙이는 짧은 주제(claude agents --json의 name 필드, 네이티브
// --resume 목록에 뜨는 바로 그것)를 세션 트랜스크립트 파일에서 직접 읽어온다 — 오프라인(프로세스가
// 죽은) 세션은 agents --json에 안 잡혀서 이 필드가 없기 때문에 파일에서 복구해야 한다.
// ~/.claude/projects/<cwd를 인코딩한 폴더명>/<sessionId>.jsonl 안에 {"type":"ai-title",...} 줄로 남는다.
// 폴더명 인코딩 규칙은 영문/숫자가 아닌 문자를 전부 1:1로 '-'로 치환하는 것(실측 확인).
function encodeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function getSessionAiTitle(sessionId: string, cwd: string): string | null {
  try {
    const file = path.join(PROJECTS_DIR, encodeProjectDirName(cwd), `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf-8');
    let title: string | null = null;
    for (const line of content.split('\n')) {
      if (!line.includes('"type":"ai-title"')) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
      } catch { /* 손상된 줄은 건너뜀 */ }
    }
    return title;
  } catch {
    return null;
  }
}

function fetchAgents(): Promise<AgentEntry[]> {
  return new Promise(resolve => {
    exec('claude agents --json', { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve([]);
      }
    });
  });
}

// 단일 JSON 파일 하나를 안전하게 읽는다 — 없거나 깨져 있으면 null.
function readJsonFileSafe<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

// 배열 하나를 담은 JSON 파일을 안전하게 읽는다 — 없거나 깨져 있거나 배열이 아니면 [].
function readJsonArraySafe<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = readJsonFileSafe<T[]>(filePath);
  return Array.isArray(parsed) ? parsed : [];
}

// 쓰는 도중 죽어도(정전, 강제 종료, 예외) 원본 파일이 잘린 채로 남지 않도록, 임시 파일에 먼저 쓰고
// 같은 폴더 안에서 rename으로 교체한다(rename은 원자적이다). 실패하면 예외를 그대로 던진다 — 호출부에서
// try/catch로 로깅/처리한다.
function writeJsonFileAtomic(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function loadLeads(): LeadRecord[] {
  return readJsonArraySafe<LeadRecord>(LEADS_PATH);
}

function saveLeads(leads: LeadRecord[]): void {
  try {
    writeJsonFileAtomic(LEADS_PATH, leads);
  } catch (err) {
    console.error('[saveLeads] leads.json 저장 실패:', err);
  }
}

function loadPendingNotices(): PendingNotice[] {
  return readJsonArraySafe<PendingNotice>(PENDING_NOTICES_PATH);
}

function savePendingNotices(notices: PendingNotice[]): void {
  try {
    writeJsonFileAtomic(PENDING_NOTICES_PATH, notices);
  } catch (err) {
    console.error('[savePendingNotices] pendingNotices.json 저장 실패:', err);
  }
}

function queueLeadNotice(leadId: string, message: string): void {
  const notices = loadPendingNotices();
  notices.push({ leadId, message, createdAt: Date.now() });
  savePendingNotices(notices);
}

function loadMembers(): MemberRecord[] {
  try {
    if (!fs.existsSync(MEMBERS_DIR)) return [];
    return fs.readdirSync(MEMBERS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => readJsonFileSafe<MemberRecord>(path.join(MEMBERS_DIR, f)))
      .filter((m): m is MemberRecord => !!m);
  } catch {
    return [];
  }
}

// 방금 등록된 팀원은 claude agents --json 스냅샷에 아직 안 잡혔을 수 있다(팀장이 방금 스폰한
// 직후의 타이밍 차이) — 그 유예 기간 안에는 "떠있지 않다"고 오판해 등록 파일을 지우지 않는다.
const MEMBER_CLEANUP_GRACE_MS = 15000;

// 보드에는 "내가 띄운 팀장"과 "팀장이 등록한 팀원"만 보여준다 — 그 외(사용자가 따로 열어둔 무관한
// 세션 등)는 team-lead 체계 밖이므로 제외한다. interactive 세션은 애초에 짧은 id가 없어서 자동으로 빠진다.
async function buildSessionRows(): Promise<{ rows: SessionRow[]; requests: MemberRequest[] }> {
  const agents = await fetchAgents();
  const agentIdSet = new Set(agents.filter(a => !!a.id).map(a => a.id));
  const leads = loadLeads();
  const leadIds = new Set(leads.map(l => l.id));
  const members = loadMembers();
  const memberMap = new Map(members.map(m => [m.memberId, m]));

  const liveRows: SessionRow[] = agents
    .filter(a => !!a.id && (leadIds.has(a.id) || memberMap.has(a.id)))
    .map(a => {
      const projectName = resolveProjectName(a.sessionId, a.cwd);
      const isLead = leadIds.has(a.id!);
      const member = isLead ? undefined : memberMap.get(a.id!);
      const lead = isLead ? leads.find(l => l.id === a.id!) : undefined;
      return {
        ...a,
        projectName,
        preview: getLatestPreview(projectName, a.sessionId),
        isLead,
        leadId: member?.leadId,
        role: member?.role,
        label: lead?.label,
        offline: false,
      };
    });

  // 대기 중인 팀원-추가 알림 중, 그 팀장이 지금 busy가 아니면(=억지로 끊어도 하던 작업이 없으면)
  // 이 타이밍에 stop→resume으로 실제 전달한다. busy면 다음 폴링까지 큐에 그대로 둔다.
  const pendingNotices = loadPendingNotices();
  if (pendingNotices.length > 0) {
    const stillPending: PendingNotice[] = [];
    for (const notice of pendingNotices) {
      const liveLead = liveRows.find(r => r.isLead && r.id === notice.leadId);
      const isBusy = !!liveLead && (liveLead.status || '').toLowerCase() === 'busy';
      if (liveLead && !isBusy) {
        const leadRec = leads.find(l => l.id === notice.leadId);
        if (leadRec) {
          queueLeadOperation(leadRec.id, () => resumeLead(leadRec.sessionId, leadRec.targetDir, notice.message))
            .catch(() => { /* 실패해도 알림 자체는 소모(재시도 안 함) */ });
          continue;
        }
      }
      stillPending.push(notice);
    }
    if (stillPending.length !== pendingNotices.length) savePendingNotices(stillPending);
  }

  // 지금 떠있지 않은 팀장은 기록을 지우지 않고 "오프라인"으로 남겨둔다 — PC 재부팅 등으로 프로세스가
  // 죽어도 세션 자체는 claude 쪽에 남아있어서 --bg --resume으로 다시 깨울 수 있기 때문이다(대화창에서
  // 메시지를 보내면 자동으로 이 절차를 탄다, resumeLead 참고).
  const offlineLeads = leads.filter(l => !agentIdSet.has(l.id));
  let leadsDirty = false;
  const offlineRows: SessionRow[] = offlineLeads.map(l => {
    const projectName = resolveProjectName(l.sessionId, l.targetDir);
    // 주제(ai-title)는 한 번 찾으면 세션 트랜스크립트를 매번 다시 읽지 않도록 leads.json에 캐싱한다.
    if (!l.aiTitle) {
      const found = getSessionAiTitle(l.sessionId, l.targetDir);
      if (found) { l.aiTitle = found; leadsDirty = true; }
    }
    return {
      id: l.id,
      sessionId: l.sessionId,
      cwd: l.targetDir,
      kind: 'background',
      startedAt: l.launchedAt,
      name: l.aiTitle,
      projectName,
      preview: getLatestPreview(projectName, l.sessionId),
      isLead: true,
      label: l.label,
      offline: true,
    };
  });
  if (leadsDirty) saveLeads(leads);

  const rows = [...liveRows, ...offlineRows];

  // 팀원은 팀장과 달리 일회성 하위 작업 단위라 이어할 필요가 적어서, 종료되면 바로 정리한다 — 단,
  // 방금(MEMBER_CLEANUP_GRACE_MS 이내) 등록된 팀원은 agents 스냅샷에 아직 안 잡혔을 수 있으니 봐준다.
  members.forEach(m => {
    if (Date.now() - m.createdAt < MEMBER_CLEANUP_GRACE_MS) return;
    if (!agentIdSet.has(m.memberId)) {
      try { fs.unlinkSync(path.join(MEMBERS_DIR, `${m.memberId}.json`)); } catch { /* ignore */ }
    }
  });

  const requests = loadPendingRequests();
  return { rows, requests };
}

function loadPendingRequests(): MemberRequest[] {
  try {
    if (!fs.existsSync(REQUESTS_DIR)) return [];
    return fs.readdirSync(REQUESTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => readJsonFileSafe<MemberRequest>(path.join(REQUESTS_DIR, f)))
      .filter((r): r is MemberRequest => !!r && r.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

// 이미 처리된(pending이 아닌) 요청을 다시 승인/거부하면 팀장에게 모순된 메시지가 두 번 전달될 수
// 있으므로, 현재 상태가 여전히 pending일 때만 갱신한다(CAS).
function writeRequestDecision(requestId: string, status: 'approved' | 'denied'): MemberRequest | null {
  const file = path.join(REQUESTS_DIR, `${requestId}.json`);
  const req = readJsonFileSafe<MemberRequest>(file);
  if (!req || req.status !== 'pending') return null;
  req.status = status;
  try {
    writeJsonFileAtomic(file, req);
  } catch (err) {
    console.error('[writeRequestDecision] 요청 상태 저장 실패:', err);
    return null;
  }
  return req;
}

// 번들된 스킬 파일을 ~/.claude/skills/team-lead/SKILL.md로 항상 최신화(덮어쓰기)한다.
function installTeamLeadSkill(): void {
  try {
    fs.mkdirSync(SKILL_DEST_DIR, { recursive: true });
    fs.copyFileSync(SKILL_SRC, path.join(SKILL_DEST_DIR, 'SKILL.md'));
    fs.mkdirSync(REQUESTS_DIR, { recursive: true });
    fs.mkdirSync(MEMBERS_DIR, { recursive: true });
  } catch (err) {
    console.error('[installTeamLeadSkill] 팀장 스킬 설치/갱신 실패 — 기존에 설치돼 있던 스킬로 계속 진행합니다.', err);
  }
}

// 예전 포맷(문자열 배열, 또는 approvedForMembers가 섞여있던 중간 포맷)을 전부 {path,name}으로
// 정규화한다. approvedForMembers는 이제 MemberTemplate.approved로 대체됐으므로 무시한다.
function loadFavorites(): Favorite[] {
  return readJsonArraySafe<Favorite>(FAVORITES_PATH);
}

function saveFavorites(favorites: Favorite[]): void {
  try {
    writeJsonFileAtomic(FAVORITES_PATH, favorites);
  } catch (err) {
    console.error('[saveFavorites] favorites.json 저장 실패:', err);
  }
}

function loadMemberTemplates(): MemberTemplate[] {
  return readJsonArraySafe<MemberTemplate>(MEMBER_TEMPLATES_PATH);
}

function saveMemberTemplates(templates: MemberTemplate[]): void {
  try {
    writeJsonFileAtomic(MEMBER_TEMPLATES_PATH, templates);
  } catch (err) {
    console.error('[saveMemberTemplates] memberTemplates.json 저장 실패:', err);
  }
}

// 팀장을 새로 띄울 때마다 매번 체크박스를 켜지 않아도 되도록, "사전승인"이 켜진 worker 템플릿은
// 항상 자동으로 그 팀장의 승인 목록에 들어간다. general(전반 역할) 템플릿은 디렉토리가 없어서
// 자동승인 대상이 될 수 없지만, "이런 역할이 있다"는 것 자체는 별도로 안내해서 팀장이 필요할 때
// 대상 디렉토리를 골라 활용하게 한다.
function approvedMemberBriefing(): { paths: string[]; text: string } {
  const templates = loadMemberTemplates();
  const approvedWorkers = templates.filter(t => t.category === 'worker' && t.approved && t.path);
  const generalRoles = templates.filter(t => t.category === 'general');

  const parts: string[] = [];
  if (approvedWorkers.length > 0) {
    const lines = approvedWorkers.map(t =>
      `- ${t.path}${t.role ? ` (역할: ${t.role})` : ''}${t.instruction ? ` — 추천 지시: "${t.instruction}"` : ''}`);
    parts.push(`사전 승인된 팀원 디렉토리 목록(이 안에서는 바로 팀원을 띄워도 됨):\n${lines.join('\n')}`);
  } else {
    parts.push('사전 승인된 팀원 디렉토리가 없음 — 팀원이 필요하면 반드시 승인 요청부터 거쳐라.');
  }
  if (generalRoles.length > 0) {
    const lines = generalRoles.map(t =>
      `- ${t.name}(역할: ${t.role || '미지정'})${t.instruction ? ` — 기본 지시: "${t.instruction}"` : ''}`);
    parts.push(`특정 프로젝트에 묶이지 않은 역할(필요한 디렉토리에 적용해서 써라 — 그 디렉토리가 위 사전승인 목록에 없으면 승인 요청부터 거쳐라):\n${lines.join('\n')}`);
  }
  return { paths: approvedWorkers.map(t => t.path!), text: parts.join('\n\n') };
}

const RUN_CLAUDE_TIMEOUT_MS = 30000; // claude --bg가 이 시간 안에도 안 끝나면 행(hang)으로 간주하고 포기한다.
const STOP_SESSION_TIMEOUT_MS = 15000;

// claude가 네이티브 실행 파일(.exe)이 아니라 .cmd/.bat 같은 셸 스크립트로 설치돼 있으면, Windows에서는
// shell:false로 spawn해도 Node가 내부적으로 cmd.exe를 거쳐 실행한다 — 이 경로는 인자 이스케이프 방식이
// 달라져서(개행·따옴표가 섞인 instruction을 그대로 넘기는 이 앱 특성상) 인자/셸 인젝션 위험이 있다.
// claude CLI 설치 형태를 이 앱이 강제로 바꿀 수는 없으므로, 실행 전에 한 번 확인해 .exe가 아니면
// 경고 로그만 남긴다(최초 1회만 검사해서 캐싱).
let claudeBinaryCheck: Promise<void> | null = null;

function checkClaudeBinaryOnce(): Promise<void> {
  if (!claudeBinaryCheck) {
    claudeBinaryCheck = new Promise(resolve => {
      exec('where claude', { windowsHide: true }, (err, stdout) => {
        if (err) {
          console.warn('[claude-team-monitor] claude 실행 파일 경로를 확인하지 못했습니다(where claude 실패) — .exe 여부 검증을 생략합니다.');
          resolve();
          return;
        }
        const firstPath = stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
        if (firstPath && !/\.exe$/i.test(firstPath)) {
          console.warn(
            `[claude-team-monitor] 경고: claude 실행 파일이 .exe가 아닙니다(${firstPath}). ` +
            'Windows에서 .cmd/.bat 스크립트는 spawn 시 셸을 거쳐 실행되어 인자 이스케이프 방식이 달라질 수 있습니다 ' +
            '(인자/셸 인젝션 위험). claude CLI를 네이티브 실행 파일로 설치하는 것을 권장합니다.'
          );
        }
        resolve();
      });
    });
  }
  return claudeBinaryCheck;
}

// claude --bg 는 시작하면서 "backgrounded · <id>" 를 stdout에 찍고 곧 종료된다(실제 세션은 별도 백그라운드
// 프로세스로 계속 돈다). 그 짧은 id를 잡아내려고 stdout을 파이프로 받는다.
//
// shell:true를 쓰면 안 된다 — 실측 확인: 지시문에 개행(\n)이 들어있으면(역할 프리픽스, 사전승인 브리핑
// 등 여러 줄짜리 프롬프트가 흔함) Windows cmd.exe가 그 줄에서 명령을 끊어버려서 뒷부분이 통째로
// 사라진다("역할: reviewer"까지만 전달되고 실제 지시가 날아가는 등). `claude`는 실제로 .exe라
// (`where claude` 확인) shell 없이 바로 spawn해도 PATH에서 찾아 실행되고, 이 경우 인자는 OS의
// CreateProcess 인자 규칙을 따르므로 개행이 든 문자열도 그대로 온전히 전달된다.
function runClaudeBg(args: string[], cwd: string): Promise<string | null> {
  return checkClaudeBinaryOnce().then(() => new Promise<string | null>(resolve => {
    let out = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn('claude', args, { cwd });
    const timer = setTimeout(() => {
      console.error('[runClaudeBg] claude 프로세스가 응답 없이 대기 중이라 강제 종료합니다.', { args, cwd });
      child.kill();
      finish(null);
    }, RUN_CLAUDE_TIMEOUT_MS);
    child.stdout?.on('data', d => { out += d.toString(); });
    child.on('close', () => {
      const m = out.match(/backgrounded\s*[·:]\s*([a-f0-9]+)/i);
      if (!m) {
        console.error('[runClaudeBg] claude stdout에서 "backgrounded" 마커를 찾지 못했습니다. 원문:', out);
      }
      finish(m ? m[1] : null);
    });
    child.on('error', err => {
      console.error('[runClaudeBg] claude 프로세스를 실행하지 못했습니다:', err);
      finish(null);
    });
  }));
}

// claude --bg --resume <id>는 그 세션이 아직 살아있으면 "복사본"을 새로 만들어버린다(실측 확인) —
// 진짜 같은 세션을 이어가려면 먼저 stop 해서 재운 뒤에 resume 해야 한다("woke session ... with its saved
// options" 로 확인됨, 같은 짧은 id 그대로 유지). done 상태에서 stop 해도 안전하다.
function stopSession(id: string): Promise<void> {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const child = spawn('claude', ['stop', id]);
    const timer = setTimeout(() => {
      console.error(`[stopSession] claude stop ${id} 이 응답 없이 대기 중이라 강제 종료합니다.`);
      child.kill();
      finish();
    }, STOP_SESSION_TIMEOUT_MS);
    child.on('close', finish);
    child.on('error', err => {
      console.error('[stopSession] claude stop 프로세스를 실행하지 못했습니다:', err);
      finish();
    });
  });
}

// 같은 팀장(leadId)에 대한 stop/resume류 작업(채팅 전송·요청 승인/거부·재시작·팀원 추가 알림)이
// 동시에 실행되면 세션이 복사본으로 갈라지거나 메시지가 엇갈릴 수 있다(stopSession 주석 참고) —
// 그래서 leadId별로 이전 작업이 끝난 뒤에만 다음 작업이 시작되도록 직렬화한다.
const leadOperationQueues = new Map<string, Promise<unknown>>();

function queueLeadOperation<T>(leadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = leadOperationQueues.get(leadId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  leadOperationQueues.set(leadId, run.then(() => undefined, () => undefined));
  return run;
}

// 큐에서 대기하는 동안 앞선 작업이 이미 이 팀장의 짧은 id를 바꿔놨을 수 있으므로, 넘겨받은 값을
// 그대로 믿지 않고 sessionId(안 바뀜)로 leads.json에서 최신 레코드를 다시 찾아서 사용한다.
// 호출부는 반드시 queueLeadOperation(leadId, ...)으로 감싸서 호출해야 한다.
async function resumeLead(sessionId: string, targetDir: string, message: string): Promise<string | null> {
  const current = loadLeads().find(l => l.sessionId === sessionId);
  if (!current) return null;
  await stopSession(current.id);
  const newId = await runClaudeBg(['--bg', '--resume', sessionId, message], targetDir);
  // stop 후 resume하면 보통 같은 짧은 id로 깨어나지만(실측 확인), 혹시 달라지는 경우를 대비해 갱신해둔다.
  if (newId && newId !== current.id) {
    const leads = loadLeads();
    const rec = leads.find(l => l.sessionId === sessionId);
    if (rec) { rec.id = newId; saveLeads(leads); }
  }
  return newId;
}

// 지금 대화 맥락을 이어받지 않고, 같은 디렉토리에서 완전히 새 세션을 시작해서 같은 팀장 슬롯(id는
// 바뀌지만 leads.json 레코드 자체와 이름표는 유지)에 덮어씌운다 — /clear 후 새 작업을 맡기는 느낌.
// resumeLead와 마찬가지로 호출부는 queueLeadOperation(leadId, ...)으로 감싸야 한다.
async function restartLead(sessionId: string, targetDir: string, instruction: string): Promise<string | null> {
  const current = loadLeads().find(l => l.sessionId === sessionId);
  if (!current) return null;
  await stopSession(current.id);
  installTeamLeadSkill();
  const { paths: approvedMembers, text: approvedText } = approvedMemberBriefing();
  const prompt = `/team-lead ${instruction}\n\n${approvedText}`;

  const newId = await runClaudeBg(['--bg', prompt], targetDir);
  if (!newId) return null;
  const newSessionId = (await findSessionIdByShortId(newId)) ?? newId;

  const leads = loadLeads();
  const rec = leads.find(l => l.sessionId === sessionId);
  if (rec) {
    rec.id = newId;
    rec.sessionId = newSessionId;
    rec.launchedAt = Date.now();
    rec.approvedMembers = approvedMembers;
    saveLeads(leads);
  }
  return newId;
}

// "작업 종료" — 이 팀장이 띄운 팀원을 전부 먼저 끄고, 마지막에 팀장 자신을 끈다. 팀장 기록은
// leads.json에서 지우지 않는다 — 다른 "종료"와 마찬가지로 오프라인/히스토리로 남아서 나중에
// --resume으로 다시 부를 수 있어야 한다(완전 삭제가 아니라 "지금은 멈춤"이라는 의미).
async function endLeadWork(sessionId: string): Promise<void> {
  const lead = loadLeads().find(l => l.sessionId === sessionId);
  if (!lead) return;
  const members = loadMembers().filter(m => m.leadId === lead.id);
  for (const m of members) {
    await stopSession(m.memberId);
    try { fs.unlinkSync(path.join(MEMBERS_DIR, `${m.memberId}.json`)); } catch { /* ignore */ }
  }
  await stopSession(lead.id);
}

async function findSessionIdByShortId(shortId: string): Promise<string | null> {
  const agents = await fetchAgents();
  return agents.find(a => a.id === shortId)?.sessionId ?? null;
}

async function launchTeamLead(targetDir: string, instruction: string): Promise<string | null> {
  installTeamLeadSkill();
  const { paths: approvedMembers, text: approvedText } = approvedMemberBriefing();
  const prompt = `/team-lead ${instruction}\n\n${approvedText}`;

  const id = await runClaudeBg(['--bg', prompt], targetDir);
  if (!id) return null;

  // 막 시작한 세션은 첫 턴을 처리 중일 수 있어 곧바로 stop시키면 방해가 된다 — 그래서 이 시점엔 자기 id를
  // 알려주는 후속 메시지를 보내지 않는다(위험). 대신 SKILL.md가 스스로 `claude agents --json`으로 자기
  // cwd에 맞는 id를 찾도록 안내한다.
  const sessionId = (await findSessionIdByShortId(id)) ?? id;

  const leads = loadLeads();
  leads.push({ id, sessionId, targetDir, launchedAt: Date.now(), approvedMembers });
  saveLeads(leads);

  return id;
}

// 터미널에서 사용자가 직접 `claude --bg "/team-lead ..."`로 띄운 세션을 나중에 이 앱에 등록해서
// 모니터링/대화창에 편입시킨다. background 세션만 대상 — interactive(사용자가 타이핑 중인 진짜
// 터미널) 세션은 stop으로 재우고 깨우는 게 위험해서 지원하지 않는다(짧은 id 자체가 없기도 함).
async function getAdoptableSessions(): Promise<AgentEntry[]> {
  const agents = await fetchAgents();
  const leads = loadLeads();
  const members = loadMembers();
  const trackedIds = new Set([...leads.map(l => l.id), ...members.map(m => m.memberId)]);
  return agents
    .filter(a => a.kind === 'background' && !!a.id && !trackedIds.has(a.id))
    // 방금 뜬 세션이 위로 오게 최신순 — 예전에 방치된 세션(며칠~몇 달 전)이 맨 위를 차지해서
    // "지금 막 띄운 게 이거였나?" 헷갈리는 걸 막는다.
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

// "세션 정리" 탭 전용 — 지금 떠있는 모든 백그라운드 세션(팀장/팀원으로 등록된 것 포함, 좀비도 포함)을
// 보여준다. 작업 화면(연결 흐름)과 완전히 분리해서, 실수로 잘못 끄는 사고를 줄인다.
async function getAllBackgroundSessions(): Promise<(AgentEntry & { tag: 'lead' | 'member' | 'untracked' })[]> {
  const agents = await fetchAgents();
  const leadIds = new Set(loadLeads().map(l => l.id));
  const memberIds = new Set(loadMembers().map(m => m.memberId));
  return agents
    .filter(a => a.kind === 'background' && !!a.id)
    .map(a => ({
      ...a,
      tag: (leadIds.has(a.id!) ? 'lead' : memberIds.has(a.id!) ? 'member' : 'untracked') as 'lead' | 'member' | 'untracked',
    }))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

async function adoptLead(shortId: string): Promise<string | null> {
  const agents = await fetchAgents();
  const agent = agents.find(a => a.id === shortId && a.kind === 'background');
  if (!agent) return null;
  installTeamLeadSkill();
  const { paths: approvedMembers } = approvedMemberBriefing();
  const leads = loadLeads();
  leads.push({
    id: agent.id!,
    sessionId: agent.sessionId,
    targetDir: agent.cwd,
    launchedAt: agent.startedAt ?? Date.now(),
    approvedMembers,
  });
  saveLeads(leads);
  return agent.id!;
}

// interactive 세션(사용자가 지금 타이핑 중일 수도 있는 진짜 터미널)은 직접 이어받을 수 없다 —
// 대신 그 세션의 sessionId로 `--resume`을 걸면, 원본이 아직 살아있으니 CLI가 자동으로 "복사본"을
// 새 짧은id로 만들어준다(실측 확인). 원본 인터랙티브 세션은 전혀 건드리지 않는다.
async function getInteractiveSessions(): Promise<AgentEntry[]> {
  const agents = await fetchAgents();
  return agents
    .filter(a => a.kind === 'interactive')
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

async function forkSessionAsLead(sessionId: string, cwd: string): Promise<string | null> {
  installTeamLeadSkill();
  const id = await runClaudeBg(
    ['--bg', '--resume', sessionId, '지금 이 대화를 Claude Team Monitor로 가져왔습니다(별도 복사본, 원본 세션과는 별개). 계속 진행하세요.'],
    cwd,
  );
  if (!id) return null;
  const newSessionId = (await findSessionIdByShortId(id)) ?? id;
  const { paths: approvedMembers } = approvedMemberBriefing();
  const leads = loadLeads();
  leads.push({ id, sessionId: newSessionId, targetDir: cwd, launchedAt: Date.now(), approvedMembers });
  saveLeads(leads);
  return id;
}

function registerMember(member: MemberRecord): void {
  try {
    writeJsonFileAtomic(path.join(MEMBERS_DIR, `${member.memberId}.json`), member);
  } catch (err) {
    console.error('[registerMember] 팀원 등록 파일 저장 실패:', err);
  }
}

// 팀원은 사람이 실시간으로 지켜보는 세션이 아니다 — 이 브리핑 없이 그냥 지시문만 던지면, 스킬을
// 하나 물고 개인 인터랙티브 세션처럼 굴다가 애매하면 "어느 경로를 리뷰할까요?" 식으로 되묻고
// 멈춰버린다(실측: 아무도 안 보고 있으니 그 질문엔 영원히 답이 안 옴). 그래서 모든 팀원 프롬프트
// 맨 앞에 이 원칙을 박아넣는다.
const TEAM_MEMBER_BRIEFING = '너는 지금 "팀장" 세션이 배정한 "팀원" 세션이다. 사람이 실시간으로 지켜보며 답해주는 세션이 아니니, 중간에 사용자에게 되묻지 말고 스스로 판단해서 진행해라. 정보가 부족하면 저장소 안에서 직접 조사해서 합리적으로 판단하고, 정말로 진행이 불가능할 때만 왜 막혔는지를 최종 답변에 명확히 남기고 멈춰라(질문만 던지고 끝내지 마라). 작업을 마치면 무엇을 확인했고 결과가 무엇인지 최종 답변에 구조적으로 정리해라 — 그 답변이 팀장에게 전달되는 유일한 보고 내용이다.';

// 팀장이 알아서 판단해서 띄우는 것과 별개로, 사용자가 직접 특정 역할(코드리뷰 등)을 주고
// 팀원을 띄운다 — 어떤 팀장 소속으로 붙일지는 사용자가 고른다(대화창에서 선택 중인 팀장 등).
async function launchMember(leadId: string, targetDir: string, instruction: string, role: string): Promise<string | null> {
  // role은 화면 라벨용 메타데이터에 그치지 않고, Claude 세션 자신도 알 수 있게 프롬프트에 박아준다.
  const roleLine = role ? `역할: ${role}\n\n` : '';
  const prompt = `${TEAM_MEMBER_BRIEFING}\n\n${roleLine}${instruction}`;
  const id = await runClaudeBg(['--bg', prompt], targetDir);
  if (!id) return null;
  registerMember({ memberId: id, leadId, dir: targetDir, createdAt: Date.now(), role: role || undefined });

  // 팀장이 스스로 띄운 게 아니라서 알려주지 않으면 이 팀원의 존재도 결과도 영원히 모른다 — 다만
  // 팀장이 지금 다른 작업으로 busy일 수 있어서 즉시 stop→resume으로 끼어들지 않고 큐에 쌓아둔다.
  // buildSessionRows가 폴링마다 이 큐를 보고, 팀장이 idle/blocked가 됐을 때만 실제로 전달한다.
  queueLeadNotice(leadId, `[알림] 사용자가 직접 팀원을 추가했습니다 — 디렉토리: ${targetDir}${role ? `, 역할: ${role}` : ''}, 지시: "${instruction}", 세션 id: ${id}. 이 팀원은 네가 띄운 게 아니니 필요하면 관리 대상에 추가하고, 완료되면 확인해서 최종 보고에 포함시켜라.`);

  return id;
}

let mainWindow: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(app.getAppPath(), 'renderer', 'index.html'));

  const poll = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { rows, requests } = await buildSessionRows();
    mainWindow.webContents.send('agents-update', { rows, requests });
  };
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);

  mainWindow.on('closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    mainWindow = null;
  });
}

ipcMain.handle('pick-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('get-favorites', () => loadFavorites());

ipcMain.handle('add-favorite', (_e, dir: string) => {
  const favs = loadFavorites();
  if (!favs.some(f => f.path === dir)) favs.push({ path: dir, name: path.basename(dir) });
  saveFavorites(favs);
  return favs;
});

ipcMain.handle('remove-favorite', (_e, dir: string) => {
  const favs = loadFavorites().filter(f => f.path !== dir);
  saveFavorites(favs);
  return favs;
});

ipcMain.handle('update-favorite-name', (_e, dir: string, name: string) => {
  const favs = loadFavorites();
  const f = favs.find(x => x.path === dir);
  if (f) { f.name = name || path.basename(dir); saveFavorites(favs); }
  return favs;
});

ipcMain.handle('launch-team-lead', async (_e, targetDir: string, instruction: string) => {
  const finalInstruction = instruction || '지금 상황을 파악하고 다음 작업을 시작해줘.';
  return launchTeamLead(targetDir, finalInstruction);
});

ipcMain.handle('get-adoptable-sessions', () => getAdoptableSessions());

ipcMain.handle('get-all-background-sessions', () => getAllBackgroundSessions());

ipcMain.handle('stop-background-session', async (_e, shortId: string) => {
  await stopSession(shortId);
  return getAllBackgroundSessions();
});

// 작업 탭 카드에서 "새로고침"/"삭제"를 눌렀을 때 3초 폴링을 기다리지 않고 바로 최신 보드를 준다.
ipcMain.handle('refresh-board', () => buildSessionRows());

ipcMain.handle('adopt-lead', async (_e, shortId: string) => adoptLead(shortId));

ipcMain.handle('get-interactive-sessions', () => getInteractiveSessions());

ipcMain.handle('fork-session-as-lead', async (_e, sessionId: string, cwd: string) => forkSessionAsLead(sessionId, cwd));

ipcMain.handle('get-member-templates', () => loadMemberTemplates());

ipcMain.handle('add-member-template', (_e, category: 'worker' | 'general', dir: string, name: string, role: string, instruction: string) => {
  const templates = loadMemberTemplates();
  templates.push({
    id: `tpl-${Date.now()}`,
    category,
    path: category === 'worker' ? dir : undefined,
    name: name || (category === 'worker' ? path.basename(dir) : (role || '역할')),
    role: role || '',
    instruction: instruction || '',
    approved: false,
  });
  saveMemberTemplates(templates);
  return templates;
});

ipcMain.handle('update-member-template', (_e, id: string, fields: Partial<Pick<MemberTemplate, 'name' | 'role' | 'instruction'>>) => {
  const templates = loadMemberTemplates();
  const t = templates.find(x => x.id === id);
  if (t) { Object.assign(t, fields); saveMemberTemplates(templates); }
  return templates;
});

ipcMain.handle('toggle-member-template-approved', (_e, id: string) => {
  const templates = loadMemberTemplates();
  const t = templates.find(x => x.id === id);
  if (t) { t.approved = !t.approved; saveMemberTemplates(templates); }
  return templates;
});

ipcMain.handle('delete-member-template', (_e, id: string) => {
  saveMemberTemplates(loadMemberTemplates().filter(t => t.id !== id));
  return loadMemberTemplates();
});

ipcMain.handle('launch-member', async (_e, leadId: string, targetDir: string, instruction: string, role: string) =>
  launchMember(leadId, targetDir, instruction, role));

ipcMain.handle('approve-request', async (_e, requestId: string) => {
  const req = writeRequestDecision(requestId, 'approved');
  if (!req) return false;
  const leads = loadLeads();
  const lead = leads.find(l => l.id === req.teamLeadId);
  if (!lead) return false;

  if (req.type === 'stop-member') {
    if (req.memberId) await stopSession(req.memberId);
    await queueLeadOperation(req.teamLeadId, () =>
      resumeLead(lead.sessionId, lead.targetDir, `팀원 종료 요청이 승인됐습니다 — "${req.memberId}" 세션을 종료했습니다. 계속 진행하세요.`));
    return true;
  }

  if (!lead.approvedMembers.includes(req.requestedDir!)) {
    lead.approvedMembers.push(req.requestedDir!);
    saveLeads(leads);
  }
  await queueLeadOperation(req.teamLeadId, () =>
    resumeLead(lead.sessionId, lead.targetDir, `팀원 요청이 승인됐습니다 — "${req.requestedDir}"에 팀원을 띄워도 됩니다. 이어서 진행하세요.`));
  return true;
});

ipcMain.handle('deny-request', async (_e, requestId: string) => {
  const req = writeRequestDecision(requestId, 'denied');
  if (!req) return false;
  const leads = loadLeads();
  const lead = leads.find(l => l.id === req.teamLeadId);
  if (!lead) return false;

  if (req.type === 'stop-member') {
    await queueLeadOperation(req.teamLeadId, () =>
      resumeLead(lead.sessionId, lead.targetDir, `팀원 종료 요청이 거부됐습니다 — "${req.memberId}"는 종료하지 말고 계속 두세요.`));
    return true;
  }

  await queueLeadOperation(req.teamLeadId, () =>
    resumeLead(lead.sessionId, lead.targetDir, `팀원 요청이 거부됐습니다 — "${req.requestedDir}"에는 팀원을 띄우지 마세요. 다른 방법을 찾거나 사용자에게 다시 확인하세요.`));
  return true;
});

ipcMain.handle('get-lead-transcript', (_e, leadId: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return [];
  const projectName = resolveProjectName(lead.sessionId, lead.targetDir);
  return getTranscript(projectName, lead.sessionId);
});

ipcMain.handle('send-to-lead', async (_e, leadId: string, message: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return null;
  return queueLeadOperation(leadId, () => resumeLead(lead.sessionId, lead.targetDir, message));
});

ipcMain.handle('update-lead-label', (_e, leadId: string, label: string) => {
  const leads = loadLeads();
  const lead = leads.find(l => l.id === leadId);
  if (lead) { lead.label = label.trim(); saveLeads(leads); }
  return leads;
});

ipcMain.handle('restart-lead', async (_e, leadId: string, instruction: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return null;
  const finalInstruction = instruction.trim() || '지금 상황을 파악하고 다음 작업을 시작해줘.';
  return queueLeadOperation(leadId, () => restartLead(lead.sessionId, lead.targetDir, finalInstruction));
});

ipcMain.handle('end-lead-work', async (_e, leadId: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return false;
  await queueLeadOperation(leadId, () => endLeadWork(lead.sessionId));
  return true;
});

// 세션 짧은 id는 claude CLI가 hex 문자열로만 발급하지만(runClaudeBg의 정규식 참고), 렌더러에서
// 넘어온 값을 그대로 shell:true 명령 문자열에 심는 것이므로 방어적으로 형식을 한 번 더 검증한다.
const SESSION_SHORT_ID_RE = /^[A-Za-z0-9_-]+$/;

ipcMain.handle('open-in-terminal', (_e, sessionShortId: string) => {
  if (typeof sessionShortId !== 'string' || !SESSION_SHORT_ID_RE.test(sessionShortId)) {
    console.error('[open-in-terminal] 유효하지 않은 세션 id라 거부합니다:', sessionShortId);
    return;
  }
  // claude attach는 인터랙티브 터미널이 필요해서, 새 콘솔 창을 띄워 그 안에서 attach를 실행한다.
  const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', `claude attach ${sessionShortId}`], {
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.on('error', err => console.error('[open-in-terminal] 터미널을 여는 데 실패했습니다:', err));
  child.unref();
});

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  // 이미 다른 인스턴스가 떠있다 — leads.json 등 공유 파일을 두 프로세스가 동시에 건드리면 정합성이
  // 깨지므로(동시 폴링·저장 경합), 새로 뜬 이 인스턴스는 즉시 종료한다.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
