import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { exec, execFile, spawn } from 'child_process';
import { trackFirstMiss, pruneMissingKeys } from './lib/firstMissTracker';
import { resolveWithinCwd, isSafeId } from './lib/pathGuard';
import { getStatus } from '../renderer/lib/status';
import { writeJsonFileAtomic } from './lib/jsonFile';
import { TEAM_MEMBER_BRIEFING, TEAM_MEMBER_STANDBY_NOTE } from './lib/teamMemberBriefing';
import { looksLikeApprovalRequest, parseStallVerdict, isStatusEligibleForStall, shouldCheckStall, shouldSendNudge } from './lib/stallGuard';
import { MEMBER_MODEL_OPTIONS, clampMinutes, normalizeMemberModel } from './lib/appSettings';
import { extractBackgroundedId, extractStartedCopyId } from './lib/claudeBgOutput';
import { CLAUDE_HOME, MEMBERS_DIR } from './lib/teamMemberPaths';
import { hasLiveMember } from './lib/leadPresence';
import { execAgentsJson } from './lib/agentsJson';
import { checkDirectoryClaudeReady, claudeNotReadyMessage } from './lib/claudeReadiness';
import { shellSingleQuote, escapeAppleScriptString } from './lib/terminalCommand';
import { resolveLongPrompt } from './lib/longPromptGuard';

const SESSION_EDITS_DIR = path.join(CLAUDE_HOME, 'session-edits');
// daily-journal은 별도로 설치하는 플러그인이라(이 앱이 번들하지 않음) 있을 수도 없을 수도 있고,
// 있다면 기록을 저장하는 디렉토리(journal.output_dir)를 사용자가 user-config.json에서 직접
// 바꿀 수 있다 — 기본값은 여기 DEFAULT_JOURNAL_DATA_DIR과 같지만, 사용자가 다른 곳(동기화 폴더
// 등)으로 바꿔놓으면 이 앱이 하드코딩된 기본 경로만 보다가 "기록이 없다"고 조용히 오판할 수 있다
// (실사용 지적, 2026-09-18). daily-journal 자신의 config.ts(getTodayDir이 정확히 이 순서로
// 읽음)와 같은 방식으로 매번 user-config.json을 확인해서, output_dir이 설정돼 있으면 그 값을
// 우선한다 — daily-journal이 아예 안 설치돼 있으면(파일 없음) 그냥 기본값으로 fail-open한다.
const DEFAULT_JOURNAL_DATA_DIR = path.join(CLAUDE_HOME, 'daily-journal', 'data');
function resolveJournalDataDir(): string {
  try {
    const raw = fs.readFileSync(path.join(CLAUDE_HOME, 'daily-journal', 'user-config.json'), 'utf-8');
    const outputDir = JSON.parse(raw)?.journal?.output_dir;
    if (typeof outputDir === 'string' && outputDir.trim()) return outputDir;
  } catch {
    // user-config.json이 없거나(daily-journal 미설치·기본값 사용 등) 읽기/파싱에 실패하면
    // daily-journal 자신도 기본값을 쓰므로 이 앱도 그대로 따라간다.
  }
  return DEFAULT_JOURNAL_DATA_DIR;
}
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const SKILL_SRC = path.join(getResourcesRoot(), 'skills', 'team-lead', 'SKILL.md');
const SKILL_DEST_DIR = path.join(CLAUDE_HOME, 'skills', 'team-lead');
const FAVORITES_PATH = path.join(app.getPath('userData'), 'favorites.json');
const MEMBER_TEMPLATES_PATH = path.join(app.getPath('userData'), 'memberTemplates.json');
const LEADS_PATH = path.join(app.getPath('userData'), 'leads.json');
const PENDING_NOTICES_PATH = path.join(app.getPath('userData'), 'pendingNotices.json');
const STALL_ALERTS_PATH = path.join(app.getPath('userData'), 'stallAlerts.json');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const APP_LOG_PATH = path.join(app.getPath('userData'), 'app.log');
// 팀장 세션(claude 프로세스, 이 앱과 별개)도 알아야 하는 고정 경로라서 앱 userData가 아니라 ~/.claude 밑에 둔다.
const REQUESTS_DIR = path.join(CLAUDE_HOME, 'claude-team-monitor', 'requests');
// claude CLI 자신의 daemon job 상태 파일 — readPendingChoiceQuestions가 AskUserQuestion으로 뜬
// 구조화된 선택지를 읽어오는 데 쓴다(claude agents --json엔 이 상세 내용이 없다).
const JOBS_DIR = path.join(CLAUDE_HOME, 'jobs');
// MEMBERS_DIR은 lib/teamMemberPaths에서 가져온다 — 팀원 생성 MCP 서버도 똑같은 경로를 써야 한다.

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
// deliverPendingNotices가 같은 알림(그룹)의 배달(resumeLead)을 이 횟수만큼 연속 실패하면 더 이상
// 자동 재시도하지 않는다 — 영원히 안 풀리는 팀장에게 무기한 재시도하며 프로세스 스폰/로그를
// 낭비하지 않기 위한 회로차단기(팀원 코드리뷰에서 지적).
const MAX_NOTICE_DELIVERY_ATTEMPTS = 5;

// resumeLead가 stop 직후 --resume을 걸면 "source session ... not found"로 크래시하거나(daemon 레이스로
// 추정), CLI가 원본을 잇는 대신 복사본을 새로 만들어버리는(mcp-config를 --resume에 다시 실어 보내던 게
// 직접 원인으로 확정됨 — 이제는 안 보냄, resumeSpawnWithRetry 주석 참고) 사고가 실사용 중 여러 번
// 재현됐다(2026-09-17). 그래서 재시도 인프라(아래 세 상수) 자체는 남겨뒀지만, 근본 원인이 고쳐지고 나서
// "혹시 몰라 매번 13초씩 기다렸다가 확정한다"는 예전 방식은 정상 경로에 상시 세금이 되어버렸다 —
// resumeSpawnWithRetry는 첫 시도는 기다리지 않고 바로 응답하고, 이 값들은 (1) 첫 시도가 그 자리에서
// 바로 실패했을 때의 동기 재시도, (2) 첫 시도가 성공한 것처럼 보였다가 나중에 조용히 죽었을 때의
// 백그라운드 복구, 이 두 경우에만 쓰인다 — "나중에 다른 원인의 버그가 있을 수 있다"는 가능성에 대비한
// 안전망이지, 정상 경로의 일부가 아니다. 사용자 피드백: "쭉은 아니고 텀을 두고 세 번 정도".
const RESUME_SETTLE_CHECK_MS = 13000;
const RESUME_RETRY_GAP_MS = 5000;
const MAX_RESUME_ATTEMPTS = 3;
// internalId -> 지금 몇 번째/최대 몇 번 재시도 중인지 — 렌더러가 채팅창에 "재시도 중 (n/m)"으로
// 보여줄 수 있게 buildSessionRowsInternal이 SessionRow에 실어서 내려준다. 정상 경로(첫 시도가 바로
// 성공)에서는 채워지지 않는다 — 실제로 재시도(동기든 백그라운드든)에 들어갔을 때만 채워진다.
const resumeRetryStatus = new Map<string, { attempt: number; max: number }>();

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
// resumeSpawnWithRetry가 추가된 뒤로는 "resume 한 번"의 최악 시간이 RUN_CLAUDE_TIMEOUT_MS
// 하나가 아니라 (RUN_CLAUDE_TIMEOUT_MS + 크래시 확인 대기) x 최대 재시도 횟수 + 재시도 사이 간격
// 전부를 더한 값이다 — 바로 위 주석이 경고하는 실수(타임아웃만 늘리고 유예는 안 늘리는 것)를
// 그대로 반복하지 않기 위해 이것도 계산식에 포함한다. 첫 시도가 바로 성공하는 정상 경로는 이제 이
// 시간의 극히 일부만 쓰지만(크래시 확인 대기 없이 바로 반환), 실패해서 동기 재시도로 넘어가는
// 최악의 경우엔 여전히 이 계산이 그대로 적용되므로 값 자체는 안전 쪽으로 그대로 둔다(과대추정이라도
// 유예가 모자란 것보다 낫다).
const RESUME_SPAWN_WORST_CASE_MS =
  MAX_RESUME_ATTEMPTS * (RUN_CLAUDE_TIMEOUT_MS + RESUME_SETTLE_CHECK_MS) + (MAX_RESUME_ATTEMPTS - 1) * RESUME_RETRY_GAP_MS;
const STOP_AND_RELAUNCH_WORST_CASE_MS = STOP_SESSION_TIMEOUT_MS + RESUME_SPAWN_WORST_CASE_MS;
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

// "정체 감시" — 팀장이 팀원 보고를 처리하고도 다음 지시를 깜빡해서 팀원이 idle/done 상태로
// 방치되는 사고(실사용 재현: g1cl-test/c7aa91ed가 state: done으로 멈춰서 다음 지시를 못 받음)를
// 잡기 위한 값. 팀원과 팀장이 둘 다 이 시간 이상 idle이어야 확인 대상이 된다 — 둘 중 하나라도
// 바쁘면 자연히 흘러갈 상황이니 굳이 건드리지 않는다. 위 LEAD_OFFLINE_GRACE_MS류와 달리 이
// 두 값은 실측된 CLI 재기동 속도가 아니라 순전히 "얼마나 기다려야 방치로 볼지"에 대한 사용자
// 취향 문제라, AppSettings로 사용자가 바꿀 수 있게 열어둔다(설정 파일에 없으면 이 기본값을 쓴다).
const STALL_IDLE_THRESHOLD_MS_DEFAULT = 10 * 60 * 1000;
// 한 번 확인(alert 생성 여부와 무관하게)했으면 이 시간 안에는 같은 팀원을 다시 확인하지 않는다 —
// 매 폴링(3초)마다 Haiku를 계속 부르는 낭비를 막는다.
const STALL_RECHECK_COOLDOWN_MS_DEFAULT = 20 * 60 * 1000;
// Haiku 서브 에이전트 한 번 호출에 걸리는 실측 시간(콜드 스타트 포함 최대 수십 초)을 감안한
// 타임아웃 — 이건 CLI 자체의 실측 성능 특성이라 사용자 설정 대상이 아니다.
const STALL_CLASSIFIER_TIMEOUT_MS = 45000;

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
  // AskUserQuestion처럼 구조화된 선택지로 멈춘 경우에만 claude agents --json이 이 값을 준다(실측
  // 확인: 2026-09-17, 자연어로만 물어본 경우엔 안 뜸) — "input needed"면 readPendingChoiceQuestions로
  // 실제 질문·선택지를 더 가져올 수 있다는 신호로 쓴다.
  waitingFor?: string;
};

// (2026-09-17 실사용 사고로 되돌림) 한때 이 함수가 getStatus()==='busy'뿐 아니라 state==='working'도
// "바쁘다"로 봤다 — 실제 프로덕션에서 status:'idle'·state:'working'이 동시에 관측된 사례가 있어서,
// 도구 실행 중인 팀장을 안 바쁘다고 오판해 끼어드는 사고를 막으려던 것이었다. 그런데 그 우려의 진짜
// 원인은 "resume에 mcp-config를 다시 실어 보내면 CLI가 복사본을 만든다"는 것이었고(resumeSpawnWithRetry
// 주석 참고) 그건 이제 근본적으로 고쳤다 — 더 이상 끼어들어도 복사본이 생기지 않는다. 반면 state가
// 'working'에서 실제로는 다 끝났는데도 계속 고정된 채 안 바뀌는 세션이 실사용으로 확인됐다(d53632df,
// 몇 분 넘게 idle인데 state만 working) — state==='working'을 바쁨 신호로 쓰면 이런 세션은 큐에 쌓인
// 메시지가 영원히(자동으로는 다시 안 풀리는 채로) 배달 안 되는, 원래 막으려던 것보다 더 나쁜 사고로
// 이어진다. 그래서 status만 다시 본다 — send-to-lead/deliverPendingNotices 전용 판정이고, 보드
// 표시용 getStatus()의 일반 라벨링 의미는 안 건드린다.
//
// waitingFor==='input needed'(AskUserQuestion으로 멈춘 상태)도 여기서 같이 막는다 — 실사용 지적
// (2026-09-18): 채팅 "전송"(수동)뿐 아니라 deliverPendingNotices(자동 큐 배달)도 이 판정 하나를
// 그대로 타므로, 여기서 안 막으면 대기 중이던 큐 메시지가 자동으로 stop→resume을 걸어 선택지를
// declined 처리해버린다(오늘 실측 확인된 그 사고를, 사람이 안 시켰는데도 재현하는 셈). state===
// 'working'과 달리 이건 "끝났는데도 안 풀리는" 종류가 아니라 "터미널에서 답하거나 daemon이 자체
// 재기동하면서 자연히 풀리는" 종류라(오늘 실측: 두 경우 다 waitingFor가 사라짐) 영구 미배달로
// 이어질 위험은 낮다고 판단했다.
function isLeadTooBusyToInterrupt(agent: AgentEntry): boolean {
  return getStatus(agent) === 'busy' || agent.waitingFor === 'input needed';
}

type SessionRow = AgentEntry & {
  projectName: string;
  preview?: { time: string; prompt: string; answer: string; summary?: string } | null;
  isLead: boolean;
  leadId?: string; // 팀원 카드일 때, 소속 팀장의 짧은 id
  role?: string;   // 팀원 카드일 때, 등록된 역할(예: reviewer)
  label?: string;  // 팀장 카드일 때, 사용자가 붙인 이름표(같은 디렉토리에서 여러 팀장을 구분하기 위함)
  offline?: boolean; // 팀장 카드일 때, 지금 프로세스가 떠있지 않음(재부팅 등) — 채팅으로 메시지를 보내면 다시 깨어남
  // 팀장 카드일 때만: reconcileLeadIds가 폴링 중 짧은 id를 조용히 바꿔도(이 앱이 관여 안 한
  // 재시작), 렌더러가 "선택 중이던 그 팀장"을 짧은 id 대신 이 안정적인 값으로 계속 따라갈 수
  // 있게 내려준다. 여러 팀장을 동시에 띄워둔 상황에서 id 드리프트가 나면, 렌더러가 이걸 몰라서
  // "지금 선택된 팀장이 목록에서 사라졌다"고 오판해 아무 온라인 팀장으로나(첫 번째) 자동
  // 전환해버려 사용자 모르게 대화창이 엉뚱한 팀장으로 바뀔 수 있었다.
  internalId?: string;
  autoStallNudge?: boolean; // 팀장 카드일 때만: 정체 감시가 확인 없이 곧바로 재촉 메시지를 보낼지
  // 팀장 카드일 때만: resumeSpawnWithRetry가 daemon 레이스로 인한 크래시를 재시도하는 중이면
  // 채워진다 — 렌더러가 채팅창에 "재시도 중 (n/m)"으로 보여준다.
  resumeRetrying?: { attempt: number; max: number };
  secret?: boolean; // 팀장·팀원 카드 공통: LeadRecord.secret/MemberRecord.secret을 그대로 반영 — 🔒 표시용
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
  secret?: boolean; // 시크릿 팀장이 spawn_team_member로 띄운 팀원이면 true — 화면 표시용
                     // (실제로 훅을 껐는지는 스폰 시점의 CLI 인자가 결정하고, 이 필드는 그 결과를
                     // 사용자에게 보여주기 위한 라벨일 뿐이다).
};

// "팀장 디렉토리" — 팀장을 어디서 띄울지 고르는 용도의 단순 등록 목록. 팀원 관련 결정(역할·사전승인)은
// 별도의 MemberTemplate이 담당한다 — 둘을 하나로 묶지 않는다(등록 ≠ 역할부여 ≠ 사전승인).
type Favorite = { path: string; name: string };

// 사용자가 바꿀 수 있는 값만 여기 둔다 — LEAD_OFFLINE_GRACE_MS류(실측 CLI 성능에 맞춰 계산된 값)는
// 절대 포함하지 않는다. 분 단위로 저장·표시하고(사람이 이해하기 쉬움), 실제 로직에서만 ms로 바꿔 쓴다.
type AppSettings = {
  stallIdleThresholdMin: number;
  stallCooldownMin: number;
};

// "팀원 등록(역할 템플릿)" — 재사용 가능한 팀원 정의. 서로 독립적인 두 축으로 정해진다:
// - scope(소속): 'shared'면 모든 팀장이 쓸 수 있고, 특정 디렉토리 경로면 그 디렉토리에서 도는
//   팀장만 이 템플릿을 브리핑받는다. 팀장은 stop/resume을 거치며 짧은 id가 계속 바뀌므로, 안정적인
//   식별자로 팀장 자신의 디렉토리(targetDir)를 "소속" 값으로 쓴다.
// - path(디렉토리): 이 팀원이 실제로 일할 디렉토리. 있으면 그 안에서만, 없으면 쓸 때마다 그때그때
//   고른다. approved는 path가 있을 때만 의미 있다(사전승인이면 매번 체크박스 없이 자동 브리핑).
// MEMBER_MODEL_OPTIONS/normalizeMemberModel은 lib/appSettings.js에 있다(순수 함수라 단위 테스트
// 대상). 리뷰어처럼 가벼운 역할엔 싼 모델을, 구현처럼 무거운 역할엔 비싼 모델을 쓰는 식으로
// 역할별 비용/품질 트레이드오프를 사용자가 직접 정할 수 있게 한다.
type MemberModel = typeof MEMBER_MODEL_OPTIONS[number];

type MemberTemplate = {
  id: string;
  scope: string; // 'shared' | <팀장 디렉토리 경로>
  path?: string;
  name: string;
  role: string;
  instruction: string;
  approved: boolean; // path가 있을 때만 의미 있음
  model?: MemberModel; // 없으면(구버전 템플릿) 'default'와 동일하게 취급
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
  // true면 정체 감시(runStallWatchdog)가 StallAlert로 사용자 확인을 기다리지 않고 곧바로
  // queueLeadNotice로 재촉 메시지를 보낸다. 기본값(없음/false)은 반자동 — 안전 게이트(blocked
  // 하드 게이트·정규식 안전장치)는 이 값과 무관하게 항상 적용된다. 사용자가 팀장 카드에서 직접 켠다.
  autoStallNudge?: boolean;
  // 팀원 생성 MCP 서버(src/mcp/teamMemberServer.ts)가 "이 프로세스가 어느 팀장인지"를 알아내는
  // 상관값. sessionId를 그대로 못 쓰는 이유: launchTeamLead/restartLead처럼 새 세션을 스폰하는
  // 경로는 claude --bg 실행 전엔 결과 sessionId를 알 수 없어서(CLI가 실행 후에 발급), 스폰 전에
  // --mcp-config 환경변수로 미리 넘겨줄 값이 필요하다 — 그래서 이 앱이 스폰 직전에 직접 발급하는
  // 별도 토큰을 쓴다. 짧은 id/sessionId와 달리 매 재개(resume)/재시작마다 새로 발급해도 무방하다
  // (이 프로세스 인스턴스 하나의 수명 동안만 유효하면 됨 — internalId처럼 영구히 안정적일 필요는 없다).
  mcpToken?: string;
  // true면 launchTeamLead/restartLead가 SECRET_MODE_CLI_ARGS를 실어 daily-journal 등 user-level
  // 훅이 아예 안 뜨게 띄운다(실측 확인: --setting-sources project,local이면 PostToolUse/Stop 훅이
  // 트리거되지 않는다 — daily-journal의 user-config.json을 건드릴 필요가 없다). resumeLead는 이
  // 플래그를 다시 안 실어 보낸다 — --resume에 저장된 옵션을 다시 실으면 복사본이 생기는 것과 같은
  // 이유로(resumeSpawnWithRetry 주석 참고), 세션이 이미 시작 시점에 물려받은 설정을 그대로 쓴다.
  // 사용자가 팀장 카드에서 직접 켠다.
  secret?: boolean;
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
// attempts는 deliverPendingNotices가 이 알림의 배달(resumeLead)을 시도했다가 실패해서 큐에 되돌린
// 횟수다(옵션 — 옛 파일/새로 쌓인 알림엔 없을 수 있어 없으면 0으로 취급). 영원히 stop이 안 되는
// 팀장(좀비 프로세스 등)에게 무한정 재시도하며 프로세스 스폰과 에러 로그를 낭비하지 않도록 상한을
// 두는 데 쓴다(팀원 코드리뷰에서 지적: 재시도 횟수 상한/회로차단기가 없었다).
type PendingNotice = { id: string; leadInternalId: string; message: string; createdAt: number; origin: 'user' | 'system'; attempts?: number };

// 정체 감시(runStallWatchdog)가 만들어내는, 사용자 확인을 기다리는 항목. 사용자가 화면에서
// "이어서 진행 지시"를 눌러야 실제로 queueLeadNotice로 전달된다(반자동 — 앱이 판단은 하되
// 사람 확인 없이 살아있는 세션에 자동으로 메시지를 찔러 넣지는 않는다). memberId는 이 알림이
// 어느 팀원의 정체를 근거로 만들어졌는지(중복 생성 방지·화면 표시용).
type StallAlert = {
  id: string;
  leadInternalId: string;
  memberId: string; // 화면 표시용 — 알림 생성 시점의 짧은 id라, 그 뒤 드리프트되면 낡은 값일 수 있다
  memberSessionId: string; // 중복 알림 방지의 진짜 기준값 — 짧은 id가 바뀌어도 안 바뀐다
  reason: string; // Haiku가 판단 근거로 남긴 한 줄 요약
  suggestedMessage: string; // 사용자가 확인을 누르면 그대로 팀장에게 전달될 메시지
  createdAt: number;
};

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
    // git이 자격증명 프롬프트나 lock 경합으로 멈추면 타임아웃 없이는 이 패널이 무한 로딩에 빠진다
    // (팀원 버그헌팅에서 지적) — 다른 exec 호출들과 같은 방어를 준다.
    exec('git status --porcelain', { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: 10000 }, (err, stdout) => {
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
    execFile('git', ['diff', 'HEAD', '--', file], { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 10000 }, (err, stdout) => {
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
    const journalDataDir = resolveJournalDataDir();
    if (!fs.existsSync(journalDataDir)) return [];
    const dates = fs.readdirSync(journalDataDir)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    const entries: any[] = [];
    for (const date of dates) {
      const file = path.join(journalDataDir, date, 'history', `${projectName}.jsonl`);
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

// 패키지된(배포된) 앱은 콘솔 창이 없어서 console.error가 정말로 아무 데도 안 남는다(실사용으로
// 확인됨 — 오늘 겪은 세션 포크/알림 유실 사고의 원인을 사후에 전혀 추적할 수 없었던 이유). 사용자가
// 원인을 알 수 없이 겪는 실패("왜 메시지가 하나도 안 가지")로 이어지는 핵심 실패 지점만 골라
// 콘솔과 별개로 파일에도 남긴다 — 모든 console.error를 다 옮기진 않는다(그러면 이 파일이 통상적인
// 디버그 로그가 돼서 정작 봐야 할 때 못 찾는다).
function logCritical(message: string): void {
  console.error(message);
  try {
    fs.appendFileSync(APP_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // 로그 자체가 실패해도(디스크 문제 등) 앱 동작에는 지장이 없어야 한다.
  }
}

// exec/파싱 실패 시 빈 배열로 fail-open한다 — 보드 표시처럼 "일시적으로 몇 초 못 그려도 그만"인
// 곳엔 맞는 선택이다. stopSession의 생존 확인처럼 "빈 배열=확실히 죽었다"로 오판하면 안 되는 안전
// 검사에는 아래 fetchAgentsStrict를 대신 써라(팀원 코드리뷰에서 지적됨).
function fetchAgents(): Promise<AgentEntry[]> {
  return (execAgentsJson() as Promise<AgentEntry[]>).catch(() => [] as AgentEntry[]);
}

// exec/파싱이 실패하면(타임아웃 포함) 조용히 빈 배열로 넘어가지 않고 reject한다 — 호출부가 "확인
// 안 됨"과 "정말 빈 목록"을 구분해서, 확인 안 된 상황을 fail-closed(안전한 쪽으로 가정)로 처리할 수
// 있게 한다.
function fetchAgentsStrict(): Promise<AgentEntry[]> {
  return execAgentsJson() as Promise<AgentEntry[]>;
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

// deliverPendingNotices가 배달을 "시도"한 시점에 큐에서 미리 지워둔 알림을, 그 시도(resumeLead)가
// 실제로 실패했을 때 되돌리는 데 쓴다 — 되돌릴 때는 그 사이(비동기로 기다리는 동안) 다른 경로가
// pendingNotices.json에 새로 쌓아뒀을 수 있는 항목을 덮어쓰지 않도록, 그 시점의 최신 목록에 이어붙인다.
function requeuePendingNotices(notices: PendingNotice[]): void {
  savePendingNotices([...loadPendingNotices(), ...notices]);
}

function savePendingNotices(notices: PendingNotice[]): void {
  try {
    writeJsonFileAtomic(PENDING_NOTICES_PATH, notices);
  } catch (err) {
    console.error('[savePendingNotices] pendingNotices.json 저장 실패:', err);
  }
}

function loadStallAlerts(): StallAlert[] {
  return readJsonArraySafe<StallAlert>(STALL_ALERTS_PATH);
}

function saveStallAlerts(alerts: StallAlert[]): void {
  try {
    writeJsonFileAtomic(STALL_ALERTS_PATH, alerts);
  } catch (err) {
    console.error('[saveStallAlerts] stallAlerts.json 저장 실패:', err);
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
      .filter((m): m is MemberRecord => !!m)
      // memberId는 나중에 cleanupStaleMembers/reconcileMemberIds/endLeadWork 등에서 그대로
      // 삭제·쓰기 경로에 이어붙는다 — 이 파일은 외부 세션이 직접 쓰는 것이라(SKILL.md 참고)
      // 내용 자체가 조작된 경로 문자열일 수 있으니, 여기서(가장 먼저 들어오는 지점에서) 걸러야
      // 이후 어떤 소비처도 그 값을 다시 검증할 필요가 없다.
      .filter(m => {
        if (isSafeId(m.memberId)) return true;
        console.error(`[loadMembers] memberId 형식이 안전하지 않아 무시합니다: ${JSON.stringify(m.memberId)}`);
        return false;
      });
  } catch {
    return [];
  }
}

// memberId별/leadId별 "처음 못 잡힌 시각"을 폴링 사이에도 유지해야 하므로 모듈 스코프에 둔다.
// 유예 판정 자체(trackFirstMiss)는 순수 함수로 뽑아서 lib/firstMissTracker.ts에 있다 — 팀원
// 정리와 팀장 오프라인 판정이 겪는 TOCTOU가 완전히 같아서 그 4단계 로직을 공용으로 쓴다.
const memberFirstMissAt = new Map<string, number>();
const leadFirstMissAt = new Map<string, number>();
// computeOfflineLeads의 콜드 스타트 그레이스 우회에 쓴다 — 앱을 새로 켠 뒤 첫 폴링에서만 false.
let hasCompletedFirstPoll = false;

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
        internalId: isLead ? lead?.internalId : undefined,
        autoStallNudge: isLead ? lead?.autoStallNudge : undefined,
        secret: isLead ? lead?.secret : member?.secret,
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

// ---------------- 정체 감시(stall watchdog) ----------------
// notifyLeadsOfFinishedMembers는 busy→idle 전환 "순간"에 딱 한 번만 팀장에게 알린다 — 팀장이 그
// 알림을 처리하고도(예: 보고서만 갱신하고) 팀원에게 다음 지시를 깜빡하면, 그 한 번의 알림 이후로는
// 아무도 다시 재촉하지 않아 팀원이 idle/done 상태로 무기한 방치될 수 있다(실사용 재현: g1cl-test의
// 팀원 c7aa91ed가 state: done인 채 계속 대기, 사용자가 직접 "하고있니?"라고 물어야 발견됨).
// 이 아래 로직은 그 방치를 감지해서 "이어서 진행하라"는 표준 프롬프트를 보낼지 사용자에게 물어보는
// 알림(StallAlert)을 만든다. 값싼 Haiku 서브 에이전트가 최근 대화 몇 턴만 보고 판단하되, 그 판단
// 하나만으로는 절대 메시지를 보내지 않는다 — blocked(승인 대기) 상태는 앱 코드가 하드 게이트로
// 걸러내고(shouldCheckStall), 팀장의 마지막 답변이 질문/승인 요청처럼 보이면 정규식으로도 한 번 더
// 막으며(shouldSendNudge), 최종적으로도 사용자가 화면에서 직접 확인을 눌러야만 실제로 전달된다
// (confirm-stall-alert IPC 참고) — Haiku의 판단·프롬프트 하나만 믿지 않는 다중 방어.
// 세 Map 전부 짧은 id가 아니라 sessionId로 키를 잡는다 — 리뷰에서 실측 재현된 버그: 짧은 id로
// 키를 잡으면, 세션이 stop→resume 등으로 외부에서 재기동돼 짧은 id만 바뀌어도(reconcileLeadIds/
// reconcileMemberIds가 짧은 id는 바로잡아주지만 이 Map들은 몰랐다) 여기 쌓인 값이 새 id에서는
// "처음 보는 키"가 돼서 조용히 리셋됐다 — 팀원/팀장이 짧은 id 드리프트를 반복하면 정체 감지가
// 사실상 무기한 미뤄질 수 있었다. sessionId는 같은 세션이 살아있는 동안 절대 안 바뀌므로(짧은
// id와 달리) 이 키로 쓰면 드리프트에 영향을 받지 않는다 — 세션이 통째로 교체될 때만(새 sessionId
// 발급) 정당하게 타이머가 리셋된다.
const memberIdleSince = new Map<string, number>(); // 팀원 sessionId -> idle/done으로 바뀐 시각
const leadIdleSince = new Map<string, number>();   // 팀장 sessionId -> idle/done으로 바뀐 시각
const stallLastCheckedAt = new Map<string, number>(); // 팀원 sessionId -> 마지막으로 실제 Haiku를 호출한 시각
let stallWatchdogInFlight = false; // Haiku 호출이 몇 초~몇십 초 걸리므로, 3초 폴링과 겹쳐 돌지 않게 막는다

function buildStallClassifierPrompt(tailText: string, memberDesc: string): string {
  return [
    '당신은 팀장 세션이 방치되고 있는지 판단하는 보조 도구입니다. 아래는 어떤 "팀장" AI 세션의',
    '최근 대화 일부와, 그 팀장에게 소속된 팀원 상태 설명입니다.',
    '',
    `[팀원 상태] ${memberDesc}`,
    '',
    '[팀장의 최근 대화]',
    tailText || '(대화 기록 없음)',
    '',
    '이 정보만 보고 판단하세요:',
    '- shouldNudge: 팀장이 실수로 다음 지시를 깜빡한 것으로 보이면 true, 이미 할 일이 다 끝났거나',
    '  판단하기 애매하면 false.',
    '- waitingForUser: 팀장이 사람의 확인/승인/선택을 기다리고 있는 것으로 조금이라도 보이면 true.',
    '  이 경우 shouldNudge 값과 무관하게 절대 재촉하면 안 되는 상황이니, 조금이라도 의심되면',
    '  반드시 true로 답하세요(애매하면 true 쪽으로 치우치세요).',
    '- reason: 판단 근거를 한국어 한 문장으로.',
    '',
    '다른 설명 없이 이 형식의 JSON만 출력하세요:',
    '{"shouldNudge": boolean, "waitingForUser": boolean, "reason": string}',
  ].join('\n');
}

// Haiku로 단발성 판단만 받는다 — --bg(백그라운드 세션)이 아니라 -p(print, 1회성 응답 후 종료)를
// 쓴다. 세션 컨텍스트가 필요 없는 순수 분류 작업이라 매번 새 프로세스로 충분하고, 그래야 비용도
// 최소화된다. cwd를 프로젝트 디렉토리가 아니라 임시 디렉토리로 둬서 어떤 프로젝트의 CLAUDE.md도
// 로드하지 않게 한다(판단에 불필요한 컨텍스트를 섞지 않기 위함 + 토큰 절약).
function runStallClassifier(tailText: string, memberDesc: string): Promise<ReturnType<typeof parseStallVerdict>> {
  const prompt = buildStallClassifierPrompt(tailText, memberDesc);
  return new Promise(resolve => {
    let out = '';
    let settled = false;
    const finish = (value: ReturnType<typeof parseStallVerdict>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const child = spawn(
      'claude',
      ['-p', '--model', 'haiku', '--output-format', 'json', prompt],
      { cwd: os.tmpdir() },
    );
    const timer = setTimeout(() => {
      console.error('[runStallClassifier] Haiku 분류 호출이 응답 없이 대기 중이라 강제 종료합니다.');
      child.kill();
      finish(null);
    }, STALL_CLASSIFIER_TIMEOUT_MS);
    child.stdout?.on('data', d => { out += d.toString(); });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        finish(parseStallVerdict(parsed.result));
      } catch (err) {
        console.error('[runStallClassifier] Haiku 응답 파싱 실패(fail-closed로 처리):', err);
        finish(null);
      }
    });
    child.on('error', err => {
      console.error('[runStallClassifier] claude 프로세스를 실행하지 못했습니다:', err);
      finish(null);
    });
  });
}

// 매 폴링마다 호출된다. 실제로 Haiku를 부르는 건 조건을 만족하는 후보가 있을 때뿐이라 평상시엔
// 거의 비용이 없다. await하지 않고 fire-and-forget으로 호출된다(buildSessionRowsInternal이 3초
// 폴링뿐 아니라 채팅 전송 직후 refresh-board로도 겹쳐 불리는데, Haiku 호출까지 그 경로를 막으면
// 화면 갱신 자체가 몇십 초씩 느려진다) — stallWatchdogInFlight로 중복 실행만 막는다.
async function runStallWatchdog(liveRows: SessionRow[], leads: LeadRecord[], members: MemberRecord[]): Promise<void> {
  if (stallWatchdogInFlight) return;
  const now = Date.now();
  const settings = loadSettings();
  const idleThresholdMs = settings.stallIdleThresholdMin * 60000;
  const cooldownMs = settings.stallCooldownMin * 60000;

  const memberRowsById = new Map(liveRows.filter(r => !r.isLead && r.id).map(r => [r.id as string, r]));
  const liveMemberSessionIds = new Set<string>();
  for (const row of memberRowsById.values()) {
    liveMemberSessionIds.add(row.sessionId);
    const status = getStatus(row);
    if (status === 'busy') { memberIdleSince.delete(row.sessionId); continue; }
    if (!memberIdleSince.has(row.sessionId)) memberIdleSince.set(row.sessionId, now);
  }
  pruneMissingKeys(memberIdleSince, liveMemberSessionIds);
  pruneMissingKeys(stallLastCheckedAt, liveMemberSessionIds);

  const leadRowsById = new Map(liveRows.filter(r => r.isLead && r.id).map(r => [r.id as string, r]));
  const liveLeadSessionIds = new Set<string>();
  for (const row of leadRowsById.values()) {
    liveLeadSessionIds.add(row.sessionId);
    const status = getStatus(row);
    if (status === 'busy') { leadIdleSince.delete(row.sessionId); continue; }
    if (!leadIdleSince.has(row.sessionId)) leadIdleSince.set(row.sessionId, now);
  }
  pruneMissingKeys(leadIdleSince, liveLeadSessionIds);

  const existingAlerts = loadStallAlerts();
  const candidates: { member: MemberRecord; memberRow: SessionRow; lead: LeadRecord; leadRow: SessionRow }[] = [];
  for (const m of members) {
    const row = memberRowsById.get(m.memberId);
    if (!row) continue;
    const lead = leads.find(l => l.id === m.leadId);
    if (!lead) continue;
    const leadRow = leadRowsById.get(lead.id);
    if (!leadRow) continue;

    const check = shouldCheckStall({
      memberStatus: getStatus(row),
      leadStatus: getStatus(leadRow),
      memberIdleSince: memberIdleSince.get(row.sessionId),
      leadIdleSince: leadIdleSince.get(leadRow.sessionId),
      now,
      idleThresholdMs,
      lastCheckedAt: stallLastCheckedAt.get(row.sessionId),
      cooldownMs,
      hasExistingAlert: existingAlerts.some(a => a.memberSessionId === row.sessionId),
    });
    if (check) candidates.push({ member: m, memberRow: row, lead, leadRow });
  }
  if (candidates.length === 0) return;

  stallWatchdogInFlight = true;
  try {
    for (const { member, memberRow, lead, leadRow } of candidates) {
      const projectName = resolveProjectName(lead.sessionId, lead.targetDir);
      const transcript = getTranscript(projectName, lead.sessionId, lead.targetDir);
      const lastEntries = transcript.slice(-4);
      if (lastEntries.length === 0) continue; // 대화 기록이 없으면 판단할 근거가 없다 — 아직 실제 확인은 안 했으니 쿨다운도 걸지 않고 다음 폴링에 다시 시도한다

      const lastAnswer = lastEntries[lastEntries.length - 1]?.answer ?? '';
      // Haiku를 부르기도 전에, 정적 안전장치로 먼저 걸러낼 수 있으면 호출 비용 자체를 아낀다.
      // 이것도 실제 확인이 아니라 스킵이므로 쿨다운을 걸지 않는다 — "승인 대기중" 신호는 다음
      // 폴링에도 계속 재평가돼야 하고, 재평가 비용도 정규식 하나뿐이라 문제없다.
      if (looksLikeApprovalRequest(lastAnswer)) continue;

      // 여기서부터는 실제로 Haiku를 호출한다 — 지금 마크해서, 호출이 느리거나 실패해도 다음
      // 폴링(3초 뒤)마다 곧바로 재시도하지 않게 한다(단, 위 두 스킵 사유는 실제 확인이 아니므로
      // 여기서 제외한다 — 그래야 일시적으로 트랜스크립트를 못 읽은 것뿐인데 쿨다운(수십 분)이
      // 통째로 걸려 진짜 방치를 오래 놓치는 사고를 막는다).
      stallLastCheckedAt.set(memberRow.sessionId, Date.now());

      const tailText = lastEntries.map(e => `사용자: ${e.prompt}\n팀장: ${e.answer}`).join('\n\n').slice(-3000);
      const idleSince = memberIdleSince.get(memberRow.sessionId) ?? Date.now();
      const idleMinutes = Math.max(1, Math.round((Date.now() - idleSince) / 60000));
      const memberDesc = `팀원 ${member.memberId}(역할: ${member.role || '미지정'})가 ${idleMinutes}분째 ${getStatus(memberRow)} 상태로 멈춰있습니다.`;

      const verdict = await runStallClassifier(tailText, memberDesc);
      if (!shouldSendNudge(verdict, lastAnswer)) continue;

      // 발송 여부를 판단하는 사이(Haiku 호출 대기 중) 상태가 바뀌었을 수 있으니, 최종적으로
      // 알림을 만들기 직전에 한 번 더 최신 상태를 확인한다 — shouldCheckStall이 최초 후보 선정에
      // 쓴 것과 같은 게이트(isStatusEligibleForStall)를 그대로 재사용해서, 재확인이 최초 선정보다
      // 허술해지는 일이 없게 한다. 짧은 id가 아니라 sessionId로 다시 찾는다 — 대기하는 동안 짧은
      // id가 드리프트됐어도(외부 재시작 등) 여전히 같은 세션을 정확히 찾아낸다.
      const freshAgents = await fetchAgents();
      const freshLeadAgent = freshAgents.find(a => a.sessionId === leadRow.sessionId);
      const freshMemberAgent = freshAgents.find(a => a.sessionId === memberRow.sessionId);
      if (!freshLeadAgent) continue; // 팀장이 그 사이 완전히 내려갔으면 재촉할 대상이 없다
      const stillEligible = isStatusEligibleForStall({
        memberStatus: freshMemberAgent ? getStatus(freshMemberAgent) : '',
        leadStatus: getStatus(freshLeadAgent),
      });
      if (!stillEligible) continue;

      const suggestedMessage = `[정체 감지] 팀원 ${member.memberId}가 ${idleMinutes}분째 대기 중입니다. 남은 작업이 있으면 이어서 지시하고, 이미 다 끝났으면 그렇다고 확인해주세요.`;

      // 팀장이 자동 진행을 켜뒀으면(사용자가 팀장 카드에서 직접 설정) 확인 알림 없이 곧바로
      // 보낸다 — 단, 여기까지 오려면 이미 blocked 하드 게이트·정규식 안전장치·Haiku의
      // waitingForUser 판단을 전부 통과한 뒤라는 점은 auto/반자동 어느 쪽이든 동일하다.
      if (lead.autoStallNudge) {
        queueLeadNotice(lead.internalId, suggestedMessage, 'system');
        continue;
      }

      const alerts = loadStallAlerts();
      if (alerts.some(a => a.memberSessionId === memberRow.sessionId)) continue; // 그 사이 이미 생성됐으면 중복 방지(짧은 id 드리프트에도 안전)
      alerts.push({
        id: `stall-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        leadInternalId: lead.internalId,
        memberId: member.memberId,
        memberSessionId: memberRow.sessionId,
        reason: verdict!.reason,
        suggestedMessage,
        createdAt: Date.now(),
      });
      saveStallAlerts(alerts);
    }
  } finally {
    stallWatchdogInFlight = false;
  }
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
    // blocked는 send-to-lead와 같은 이유로 busy와 다르게 취급한다 — 저절로 안 풀리는 상태라 여기서
    // 큐에 계속 묶어두면 영원히 배달 안 되는 메시지가 된다(2026-09-17 실사용 재현). blocked도 배달을
    // 시도해 stop→resume으로 깨우고, 세션 포크 방지는 resumeLead 안의 안전장치가 맡는다.
    const isBusy = !!liveAgent && isLeadTooBusyToInterrupt(liveAgent);
    // "터미널에서 직접 열기"로 띄운 attach 창이 아직 붙어있으면 여기서 stop→resume을 시도하지
    // 않는다(send-to-lead와 같은 이유, 위 isAttachTerminalOpenFor 주석 참고) — 다만 이건 busy와
    // 달리 attempts를 소모시키지 않는다: 사람이 그 터미널에서 아직 답하고 있는 중일 뿐 실패한 게
    // 아니므로, 시도 횟수를 깎지 않고 그냥 이번 폴링만 건너뛴다(창을 닫으면 다음 폴링부터 정상
    // 배달된다).
    const attachOpen = !!liveAgent?.id && isAttachTerminalOpenFor(liveAgent.id);
    if (attachOpen) {
      stillPending.push(...notices);
      continue;
    }
    // 영원히 stop이 안 되는 팀장(좀비 프로세스, 영구히 망가진 세션 등)에게는 재시도해봤자 매번
    // 실패한다 — 상한 없이 폴링마다 계속 resume을 시도하면 프로세스 스폰과 에러 로그만 무기한
    // 낭비된다(팀원 코드리뷰에서 지적). 상한을 넘으면 자동 재시도를 멈추고 큐에 그대로(제거하지
    // 않고) 남겨서 사용자가 채팅창에서 직접 취소하거나 다시 보내게 한다(실제로 없는 "팀장 복구"
    // 버튼을 안내하지 않는다).
    const attemptsSoFar = Math.max(0, ...notices.map(n => n.attempts ?? 0));
    const exhausted = attemptsSoFar >= MAX_NOTICE_DELIVERY_ATTEMPTS;
    if (exhausted) {
      stillPending.push(...notices);
      continue;
    }
    if (leadRec && liveAgent && !isBusy) {
      const message = combinePendingNoticeMessages(notices);
      const attemptedNotices = notices.map(n => ({ ...n, attempts: (n.attempts ?? 0) + 1 }));
      // resumeLead가 null을 반환(정지 실패 등으로 포기)하는 건 예외가 아니라 정상적인 resolve라
      // .catch만으로는 못 잡는다 — 이 알림은 이미 위에서 큐(stillPending)에서 빠진 뒤라, 그대로 두면
      // 아무도 모르게 영구히 사라진다(팀원 코드리뷰에서 지적, 실측 재현). 실패(null 또는 예외) 시
      // 다음 폴링에서 다시 시도할 수 있도록(단, 상한까지만) 큐에 되돌린다.
      queueLeadOperation(leadRec.internalId, () => resumeLead(leadRec.internalId, message))
        .then(result => {
          if (result === null) {
            const attempts = attemptedNotices[0].attempts!;
            logCritical(`[deliverPendingNotices] 팀장 ${leadRec.internalId} 알림 배달(resume)이 실패해 큐에 되돌립니다(시도 ${attempts}/${MAX_NOTICE_DELIVERY_ATTEMPTS}).`);
            if (attempts >= MAX_NOTICE_DELIVERY_ATTEMPTS) {
              logCritical(`[deliverPendingNotices] 팀장 ${leadRec.internalId} 알림이 ${MAX_NOTICE_DELIVERY_ATTEMPTS}회 연속 실패해 자동 재시도를 멈춥니다 — 채팅창에서 직접 취소하고 다시 보내야 합니다.`);
            }
            requeuePendingNotices(attemptedNotices);
          }
        })
        .catch(err => {
          logCritical(`[deliverPendingNotices] 팀장 ${leadRec.internalId} 알림 배달 중 예외가 발생해 큐에 되돌립니다: ${err}`);
          requeuePendingNotices(attemptedNotices);
        });
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
//
// graceMs를 매개변수로 받는 이유(실사용 재현된 사고 대응): 이 유예값은 "이 앱이 방금 stop을 걸어서
// 재기동 중인" 상황을 봐주기 위한 것인데, leadFirstMissAt/lastKnownLiveLeadRow가 전부 메모리에만
// 있어서 앱을 껐다 켜면 완전히 비어버린다. 그러면 앱을 새로 켰을 때 이미 죽어있던 팀장도 "처음
// 못 잡힘"부터 다시 시작해서, graceMs(약 75초)가 다 지날 때까지 liveRows에도(안 잡히니까)
// graceRows에도(캐시가 비어있으니까) offlineRows에도(아직 안 만료됐으니까) 안 잡혀 화면
// 어디에도 안 보이는 공백이 생긴다 — 실사용 재현: 앱을 껐다 켠 날 아침, 이미 죽어있던 팀장이
// 작업 탭에도 히스토리 탭에도 안 보여서 사용자가 세션 ID를 직접 찾아 수동으로 이어야 했다.
// 앱이 막 시작해서 이 팀장에 대해 아직 stop을 걸어본 적이 없는 시점(hasCompletedFirstPoll이
// false인 첫 폴링)에는 "재기동 중일 수도 있다"고 봐줄 이유가 아예 없으므로, 그 폴링 한 번만
// graceMs=0을 줘서 다음 폴링(3초 뒤)에 곧바로 만료 판정이 나게 한다 — 평소 동작(진짜 stop→resume
// 재기동 유예)은 그대로 유지된다.
// hasLiveMember는 lib/leadPresence.js에 있다(순수 함수, 단위 테스트 대상). MemberRecord.leadId는
// 등록 당시의 짧은 id라 그 뒤 팀장이 재시작됐으면 낡은 값일 수 있지만, 여기 넘기는 leads/members/
// agentIdSet은 reconcileLeadIds/reconcileMemberIds가 이미 최신화한 뒤의 것이라 낡은 참조가
// 계속 남아있지는 않는다.

// buildOfflineRows/buildGraceRows(캐시 없는 경우)가 공유하는 팀장 카드 생성 로직 — 하나는
// offline:true(히스토리), 하나는 offline:false(작업 탭 온라인 목록)로만 갈린다.
function buildLeadRecordRow(l: LeadRecord, offline: boolean): { row: SessionRow; aiTitleUpdated: boolean } {
  const projectName = resolveProjectName(l.sessionId, l.targetDir);
  let aiTitleUpdated = false;
  // 주제(ai-title)는 한 번 찾으면 세션 트랜스크립트를 매번 다시 읽지 않도록 leads.json에 캐싱한다.
  if (!l.aiTitle) {
    const found = getSessionAiTitle(l.sessionId, l.targetDir);
    if (found) { l.aiTitle = found; aiTitleUpdated = true; }
  }
  const row: SessionRow = {
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
    offline,
    internalId: l.internalId,
    autoStallNudge: l.autoStallNudge,
    secret: l.secret,
  };
  return { row, aiTitleUpdated };
}

function computeOfflineLeads(leads: LeadRecord[], agentIdSet: Set<string | undefined>, now: number, graceMs: number, members: MemberRecord[]): LeadRecord[] {
  const offlineLeads: LeadRecord[] = [];
  leads.forEach(l => {
    const isPresent = agentIdSet.has(l.id) || hasLiveMember(l.id, members, agentIdSet);
    const result = trackFirstMiss(leadFirstMissAt, isPresent, l.id, now, graceMs);
    if (result === 'expired') offlineLeads.push(l);
  });
  // 다른 경로로 이미 사라진(현재는 없지만 혹시 모를) leadId의 기록을 정리해 Map이 무한정 자라지
  // 않게 한다 — 팀원 정리 로직과 동일한 방어.
  pruneMissingKeys(leadFirstMissAt, new Set(leads.map(l => l.id)));
  return offlineLeads;
}

// agents 스냅샷에 이번엔 안 잡혔지만(agentIdSet에 없음) 아직 오프라인으로 확정되지도 않은(유예
// 구간, offlineLeads에도 없음) 팀장들 — 대부분 stop→resume 재기동 중이거나, 팀장은 내려갔지만
// 팀원이 아직 살아있는 경우다. liveRows에도 offlineRows에도 안 들어가는 이 틈을 그냥 두면
// rows에서 통째로 빠져서(위 lastKnownLiveLeadRow 주석 참고) 대화창이 순간적으로 사라지므로,
// 마지막으로 살아있었을 때의 스냅숏을 그대로 재사용해 "아직 그대로 있는 것처럼" 보여준다.
// 캐시가 없으면(한 번도 liveRows에 잡힌 적 없음 — 앱을 막 켰을 때 등) 팀원이라도 살아있는지
// 확인해서, 살아있으면 leads.json 데이터로 새로 카드를 만들어 보여준다(실사용 재현: 앱을 새로
// 켰는데 팀장은 이미 내려가 있고 팀원만 일하고 있어서, 캐시가 비어 화면 어디에도 안 보였음).
// 팀원도 없으면(진짜 오프라인 유예 구간) 다음 폴링까지 조용히 건너뛴다.
function buildGraceRows(leads: LeadRecord[], agentIdSet: Set<string | undefined>, offlineLeads: LeadRecord[], members: MemberRecord[]): { rows: SessionRow[]; leadsDirty: boolean } {
  const offlineLeadIds = new Set(offlineLeads.map(l => l.id));
  const graceRows: SessionRow[] = [];
  let leadsDirty = false;
  for (const l of leads) {
    if (agentIdSet.has(l.id) || offlineLeadIds.has(l.id)) continue;
    const cached = lastKnownLiveLeadRow.get(l.id);
    if (cached) { graceRows.push(cached); continue; }
    if (!hasLiveMember(l.id, members, agentIdSet)) continue;
    const { row, aiTitleUpdated } = buildLeadRecordRow(l, false);
    if (aiTitleUpdated) leadsDirty = true;
    graceRows.push(row);
  }
  return { rows: graceRows, leadsDirty };
}

function buildOfflineRows(offlineLeads: LeadRecord[], leads: LeadRecord[]): SessionRow[] {
  let leadsDirty = false;
  const offlineRows: SessionRow[] = offlineLeads.map(l => {
    const { row, aiTitleUpdated } = buildLeadRecordRow(l, true);
    if (aiTitleUpdated) leadsDirty = true;
    return row;
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
// 반환값은 "oldId -> newId" 변경 목록이다 — 호출부가 이걸로 MemberRecord.leadId(팀원이 저장해둔
// 소속 팀장의 옛 짧은 id)도 같이 옮겨써야 한다(restartLead가 겪었던 것과 똑같은 문제라 같은 방식
// 으로 고친다 — 아래 buildSessionRowsInternal 참고). 그렇게 안 하면 여기서 팀장 id는 바로잡히지만
// 그 팀장 소속 팀원들은 여전히 "소속 팀장 없음"으로 잘못 보이게 된다.
function reconcileLeadIds(agents: AgentEntry[], leads: LeadRecord[]): { oldId: string; newId: string }[] {
  const renames: { oldId: string; newId: string }[] = [];
  const leadIdSet = new Set(leads.map(l => l.id));
  for (const agent of agents) {
    if (!agent.id || !agent.sessionId || leadIdSet.has(agent.id)) continue;
    const rec = leads.find(l => l.sessionId === agent.sessionId);
    if (rec && rec.id !== agent.id) {
      console.log(`[reconcileLeadIds] 팀장 ${rec.internalId}의 짧은 id가 이 앱 밖에서 바뀐 것을 발견해 ${rec.id} -> ${agent.id}로 갱신합니다.`);
      renames.push({ oldId: rec.id, newId: agent.id });
      rec.id = agent.id;
      leadIdSet.add(agent.id);
    }
  }
  return renames;
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
    // memberFirstMissAt/lastMemberStatus는 memberId로 키잉되는데 옛 id 그대로 두면, 방금 바로잡은
    // 이 폴링 사이클에서 "새 id의 busy→idle 전이"를 놓칠 수 있다(다음 폴링부턴 새 키로 정상
    // 추적되니 스스로 회복은 되지만, 굳이 한 번이라도 완료 알림을 놓칠 이유가 없다).
    const firstMissAt = memberFirstMissAt.get(m.memberId);
    if (firstMissAt !== undefined) { memberFirstMissAt.delete(m.memberId); memberFirstMissAt.set(matched.id, firstMissAt); }
    const lastStatus = lastMemberStatus.get(m.memberId);
    if (lastStatus !== undefined) { lastMemberStatus.delete(m.memberId); lastMemberStatus.set(matched.id, lastStatus); }
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
// 이 앱이 실제로 claude --bg를 새로 스폰할 수 있는 디렉토리(팀장 자신의 targetDir + 사전승인된
// 팀원 디렉토리)만 모아서, claude 최초 실행 승인(checkDirectoryClaudeReady)이 안 된 곳을 화면에
// 알림으로 띄우는 데 쓴다 — "터미널 열기"와 같은 방식으로 사용자가 그 자리에서 바로 승인할 수
// 있게(open-terminal-for-approval IPC) 하기 위함.
//
// 예전엔 "지금 실제로 떠있는 세션들의 cwd"도 여기 같이 넣었었다 — 그런데 팀장이 EnterWorktree로
// 자기 자신의 작업 디렉토리를 일시적으로 워크트리 서브디렉토리로 옮기면(이 앱도 코딩할 때 쓰는
// 흔한 패턴), 그 워크트리 경로는 애초에 이 앱이 헤드리스로 spawn할 일이 없는 곳인데도(resumeLead/
// restartLead는 항상 lead.targetDir을, spawn_team_member는 항상 approvedMembers를 쓴다 — 살아있는
// 세션의 "지금 이 순간의" cwd는 안 쓴다) 매번 "미승인"으로 잡혀서, 사용자가 터미널을 열어 확인해봐도
// 지울 방법이 없는 알림으로 영구히 남는 사고가 있었다(실사용 재현: g1cl-mgt가 e2e 작업 중
// .claude/worktrees/e2e-consolidated-report로 옮겨간 사례). 그래서 실제 spawn 대상이 될 수 있는
// 디렉토리만 검사한다.
function computeUnapprovedDirs(leads: LeadRecord[]): { dir: string; reason: string }[] {
  const dirs = new Set<string>();
  for (const lead of leads) {
    dirs.add(lead.targetDir);
    lead.approvedMembers.forEach(dir => dirs.add(dir));
  }
  const result: { dir: string; reason: string }[] = [];
  for (const dir of dirs) {
    const readiness = checkDirectoryClaudeReady(dir);
    if (!readiness.ready) result.push({ dir, reason: readiness.reason! });
  }
  return result;
}

async function buildSessionRowsInternal(): Promise<{ rows: SessionRow[]; requests: MemberRequest[]; unapprovedDirs: { dir: string; reason: string }[] }> {
  // 아래 leadFirstMissAt/memberFirstMissAt 유예 판정에 쓸 기준 시각 — 이 함수 실행 도중 한 번만
  // 고정해서 재는다(같은 호출 안에서 Date.now()를 여러 번 부르며 값이 갈리는 걸 방지).
  const now = Date.now();
  const agents = await fetchAgents();
  const agentIdSet = new Set(agents.filter(a => !!a.id).map(a => a.id));
  const leads = loadLeads();
  const leadRenames = reconcileLeadIds(agents, leads);
  if (leadRenames.length) {
    saveLeads(leads);
    const renameMap = new Map(leadRenames.map(r => [r.oldId, r.newId]));
    loadMembers()
      .filter(m => renameMap.has(m.leadId))
      .forEach(m => registerMember({ ...m, leadId: renameMap.get(m.leadId)! }));
  }
  const leadIds = new Set(leads.map(l => l.id));
  const members = reconcileMemberIds(agents, loadMembers());
  const memberMap = new Map(members.map(m => [m.memberId, m]));

  const liveRows = computeLiveRows(agents, leads, leadIds, memberMap);
  liveRows.filter(r => r.isLead).forEach(r => lastKnownLiveLeadRow.set(r.id!, r));
  notifyLeadsOfFinishedMembers(liveRows, leads);
  deliverPendingNotices(agents, leads);
  // Haiku 호출까지 포함해 몇십 초 걸릴 수 있어 await하지 않는다(fire-and-forget) — 이 함수의
  // 반환(화면 갱신)을 막으면 안 된다. 내부적으로 stallWatchdogInFlight가 중복 실행을 막는다.
  runStallWatchdog(liveRows, leads, members).catch(err => {
    console.error('[runStallWatchdog] 정체 감시 도중 오류:', err);
  });

  const offlineLeads = computeOfflineLeads(leads, agentIdSet, now, hasCompletedFirstPoll ? LEAD_OFFLINE_GRACE_MS : 0, members);
  hasCompletedFirstPoll = true;
  const offlineRows = buildOfflineRows(offlineLeads, leads);
  const { rows: graceRows, leadsDirty: graceLeadsDirty } = buildGraceRows(leads, agentIdSet, offlineLeads, members);
  if (graceLeadsDirty) saveLeads(leads);
  const rows = [...liveRows, ...graceRows, ...offlineRows];
  for (const row of rows) {
    if (row.isLead && row.internalId) {
      const retryState = resumeRetryStatus.get(row.internalId);
      if (retryState) row.resumeRetrying = retryState;
    }
  }

  pruneMissingKeys(lastKnownLiveLeadRow, new Set(leads.map(l => l.id)));
  cleanupStaleMembers(members, agentIdSet, now);

  const requests = loadPendingRequests();
  const unapprovedDirs = computeUnapprovedDirs(leads);
  return { rows, requests, unapprovedDirs };
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
function buildSessionRows(): Promise<{ rows: SessionRow[]; requests: MemberRequest[]; unapprovedDirs: { dir: string; reason: string }[] }> {
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
      // memberId와 같은 이유(외부 세션이 직접 쓰는 파일) — id가 안전한 형식이 아니면 걸러서
      // writeRequestDecision이 이 값을 파일 경로에 그대로 쓰는 경로로 절대 넘어가지 않게 한다.
      .filter(r => {
        if (isSafeId(r.id)) return true;
        console.error(`[loadPendingRequests] 요청 id 형식이 안전하지 않아 무시합니다: ${JSON.stringify(r.id)}`);
        return false;
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

// 이미 처리된(pending이 아닌) 요청을 다시 승인/거부하면 팀장에게 모순된 메시지가 두 번 전달될 수
// 있으므로, 현재 상태가 여전히 pending일 때만 갱신한다(CAS). requestId는 렌더러 IPC에서 그대로
// 오므로(정상 흐름이면 loadPendingRequests가 이미 걸러준 안전한 값이지만), 여기서도 다시 한번
// 확인해서 이 함수가 다른 경로로 호출돼도 항상 안전하게 만든다.
function writeRequestDecision(requestId: string, status: 'approved' | 'denied'): MemberRequest | null {
  if (!isSafeId(requestId)) return null;
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

function loadSettings(): AppSettings {
  const raw = readJsonFileSafe<Partial<AppSettings>>(SETTINGS_PATH);
  return {
    stallIdleThresholdMin: clampMinutes(raw?.stallIdleThresholdMin, STALL_IDLE_THRESHOLD_MS_DEFAULT / 60000, 1, 24 * 60),
    stallCooldownMin: clampMinutes(raw?.stallCooldownMin, STALL_RECHECK_COOLDOWN_MS_DEFAULT / 60000, 1, 24 * 60),
  };
}

function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...partial };
  const next: AppSettings = {
    stallIdleThresholdMin: clampMinutes(merged.stallIdleThresholdMin, STALL_IDLE_THRESHOLD_MS_DEFAULT / 60000, 1, 24 * 60),
    stallCooldownMin: clampMinutes(merged.stallCooldownMin, STALL_RECHECK_COOLDOWN_MS_DEFAULT / 60000, 1, 24 * 60),
  };
  try {
    writeJsonFileAtomic(SETTINGS_PATH, next);
  } catch (err) {
    console.error('[saveSettings] settings.json 저장 실패:', err);
  }
  return next;
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
      // 타임아웃 없이 이 exec가 멈추면(예: PATH에 응답 없는 네트워크 드라이브가 섞여있는 경우),
      // 이 프라미스가 앱 수명 내내 캐시된 채로 절대 resolve되지 않아 이후 팀장/팀원 스폰이 전부
      // 영구히 막힌다(팀원 버그헌팅에서 지적) — 다른 exec 호출들과 마찬가지로 타임아웃을 준다.
      exec('where claude', { windowsHide: true, timeout: 5000 }, (err, stdout) => {
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
//
// prompt는 반드시 flags와 분리된 별도 인자로 받아서 flags 뒤에 `--`(옵션 종료 마커)를 끼워 넣고서야
// argv에 싣는다 — 실측 확인(2026-09-18): `--allowedTools`/`--mcp-config`는 `claude --help`에
// `<tools...>`/`<configs...>`로 명시된 가변인자(variadic) 플래그라, 그 바로 뒤에 구분자 없이 prompt를
// 붙이면 CLI가 prompt 문자열 전체를 "허용할 도구 이름 하나 더"로 먹어버리고 실제 메시지는 통째로
// 사라진다. 이 경우 `claude --bg`가 에러 없이 "backgrounded · <id> (idle — send a prompt to start)"를
// 찍고 뜨는데, 새 세션은 완전히 빈 입력창 상태로 시작해서 지시도 안 가고 스킬(`/team-lead` 등)도 전혀
// 로드되지 않는다 — 사용자가 "값이랑 명령이 안 간다"고 리포트한 것과 정확히 일치하는 증상이었다.
// `--`는 POSIX 표준 "이후는 전부 위치 인자" 마커라 그 앞의 플래그가 가변인자든 아니든 항상 안전하다.
function runClaudeBg(flags: string[], prompt: string, cwd: string): Promise<string | null> {
  const args = [...flags, '--', prompt];
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
      // claude stop이 반환해도 daemon이 실제로 정리를 끝냈다는 보장이 약하다(팀원이 CLI 레벨에서
      // 직접 재현: stop 직후 짧은 시간 안에 --resume하면 원본을 잇는 대신 "이미 실행 중이라 복사본을
      // 만들었다"고 stdout에 남기고 완전히 별개의 새 세션을 만들어버림 — exit code 0, 겉보기엔 성공).
      // 이 마커가 있으면 방금 뜬 세션은 원치 않는 복사본이므로, 곧바로(best-effort로) 정리하고
      // 실패로 반환한다 — 호출부(resumeSpawnWithRetry)가 간격을 두고 다시 시도하면서, 그때는 원본이
      // 진짜로 정리돼 있기를 기대한다.
      const copyId = extractStartedCopyId(out);
      if (copyId) {
        logCritical(`[runClaudeBg] daemon이 아직 원본을 정리하지 못해 복사본(${copyId})을 새로 만들었습니다 — 원치 않는 복사본이라 정리하고 실패로 처리합니다(재시도로 이어짐).`);
        spawn('claude', ['stop', copyId], { stdio: 'ignore' }).on('error', () => { /* best-effort 정리 — 실패해도 이 함수 자체는 어차피 실패로 반환한다 */ });
        finish(null);
        return;
      }
      const id = extractBackgroundedId(out);
      if (!id) {
        console.error('[runClaudeBg] claude stdout에서 "backgrounded" 마커를 찾지 못했습니다. 원문:', out);
      }
      finish(id);
    });
    child.on('error', err => {
      console.error('[runClaudeBg] claude 프로세스를 실행하지 못했습니다:', err);
      finish(null);
    });
  }));
}

// 팀원 생성 MCP 서버(src/mcp/teamMemberServer.ts, 빌드되면 dist/teamMemberServer.js)를 팀장
// 세션에 붙여주는 CLI 인자들. stdio 방식이라 claude CLI 자신이 이 서버를 자식 프로세스로 실행하고
// 세션 종료 시 같이 정리한다 — 이 앱이 따로 띄워두거나 관리할 필요가 없다.
// --allowedTools로 이 툴 하나만 미리 승인해둔다(실측 확인: 승인 안 해두면 팀장 세션이 이
// 백그라운드 세션이라 아무도 응답 못 하는 권한 프롬프트에 막혀버린다 — --dangerously-skip-permissions처럼
// 전체를 우회하는 게 아니라 이 툴 하나만 화이트리스트에 추가하는 것이라 "권한을 절대 우회하지
// 않는다"는 SKILL.md 원칙과 배치되지 않는다).
const MEMBER_SPAWN_MCP_SERVER_NAME = 'team-monitor';
const MEMBER_SPAWN_TOOL_NAME = `mcp__${MEMBER_SPAWN_MCP_SERVER_NAME}__spawn_team_member`;

function buildMemberSpawnCliArgs(mcpToken: string): string[] {
  const config = {
    mcpServers: {
      [MEMBER_SPAWN_MCP_SERVER_NAME]: {
        command: 'node',
        args: [path.join(__dirname, 'teamMemberServer.js')],
        env: {
          TEAM_MONITOR_LEAD_TOKEN: mcpToken,
          TEAM_MONITOR_LEADS_PATH: LEADS_PATH,
        },
      },
    },
  };
  return ['--mcp-config', JSON.stringify(config), '--allowedTools', MEMBER_SPAWN_TOOL_NAME];
}

// 실측 확인(2026-09-18): --setting-sources project,local로 띄우면(즉 user-level 설정을 안 읽으면)
// daily-journal 플러그인의 PostToolUse(파일 편집 기록)·Stop(세션 요약) 훅이 아예 트리거되지 않는다
// — daily-journal의 user-config.json을 손대지 않고도 "이 세션은 기록에 안 남긴다"를 완전히
// 달성한다(daily-journal 훅이 user-level settings.json에 등록돼 있어서 가능한 것 — plugin 훅
// 등록 방식이 바뀌면 이 값도 다시 검증해야 한다). 워크스페이스 신뢰 승인 여부는 이 옵션과 무관하게
// 정상 동작함을 실측으로 확인했다(트러스트 상태는 설정 소스가 아니라 별도 메커니즘인 것으로 보임).
const SECRET_MODE_CLI_ARGS = ['--setting-sources', 'project,local'];

// 기존(이미 leads.json에 있는) 팀장 레코드에 새 토큰을 발급해 즉시 저장한다 — resumeLead/
// restartLead처럼 스폰 전에 이미 internalId를 아는 경로에서 쓴다. 다른 팀장의 동시 변경을
// 덮어쓰지 않도록, 스폰 직전에 다시 읽어서 쓴다(forkSessionAsLead 등과 같은 패턴).
// 짧은 id/sessionId와 달리 mcpToken은 안정적으로 유지할 필요가 없어서(이 프로세스 인스턴스
// 하나의 수명 동안만 유효하면 됨) 매번 새로 발급해도 무방하다.
function issueMcpToken(internalId: string): string {
  const token = crypto.randomUUID();
  const leads = loadLeads();
  const rec = leads.find(l => l.internalId === internalId);
  if (rec) { rec.mcpToken = token; saveLeads(leads); }
  return token;
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
      fetchAgentsStrict().then(agents => {
        const stillAlive = agents.some(a => a.id === id);
        if (stillAlive) {
          console.error(`[stopSession] claude stop ${id} 이후에도 agents 목록에 여전히 남아있습니다 — 정지 실패로 간주합니다.`);
        }
        resolve(exitedCleanly && !stillAlive);
      }).catch(err => {
        // 생존 여부 확인 자체가 실패하면(exec/파싱 오류) "안 살아있다"고 fail-open으로 단정하지
        // 않는다 — 그러면 resumeLead가 그대로 --resume을 걸어, 실제로는 아직 살아있는 세션을 향해
        // resume해서 복사본(포크)이 생기는 바로 그 사고로 이어질 수 있다. 확인이 안 되면 안전한
        // 쪽(정지 실패로 간주)으로 fail-closed 한다.
        console.error(`[stopSession] claude stop ${id} 이후 생존 여부 확인 자체가 실패했습니다 — 안전을 위해 정지 실패로 간주합니다:`, err);
        resolve(false);
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

// 직접 원인 확정(팀원이 CLI로 대조 실험, 2026-09-17): claude CLI는 background 세션이 "자기 자신의
// 저장된 옵션(mcp-config/allowedTools/model)"을 그대로 갖고 있어서, --resume에 이 옵션들을 다시
// 실어 보내면 그 세션을 잇는 게 아니라 그 자리에서 매번 완전히 새로운 session-id를 가진 "복사본"을
// 만든다 — CLI 자신이 이걸 stdout에 그대로 알려준다("... started a copy as <newId>. Without flags,
// the same command continues <id> itself."). 이 앱의 resumeLead는 지금까지 매번 buildMemberSpawnCliArgs
// (mcp-config+allowedTools)를 --resume과 함께 실어 보내고 있었다 — 즉 오늘 겪은 "한 stop 이벤트 뒤
// 새 세션이 생기는" 사고는 타이밍 레이스가 아니라, 이 조합을 쓰는 한 매번 확정적으로 벌어지는
// 일이었다(대조 실험: 플래그 없이 --resume만 쓴 그룹은 5/5 전부 같은 session-id로 정상 재개, 크래시도
// 포크도 0건). 그래서 여기서는 --resume에 mcp-config류를 아예 실어 보내지 않는다 — 최초 실행 때 이미
// 저장된 mcp-config/allowedTools/model을 CLI가 그대로 물려받으므로 다시 넘길 필요가 없다(이 팀장이
// 처음 뜰 때 설정한 spawn_team_member 허용은 계속 유효하다).
//
// runClaudeBg는 CLI가 stdout에 "started a copy as <id>"라고 직접 알려주는 케이스를 문자열 매칭으로
// 이미 걸러낸다(extractStartedCopyId) — 다만 이건 CLI의 정확한 영어 문구에 의존하는 약한 신호라,
// 문구가 조금만 바뀌거나 예상 못 한 포맷으로 나오면 조용히 못 잡아낼 수 있다(extractBackgroundedId가
// 예전에 ANSI 코드 때문에 바로 이런 식으로 조용히 실패한 전례가 있다). 그래서 문구 매칭과는 독립적인
// 두 번째 방어선을 둔다: 정상 resume은 항상 같은 짧은 id로 깨어난다는 사실 자체(위 stopSession 주석
// 참고, "woke session ... with its saved options"로 확인됨)를 이용해, 돌아온 짧은 id가 resume 전
// id(current.id)와 다르면 문구를 못 알아봤어도 복사본으로 단정하고 정리한다(resumeOnce).
function resumeOnce(internalId: string, current: LeadRecord, message: string, attempt: number): Promise<string | null> {
  return runClaudeBg(['--bg', '--resume', current.sessionId], resolveLongPrompt(message), current.targetDir).then(candidateId => {
    if (!candidateId) return null;
    if (candidateId !== current.id) {
      logCritical(
        `[resumeLead] 팀장 ${internalId}의 resume 시도 ${attempt}/${MAX_RESUME_ATTEMPTS}가 다른 짧은 id로 떴습니다` +
        `(${current.id} → ${candidateId}) — "started a copy" 문구를 놓쳤더라도 id 불일치로 복사본임을 감지해 정리합니다.`
      );
      spawn('claude', ['stop', candidateId], { stdio: 'ignore' }).on('error', () => { /* best-effort 정리 */ });
      return null;
    }
    return candidateId;
  });
}

// 실제로 실패가 확인된 뒤(동기 재시도든, 아래 scheduleBackgroundResumeHealing의 뒤늦은 발견이든)에만
// 호출된다 — 간격을 두고 startAttempt부터 MAX_RESUME_ATTEMPTS까지 재시도하고, 이번엔(이미 한 번
// 실패한 뒤라) 매 시도마다 RESUME_SETTLE_CHECK_MS만큼 기다렸다가 여전히 살아있는지 확인하고서야
// 성공으로 확정한다 — 재시도 국면에서는 이 정도 신중함이 정상 경로의 지연보다 훨씬 싸다.
async function resumeRetryFrom(internalId: string, current: LeadRecord, message: string, startAttempt: number): Promise<string | null> {
  try {
    for (let attempt = startAttempt; attempt <= MAX_RESUME_ATTEMPTS; attempt++) {
      resumeRetryStatus.set(internalId, { attempt, max: MAX_RESUME_ATTEMPTS });
      await new Promise(resolve => setTimeout(resolve, RESUME_RETRY_GAP_MS));
      const candidateId = await resumeOnce(internalId, current, message, attempt);
      if (candidateId) {
        await new Promise(resolve => setTimeout(resolve, RESUME_SETTLE_CHECK_MS));
        let survived: boolean;
        try {
          const agents = await fetchAgentsStrict();
          survived = agents.some(a => a.id === candidateId);
        } catch {
          survived = true; // 확인 자체가 실패하면 fail-closed(성공으로 간주) — 불필요한 재시도를 피한다.
        }
        if (survived) return candidateId;
        logCritical(`[resumeLead] 팀장 ${internalId}의 resume 시도 ${attempt}/${MAX_RESUME_ATTEMPTS}가 크래시한 것으로 보입니다(${candidateId}, 원인 미확정).`);
      } else {
        logCritical(`[resumeLead] 팀장 ${internalId}의 resume 시도 ${attempt}/${MAX_RESUME_ATTEMPTS}가 실패했습니다("backgrounded" 마커 없음/타임아웃 또는 복사본으로 감지되어 정리됨).`);
      }
    }
    return null;
  } finally {
    resumeRetryStatus.delete(internalId);
  }
}

// 첫 시도가 성공한 것처럼 보인(같은 짧은 id로 backgrounded 마커까지 찍은) 뒤에도, 남을 수 있는 다른
// 원인으로 몇 초 뒤 조용히 죽을 가능성 자체는 배제 못 한다 — 그렇다고 매번 정상 경로에서 13초씩 막고
// 기다리는 건 손해가 더 크므로(resumeSpawnWithRetry 위 상수 주석 참고), 확인은 백그라운드로 미루고
// 응답은 즉시 돌려준다. RESUME_SETTLE_CHECK_MS 뒤에 그 짧은 id가 여전히 agents 목록에 있는지만
// 조용히 확인하고, 죽어있으면 그때 가서 resumeRetryFrom으로 복구를 시도한다 — 같은 internalId의
// queueLeadOperation을 통해서(그사이 사용자가 새 메시지를 보내거나 재시작했을 수 있으니, 우리가
// 감시하던 세션이 여전히 leads.json의 "현재" 세션일 때만 개입한다).
function scheduleBackgroundResumeHealing(internalId: string, current: LeadRecord, message: string, expectedId: string): void {
  setTimeout(() => {
    queueLeadOperation(internalId, async () => {
      const leads = loadLeads();
      const rec = leads.find(l => l.internalId === internalId);
      if (!rec || rec.id !== expectedId) return; // 이미 다른 작업으로 대체됨 — 간섭하지 않는다.
      let survived: boolean;
      try {
        const agents = await fetchAgentsStrict();
        survived = agents.some(a => a.id === expectedId);
      } catch {
        return; // 생존 확인 자체가 실패하면, 정말 죽었는지도 모르는 채로 또 stop/resume을 거는 게
                // 더 위험하다 — 다음 폴링이나 사용자 조작 때 다시 기회가 있으니 여기서는 그냥 넘어간다.
      }
      if (survived) return;
      logCritical(`[resumeLead] 팀장 ${internalId}(${expectedId})가 백그라운드 확인(spawn 후 ${RESUME_SETTLE_CHECK_MS}ms) 중 사라진 것을 발견했습니다 — 재시도로 복구를 시도합니다.`);
      const healedId = await resumeRetryFrom(internalId, current, message, 2);
      if (!healedId) {
        logCritical(`[resumeLead] 팀장 ${internalId} 백그라운드 복구가 남은 재시도를 모두 실패했습니다 — 이 팀장이 실제로 오프라인 상태일 수 있어 수동 확인이 필요합니다.`);
        return;
      }
      const newSessionId = await findSessionIdByShortIdRetrying(healedId);
      const latestLeads = loadLeads();
      const latestRec = latestLeads.find(l => l.internalId === internalId);
      if (latestRec && latestRec.id === expectedId) {
        latestRec.id = healedId;
        // resumeOnce가 이미 healedId === current.id(즉 expectedId)임을 보장하므로, 여기서 sessionId가
        // current.sessionId와 달라져 보이면 resumeLead의 같은 가드와 동일한 이유로 신뢰하지 않는다
        // (위 resumeLead 본문의 동일 주석 참고 — 실사용 재현: 이 조합에서 존재하지 않는 sessionId를
        // 그대로 저장해 대화 기록이 안 보이는 사고로 이어졌었다).
        if (newSessionId && newSessionId !== current.sessionId) {
          logCritical(
            `[resumeLead] 팀장 ${internalId}(${healedId}) 백그라운드 복구 — 짧은 id는 그대로인데 sessionId만 달라진 걸로 조회됐습니다` +
            `(${current.sessionId} → ${newSessionId}). 신뢰하지 않고 기존 sessionId를 유지합니다.`
          );
        } else if (newSessionId) {
          latestRec.sessionId = newSessionId;
        }
        saveLeads(latestLeads);
      }
    }).catch(err => logCritical(`[resumeLead] 팀장 ${internalId} 백그라운드 복구 큐 처리 중 오류가 났습니다: ${err}`));
  }, RESUME_SETTLE_CHECK_MS);
}

// 호출부(resumeLead)는 internalId를 넘겨서, 재시도 중인 동안 resumeRetryStatus에 진행 상황(몇 번째/
// 최대 몇 번)을 남겨 렌더러가 "재시도 중" 표시를 할 수 있게 한다. 정상 경로(첫 시도가 바로 성공)에서는
// 이 함수가 즉시 반환하고 resumeRetryStatus를 건드리지 않는다 — 재시도 인프라(resumeRetryFrom)는 첫
// 시도가 그 자리에서 바로 실패했을 때만 동기적으로 쓰인다.
async function resumeSpawnWithRetry(internalId: string, current: LeadRecord, message: string): Promise<string | null> {
  const candidateId = await resumeOnce(internalId, current, message, 1);
  if (!candidateId) {
    return resumeRetryFrom(internalId, current, message, 2);
  }
  scheduleBackgroundResumeHealing(internalId, current, message, candidateId);
  return candidateId;
}

// 큐에서 대기하는 동안 앞선 작업(예: 재시작)이 이미 이 팀장의 짧은 id/sessionId를 바꿔놨을 수
// 있으므로, 넘겨받은 값을 그대로 믿지 않고 internalId(절대 안 바뀜)로 leads.json에서 최신
// 레코드를 실행 시점에 다시 찾아서 사용한다. 호출부는 반드시 queueLeadOperation(internalId, ...)으로
// 감싸서 호출해야 한다.
async function resumeLead(internalId: string, message: string): Promise<string | null> {
  const current = loadLeads().find(l => l.internalId === internalId);
  if (!current) return null;
  const readiness = checkDirectoryClaudeReady(current.targetDir);
  if (!readiness.ready) {
    logCritical(claudeNotReadyMessage(current.targetDir, readiness.reason!));
    return null;
  }
  // 히스토리 탭에서 이미 오프라인인(agents 스냅샷에 안 잡히는) 팀장에게 메시지를 보내도 여기까지
  // 그대로 들어온다 — restartLead와 같은 이유로, 실제로 떠있을 때만 stop을 호출한다(없는 프로세스에
  // claude stop을 걸어 시간을 낭비하고 이어지는 runClaudeBg 타임아웃과 겹치는 걸 막기 위함).
  // 이 판정에 fail-open인 fetchAgents()를 쓰면, exec 자체가 실패했을 때 "확인 안 됨"을 "안
  // 살아있음"으로 잘못 해석해 stopSession을 건너뛰고 곧장 --resume을 걸어버릴 수 있다 — 그러면
  // 실제로는 살아있는 세션에 resume을 걸어 복사본(포크)이 생기는, 바로 아래에서 막으려는 그 사고를
  // 상류에서 그대로 재현하게 된다(팀원 코드리뷰에서 지적: stopSession만 fail-closed로 고쳐봤자
  // 이 판정 자체가 fail-open이면 무의미하다). 그래서 여기도 fail-closed로 맞춘다 — 확인이 안 되면
  // "혹시 몰라 살아있다고 가정"하고 stop을 한 번 거친다.
  let isCurrentlyLive: boolean;
  try {
    const agents = await fetchAgentsStrict();
    isCurrentlyLive = agents.some(a => a.id === current.id);
  } catch {
    isCurrentlyLive = true;
  }
  if (isCurrentlyLive) {
    // stop이 실패했는데(타임아웃 등) 그대로 --resume을 걸면, 세션이 아직 살아있는 채로 resume하는
    // 셈이 되어 claude CLI가 같은 세션을 잇는 대신 복사본(포크)을 새로 만들어버린다(실측 확인, 아래
    // runClaudeBg 호출부 참고) — 실사용 사고 재현: blocked(권한 승인 대기)로 멈춰있던 팀장이 이
    // 경로를 타면서 고아 세션(leads.json에 없는 별도 agent)이 하나 더 생겼다. endLeadWork와 같은
    // 1회 재시도 패턴으로 한 번 더 시도해보고, 그래도 실패하면 포크 위험을 감수하지 않고 여기서
    // 포기한다(호출부는 null을 실패로 처리).
    let stopped = await stopSession(current.id);
    if (!stopped) stopped = await stopSession(current.id);
    if (!stopped) {
      logCritical(`[resumeLead] 팀장 ${internalId}(${current.id}) 정지에 실패해 세션 포크 위험이 있어 resume을 중단합니다.`);
      return null;
    }
    // stopSession이 성공(claude agents --json에서 사라짐)을 확인해도 곧바로 --resume을 걸면
    // "source session ... not found"로 크래시하는 사고가 실사용 중 여러 번 났다(2026-09-17, 두
    // 팀장 모두 겪음) — 처음엔 "stop 직후라 시간이 덜 지나서"라고 보고 이 유예를 넣었는데, 하루치
    // daemon.log를 다시 분석해보니 그 가설은 틀렸다(정상 성공 사례 수백 건의 간격이 0.4~5초였고,
    // 크래시 사례 중엔 간격이 255초였는데도 크래시한 것도 있었다 — 간격 길이 자체는 원인이 아니다).
    // 지금은 "서로 다른 팀장의 stop/resume이 겹쳐서 daemon을 헷갈리게 한다" 쪽이 더 유력한 가설이지만
    // 확정은 아니다. 이 3초 유예는 그 잘못된 가설 위에서 넣은 것이라 실제 방지 효과는 불확실하고,
    // 진짜 안전장치는 아래 resumeSpawnWithRetry의 크래시 감지+재시도 쪽이다 — 그래도 해될 게 없는
    // 짧은 지연이라 없애지는 않았다. 다시 재현되면 ~/.claude/jobs/<id>/state.json의 state/detail
    // 필드로 원인을 더 파볼 수 있다.
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  // 더 이상 issueMcpToken을 여기서 새로 발급하지 않는다 — --resume에 mcp-config를 다시 실어 보내지
  // 않으므로(위 resumeSpawnWithRetry 주석 참고) 새 토큰을 만들어봤자 그 값을 전달할 방법이 없고,
  // leads.json의 mcpToken은 이 팀장이 마지막으로 실제 --mcp-config를 실어 떴을 때(launchTeamLead/
  // restartLead) 발급된 값 그대로 유효하다 — CLI가 세션 자신의 저장된 옵션으로 계속 그 값을 쓴다.
  const newId = await resumeSpawnWithRetry(internalId, current, message);
  if (newId) {
    // stop 후 resume하면 보통 같은 짧은 id/sessionId로 깨어나지만, 위 가드를 다 통과하고도 CLI가
    // 어떤 이유로든 새 세션(포크)을 만들었다면 sessionId 자체가 바뀐다 — 이걸 안 챙기고 짧은 id만
    // 갱신하면 leads.json이 낡은 sessionId를 계속 붙들고 있어서, 다음 메시지도 그 낡은(포크 이전)
    // 세션을 향해 resume을 시도하다 또 포크가 나는 악순환으로 이어진다(실사용 재현). 그래서 실제
    // sessionId를 다시 조회해 함께 갱신한다. 이 조회 자체가 (막 spawn된 직후라 claude agents
    // --json에 아직 안 잡히는 등의 이유로) 실패하면 leads.json이 fork 이전의 낡은 sessionId를
    // 영구히 붙들고, 이후 모든 메시지가 그 낡은(대화가 거의 안 쌓인) 지점만 계속 resume하게 되어
    // "새 세션이라 기억이 없다"처럼 보이는 사고로 이어진다(팀원 리뷰에서 지적, 실측 재현) — 그래서
    // 한 번 실패해도 바로 포기하지 않고 재시도한다.
    const newSessionId = await findSessionIdByShortIdRetrying(newId);
    const leads = loadLeads();
    const rec = leads.find(l => l.internalId === internalId);
    if (rec) {
      rec.id = newId;
      // 짧은 id가 stop 이전과 동일한데(newId === current.id) sessionId만 달라진 조합은, 이 코드베이스가
      // 곳곳에서 의존하는 전제("정상 resume은 항상 같은 짧은 id로 깨어나고, 그러면 sessionId도 당연히
      // 그대로다")에 어긋난다 — 실사용으로 확인됨(2026-09-17): g1cl-mgt와 이 팀장(Team Monitor) 자신
      // 둘 다에서, claude agents --json 조회가 이 순간 daemon의 일시적으로 꼬인 상태를 읽어 존재하지도
      // 않는 sessionId를 돌려줬고, 그걸 그대로 믿고 저장해서 leads.json이 실제로는 아무 데도 없는
      // sessionId를 가리키게 됐다(대화 기록이 통째로 안 보이는 사고로 이어짐 — 실제 세션·대화 자체는
      // 멀쩡히 살아있었는데 이 앱이 엉뚱한 sessionId로 필터링해서 못 찾은 것뿐이었다). 짧은 id가 안
      // 바뀌었는데 sessionId가 바뀌어 보이면 조회 자체를 못 믿는 게 낫다 — 기존 값을 그대로 유지한다
      // (포크로 짧은 id 자체가 바뀐 경우는 이 조건에 안 걸리므로 정상적으로 갱신된다).
      if (newSessionId && newId === current.id && newSessionId !== current.sessionId) {
        logCritical(
          `[resumeLead] 팀장 ${internalId}(${newId}) — 짧은 id는 그대로인데 sessionId만 달라진 걸로 조회됐습니다` +
          `(${current.sessionId} → ${newSessionId}). 정상 resume이라면 있을 수 없는 조합이라 신뢰하지 않고 기존 sessionId를 유지합니다.`
        );
      } else if (newSessionId) {
        rec.sessionId = newSessionId;
      } else {
        logCritical(`[resumeLead] 팀장 ${internalId}(${newId})의 새 sessionId를 확인하지 못했습니다 — leads.json이 낡은 sessionId(${rec.sessionId})를 계속 가리킬 수 있습니다.`);
      }
      saveLeads(leads);
    }
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
  const readiness = checkDirectoryClaudeReady(current.targetDir);
  if (!readiness.ready) {
    logCritical(claudeNotReadyMessage(current.targetDir, readiness.reason!));
    return { error: `"${current.targetDir}"에서 claude 최초 실행 승인이 안 돼 있습니다(${readiness.reason}) — 그 디렉토리에서 터미널로 claude를 한 번 실행해 승인창을 눌러준 뒤 다시 시도하세요.` };
  }
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

  const mcpToken = issueMcpToken(internalId);
  // 재시작은 완전히 새 세션(--resume이 아님)이라 launchTeamLead와 같은 이유로 이 시점에 SECRET_MODE_CLI_ARGS를
  // 다시 실어야 한다 — resumeLead와 달리 "저장된 옵션을 물려받는" 경로가 아니다.
  const newId = await runClaudeBg(
    ['--bg', ...buildMemberSpawnCliArgs(mcpToken), ...(current.secret ? SECRET_MODE_CLI_ARGS : [])],
    resolveLongPrompt(prompt),
    current.targetDir,
  );
  if (!newId) {
    return { error: `claude --bg가 ${RUN_CLAUDE_TIMEOUT_MS / 1000}초 안에 새 세션 시작을 확인해주지 못했습니다(타임아웃 또는 "backgrounded" 표시를 못 찾음). claude CLI 로그인/설치 상태를 확인해보세요 — 자세한 로그는 앱 콘솔에 남습니다.` };
  }
  const newSessionId = (await findSessionIdByShortId(newId)) ?? newId;

  const leads = loadLeads();
  const rec = leads.find(l => l.internalId === internalId);
  if (rec) {
    const oldId = rec.id;
    rec.id = newId;
    rec.sessionId = newSessionId;
    rec.launchedAt = Date.now();
    rec.approvedMembers = approvedMembers;
    // 재시작은 완전히 새 세션(새 sessionId)이라 예전 대화 주제가 더 이상 안 맞는다 — 안 지우면
    // 이 팀장이 나중에 오프라인이 됐을 때 히스토리 탭에 재시작 이전 대화의 주제가 그대로 남아
    // 보인다. 다음에 필요할 때(buildOfflineRows) 새로 조회해서 다시 채워진다.
    delete rec.aiTitle;
    saveLeads(leads);
    // MemberRecord.leadId는 등록 당시의 짧은 id를 그대로 저장해두는데, restartLead는 짧은 id를
    // 항상 새로 발급하면서도 이 값을 안 건드려서(실측 확인) 그 팀장 소속 팀원들이 재시작 직후부터
    // 전부 leadId 불일치를 겪었다 — endLeadWork가 그 팀원들을 아예 못 찾아 종료가 안 되고,
    // notifyLeadsOfFinishedMembers의 완료 알림도 전달 안 되고, 화면에도 "소속 팀장 없음"으로
    // 잘못 보였다. 짧은 id가 바뀌는 시점(여기)에 소속 팀원 전부를 새 id로 같이 옮겨써서 막는다.
    const members = loadMembers();
    members.filter(m => m.leadId === oldId).forEach(m => registerMember({ ...m, leadId: newId }));
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
    // 팀원 하나씩 정지하는 이 루프는(각각 최대 STOP_SESSION_TIMEOUT_MS) 꽤 오래 걸릴 수 있고, 그
    // 사이 폴링의 reconcileMemberIds가 이 팀원의 짧은 id를 앱 밖 재시작으로 바꿔놨을 수 있다 —
    // sessionId로 지금 최신 등록 파일을 다시 찾아서(찾으면 그 파일이 곧 "지금 진짜 id") 정지한다.
    const current = (m.sessionId && loadMembers().find(x => x.sessionId === m.sessionId)) || m;
    const stopped = await stopSession(current.memberId);
    if (!stopped) memberFailures.push(current.memberId);
    try { fs.unlinkSync(path.join(MEMBERS_DIR, `${current.memberId}.json`)); } catch { /* ignore */ }
  }
  // 팀원 정리 루프가 도는 동안 팀장 자신의 짧은 id도 바뀌었을 수 있다 — internalId로 최신 레코드를
  // 다시 찾아서 정지한다(resumeLead/restartLead와 같은 이유).
  const currentLead = loadLeads().find(l => l.internalId === internalId) ?? lead;
  let leadStopped = await stopSession(currentLead.id);
  if (!leadStopped) {
    leadStopped = await stopSession(currentLead.id);
  }
  return { success: leadStopped, memberFailures };
}

async function findSessionIdByShortId(shortId: string): Promise<string | null> {
  const agents = await fetchAgents();
  return agents.find(a => a.id === shortId)?.sessionId ?? null;
}

// resumeLead가 방금 막 spawn된 짧은 id의 실제 sessionId를 되찾을 때 쓴다 — claude agents --json이
// 방금 뜬 프로세스를 아직 못 잡았을 수 있는 짧은 반영 지연을 봐주기 위해 재시도한다(팀원 리뷰에서
// 지적: 이 조회가 실패하면 leads.json이 fork 이전의 낡은 sessionId를 영구히 붙들게 된다). 세션이
// 여러 개 떠있으면 claude agents --json 자체가 500~940ms씩 걸리는 게 실측으로 확인돼 있어서(위
// checkClaudeBinaryOnce 주변 실측 주석 참고), 처음엔 500ms 한 번만 쉬고 재시도해서 부족하다는
// 지적(팀원 리뷰)을 받아 총 3회(딜레이 800ms→1500ms)로 늘렸다 — 이 조회 실패의 대가(leads.json이
// 영구히 낡은 세션을 가리키게 됨)가 몇 초 더 기다리는 것보다 훨씬 크기 때문이다.
async function findSessionIdByShortIdRetrying(shortId: string): Promise<string | null> {
  const delaysMs = [800, 1500];
  const first = await findSessionIdByShortId(shortId);
  if (first) return first;
  for (const delay of delaysMs) {
    await new Promise(resolve => setTimeout(resolve, delay));
    const found = await findSessionIdByShortId(shortId);
    if (found) return found;
  }
  return null;
}

async function launchTeamLead(targetDir: string, instruction: string, secret?: boolean): Promise<string | null> {
  const readiness = checkDirectoryClaudeReady(targetDir);
  if (!readiness.ready) {
    logCritical(claudeNotReadyMessage(targetDir, readiness.reason!));
    return null;
  }
  installTeamLeadSkill();
  const { paths: approvedMembers, text: approvedText } = approvedMemberBriefing(targetDir);
  const prompt = `/team-lead ${instruction}\n\n${approvedText}`;

  // 아직 leads.json 레코드가 없어서(브랜드 뉴 팀장) issueMcpToken을 못 쓴다 — 스폰 전에 직접
  // 발급해서 --mcp-config에 실은 뒤, 스폰 성공 후 같은 값을 새 레코드에 그대로 저장한다.
  const mcpToken = crypto.randomUUID();
  const id = await runClaudeBg(
    ['--bg', ...buildMemberSpawnCliArgs(mcpToken), ...(secret ? SECRET_MODE_CLI_ARGS : [])],
    resolveLongPrompt(prompt),
    targetDir,
  );
  if (!id) return null;

  // 막 시작한 세션은 첫 턴을 처리 중일 수 있어 곧바로 stop시키면 방해가 된다 — 그래서 이 시점엔 자기 id를
  // 알려주는 후속 메시지를 보내지 않는다(위험). 대신 SKILL.md가 스스로 `claude agents --json`으로 자기
  // cwd에 맞는 id를 찾도록 안내한다.
  const sessionId = (await findSessionIdByShortId(id)) ?? id;

  const leads = loadLeads();
  leads.push({ id, sessionId, targetDir, launchedAt: Date.now(), approvedMembers, internalId: crypto.randomUUID(), mcpToken, secret });
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

// 팀장(사람이든 팀장 세션 자신이든)이 SKILL.md의 "띄우자마자 등록해라"를 깜빡하면(실사용 확인 —
// 오늘 이 앱을 고치던 팀장 자신도 팀원 d8bafe71/dc1db755를 등록 없이 띄웠다), 팀원이 실제로는
// 멀쩡히 일하고 있는데도 "미등록"으로만 보이고 어느 팀장 소속인지 전혀 알 길이 없었다. 등록 파일이
// 없어도 "이 팀장의 승인된 디렉토리에서, 이 팀장이 뜬 뒤에 새로 나타난 미등록 세션"이면 꽤 높은
// 확률로 그 팀장이 띄운 팀원이라고 추정할 수 있다 — 확정은 아니라서 자동으로 등록하지는 않고,
// "이 팀장 소속일 수 있음"이라고 표시만 해서 사람이 한 번 확인 후 등록 버튼을 누르게 한다.
function guessProbableLeadId(agent: AgentEntry, leads: LeadRecord[]): string | undefined {
  const lead = leads.find(l => l.approvedMembers.includes(agent.cwd) && (agent.startedAt ?? 0) >= l.launchedAt);
  return lead?.id;
}

// "세션 정리" 탭 전용 — 지금 떠있는 모든 백그라운드 세션(팀장/팀원으로 등록된 것 포함, 좀비도 포함)을
// 보여준다. 작업 화면(연결 흐름)과 완전히 분리해서, 실수로 잘못 끄는 사고를 줄인다.
async function getAllBackgroundSessions(): Promise<(AgentEntry & { tag: 'lead' | 'member' | 'untracked'; leadId?: string; probableLeadId?: string; registeredDir?: string })[]> {
  const agents = await fetchAgents();
  const leads = loadLeads();
  const leadIds = new Set(leads.map(l => l.id));
  const memberLeadById = new Map(loadMembers().map(m => [m.memberId, m.leadId]));
  return agents
    .filter(a => a.kind === 'background' && !!a.id)
    .map(a => {
      const tag = (leadIds.has(a.id!) ? 'lead' : memberLeadById.has(a.id!) ? 'member' : 'untracked') as 'lead' | 'member' | 'untracked';
      return {
        ...a,
        tag,
        // 세션 정리 탭에서 팀장 소속으로 팀원을 묶어서 보여주는 데 쓴다 — 팀장 자신·미등록 세션은 없다.
        leadId: memberLeadById.get(a.id!),
        // 미등록 세션에만 의미가 있다 — 확정 등록된 것과 헷갈리지 않게 tag는 여전히 'untracked'로 둔다.
        probableLeadId: tag === 'untracked' ? guessProbableLeadId(a, leads) : undefined,
        // 팀장이 EnterWorktree로 자기 작업 디렉토리를 일시적으로 워크트리 서브디렉토리로 옮기면
        // a.cwd(지금 이 순간의 실제 cwd)가 등록된 디렉토리와 달라진다 — 렌더러가 이 값이 있으면
        // 이름 표시에 a.cwd 대신 이걸 써서, "팀장이 잠깐 자리를 옮겼을 뿐인데 완전히 다른 팀장이
        // 새로 생긴 것처럼" 보이는 걸 막는다(실사용 재현: g1cl-mgt가 e2e 작업 중 워크트리로 옮겨간
        // 사례 — cleanup 탭이 "e2e-consolidated-report"라는 별개의 팀장처럼 보여줬었다). cwd 자체는
        // 그대로 남겨서 "지금 어디서 뭘 하고 있는지"는 여전히 보이게 한다.
        registeredDir: tag === 'lead' ? leads.find(l => l.id === a.id)?.targetDir : undefined,
      };
    })
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

// 세션 정리 탭에서 "이 팀장 소속일 수 있음" 추정 세션을 사람이 확인하고 누르는 "팀원으로 등록" 버튼용.
// agentId는 실제로 지금 떠있어야 하고(가짜 등록 방지), leadId도 실제 등록된 팀장이어야 한다 — 둘 다
// 아니면 아무 일도 안 하고 false를 반환한다.
async function registerProbableMember(agentId: string, leadId: string): Promise<boolean> {
  const agents = await fetchAgents();
  const agent = agents.find(a => a.id === agentId && a.kind === 'background');
  if (!agent) return false;
  if (!loadLeads().some(l => l.id === leadId)) return false;
  registerMember({ memberId: agentId, leadId, createdAt: Date.now(), sessionId: agent.sessionId });
  return true;
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
    // 이미 떠 있는 프로세스를 등록만 하는 경로라 --mcp-config를 지금 붙일 방법이 없다(그 값은
    // 세션 시작 시점에만 줄 수 있다) — 여기서 발급해두면 다음 stop→resume(채팅 전송 등) 때부터
    // resumeLead가 이 값을 이어받아 팀원 생성 툴을 쓸 수 있게 된다.
    mcpToken: crypto.randomUUID(),
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
  // 아직 leads.json 레코드가 없어서(브랜드 뉴 팀장) issueMcpToken을 못 쓴다 — launchTeamLead와
  // 같은 이유로 스폰 전에 직접 발급한다.
  const mcpToken = crypto.randomUUID();
  const id = await runClaudeBg(
    ['--bg', ...buildMemberSpawnCliArgs(mcpToken), '--resume', sessionId],
    '지금 이 대화를 Claude Team Monitor로 가져왔습니다(별도 복사본, 원본 세션과는 별개). 계속 진행하세요.',
    cwd,
  );
  if (!id) return null;
  const newSessionId = (await findSessionIdByShortId(id)) ?? id;
  const { paths: approvedMembers } = approvedMemberBriefing(cwd);
  // 위 두 await(runClaudeBg/findSessionIdByShortId) 동안 최대 수십 초가 지날 수 있고, 그 사이
  // 3초 폴링의 reconcileLeadIds 등이 leads.json에 다른 팀장의 변경을 저장했을 수 있다 — 맨 위에서
  // 캡처해둔 leads 배열을 그대로 쓰면 그 변경을 통째로 덮어써버린다(실측: Node 시뮬레이션으로
  // 재현 확인됨). launchTeamLead/adoptLead/resumeLead/restartLead와 같은 패턴대로, 쓰기 직전에
  // 다시 읽어서 최신 상태 위에 얹는다.
  const latestLeads = loadLeads();
  latestLeads.push({ id, sessionId: newSessionId, targetDir: cwd, launchedAt: Date.now(), approvedMembers, internalId: crypto.randomUUID(), mcpToken });
  saveLeads(latestLeads);
  return id;
}

function registerMember(member: MemberRecord): void {
  // 지금 있는 호출부(launchMember/registerProbableMember/reconcileMemberIds)는 전부 이미 안전한
  // memberId만 넘기지만, 파일 경로에 직접 쓰이는 값이라 여기서도 한 번 더 막아 방어선을 이중화한다.
  if (!isSafeId(member.memberId)) {
    console.error(`[registerMember] memberId 형식이 안전하지 않아 등록을 거부합니다: ${JSON.stringify(member.memberId)}`);
    return;
  }
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
async function launchMember(leadId: string, targetDir: string, instruction: string, role: string, label: string, model?: string): Promise<string | null> {
  // 빈 이름은 CLI 실행 실패(null 반환 → "터미널을 확인해보라"는 안내)와 다른 원인이라, 렌더러가
  // 왜 실패했는지 구분해서 보여줄 수 있게 별도 에러로 던진다.
  if (!label || !label.trim()) throw new Error('이 팀원을 구분할 이름을 입력해주세요.');
  // role은 화면 라벨용 메타데이터에 그치지 않고, Claude 세션 자신도 알 수 있게 프롬프트에 박아준다.
  const roleLine = role ? `역할: ${role}\n\n` : '';
  const prompt = `${TEAM_MEMBER_BRIEFING}\n\n${roleLine}${TEAM_MEMBER_STANDBY_NOTE}\n\n"""\n${instruction}\n"""`;
  const normalizedModel = normalizeMemberModel(model);
  const modelArgs = normalizedModel === 'default' ? [] : ['--model', normalizedModel];
  const id = await runClaudeBg(['--bg', ...modelArgs], resolveLongPrompt(prompt), targetDir);
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
    const { rows, requests, unapprovedDirs } = await buildSessionRows();
    mainWindow.webContents.send('agents-update', { rows, requests, stallAlerts: listStallAlertsForUi(), unapprovedDirs });
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

ipcMain.handle('launch-team-lead', async (_e, targetDir: string, instruction: string, secret?: boolean) => {
  const finalInstruction = instruction || '지금 상황을 파악하고 다음 작업을 시작해줘.';
  return launchTeamLead(targetDir, finalInstruction, secret);
});

ipcMain.handle('get-adoptable-sessions', () => getAdoptableSessions());

ipcMain.handle('get-all-background-sessions', () => getAllBackgroundSessions());

ipcMain.handle('register-probable-member', (_e, agentId: string, leadId: string) => registerProbableMember(agentId, leadId));

ipcMain.handle('stop-background-session', async (_e, shortId: string) => {
  await stopSession(shortId);
  return getAllBackgroundSessions();
});

// 작업 탭 카드에서 "새로고침"/"삭제"를 눌렀을 때 3초 폴링을 기다리지 않고 바로 최신 보드를 준다.
ipcMain.handle('refresh-board', async () => ({ ...(await buildSessionRows()), stallAlerts: listStallAlertsForUi() }));

ipcMain.handle('adopt-lead', async (_e, shortId: string) => adoptLead(shortId));

ipcMain.handle('get-interactive-sessions', () => getInteractiveSessions());

ipcMain.handle('fork-session-as-lead', async (_e, sessionId: string, cwd: string) => forkSessionAsLead(sessionId, cwd));

ipcMain.handle('get-member-templates', () => loadMemberTemplates());

ipcMain.handle('add-member-template', (_e, scope: string, dir: string, name: string, role: string, instruction: string, model?: string) => {
  const templates = loadMemberTemplates();
  templates.push({
    id: `tpl-${Date.now()}`,
    scope: scope || 'shared',
    path: dir || undefined,
    name: name || (dir ? path.basename(dir) : (role || '역할')),
    role: role || '',
    instruction: instruction || '',
    approved: false,
    model: normalizeMemberModel(model),
  });
  saveMemberTemplates(templates);
  return templates;
});

ipcMain.handle('update-member-template', (_e, id: string, fields: Partial<Pick<MemberTemplate, 'name' | 'role' | 'instruction' | 'model'>>) => {
  const templates = loadMemberTemplates();
  const t = templates.find(x => x.id === id);
  if (t) {
    const next = { ...fields };
    if ('model' in next) next.model = normalizeMemberModel(next.model);
    Object.assign(t, next);
    saveMemberTemplates(templates);
  }
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

ipcMain.handle('launch-member', async (_e, leadId: string, targetDir: string, instruction: string, role: string, label: string, model?: string) =>
  launchMember(leadId, targetDir, instruction, role, label, model));

// 요청 파일의 teamLeadId는 팀장 자신이 요청을 쓴 시점의 짧은 id를 그대로 담고 있다(팀장은 자기
// internalId를 알 방법이 없어 이게 유일한 참조 수단) — 사용자가 승인/거부 버튼을 누르기 전 그
// 사이 팀장의 짧은 id가 앱 밖에서 바뀌면(reconcileLeadIds가 다음 폴링에야 바로잡음) 못 찾아서
// writeRequestDecision으로 이미 처리 확정된 요청이 팀장에게 영원히 전달 안 될 수 있다. 못 찾으면
// 마지막으로 한 번 더(지금 이 순간 기준으로) 최신화를 시도해본다.
async function findLeadByShortIdWithReconcile(shortId: string): Promise<{ leads: LeadRecord[]; lead: LeadRecord | undefined }> {
  const leads = loadLeads();
  let lead = leads.find(l => l.id === shortId);
  if (!lead) {
    const agents = await fetchAgents();
    if (reconcileLeadIds(agents, leads).length) saveLeads(leads);
    lead = leads.find(l => l.id === shortId);
  }
  return { leads, lead };
}

// 승인/거부 결정(writeRequestDecision)은 파일에 영구 기록되지만, 그걸 팀장에게 알리는 resumeLead가
// 실패(null)할 수 있다 — 예전엔 이 반환값을 아예 안 보고 무조건 true를 돌려줘서, 결정은 기록됐는데
// 팀장은 영원히 그 사실을 모르는 채로(승인 대기 상태 그대로) 남을 수 있었다(팀원 코드리뷰에서 지적).
// decided(결정 자체가 기록됐는지)와 delivered(팀장에게 실제로 전달됐는지)를 분리해서 렌더러가 후자의
// 실패를 사용자에게 보여줄 수 있게 한다.
ipcMain.handle('approve-request', async (_e, requestId: string) => {
  const req = writeRequestDecision(requestId, 'approved');
  if (!req) return { decided: false, delivered: false };
  const { lead } = await findLeadByShortIdWithReconcile(req.teamLeadId);
  if (!lead) return { decided: true, delivered: false };

  if (req.type === 'stop-member') {
    if (req.memberId) await stopSession(req.memberId);
    const result = await queueLeadOperation(lead.internalId, () =>
      resumeLead(lead.internalId, `팀원 종료 요청이 승인됐습니다 — "${req.memberId}" 세션을 종료했습니다. 계속 진행하세요.`));
    return { decided: true, delivered: result !== null };
  }

  // findLeadByShortIdWithReconcile이 짧은 id 드리프트 때문에 await fetchAgents()를 거쳤을 수 있고
  // (수백 ms~1초 가까이 걸릴 수 있음, 위 실측 주석 참고), 그 사이 3초 폴링이 leads.json을 다시 저장
  // (aiTitle 캐싱·id 재조정 등)했을 수 있다 — 여기서 그 폴링 이전에 로드해둔 낡은 leads 배열을 그대로
  // saveLeads하면 폴링이 방금 쓴 내용을 통째로 덮어써서 잃어버린다(팀원 버그헌팅에서 지적, lost
  // update). 이 코드베이스의 다른 모든 쓰기(resumeLead/restartLead 등)가 그러듯, 쓰기 직전에
  // internalId로 최신 레코드를 다시 찾아서 쓴다.
  const freshLeads = loadLeads();
  const freshLead = freshLeads.find(l => l.internalId === lead.internalId);
  if (freshLead && !freshLead.approvedMembers.includes(req.requestedDir!)) {
    freshLead.approvedMembers.push(req.requestedDir!);
    saveLeads(freshLeads);
  }
  const result = await queueLeadOperation(lead.internalId, () =>
    resumeLead(lead.internalId, `팀원 요청이 승인됐습니다 — "${req.requestedDir}"에 팀원을 띄워도 됩니다. 이어서 진행하세요.`));
  return { decided: true, delivered: result !== null };
});

ipcMain.handle('deny-request', async (_e, requestId: string) => {
  const req = writeRequestDecision(requestId, 'denied');
  if (!req) return { decided: false, delivered: false };
  const { lead } = await findLeadByShortIdWithReconcile(req.teamLeadId);
  if (!lead) return { decided: true, delivered: false };

  if (req.type === 'stop-member') {
    const result = await queueLeadOperation(lead.internalId, () =>
      resumeLead(lead.internalId, `팀원 종료 요청이 거부됐습니다 — "${req.memberId}"는 종료하지 말고 계속 두세요.`));
    return { decided: true, delivered: result !== null };
  }

  const result = await queueLeadOperation(lead.internalId, () =>
    resumeLead(lead.internalId, `팀원 요청이 거부됐습니다 — "${req.requestedDir}"에는 팀원을 띄우지 마세요. 다른 방법을 찾거나 사용자에게 다시 확인하세요.`));
  return { decided: true, delivered: result !== null };
});

ipcMain.handle('get-changed-files', (_e, cwd: string) => getGitChangedFiles(cwd));

ipcMain.handle('get-file-diff', (_e, cwd: string, file: string) => getFileDiff(cwd, file));

ipcMain.handle('get-lead-transcript', (_e, leadId: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return [];
  const projectName = resolveProjectName(lead.sessionId, lead.targetDir);
  return getTranscript(projectName, lead.sessionId, lead.targetDir);
});

// AskUserQuestion으로 멈춘 세션이 실제로 무엇을 물었는지(질문 문구 + 선택지)는 claude agents --json엔
// 없고, daemon이 그 job마다 따로 관리하는 state.json에만 있다(실측 확인: 2026-09-17, block.questions
// 필드) — 지금까지 이 정보를 볼 방법이 없어서 사용자가 매번 터미널로 가서 직접 확인해야 했다. 이걸
// 읽어서 채팅창에 질문·선택지를 텍스트로만 보여준다("터미널에서 직접 열기" 버튼과 함께) — 채팅
// 답변 버튼은 일부러 안 만들었다: --resume에 실어 보낸 일반 채팅 메시지로 답을 흉내 내봤더니
// 실사용에서 반복적으로 "User declined to answer questions"로 처리됐다(2026-09-18, 실측 확인) —
// stop→resume 경로 자체가 이 tool_use를 정식으로 답변하는 방법이 아니라고 판단해 뺐다. 이 파일은
// daemon이 수시로 덮어쓰는 내부 상태라 스키마가 안 바뀐다는 보장이 없으므로, 읽기 실패나 예상과
// 다른 형태는 전부 조용히 null로 넘긴다(안내를 못 보여줄 뿐, 채팅 자체는 그대로 정상 동작해야 한다).
function readPendingChoiceQuestions(shortId: string): { question: string; options: { label: string; description?: string }[] }[] | null {
  if (!isSafeId(shortId)) return null;
  try {
    const raw = fs.readFileSync(path.join(JOBS_DIR, shortId, 'state.json'), 'utf-8');
    const data = JSON.parse(raw);
    const questions = data?.block?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return null;
    return questions
      .filter((q: unknown): q is { question: string; options: unknown } =>
        !!q && typeof q === 'object' && typeof (q as any).question === 'string' && Array.isArray((q as any).options))
      .map((q: any) => ({
        question: q.question,
        options: (q.options as unknown[])
          .filter((o): o is { label: string; description?: string } => !!o && typeof o === 'object' && typeof (o as any).label === 'string')
          .map((o: any) => ({ label: o.label, description: typeof o.description === 'string' ? o.description : undefined })),
      }))
      .filter(q => q.options.length > 0);
  } catch {
    return null;
  }
}

ipcMain.handle('get-pending-choice', (_e, shortId: string) => readPendingChoiceQuestions(shortId));

// AskUserQuestion류의 구조화된 선택지 말고도, 채팅으로는 절대 못 풀리는 blocked가 있다(실사용 확인,
// 2026-09-17: g1cl-mgt가 "Could not refresh your login because another Claude Code process is
// refreshing it..." 로그인 갱신 오류로 멈춘 사례) — 이런 건 --resume에 아무 메시지를 실어 보내도
// 의미가 없고, 사람이 터미널에서 직접 /login 등을 해야 풀린다. 여기서도 실제 문구는 daemon의
// state.json에만 있다. claude CLI가 로그인 갱신 실패 때 남기는 문구가 이것뿐이라는 보장은 없지만
// (버전이 바뀌면 문구가 달라질 수 있음, extractStartedCopyId와 같은 한계), 지금까지 실사용으로
// 확인된 것만 좁게 잡는다 — 오탐(진짜 채팅으로 풀리는 질문을 "터미널 가라"고 잘못 안내)보다는
// 미탐(놓쳐서 그냥 "확인 필요"로만 보이는 것)이 덜 위험하다고 판단했다.
const CHAT_UNRESOLVABLE_DETAIL_PATTERNS = [/could not refresh your login/i];

function readChatUnresolvableBlockDetail(shortId: string): string | null {
  if (!isSafeId(shortId)) return null;
  try {
    const raw = fs.readFileSync(path.join(JOBS_DIR, shortId, 'state.json'), 'utf-8');
    const data = JSON.parse(raw);
    if (data?.state !== 'blocked' || typeof data?.detail !== 'string') return null;
    if (!CHAT_UNRESOLVABLE_DETAIL_PATTERNS.some(re => re.test(data.detail))) return null;
    return data.detail;
  } catch {
    return null;
  }
}

ipcMain.handle('get-chat-unresolvable-detail', (_e, shortId: string) => readChatUnresolvableBlockDetail(shortId));

// claude CLI에는 이미 생성(응답) 중인 세션에 중간에 끼어들어 입력만 추가하는 기능이 없다(claude
// --help로 확인) — 개입할 수 있는 유일한 수단인 stop→resume은 하던 응답을 그대로 끊어버린다. 그래서
// 팀장이 지금 busy면 곧바로 stop→resume하지 않고, 팀원 추가 알림(queueLeadNotice)과 완전히 같은
// 패턴으로 메시지를 큐(pendingNotices)에 원문 그대로 쌓아둔 뒤, buildSessionRows의 폴링이 그 팀장의
// idle/blocked 전환을 감지했을 때 자동으로 resumeLead에 전달하게 한다. "끊지 않고 대기시켰다가
// idle 되면 전달"이 지금 이 CLI로 가능한 최선이다.
ipcMain.handle('send-to-lead', async (_e, leadId: string, message: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return { status: 'not-found' as const };

  // "터미널에서 직접 열기"로 띄운 attach 창이 아직 이 세션에 붙어있으면, 여기서 stop→resume을
  // 걸었다가 attach 쪽의 독립적인 재연결 시도와 경합해서 daemon이 복사본을 만들 수 있다(위
  // isAttachTerminalOpenFor 주석 참고, 실사용 재현됨). 큐로 돌리지 않고(그러면 영원히 안 풀릴
  // 수 있다) 바로 실패로 알려서 사용자가 터미널을 닫고 다시 보내게 한다.
  if (isAttachTerminalOpenFor(leadId)) {
    return { status: 'attach-open' as const };
  }

  const agents = await fetchAgents();
  const agent = agents.find(a => a.id === leadId);
  // blocked(권한 승인 대기 등)는 busy와 달리 "언젠가 저절로 풀리는" 상태가 아니다 — headless라
  // 아무도 승인해줄 수 없어 사실상 무기한 멈춰있을 수 있다. 그래서 여기서 blocked를 busy처럼 큐로
  // 돌리면(한때 그렇게 해봤다가 실사용에서 바로 걸림, 2026-09-17) 메시지가 다시는 안 풀리는 큐에
  // 영원히 갇혀버린다 — blocked는 오히려 stop→resume으로 깨워서 풀어줘야 하는 상황이다. 세션이
  // 복사본으로 갈라지는 사고(예전엔 여기서 났다)를 막는 안전장치는 이제 resumeLead 안에 있으므로
  // (stop 성공 여부를 확인하고 실패하면 resume 자체를 포기함) 여기서는 busy만 큐로 돌리면 된다 —
  // 다만 "busy"는 status만이 아니라 isLeadTooBusyToInterrupt로 판정한다(위 주석 참고).
  const isBusy = !!agent && isLeadTooBusyToInterrupt(agent);
  if (isBusy) {
    const noticeId = queueLeadNotice(lead.internalId, message, 'user');
    return { status: 'queued' as const, id: noticeId };
  }

  const id = await queueLeadOperation(lead.internalId, () => resumeLead(lead.internalId, message));
  // resumeLead가 null이면(정지 실패 등으로 resume 자체를 포기) 실제로는 메시지가 전달 안 된 것인데,
  // 예전엔 이걸 그냥 'sent'로 돌려줘서 렌더러가 성공으로 착각해 selectedLeadId를 null로 덮어쓰며
  // 대화창이 조용히 깨지는 문제가 있었다(팀원 코드리뷰에서 지적) — 별도 상태로 구분해서 알린다.
  if (id === null) return { status: 'failed' as const };
  return { status: 'sent' as const, id };
});

// 대기열에 쌓아둔 메시지 중 아직 전달 안 된 것을 사용자가 취소할 수 있게 한다(채팅창의 "취소" 버튼).
ipcMain.handle('cancel-queued-message', (_e, leadId: string, noticeId: string) => cancelQueuedNotice(leadId, noticeId));

// 히스토리 탭에서 "삭제" — 실제 claude 세션·대화 파일(daily-journal 포함)은 전혀 안 건드리고, 이
// 앱 자신의 추적 기록(leads.json)에서만 지운다. 시크릿 모드를 쓴 사용자가 Team Monitor 화면에서도
// 흔적을 지우고 싶을 때를 위한 기능이라, "이 앱이 기억하는 목록에서 빼는 것"이 전부다 — 더 깊이
// (원본 세션 transcript 자체)까지 지우는 건 되돌릴 수 없는 파괴적 작업이라 여기서 다루지 않는다.
// 살아있는 팀장(또는 그 소속 팀원)을 실수로 지우면 다음 폴링 때 "미등록" 세션으로 다시 나타나
// 혼란을 주므로, 오프라인 상태일 때만 지우도록 막는다.
async function deleteLeadHistory(internalId: string): Promise<{ success: boolean; error?: string }> {
  const leads = loadLeads();
  const rec = leads.find(l => l.internalId === internalId);
  if (!rec) return { success: false, error: '팀장 기록을 찾을 수 없습니다(이미 삭제됐을 수 있음).' };
  let isLive: boolean;
  try {
    const agents = await fetchAgentsStrict();
    const agentIdSet = new Set(agents.map(a => a.id));
    isLive = agentIdSet.has(rec.id) || hasLiveMember(rec.id, loadMembers(), agentIdSet);
  } catch {
    isLive = true; // 확인 자체가 실패하면 fail-closed — 살아있는데 지워버리는 사고보다 안전하다.
  }
  if (isLive) {
    return { success: false, error: '이 팀장(또는 소속 팀원)이 아직 살아있는 것으로 보입니다 — 오프라인 상태에서만 히스토리를 삭제할 수 있습니다.' };
  }
  saveLeads(leads.filter(l => l.internalId !== internalId));
  return { success: true };
}

ipcMain.handle('delete-lead-history', (_e, internalId: string) => deleteLeadHistory(internalId));

// 이 팀장 앞으로 아직 서버에 남아있는(전달 안 된) 대기열 알림들을 돌려준다 — 렌더러는 짧은 id만
// 알고 있으므로 여기서 internalId로 변환해서 찾는다. 두 곳에서 쓴다: (1) 재시작/작업종료 확인
// 모달의 "몇 건 남았는지" 경고(개수만 필요), (2) deliverPendingNotices가 이제 같은 팀장 앞 여러
// 건을 하나로 합쳐서 보낼 수 있어서, 대화창의 각 큐 항목이 실제로 전달됐는지를 더 이상 원문
// 텍스트로 트랜스크립트와 대조할 수 없다 — 이 목록에 더 이상 없으면 전달된 것으로 본다.
// exhausted(시도 횟수가 MAX_NOTICE_DELIVERY_ATTEMPTS에 도달)도 함께 내려준다 — 예전엔 id
// 존재 여부만 봤는데, 그러면 "아직 재시도 중"과 "자동 재시도를 완전히 포기하고 큐에 남아만
// 있음"이 화면에서 똑같이 "대기열에 넣었습니다"로 보였다(실사용 재현: 다른 경로가 같은 세션을
// 동시에 resume해서 포크가 반복되면 5회 재시도가 전부 실패하는데, 채팅창은 계속 "자동으로
// 전달됩니다"라고만 보여줘서 사용자가 메시지가 사실상 영구히 막힌 걸 알 도리가 없었다).
ipcMain.handle('get-pending-notice-ids', (_e, leadId: string) => {
  const lead = loadLeads().find(l => l.id === leadId);
  if (!lead) return [];
  return loadPendingNotices()
    .filter(n => n.leadInternalId === lead.internalId)
    .map(n => ({ id: n.id, exhausted: (n.attempts ?? 0) >= MAX_NOTICE_DELIVERY_ATTEMPTS }));
});

// 정체 감시가 만들어낸, 아직 사용자 확인을 안 거친 알림 목록. 화면에 팀장 이름 등을 붙여
// 보여줄 수 있게 leadId(짧은 id)도 같이 계산해서 내려준다 — 렌더러는 internalId를 모른다.
// poll()의 agents-update 푸시와 get-stall-alerts IPC 양쪽에서 같은 로직을 쓴다.
function listStallAlertsForUi(): (StallAlert & { leadId?: string })[] {
  const leads = loadLeads();
  return loadStallAlerts().map(a => ({
    ...a,
    leadId: leads.find(l => l.internalId === a.leadInternalId)?.id,
  }));
}

ipcMain.handle('get-stall-alerts', () => listStallAlertsForUi());

// 사용자가 "이어서 진행 지시"를 눌렀을 때만 실제로 팀장에게 전달한다 — Haiku 판단+앱 게이트를
// 다 통과해도 사람 확인 전에는 살아있는 세션에 자동으로 메시지를 찔러 넣지 않는다(반자동).
ipcMain.handle('confirm-stall-alert', (_e, alertId: string) => {
  const alerts = loadStallAlerts();
  const alert = alerts.find(a => a.id === alertId);
  if (!alert) return false;
  saveStallAlerts(alerts.filter(a => a.id !== alertId));
  queueLeadNotice(alert.leadInternalId, alert.suggestedMessage, 'system');
  return true;
});

ipcMain.handle('dismiss-stall-alert', (_e, alertId: string) => {
  const alerts = loadStallAlerts();
  const filtered = alerts.filter(a => a.id !== alertId);
  if (filtered.length === alerts.length) return false;
  saveStallAlerts(filtered);
  return true;
});

ipcMain.handle('get-settings', () => loadSettings());

ipcMain.handle('update-settings', (_e, partial: Partial<AppSettings>) => saveSettings(partial));

ipcMain.handle('set-lead-auto-stall-nudge', (_e, leadId: string, value: boolean) => {
  const leads = loadLeads();
  const lead = leads.find(l => l.id === leadId);
  if (lead) { lead.autoStallNudge = !!value; saveLeads(leads); }
  return leads;
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

// 인터랙티브 명령(claude attach, claude 최초 승인 등)은 이 앱 안에서 답할 수 없어서 항상 사람이
// 보는 새 터미널 창을 띄워야 한다 — Windows(cmd.exe)와 macOS(Terminal.app, osascript)를 각각의
// 방식으로 지원한다. env는 Windows에서만 의미가 있다 — spawn()의 env는 그 spawn()의 직계 자식
// 프로세스(cmd.exe)에만 적용되는데, macOS의 Terminal.app은 osascript의 자식이 아니라 Apple Event로
// 메시지만 받는 완전히 별개의(이미 떠있는) 앱이라 osascript의 env를 아예 물려받지 않는다 — 그래서
// CLAUDE_CODE_* 마커 제거(open-terminal-for-approval 참고)가 macOS에서는 애초에 필요 없다.
function openTerminalRunning(command: string, cwd?: string, winEnv?: NodeJS.ProcessEnv): void {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', command], {
      cwd,
      detached: true,
      stdio: 'ignore',
      shell: true,
      env: winEnv,
    });
    child.on('error', err => console.error('[openTerminalRunning] 터미널을 여는 데 실패했습니다:', err));
    child.unref();
    return;
  }
  if (process.platform === 'darwin') {
    const shellCommand = cwd ? `cd ${shellSingleQuote(cwd)} && ${command}` : command;
    const script = `tell application "Terminal" to do script "${escapeAppleScriptString(shellCommand)}"`;
    const child = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    child.on('error', err => console.error('[openTerminalRunning] 터미널을 여는 데 실패했습니다:', err));
    child.unref();
    return;
  }
  console.error(`[openTerminalRunning] 이 OS(${process.platform})에서는 터미널 자동 열기를 지원하지 않습니다.`);
}

// "터미널에서 직접 열기"로 띄운 attach 터미널의 PID를 세션 짧은 id별로 기억해둔다 — 이 창이 열려
// 있는 동안 앱이 같은 세션에 stop→resume을 걸면(메시지 배달) attach 쪽도 독립적으로 재연결을
// 시도해서 daemon이 복사본을 만드는 경합이 실제로 재현됐다(2026-09-18, 이 앱 자신의 팀장 세션에서
// 실사용 재현 — daemon.log에 fleet/shell 태그가 같은 세션에 몇 초 간격으로 번갈아 찍히며 6연속
// 포크). Windows에서만 지원한다 — macOS는 osascript가 이미 떠있는 Terminal.app에 Apple Event로
// 명령만 보내는 방식이라 새로 생기는 자식 프로세스가 없어서 PID로 추적할 방법이 없다.
const attachTerminalPids = new Map<string, number[]>(); // key: session 짧은 id

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// resumeLead/deliverPendingNotices가 stop→resume을 걸기 전에 확인한다 — 살아있는 PID가 하나도
// 없으면(창을 닫았거나 애초에 못 찾았으면) false를 돌려주면서 지도도 정리한다.
function isAttachTerminalOpenFor(sessionShortId: string): boolean {
  const pids = attachTerminalPids.get(sessionShortId);
  if (!pids || pids.length === 0) return false;
  const alive = pids.filter(isProcessAlive);
  if (alive.length === 0) {
    attachTerminalPids.delete(sessionShortId);
    return false;
  }
  if (alive.length !== pids.length) attachTerminalPids.set(sessionShortId, alive);
  return true;
}

// openTerminalRunning으로 claude attach 터미널을 띄운 직후, 그 창의 실제 PID를 찾아 기록한다.
// Windows에서 콘솔 없는 프로세스(Electron main)가 `cmd.exe /c start cmd.exe /k <command>`로 새
// 콘솔 창을 띄우면, spawn()이 돌려주는 child(=`cmd.exe /c start ...` 자신)는 `start`가 새 창을
// 띄우자마자 곧바로 종료돼버려서 child.pid로는 실제 창의 PID를 못 잡는다 — 대신 명령줄에 이
// 세션의 짧은 id가 고유하게 박혀있는 걸 이용해 WMI로 찾는다. `start`가 실제로 새 창을 띄우기까지
// 짧은 지연이 있어 800ms 뒤에 조회한다(그 사이 사라지는 `/c start` 자신의 프로세스가 같이 잡혀도
// 무해하다 — isAttachTerminalOpenFor가 매번 살아있는 것만 걸러낸다).
function trackAttachTerminal(sessionShortId: string): void {
  if (process.platform !== 'win32') return;
  setTimeout(() => {
    const needle = `claude attach ${sessionShortId}`;
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | Select-Object -ExpandProperty ProcessId`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    ps.stdout?.on('data', d => { out += d.toString(); });
    ps.on('close', () => {
      const pids = out.split(/\s+/).map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
      if (pids.length) attachTerminalPids.set(sessionShortId, pids);
    });
    // 못 찾아도(예: powershell 자체가 없는 환경) 이 세션에 대해서만 경합 감지를 못 하는 것뿐이고
    // 예전(이 기능 추가 전)과 같은 동작으로 남으므로 best-effort로 둔다.
    ps.on('error', () => { /* ignore */ });
  }, 800);
}

ipcMain.handle('open-in-terminal', (_e, sessionShortId: string) => {
  if (typeof sessionShortId !== 'string' || !SESSION_SHORT_ID_RE.test(sessionShortId)) {
    console.error('[open-in-terminal] 유효하지 않은 세션 id라 거부합니다:', sessionShortId);
    return;
  }
  // claude attach는 인터랙티브 터미널이 필요해서, 새 콘솔 창을 띄워 그 안에서 attach를 실행한다.
  openTerminalRunning(`claude attach ${sessionShortId}`);
  trackAttachTerminal(sessionShortId);
});

// 이 앱(Claude Team Monitor.exe) 자신이 다른 claude 세션 안에서(팀장 세션의 자식 프로세스 등으로)
// 실행되는 경우가 흔해서, process.env에 CLAUDE_CODE_CHILD_SESSION=1 같은 "나는 상위 세션의 자식이다"
// 마커가 이미 실려 있을 수 있다(실사용 확인: 2026-09-17). spawn()은 기본적으로 이 env를 그대로
// 자식 프로세스에 물려주는데, open-terminal-for-approval이 새로 띄우는 터미널의 claude에까지 이
// 마커가 그대로 전달되면 claude가 그 터미널을 "진짜 새 최상위 세션"이 아니라 기존 세션의 연장으로
// 보고 워크스페이스 신뢰 다이얼로그 자체를 건너뛴다(터미널 배너에 "inherited CLAUDE_CODE_CHILD_SESSION
// marker"로 직접 찍힘) — 그런데 그러면서도 ~/.claude.json에 그 디렉토리의 신뢰 승인 기록은 남기지
// 않는다. 결과적으로 사용자는 눌러야 할 승인 다이얼로그 자체를 못 보고, 승인도 실제로는 안 된 채로
// 끝나서 checkDirectoryClaudeReady가 여전히 "미승인"으로 판정하는(즉 이 버튼이 아무 효과가 없는)
// 사고로 이어진다(실사용 재현). 그래서 이 터미널만큼은 CLAUDE_CODE_ 접두사가 붙은 환경변수를 전부
// 지운 깨끗한 env로 띄워서, 그 안의 claude가 진짜 독립된 최상위 세션처럼 동작하게 한다.
function envWithoutClaudeCodeSessionMarkers(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

// 사용자가 "승인하기" 버튼을 눌렀을 때, 그 디렉토리에서 새 터미널 창으로 claude를 인터랙티브로
// 한 번 띄워준다 — claude CLI 최초 실행 시 뜨는 워크스페이스 신뢰/CLAUDE.md include 승인 다이얼로그를
// 사용자가 그 자리에서 바로 클릭해서 넘길 수 있게 하기 위함(open-in-terminal과 같은 패턴). 렌더러가
// 임의의 경로를 넘겨서 아무 데서나 터미널을 열게 하면 안 되므로, 지금 이 앱이 실제로 알고 있고
// 아직 승인이 안 된 디렉토리인지 서버 쪽에서 다시 확인한다.
ipcMain.handle('open-terminal-for-approval', async (_e, targetDir: string) => {
  if (typeof targetDir !== 'string') return;
  const isKnownUnapproved = computeUnapprovedDirs(loadLeads()).some(u => u.dir === targetDir);
  if (!isKnownUnapproved) {
    console.error('[open-terminal-for-approval] 알 수 없거나 이미 승인된 디렉토리라 거부합니다:', targetDir);
    return;
  }
  openTerminalRunning('claude', targetDir, envWithoutClaudeCodeSessionMarkers());
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
