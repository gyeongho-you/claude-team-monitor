// 두 스크립트의 줄 단위 차이를 계산하는 순수 로직(DOM 없음) — renderer.js와 테스트(node:test)가 같이 쓴다.
// "AI로 수정" 뒤에 무엇이 바뀌었는지 코드를 통째로 읽지 않고도 볼 수 있게 한다.
// 최장 공통 부분 수열(LCS)로 계산하며, 너무 큰 입력은 표 크기를 제한해 화면이 멈추지 않게 한다(그때는 "전체가 바뀜"으로 본다).
var LINE_DIFF_MAX_CELLS = 4000000;

/** @param {string} before @param {string} after @returns {{type: 'same'|'add'|'del', text: string}[]} */
function diffLines(before, after) {
  const a = String(before).replace(/\r\n/g, '\n').split('\n');
  const b = String(after).replace(/\r\n/g, '\n').split('\n');
  // 앞뒤로 같은 줄은 표에 넣지 않는다(계산량을 줄이고, 큰 파일의 작은 수정에서 거의 항상 이득)
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const out = [];
  for (let i = 0; i < head; i++) out.push({ type: 'same', text: a[i] });
  if ((midA.length + 1) * (midB.length + 1) > LINE_DIFF_MAX_CELLS) {
    midA.forEach(t => out.push({ type: 'del', text: t }));
    midB.forEach(t => out.push({ type: 'add', text: t }));
  } else {
    const n = midA.length, m = midB.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { out.push({ type: 'same', text: midA[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ type: 'del', text: midA[i] }); i++; }
      else { out.push({ type: 'add', text: midB[j] }); j++; }
    }
    while (i < n) { out.push({ type: 'del', text: midA[i++] }); }
    while (j < m) { out.push({ type: 'add', text: midB[j++] }); }
  }
  for (let k = a.length - tail; k < a.length; k++) out.push({ type: 'same', text: a[k] });
  return out;
}

/** 바뀐 줄 수 요약 */
function summarizeDiff(lines) {
  let added = 0, removed = 0;
  for (const l of lines) { if (l.type === 'add') added++; else if (l.type === 'del') removed++; }
  return { added, removed };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { diffLines, summarizeDiff };
} else {
  (typeof window !== 'undefined' ? window : globalThis).diffLines = diffLines;
  (typeof window !== 'undefined' ? window : globalThis).summarizeDiff = summarizeDiff;
}
