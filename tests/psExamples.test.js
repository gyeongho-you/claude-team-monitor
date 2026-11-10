// 스크립트 슬롯의 내장 예제가 (1) 문법적으로 올바르고 (2) 슬롯 길이 한도 안에 들고 (3) 버튼이 연결돼 있는지 확인한다.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const rust = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'panel_script.rs'), 'utf8');
const MAX = Number(/MAX_SCRIPT_CHARS: usize = ([0-9_]+)/.exec(rust)[1].replace(/_/g, ''));

const examples = [...js.matchAll(/const (PS_EXAMPLE_[A-Z_]+) = String\.raw`([\s\S]*?)\n`;/g)].map(m => ({ name: m[1], code: m[2] }));

test('내장 예제가 2개 이상 있다', () => {
  assert.ok(examples.length >= 2, examples.map(e => e.name).join(','));
  assert.ok(examples.some(e => e.name === 'PS_EXAMPLE_GRAPH_TEAM_JS'));
});

for (const ex of examples) {
  test(`${ex.name}: 문법 오류가 없고 길이 한도 안이다`, () => {
    assert.doesNotThrow(() => new vm.Script(`(function(){${ex.code}\n})`, { filename: ex.name }));
    assert.ok(ex.code.length < MAX, `${ex.code.length}자 / 한도 ${MAX}자`);
    assert.ok(!ex.code.includes('`'), '템플릿 안에 백틱이 있으면 예제가 잘린다');
  });
}

test('예제 버튼이 화면과 코드에 모두 연결돼 있다', () => {
  for (const id of ['ps-example-graph-js-btn', 'ps-example-graph-team-btn']) {
    assert.ok(html.includes(`id="${id}"`), `${id} 버튼이 index.html에 없다`);
    assert.ok(js.includes(`getElementById('${id}')`), `${id} 핸들러가 renderer.js에 없다`);
  }
});
