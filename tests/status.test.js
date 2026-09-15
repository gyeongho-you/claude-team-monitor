const test = require('node:test');
const assert = require('node:assert/strict');
const { getStatus } = require('../renderer/lib/status');

test('getStatus: status가 있으면 소문자로 바꿔서 반환한다', () => {
  assert.equal(getStatus({ status: 'Busy' }), 'busy');
});

test('getStatus: status가 없으면 state로 폴백한다', () => {
  assert.equal(getStatus({ state: 'Idle' }), 'idle');
});

test('getStatus: status와 state가 둘 다 있으면 status를 우선한다', () => {
  assert.equal(getStatus({ status: 'idle', state: 'busy' }), 'idle');
});

test("getStatus: state가 정확히 'done'이면 status가 뭐든 done을 우선한다", () => {
  assert.equal(getStatus({ status: 'idle', state: 'done' }), 'done');
});

test("getStatus: state가 정확히 'blocked'이면 status가 뭐든(waiting/busy/idle 등) blocked를 우선한다", () => {
  assert.equal(getStatus({ status: 'waiting', state: 'blocked' }), 'blocked');
  assert.equal(getStatus({ status: 'busy', state: 'blocked' }), 'blocked');
  assert.equal(getStatus({ status: 'idle', state: 'blocked' }), 'blocked');
});

test('getStatus: 둘 다 없으면 빈 문자열을 반환한다', () => {
  assert.equal(getStatus({}), '');
});

test('getStatus: row 자체가 없으면(null/undefined) 빈 문자열을 반환한다', () => {
  assert.equal(getStatus(null), '');
  assert.equal(getStatus(undefined), '');
});
