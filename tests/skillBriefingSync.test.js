const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 예전엔 SKILL.md가 팀장에게 "Bash로 claude --bg를 직접 실행하고, TEAM_MEMBER_BRIEFING 문구를
// 그대로 복사해 붙여라"고 안내했다 — 그래서 SKILL.md 자체에 그 문구가 문자 그대로 들어있어야
// 했고, 이 테스트 파일이 그 동기화를 검증했다. 이제는 팀원 생성이 mcp__team-monitor__spawn_team_member
// 툴 하나로 바뀌어서(src/mcp/teamMemberServer.ts), 브리핑 문구를 그 툴이 내부적으로 자동으로
// 붙여준다 — SKILL.md는 더 이상 그 문구를 직접 담을 필요가 없다. 대신 검증 대상이 바뀌었다:
// "SKILL.md에 브리핑이 그대로 있는가"가 아니라 "teamMemberServer.ts가 launchMember(main.ts)와
// 같은 TEAM_MEMBER_BRIEFING을 실제로 재사용하는가"다.

const SKILL_PATH = path.join(__dirname, '..', 'resources', 'skills', 'team-lead', 'SKILL.md');
const skillText = fs.readFileSync(SKILL_PATH, 'utf-8');

const MCP_SERVER_PATH = path.join(__dirname, '..', 'src', 'mcp', 'teamMemberServer.ts');
const mcpServerSrc = fs.readFileSync(MCP_SERVER_PATH, 'utf-8');

test('SKILL.md가 팀원 생성 시 mcp__team-monitor__spawn_team_member 툴 사용을 명시한다', () => {
  assert.ok(skillText.includes('mcp__team-monitor__spawn_team_member'));
});

test('teamMemberServer.ts가 TEAM_MEMBER_BRIEFING을 launchMember와 같은 소스(lib/teamMemberBriefing)에서 가져다 쓴다', () => {
  // 문자열 자체를 이 파일에 복사해서 비교하지 않는다 — "같은 모듈을 import해서 쓰는지"만
  // 확인하면 충분하다(문구 내용은 lib/teamMemberBriefing.js 하나에만 존재해야 한다).
  assert.ok(mcpServerSrc.includes("from '../lib/teamMemberBriefing'"));
  assert.ok(mcpServerSrc.includes('TEAM_MEMBER_BRIEFING'));
});

test('teamMemberServer.ts는 TEAM_MEMBER_STANDBY_NOTE를 import/사용하지 않는다', () => {
  // TEAM_MEMBER_STANDBY_NOTE는 앱 UI가 "역할·지시를 먼저 등록해두고 나중에 시작 신호를
  // 보낸다"는 launchMember의 2단계 흐름 전용 문구다. spawn_team_member 툴은 팀장이 지금 당장
  // 실행할 실제 지시를 그대로 넘기는 구조라(옛 SKILL.md의 Bash 기반 흐름과 동일), 이 문구가
  // 섞여 들어가면 팀원이 실제 지시를 받고도 "준비 완료" 응답만 남긴 채 다음 메시지를 기다리며
  // 방치되는 사고로 이어진다 — 실수로 다시 import/사용되면 이 테스트가 바로 잡아낸다. 그 이름을
  // "왜 안 쓰는지" 설명하는 주석까지는 막지 않도록, 실제 import 구문과 템플릿 리터럴 사용만 본다.
  assert.ok(!mcpServerSrc.includes("import { TEAM_MEMBER_BRIEFING, TEAM_MEMBER_STANDBY_NOTE }"));
  assert.ok(!mcpServerSrc.includes('${TEAM_MEMBER_STANDBY_NOTE}'));
});
