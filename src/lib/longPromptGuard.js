// claude 프로세스는 shell:false로 spawn하므로 인자는 셸을 거치지 않고 Windows의 CreateProcessW
// 규칙을 그대로 따르는데, 이 전체 명령줄(프로그램명+모든 인자 합)엔 32767자라는 OS 한도가 있다.
// 지시문(instruction)은 사용자/팀장이 얼마든지 길게 쓸 수 있는 값이라, 그 길이를 그대로 argv 한
// 자리에 실으면 이 한도를 넘겨 spawn 자체가 ENAMETOOLONG으로 실패한다(실사용 확인). --mcp-config
// JSON, 여러 플래그, 이스케이프 오버헤드까지 감안해 훨씬 낮은 문턱에서 미리 파일로 돌린다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROMPTS_DIR } = require('./teamMemberPaths');

const MAX_INLINE_PROMPT_LENGTH = 4000;

/**
 * prompt가 짧으면 그대로 돌려주고, 길면 파일에 써두고 그 파일을 읽으라는 짧은 지시로 바꿔 돌려준다.
 * 호출부(runClaudeBg에 넘길 인자 조립부)는 이 함수가 돌려준 값을 그대로 argv에 실으면 된다 — 어느
 * 경로든 길이 걱정 없이 항상 안전하다.
 * @param {string} prompt
 * @returns {string}
 */
function resolveLongPrompt(prompt) {
  if (prompt.length <= MAX_INLINE_PROMPT_LENGTH) return prompt;
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  const filePath = path.join(PROMPTS_DIR, `${crypto.randomUUID()}.md`);
  fs.writeFileSync(filePath, prompt, 'utf-8');
  return (
    `지시문이 너무 길어 Claude Team Monitor가 대신 파일로 저장했다. 이 파일을 읽고, 그 안의 내용 ` +
    `전체를 지시로 그대로 수행해라: "${filePath}"\n\n(다 읽었으면 이 파일은 지워도 된다.)`
  );
}

module.exports = { resolveLongPrompt, MAX_INLINE_PROMPT_LENGTH };
