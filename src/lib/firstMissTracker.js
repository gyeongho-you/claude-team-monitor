// 팀원 정리(memberFirstMissAt)와 팀장 오프라인 판정(leadFirstMissAt)이 겪는 TOCTOU 유예 로직이
// 완전히 동일해서(살아있으면 기록 삭제 / 처음 놓치면 기록만 / 유예시간 안이면 대기 / 유예시간
// 지나면 만료) 하나의 순수 함수로 뽑았다. 파일 I/O 없이 Map만 다루므로 단위 테스트하기 쉽다.
//
// 반환값 중 'expired' 처리 후 map 항목을 지울지 말지는 호출부가 정한다 — 팀장 오프라인 판정은
// 만료돼도 기록을 남겨둬야 계속 오프라인으로 표시된다(안 지우면 매 폴링 다시 'expired'가 나옴).
// 반대로 팀원 정리는 만료되면 등록 파일 자체를 지우므로, 호출부가 즉시 map에서도 지운다(main.ts 참고).
//
// @param {Map<string, number>} map - id -> 처음 못 잡힌 시각(ms)
// @param {boolean} isPresent - 이번 스냅샷에 이 id가 살아있는 것으로 잡혔는지
// @param {string} id
// @param {number} now
// @param {number} graceMs
// @returns {'present' | 'first-miss' | 'within-grace' | 'expired'}
function trackFirstMiss(map, isPresent, id, now, graceMs) {
  if (isPresent) {
    map.delete(id);
    return 'present';
  }
  const firstMissAt = map.get(id);
  if (firstMissAt === undefined) {
    map.set(id, now);
    return 'first-miss';
  }
  if (now - firstMissAt < graceMs) {
    return 'within-grace';
  }
  return 'expired';
}

// map에 남아있는 키 중, 지금 더 이상 존재하지 않는(currentIds에 없는) 것을 정리한다 — 등록
// 자체가 다른 경로(수동 삭제 등)로 이미 사라진 id의 기록이 무한정 쌓이지 않게 하는 방어.
//
// @param {Map<string, number>} map
// @param {Set<string>} currentIds
function pruneMissingKeys(map, currentIds) {
  for (const key of map.keys()) {
    if (!currentIds.has(key)) map.delete(key);
  }
}

module.exports = { trackFirstMiss, pruneMissingKeys };
