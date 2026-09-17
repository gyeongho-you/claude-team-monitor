const test = require('node:test');
const assert = require('node:assert/strict');
const { extractBackgroundedId } = require('../src/lib/claudeBgOutput');

test('extractBackgroundedId: 가운뎃점 구분자(실측 CLI 출력)에서 짧은 id를 뽑는다', () => {
  assert.equal(extractBackgroundedId('backgrounded · a1b2c3d4\n다음 줄...'), 'a1b2c3d4');
});

test('extractBackgroundedId: 콜론 구분자도 인식한다', () => {
  assert.equal(extractBackgroundedId('backgrounded: a1b2c3d4'), 'a1b2c3d4');
});

test('extractBackgroundedId: 구분자 앞뒤 공백이 있어도 인식한다', () => {
  assert.equal(extractBackgroundedId('backgrounded   ·   a1b2c3d4'), 'a1b2c3d4');
});

test('extractBackgroundedId: 대소문자 구분 없이 backgrounded를 찾는다', () => {
  assert.equal(extractBackgroundedId('Backgrounded · a1b2c3d4'), 'a1b2c3d4');
});

test('extractBackgroundedId: id에 ANSI 색상 코드가 섞여 있어도 뽑아낸다(MCP 서버 자식 프로세스로 실행 시 실측)', () => {
  assert.equal(extractBackgroundedId('backgrounded · \x1b[36ma7471441\x1b[39m\n  claude agents ...'), 'a7471441');
});

test('extractBackgroundedId: 마커가 없으면 null', () => {
  assert.equal(extractBackgroundedId('claude: command not found'), null);
  assert.equal(extractBackgroundedId(''), null);
});

test('extractBackgroundedId: 문자열이 아닌 입력은 null', () => {
  assert.equal(extractBackgroundedId(undefined), null);
  assert.equal(extractBackgroundedId(null), null);
});
