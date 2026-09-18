const path = require('path');
const os = require('os');

// main.ts와 팀원 생성 MCP 서버(src/mcp/teamMemberServer.ts) 둘 다 정확히 같은 경로를 봐야 한다 —
// 한쪽만 계산식을 바꾸면 서로 다른 곳을 보게 돼서 "분명 등록했는데 앱엔 안 보인다" 같은 사고로
// 이어지기 쉽다. Electron의 app.getPath('userData')에 의존하지 않는(순수 Node) 경로만 여기 둔다 —
// leads.json 등 userData 밑 경로는 앱 실행마다 다를 수 있어 main.ts가 직접 넘겨줘야 한다(MCP
// 서버는 TEAM_MONITOR_LEADS_PATH 환경변수로 전달받는다).
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const MEMBERS_DIR = path.join(CLAUDE_HOME, 'claude-team-monitor', 'members');
// longPromptGuard.js가 argv 길이 한도를 넘는 지시문을 파일로 대신 써두는 곳 — 같은 이유(main.ts와
// MCP 서버가 정확히 같은 경로를 봐야 함)로 여기 같이 둔다.
const PROMPTS_DIR = path.join(CLAUDE_HOME, 'claude-team-monitor', 'prompts');

module.exports = { CLAUDE_HOME, MEMBERS_DIR, PROMPTS_DIR };
