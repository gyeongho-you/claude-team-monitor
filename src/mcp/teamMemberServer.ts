// 팀원 생성 전용 MCP 서버 — stdio 방식이라 claude CLI가 팀장 세션을 시작할 때 자식 프로세스로
// 직접 실행하고, 세션이 끝나면 같이 정리된다(상시로 띄워둘 서버가 아니다, 따로 관리할 필요 없음).
//
// 왜 이게 필요한가: 예전엔 SKILL.md가 팀장에게 "Bash로 claude --bg를 직접 실행하고, 그다음
// 등록 파일도 따로 써라"는 2단계 지시를 줬다. 팀장(LLM)이 1단계만 하고 2단계(등록)를 깜빡하면
// 아무도 못 막아서, 실제로 이 앱을 통해 관리되는 여러 팀장 세션이 반복해서 이 실수를 저질렀다
// (팀원을 스폰만 하고 등록은 안 해서 모니터링 화면에 안 잡히는 사고). 이 서버는 스폰+등록을
// 툴 호출 하나로 묶어서, "스폰은 했는데 등록을 깜빡"하는 상황 자체를 구조적으로 없앤다.
//
// "이 프로세스가 어느 팀장인지"는 이 프로세스를 실행하는 claude 세션의 환경변수
// (TEAM_MONITOR_LEAD_TOKEN / TEAM_MONITOR_LEADS_PATH)로 전달받는다 — main.ts가 팀장을
// 시작/재개할 때마다(launchTeamLead/resumeLead/restartLead/adoptLead/forkSessionAsLead) 그
// 시점에 새로 발급한 토큰을 --mcp-config에 실어 보낸다. sessionId를 안 쓰는 이유: launchTeamLead/
// restartLead처럼 새 세션을 스폰하는 경로는 claude --bg 실행 전엔 결과 sessionId를 알 수
// 없다(CLI가 실행 후에 발급) — 그래서 스폰 전에 미리 만들어 넘길 수 있는, 이 앱이 직접 발급하는
// 별도 토큰(LeadRecord.mcpToken)을 쓴다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isSafeId } from '../lib/pathGuard';
import { extractBackgroundedId } from '../lib/claudeBgOutput';
import { normalizeMemberModel } from '../lib/appSettings';
import { MEMBERS_DIR } from '../lib/teamMemberPaths';
// TEAM_MEMBER_BRIEFING은 launchMember(main.ts)가 쓰는 것과 정확히 같은 상수를 그대로 재사용한다
// — 둘이 어긋나면 앱이 직접 등록하는 팀원과 팀장이 이 툴로 만드는 팀원이 서로 다른 브리핑을
// 받게 된다. TEAM_MEMBER_STANDBY_NOTE는 여기서 안 쓴다(아래 prompt 조립부 주석 참고).
import { TEAM_MEMBER_BRIEFING } from '../lib/teamMemberBriefing';

// main.ts의 RUN_CLAUDE_TIMEOUT_MS와 같은 값을 쓴다(콜드 스타트가 오래 걸릴 수 있음을 감안) —
// 상수 파일을 공유하기엔 main.ts 쪽 값이 다른 여러 타이밍 상수와 얽혀 있어서, 여기서는 그
// 값만 그대로 복사해 유지한다.
const RUN_CLAUDE_TIMEOUT_MS = 45000;

type LeadRecord = { id: string; sessionId: string; approvedMembers: string[]; mcpToken?: string };

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function loadLeadFromEnv(): { lead: LeadRecord } | { error: string } {
  const leadsPath = process.env.TEAM_MONITOR_LEADS_PATH;
  const token = process.env.TEAM_MONITOR_LEAD_TOKEN;
  if (!leadsPath || !token) {
    return { error: '이 MCP 서버가 팀장 컨텍스트 없이 실행되고 있습니다(환경변수 누락) — Claude Team Monitor를 통해 시작된 팀장 세션에서만 이 툴을 쓸 수 있습니다.' };
  }
  let leads: LeadRecord[];
  try {
    leads = JSON.parse(fs.readFileSync(leadsPath, 'utf-8'));
  } catch (err) {
    return { error: `leads.json을 읽지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  const lead = leads.find(l => l.mcpToken === token);
  if (!lead) return { error: '이 팀장의 leads.json 레코드를 찾을 수 없습니다 — 아직 등록되기 전이거나 삭제된 것 같습니다.' };
  return { lead };
}

function findSessionIdByShortId(shortId: string): Promise<string | null> {
  return new Promise(resolve => {
    exec('claude agents --json', { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const agents = JSON.parse(stdout) as { id?: string; sessionId?: string }[];
        resolve(agents.find(a => a.id === shortId)?.sessionId ?? null);
      } catch {
        resolve(null);
      }
    });
  });
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

function registerMember(member: { memberId: string; leadId: string; createdAt: number; role?: string; label?: string; sessionId?: string }): void {
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
    const leadResult = loadLeadFromEnv();
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

    const memberId = await runClaudeBg(['--bg', ...modelArgs, prompt], resolvedTarget);
    if (!memberId) {
      return errorResult('claude --bg 실행에 실패했습니다 — claude CLI 설치/로그인 상태 또는 대상 디렉토리를 확인하세요.');
    }

    const sessionId = (await findSessionIdByShortId(memberId)) ?? undefined;
    try {
      registerMember({ memberId, leadId: lead.id, createdAt: Date.now(), role, label: label.trim(), sessionId });
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

const transport = new StdioServerTransport();
server.connect(transport).catch(err => {
  console.error('[teamMemberServer] MCP 서버 연결 실패:', err);
  process.exit(1);
});
