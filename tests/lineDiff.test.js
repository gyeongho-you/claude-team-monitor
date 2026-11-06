const test = require('node:test');
const assert = require('node:assert/strict');
const { diffLines, summarizeDiff } = require('../renderer/lib/lineDiff');

const fmt = lines => lines.map(l => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text).join('|');

test('diffLines: 같은 입력이면 전부 same이고 바뀐 줄이 없다', () => {
  const d = diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(fmt(d), ' a| b| c');
  assert.deepEqual(summarizeDiff(d), { added: 0, removed: 0 });
});

test('diffLines: 가운데 한 줄 교체는 del 하나와 add 하나로 나온다', () => {
  const d = diffLines('a\nb\nc', 'a\nX\nc');
  assert.equal(fmt(d), ' a|-b|+X| c');
  assert.deepEqual(summarizeDiff(d), { added: 1, removed: 1 });
});

test('diffLines: 줄 추가·삭제와 순서가 섞여도 공통 줄은 유지한다', () => {
  const d = diffLines('a\nb\nc\nd', 'a\nc\nd\ne');
  assert.deepEqual(summarizeDiff(d), { added: 1, removed: 1 });
  assert.equal(fmt(d), ' a|-b| c| d|+e');
});

test('diffLines: CRLF와 LF 차이는 무시하고, 빈 입력도 다룬다', () => {
  assert.deepEqual(summarizeDiff(diffLines('a\r\nb', 'a\nb')), { added: 0, removed: 0 });
  assert.deepEqual(summarizeDiff(diffLines('', 'x\ny')), { added: 2, removed: 1 });
  assert.deepEqual(summarizeDiff(diffLines('x\ny', '')), { added: 1, removed: 2 });
});

test('diffLines: 아주 큰 입력은 표를 만들지 않고 전체 교체로 처리해 빠르게 끝난다', () => {
  const big1 = Array.from({ length: 3000 }, (_, i) => 'a' + i).join('\n');
  const big2 = Array.from({ length: 3000 }, (_, i) => 'b' + i).join('\n');
  const t0 = Date.now();
  const s = summarizeDiff(diffLines(big1, big2));
  assert.deepEqual(s, { added: 3000, removed: 3000 });
  assert.ok(Date.now() - t0 < 2000);
});
