const test = require('node:test');
const assert = require('node:assert');
const { hasNoLiveProcess } = require('../src/lib/ghostAgent');

test('목록에 없으면 정지할 프로세스가 없는 것으로 본다', () => {
  assert.strictEqual(hasNoLiveProcess(undefined), true);
  assert.strictEqual(hasNoLiveProcess(null), true);
});

test('pid와 status가 모두 없는 유령 항목(blocked 상태 파일만 남음)은 프로세스 없음', () => {
  assert.strictEqual(hasNoLiveProcess({ id: 'c728206b', state: 'blocked' }), true);
});

test('살아있는 세션은 막는다 — busy/idle은 물론 blocked(권한 대기)여도 pid와 status가 있다', () => {
  assert.strictEqual(hasNoLiveProcess({ id: 'a', pid: 1234, status: 'busy', state: 'working' }), false);
  assert.strictEqual(hasNoLiveProcess({ id: 'a', pid: 1234, status: 'waiting', state: 'blocked' }), false);
});

test('pid나 status 중 하나라도 있으면 살아있을 수 있으므로 막는다', () => {
  assert.strictEqual(hasNoLiveProcess({ id: 'a', pid: 1234 }), false);
  assert.strictEqual(hasNoLiveProcess({ id: 'a', status: 'idle' }), false);
});
