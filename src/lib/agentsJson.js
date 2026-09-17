const { exec } = require('child_process');

// claude --bg/claude stop처럼 spawn으로 띄우는 호출은 전부 setTimeout+child.kill() 타임아웃 가드가
// 붙어있는데(RUN_CLAUDE_TIMEOUT_MS/STOP_SESSION_TIMEOUT_MS), 정작 가장 자주 불리는(3초 폴링마다 +
// 거의 모든 팀장 조작 안에서) `claude agents --json`에는 타임아웃이 전혀 없었다 — CLI가 어떤
// 이유로든 응답 없이 멈추면 이 호출 하나가 폴링 체인 전체와 채팅 전송/재시작/작업종료까지 전부
// 영구히 막아버릴 수 있었다(팀원 버그헌팅에서 지적, exec에 timeout 옵션이 없었던 게 원인).
// main.ts(fetchAgents/fetchAgentsStrict)와 teamMemberServer.ts(findSessionIdByShortId) 양쪽이
// 각자 이 호출을 따로 구현하면 이런 방어를 고칠 때 한쪽만 고치고 잊어버리는 드리프트가 생기기
// 쉬워서, 공용 함수로 뽑았다(claudeBgOutput.js와 같은 이유).
const AGENTS_JSON_TIMEOUT_MS = 10000;

/**
 * `claude agents --json`을 실행해 파싱한 결과를 돌려준다. exec 자체가 타임아웃/실패하거나 stdout이
 * JSON으로 파싱 안 되면 reject한다 — "실패"와 "빈 목록"을 구분해야 하는 호출부(stopSession의 생존
 * 확인 등)를 위해 fail-open으로 뭉개지 않는다. "빈 목록으로 봐도 되는" 호출부는 .catch(() => [])로
 * 감싸서 쓰면 된다.
 * @returns {Promise<Array<{id?: string, sessionId?: string, [key: string]: unknown}>>}
 */
function execAgentsJson() {
  return new Promise((resolve, reject) => {
    exec(
      'claude agents --json',
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024, timeout: AGENTS_JSON_TIMEOUT_MS },
      (err, stdout) => {
        if (err) { reject(err); return; }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

module.exports = { execAgentsJson, AGENTS_JSON_TIMEOUT_MS };
