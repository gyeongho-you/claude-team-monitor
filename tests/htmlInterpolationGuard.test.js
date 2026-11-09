// renderer/renderer.js가 HTML 조각을 만들 때 `${값}`을 이스케이프 없이 끼워 넣는 곳이 "검토를 거친 것"만 있는지 지키는 시험.
// 대화 내용·파일 이름·네트워크 응답 같은 외부 값이 이스케이프 없이 innerHTML로 들어가면 화면에 스크립트가 끼어들 수 있다(XSS).
// 새로 생기면 이 시험이 실패한다: 값이 외부에서 올 수 있다면 escapeHtml로 감싸고, 정말 안전하면 이유와 함께 docs/html-interpolation-review.json에 추가하라.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SAFE = /escapeHtml\(|escapeAttr\(|encodeURIComponent\(|Number\(|\.length\b|toFixed\(|Math\.|JSON\.stringify\(|formatAgo\(|formatTime\(|\.map\(|\.join\(|renderMarkdown\(|renderMd|statusLabel|badge|cls\b|className|classList/;

function candidates() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  const found = new Set();
  for (const line of src.split('\n')) {
    if (!line.includes('<')) continue;
    const re = /\$\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;
    let m;
    while ((m = re.exec(line))) {
      const expr = m[1].trim();
      if (SAFE.test(expr)) continue;
      if (/^[^.\w]*['"`][^'"`]*['"`][^.\w]*$/.test(expr)) continue; // 문자열 리터럴뿐
      found.add(expr);
    }
  }
  return [...found].sort();
}

const reviewed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'html-interpolation-review.json'), 'utf8')).items;

test('이스케이프 표시가 없는 HTML 보간은 전부 검토된 목록에 있다(새로 생기면 실패)', () => {
  const known = new Set(reviewed.map(i => i.expr));
  const unreviewed = candidates().filter(e => !known.has(e));
  assert.deepEqual(unreviewed, [], '검토하지 않은 HTML 보간이 생겼습니다 — 외부 값이면 escapeHtml로 감싸고, 안전하면 docs/html-interpolation-review.json에 이유와 함께 추가하세요');
});

test('검토 목록의 모든 항목에 근거가 적혀 있고 미분류가 없다', () => {
  assert.deepEqual(reviewed.filter(i => !i.basis || i.basis === '미분류').map(i => i.expr), []);
});

test('검토 목록에 코드에서 사라진 낡은 항목이 없다', () => {
  const now = new Set(candidates());
  assert.deepEqual(reviewed.map(i => i.expr).filter(e => !now.has(e)), []);
});

test('외부 값이 들어오는 대표 자리는 escapeHtml을 거친다(회귀 방지)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  for (const needle of [
    'data-lead="${escapeHtml(row.id)}"',
    '<div class="chat-prompt">▸ ${escapeHtml(item.message)}</div>',
    '<div class="diff-path">${escapeHtml(file)}</div>',
    'activity-${escapeHtml(it.kind)}',
    'src="${escapeHtml(attachmentThumbs.get(p))}"',
  ]) assert.ok(src.includes(needle), `이스케이프가 빠졌습니다: ${needle}`);
});
