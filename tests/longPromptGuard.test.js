const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { resolveLongPrompt, MAX_INLINE_PROMPT_LENGTH } = require('../src/lib/longPromptGuard');

test('resolveLongPrompt: 짧은 지시문은 그대로 돌려준다', () => {
  const prompt = '짧은 지시문';
  assert.equal(resolveLongPrompt(prompt), prompt);
});

test('resolveLongPrompt: 한도와 정확히 같은 길이는 그대로 돌려준다(경계값)', () => {
  const prompt = 'a'.repeat(MAX_INLINE_PROMPT_LENGTH);
  assert.equal(resolveLongPrompt(prompt), prompt);
});

test('resolveLongPrompt: 한도를 넘으면 파일로 써두고 짧은 안내문으로 바꿔 돌려준다', () => {
  const original = 'a'.repeat(MAX_INLINE_PROMPT_LENGTH + 1);
  const result = resolveLongPrompt(original);
  assert.ok(result.length < MAX_INLINE_PROMPT_LENGTH);

  const match = result.match(/"([^"]+\.md)"/);
  assert.ok(match, '결과 안내문에 파일 경로가 쌍따옴표로 들어있어야 한다');
  const filePath = match[1];
  assert.equal(fs.readFileSync(filePath, 'utf-8'), original);
  fs.unlinkSync(filePath);
});
