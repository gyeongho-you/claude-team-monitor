const test = require('node:test');
const assert = require('node:assert/strict');
const { extractBackgroundedId, extractStartedCopyId } = require('../src/lib/claudeBgOutput');

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

// extractStartedCopyId는 CLI가 stop→resume 사이 레이스로 원본 대신 복사본을 만들었을 때 그 사실을
// 잡아내는 유일한 문자열 신호다(resumeOnce의 짧은 id 비교가 두 번째 독립 방어선) — extractBackgroundedId가
// 예전에 ANSI 코드 때문에 조용히 매칭 실패했던 전례가 있는 만큼, 같은 종류의 회귀를 여기서도 잡아둔다.
test('extractStartedCopyId: "started a copy as <id>" 문구에서 짧은 id를 뽑는다', () => {
  assert.equal(
    extractStartedCopyId('note: session abcd1234 is already running in the background, so this started a copy as a7471441'),
    'a7471441'
  );
});

test('extractStartedCopyId: id 뒤에 문장이 더 이어져도 인식한다', () => {
  assert.equal(
    extractStartedCopyId('... started a copy as a7471441. Without flags, the same command continues abcd1234 itself.'),
    'a7471441'
  );
});

test('extractStartedCopyId: 대소문자 구분 없이 찾는다', () => {
  assert.equal(extractStartedCopyId('Started a Copy as a7471441'), 'a7471441');
});

test('extractStartedCopyId: id에 ANSI 색상 코드가 섞여 있어도 뽑아낸다', () => {
  assert.equal(extractStartedCopyId('started a copy as \x1b[36ma7471441\x1b[39m'), 'a7471441');
});

test('extractStartedCopyId: 마커가 없으면(정상 resume) null', () => {
  assert.equal(extractStartedCopyId('backgrounded · a7471441'), null);
  assert.equal(extractStartedCopyId(''), null);
});

test('extractStartedCopyId: 문자열이 아닌 입력은 null', () => {
  assert.equal(extractStartedCopyId(undefined), null);
  assert.equal(extractStartedCopyId(null), null);
});
