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
    // graceMs<=0은 "유예 없이 즉시 만료"를 의도한 호출(앱 시작 직후 첫 폴링, endLeadWork의 확정
    // 종료 등)인데, 이 id를 처음 보는 순간이면 항상 'first-miss'만 반환해서 graceMs를 사실상
    // 무시하고 있었다(Tauri 포팅본의 실측 UI 테스트로 재현·확인 — 죽은 팀장이 앱 재시작 후 ~217초
    // 동안 어느 탭에도 안 보임).
    //
    // 1차 수정(graceMs<=0이면 'expired' 반환)만으로는 부족했다 — firstMissAt을 now로 기록해버리면,
    // 바로 다음 폴링부터 hasCompletedFirstPoll이 true가 돼 graceMs가 원래 유예
    // (LEAD_OFFLINE_GRACE_MS, 3분 이상)로 늘어나는데, 그 큰 유예를 "방금 기록한 now" 기준으로
    // 다시 재는 바람에 now-firstMissAt(수 초)<graceMs가 성립해 'within-grace'로 되돌아간다 —
    // endLeadWork(leadFirstMissAt.set(id,0))와 정확히 같은 이유로, 여기서도 now 대신 0(아주 오래
    // 전)을 기록해야 이후 어떤 graceMs가 오더라도 다시 유예 안으로 들어가지 않는다(Tauri 재검증
    // UI 테스트에서 첫 폴링엔 정상 해소됐다가 잠시 후 다시 공백이 재현되는 것으로 확인).
    map.set(id, graceMs <= 0 ? 0 : now);
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
