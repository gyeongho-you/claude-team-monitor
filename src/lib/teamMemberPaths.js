const path = require('path');
const os = require('os');

// main.ts와 팀원 생성 MCP 서버(src/mcp/teamMemberServer.ts) 둘 다 정확히 같은 경로를 봐야 한다 —
// 한쪽만 계산식을 바꾸면 서로 다른 곳을 보게 돼서 "분명 등록했는데 앱엔 안 보인다" 같은 사고로
// 이어지기 쉽다. Electron의 app.getPath('userData')에 의존하지 않는(순수 Node) 경로만 여기 둔다 —
// 그래야 이 앱(Electron/Tauri) 없이 터미널에서 스킬+MCP만으로 팀장을 띄워도 MCP 서버가 스스로
// 이 경로를 계산할 수 있다(환경변수로 전달받을 필요가 없다).
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const MEMBERS_DIR = path.join(CLAUDE_HOME, 'claude-team-monitor', 'members');
// longPromptGuard.js가 argv 길이 한도를 넘는 지시문을 파일로 대신 써두는 곳 — 같은 이유(main.ts와
// MCP 서버가 정확히 같은 경로를 봐야 함)로 여기 같이 둔다.
const PROMPTS_DIR = path.join(CLAUDE_HOME, 'claude-team-monitor', 'prompts');
// 예전엔 app.getPath('userData')(%APPDATA%\claude-team-monitor\leads.json) 밑에 있었다 — 그러다
// 보니 이 경로를 Electron 앱만 알 수 있어서, MCP 서버는 --mcp-config env로 매번 전달받아야 했다
// (TEAM_MONITOR_LEADS_PATH). 앱 없이 터미널+스킬+MCP만으로 팀장을 등록/운영할 수 있게 하려면 MCP
// 서버가 이 경로를 스스로 계산할 수 있어야 해서, MEMBERS_DIR/PROMPTS_DIR과 같은 컨벤션으로 옮겼다
// (기존 사용자의 구 경로 leads.json은 main.ts가 최초 실행 시 여기로 1회 이전한다).
const LEADS_PATH = path.join(CLAUDE_HOME, 'claude-team-monitor', 'leads.json');

module.exports = { CLAUDE_HOME, MEMBERS_DIR, PROMPTS_DIR, LEADS_PATH };
