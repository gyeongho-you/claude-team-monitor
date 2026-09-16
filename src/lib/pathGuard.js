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

// 팀원/요청 등록 파일(~/.claude/claude-team-monitor/members|requests/<id>.json)은 이 앱이 아니라
// 외부(팀장) Claude 세션이 SKILL.md 안내를 따라 직접 파일로 써서 남긴다 — 파일 내용의 id 필드값을
// 검증 없이 그대로 delete/write 경로에 이어붙이면(예: cleanupStaleMembers의 unlinkSync), 그 값이
// "../../../어딘가"처럼 조작된 경우 이 디렉토리 밖의 임의 .json 파일을 사람 확인 없이 지울 수 있다
// (실측 리뷰로 발견됨). 짧은 세션 id·타임스탬프 기반 요청id 둘 다 원래 영문/숫자/하이픈/언더스코어
// 뿐이라, 그 범위를 벗어나면 무조건 거부한다.
function isSafeId(id) {
  return typeof id === 'string' && id.length > 0 && /^[A-Za-z0-9_-]+$/.test(id);
}

module.exports = { resolveWithinCwd, isSafeId };
