// 팀원 생성 전용 MCP 서버 — stdio 방식이라 claude CLI가 팀장 세션을 시작할 때 자식 프로세스로
// 직접 실행하고, 세션이 끝나면 같이 정리된다(상시로 띄워둘 서버가 아니다, 따로 관리할 필요 없음).
//
// 왜 이게 필요한가: 예전엔 SKILL.md가 팀장에게 "Bash로 claude --bg를 직접 실행하고, 그다음
// 등록 파일도 따로 써라"는 2단계 지시를 줬다. 팀장(LLM)이 1단계만 하고 2단계(등록)를 깜빡하면
// 아무도 못 막아서, 실제로 이 앱을 통해 관리되는 여러 팀장 세션이 반복해서 이 실수를 저질렀다
// (팀원을 스폰만 하고 등록은 안 해서 모니터링 화면에 안 잡히는 사고). 이 서버는 스폰+등록을
// 툴 호출 하나로 묶어서, "스폰은 했는데 등록을 깜빡"하는 상황 자체를 구조적으로 없앤다.
//
// "이 프로세스가 어느 팀장인지"는 process.ppid(이 MCP 서버를 실행시킨 claude 세션 자신의 pid)로
// `claude agents --json`에서 자기 자신을 찾아 알아낸다(resolveCallingLead 참고). 예전엔 스폰
// 시점에 이 앱이 발급한 토큰을 환경변수(TEAM_MONITOR_LEAD_TOKEN/TEAM_MONITOR_LEADS_PATH)로
// 전달받아 식별했는데, 그러면 이 앱을 거쳐 스폰된 세션만 쓸 수 있었다 — 터미널에서 스킬만으로
// 직접 시작한 팀장은 토큰을 받을 방법이 없었다. ppid 기반 식별은 실측 확인됐다(2026-09-22: MCP
// stdio 서버는 claude 세션의 직계 자식으로 뜨고, process.ppid가 그 세션의 pid와 정확히 일치한다 —
// 중간에 daemon이 안 낀다). 아직 leads.json에 없는 세션은 register_as_lead 툴로 스스로 등록한다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isSafeId } from '../lib/pathGuard';
import { extractBackgroundedId } from '../lib/claudeBgOutput';
import { normalizeMemberModel } from '../lib/appSettings';
import { MEMBERS_DIR, LEADS_PATH } from '../lib/teamMemberPaths';
import { execAgentsJson } from '../lib/agentsJson';
import { checkDirectoryClaudeReady, claudeNotReadyMessage } from '../lib/claudeReadiness';
// TEAM_MEMBER_BRIEFING은 launchMember(main.ts)가 쓰는 것과 정확히 같은 상수를 그대로 재사용한다
// — 둘이 어긋나면 앱이 직접 등록하는 팀원과 팀장이 이 툴로 만드는 팀원이 서로 다른 브리핑을
// 받게 된다. TEAM_MEMBER_STANDBY_NOTE는 여기서 안 쓴다(아래 prompt 조립부 주석 참고).
import { TEAM_MEMBER_BRIEFING } from '../lib/teamMemberBriefing';
import { resolveLongPrompt } from '../lib/longPromptGuard';

// main.ts의 RUN_CLAUDE_TIMEOUT_MS와 같은 값을 쓴다(콜드 스타트가 오래 걸릴 수 있음을 감안) —
// 상수 파일을 공유하기엔 main.ts 쪽 값이 다른 여러 타이밍 상수와 얽혀 있어서, 여기서는 그
// 값만 그대로 복사해 유지한다.
const RUN_CLAUDE_TIMEOUT_MS = 45000;

// main.ts의 LeadRecord와 정확히 같은 파일(leads.json)을 읽고 쓰므로, 그 필드셋과 어긋나면 안 된다
// — 여기서 실제로 쓰는 필드만 타입에 올린다(다른 팀장 레코드에 있는, 여기서 모르는 필드는
// JSON.parse/stringify를 그대로 거치므로 유실되지 않는다).
type LeadRecord = {
  id: string;
  sessionId: string;
  targetDir: string;
  launchedAt: number;
  approvedMembers: string[];
  internalId: string;
  secret?: boolean;
};

// main.ts의 SECRET_MODE_CLI_ARGS와 정확히 같은 값이다 — 시크릿 팀장이 만드는 팀원도 daily-journal
// 등 user-level 훅에 안 남아야 "팀장만 시크릿이고 팀원은 흔적이 남는" 반쪽짜리가 안 된다. 상수
// 파일을 공유하기엔 main.ts 쪽이 다른 타이밍 상수와 얽혀 있어서, RUN_CLAUDE_TIMEOUT_MS와 같은
// 이유로 여기서도 값만 그대로 복사해 유지한다 — main.ts에서 이 값을 바꾸면 여기도 같이 바꿔야 한다.
const SECRET_MODE_CLI_ARGS = ['--setting-sources', 'project,local'];

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

type AgentEntry = { id?: string; sessionId?: string; pid?: number; cwd?: string; kind?: string; startedAt?: number };

// process.ppid(부모 프로세스, 즉 이 MCP 서버를 자식으로 띄운 claude 세션 자신)와 pid가 일치하는
// 항목을 `claude agents --json` 결과에서 찾는다 — 그 항목이 바로 "나를 실행시킨 세션"이다.
async function findCallingAgent(): Promise<AgentEntry | null> {
  try {
    const agents = await execAgentsJson() as AgentEntry[];
    return agents.find(a => a.pid === process.ppid) ?? null;
  } catch {
    return null;
  }
}

function readLeads(): LeadRecord[] {
  try {
    return JSON.parse(fs.readFileSync(LEADS_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

function writeLeads(leads: LeadRecord[]): void {
  fs.mkdirSync(path.dirname(LEADS_PATH), { recursive: true });
  const tmpPath = `${LEADS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(leads, null, 2), 'utf-8');
  fs.renameSync(tmpPath, LEADS_PATH);
}

async function resolveCallingLead(): Promise<{ lead: LeadRecord } | { error: string }> {
  const agent = await findCallingAgent();
  if (!agent || !agent.sessionId) {
    return {
      error: '이 MCP 서버를 실행 중인 claude 세션을 claude agents --json 목록에서 찾지 못했습니다 — ' +
        '--bg로 뜬 세션이 아니거나, 방금 시작돼서 아직 목록에 반영되지 않았을 수 있습니다(몇 초 후 다시 시도해보세요).',
    };
  }
  const lead = readLeads().find(l => l.sessionId === agent.sessionId);
  if (!lead) {
    return {
      error: '이 세션은 아직 팀장으로 등록되지 않았습니다 — 먼저 mcp__team-monitor__register_as_lead 툴을 ' +
        '호출해 스스로를 등록한 뒤 다시 시도하세요.',
    };
  }
  return { lead };
}

async function findSessionIdByShortId(shortId: string): Promise<string | null> {
  try {
    const agents = await execAgentsJson() as { id?: string; sessionId?: string }[];
    return agents.find(a => a.id === shortId)?.sessionId ?? null;
  } catch {
    return null;
  }
}

function runClaudeBg(args: string[], cwd: string): Promise<string | null> {
  return new Promise(resolve => {
    let out = '';
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // shell:true를 안 쓰는 이유는 main.ts의 runClaudeBg와 동일하다 — 지시문에 개행이 있으면
    // Windows cmd.exe가 줄에서 끊어버린다.
    const child = spawn('claude', args, { cwd });
    const timer = setTimeout(() => { child.kill(); finish(null); }, RUN_CLAUDE_TIMEOUT_MS);
    child.stdout?.on('data', d => { out += d.toString(); });
    child.on('close', () => finish(extractBackgroundedId(out)));
    child.on('error', () => finish(null));
  });
}

function registerMember(member: { memberId: string; leadId: string; createdAt: number; role?: string; label?: string; sessionId?: string; secret?: boolean }): void {
  if (!isSafeId(member.memberId)) {
    throw new Error(`memberId 형식이 안전하지 않습니다: ${JSON.stringify(member.memberId)}`);
  }
  fs.mkdirSync(MEMBERS_DIR, { recursive: true });
  const tmpPath = path.join(MEMBERS_DIR, `${member.memberId}.json.${process.pid}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(member, null, 2), 'utf-8');
  fs.renameSync(tmpPath, path.join(MEMBERS_DIR, `${member.memberId}.json`));
}

const server = new McpServer({ name: 'claude-team-monitor', version: '1.0.0' });

server.registerTool(
  'spawn_team_member',
  {
    title: '팀원 생성',
    description: [
      '새 팀원(claude --bg 백그라운드 세션)을 사전 승인된 디렉토리에 띄우고, Claude Team Monitor',
      '앱에 자동으로 등록한다. 팀원을 만들 때는 Bash로 claude --bg를 직접 실행하지 말고 항상',
      '이 툴을 써라 — 이 툴은 스폰과 등록을 한 번에 처리해서, 등록을 깜빡해 모니터링 화면에',
      '팀원이 안 잡히는 사고를 원천적으로 막는다.',
    ].join(' '),
    inputSchema: {
      targetDir: z.string().describe('이 팀원이 작업할 저장소의 절대 경로. 사전 승인된 디렉토리여야 한다.'),
      instruction: z.string().describe('이 팀원에게 줄 구체적인 작업 지시.'),
      label: z.string().describe('이 팀원을 구분할, 사람이 읽을 수 있는 이름.'),
      role: z.string().optional().describe('선택: 이 팀원의 역할(예: reviewer, implementer). 화면 표시 및 팀원 자신에게도 전달된다.'),
      model: z.enum(['default', 'haiku', 'sonnet', 'opus']).optional().describe('선택: 이 팀원에 쓸 모델. 생략하면 기본값.'),
    },
  },
  async ({ targetDir, instruction, label, role, model }) => {
    const leadResult = await resolveCallingLead();
    if ('error' in leadResult) return errorResult(leadResult.error);
    const { lead } = leadResult;

    if (!instruction.trim()) return errorResult('instruction이 비어있습니다.');
    if (!label.trim()) return errorResult('이 팀원을 구분할 label을 입력하세요.');

    const resolvedTarget = path.resolve(targetDir);
    const isApproved = lead.approvedMembers.some(dir => path.resolve(dir) === resolvedTarget);
    if (!isApproved) {
      return errorResult(
        `"${targetDir}"는 사전 승인된 디렉토리 목록에 없습니다. 바로 띄우지 말고, SKILL.md의 ` +
        `"새 팀원 승인 요청" 절차(~/.claude/claude-team-monitor/requests/에 dir-approval 요청 ` +
        '작성 후 턴 종료)를 먼저 거치세요.',
      );
    }

    // TEAM_MEMBER_STANDBY_NOTE는 여기 안 붙인다 — 그건 앱 UI가 "역할·지시를 먼저 등록해두고
    // 나중에 시작 신호를 보낸다"는 2단계 흐름(launchMember)에서만 쓰는 문구다. 이 툴은 팀장이
    // 지금 당장 실행할 실제 지시를 그대로 넘기는 구조라, 옛 SKILL.md의 Bash 기반 흐름과 똑같이
    // "대기하지 말고 바로 시작하라"는 게 맞다 — STANDBY_NOTE를 넣으면 팀원이 실제 지시를 받고도
    // 준비 완료 응답만 남긴 채 다음 메시지를 기다리며 방치되는 사고가 난다.
    const roleLine = role ? `역할: ${role}\n\n` : '';
    const prompt = `${TEAM_MEMBER_BRIEFING}\n\n${roleLine}"""\n${instruction}\n"""`;
    const normalizedModel = normalizeMemberModel(model);
    const modelArgs = normalizedModel === 'default' ? [] : ['--model', normalizedModel];

    // main.ts의 launchTeamLead/resumeLead/restartLead와 같은 이유로(claudeReadiness.js 주석 참고:
    // 2026-09-21 재검증 — claude CLI v2.1.278, 한 번도 실행한 적 없는 새 디렉토리 3곳에서 백그라운드
    // 스폰 3/3 모두 트러스트 다이얼로그 없이 정상 완료) 이 판정을 더 이상 spawn 차단에 쓰지 않는다 —
    // 경고만 남기고 그대로 진행한다. 그래도 아래에서 spawn 자체가 실패하면(구버전 CLI로 되돌아갔거나
    // 이번 재검증이 특이 케이스였을 가능성 포함) readiness가 원인일 수 있다는 걸 실패 메시지에 같이 담는다.
    const readiness = checkDirectoryClaudeReady(resolvedTarget);
    if (!readiness.ready) {
      console.error(`[teamMemberServer] ${claudeNotReadyMessage(resolvedTarget, readiness.reason!)} (경고만 하고 spawn은 계속 시도합니다)`);
    }

    const memberId = await runClaudeBg(
      ['--bg', ...modelArgs, ...(lead.secret ? SECRET_MODE_CLI_ARGS : []), resolveLongPrompt(prompt)],
      resolvedTarget,
    );
    if (!memberId) {
      if (!readiness.ready) {
        return errorResult(
          `팀원 세션 시작에 실패했습니다 — "${resolvedTarget}"에서 ${readiness.reason} 이게 원인일 수 있습니다. ` +
          '그 디렉토리에서 터미널로 claude를 한 번 실행해 승인창을 눌러준 뒤 다시 시도해보세요.',
        );
      }
      return errorResult('claude --bg 실행에 실패했습니다 — claude CLI 설치/로그인 상태 또는 대상 디렉토리를 확인하세요.');
    }

    const sessionId = (await findSessionIdByShortId(memberId)) ?? undefined;
    try {
      registerMember({ memberId, leadId: lead.id, createdAt: Date.now(), role, label: label.trim(), sessionId, secret: lead.secret });
    } catch (err) {
      return errorResult(
        `팀원(${memberId})은 떴지만 등록에 실패했습니다: ${err instanceof Error ? err.message : String(err)}. ` +
        `직접 ~/.claude/claude-team-monitor/members/${memberId}.json을 만들어 등록을 완료하세요.`,
      );
    }

    return {
      content: [{
        type: 'text' as const,
        text: `팀원을 생성하고 등록했습니다. memberId: ${memberId}, 이름: ${label}, 역할: ${role || '(없음)'}, 디렉토리: ${resolvedTarget}`,
      }],
    };
  },
);

server.registerTool(
  'register_as_lead',
  {
    title: '이 세션을 팀장으로 등록',
    description: [
      '지금 이 claude 세션 자신을 Claude Team Monitor의 팀장으로 등록한다. 이 앱(Electron/Tauri)을',
      '거치지 않고 터미널에서 곧바로 /team-lead 스킬로 시작한 세션은 처음엔 등록이 안 되어 있어서',
      'spawn_team_member가 "아직 등록되지 않았다"는 에러를 돌려준다 — 그때 이 툴을 먼저 한 번',
      '호출해 스스로를 등록해라. 이미 등록되어 있으면(이 앱을 통해 시작됐거나, 이전에 이미 이',
      '툴을 호출한 경우) 아무것도 바꾸지 않고 그대로 성공을 반환한다.',
    ].join(' '),
    inputSchema: {
      approvedMembers: z.array(z.string()).optional().describe(
        '선택: 이 팀장이 팀원을 띄워도 되는 디렉토리(절대 경로) 목록. 생략하면 빈 목록으로 시작한다 ' +
        '— 팀원이 필요해지면 SKILL.md의 "새 팀원 승인 요청" 절차로 그때그때 채워도 된다.',
      ),
    },
  },
  async ({ approvedMembers }) => {
    const agent = await findCallingAgent();
    if (!agent || !agent.sessionId || !agent.id) {
      return errorResult(
        '이 세션을 claude agents --json 목록에서 찾지 못했습니다 — --bg로 뜬 세션이 아니거나, 방금 ' +
        '시작돼서 아직 목록에 반영되지 않았을 수 있습니다(몇 초 후 다시 시도해보세요).',
      );
    }
    if (agent.kind !== 'background') {
      return errorResult('interactive(사람이 직접 타이핑하는) 세션은 팀장으로 등록할 수 없습니다 — claude --bg로 띄운 세션만 지원합니다.');
    }
    const existing = readLeads().find(l => l.sessionId === agent.sessionId);
    if (existing) {
      return { content: [{ type: 'text' as const, text: `이미 팀장으로 등록되어 있습니다(id: ${existing.id}).` }] };
    }
    const newLead: LeadRecord = {
      id: agent.id,
      sessionId: agent.sessionId,
      targetDir: agent.cwd ?? process.cwd(),
      launchedAt: agent.startedAt ?? Date.now(),
      approvedMembers: approvedMembers ?? [],
      internalId: crypto.randomUUID(),
    };
    // 위 findCallingAgent/readLeads 동안 다른 팀장의 등록/변경이 leads.json에 먼저 반영됐을 수
    // 있다 — 쓰기 직전에 다시 읽어서 최신 상태 위에 얹는다(main.ts의 여러 스폰 경로와 같은 패턴).
    const latestLeads = readLeads();
    if (latestLeads.some(l => l.sessionId === agent.sessionId)) {
      return { content: [{ type: 'text' as const, text: `이미 팀장으로 등록되어 있습니다(id: ${agent.id}).` }] };
    }
    latestLeads.push(newLead);
    try {
      writeLeads(latestLeads);
    } catch (err) {
      return errorResult(`등록에 실패했습니다: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { content: [{ type: 'text' as const, text: `팀장으로 등록했습니다(id: ${agent.id}, 디렉토리: ${newLead.targetDir}).` }] };
  },
);

const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  console.error('[teamMemberServer] MCP 서버 연결 실패:', err);
  process.exit(1);
});
