// macOS에서 새 터미널 창(Terminal.app)에 명령을 넘길 때 쓰는 문자열 이스케이프 두 단계 —
// main.ts의 openTerminalRunning이 조립하는 문자열이 두 겹으로 감싸여 있어서 각각 따로 뽑았다.
// 1) shellSingleQuote: 디렉토리 경로 같은 값을 쉘 명령 안에 안전하게 넣는다.
// 2) escapeAppleScriptString: 그 쉘 명령 전체를 AppleScript 문자열 리터럴("...") 안에 넣는다.
// 순서를 안 지키거나 하나만 하면(예: AppleScript만 이스케이프하고 쉘 싱글쿼트를 빼먹으면) 공백이나
// 특수문자가 든 디렉토리 경로에서 조용히 깨지거나, 최악의 경우 의도 안 한 명령이 실행될 수 있다.

/** @param {string} s @returns {string} */
function shellSingleQuote(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** @param {string} s @returns {string} */
function escapeAppleScriptString(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

module.exports = { shellSingleQuote, escapeAppleScriptString };
