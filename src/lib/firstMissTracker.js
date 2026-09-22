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
    // graceMs<=0은 "유예 없이 즉시 만료"를 의도한 호출(앱 시작 직후 첫 폴링, endLeadWork의 확정
    // 종료 등)인데, 이 id를 처음 보는 순간이면 항상 'first-miss'만 반환해서 graceMs를 사실상
    // 무시하고 있었다 — 다음 폴링부터는 hasCompletedFirstPoll이 이미 true라 원래 유예
    // (LEAD_OFFLINE_GRACE_MS, 3분 이상)가 그대로 적용돼, "즉시 만료"를 의도한 호출이 전체 유예를
    // 그대로 물게 된다(Tauri 포팅본의 실측 UI 테스트로 재현·확인 — 죽은 팀장이 앱 재시작 후
    // ~217초 동안 어느 탭에도 안 보임. Rust로 옮겨진 동일 로직에서 먼저 발견됐지만 이 원본 함수의
    // 버그다).
    return graceMs <= 0 ? 'expired' : 'first-miss';
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
