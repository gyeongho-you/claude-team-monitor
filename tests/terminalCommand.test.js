const test = require('node:test');
const assert = require('node:assert/strict');
const { shellSingleQuote, escapeAppleScriptString } = require('../src/lib/terminalCommand');

test('shellSingleQuote: 평범한 경로는 그냥 감싼다', () => {
  assert.equal(shellSingleQuote('/Users/pc/project'), "'/Users/pc/project'");
});

test('shellSingleQuote: 공백이 있는 경로도 안전하게 감싼다', () => {
  assert.equal(shellSingleQuote('/Users/pc/My Project'), "'/Users/pc/My Project'");
});

test('shellSingleQuote: 경로 안의 싱글쿼트를 이스케이프한다', () => {
  assert.equal(shellSingleQuote("/Users/pc/it's a dir"), "'/Users/pc/it'\\''s a dir'");
});

test('escapeAppleScriptString: 쌍따옴표를 이스케이프한다', () => {
  assert.equal(escapeAppleScriptString('echo "hi"'), 'echo \\"hi\\"');
});

test('escapeAppleScriptString: 백슬래시를 이스케이프한다(쌍따옴표보다 먼저 처리돼야 함)', () => {
  assert.equal(escapeAppleScriptString('a\\b'), 'a\\\\b');
});

test('escapeAppleScriptString: shellSingleQuote가 이미 만든 백슬래시-이스케이프 싱글쿼트도 다시 안전하게 감싼다', () => {
  // 실제 조합 시나리오: cd '/it\'s a dir' && claude 같은 문자열을 AppleScript 리터럴에 넣을 때
  // 백슬래시가 먼저 escapeAppleScriptString 스스로 이중으로 이스케이프돼야 한다.
  const quoted = shellSingleQuote("/it's a dir");
  const escaped = escapeAppleScriptString(quoted);
  assert.equal(escaped, "'/it'\\\\''s a dir'");
});
