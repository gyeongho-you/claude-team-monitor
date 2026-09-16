const test = require('node:test');
const assert = require('node:assert/strict');
const { MEMBER_MODEL_OPTIONS, clampMinutes, normalizeMemberModel } = require('../src/lib/appSettings');

test('clampMinutes: 범위 안 값은 그대로(반올림만) 통과시킨다', () => {
  assert.equal(clampMinutes(15, 10, 1, 60), 15);
  assert.equal(clampMinutes(15.6, 10, 1, 60), 16);
});

test('clampMinutes: 최솟값보다 작으면 최솟값으로 올린다', () => {
  assert.equal(clampMinutes(0, 10, 1, 60), 1);
  assert.equal(clampMinutes(-5, 10, 1, 60), 1);
});

test('clampMinutes: 최댓값보다 크면 최댓값으로 내린다', () => {
  assert.equal(clampMinutes(9999, 10, 1, 1440), 1440);
});

test('clampMinutes: 숫자가 아니거나 손상된 값이면 fallback을 쓴다(fail-safe)', () => {
  assert.equal(clampMinutes('abc', 10, 1, 60), 10);
  assert.equal(clampMinutes(undefined, 10, 1, 60), 10);
  assert.equal(clampMinutes(NaN, 10, 1, 60), 10);
  assert.equal(clampMinutes(null, 10, 1, 60), 10);
});

test('clampMinutes: 숫자로 변환 가능한 문자열은 변환해서 쓴다', () => {
  assert.equal(clampMinutes('20', 10, 1, 60), 20);
});

test('normalizeMemberModel: 화이트리스트 안 값은 그대로 반환', () => {
  for (const m of MEMBER_MODEL_OPTIONS) {
    assert.equal(normalizeMemberModel(m), m);
  }
});

test('normalizeMemberModel: 화이트리스트 밖 값은 default로 취급(fail-safe)', () => {
  assert.equal(normalizeMemberModel('gpt-4'), 'default');
  assert.equal(normalizeMemberModel(''), 'default');
  assert.equal(normalizeMemberModel(undefined), 'default');
  assert.equal(normalizeMemberModel(null), 'default');
});
