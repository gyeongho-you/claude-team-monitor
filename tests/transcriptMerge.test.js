const test = require('node:test');
const assert = require('node:assert');
const { queuedCommandPrompt, mergeInjectedPrompts } = require('../src/lib/transcriptMerge');

const att = prompt => ({ type: 'attachment', attachment: { type: 'queued_command', prompt } });
const e = (time, prompt) => ({ time, prompt, answer: '' });

test('끼어든 메시지(queued_command)의 원문을 돌려준다', () => {
  assert.strictEqual(queuedCommandPrompt(att('추가 요청: 끝에 메모접수를 붙여줘')), '추가 요청: 끝에 메모접수를 붙여줘');
});

test('완료 알림·빈 문구·다른 기록은 무시한다', () => {
  assert.strictEqual(queuedCommandPrompt(att('<task-notification><task-id>x</task-id></task-notification>')), null);
  assert.strictEqual(queuedCommandPrompt(att('   ')), null);
  assert.strictEqual(queuedCommandPrompt({ type: 'user', message: { content: '안녕' } }), null);
  assert.strictEqual(queuedCommandPrompt({ type: 'attachment', attachment: { type: 'other', prompt: 'x' } }), null);
  assert.strictEqual(queuedCommandPrompt({ type: 'attachment', attachment: { type: 'queued_command', prompt: ['배열'] } }), null);
});

test('일지에 없는 끼어든 메시지는 시간순 위치에 들어가고, 이미 있는 것은 중복으로 넣지 않는다', () => {
  const journal = [e('2026-10-22 15:25', '첫 메시지'), e('2026-10-22 15:40', '나중 메시지')];
  const injected = [e('2026-10-22 15:26', '끼어든 메시지'), e('2026-10-22 15:40', '나중 메시지')];
  assert.deepStrictEqual(mergeInjectedPrompts(journal, injected).map(x => x.prompt), ['첫 메시지', '끼어든 메시지', '나중 메시지']);
});

test('같은 문구라도 시간이 10분 넘게 떨어져 있으면 다른 메시지로 본다', () => {
  const journal = [e('2026-10-22 10:00', '그래')];
  const injected = [e('2026-10-22 15:00', '그래')];
  assert.deepStrictEqual(mergeInjectedPrompts(journal, injected).map(x => x.time), ['2026-10-22 10:00', '2026-10-22 15:00']);
});
