import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec, execFile, spawn } from 'child_process';

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

// "팀원 등록(역할 템플릿)" — 재사용 가능한 팀원 정의. 서로 독립적인 두 축으로 정해진다:
// - scope(소속): 'shared'면 모든 팀장이 쓸 수 있고, 특정 디렉토리 경로면 그 디렉토리에서 도는
//   팀장만 이 템플릿을 브리핑받는다. 팀장은 stop/resume을 거치며 짧은 id가 계속 바뀌므로, 안정적인
//   식별자로 팀장 자신의 디렉토리(targetDir)를 "소속" 값으로 쓴다.
// - path(디렉토리): 이 팀원이 실제로 일할 디렉토리. 있으면 그 안에서만, 없으면 쓸 때마다 그때그때
//   고른다. approved는 path가 있을 때만 의미 있다(사전승인이면 매번 체크박스 없이 자동 브리핑).
type MemberTemplate = {
  id: string;
  scope: string; // 'shared' | <팀장 디렉토리 경로>
  path?: string;
  name: string;
  role: string;
  instruction: string;
  approved: boolean; // path가 있을 때만 의미 있음
};

type LeadRecord = {
  id: string; // claude --bg 가 돌려주는 짧은 id (claude agents --json 매칭·attach/logs/stop용)
  sessionId: string; // 전체 UUID (--resume은 반드시 이걸로 해야 같은 세션이 이어짐, 짧은 id를 주면 복사본이 갈라짐)
  targetDir: string;
  launchedAt: number;
  approvedMembers: string[];
  label?: string; // 사용자가 직접 붙인 이름표 — 같은 디렉토리에서 팀장을 여러 개 띄웠을 때 구분용
  aiTitle?: string; // claude가 자동 생성한 세션 주제(네이티브 --resume 목록에 뜨는 것과 같은 것) — 한 번 찾으면 캐싱
  // restartLead가 id/sessionId를 새 값으로 갈아치워도 절대 바뀌지 않는 내부 전용 식별자(레코드
  // 생성 시 한 번만 발급). queueLeadOperation의 큐 키와 PendingNotice가 팀장을 가리키는 값으로
  // 이걸 쓴다 — 그래야 재시작 도중/직후에 큐잉된 다른 작업(채팅 전송·요청 승인/거부·팀원 알림 등)이
  // 재시작 전에 캡처해둔 옛 sessionId/짧은id로 leads.json을 다시 찾다가 못 찾아서 조용히
  // 무동작으로 끝나는 일이 없다. 렌더러에는 노출하지 않는 백엔드 전용 값이다.
  internalId: string;
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
// 끊기지 않도록 알림을 큐에 쌓아뒀다가 idle/blocked일 때만 전달한다. id는 렌더러가 "이 항목이
// 아직 전달됐는지/취소됐는지"를 개별적으로 추적할 수 있게 하는 용도다(같은 팀장에게 여러 개가
// 동시에 쌓일 수 있어서 leadId만으로는 항목을 구분할 수 없다 — cancel-queued-message 참고).
// leadInternalId는 LeadRecord.internalId다(짧은 id가 아님) — restartLead가 짧은 id/sessionId를
// 바꿔도 큐에 쌓인 알림이 여전히 같은 팀장을 가리켜야 하기 때문이다.
type PendingNotice = { id: string; leadInternalId: string; message: string; createdAt: number };

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

// "변경 파일"은 처음엔 daily-journal의 편집 기록(PostToolUse 훅 버퍼)을 썼는데, Bash로 직접 손대거나
// 서브에이전트를 거치는 경로는 그 기록에 안 잡히는 걸 실측으로 확인하고 git 상태 조회로 바꿨다.
// 그 다음엔 "이 세션이 건드린 것만" 보여주려고 mtime으로 필터링했는데, 실제로 사용자가 원한 건
// 그게 아니라 "지금 커밋+푸시하면 뭐가 들어가는지"였다 — 그건 이 필터링 없이 그냥 git의 현재
// 미커밋 상태 그대로가 정답이다(git add -A로 커밋할 때 포함될 것과 정확히 같다). 그래서 다시
// mtime 필터 없이 git status 원본을 그대로 보여주는 걸로 되돌렸다.
function getGitChangedFiles(cwd: string): Promise<{ file: string; status: string }[]> {
  return new Promise(resolve => {
    exec('git status --porcelain', { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve([]); return; } // git 저장소가 아니거나 git이 없으면 빈 목록
      const files = stdout.split('\n')
        .map(l => l.replace(/\r$/, ''))
        .filter(Boolean)
        .map(l => ({ status: l.slice(0, 2).trim() || '?', file: l.slice(3).trim() }));
      resolve(files);
    });
  });
}

// file 인자에 상대경로 탈출(예: "../../../../etc/passwd")이 섞여 있으면 path.join(cwd, file)이
// cwd 밖의 임의 파일을 가리킬 수 있다 — 실제로 join한 절대경로가 cwd 하위인지 확인해서, 벗어나면
// null을 돌려줘 호출부가 거부하게 한다.
function resolveWithinCwd(cwd: string, file: string): string | null {
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(cwd, file);
  if (resolvedFile !== resolvedCwd && !resolvedFile.startsWith(resolvedCwd + path.sep)) return null;
  return resolvedFile;
}

// 목록의 파일 하나를 눌렀을 때 실제 내용을 보여준다. git이 추적 중인 변경이면 diff를, 아직 추적
// 안 되는 새 파일(untracked)이면 diff 대상이 없으므로 파일 내용 자체를 "전부 추가"로 보여준다.
// HEAD와 비교해야 한다 — `git diff --`(워킹트리 대 인덱스)만 쓰면 git add로 스테이징만 해두고
// 추가 수정이 없는 파일은 diff가 비어서 새 파일로 오판돼 전체 내용이 "전부 추가"로 보인다.
// HEAD가 아직 없는(커밋 0개) 저장소에서는 이 명령 자체가 실패하는데, 그 경우엔 사실상 모든 파일이
// 진짜 새 파일이므로 아래 catch(=untracked 처리) 경로로 폴백되는 게 오히려 맞다.
function getFileDiff(cwd: string, file: string): Promise<{ diff: string; isNew: boolean; binary: boolean }> {
  return new Promise(resolve => {
    const resolvedFile = resolveWithinCwd(cwd, file);
    if (!resolvedFile) {
      console.error('[getFileDiff] cwd 밖을 가리키는 file 인자를 거부합니다:', { cwd, file });
      resolve({ diff: '', isNew: false, binary: false });
      return;
    }
    execFile('git', ['diff', 'HEAD', '--', file], { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (!err && stdout.trim()) {
        resolve({ diff: stdout, isNew: false, binary: /^Binary files /m.test(stdout) });
        return;
      }
      try {
        const buf = fs.readFileSync(resolvedFile);
        const isBinary = buf.subarray(0, 8000).includes(0); // NUL 바이트가 있으면 텍스트가 아닌 걸로 간주
        resolve({ diff: isBinary ? '' : buf.toString('utf-8'), isNew: true, binary: isBinary });
      } catch {
        resolve({ diff: '', isNew: true, binary: false });
      }
    });
  });
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
// 팀원 등록·승인 요청 같은 JSON 파일은 팀장(LLM)이 직접 손으로 써서 만든다 — 실측으로, Windows
// 경로(`C:\Users\...`)를 JSON 이스케이프 없이 그냥 넣는 실수가 실제로 나왔다("\U", "\P" 등은
// 유효한 JSON 이스케이프가 아니라 파싱 자체가 깨짐). 이러면 등록이 통째로 무시돼서 팀원이 화면에
// 아예 안 뜨는 심각한 문제로 이어지므로, 파싱에 실패하면 유효한 JSON 이스케이프
// (\" \\ \/ \b \f \n \r \t \uXXXX)가 아닌 백슬래시를 전부 두 번 이스케이프해서 한 번 더 시도한다.
function repairLooseBackslashes(raw: string): string {
  return raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

function readJsonFileSafe<T>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      return JSON.parse(repairLooseBackslashes(raw)) as T;
    } catch {
      return null;
    }
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

// 이 필드를 추가하기 전에 만들어진 leads.json 레코드는 internalId가 없다 — 처음 읽을 때 한 번
// 발급해서 즉시 저장해두면, 이후로는 다른 마이그레이션 없이 계속 같은 값을 쓸 수 있다.
function loadLeads(): LeadRecord[] {
  const leads = readJsonArraySafe<LeadRecord>(LEADS_PATH);
  let dirty = false;
  leads.forEach(l => {
    if (!l.internalId) {
      l.internalId = crypto.randomUUID();
      dirty = true;
    }
  });
  if (dirty) saveLeads(leads);
  return leads;
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

// 생성한 알림의 id를 반환한다 — 채팅 큐잉처럼 호출부가 나중에 이 항목을 특정해서 취소해야 하는
// 경우에 쓴다(다른 호출부는 반환값을 그냥 무시해도 된다). leadInternalId는 LeadRecord.internalId다.
function queueLeadNotice(leadInternalId: string, message: string): string {
  const notices = loadPendingNotices();
  const id = `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  notices.push({ id, leadInternalId, message, createdAt: Date.now() });
  savePendingNotices(notices);
  return id;
}

// 아직 전달 안 된 대기열 항목을 사용자가 직접 취소할 수 있게 한다. 렌더러는 짧은 id(화면 표시용)만
// 알고 있으므로 여기서 internalId로 변환해서 대조한다 — 다른 팀장의 것을 실수로 건드리지 않게.
// 짧은 id가 이미 바뀌어서(재시작 등) 지금 못 찾더라도, id 자체가 이미 전역적으로 고유하므로
// noticeId만으로 대조해 사용자가 화면에서 보고 누른 항목은 항상 취소되게 한다.
// 이미 전달됐거나(폴링이 먼저 소모함) 이미 취소돼서 못 찾으면 false — 렌더러는 이 경우도 로컬
// 상태만 정리하고 조용히 넘어간다.
function cancelQueuedNotice(leadShortId: string, noticeId: string): boolean {
  const notices = loadPendingNotices();
  const leadRec = loadLeads().find(l => l.id === leadShortId);
  const filtered = notices.filter(n => {
    if (n.id !== noticeId) return true;
    if (leadRec && n.leadInternalId !== leadRec.internalId) return true;
    return false;
  });
  if (filtered.length === notices.length) return false;
  savePendingNotices(filtered);
  return true;
}

// 팀원이 busy → idle/done으로 바뀌는 순간(=일을 마쳤을 가능성)을 감지하려고 폴링마다 마지막으로
// 본 상태를 기억해둔다. 앱을 껐다 켜면 초기화되지만(=재부팅 직후 이미 끝나있던 건 못 잡음), 계속
// 켜둔 동안엔 문제없다. 이게 없으면 팀장이 스스로 확인할 계기가 없어서 팀원 보고가 영영 팀장(=이
// 앱 화면)에 안 올라온다.
const lastMemberStatus = new Map<string, string>();

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

// 유예 기간이 지난, 멀쩡히 동작 중이던 팀원도 claude stop→resume되는 그 짧은 순간(프로세스가 잠깐
// 사라졌다가 새 pid로 재기동되는 구간)엔 agents 스냅샷에서 한 번 빠질 수 있다(실측 재현됨 — 살아있는
// 팀원 4명의 등록 파일이 단 한 번의 폴링 미스로 전부 삭제됨). 그래서 한 번 빠진 것만으로 바로 지우지
// 않고, 일정 시간(MEMBER_MISS_GRACE_MS) 안에 다시 잡히면 봐준다.
//
// 처음엔 "연속으로 N번 못 잡혔을 때만" 식의 폴링 횟수 기반 카운터였는데, renderer.js의
// sendChatMessage가 채팅 전송 직후 refreshBoardNow()로 buildSessionRows()를 즉시 한 번 더
// 호출하도록 바뀌면서(3초 정기 폴링과는 별개로) 회귀가 생겼다 — 팀장 프로세스가 실제로
// 재기동되기도 전에 그 즉시호출이 미스 카운트를 1 소모해버려서, 정기 폴링이 3초 뒤 딱 한 번만
// 더 못 잡혀도 threshold(2)에 도달해 곧바로 오프라인/삭제 처리됐다(실측 재현됨 — "채팅 보내면
// 팀장/팀원 목록이 통째로 사라졌다가 그다음 폴링에 다시 뜸"). 즉 "폴링 몇 번"은 buildSessionRows가
// 얼마나 자주 불리는지에 따라 실제 경과 시간이 고무줄처럼 늘었다 줄었다 해서 유예 시간을 보장하지
// 못한다. 그래서 횟수 대신 "처음 못 잡힌 시각"을 저장해두고 실제 경과 시간으로 판단한다 —
// buildSessionRows가 짧은 간격으로 몇 번을 더 불리든(즉시호출+정기폴링 등) 결과가 달라지지 않는다.
// memberId별 값은 폴링 사이에도 유지해야 하므로 모듈 스코프에 둔다.
const MEMBER_MISS_GRACE_MS = 8000;
const memberFirstMissAt = new Map<string, number>();

// 팀장도 팀원 정리와 완전히 같은 TOCTOU를 겪는다 — 멀쩡히 응답 중이던 팀장도 채팅을 보낼 때마다
// stop→resume이 도는데, 그 짧은 재기동 구간엔 agents 스냅샷에서 한 번 빠질 수 있다. 그 순간 바로
// "오프라인"으로 분류해버리면 온라인 목록(카드)에서 사라지고 히스토리 탭으로 밀려난다(채팅을 자주
// 보낼수록 자주 재현됨). 팀원과 동일한 이유로, 그리고 팀원과 똑같이 카운터 기반이었다가 겪은 같은
// 회귀 때문에(위 MEMBER_MISS_GRACE_MS 주석 참고) "처음 못 잡힌 시각" 기준으로 판단한다.
const LEAD_OFFLINE_GRACE_MS = 8000;
const leadFirstMissAt = new Map<string, number>();

// 보드에는 "내가 띄운 팀장"과 "팀장이 등록한 팀원"만 보여준다 — 그 외(사용자가 따로 열어둔 무관한
// 세션 등)는 team-lead 체계 밖이므로 제외한다. interactive 세션은 애초에 짧은 id가 없어서 자동으로 빠진다.
async function buildSessionRowsInternal(): Promise<{ rows: SessionRow[]; requests: MemberRequest[] }> {
  // 아래 leadFirstMissAt/memberFirstMissAt 유예 판정에 쓸 기준 시각 — 이 함수 실행 도중 한 번만
  // 고정해서 재는다(같은 호출 안에서 Date.now()를 여러 번 부르며 값이 갈리는 걸 방지).
  const now = Date.now();
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

  // 팀원이 busy → idle/done으로 바뀌면 팀장에게 확인해보라고 알려준다(큐에 쌓였다가 팀장이
  // idle/blocked일 때 전달됨 — 아래 pendingNotices 처리 로직 재사용).
  liveRows.filter(r => !r.isLead).forEach(r => {
    const status = (r.status || r.state || '').toLowerCase();
    const prevStatus = lastMemberStatus.get(r.id!);
    if (prevStatus === 'busy' && status && status !== 'busy' && r.leadId) {
      // MemberRecord.leadId는 등록 당시의 짧은 id라 그 뒤로 팀장이 재시작됐으면 이미 낡은 값일 수
      // 있다 — 지금 이 폴링 시점 기준으로 leads에서 다시 찾아 internalId로 바꿔서 큐잉한다.
      const leadRecForMember = leads.find(l => l.id === r.leadId);
      if (leadRecForMember) {
        queueLeadNotice(
          leadRecForMember.internalId,
          `[알림] 팀원 ${r.id}(${r.cwd}${r.role ? `, 역할: ${r.role}` : ''})가 작업을 마친 것 같습니다(상태: ${status}). stop→resume으로 "방금 한 작업을 한국어로 짧게 요약해줘"처럼 확인하고, 결과를 파악해서 필요하면 최종 보고에 반영하세요.`,
        );
      }
    }
    if (status) lastMemberStatus.set(r.id!, status);
  });

  // 대기 중인 팀원-추가 알림 중, 그 팀장이 지금 busy가 아니면(=억지로 끊어도 하던 작업이 없으면)
  // 이 타이밍에 stop→resume으로 실제 전달한다. busy면 다음 폴링까지 큐에 그대로 둔다.
  const pendingNotices = loadPendingNotices();
  if (pendingNotices.length > 0) {
    const stillPending: PendingNotice[] = [];
    for (const notice of pendingNotices) {
      const leadRec = leads.find(l => l.internalId === notice.leadInternalId);
      const liveAgent = leadRec ? agents.find(a => a.id === leadRec.id) : undefined;
      const isBusy = !!liveAgent && (liveAgent.status || liveAgent.state || '').toLowerCase() === 'busy';
      if (leadRec && liveAgent && !isBusy) {
        queueLeadOperation(leadRec.internalId, () => resumeLead(leadRec.internalId, notice.message))
          .catch(() => { /* 실패해도 알림 자체는 소모(재시도 안 함) */ });
        continue;
      }
      stillPending.push(notice);
    }
    if (stillPending.length !== pendingNotices.length) savePendingNotices(stillPending);
  }

  // 지금 떠있지 않은 팀장은 기록을 지우지 않고 "오프라인"으로 남겨둔다 — PC 재부팅 등으로 프로세스가
  // 죽어도 세션 자체는 claude 쪽에 남아있어서 --bg --resume으로 다시 깨울 수 있기 때문이다(대화창에서
  // 메시지를 보내면 자동으로 이 절차를 탄다, resumeLead 참고). 단, agents 스냅샷에 한 번 안 잡힌
  // 것만으로 바로 오프라인 처리하지 않는다(LEAD_OFFLINE_GRACE_MS 주석 참고) — 처음 못 잡힌
  // 시각으로부터 유예 시간이 지나기 전이면 이번 폴링에서만 목록에 안 잡히고, 다음 폴링에 스스로
  // 복구된다.
  const offlineLeads: LeadRecord[] = [];
  leads.forEach(l => {
    if (agentIdSet.has(l.id)) {
      leadFirstMissAt.delete(l.id);
      return;
    }
    const firstMissAt = leadFirstMissAt.get(l.id);
    if (firstMissAt === undefined) {
      leadFirstMissAt.set(l.id, now);
      return;
    }
    if (now - firstMissAt < LEAD_OFFLINE_GRACE_MS) return;
    offlineLeads.push(l);
  });
  // 다른 경로로 이미 사라진(현재는 없지만 혹시 모를) leadId의 기록을 정리해 Map이 무한정 자라지
  // 않게 한다 — 팀원 정리 로직과 동일한 방어.
  const currentLeadIds = new Set(leads.map(l => l.id));
  for (const key of leadFirstMissAt.keys()) {
    if (!currentLeadIds.has(key)) leadFirstMissAt.delete(key);
  }
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

  // 팀원은 팀장과 달리 일회성 하위 작업 단위라 이어할 필요가 적어서, 종료되면 정리한다 — 단,
  // 방금(MEMBER_CLEANUP_GRACE_MS 이내) 등록된 팀원은 봐주고(TOCTOU), 처음 못 잡힌 시각으로부터
  // MEMBER_MISS_GRACE_MS가 지나기 전이면(=stop→resume 재기동 구간일 수 있음) 아직 지우지 않는다.
  const currentMemberIds = new Set(members.map(m => m.memberId));
  members.forEach(m => {
    if (now - m.createdAt < MEMBER_CLEANUP_GRACE_MS) return;
    if (agentIdSet.has(m.memberId)) {
      memberFirstMissAt.delete(m.memberId);
      return;
    }
    const firstMissAt = memberFirstMissAt.get(m.memberId);
    if (firstMissAt === undefined) {
      memberFirstMissAt.set(m.memberId, now);
      return;
    }
    if (now - firstMissAt < MEMBER_MISS_GRACE_MS) return;
    memberFirstMissAt.delete(m.memberId);
    try { fs.unlinkSync(path.join(MEMBERS_DIR, `${m.memberId}.json`)); } catch { /* ignore */ }
  });
  // 등록 파일이 다른 경로(수동 종료 버튼 등)로 이미 사라진 memberId의 기록은 여기서 정리해야
  // Map이 무한정 자라지 않는다.
  for (const key of memberFirstMissAt.keys()) {
    if (!currentMemberIds.has(key)) memberFirstMissAt.delete(key);
  }

  const requests = loadPendingRequests();
  return { rows, requests };
}

// buildSessionRowsInternal은 이제 3초 정기 폴링뿐 아니라 refresh-board IPC(채팅 전송 직후 등)로도
// 짧은 간격에 겹쳐 호출될 수 있다. 겹쳐 호출된 두 번의 실행은 각자 다른 시점에 `claude agents --json`을
// 실행하는데(exec는 매번 새 프로세스를 띄우므로 소요 시간이 들쭉날쭉하다), 나중에 "시작"한 쪽이
// 시스템 부하 등으로 먼저 "완료"해버리면, 더 늦게 완료된(=먼저 시작했지만 더 느렸던) 호출의 오래된
// 스냅숏이 나중에 렌더러로 전달되어 방금 반영된 최신 상태(예: 막 idle로 바뀐 것)를 오래된 값(예:
// busy)으로 덮어써버릴 수 있다 — 실제로는 끝났는데 화면엔 계속 "작업중"으로 남는 것처럼 보이는
// 원인이 될 수 있다. 완료 순서가 항상 시작 순서와 같도록(=먼저 시작한 호출의 결과가 항상 먼저
// 반영되도록) 아래처럼 직렬화한다 — 겹쳐 호출되면 앞선 호출이 끝난 뒤에야 다음 호출이 실제로 시작된다.
let buildSessionRowsChain: Promise<unknown> = Promise.resolve();
function buildSessionRows(): Promise<{ rows: SessionRow[]; requests: MemberRequest[] }> {
  const run = buildSessionRowsChain.then(buildSessionRowsInternal, buildSessionRowsInternal);
  buildSessionRowsChain = run.catch(() => undefined);
  return run;
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

// 팀장을 새로 띄울 때마다 매번 체크박스를 켜지 않아도 되도록, "사전승인"이 켜지고 디렉토리(path)가
// 있는 템플릿은 항상 자동으로 그 팀장의 승인 목록에 들어간다. path가 없는 템플릿은 자동승인 대상이
// 될 수 없지만, "이런 역할이 있다"는 것 자체는 별도로 안내해서 팀장이 필요할 때 대상 디렉토리를
// 골라 활용하게 한다. scope가 'shared'가 아니면 그 디렉토리(callerDir)에서 도는 팀장에게만 보인다.
function approvedMemberBriefing(callerDir: string): { paths: string[]; text: string } {
  const templates = loadMemberTemplates().filter(t => t.scope === 'shared' || t.scope === callerDir);
  const approvedWithPath = templates.filter(t => t.approved && t.path);
  const withoutPath = templates.filter(t => !t.path);

  const parts: string[] = [];
  if (approvedWithPath.length > 0) {
    const lines = approvedWithPath.map(t =>
      `- ${t.path}${t.role ? ` (역할: ${t.role})` : ''}${t.instruction ? ` — 추천 지시: "${t.instruction}"` : ''}`);
    parts.push(`사전 승인된 팀원 디렉토리 목록(이 안에서는 바로 팀원을 띄워도 됨):\n${lines.join('\n')}`);
  } else {
    parts.push('사전 승인된 팀원 디렉토리가 없음 — 팀원이 필요하면 반드시 승인 요청부터 거쳐라.');
  }
  if (withoutPath.length > 0) {
    const lines = withoutPath.map(t =>
      `- ${t.name}(역할: ${t.role || '미지정'})${t.instruction ? ` — 기본 지시: "${t.instruction}"` : ''}`);
    parts.push(`특정 프로젝트에 묶이지 않은 역할(필요한 디렉토리에 적용해서 써라 — 그 디렉토리가 위 사전승인 목록에 없으면 승인 요청부터 거쳐라):\n${lines.join('\n')}`);
  }
  return { paths: approvedWithPath.map(t => t.path!), text: parts.join('\n\n') };
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

// 같은 팀장(internalId)에 대한 stop/resume류 작업(채팅 전송·요청 승인/거부·재시작·팀원 추가 알림)이
// 동시에 실행되면 세션이 복사본으로 갈라지거나 메시지가 엇갈릴 수 있다(stopSession 주석 참고) —
// 그래서 internalId별로 이전 작업이 끝난 뒤에만 다음 작업이 시작되도록 직렬화한다. 짧은 id(예:
// leadId IPC 파라미터)를 키로 쓰면 restartLead가 짧은 id를 바꿔치기했을 때 새 작업이 다른 큐로
// 갈라져서 직렬화가 깨지므로, 반드시 restartLead가 절대 바꾸지 않는 internalId를 키로 써야 한다.
const leadOperationQueues = new Map<string, Promise<unknown>>();

function queueLeadOperation<T>(internalId: string, fn: () => Promise<T>): Promise<T> {
  const prev = leadOperationQueues.get(internalId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  leadOperationQueues.set(internalId, run.then(() => undefined, () => undefined));
  return run;
}

// 큐에서 대기하는 동안 앞선 작업(예: 재시작)이 이미 이 팀장의 짧은 id/sessionId를 바꿔놨을 수
// 있으므로, 넘겨받은 값을 그대로 믿지 않고 internalId(절대 안 바뀜)로 leads.json에서 최신
// 레코드를 실행 시점에 다시 찾아서 사용한다. 호출부는 반드시 queueLeadOperation(internalId, ...)으로
// 감싸서 호출해야 한다.
async function resumeLead(internalId: string, message: string): Promise<string | null> {
  const current = loadLeads().find(l => l.internalId === internalId);
  if (!current) return null;
  await stopSession(current.id);
  const newId = await runClaudeBg(['--bg', '--resume', current.sessionId, message], current.targetDir);
  // stop 후 resume하면 보통 같은 짧은 id로 깨어나지만(실측 확인), 혹시 달라지는 경우를 대비해 갱신해둔다.
  if (newId && newId !== current.id) {
    const leads = loadLeads();
    const rec = leads.find(l => l.internalId === internalId);
    if (rec) { rec.id = newId; saveLeads(leads); }
  }
  return newId;
}

// 지금 대화 맥락을 이어받지 않고, 같은 디렉토리에서 완전히 새 세션을 시작해서 같은 팀장 슬롯(id는
// 바뀌지만 leads.json 레코드 자체와 이름표는 유지)에 덮어씌운다 — /clear 후 새 작업을 맡기는 느낌.
// resumeLead와 마찬가지로 호출부는 queueLeadOperation(internalId, ...)으로 감싸야 하고, 실행
// 시점에 internalId로 최신 레코드를 다시 찾아야 한다(같은 이유).
async function restartLead(internalId: string, instruction: string): Promise<string | null> {
  const current = loadLeads().find(l => l.internalId === internalId);
  if (!current) return null;
  await stopSession(current.id);
  installTeamLeadSkill();
  const { paths: approvedMembers, text: approvedText } = approvedMemberBriefing(current.targetDir);
  const prompt = `/team-lead ${instruction}\n\n${approvedText}`;

  const newId = await runClaudeBg(['--bg', prompt], current.targetDir);
  if (!newId) return null;
  const newSessionId = (await findSessionIdByShortId(newId)) ?? newId;

  const leads = loadLeads();
  const rec = leads.find(l => l.internalId === internalId);
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
// --resume으로 다시 부를 수 있어야 한다(완전 삭제가 아니라 "지금은 멈춤"이라는 의미). internalId로
// 실행 시점에 최신 레코드를 다시 찾는다(resumeLead/restartLead와 같은 이유).
async function endLeadWork(internalId: string): Promise<void> {
  const lead = loadLeads().find(l => l.internalId === internalId);
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
  const { paths: approvedMembers, text: approvedText } = approvedMemberBriefing(targetDir);
  const prompt = `/team-lead ${instruction}\n\n${approvedText}`;

  const id = await runClaudeBg(['--bg', prompt], targetDir);
  if (!id) return null;

  // 막 시작한 세션은 첫 턴을 처리 중일 수 있어 곧바로 stop시키면 방해가 된다 — 그래서 이 시점엔 자기 id를
  // 알려주는 후속 메시지를 보내지 않는다(위험). 대신 SKILL.md가 스스로 `claude agents --json`으로 자기
  // cwd에 맞는 id를 찾도록 안내한다.
  const sessionId = (await findSessionIdByShortId(id)) ?? id;

  const leads = loadLeads();
  leads.push({ id, sessionId, targetDir, launchedAt: Date.now(), approvedMembers, internalId: crypto.randomUUID() });
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
  const { paths: approvedMembers } = approvedMemberBriefing(agent.cwd);
  const leads = loadLeads();
  leads.push({
    id: agent.id!,
    sessionId: agent.sessionId,
    targetDir: agent.cwd,
    launchedAt: agent.startedAt ?? Date.now(),
    approvedMembers,
    internalId: crypto.randomUUID(),
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
  const { paths: approvedMembers } = approvedMemberBriefing(cwd);
  const leads = loadLeads();
  leads.push({ id, sessionId: newSessionId, targetDir: cwd, launchedAt: Date.now(), approvedMembers, internalId: crypto.randomUUID() });
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
// 맨 앞에 이 원칙을 박아넣는다. 지침이 여러 개라 가독성을 위해 항목별로 줄바꿈해서 이어붙인다 —
// 실제로 팀원에게 전달되는 내용(의미)은 한 줄이었을 때와 동일하다.
const TEAM_MEMBER_BRIEFING = [
  '너는 지금 "팀장" 세션이 배정한 "팀원" 세션이다. 사람이 실시간으로 지켜보며 답해주는 세션이 아니니, 중간에 사용자에게 되묻지 말고 스스로 판단해서 진행해라.',
  '정보가 부족하면 저장소 안에서 직접 조사해서 합리적으로 판단하고, 정말로 진행이 불가능할 때만 왜 막혔는지를 최종 답변에 명확히 남기고 멈춰라(질문만 던지고 끝내지 마라).',
  'AskUserQuestion 같은 화살표 선택형 인터랙티브 도구는 절대 쓰지 마라 — 백그라운드 세션이라 실제 터미널이 안 붙어있어서 그 메뉴에 아무도 응답할 수 없고, 세션이 그대로 영구히 멈춘다(텍스트로 되묻는 것보다 훨씬 심각하게 막힘).',
  '같은 이유로 EnterWorktree/ExitWorktree 도구도 쓰지 마라 — 사전 승인 안 된 경로로 permission root를 옮기려 하면 "진행할까요? Yes/No" 확인 프롬프트가 뜨는데 이것도 아무도 응답 못 해서 똑같이 멈춘다(실측 확인). 워크트리가 필요하면 `git worktree add <경로> <브랜치>`를 Bash로 직접 실행하고, 그 경로를 Edit/Write/Bash의 대상 경로로 그냥 지정해서 작업해라 — permission root 자체를 옮기는 도구만 피하면 된다.',
  '작업을 마치면 무엇을 확인했고 결과가 무엇인지 최종 답변에 구조적으로 정리해라 — 그 답변이 팀장에게 전달되는 유일한 보고 내용이다.',
].join('\n\n');

// launchMember로 처음 띄울 때 instruction을 곧바로 실행 지시로 붙이면, 실사용해보니 지시가
// 구체적일수록(예: "정합성/버그/로직 문제를 자세히 리뷰해라") 팀원이 팀장의 확인 없이 곧장 전체
// 작업을 스스로 벌여버려서 사용자가 당황하는 일이 잦았다. 그래서 최초 실행에서는 instruction을
// "앞으로 맡을 작업에 대한 참고용 사전 지시"로만 전달하고, 실제 개시는 항상 팀장이 이어서 보내는
// 다음 메시지에서 시작되도록 못 박는다 — 최초 실행은 항상 "대기" 상태로 끝나야 한다.
const TEAM_MEMBER_STANDBY_NOTE = '아래는 앞으로 맡을 작업에 대한 참고용 사전 지시다 — 이번 턴에서 곧바로 실행하지 마라. 내용을 확인했다는 짧은 준비 완료 응답만 남기고(예: "확인했습니다. 아래 작업을 맡을 준비가 됐습니다."), 실제로 작업을 시작하라는 팀장의 다음 메시지가 올 때까지 기다려라. 팀장이 다시 메시지를 보내기 전까지는 어떤 파일도 고치거나 만들지 마라.';

// 팀장이 알아서 판단해서 띄우는 것과 별개로, 사용자가 직접 특정 역할(코드리뷰 등)을 주고
// 팀원을 띄운다 — 어떤 팀장 소속으로 붙일지는 사용자가 고른다(대화창에서 선택 중인 팀장 등).
async function launchMember(leadId: string, targetDir: string, instruction: string, role: string): Promise<string | null> {
  // role은 화면 라벨용 메타데이터에 그치지 않고, Claude 세션 자신도 알 수 있게 프롬프트에 박아준다.
  const roleLine = role ? `역할: ${role}\n\n` : '';
  const prompt = `${TEAM_MEMBER_BRIEFING}\n\n${roleLine}${TEAM_MEMBER_STANDBY_NOTE}\n\n"""\n${instruction}\n"""`;
  const id = await runClaudeBg(['--bg', prompt], targetDir);
  if (!id) return null;
  registerMember({ memberId: id, leadId, dir: targetDir, createdAt: Date.now(), role: role || undefined });

  // 팀장이 스스로 띄운 게 아니라서 알려주지 않으면 이 팀원의 존재도 결과도 영원히 모른다 — 다만
  // 팀장이 지금 다른 작업으로 busy일 수 있어서 즉시 stop→resume으로 끼어들지 않고 큐에 쌓아둔다.
  // buildSessionRows가 폴링마다 이 큐를 보고, 팀장이 idle/blocked가 됐을 때만 실제로 전달한다.
  // (팀원은 대기 상태로 시작하므로, 이 알림을 받은 팀장이 실제 작업 개시 메시지를 별도로 보내야 한다.)
  // queueLeadNotice는 internalId를 받으므로, IPC로 넘어온 짧은 id(leadId)를 여기서 변환한다.
  const leadRec = loadLeads().find(l => l.id === leadId);
  if (leadRec) {
    queueLeadNotice(leadRec.internalId, `[알림] 사용자가 직접 팀원을 추가했습니다 — 디렉토리: ${targetDir}${role ? `, 역할: ${role}` : ''}, 사전 지시(참고용): "${instruction}", 세션 id: ${id}. 이 팀원은 이미 팀원 공통 브리핑(백그라운드 세션 유의사항)을 전달받은 상태이며, 지금 준비 완료 응답만 남기고 대기 중이니, 필요하면 관리 대상에 추가하고 실제 작업을 시작하라는 메시지를 직접 보내라(stop→resume). 완료되면 확인해서 최종 보고에 포함시켜라.`);
  }

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

ipcMain.handle('add-member-template', (_e, scope: string, dir: string, name: string, role: string, instruction: string) => {
  const templates = loadMemberTemplates();
  templates.push({
    id: `tpl-${Date.now()}`,
    scope: scope || 'shared',
    path: dir || undefined,
    name: name || (dir ? path.basename(dir) : (role || '역할')),
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
    await queueLeadOperation(lead.internalId, () =>
      resumeLead(lead.internalId, `팀원 종료 요청이 승인됐습니다 — "${req.memberId}" 세션을 종료했습니다. 계속 진행하세요.`));
    return true;
  }

  if (!lead.approvedMembers.includes(req.requestedDir!)) {
    lead.approvedMembers.push(req.requestedDir!);
    saveLeads(leads);
  }
  await queueLeadOperation(lead.internalId, () =>
    resumeLead(lead.internalId, `팀원 요청이 승인됐습니다 — "${req.requestedDir}"에 팀원을 띄워도 됩니다. 이어서 진행하세요.`));
  return true;
});

ipcMain.handle('deny-request', async (_e, requestId: string) => {
  const req = writeRequestDecision(requestId, 'denied');
  if (!req) return false;
  const leads = loadLeads();
  const lead = leads.find(l => l.id === req.teamLeadId);
  if (!lead) return false;

  if (req.type === 'stop-member') {
    await queueLeadOperation(lead.internalId, () =>
      resumeLead(lead.internalId, `팀원 종료 요청이 거부됐습니다 — "${req.memberId}"는 종료하지 말고 계속 두세요.`));
    return true;
  }

  await queueLeadOperation(lead.internalId, () =>
    resumeLead(lead.internalId, `팀원 요청이 거부됐습니다 — "${req.requestedDir}"에는 팀원을 띄우지 마세요. 다른 방법을 찾거나 사용자에게 다시 확인하세요.`));
  return true;
});

ipcMain.handle('get-changed-files', (_e, cwd: string) => getGitChangedFiles(cwd));

ipcMain.handle('get-file-diff', (_e, cwd: string, file: string) => getFileDiff(cwd, file));

ipcMain.handle('get-lead-transcript', (_e, leadId: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return [];
  const projectName = resolveProjectName(lead.sessionId, lead.targetDir);
  return getTranscript(projectName, lead.sessionId);
});

// claude CLI에는 이미 생성(응답) 중인 세션에 중간에 끼어들어 입력만 추가하는 기능이 없다(claude
// --help로 확인) — 개입할 수 있는 유일한 수단인 stop→resume은 하던 응답을 그대로 끊어버린다. 그래서
// 팀장이 지금 busy면 곧바로 stop→resume하지 않고, 팀원 추가 알림(queueLeadNotice)과 완전히 같은
// 패턴으로 메시지를 큐(pendingNotices)에 원문 그대로 쌓아둔 뒤, buildSessionRows의 폴링이 그 팀장의
// idle/blocked 전환을 감지했을 때 자동으로 resumeLead에 전달하게 한다. "끊지 않고 대기시켰다가
// idle 되면 전달"이 지금 이 CLI로 가능한 최선이다.
ipcMain.handle('send-to-lead', async (_e, leadId: string, message: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return { status: 'not-found' as const };

  const agents = await fetchAgents();
  const agent = agents.find(a => a.id === leadId);
  const isBusy = !!agent && (agent.status || agent.state || '').toLowerCase() === 'busy';
  if (isBusy) {
    const noticeId = queueLeadNotice(lead.internalId, message);
    return { status: 'queued' as const, id: noticeId };
  }

  const id = await queueLeadOperation(lead.internalId, () => resumeLead(lead.internalId, message));
  return { status: 'sent' as const, id };
});

// 대기열에 쌓아둔 메시지 중 아직 전달 안 된 것을 사용자가 취소할 수 있게 한다(채팅창의 "취소" 버튼).
ipcMain.handle('cancel-queued-message', (_e, leadId: string, noticeId: string) => cancelQueuedNotice(leadId, noticeId));

// 재시작/작업종료 확인 모달에서 "이 팀장에게 아직 전달 안 된 대기열 메시지가 몇 건 있는지" 미리
// 보여주기 위한 조회 전용 핸들러 — 렌더러는 짧은 id만 알고 있으므로 여기서 internalId로 변환해서 센다.
ipcMain.handle('get-pending-notice-count', (_e, leadId: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return 0;
  return loadPendingNotices().filter(n => n.leadInternalId === lead.internalId).length;
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
  return queueLeadOperation(lead.internalId, () => restartLead(lead.internalId, finalInstruction));
});

ipcMain.handle('end-lead-work', async (_e, leadId: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return false;
  await queueLeadOperation(lead.internalId, () => endLeadWork(lead.internalId));
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
