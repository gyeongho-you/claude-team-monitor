const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown, renderInline } = require('../renderer/lib/markdown');

test('입력의 HTML은 전부 이스케이프되어 태그가 살아남지 않는다', () => {
  const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> **굵게**');
  assert.ok(!/<script|<img/i.test(html), html);
  assert.ok(html.includes('&lt;script&gt;') && html.includes('<strong>굵게</strong>'));
  assert.ok(!renderInline('"><b onclick="x">').includes('<b'), '속성 탈출 시도');
});

test('링크는 http/https만 허용하고 href는 #이며 주소는 data-url에만 들어간다', () => {
  const ok = renderMarkdown('[보고서](https://claude.ai/artifact/abc?x=1&y=2)');
  assert.ok(ok.includes('href="#"') && ok.includes('data-url="https://claude.ai/artifact/abc?x=1&amp;y=2"') && ok.includes('>보고서</a>'), ok);
  for (const bad of ['[x](javascript:alert(1))', '[x](file:///c:/a.exe)', '[x](data:text/html,<b>)', '[x](//evil.com)']) {
    const h = renderMarkdown(bad);
    assert.ok(!h.includes('<a ') && !/javascript:|file:|data:/.test(h.replace(/&[a-z]+;/g, '')) || !h.includes('data-url'), `${bad} → ${h}`);
    assert.ok(!h.includes('<a '), `${bad}는 링크가 되면 안 된다: ${h}`);
  }
  assert.ok(renderMarkdown('https://example.com/a 를 보세요').includes('data-url="https://example.com/a"'), '맨 주소는 자동 링크');
  assert.ok(!renderMarkdown('![그림](https://x.com/a.png)').includes('<img'), '외부 주소 이미지는 그리지 않는다');
});

test('이미지는 base64 data: 주소만 그린다', () => {
  const ok = renderMarkdown('![차트](data:image/png;base64,iVBORw0KGgo=)');
  assert.strictEqual(ok, '<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="차트"></p>');
  assert.ok(renderMarkdown('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)').includes('<img src="data:image/svg+xml;base64,'));
  for (const bad of ['![x](data:text/html;base64,PGI+)', '![x](data:image/png;base64,AA"onerror="x)', '![x](javascript:alert(1))', '![x](file:///c:/a.png)', '![x](data:image/png,raw)']) {
    const h = renderMarkdown(bad);
    assert.ok(!h.includes('<img'), `${bad} → ${h}`);
  }
});

test('제목, 목록, 표, 인용, 코드 블록, 구분선', () => {
  assert.ok(renderMarkdown('# 제목\n## 소제목').includes('<h2>제목</h2>') && renderMarkdown('# 제목\n## 소제목').includes('<h3>소제목</h3>'), '앱 제목과 겹치지 않게 한 단계 낮춘다');
  assert.strictEqual(renderMarkdown('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.strictEqual(renderMarkdown('1. a\n2) b'), '<ol><li>a</li><li>b</li></ol>');
  const t = renderMarkdown('| 날짜 | 제목 |\n|---|---|\n| 11-01 | [보고](https://a.com) |');
  assert.ok(t.includes('<th>날짜</th>') && t.includes('<td>11-01</td>') && t.includes('data-url="https://a.com"'), t);
  assert.ok(renderMarkdown('> 인용 **중요**').includes('<blockquote>인용 <strong>중요</strong></blockquote>'));
  assert.strictEqual(renderMarkdown('```\n<b>코드</b>\n```'), '<pre><code>&lt;b&gt;코드&lt;/b&gt;</code></pre>');
  assert.ok(renderMarkdown('위\n\n---\n\n아래').includes('<hr>'));
});

test('인라인 코드 안은 변환하지 않고, 문단의 줄바꿈은 유지한다', () => {
  assert.strictEqual(renderInline('`**그대로** <b>`'), '<code>**그대로** &lt;b&gt;</code>');
  assert.strictEqual(renderMarkdown('첫 줄\n둘째 줄'), '<p>첫 줄<br>둘째 줄</p>');
  assert.strictEqual(renderMarkdown(''), '');
  assert.strictEqual(renderMarkdown(null), '');
});

test('XSS 공격 모음: 어떤 입력도 실행 가능한 태그·속성·주소를 만들지 않는다', () => {
  const vectors = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<iframe src="javascript:alert(1)">', '<a href="javascript:alert(1)">x</a>',
    '[x](javascript:alert(1))', '[x]( javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](&#106;avascript:alert(1))', '[x](vbscript:msgbox(1))', '[x](data:text/html,<script>alert(1)</script>)',
    '[x](https://a.com" onmouseover="alert(1))', '[x](https://a.com\'onmouseover=\'alert(1))', '[x](https://a.com/`onmouseover=`alert(1))',
    '[<img src=x onerror=alert(1)>](https://a.com)', '[x](https://a.com "title" onclick="alert(1)")',
    '![x](javascript:alert(1))', '![x](https://evil.com/a.png)', '![x](data:image/svg+xml;utf8,<svg onload=alert(1)>)', '![x](data:image/png;base64,AAAA" onerror="alert(1))',
    '`<script>alert(1)</script>`', '```\n<script>alert(1)</script>\n```', '**<img src=x onerror=alert(1)>**', '*a<img src=x onerror=alert(1)>*',
    '| <img src=x onerror=alert(1)> | b |\n|---|---|\n| <svg onload=alert(1)> | c |', '> <img src=x onerror=alert(1)>', '# <img src=x onerror=alert(1)>', '- <img src=x onerror=alert(1)>',
    'https://a.com/"onmouseover="alert(1)', 'https://a.com/<script>alert(1)</script>', '<<script>script>alert(1)<</script>/script>', '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
    '\u0000<script>alert(1)</script>', '\u0000\u0001 [x](javascript:alert(1))', '<a href="&#x6A;avascript:alert(1)">x</a>',
  ];
  for (const v of vectors) {
    const h = renderMarkdown(v);
    // 태그가 되는 "<"는 우리가 직접 만든 태그뿐이어야 한다: 허용 목록 밖의 태그나 이벤트 속성이 있으면 안 된다
    const tags = [...h.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map(m => m[1].toLowerCase());
    const allowed = new Set(['p', 'br', 'strong', 'em', 'code', 'pre', 'a', 'img', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
    assert.ok(tags.every(t => allowed.has(t)), `허용 밖 태그: ${v} → ${h}`);
    // 글자로 이스케이프된 내용(&lt;img onerror=...&gt;)이 아니라, 진짜 태그(<...>) 안에 이벤트 속성이 있는지만 본다
    for (const tag of h.matchAll(/<[^>]*>/g)) assert.ok(!/\son[a-z]+\s*=/i.test(tag[0]), `이벤트 속성: ${v} → ${h}`);
    // 속성 값 안으로 따옴표가 새어 나오면 안 된다: a 태그와 img 태그의 속성은 우리가 정한 것만
    for (const m of h.matchAll(/<(a|img)\b([^>]*)>/g)) {
      const attrs = [...m[2].matchAll(/\s([a-z-]+)=/g)].map(x => x[1]);
      const ok = m[1] === 'a' ? ['href', 'data-url', 'title'] : ['src', 'alt'];
      assert.ok(attrs.every(a => ok.includes(a)), `예상 밖 속성 ${attrs}: ${v} → ${h}`);
      const src = (m[2].match(/(?:src|data-url)="([^"]*)"/g) || []).join(' ');
      assert.ok(!/javascript:|vbscript:|file:/i.test(src), `위험한 주소: ${v} → ${h}`);
    }
    // img는 base64 data: 이미지일 때만
    for (const m of h.matchAll(/<img src="([^"]*)"/g)) assert.ok(/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+\/=]+$/.test(m[1]), `허용 밖 이미지: ${v} → ${h}`);
    // a의 실제 이동 주소(href)는 항상 #
    for (const m of h.matchAll(/<a\b[^>]*\shref="([^"]*)"/g)) assert.strictEqual(m[1], '#', `href가 #이 아님: ${v} → ${h}`);
  }
});

test('깊게 중첩된·긴 입력에도 오래 걸리지 않는다(정규식 폭주 방지)', () => {
  const t = Date.now();
  const nasty = ['**' + 'a*'.repeat(20000), '['.repeat(5000), '[x](' + 'a'.repeat(100000), '`'.repeat(50000), '> '.repeat(20000), '|'.repeat(30000) + '\n' + '-'.repeat(30000), 'https://' + 'a/'.repeat(30000), '![x](data:image/png;base64,' + 'A'.repeat(200000) + ')'];
  for (const s of nasty) renderMarkdown(s);
  assert.ok(Date.now() - t < 4000, `너무 오래 걸림: ${Date.now() - t}ms`);
});
