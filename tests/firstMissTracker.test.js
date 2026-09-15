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
