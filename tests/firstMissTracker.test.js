const test = require('node:test');
const assert = require('node:assert/strict');
const { trackFirstMiss, pruneMissingKeys } = require('../src/lib/firstMissTracker');

test('trackFirstMiss: 살아있으면 present를 반환하고 기록을 지운다', () => {
  const map = new Map([['a', 1000]]);
  const result = trackFirstMiss(map, true, 'a', 5000, 8000);
  assert.equal(result, 'present');
  assert.equal(map.has('a'), false);
});

test('trackFirstMiss: 처음 놓치면 first-miss를 반환하고 지금 시각을 기록한다', () => {
  const map = new Map();
  const result = trackFirstMiss(map, false, 'a', 1000, 8000);
  assert.equal(result, 'first-miss');
  assert.equal(map.get('a'), 1000);
});

test('trackFirstMiss: 유예시간 안이면 within-grace이고 기록은 그대로 유지된다', () => {
  const map = new Map([['a', 1000]]);
  const result = trackFirstMiss(map, false, 'a', 1000 + 7999, 8000);
  assert.equal(result, 'within-grace');
  assert.equal(map.get('a'), 1000); // 갱신되지 않아야 한다(처음 놓친 시각을 그대로 유지)
});

test('trackFirstMiss: 유예시간을 넘기면 expired이고, 기록은 호출부가 지우기 전까지 남아있다', () => {
  const map = new Map([['a', 1000]]);
  const result = trackFirstMiss(map, false, 'a', 1000 + 8000, 8000);
  assert.equal(result, 'expired');
  assert.equal(map.get('a'), 1000); // trackFirstMiss 자신은 지우지 않는다 — 호출부가 정책을 정한다
});

test('trackFirstMiss: expired 이후에도 계속 없으면(호출부가 안 지웠을 때) 계속 expired를 반환한다', () => {
  // 팀장 오프라인 판정처럼, 만료돼도 기록을 지우지 않는 호출부의 시나리오 — 다시 잡히기 전까지
  // 매 폴링 계속 offline으로 판정돼야 한다.
  const map = new Map([['a', 1000]]);
  assert.equal(trackFirstMiss(map, false, 'a', 20000, 8000), 'expired');
  assert.equal(trackFirstMiss(map, false, 'a', 30000, 8000), 'expired');
});

test('trackFirstMiss: 다시 잡히면(present) 처음부터 다시 유예가 시작된다', () => {
  const map = new Map([['a', 1000]]);
  assert.equal(trackFirstMiss(map, false, 'a', 20000, 8000), 'expired');
  assert.equal(trackFirstMiss(map, true, 'a', 21000, 8000), 'present');
  assert.equal(map.has('a'), false);
  // 다시 놓치면 새 시각으로 처음부터 기록된다
  assert.equal(trackFirstMiss(map, false, 'a', 22000, 8000), 'first-miss');
  assert.equal(map.get('a'), 22000);
});

test('trackFirstMiss: graceMs<=0이면 처음 놓친 순간(map에 기록이 아직 없을 때)에도 곧바로 expired — 콜드 스타트 유예 우회(computeOfflineLeads)가 기대는 동작', () => {
  // 앱을 새로 켜면 leadFirstMissAt/lastKnownLiveLeadRow가 메모리라 전부 비어서, 이미 죽어있던
  // 팀장도 정상 유예시간(LEAD_OFFLINE_GRACE_MS, 3분 이상)만큼 화면 어디에도 안 보이는 공백이
  // 생겼다(실사용 재현, Tauri 포팅본의 실측 UI 테스트로 재확인 — 앱 재시작 후 ~217초 공백).
  //
  // 예전엔 이 함수가 "처음 보는 id"면 graceMs 값과 무관하게 항상 'first-miss'만 반환했다 —
  // computeOfflineLeads가 앱 시작 직후 첫 폴링에만 graceMs=0을 줘도, 바로 그 첫 폴링이 이 id를
  // 처음 보는 순간이라 grace 판정 자체를 아직 못 타보고 무조건 'first-miss'가 나왔고, 그 다음
  // 폴링부터는 hasCompletedFirstPoll이 true라 원래 유예(LEAD_OFFLINE_GRACE_MS)로 돌아가서
  // "즉시 만료"가 사실상 죽은 코드였다(이 테스트가 예전엔 첫 호출을 'first-miss'로 기대하고
  // 두 번째 호출에도 graceMs=0을 또 줘서 통과했는데, 실제 호출부는 두 번째 폴링부터 graceMs가
  // 이미 전체 유예로 바뀌어 있어서 이 테스트가 실제 동작을 반영하지 못하고 있었다).
  //
  // 지금은 graceMs<=0이면 처음 보는 순간에도(map에 기록이 없어도) 바로 expired를 반환한다.
  const map = new Map();
  assert.equal(trackFirstMiss(map, false, 'a', 1000, 0), 'expired');
  assert.equal(map.get('a'), 0); // now가 아니라 0으로 기록돼야 한다(아래 테스트가 그 이유)
  assert.equal(trackFirstMiss(map, false, 'a', 1001, 0), 'expired');
});

test('trackFirstMiss: graceMs=0으로 만료된 뒤, 다음 폴링에서 graceMs가 원래 유예로 늘어나도 계속 expired여야 한다(회귀 재현)', () => {
  // 실측 UI 재검증(2026-09-23)으로 발견된 회귀: 위 수정이 firstMissAt을 now로 기록했더니,
  // hasCompletedFirstPoll이 true로 바뀌어 graceMs가 LEAD_OFFLINE_GRACE_MS(3분 이상)로 늘어나는
  // 바로 다음 폴링에서, "방금 기록한 now" 기준으로 그 큰 유예를 다시 재는 바람에 within-grace로
  // 되돌아갔다 — 앱 재시작 후 화면에 잠깐 보였다가 다시 사라지는 것으로 재현됨(Tauri 재검증
  // UI 테스트에서 t=97~220초 구간에 재발).
  // now는 실제 운영 환경처럼 Date.now() 규모(현실적인 epoch ms)여야 한다 — firstMissAt을 0으로
  // 기록하는 이 수정은 "now가 충분히 커서 now-0이 어떤 grace_ms보다도 크다"는 전제에 기대기
  // 때문에, 테스트에서도 작은 상대값(예: 1000)을 쓰면 이 전제가 깨져 오히려 회귀를 못 잡는다.
  const base = 1_790_000_000_000;
  const map = new Map();
  assert.equal(trackFirstMiss(map, false, 'a', base, 0), 'expired'); // 앱 재시작 직후 첫 폴링
  assert.equal(trackFirstMiss(map, false, 'a', base + 4_000, 214_000), 'expired'); // 다음 폴링부터 원래 유예로 복귀
  assert.equal(trackFirstMiss(map, false, 'a', base + 300_000, 214_000), 'expired');
});

test('pruneMissingKeys: currentIds에 없는 키만 지운다', () => {
  const map = new Map([['a', 1], ['b', 2], ['c', 3]]);
  pruneMissingKeys(map, new Set(['a', 'c']));
  assert.deepEqual([...map.keys()].sort(), ['a', 'c']);
});

test('pruneMissingKeys: 전부 currentIds에 있으면 아무것도 안 지운다', () => {
  const map = new Map([['a', 1], ['b', 2]]);
  pruneMissingKeys(map, new Set(['a', 'b']));
  assert.deepEqual([...map.keys()].sort(), ['a', 'b']);
});
