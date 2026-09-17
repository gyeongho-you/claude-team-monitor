// claude --bg는 시작하면서 "backgrounded · <id>"를 stdout에 찍고 곧 종료된다(실제 세션은 별도
// 백그라운드 프로세스로 계속 돈다). 이 파싱 규칙을 main.ts(runClaudeBg)와 팀원 생성 MCP 서버
// (src/mcp/teamMemberServer.ts) 양쪽이 똑같이 써야 해서 — 둘이 따로 구현하면 CLI 출력 형식이
// 바뀔 때 한쪽만 고치고 잊어버리는 드리프트가 생기기 쉽다 — 공용 순수 함수로 뽑았다.

/**
 * @param {string} stdout - claude --bg 프로세스의 stdout 원문
 * @returns {string | null} 짧은 id, 마커를 못 찾으면 null
 */
function extractBackgroundedId(stdout) {
  if (typeof stdout !== 'string') return null;
  // claude가 실행 환경에 따라 id에 ANSI 색상 코드를 입혀서 찍을 때가 있다(실측 확인: MCP 서버
  // 자식 프로세스로 spawn했을 때 "backgrounded · \x1b[36ma7471441\x1b[39m"처럼 나옴 — Electron
  // main 프로세스에서 spawn할 때는 색이 안 붙어서 그동안은 못 봤다). \s*만으로는 이 이스케이프
  // 시퀀스를 건너뛸 수 없어 마커를 못 찾고 조용히 null이 되던 버그라, 매칭 전에 ANSI 코드부터
  // 걷어낸다.
  const clean = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  const m = clean.match(/backgrounded\s*[·:]\s*([a-f0-9]+)/i);
  return m ? m[1] : null;
}

module.exports = { extractBackgroundedId };
