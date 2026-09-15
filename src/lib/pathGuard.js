const path = require('path');

// file 인자에 상대경로 탈출(예: "../../../../etc/passwd")이 섞여 있으면 path.join(cwd, file)이
// cwd 밖의 임의 파일을 가리킬 수 있다 — 실제로 join한 절대경로가 cwd 하위인지 확인해서, 벗어나면
// null을 돌려줘 호출부가 거부하게 한다.
//
// @param {string} cwd
// @param {string} file
// @returns {string | null} cwd 하위의 절대경로, 벗어나면 null
function resolveWithinCwd(cwd, file) {
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(cwd, file);
  if (resolvedFile !== resolvedCwd && !resolvedFile.startsWith(resolvedCwd + path.sep)) return null;
  return resolvedFile;
}

module.exports = { resolveWithinCwd };
