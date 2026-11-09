// Rust 실행 코드에서 패닉할 수 있는 호출(.unwrap(), .expect( 등)이 "검토를 거친 것"만 있는지 지키는 시험.
// 시험 코드(#[cfg(test)] 뒤)는 제외한다 — 이 저장소는 시험을 파일 맨 끝에 둔다.
// 새 호출을 넣으면 이 시험이 실패한다: 정말 안전한지 확인하고, 이유와 함께 docs/panic-allowlist.json에 추가하라(가능하면 오류로 돌려주는 쪽을 먼저 고려).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src-tauri', 'src');
const PATTERN = /\.unwrap\(\)|\.expect\(|panic!\(|unreachable!\(|unimplemented!\(|todo!\(|\.unwrap_unchecked/;

function runtimeSites() {
  const out = [];
  for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.rs')).sort()) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
    const cut = text.indexOf('#[cfg(test)]');
    const code = cut < 0 ? text : text.slice(0, cut);
    for (const line of code.split('\n')) {
      const t = line.trim();
      if (t.startsWith('//')) continue;
      if (PATTERN.test(line)) out.push(`${file}: ${t}`);
    }
  }
  return out;
}

const allow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'panic-allowlist.json'), 'utf8')).sites;
const key = s => `${s.file}: ${s.code}`;

test('실행 코드의 패닉 후보는 전부 검토된 목록에 있다(새로 생기면 실패)', () => {
  const allowed = new Set(allow.map(key));
  const unreviewed = runtimeSites().filter(s => !allowed.has(s));
  assert.deepEqual(unreviewed, [], '검토하지 않은 panic 후보가 생겼습니다 — 안전한지 확인하고 docs/panic-allowlist.json에 이유와 함께 추가하세요');
});

test('허용 목록에 낡은 항목이 없다(코드에서 사라진 항목은 목록에서도 지운다)', () => {
  const now = new Set(runtimeSites());
  const stale = allow.map(key).filter(k => !now.has(k));
  assert.deepEqual(stale, [], '코드에 더 이상 없는 항목이 허용 목록에 남아 있습니다');
});

test('허용 목록의 모든 항목에 실제 이유가 적혀 있다', () => {
  const missing = allow.filter(s => !s.why || s.why.trim() === '' || s.why === '검토 필요').map(key);
  assert.deepEqual(missing, [], '이유가 없는 항목이 있습니다');
});

test('허용 목록은 작게 유지된다(이 수가 늘어나려면 의식적으로 올려야 한다)', () => {
  assert.ok(allow.length <= 20, `허용된 패닉 후보가 ${allow.length}곳입니다 — 정말 필요한지 다시 보세요`);
});

test('unsafe 코드는 검토된 1곳(Windows에서 부모 프로세스 pid 조회)뿐이다', () => {
  const sites = [];
  for (const file of fs.readdirSync(SRC).filter(f => f.endsWith('.rs')).sort()) {
    const text = fs.readFileSync(path.join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
    const cut = text.indexOf('#[cfg(test)]');
    const code = cut < 0 ? text : text.slice(0, cut);
    code.split('\n').forEach(line => { const t = line.trim(); if (!t.startsWith('//') && /\bunsafe\s*(\{|fn\b|impl\b)/.test(t)) sites.push(`${file}: ${t}`); });
  }
  assert.deepEqual(sites, ['mcp_server.rs: unsafe {'], 'unsafe 코드가 늘었습니다 — 꼭 필요한지, 안전한 이유를 SAFETY 주석과 SECURITY.md에 적었는지 확인하세요');
});
