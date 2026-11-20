// 내장 예제 "작업 중 변경 보기"를 실제 git 저장소(임시 폴더)에 대해 실행해 본다.
//  - 페이지 방식(CTM_REQUEST 없음): 폴더별 변경 목록(수정·추가·삭제·이름 바꾸기·새 파일)과 현재 작업 폴더·워크트리 포함 여부
//  - 질의 방식(CTM_REQUEST 있음): 목록 새로고침, 파일 하나의 전체 내용과 줄별 변경 표시, 마크다운 원문, 이진 파일, 잘못된/악의적 요청 거절
// (이 시험은 git이 필요하다 — CI 러너와 개발 PC에는 있다.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const m = /const PS_EXAMPLE_CHANGES_JS = String\.raw`([\s\S]*?)\n`;/.exec(js);
assert.ok(m, '예제 스크립트를 renderer.js에서 찾지 못했습니다');
const SCRIPT = m[1];

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const mk = p => fs.mkdirSync(p, { recursive: true });
const jsonEsc = s => JSON.stringify(s).slice(1, -1);

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-chg-'));
  const lead = path.join(base, '팀장 저장소');
  mk(lead);
  git(lead, 'init', '-q', '-b', 'main');
  const lines = Array.from({ length: 30 }, (_, i) => '줄 ' + (i + 1));
  fs.writeFileSync(path.join(lead, 'code.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(lead, 'doc.md'), '# 제목\n\n- 항목\n  - 안쪽\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  fs.writeFileSync(path.join(lead, 'gone.txt'), '지울 파일\n두번째 줄\n');
  fs.writeFileSync(path.join(lead, 'old-name.txt'), '이름이 바뀔 파일 내용입니다. 충분히 길게 써서 비슷한 파일로 인식됩니다.\n');
  git(lead, 'add', '-A'); git(lead, 'commit', '-q', '-m', '처음');
  // 작업 중 변경: 수정, 마크다운 수정, 삭제, 이름 바꾸기(스테이지), 새 파일(추적 안 됨), 이진 파일
  lines[14] = '줄 15 (바뀜)'; lines.splice(20, 0, '새로 끼운 줄');
  fs.writeFileSync(path.join(lead, 'code.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(lead, 'doc.md'), '# 제목\n\n- 항목\n  - 안쪽\n  - 새 안쪽\n\n| a | b |\n|---|---|\n| 1 | 3 |\n');
  fs.unlinkSync(path.join(lead, 'gone.txt'));
  git(lead, 'mv', 'old-name.txt', 'new-name.txt');
  mk(path.join(lead, 'sub dir'));
  fs.writeFileSync(path.join(lead, 'sub dir', '새 문서.md'), '# 새 문서\n본문\n');
  fs.writeFileSync(path.join(lead, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
  // 워크트리(팀장 폴더의 다른 작업 공간) — 여기에도 변경이 있다
  const wt = path.join(base, '워크트리 하나');
  git(lead, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
  fs.writeFileSync(path.join(wt, 'doc.md'), '워크트리에서 고친 문서\n');
  // 팀장 세션의 현재 작업 폴더는 워크트리(대화 기록 마지막 줄의 cwd)
  const session = path.join(base, 'session.jsonl');
  fs.writeFileSync(session, JSON.stringify({ type: 'user', cwd: lead, message: {} }) + '\n' + '{"type":"assistant","cwd":"' + jsonEsc(wt) + '"}\n');
  const outside = path.join(base, '다른 저장소'); mk(outside); git(outside, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(outside, 'secret.txt'), '남의 비밀');
  const leadsFile = path.join(base, 'leads.json');
  fs.writeFileSync(leadsFile, JSON.stringify([{ id: 'L1', sessionId: 's1', targetDir: lead, approvedMembers: [outside] }]));
  const scriptFile = path.join(base, 'changes.js');
  fs.writeFileSync(scriptFile, SCRIPT);
  return { base, lead, wt, outside, session, leadsFile, scriptFile, tmp: path.join(base, 'tmp') };
}

function runScript(ctx, request) {
  mk(ctx.tmp);
  const env = { ...process.env, TMPDIR: ctx.tmp, TEMP: ctx.tmp, TMP: ctx.tmp, CTM_LEAD_DIR: ctx.lead, CTM_LEAD_ID: 'L1', CTM_SESSION_ID: 's1', CTM_LEADS_FILE: ctx.leadsFile, CTM_SESSION_FILE: ctx.session, CTM_LEAD_LABEL: '시험 팀장' };
  delete env.CTM_CLAUDE_HOME; // 시험에서는 떠 있는 팀원 조회(claude)를 건너뛴다
  if (request !== undefined) env.CTM_REQUEST = typeof request === 'string' ? request : JSON.stringify(request);
  const r = spawnSync(process.execPath, [ctx.scriptFile], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}
const page = ctx => {
  const out = runScript(ctx);
  const dm = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(out);
  assert.ok(dm, '데이터 JSON이 출력에 없다: ' + out.slice(0, 300));
  return { out, data: JSON.parse(dm[1]) };
};
const call = (ctx, req) => JSON.parse(runScript(ctx, req));
const norm = p => String(p).replace(/\\/g, '/').toLowerCase();

test('페이지 방식: 팀장 폴더와 워크트리, 세션의 현재 작업 폴더에서 변경 파일을 상태별로 모은다', () => {
  const ctx = setup();
  const { out, data } = page(ctx);
  const byDir = new Map(data.dirs.map(d => [norm(d.dir), d]));
  const leadDir = byDir.get(norm(ctx.lead));
  assert.ok(leadDir, '팀장 폴더가 목록에 없다: ' + data.dirs.map(d => d.dir).join(' | '));
  const st = Object.fromEntries(leadDir.files.map(f => [f.p, f.s]));
  assert.strictEqual(st['code.txt'], 'M');
  assert.strictEqual(st['doc.md'], 'M');
  assert.strictEqual(st['gone.txt'], 'D');
  assert.strictEqual(st['new-name.txt'], 'R', JSON.stringify(st));
  assert.strictEqual(st['sub dir/새 문서.md'], '?', '추적 안 되는 새 파일(공백·한글 경로)');
  assert.strictEqual(st['blob.bin'], '?');
  assert.ok(!('old-name.txt' in st), '이름 바꾸기의 옛 경로는 목록에 따로 나오지 않는다');
  const wtDir = byDir.get(norm(ctx.wt));
  assert.ok(wtDir && wtDir.files.some(f => f.p === 'doc.md' && f.s === 'M'), '워크트리의 변경이 없다');
  assert.ok(wtDir.role.includes('작업 폴더'), '세션의 현재 작업 폴더(워크트리)는 "팀장 작업 폴더"로 표시: ' + wtDir.role);
  assert.ok(!byDir.has(norm(ctx.outside)), '허용한 팀원 폴더라도 떠 있는 팀원이 아니면 보지 않는다');
  assert.ok(out.includes('<script>(function frameMain'), '화면 스크립트가 들어 있다');
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test('질의 방식(list): 변경 목록을 다시 모은다', () => {
  const ctx = setup();
  const r = call(ctx, { op: 'list' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.dirs.length >= 2);
  fs.writeFileSync(path.join(ctx.lead, 'another.txt'), 'x');
  const again = call(ctx, { op: 'list' });
  const lead = again.dirs.find(d => norm(d.dir) === norm(ctx.lead));
  assert.ok(lead.files.some(f => f.p === 'another.txt'), '새로고침이 새 파일을 반영해야 한다');
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test('질의 방식(file): 수정된 파일은 전체 내용에 바뀐 줄 표시가 붙고 줄 번호가 맞는다', () => {
  const ctx = setup();
  const r = call(ctx, { op: 'file', dir: ctx.lead, path: 'code.txt', st: 'M' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rows.length, 32, '전체 31줄 + 삭제 1줄(원래 30줄 중 1줄 바뀌고 1줄 끼움)');
  const added = r.rows.filter(x => x[0] === '+').map(x => x[3]);
  const removed = r.rows.filter(x => x[0] === '-').map(x => x[3]);
  assert.deepStrictEqual(added.sort(), ['새로 끼운 줄', '줄 15 (바뀜)'].sort());
  assert.deepStrictEqual(removed, ['줄 15']);
  const ctxRows = r.rows.filter(x => x[0] === ' ');
  assert.strictEqual(ctxRows.length, 29);
  assert.strictEqual(ctxRows[0][3], '줄 1');
  assert.strictEqual(ctxRows[0][2], 1, '바뀌지 않은 첫 줄의 새 줄 번호');
  const last = r.rows[r.rows.length - 1];
  assert.strictEqual(last[3], '줄 30'); assert.strictEqual(last[2], 31, '새 파일의 마지막 줄 번호');
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test('질의 방식(file): 마크다운은 렌더링용 원문(raw)을 함께 준다 / 새 파일은 전부 추가, 삭제된 파일은 전부 삭제', () => {
  const ctx = setup();
  const md = call(ctx, { op: 'file', dir: ctx.lead, path: 'doc.md', st: 'M' });
  assert.ok(md.raw.includes('  - 새 안쪽') && md.raw.includes('| 1 | 3 |'), '작업 폴더의 현재 내용이 원문이어야 한다');
  const fresh = call(ctx, { op: 'file', dir: ctx.lead, path: 'sub dir/새 문서.md', st: '?' });
  assert.ok(fresh.rows.every(x => x[0] === '+') && fresh.rows.length === 2 && fresh.raw.startsWith('# 새 문서'));
  const gone = call(ctx, { op: 'file', dir: ctx.lead, path: 'gone.txt', st: 'D' });
  assert.ok(gone.status === 'D' && gone.rows.length === 2 && gone.rows.every(x => x[0] === '-'), JSON.stringify(gone));
  const txt = call(ctx, { op: 'file', dir: ctx.lead, path: 'code.txt', st: 'M' });
  assert.strictEqual(txt.raw, '', '마크다운이 아니면 원문을 따로 보내지 않는다(데이터 크기)');
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test('질의 방식(file): 이진 파일은 내용을 주지 않고, 아주 큰 파일은 잘렸다고 알린다', () => {
  const ctx = setup();
  const bin = call(ctx, { op: 'file', dir: ctx.lead, path: 'blob.bin', st: '?' });
  assert.strictEqual(bin.binary, true); assert.deepStrictEqual(bin.rows, []);
  fs.writeFileSync(path.join(ctx.lead, 'big.txt'), 'x'.repeat(10) + '\n' + 'y'.repeat(500000));
  const big = call(ctx, { op: 'file', dir: ctx.lead, path: 'big.txt', st: '?' });
  assert.strictEqual(big.truncated, true);
  assert.ok(JSON.stringify(big).length < 700000, '응답이 너무 크다');
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test('질의 방식: 잘못된·악의적 요청(허용 안 된 폴더, 경로 탈출, 이상한 요청)은 거절한다', () => {
  const ctx = setup();
  const bad = [
    { op: 'file', dir: ctx.outside, path: 'secret.txt', st: '?' }, // 허용 목록에 있어도 떠 있는 팀원 폴더가 아니면 거절
    { op: 'file', dir: ctx.base, path: 'leads.json', st: '?' }, // 팀장 폴더 밖
    { op: 'file', dir: ctx.lead, path: '../leads.json', st: '?' },
    { op: 'file', dir: ctx.lead, path: '..\\leads.json', st: '?' },
    { op: 'file', dir: ctx.lead, path: 'sub dir/../../leads.json', st: '?' },
    { op: 'file', dir: ctx.lead, path: path.join(ctx.base, 'leads.json'), st: '?' },
    { op: 'file', dir: ctx.lead, path: 'C:\\Windows\\win.ini', st: '?' },
    { op: 'file', dir: ctx.lead, path: '/etc/passwd', st: '?' },
    { op: 'file', dir: ctx.lead, path: '', st: '?' },
    { op: 'file', dir: 42, path: 'x', st: '?' },
    { op: 'nope' },
    '그냥 글자', '[1,2]', 'null',
  ];
  for (const req of bad) {
    const out = runScript(ctx, req);
    const r = JSON.parse(out);
    assert.strictEqual(r.ok, false, JSON.stringify(req) + ' → ' + out.slice(0, 200));
    assert.ok(!out.includes('남의 비밀') && !out.includes('"id":"L1"'), '남의 내용이 새어 나오면 안 된다');
  }
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

// 팀장이 이미 "커밋한" 변경도 보여야 한다(실사용: 팀장이 설계 문서를 쓰고 커밋까지 했는데 "커밋 전 변경"만 보면 아무것도 안 보였다)
function addTopicWorktree(ctx) {
  const topic = path.join(ctx.base, '토픽 워크트리');
  git(ctx.lead, 'worktree', 'add', '-q', '-b', 'topic', topic, 'main');
  const lines = fs.readFileSync(path.join(topic, 'code.txt'), 'utf8').split('\n'); lines[2] = '줄 3 (커밋으로 바뀜)';
  fs.writeFileSync(path.join(topic, 'code.txt'), lines.join('\n'));
  fs.writeFileSync(path.join(topic, 'new-design.md'), '# 설계\n첫 문단\n');
  git(topic, 'add', '-A'); git(topic, 'commit', '-q', '-m', '설계 추가');
  fs.writeFileSync(path.join(topic, 'new-design.md'), '# 설계\n첫 문단\n둘째 문단\n');
  fs.writeFileSync(path.join(topic, 'extra.md'), '추가 문서\n');
  git(topic, 'add', '-A'); git(topic, 'commit', '-q', '-m', '설계 보강');
  fs.writeFileSync(path.join(topic, 'new-design.md'), '# 설계\n첫 문단\n둘째 문단\n아직 커밋 안 한 줄\n'); // 커밋 후 더 고침
  return topic;
}
const listFor = (ctx, scope, dir) => { const r = call(ctx, { op: 'list', scope }); const d = r.dirs.find(x => norm(x.dir) === norm(dir)); assert.ok(d, '폴더가 목록에 없다: ' + dir); return d; };
const fileMap = d => Object.fromEntries(d.files.map(f => [f.p, f]));

test('이미 커밋한 변경: 기본 비교 기준("브랜치 전체")은 기본 브랜치와 갈라진 뒤의 모든 변경을 보여 주고, 커밋 전 변경에는 표시를 붙인다', () => {
  const ctx = setup(); const topic = addTopicWorktree(ctx);
  const { data } = page(ctx);
  const d = data.dirs.find(x => norm(x.dir) === norm(topic));
  assert.ok(d, '커밋만 한 워크트리도 목록에 있어야 한다');
  assert.ok(d.base.includes('main'), '비교 기준 설명: ' + d.base);
  const f = fileMap(d);
  assert.deepStrictEqual(Object.keys(f).sort(), ['code.txt', 'extra.md', 'new-design.md']);
  assert.strictEqual(f['code.txt'].s, 'M'); assert.strictEqual(f['code.txt'].u, false, '커밋만 한 파일은 커밋 전 표시가 없다');
  assert.strictEqual(f['extra.md'].s, 'A'); assert.strictEqual(f['extra.md'].u, false);
  assert.strictEqual(f['new-design.md'].s, 'A'); assert.strictEqual(f['new-design.md'].u, true, '커밋한 뒤 더 고친 파일은 커밋 전 표시');
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test('비교 기준을 바꾸면 목록이 달라진다: 커밋 전만 / 최근 1커밋', () => {
  const ctx = setup(); const topic = addTopicWorktree(ctx);
  assert.deepStrictEqual(Object.keys(fileMap(listFor(ctx, 'wt', topic))), ['new-design.md'], '커밋 전만 보면 아직 커밋 안 한 파일뿐');
  const one = fileMap(listFor(ctx, 'last:1', topic));
  assert.deepStrictEqual(Object.keys(one).sort(), ['extra.md', 'new-design.md'], '최근 1커밋 + 그 뒤의 변경: ' + Object.keys(one));
  assert.strictEqual(one['new-design.md'].s, 'M', '직전 커밋에도 있던 파일은 수정으로');
  const three = fileMap(listFor(ctx, 'last:3', topic));
  assert.ok('code.txt' in three, '3커밋 전이면 처음 바꾼 파일도 들어온다(기록이 모자라면 빈 트리와 비교)');
  assert.strictEqual(call(ctx, { op: 'list', scope: 'last:0' }).scope, 'branch', '범위 밖의 값은 기본으로');
  assert.strictEqual(call(ctx, { op: 'list', scope: 'last:999' }).scope, 'branch');
  assert.strictEqual(call(ctx, { op: 'list', scope: '--output=x' }).scope, 'branch', '이상한 값은 기본으로(git 옵션으로 쓰이지 않는다)');
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test('커밋한 파일의 내용: 기준과 비교한 전체 보기(바뀐 줄 표시)와 마크다운 원문', () => {
  const ctx = setup(); const topic = addTopicWorktree(ctx);
  const code = call(ctx, { op: 'file', dir: topic, path: 'code.txt', st: 'M', scope: 'branch' });
  assert.strictEqual(code.ok, true);
  const added = code.rows.filter(x => x[0] === '+').map(x => x[3]); const removed = code.rows.filter(x => x[0] === '-').map(x => x[3]);
  assert.deepStrictEqual(added, ['줄 3 (커밋으로 바뀜)']); assert.deepStrictEqual(removed, ['줄 3']);
  assert.ok(code.rows.length >= 30, '파일 전체가 나와야 한다');
  const md = call(ctx, { op: 'file', dir: topic, path: 'new-design.md', st: 'A', scope: 'branch' });
  assert.ok(md.rows.every(x => x[0] === '+') && md.rows.length === 4, '기준에 없던 파일은 전부 추가: ' + md.rows.length);
  assert.ok(md.raw.includes('아직 커밋 안 한 줄'), '렌더링 원문은 작업 폴더의 현재 내용');
  const mdLast = call(ctx, { op: 'file', dir: topic, path: 'new-design.md', st: 'M', scope: 'last:1' });
  assert.deepStrictEqual(mdLast.rows.filter(x => x[0] === '+').map(x => x[3]), ['둘째 문단', '아직 커밋 안 한 줄'], '최근 1커밋 기준에서는 그 뒤에 바뀐 줄만 추가로 표시');
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test('기본 브랜치(main) 위에서 일하는 폴더는 기준을 바꿔도 커밋 전 변경은 그대로 보인다', () => {
  const ctx = setup();
  const d = listFor(ctx, 'branch', ctx.lead);
  assert.ok(d.base.includes('새 커밋 없음') || d.base.includes('main'), d.base);
  assert.strictEqual(fileMap(d)['code.txt'].u, true);
  fs.rmSync(ctx.base, { recursive: true, force: true });
});

test('팀장을 고르지 않으면 안내만 낸다', () => {
  const ctx = setup();
  const env = { ...process.env };
  delete env.CTM_LEAD_DIR; delete env.CTM_REQUEST;
  const r = spawnSync(process.execPath, [ctx.scriptFile], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0);
  assert.ok(r.stdout.includes('팀장을 선택'));
  fs.rmSync(ctx.base, { recursive: true, force: true });
});
