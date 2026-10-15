const test = require('node:test');
const assert = require('node:assert');
const { isChatItemDelivered, LONG_PROMPT_MAX_INLINE_LENGTH, LONG_PROMPT_REDIRECT_MARKER } = require('../renderer/lib/chatDelivery');
const { resolveLongPrompt } = require('../src/lib/longPromptGuard');

test('짧은 메시지는 원문이 정확히 일치할 때만 전달로 본다', () => {
  assert.strictEqual(isChatItemDelivered({ message: '안녕' }, [{ prompt: '안녕' }]), true);
  assert.strictEqual(isChatItemDelivered({ message: '안녕' }, [{ prompt: '안녕하세요' }]), false);
  assert.strictEqual(isChatItemDelivered({ message: '안녕' }, []), false);
});

test('묶음 배달(matchBySubstring)은 원문 포함이면 전달로 본다', () => {
  assert.strictEqual(isChatItemDelivered({ message: '그래', matchBySubstring: true }, [{ prompt: '1) 그래\n2) 커밋' }]), true);
});

test('긴 메시지는 파일 안내문으로 바뀌어 기록에 남아도 전달로 본다', () => {
  const message = '가'.repeat(LONG_PROMPT_MAX_INLINE_LENGTH + 1);
  const redirected = resolveLongPrompt(message); // 실제 안내문 문구와 마커가 계속 일치하는지도 함께 검증한다
  assert.ok(redirected.includes(LONG_PROMPT_REDIRECT_MARKER));
  assert.strictEqual(isChatItemDelivered({ message }, [{ prompt: redirected }]), true);
});

test('긴 메시지여도 안내문이 아직 안 나타났으면 전달 안 된 것이다', () => {
  const message = '가'.repeat(LONG_PROMPT_MAX_INLINE_LENGTH + 1);
  assert.strictEqual(isChatItemDelivered({ message }, [{ prompt: '관계없는 다른 턴' }]), false);
});

test('짧은 메시지는 다른 긴 메시지의 안내문 때문에 전달로 오판하지 않는다', () => {
  const redirected = `지시문이 너무 길어 Claude Team Monitor가 ${LONG_PROMPT_REDIRECT_MARKER}. 파일을 읽어라`;
  assert.strictEqual(isChatItemDelivered({ message: '짧은 메시지' }, [{ prompt: redirected }]), false);
});
