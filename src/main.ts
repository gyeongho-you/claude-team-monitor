import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec, execFile, spawn } from 'child_process';
import { trackFirstMiss, pruneMissingKeys } from './lib/firstMissTracker';
import { resolveWithinCwd } from './lib/pathGuard';
import { getStatus } from '../renderer/lib/status';
import { writeJsonFileAtomic } from './lib/jsonFile';
import { TEAM_MEMBER_BRIEFING, TEAM_MEMBER_STANDBY_NOTE } from './lib/teamMemberBriefing';

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

// ---------------- 타이밍 상수 ----------------
// 유예/타임아웃 값들이 파일 전체에 흩어져 있으면 서로 값이 겹치거나 모순되는지 한눈에 알기
// 어려워서 한곳에 모아둔다.

const POLL_INTERVAL_MS = 3000;

// 방금 등록된 팀원은 claude agents --json 스냅샷에 아직 안 잡혔을 수 있다(팀장이 방금 스폰한
// 직후의 타이밍 차이) — 그 유예 기간 안에는 "떠있지 않다"고 오판해 등록 파일을 지우지 않는다.
const MEMBER_CLEANUP_GRACE_MS = 15000;

// claude --bg가 이 시간 안에도 안 끝나면 행(hang)으로 간주하고 포기한다. restartLead/launchTeamLead처럼
// /team-lead 스킬을 새로 로드하며 시작하는 무거운 콜드 스타트는 단순 --resume보다 느릴 수 있고,
// 이 PC에서 여러 claude 세션이 동시에 떠있으면(실측 재현) 자원 경합으로 더 늘어질 수 있어서
// 여유를 두었다("재시작이 자꾸 실패한다" 리포트 대응).
const RUN_CLAUDE_TIMEOUT_MS = 45000;
const STOP_SESSION_TIMEOUT_MS = 15000;

// 팀장/팀원 오프라인 확정 유예(아래 LEAD_OFFLINE_GRACE_MS/MEMBER_MISS_GRACE_MS)는 반드시
// "정상적인 stop→resume 재기동이 최악의 경우 걸릴 수 있는 시간"보다 커야 한다 — 그렇지 않으면
// 재기동이 끝나기도 전에 유예가 먼저 끝나서, 아직 살아있는(그저 느리게 재기동 중인) 팀장/팀원을
// 오프라인으로 확정 처리해버리는 회귀가 생긴다. 실제로 이 회귀가 두 번 재현됐다: RUN_CLAUDE_TIMEOUT_MS를
// 30초→45초로 늘렸을 때("재시작 실패" 리포트 대응) 유예 값(당시 8초로 하드코딩)을 같이 안 늘려서,
// "즉시 전송한 메시지가 화면에서 사라진다"는 문제가 재발했다(대화창 패널이 숨겨지는 것까지 이전
// 회귀와 완전히 동일한 증상). 하드코딩된 두 값이 서로 독립적으로 존재하는 한 이런 불일치가 또
// 생기기 쉬우므로, 유예를 하드코딩하지 않고 두 타임아웃의 합(stopSession이 최악으로 다 걸리고
// 그 뒤 runClaudeBg도 최악으로 다 걸리는 순차 케이스) + 여유분으로 계산한다 — 앞으로 타임아웃만
// 늘리고 유예를 깜빡하는 실수 자체가 구조적으로 나지 않게 하기 위함이다.
const STOP_AND_RELAUNCH_WORST_CASE_MS = STOP_SESSION_TIMEOUT_MS + RUN_CLAUDE_TIMEOUT_MS;
const OFFLINE_GRACE_BUFFER_MS = 15000; // 폴링 지연·시스템 부하 등을 감안한 추가 여유분(위 두 타임아웃의 합 위에 더 얹는다).

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
//
// 팀원의 stop→resume은 이 앱이 아니라 팀장(외부 claude 세션)이 SKILL.md 안내대로 직접 거는
// 것이라 RUN_CLAUDE_TIMEOUT_MS/STOP_SESSION_TIMEOUT_MS로 정확한 상한을 잴 수는 없지만, 같은
// claude CLI를 쓰는 이상 같은 시스템 부하·콜드스타트 영향을 받으므로 팀장과 같은 값을 쓴다.
//
// 다만 팀원 쪽엔 팀장에게는 없는 추가 위험이 하나 더 있다 — resumeLead(팀장)는 이 앱이 stop
// 직후 곧바로 프로그램적으로 resume을 걸어서 그 사이 지연이 STOP_AND_RELAUNCH_WORST_CASE_MS로
// 정확히 상한이 잡히지만, 팀원의 stop→resume은 팀장(별도 LLM 세션)이 Bash 도구로 "claude stop"과
// "claude --bg --resume"을 각각 별도 턴으로 실행하는 것이라, 그 두 명령 사이에 팀장 자신의
// 추론/다른 도구 호출 시간이 얼마든지 끼어들 수 있다 — 이 구간은 이 앱이 전혀 통제할 수도, 상한을
// 잴 수도 없다(팀장이 바쁘거나 시스템에 세션이 많이 떠있으면 임의로 길어진다 — 실측: 세션 6개만
// 떠있어도 claude agents --json 자체가 500~940ms씩 걸림). 실사용 리포트로 재현됨: 팀원 프로세스는
// 안 죽고 정상 작동 중이었는데 "여러 번 stop→resume을 반복하는 사이" 등록 파일만 사라짐 — 이
// 외부 LLM 오케스트레이션 구간이 유력한 원인이라 팀원에게만 추가 여유분을 더 얹는다. 이 값으로도
// 그 구간이 이론상 완전히 상한이 잡히는 건 아니지만(팀장이 얼마나 오래 걸릴지는 원천적으로 알 수
// 없다), 재현된 사고 사례를 감안한 실용적 여유분이다.
const MEMBER_EXTERNAL_LEAD_ORCHESTRATION_BUFFER_MS = 30000;
const MEMBER_MISS_GRACE_MS = STOP_AND_RELAUNCH_WORST_CASE_MS + OFFLINE_GRACE_BUFFER_MS + MEMBER_EXTERNAL_LEAD_ORCHESTRATION_BUFFER_MS;

// 팀장도 팀원 정리와 완전히 같은 TOCTOU를 겪는다 — 멀쩡히 응답 중이던 팀장도 채팅을 보낼 때마다
// stop→resume이 도는데, 그 짧은 재기동 구간엔 agents 스냅샷에서 한 번 빠질 수 있다. 그 순간 바로
// "오프라인"으로 분류해버리면 온라인 목록(카드)에서 사라지고 히스토리 탭으로 밀려난다(채팅을 자주
// 보낼수록 자주 재현됨). 팀원과 동일한 이유로, 그리고 팀원과 똑같이 카운터 기반이었다가 겪은 같은
// 회귀 때문에(위 MEMBER_MISS_GRACE_MS 주석 참고) "처음 못 잡힌 시각" 기준으로 판단한다. 팀장의
// stop→resume은 이 앱이 직접 걸므로(resumeLead/restartLead) STOP_AND_RELAUNCH_WORST_CASE_MS로
// 정확한 상한을 잴 수 있다 — 위 공용 주석 참고.
const LEAD_OFFLINE_GRACE_MS = STOP_AND_RELAUNCH_WORST_CASE_MS + OFFLINE_GRACE_BUFFER_MS;

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
  createdAt: number;
  role?: string; // 예: "reviewer" — 일반 구현 팀원과 구분해 화면에 표시하기 위한 선택 필드
  label?: string; // 사용자가 "+ 팀원 직접 추가"에서 직접 붙인 이름 — LeadRecord.label과 같은 개념.
                  // 이 필드를 추가하기 전에 등록된 팀원에는 없을 수 있어 optional이다.
  sessionId?: string; // reconcileMemberIds가 짧은 id 드리프트를 되찾는 데 쓰는 안정적인 식별자.
                       // 이 필드를 추가하기 전에 등록된(또는 SKILL.md를 그대로 따라 팀장이 직접 쓴)
                       // 레코드에는 없을 수 있어 optional이다 — 그런 레코드는 살아있는 동안 자동으로
                       // 채워진다(reconcileMemberIds 참고).
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
// origin은 이 알림이 사용자가 직접 채팅으로 보낸 메시지인지('user', send-to-lead 경로), 시스템이
// 자동으로 만든 알림인지('system', 팀원 완료 알림·직접 추가 알림 등)를 구분한다 — deliverPendingNotices가
// 같은 팀장 앞으로 쌓인 것이어도 이 둘을 절대 한 덩어리로 묶지 않기 위해 쓴다(섞어서 묶으면
// isAutoInjectedPrompt가 '[알림]' 문구 때문에 사용자 메시지까지 자동알림으로 오판해 잘못 표시된다).
type PendingNotice = { id: string; leadInternalId: string; message: string; createdAt: number; origin: 'user' | 'system' };

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

// 팀장과의 "대화" 패널용 — 그 세션 id로 필터링한 전체 왕복 기록. daily-journal이 특정 상황
// (백그라운드 세션의 긴 턴, task-notification으로 재개된 턴 등 — claude-team-monitor 바깥의 별도
// 이슈로 실측 확인됨)에서 기록을 통째로 누락할 수 있다 — 그러면 대화창이 텅 비거나 최근 턴만
// 쏙 빠져 보인다. daily-journal 기록이 비었거나 원본 세션 파일보다 뒤처져 보이면, 원본 세션 파일
// (~/.claude/projects/<cwd 인코딩>/<sessionId>.jsonl)에서 직접 읽어와 모자란 뒷부분만 이어붙인다.
function getTranscript(projectName: string, sessionId: string, cwd: string): TranscriptEntry[] {
  const journalEntries = readJournalEntries(projectName)
    .filter(e => e.sessionId === sessionId)
    .map(e => ({ time: e.time ?? '', prompt: e.prompt ?? '', answer: e.answer ?? '' }));
  return fillMissingTranscriptFromRawSession(journalEntries, cwd, sessionId);
}

// "YYYY-MM-DD HH:MM"(daily-journal의 time 포맷, 분 단위) 문자열을 로컬 시각 기준 epoch ms로
// 되돌린다 — 형식이 안 맞으면(예전 스키마 등) null.
function parseJournalTimeLoose(time: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const ts = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime();
  return Number.isNaN(ts) ? null : ts;
}

function formatRawSessionTimestamp(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 원본 세션 파일(~/.claude/projects/.../<sessionId>.jsonl)은 daily-journal과 포맷이 전혀 다르다 —
// type:"user"/"assistant" 메시지가 순서대로 나열되고, message.content가 문자열이거나 배열
// (tool_use 결과인 tool_result와 실제 텍스트인 text 블록이 섞인 배열)일 수 있다(실측 확인, 이
// 프로젝트 자신의 세션 파일로 검증함). tool_result만 있는 user 메시지는 도구 실행 결과일 뿐
// 사람이 보낸 프롬프트가 아니므로 건너뛴다 — 그 외(문자열이거나 text 블록이 있는 경우)는 새 턴의
// 시작으로 보고, 그 다음에 오는 assistant 메시지들의 text 블록을 모아 답변으로 짝짓는다.
function readRawSessionTranscript(cwd: string, sessionId: string): TranscriptEntry[] {
  const file = path.join(PROJECTS_DIR, encodeProjectDirName(cwd), `${sessionId}.jsonl`);
  let lines: string[];
  try {
    if (!fs.existsSync(file)) return [];
    lines = fs.readFileSync(file, 'utf-8').split('\n');
  } catch {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  let currentPrompt: { time: string; prompt: string } | null = null;
  let currentAnswerParts: string[] = [];
  const flush = () => {
    if (currentPrompt && currentPrompt.prompt.trim()) {
      entries.push({ time: currentPrompt.time, prompt: currentPrompt.prompt, answer: currentAnswerParts.join('\n').trim() });
    }
    currentPrompt = null;
    currentAnswerParts = [];
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: any;
    try { rec = JSON.parse(line); } catch { continue; }

    if (rec.type === 'user' && rec.message) {
      const content = rec.message.content;
      let promptText: string | null = null;
      if (typeof content === 'string') {
        promptText = content;
      } else if (Array.isArray(content) && content.length > 0 && !content.every((b: any) => b.type === 'tool_result')) {
        const textParts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).filter(Boolean);
        if (textParts.length) promptText = textParts.join('\n');
      }
      if (promptText !== null && promptText.trim()) {
        flush();
        currentPrompt = { time: formatRawSessionTimestamp(rec.timestamp), prompt: promptText };
      }
    } else if (rec.type === 'assistant' && rec.message && currentPrompt) {
      const content = rec.message.content;
      if (Array.isArray(content)) {
        const textParts = content.filter((b: any) => b.type === 'text').map((b: any) => b.text).filter(Boolean);
        if (textParts.length) currentAnswerParts.push(...textParts);
      }
    }
  }
  flush();
  return entries;
}

// daily-journal 기록이 있으면 그게 더 깔끔하게 정제된 형태라 그대로 신뢰하고, 거기 없는(원본에는
// 있는) 뒷부분만 원본 세션 파일에서 보완해서 이어붙인다 — 완전히 원본으로 교체하지 않는다.
// 원본 세션 파일은 몇 MB씩 될 수 있어서(실측: 두 달치 프로젝트의 팀장 세션 파일이 1.7MB) 매번
// 열어 전체를 재구성하면 3초 폴링마다 부담이 크다 — daily-journal의 마지막 기록 시각 이후로 원본
// 파일이 수정된 적이 없으면(fs.statSync만으로 확인 가능, 파일을 열 필요가 없다) 새로 쌓인 턴이
// 없다는 뜻이니 그냥 넘어간다.
function fillMissingTranscriptFromRawSession(journalEntries: TranscriptEntry[], cwd: string, sessionId: string): TranscriptEntry[] {
  if (journalEntries.length === 0) {
    const raw = readRawSessionTranscript(cwd, sessionId);
    return raw.length ? raw : journalEntries;
  }

  const file = path.join(PROJECTS_DIR, encodeProjectDirName(cwd), `${sessionId}.jsonl`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return journalEntries;
  }
  const lastJournalTime = parseJournalTimeLoose(journalEntries[journalEntries.length - 1].time);
  // "YYYY-MM-DD HH:MM"은 분 단위까지만 있어서 실제 mtime과 최대 1분 가까이 차이날 수 있다 —
  // 여유를 두고 비교한다.
  if (lastJournalTime !== null && stat.mtimeMs <= lastJournalTime + 2 * 60 * 1000) {
    return journalEntries;
  }

  const rawEntries = readRawSessionTranscript(cwd, sessionId);
  if (rawEntries.length === 0) return journalEntries;

  const cutIndex = findLastMatchingRawIndex(journalEntries[journalEntries.length - 1], rawEntries);
  // daily-journal의 마지막 프롬프트를 원본에서 못 찾으면(문구 가공 등으로 정확히 안 맞을 수 있음)
  // 개수 기준으로 대략 맞춰 보완한다 — 완벽하지 않아도 아예 안 보이는 것보다는 낫다.
  const tail = cutIndex >= 0 ? rawEntries.slice(cutIndex + 1) : rawEntries.slice(journalEntries.length);
  return tail.length ? journalEntries.concat(tail) : journalEntries;
}

// journalEntries의 마지막 항목과 똑같은 prompt 텍스트가 원본 세션 파일에 정확히 어디 있었는지
// 찾는다. 이 앱이 자동으로 넣는 "[알림] 팀원 ... 완료" 같은 정형 문구는 같은 팀원이 같은 상태로
// 여러 번 끝날 때마다 글자 하나 안 틀리고 그대로 반복될 수 있다(실측 확인) — 그래서 단순히
// "원본 배열 끝에서부터 훑어 처음 일치하는 것"을 고르면, 훨씬 나중에 벌어진 무관한 재발생을
// 잘못 짚어서 그 뒤로 아무것도 안 남는(보완 실패) 사고가 난다. daily-journal의 time과 원본
// 프롬프트의 time이 완전히 같지는 않아도(대기열에 걸려있다 배달되면 최대 수십 분 차이날 수
// 있음 — deliverPendingNotices 참고) 어느 정도는 가까울 수밖에 없으므로, 텍스트가 일치하는
// 후보들 중 시간이 가장 가까운 것을 고른다.
function findLastMatchingRawIndex(lastEntry: TranscriptEntry, rawEntries: TranscriptEntry[]): number {
  const lastTime = parseJournalTimeLoose(lastEntry.time);
  if (lastTime === null) {
    for (let i = rawEntries.length - 1; i >= 0; i--) {
      if (rawEntries[i].prompt === lastEntry.prompt) return i;
    }
    return -1;
  }
  const MATCH_SLACK_MS = 60 * 60 * 1000; // 대기열에서 오래 기다린 경우까지 감안한 여유
  let bestIndex = -1;
  let bestDiff = Infinity;
  for (let i = rawEntries.length - 1; i >= 0; i--) {
    if (rawEntries[i].prompt !== lastEntry.prompt) continue;
    const rawTime = parseJournalTimeLoose(rawEntries[i].time);
    if (rawTime === null) continue;
    const diff = Math.abs(rawTime - lastTime);
    if (diff <= MATCH_SLACK_MS && diff < bestDiff) { bestDiff = diff; bestIndex = i; }
  }
  return bestIndex;
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

// origin 분리 리팩터(deliverPendingNotices가 leadInternalId+origin으로 그룹핑하도록 바뀐 것) 이전에
// 만들어진 구버전 pendingNotices.json 항목은 leadInternalId 대신 leadId(짧은 id)만 있고 origin
// 필드가 아예 없다(실제로 로컬 파일에 남아있던 걸 확인함: {"id":"...","leadId":"e7e14a26",
// "message":"[알림] ...","createdAt":...}). 코드만 고쳐서는 이미 파일에 쌓여있던 이 구버전
// 항목이 저절로 안 바뀌어서, leadInternalId가 undefined인 채로 영원히 어떤 그룹에도 제대로
// 안 묶이고 stillPending에만 남아 고아 데이터로 계속 적체된다 — 그래서 로드할 때마다 한 번씩
// 이 마이그레이션을 거친다(loadLeads의 internalId 백필과 같은 패턴).
function migratePendingNotices(raw: any[]): { notices: PendingNotice[]; dirty: boolean } {
  const leads = loadLeads();
  const notices: PendingNotice[] = [];
  let dirty = false;
  for (const item of raw) {
    if (!item || typeof item !== 'object') { dirty = true; continue; }
    let leadInternalId: string | undefined = typeof item.leadInternalId === 'string' ? item.leadInternalId : undefined;
    if (!leadInternalId && typeof item.leadId === 'string') {
      // 구버전 필드(leadId, 짧은 id)를 지금 leads.json에서 찾아 internalId로 변환한다 — 이미
      // 사라진(재시작 등으로 짧은 id가 바뀌었거나 완전히 없어진) 팀장이면 더 전달할 대상이
      // 없으므로 이 항목은 버린다(계속 들고 있어봐야 영원히 배달 못 됨).
      const lead = leads.find(l => l.id === item.leadId);
      if (!lead) { dirty = true; continue; }
      leadInternalId = lead.internalId;
      dirty = true;
    }
    if (!leadInternalId) { dirty = true; continue; } // 둘 다 없으면(알 수 없는 포맷) 버린다
    const message = typeof item.message === 'string' ? item.message : '';
    let origin: 'user' | 'system';
    if (item.origin === 'user' || item.origin === 'system') {
      origin = item.origin;
    } else {
      // origin이 없던 구버전 항목은 문구로 추론한다 — isAutoInjectedPrompt(renderer.js)와 같은 판별.
      origin = message.startsWith('[알림]') || message.includes('<task-notification>') ? 'system' : 'user';
      dirty = true;
    }
    notices.push({
      id: typeof item.id === 'string' ? item.id : `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      leadInternalId,
      message,
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      origin,
    });
  }
  return { notices, dirty };
}

function loadPendingNotices(): PendingNotice[] {
  const raw = readJsonArraySafe<any>(PENDING_NOTICES_PATH);
  const { notices, dirty } = migratePendingNotices(raw);
  // 마이그레이션으로 뭔가 바뀌었으면(구버전 필드 변환·유실 항목 제거 등) 즉시 저장해서 다음부터는
  // 매번 다시 마이그레이션할 필요가 없게 한다(1회성 정리 — loadLeads의 internalId 백필과 동일한 이유).
  if (dirty) savePendingNotices(notices);
  return notices;
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
// origin은 위 PendingNotice 타입 주석 참고 — 호출부가 반드시 맞는 값을 넘겨야 한다.
function queueLeadNotice(leadInternalId: string, message: string, origin: 'user' | 'system'): string {
  const notices = loadPendingNotices();
  const id = `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  notices.push({ id, leadInternalId, message, createdAt: Date.now(), origin });
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

// memberId별/leadId별 "처음 못 잡힌 시각"을 폴링 사이에도 유지해야 하므로 모듈 스코프에 둔다.
// 유예 판정 자체(trackFirstMiss)는 순수 함수로 뽑아서 lib/firstMissTracker.ts에 있다 — 팀원
// 정리와 팀장 오프라인 판정이 겪는 TOCTOU가 완전히 같아서 그 4단계 로직을 공용으로 쓴다.
const memberFirstMissAt = new Map<string, number>();
const leadFirstMissAt = new Map<string, number>();

// 팀장이 agents 스냅샷에 이번 폴링에서만 못 잡힌(유예 구간, 아직 오프라인 확정 전) 순간에 보여줄
// "마지막으로 살아있던 스냅숏" — liveRows에 잡힐 때마다 갱신한다. 이게 없으면 stop→resume 재기동
// 구간(채팅 즉시전송마다 정상적으로 발생함)에 그 팀장이 liveRows에도 offlineRows에도 안 잡혀서
// rows에서 통째로 빠지고, 그 결과 renderer.js의 lastLeadIds에서도 빠져 selectedLeadId가 null로
// 리셋되면서 대화창 패널(leadChatPanelEl) 자체가 순간적으로 숨겨지는 버그로 이어진다(실사용 재현:
// 즉시 전송할 때마다 화면이 잠깐 지워졌다 돌아옴 — pendingChatTurns 통합 수정과는 별개의 원인).
const lastKnownLiveLeadRow = new Map<string, SessionRow>();

function computeLiveRows(
  agents: AgentEntry[],
  leads: LeadRecord[],
  leadIds: Set<string>,
  memberMap: Map<string, MemberRecord>,
): SessionRow[] {
  return agents
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
        label: isLead ? lead?.label : member?.label,
        offline: false,
      };
    });
}

// 팀원이 busy → idle/done으로 바뀌면 팀장에게 확인해보라고 알려준다(큐에 쌓였다가 팀장이
// idle/blocked일 때 전달됨 — deliverPendingNotices의 pendingNotices 큐를 그대로 재사용).
function notifyLeadsOfFinishedMembers(liveRows: SessionRow[], leads: LeadRecord[]): void {
  liveRows.filter(r => !r.isLead).forEach(r => {
    const status = getStatus(r);
    const prevStatus = lastMemberStatus.get(r.id!);
    if (prevStatus === 'busy' && status && status !== 'busy' && r.leadId) {
      // MemberRecord.leadId는 등록 당시의 짧은 id라 그 뒤로 팀장이 재시작됐으면 이미 낡은 값일 수
      // 있다 — 지금 이 폴링 시점 기준으로 leads에서 다시 찾아 internalId로 바꿔서 큐잉한다.
      const leadRecForMember = leads.find(l => l.id === r.leadId);
      if (leadRecForMember) {
        queueLeadNotice(
          leadRecForMember.internalId,
          `[알림] 팀원 ${r.id}(${r.cwd}${r.role ? `, 역할: ${r.role}` : ''})가 작업을 마친 것 같습니다(상태: ${status}). stop→resume으로 "방금 한 작업을 한국어로 짧게 요약해줘"처럼 확인하고, 결과를 파악해서 필요하면 최종 보고에 반영하세요.`,
          'system',
        );
      }
    }
    if (status) lastMemberStatus.set(r.id!, status);
  });
}

// 대기 중이던 알림이 한 팀장 앞으로 여러 건 쌓여있으면 번호를 매겨 하나로 합친다 — 개별로
// 따로 보내면 stop→resume 사이클이 N번 쉴 틈 없이 연달아 실행돼서(1) 사이클 사이의 짧은 idle
// 순간을 폴링이 못 잡아 계속 busy처럼 보이고, (2) 나중에 새로 쌓인 메시지(예: 팀장 질문에 대한
// 사용자 답변)가 먼저 쌓여있던 알림들보다 늦게 배달돼서 대화 흐름이 꼬인다. 1건뿐이면 불필요한
// 안내문/번호 없이 원문 그대로 보낸다.
function combinePendingNoticeMessages(notices: PendingNotice[]): string {
  if (notices.length === 1) return notices[0].message;
  const lines = notices.map((n, i) => `${i + 1}) ${n.message}`);
  return `[대기 중이던 메시지 ${notices.length}건을 순서대로 전달합니다]\n\n${lines.join('\n\n')}`;
}

// 대기 중인 알림 중, 그 팀장이 지금 busy가 아니면(=억지로 끊어도 하던 작업이 없으면) 이 타이밍에
// stop→resume으로 실제 전달한다. busy면 다음 폴링까지 큐에 그대로 둔다. 같은 팀장 앞으로 쌓인
// 알림은(원래 쌓인 순서 그대로) 하나로 합쳐서 resumeLead 호출로 보낸다 — 단, leadInternalId뿐
// 아니라 origin('user'/'system')까지 같아야 같은 그룹으로 묶는다. 사용자가 직접 보낸 채팅
// 메시지와 시스템이 자동으로 만든 '[알림]'류 알림을 한 덩어리로 합쳐버리면, isAutoInjectedPrompt가
// 섞여 들어간 '[알림]' 문구 때문에 사용자 메시지까지 자동알림으로 오판해 화면에 잘못 표시된다
// (실사용 재현) — 그래서 두 origin은 절대 같은 그룹에 넣지 않는다. 같은 팀장 앞에 두 그룹이
// 동시에 쌓여있으면 각각 combinePendingNoticeMessages로 따로 묶어서 queueLeadOperation(같은
// internalId 키)에 순서대로 넣는다 — 이미 있는 leadId별 직렬 큐 덕분에 두 번째 resumeLead는
// 첫 번째가 끝난 뒤에 자연스럽게 실행된다. 그룹 몫으로 처리된 notice는 전부 한 번에
// stillPending에서 빠진다.
function deliverPendingNotices(agents: AgentEntry[], leads: LeadRecord[]): void {
  const pendingNotices = loadPendingNotices();
  if (pendingNotices.length === 0) return;

  const byLeadAndOrigin = new Map<string, PendingNotice[]>();
  for (const notice of pendingNotices) {
    const key = `${notice.leadInternalId}|${notice.origin}`;
    const list = byLeadAndOrigin.get(key) ?? [];
    list.push(notice);
    byLeadAndOrigin.set(key, list);
  }

  const stillPending: PendingNotice[] = [];
  for (const notices of byLeadAndOrigin.values()) {
    const leadRec = leads.find(l => l.internalId === notices[0].leadInternalId);
    const liveAgent = leadRec ? agents.find(a => a.id === leadRec.id) : undefined;
    const isBusy = !!liveAgent && getStatus(liveAgent) === 'busy';
    if (leadRec && liveAgent && !isBusy) {
      const message = combinePendingNoticeMessages(notices);
      queueLeadOperation(leadRec.internalId, () => resumeLead(leadRec.internalId, message))
        .catch(() => { /* 실패해도 알림 자체는 소모(재시도 안 함) */ });
      continue;
    }
    stillPending.push(...notices);
  }
  if (stillPending.length !== pendingNotices.length) savePendingNotices(stillPending);
}

// 지금 떠있지 않은 팀장은 기록을 지우지 않고 "오프라인"으로 남겨둔다 — PC 재부팅 등으로 프로세스가
// 죽어도 세션 자체는 claude 쪽에 남아있어서 --bg --resume으로 다시 깨울 수 있기 때문이다(대화창에서
// 메시지를 보내면 자동으로 이 절차를 탄다, resumeLead 참고). 단, agents 스냅샷에 한 번 안 잡힌
// 것만으로 바로 오프라인 처리하지 않는다(LEAD_OFFLINE_GRACE_MS 주석 참고) — 처음 못 잡힌 시각으로부터
// 유예 시간이 지나기 전이면 "오프라인 확정" 전인 유예 구간으로 보고(buildGraceRows가 이 구간을
// 화면에서 처리한다), 유예 시간이 지나야 진짜 오프라인으로 확정한다. 만료돼도 leadFirstMissAt
// 기록은 지우지 않는다 — 지우면 다음 폴링에 "처음 못 잡힘"부터 다시 시작해 유예 시간 동안 또
// 온라인처럼 보이므로, 다시 잡힐 때까지 계속 만료 상태를 유지해야 한다.
function computeOfflineLeads(leads: LeadRecord[], agentIdSet: Set<string | undefined>, now: number): LeadRecord[] {
  const offlineLeads: LeadRecord[] = [];
  leads.forEach(l => {
    const result = trackFirstMiss(leadFirstMissAt, agentIdSet.has(l.id), l.id, now, LEAD_OFFLINE_GRACE_MS);
    if (result === 'expired') offlineLeads.push(l);
  });
  // 다른 경로로 이미 사라진(현재는 없지만 혹시 모를) leadId의 기록을 정리해 Map이 무한정 자라지
  // 않게 한다 — 팀원 정리 로직과 동일한 방어.
  pruneMissingKeys(leadFirstMissAt, new Set(leads.map(l => l.id)));
  return offlineLeads;
}

// agents 스냅샷에 이번엔 안 잡혔지만(agentIdSet에 없음) 아직 오프라인으로 확정되지도 않은(유예
// 구간, offlineLeads에도 없음) 팀장들 — 대부분 stop→resume 재기동 중이다. liveRows에도
// offlineRows에도 안 들어가는 이 틈을 그냥 두면 rows에서 통째로 빠져서(위 lastKnownLiveLeadRow
// 주석 참고) 대화창이 순간적으로 사라지므로, 마지막으로 살아있었을 때의 스냅숏을 그대로 재사용해
// "아직 그대로 있는 것처럼" 보여준다. 캐시가 아직 없으면(한 번도 liveRows에 잡힌 적 없음) 보여줄
// 게 없으므로 건너뛴다 — 다음 폴링에 자연히 다시 시도된다.
function buildGraceRows(leads: LeadRecord[], agentIdSet: Set<string | undefined>, offlineLeads: LeadRecord[]): SessionRow[] {
  const offlineLeadIds = new Set(offlineLeads.map(l => l.id));
  const graceRows: SessionRow[] = [];
  for (const l of leads) {
    if (agentIdSet.has(l.id) || offlineLeadIds.has(l.id)) continue;
    const cached = lastKnownLiveLeadRow.get(l.id);
    if (cached) graceRows.push(cached);
  }
  return graceRows;
}

function buildOfflineRows(offlineLeads: LeadRecord[], leads: LeadRecord[]): SessionRow[] {
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
  return offlineRows;
}

// 팀원은 팀장과 달리 일회성 하위 작업 단위라 이어할 필요가 적어서, 종료되면 정리한다 — 단,
// 방금(MEMBER_CLEANUP_GRACE_MS 이내) 등록된 팀원은 봐주고(TOCTOU), 처음 못 잡힌 시각으로부터
// MEMBER_MISS_GRACE_MS가 지나기 전이면(=stop→resume 재기동 구간일 수 있음) 아직 지우지 않는다.
// 팀장과 달리 만료되면 등록 파일 자체를 지우므로, firstMiss 기록도 즉시 같이 지운다.
function cleanupStaleMembers(members: MemberRecord[], agentIdSet: Set<string | undefined>, now: number): void {
  const currentMemberIds = new Set(members.map(m => m.memberId));
  members.forEach(m => {
    if (now - m.createdAt < MEMBER_CLEANUP_GRACE_MS) return;
    const firstMissAt = memberFirstMissAt.get(m.memberId);
    const result = trackFirstMiss(memberFirstMissAt, agentIdSet.has(m.memberId), m.memberId, now, MEMBER_MISS_GRACE_MS);
    if (result !== 'expired') return;
    memberFirstMissAt.delete(m.memberId);
    // 실사용 리포트로 "팀원 프로세스는 안 죽었는데 등록 파일만 사라졌다"는 사고가 재현됐는데
    // 원인을 확정 못 했다 — 다음에 재현되면 최소한 "얼마나 오래 못 잡혔었는지"와 "그 시점에
    // 이 앱이 실제로 살아있다고 본 세션이 몇 개였는지"(시스템 부하 정황)는 바로 알 수 있게
    // 지우기 직전에 로그를 남긴다.
    console.error(
      `[cleanupStaleMembers] 팀원 ${m.memberId}(팀장 ${m.leadId}) 등록 파일을 정리합니다 — ` +
      `${firstMissAt !== undefined ? now - firstMissAt : '알 수 없음'}ms 동안 agents 스냅샷에서 못 잡힘 ` +
      `(유예 ${MEMBER_MISS_GRACE_MS}ms), 현재 살아있는 세션 수=${agentIdSet.size}`
    );
    try { fs.unlinkSync(path.join(MEMBERS_DIR, `${m.memberId}.json`)); } catch { /* ignore */ }
  });
  // 등록 파일이 다른 경로(수동 종료 버튼 등)로 이미 사라진 memberId의 기록은 여기서 정리해야
  // Map이 무한정 자라지 않는다.
  pruneMissingKeys(memberFirstMissAt, currentMemberIds);
}

// 이 앱이 직접 stop→resume시킨 팀장은 resumeLead가 짧은 id 변경을 바로 leads.json에 반영해주지만,
// 팀장이 이 앱 밖에서(예: 팀장 자신이 스스로를 재기동하거나, 다른 오케스트레이터가 관리) 재시작되면
// 짧은 id가 이 앱 모르게 바뀌어버린다 — leads.json엔 옛 id가 그대로 남아서, 실제로는 살아있는데도
// leadIds.has(a.id)가 항상 실패해 "세션 정리" 탭에 "미등록"으로, 작업 탭에선 오프라인으로 잘못
// 보인다(실사고 확인: g1cl-mgt의 팀장이 이런 식으로 낡은 id를 갖고 있었다). sessionId는 이 앱이
// 관여하지 않아도 절대 안 바뀌므로, 짧은 id로 못 찾은 살아있는 세션을 sessionId로 다시 찾아서
// leads.json의 id를 그 자리에서 바로잡는다.
function reconcileLeadIds(agents: AgentEntry[], leads: LeadRecord[]): boolean {
  let changed = false;
  const leadIdSet = new Set(leads.map(l => l.id));
  for (const agent of agents) {
    if (!agent.id || !agent.sessionId || leadIdSet.has(agent.id)) continue;
    const rec = leads.find(l => l.sessionId === agent.sessionId);
    if (rec && rec.id !== agent.id) {
      console.log(`[reconcileLeadIds] 팀장 ${rec.internalId}의 짧은 id가 이 앱 밖에서 바뀐 것을 발견해 ${rec.id} -> ${agent.id}로 갱신합니다.`);
      rec.id = agent.id;
      leadIdSet.add(agent.id);
      changed = true;
    }
  }
  return changed;
}

// 팀원도 팀장과 똑같은 문제를 겪는데, 훨씬 더 심각하다 — 팀장은 낡은 id로 잘못 표시만 되지만
// 팀원은 cleanupStaleMembers가 결국 "죽은 것"으로 보고 등록 파일을 영구히 지워버린다(실사고 확인:
// g1cl-mgt의 팀원). 팀원은 이 앱이 stop→resume을 관리하지 않고(팀장이 직접 관리) 등록 파일 자체가
// sessionId를 안 담고 있었어서(디렉토리처럼 "떠있을 때 agents --json으로 알 수 있으니 굳이 저장 안
// 함") 되찾을 방법조차 없었다. 이제 sessionId를 등록 시점부터(또는 살아있는 동안 한 번) 채워두고,
// 짧은 id로 못 찾은 살아있는 세션을 sessionId로 다시 찾아 등록 파일을 새 id로 옮겨써서 살려낸다.
// 등록 파일은 팀장별로 한 파일(memberId.json)이라 "옮긴다"는 게 곧 지우고 새로 쓰는 것이다.
function reconcileMemberIds(agents: AgentEntry[], members: MemberRecord[]): MemberRecord[] {
  const agentById = new Map(agents.filter(a => !!a.id).map(a => [a.id!, a]));
  const agentBySessionId = new Map(agents.filter(a => !!a.sessionId).map(a => [a.sessionId!, a]));
  return members.map(m => {
    const liveAgent = agentById.get(m.memberId);
    if (liveAgent) {
      if (m.sessionId) return m;
      const updated: MemberRecord = { ...m, sessionId: liveAgent.sessionId };
      registerMember(updated);
      return updated;
    }
    if (!m.sessionId) return m; // sessionId를 모르면(옛 레코드) 되찾을 방법이 없다 — 기존 정리 로직대로 처리
    const matched = agentBySessionId.get(m.sessionId);
    if (!matched || !matched.id || matched.id === m.memberId) return m;
    console.log(`[reconcileMemberIds] 팀원 ${m.memberId}(팀장 ${m.leadId})의 짧은 id가 이 앱 밖에서 바뀐 것을 발견해 ${matched.id}로 등록 파일을 옮깁니다.`);
    try { fs.unlinkSync(path.join(MEMBERS_DIR, `${m.memberId}.json`)); } catch { /* ignore */ }
    const renamed: MemberRecord = { ...m, memberId: matched.id };
    registerMember(renamed);
    return renamed;
  });
}

// 보드에는 "내가 띄운 팀장"과 "팀장이 등록한 팀원"만 보여준다 — 그 외(사용자가 따로 열어둔 무관한
// 세션 등)는 team-lead 체계 밖이므로 제외한다. interactive 세션은 애초에 짧은 id가 없어서 자동으로 빠진다.
//
// 책임이 여럿(실시간 스냅샷 구성, 팀원 완료 알림, 대기열 배달, 팀장 오프라인 판정, 팀원 정리)이라
// 각각을 위 헬퍼로 뽑고, 여기서는 순서대로 호출해 조합만 한다.
async function buildSessionRowsInternal(): Promise<{ rows: SessionRow[]; requests: MemberRequest[] }> {
  // 아래 leadFirstMissAt/memberFirstMissAt 유예 판정에 쓸 기준 시각 — 이 함수 실행 도중 한 번만
  // 고정해서 재는다(같은 호출 안에서 Date.now()를 여러 번 부르며 값이 갈리는 걸 방지).
  const now = Date.now();
  const agents = await fetchAgents();
  const agentIdSet = new Set(agents.filter(a => !!a.id).map(a => a.id));
  const leads = loadLeads();
  if (reconcileLeadIds(agents, leads)) saveLeads(leads);
  const leadIds = new Set(leads.map(l => l.id));
  const members = reconcileMemberIds(agents, loadMembers());
  const memberMap = new Map(members.map(m => [m.memberId, m]));

  const liveRows = computeLiveRows(agents, leads, leadIds, memberMap);
  liveRows.filter(r => r.isLead).forEach(r => lastKnownLiveLeadRow.set(r.id!, r));
  notifyLeadsOfFinishedMembers(liveRows, leads);
  deliverPendingNotices(agents, leads);

  const offlineLeads = computeOfflineLeads(leads, agentIdSet, now);
  const offlineRows = buildOfflineRows(offlineLeads, leads);
  const graceRows = buildGraceRows(leads, agentIdSet, offlineLeads);
  const rows = [...liveRows, ...graceRows, ...offlineRows];

  pruneMissingKeys(lastKnownLiveLeadRow, new Set(leads.map(l => l.id)));
  cleanupStaleMembers(members, agentIdSet, now);

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

// favorites.json은 항상 {path,name} 객체 배열로만 저장돼왔다(문자열 배열이나 approvedForMembers가
// 섞인 예전 포맷은 실제 데이터에 존재한 적이 없어 정규화 로직이 필요 없다) — 그대로 읽기만 한다.
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
// exit code만으로는 부족하다 — 타임아웃으로 child.kill()한 경우 exit code가 없어도 실제로 세션이
// 죽었는지 알 수 없다. 그래서 claude stop을 시도한 뒤 claude agents --json으로 그 id가 실제로
// 목록에서 사라졌는지까지 확인해서 최종 성공 여부를 반환한다.
function stopSession(id: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (exitedCleanly: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fetchAgents().then(agents => {
        const stillAlive = agents.some(a => a.id === id);
        if (stillAlive) {
          console.error(`[stopSession] claude stop ${id} 이후에도 agents 목록에 여전히 남아있습니다 — 정지 실패로 간주합니다.`);
        }
        resolve(exitedCleanly && !stillAlive);
      });
    };
    const child = spawn('claude', ['stop', id]);
    const timer = setTimeout(() => {
      console.error(`[stopSession] claude stop ${id} 이 응답 없이 대기 중이라 강제 종료합니다.`);
      child.kill();
      finish(false);
    }, STOP_SESSION_TIMEOUT_MS);
    child.on('close', code => {
      if (code !== 0) {
        console.error(`[stopSession] claude stop ${id} 이 실패했습니다(exit code ${code}).`);
      }
      finish(code === 0);
    });
    child.on('error', err => {
      console.error('[stopSession] claude stop 프로세스를 실행하지 못했습니다:', err);
      finish(false);
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
  // 히스토리 탭에서 이미 오프라인인(agents 스냅샷에 안 잡히는) 팀장에게 메시지를 보내도 여기까지
  // 그대로 들어온다 — restartLead와 같은 이유로, 실제로 떠있을 때만 stop을 호출한다(없는 프로세스에
  // claude stop을 걸어 시간을 낭비하고 이어지는 runClaudeBg 타임아웃과 겹치는 걸 막기 위함).
  const agents = await fetchAgents();
  const isCurrentlyLive = agents.some(a => a.id === current.id);
  if (isCurrentlyLive) {
    await stopSession(current.id);
  }
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
//
// "재시작이 자꾸 실패한다"는 실사용 리포트 조사 중 — internalId 연결/pending-notice 경고 기능
// 자체엔 재시작을 막거나 방해하는 버그가 없음을 코드 추적으로 확인했다(둘 다 무관한 별개 경로).
// 다만 이전엔 실패 사유를 구분 없이 전부 null로 뭉뚱그려서 "실패했습니다"로만 보여줬는데, 그래서는
// stopSession 이후 runClaudeBg가 왜 실패했는지(타임아웃/마커 인식 실패 등, 자세한 내용은 콘솔
// 로그에 남음) 사용자가 화면에서 전혀 알 수 없었다 — 실제 원인을 좁히려면 이게 먼저 필요해서,
// 실패 사유를 렌더러까지 전달하도록 반환 타입을 바꿨다.
async function restartLead(internalId: string, instruction: string): Promise<{ id: string } | { error: string }> {
  const current = loadLeads().find(l => l.internalId === internalId);
  if (!current) return { error: '팀장 레코드를 찾을 수 없습니다(이미 삭제됐거나 internalId가 어긋났을 수 있음).' };
  // 히스토리 탭에서 이미 오프라인인(agents 스냅샷에 안 잡히는) 팀장을 골라 재시작해도 여기까지
  // 그대로 들어온다 — 이 경우 claude stop을 걸 실제 프로세스가 없으니 불필요하게 시간만 쓰고
  // (실사용 재현: 그 뒤 이어지는 runClaudeBg의 45초 타임아웃과 겹쳐 재시작 실패로 이어짐),
  // 지금 실제로 떠있을 때만 stop을 호출한다.
  const agents = await fetchAgents();
  const isCurrentlyLive = agents.some(a => a.id === current.id);
  if (isCurrentlyLive) {
    await stopSession(current.id);
  }
  installTeamLeadSkill();
  const { paths: approvedMembers, text: approvedText } = approvedMemberBriefing(current.targetDir);
  const prompt = `/team-lead ${instruction}\n\n${approvedText}`;

  const newId = await runClaudeBg(['--bg', prompt], current.targetDir);
  if (!newId) {
    return { error: `claude --bg가 ${RUN_CLAUDE_TIMEOUT_MS / 1000}초 안에 새 세션 시작을 확인해주지 못했습니다(타임아웃 또는 "backgrounded" 표시를 못 찾음). claude CLI 로그인/설치 상태를 확인해보세요 — 자세한 로그는 앱 콘솔에 남습니다.` };
  }
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
  return { id: newId };
}

// "작업 종료" — 이 팀장이 띄운 팀원을 전부 먼저 끄고, 마지막에 팀장 자신을 끈다. 팀장 기록은
// leads.json에서 지우지 않는다 — 다른 "종료"와 마찬가지로 오프라인/히스토리로 남아서 나중에
// --resume으로 다시 부를 수 있어야 한다(완전 삭제가 아니라 "지금은 멈춤"이라는 의미). internalId로
// 실행 시점에 최신 레코드를 다시 찾는다(resumeLead/restartLead와 같은 이유).
// 팀장 자신을 끄는 마지막 stopSession이 실패하면(바쁜 세션은 정지에 더 오래 걸릴 수 있다) 1회
// 재시도하고, 그래도 실패하면 그 사실을 반환값에 담아 호출부(ipcMain 핸들러)가 렌더러에 정확히
// 전달할 수 있게 한다.
async function endLeadWork(internalId: string): Promise<{ success: boolean; memberFailures: string[] }> {
  const lead = loadLeads().find(l => l.internalId === internalId);
  if (!lead) return { success: false, memberFailures: [] };
  const members = loadMembers().filter(m => m.leadId === lead.id);
  const memberFailures: string[] = [];
  for (const m of members) {
    const stopped = await stopSession(m.memberId);
    if (!stopped) memberFailures.push(m.memberId);
    try { fs.unlinkSync(path.join(MEMBERS_DIR, `${m.memberId}.json`)); } catch { /* ignore */ }
  }
  let leadStopped = await stopSession(lead.id);
  if (!leadStopped) {
    leadStopped = await stopSession(lead.id);
  }
  return { success: leadStopped, memberFailures };
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
async function getAllBackgroundSessions(): Promise<(AgentEntry & { tag: 'lead' | 'member' | 'untracked'; leadId?: string })[]> {
  const agents = await fetchAgents();
  const leadIds = new Set(loadLeads().map(l => l.id));
  const memberLeadById = new Map(loadMembers().map(m => [m.memberId, m.leadId]));
  return agents
    .filter(a => a.kind === 'background' && !!a.id)
    .map(a => ({
      ...a,
      tag: (leadIds.has(a.id!) ? 'lead' : memberLeadById.has(a.id!) ? 'member' : 'untracked') as 'lead' | 'member' | 'untracked',
      // 세션 정리 탭에서 팀장 소속으로 팀원을 묶어서 보여주는 데 쓴다 — 팀장 자신·미등록 세션은 없다.
      leadId: memberLeadById.get(a.id!),
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
  const leads = loadLeads();
  // 이 sessionId가 이미 이 앱이 추적 중인(히스토리 탭에 있는, 오프라인이든 아니든) 레코드라면 새
  // 레코드를 또 만들지 말고 히스토리에서 이어할 때와 똑같은 경로(resumeLead)로 그 레코드를 그대로
  // 이어서 깨운다. 안 그러면 같은 세션을 가리키는 레코드가 leads.json에 두 개 생겨서, internalId
  // 기반의 queueLeadOperation/PendingNotice가 서로 다른 레코드로 갈라져 메시지가 엉킨다("세션 ID로
  // 이어하기"로 히스토리에 이미 있는 세션을 다시 입력했을 때 실제로 이 경로를 탄다).
  const existing = leads.find(l => l.sessionId === sessionId);
  if (existing) {
    return queueLeadOperation(existing.internalId, () =>
      resumeLead(existing.internalId, '지금 이 대화를 Claude Team Monitor로 다시 불러왔습니다. 계속 진행하세요.'));
  }
  const id = await runClaudeBg(
    ['--bg', '--resume', sessionId, '지금 이 대화를 Claude Team Monitor로 가져왔습니다(별도 복사본, 원본 세션과는 별개). 계속 진행하세요.'],
    cwd,
  );
  if (!id) return null;
  const newSessionId = (await findSessionIdByShortId(id)) ?? id;
  const { paths: approvedMembers } = approvedMemberBriefing(cwd);
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

// TEAM_MEMBER_BRIEFING/TEAM_MEMBER_STANDBY_NOTE는 lib/teamMemberBriefing.ts에 있다 —
// TEAM_MEMBER_BRIEFING은 SKILL.md에도 문자 그대로 복사돼있어야 해서(팀장이 직접 띄우는
// 팀원도 같은 브리핑을 받아야 함), tests/skillBriefingSync.test.js가 그 동기화를 검증한다.

// 팀장이 알아서 판단해서 띄우는 것과 별개로, 사용자가 직접 특정 역할(코드리뷰 등)을 주고
// 팀원을 띄운다 — 어떤 팀장 소속으로 붙일지는 사용자가 고른다(대화창에서 선택 중인 팀장 등).
// label은 사용자가 이 팀원을 구분하려고 직접 붙인 이름이다. 렌더러(add-member-submit-btn)가
// 비어있으면 막긴 하지만, 그건 UI 하나뿐인 방어선이라 여기서도 다시 확인한다 — 그래야 렌더러
// 쪽 검증이 언젠가 우회되거나 깨지더라도 이름 없는 팀원이 실제로 만들어지는 일은 없다.
async function launchMember(leadId: string, targetDir: string, instruction: string, role: string, label: string): Promise<string | null> {
  // 빈 이름은 CLI 실행 실패(null 반환 → "터미널을 확인해보라"는 안내)와 다른 원인이라, 렌더러가
  // 왜 실패했는지 구분해서 보여줄 수 있게 별도 에러로 던진다.
  if (!label || !label.trim()) throw new Error('이 팀원을 구분할 이름을 입력해주세요.');
  // role은 화면 라벨용 메타데이터에 그치지 않고, Claude 세션 자신도 알 수 있게 프롬프트에 박아준다.
  const roleLine = role ? `역할: ${role}\n\n` : '';
  const prompt = `${TEAM_MEMBER_BRIEFING}\n\n${roleLine}${TEAM_MEMBER_STANDBY_NOTE}\n\n"""\n${instruction}\n"""`;
  const id = await runClaudeBg(['--bg', prompt], targetDir);
  if (!id) return null;
  registerMember({ memberId: id, leadId, createdAt: Date.now(), role: role || undefined, label: label.trim() });

  // 팀장이 스스로 띄운 게 아니라서 알려주지 않으면 이 팀원의 존재도 결과도 영원히 모른다 — 다만
  // 팀장이 지금 다른 작업으로 busy일 수 있어서 즉시 stop→resume으로 끼어들지 않고 큐에 쌓아둔다.
  // buildSessionRows가 폴링마다 이 큐를 보고, 팀장이 idle/blocked가 됐을 때만 실제로 전달한다.
  // (팀원은 대기 상태로 시작하므로, 이 알림을 받은 팀장이 실제 작업 개시 메시지를 별도로 보내야 한다.)
  // queueLeadNotice는 internalId를 받으므로, IPC로 넘어온 짧은 id(leadId)를 여기서 변환한다.
  const leadRec = loadLeads().find(l => l.id === leadId);
  if (leadRec) {
    queueLeadNotice(leadRec.internalId, `[알림] 사용자가 직접 팀원을 추가했습니다 — 이름: ${label}, 디렉토리: ${targetDir}${role ? `, 역할: ${role}` : ''}, 사전 지시(참고용): "${instruction}", 세션 id: ${id}. 이 팀원은 이미 팀원 공통 브리핑(백그라운드 세션 유의사항)을 전달받은 상태이며, 지금 준비 완료 응답만 남기고 대기 중이니, 필요하면 관리 대상에 추가하고 실제 작업을 시작하라는 메시지를 직접 보내라(stop→resume). 완료되면 확인해서 최종 보고에 포함시켜라.`, 'system');
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

ipcMain.handle('launch-member', async (_e, leadId: string, targetDir: string, instruction: string, role: string, label: string) =>
  launchMember(leadId, targetDir, instruction, role, label));

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
  return getTranscript(projectName, lead.sessionId, lead.targetDir);
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
  const isBusy = !!agent && getStatus(agent) === 'busy';
  if (isBusy) {
    const noticeId = queueLeadNotice(lead.internalId, message, 'user');
    return { status: 'queued' as const, id: noticeId };
  }

  const id = await queueLeadOperation(lead.internalId, () => resumeLead(lead.internalId, message));
  return { status: 'sent' as const, id };
});

// 대기열에 쌓아둔 메시지 중 아직 전달 안 된 것을 사용자가 취소할 수 있게 한다(채팅창의 "취소" 버튼).
ipcMain.handle('cancel-queued-message', (_e, leadId: string, noticeId: string) => cancelQueuedNotice(leadId, noticeId));

// 이 팀장 앞으로 아직 서버에 남아있는(전달 안 된) 대기열 알림들의 id 목록을 돌려준다 — 렌더러는
// 짧은 id만 알고 있으므로 여기서 internalId로 변환해서 찾는다. 두 곳에서 쓴다: (1) 재시작/작업종료
// 확인 모달의 "몇 건 남았는지" 경고(개수만 필요), (2) deliverPendingNotices가 이제 같은 팀장 앞
// 여러 건을 하나로 합쳐서 보낼 수 있어서, 대화창의 각 큐 항목이 실제로 전달됐는지를 더 이상
// 원문 텍스트로 트랜스크립트와 대조할 수 없다 — 이 id 목록에 더 이상 없으면 전달된 것으로 본다.
ipcMain.handle('get-pending-notice-ids', (_e, leadId: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return [];
  return loadPendingNotices().filter(n => n.leadInternalId === lead.internalId).map(n => n.id);
});

ipcMain.handle('update-lead-label', (_e, leadId: string, label: string) => {
  const leads = loadLeads();
  const lead = leads.find(l => l.id === leadId);
  if (lead) { lead.label = label.trim(); saveLeads(leads); }
  return leads;
});

ipcMain.handle('restart-lead', async (_e, leadId: string, instruction: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return { error: '팀장을 찾을 수 없습니다 — 이미 종료됐거나 목록이 갱신됐을 수 있습니다.' };
  const finalInstruction = instruction.trim() || '지금 상황을 파악하고 다음 작업을 시작해줘.';
  return queueLeadOperation(lead.internalId, () => restartLead(lead.internalId, finalInstruction));
});

ipcMain.handle('end-lead-work', async (_e, leadId: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return { success: false, memberFailures: [] };
  return queueLeadOperation(lead.internalId, () => endLeadWork(lead.internalId));
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
