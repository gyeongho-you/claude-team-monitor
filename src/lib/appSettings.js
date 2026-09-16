// 사용자 설정값 검증/정규화 로직만 모아둔다 — 파일 I/O 없이 순수 함수라 단위 테스트하기 쉽다.
// main.ts는 이 값을 읽고 쓰는 쪽(loadSettings/saveSettings/normalizeMemberModel 호출부)만 맡는다.

// 'default'는 이 앱이 모델을 따로 지정하지 않고 claude CLI 기본값을 그대로 쓴다는 뜻.
const MEMBER_MODEL_OPTIONS = ['default', 'haiku', 'sonnet', 'opus'];

/**
 * 분 단위 숫자 하나를 안전 범위로 정리한다 — 파일이 손상됐거나(수동 편집 등) 렌더러가 이상한
 * 값을 보내도, 정체 감시가 0분(과도한 Haiku 호출)이나 음수 같은 값으로 오동작하지 않게 막는다.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampMinutes(value, fallback, min, max) {
  // Number(null) === 0, Number('') === 0, Number('   ') === 0이라 아래 변환에 그대로 넘기면
  // "값이 없다"는 뜻인 null/빈 문자열이 조용히 0(→min으로 클램프)으로 취급된다 — 이런 값들은
  // 여기서 먼저 걸러 fallback으로 보낸다.
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 렌더러에서 넘어온 값이 화이트리스트 밖이면(구버전 템플릿·조작된 값 등) 'default'로 취급한다.
 * @param {unknown} model
 * @returns {string}
 */
function normalizeMemberModel(model) {
  return MEMBER_MODEL_OPTIONS.includes(model) ? model : 'default';
}

module.exports = { MEMBER_MODEL_OPTIONS, clampMinutes, normalizeMemberModel };
