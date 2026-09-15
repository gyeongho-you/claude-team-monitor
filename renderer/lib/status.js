// 세션 하나(SessionRow/AgentEntry)의 상태 문자열을 하나의 규칙으로 뽑아낸다.
// main.ts(Node, import)와 renderer.js(브라우저, <script> 전역)가 똑같은 로직을 쓰도록
// 이 파일 하나를 두 군데서 그대로 공유한다 — CommonJS 환경(require)이면 module.exports로
// 내보내고, 브라우저(<script src="lib/status.js">)면 전역 함수 getStatus로 노출한다.
//
// claude agents --json은 status/state 두 필드 중 하나만 채워져 있을 수 있어(방어적으로 둘 다
// 본다) status를 우선하고 state로 폴백한다. 단, state가 정확히 'done'이면 status가 오래된 값
// (예: 'idle')으로 남아있어도 완료로 우선 취급한다 — 세션이 끝난 직후 status가 못 따라오고
// state만 먼저 'done'으로 바뀌는 사례가 실측으로 있었다.
function getStatus(row) {
  if (!row) return '';
  if (row.state === 'done') return 'done';
  return (row.status || row.state || '').toLowerCase();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStatus };
} else {
  (typeof window !== 'undefined' ? window : globalThis).getStatus = getStatus;
}
