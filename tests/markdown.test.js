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
