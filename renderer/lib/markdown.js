// 아주 작은 마크다운 → HTML 변환기(오른쪽 패널 표시용). 팀장이나 모델이 쓴 글을 그대로 보여 주므로 안전이 먼저다:
//  - 입력의 모든 HTML은 먼저 이스케이프한다(태그가 그대로 살아남지 않는다).
//  - 링크는 http/https만 허용하고 href를 "#"로 두고 실제 주소는 data-url에 넣는다(화면 이동 없이 앱이 기본 브라우저로 연다).
//  - 이미지, 스크립트, 인라인 스타일은 지원하지 않는다(이미지는 링크로 보인다).
// 지원: 제목(#), 굵게(**), 기울임(*), 인라인 코드(\`), 코드 블록(\`\`\`), 링크([글](주소)와 맨 주소), 목록(-,*,숫자.), 인용(>), 구분선(---), 표.
// status.js와 같은 방식으로 CommonJS(require)와 브라우저 전역(<script>)에서 모두 쓴다.

function escapeHtmlMd(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SAFE_URL = /^https?:\/\/[^\s<>"'\`]+$/;

function renderInline(raw) {
  const stash = [];
  const keep = html => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
  let s = String(raw);
  // 인라인 코드는 안쪽을 건드리지 않게 먼저 빼 둔다
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escapeHtmlMd(code)}</code>`));
  // [글](주소) — 주소가 http/https일 때만 링크, 아니면 글만 보인다
  s = s.replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, text, url) => {
    if (SAFE_URL.test(url)) return keep(`<a href="#" data-url="${escapeHtmlMd(url)}" title="${escapeHtmlMd(url)}">${escapeHtmlMd(text || url)}</a>`);
    return keep(escapeHtmlMd(text));
  });
  // 맨 주소
  s = s.replace(/https?:\/\/[^\s<>"'\`)\]]+/g, url => keep(`<a href="#" data-url="${escapeHtmlMd(url)}" title="${escapeHtmlMd(url)}">${escapeHtmlMd(url)}</a>`));
  s = escapeHtmlMd(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
}

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(c => c.trim());
}

const isTableSep = line => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

function renderMarkdown(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // 코드 블록
    if (/^```/.test(line.trim())) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtmlMd(code.join('\n'))}</code></pre>`);
      continue;
    }
    // 제목
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = Math.min(h[1].length + 1, 6); out.push(`<h${n}>${renderInline(h[2])}</h${n}>`); i++; continue; }
    // 구분선
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    // 표
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    // 인용
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${q.map(renderInline).join('<br>')}</blockquote>`);
      continue;
    }
    // 목록
    const ul = /^\s*[-*+]\s+/, ol = /^\s*\d+[.)]\s+/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items = [];
      while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map(it => `<li>${renderInline(it)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    // 문단(빈 줄까지, 줄바꿈은 그대로 보인다)
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,6}\s|^\s*>|^\s*[-*+]\s+|^\s*\d+[.)]\s+/.test(lines[i])) para.push(lines[i++]);
    if (para.length) out.push(`<p>${para.map(renderInline).join('<br>')}</p>`);
    else i++;
  }
  return out.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderMarkdown, renderInline, escapeHtmlMd };
} else {
  (typeof window !== 'undefined' ? window : globalThis).renderMarkdown = renderMarkdown;
}
