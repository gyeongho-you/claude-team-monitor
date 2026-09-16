const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveWithinCwd, isSafeId } = require('../src/lib/pathGuard');

const CWD = process.platform === 'win32' ? 'C:\\repo' : '/repo';

test('resolveWithinCwd: cwd 안쪽의 평범한 상대경로는 통과한다', () => {
  const result = resolveWithinCwd(CWD, 'src/main.ts');
  assert.equal(result, path.resolve(CWD, 'src/main.ts'));
});

test('resolveWithinCwd: cwd 자기 자신(빈 상대경로)도 통과한다', () => {
  const result = resolveWithinCwd(CWD, '.');
  assert.equal(result, path.resolve(CWD));
});

test('resolveWithinCwd: ../로 cwd를 벗어나려는 경로는 거부(null)한다', () => {
  const result = resolveWithinCwd(CWD, '../../../../etc/passwd');
  assert.equal(result, null);
});

test('resolveWithinCwd: 절대경로로 완전히 다른 곳을 가리켜도 거부한다', () => {
  const other = process.platform === 'win32' ? 'C:\\Windows\\System32\\config' : '/etc/passwd';
  const result = resolveWithinCwd(CWD, other);
  assert.equal(result, null);
});

test('resolveWithinCwd: cwd와 접두어만 같고 실제로는 다른 형제 디렉토리는 거부한다', () => {
  // "C:\repo-evil"이 "C:\repo"로 시작한다고 오판하면 안 된다(경로 구분자 경계 확인).
  const sibling = CWD + '-evil';
  const result = resolveWithinCwd(CWD, path.relative(CWD, sibling));
  assert.equal(result, null);
});

test('isSafeId: 짧은 세션 id/요청 id 형태(영문·숫자·하이픈·언더스코어)는 통과한다', () => {
  assert.equal(isSafeId('d1aa3cd0'), true);
  assert.equal(isSafeId('req-1234567890'), true);
  assert.equal(isSafeId('a_b-C9'), true);
});

test('isSafeId: 경로 탈출 문자가 섞이면 거부한다', () => {
  assert.equal(isSafeId('../../../etc/passwd'), false);
  assert.equal(isSafeId('a/b'), false);
  assert.equal(isSafeId('a\\b'), false);
  assert.equal(isSafeId('..'), false);
});

test('isSafeId: 빈 문자열/문자열이 아닌 값은 거부한다', () => {
  assert.equal(isSafeId(''), false);
  assert.equal(isSafeId(undefined), false);
  assert.equal(isSafeId(null), false);
  assert.equal(isSafeId(123), false);
});
