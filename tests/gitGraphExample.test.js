// 내장 예제 "깃 그래프(팀장+팀원 · 질의 방식)"를 실제 git 저장소 여러 개에 대해 실행해 본다.
//  - 페이지 방식(CTM_REQUEST 없음): 저장소·전체 브랜치 목록·워크트리·"전체 브랜치" 그래프를 담은 HTML
//  - 질의 방식(CTM_REQUEST 있음): 화면이 ctm.call로 보낸 요청에 맞는 JSON만 — 브랜치별 그래프, 더 보기, 목록 새로고침, 잘못된/악의적 요청 거절
// (이 시험은 git이 필요하다 — CI 러너와 개발 PC에는 있다.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
const m = /const PS_EXAMPLE_GRAPH_TEAM_JS = String\.raw`([\s\S]*?)\n`;/.exec(js);
assert.ok(m, '예제 스크립트를 renderer.js에서 찾지 못했습니다');
const SCRIPT = m[1];

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const mk = p => fs.mkdirSync(p, { recursive: true });

function makeRepo(dir, commits) {
  mk(dir);
  git(dir, 'init', '-q', '-b', 'main');
  commits.forEach(([file, body, msg]) => { fs.writeFileSync(path.join(dir, file), body); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); });
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-gg-'));
  const lead = path.join(base, 'lead-design');
  const memberA = path.join(base, 'member-한글 폴더');
  const notGit = path.join(base, 'not-a-repo');
  const missing = path.join(base, 'missing-folder');
  makeRepo(lead, [['a.txt', '1', '설계 1'], ['b.txt', '2', '설계 2'], ['c.txt', '3', '설계 3']]);
  makeRepo(memberA, [['한글.txt', 'x', '구현 1'], ['src.js', 'y', '구현 2']]);
  git(memberA, 'branch', 'feature');
  const wt = path.join(base, 'member-wt');
  git(memberA, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
  fs.writeFileSync(path.join(wt, 'w.txt'), 'w'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', '워크트리 커밋');
  mk(notGit);
  const leadsFile = path.join(base, 'leads.json');
  fs.writeFileSync(leadsFile, JSON.stringify([{ id: 'L1', sessionId: 's1', targetDir: lead, approvedMembers: [memberA, notGit, missing, memberA + '/'] }]));
  const scriptFile = path.join(base, 'graph.js');
  fs.writeFileSync(scriptFile, SCRIPT);
  return { base, lead, memberA, wt, notGit, missing, leadsFile, scriptFile, tmp: path.join(base, 'tmp') };
}

function run(ctx, extraEnv = {}) {
  mk(ctx.tmp);
  const r = spawnSync(process.execPath, [ctx.scriptFile], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TMPDIR: ctx.tmp, TEMP: ctx.tmp, TMP: ctx.tmp, CTM_LEAD_DIR: ctx.lead, CTM_LEAD_ID: 'L1', CTM_SESSION_ID: 's1', CTM_LEADS_FILE: ctx.leadsFile, CTM_LEAD_LABEL: '시험 팀장', ...extraEnv },
  });
  const dm = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(r.stdout);
  return { r, data: dm ? JSON.parse(dm[1]) : null, out: r.stdout };
}
// 질의 방식: 요청(객체 또는 글자)을 CTM_REQUEST로 넘겨 JSON 응답을 받는다
function call(ctx, req) {
  mk(ctx.tmp);
  const r = spawnSync(process.execPath, [ctx.scriptFile], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TMPDIR: ctx.tmp, TEMP: ctx.tmp, TMP: ctx.tmp, CTM_LEAD_DIR: ctx.lead, CTM_LEAD_ID: 'L1', CTM_SESSION_ID: 's1', CTM_LEADS_FILE: ctx.leadsFile, CTM_REQUEST: typeof req === 'string' ? req : JSON.stringify(req) },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('페이지 방식: 팀장·팀원 저장소와 전체 브랜치 목록을 담고, 오류 폴더는 오류로 표시하며, 같은 저장소(워크트리)는 하나로 묶는다', () => {
  const ctx = setup();
  const { r, data, out } = run(ctx);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(data, '데이터 JSON이 출력에 없다: ' + out.slice(0, 300));
  const repos = data.repos;
  const roles = repos.map(x => x.role);
  assert.ok(roles.indexOf('팀장(설계)') === roles.length - 1, roles.join(','));
  assert.ok(roles[0].includes('팀원'), roles.join(','));
  assert.deepStrictEqual(repos.filter(x => x.err).map(x => x.err).sort(), ['git 저장소가 아닙니다', '폴더가 없습니다'].sort());
  const good = repos.filter(x => !x.err);
  assert.strictEqual(good.length, 2, '정상 저장소는 팀원 1 + 팀장 1이어야 한다(중복 승인 경로는 하나로)');
  const member = good.find(x => x.role.includes('팀원'));
  assert.strictEqual(member.wts.length, 2, '워크트리 목록');
  assert.deepStrictEqual(member.branches.map(b => b.n).sort(), ['feature', 'main', 'wt-branch'], '모든 브랜치가 목록에 있어야 한다(워크트리가 아닌 feature도)');
  assert.strictEqual(member.all.n, 3, '"전체 브랜치" 그래프 커밋 수(구현 2 + 워크트리 1)');
  assert.ok(member.wts.every(w => w.bf || w.hf), '워크트리 행은 눌러서 불러올 대상(브랜치 이름 또는 커밋)을 가져야 한다');
  assert.strictEqual(good.find(x => x.role.includes('설계')).all.n, 3);
  assert.ok(!('graphs' in member), '브랜치별 그래프는 미리 담지 않고 누를 때 불러온다');
});

test('페이지 방식: 한글 파일 이름과 변경 파일 목록이 정확하다', () => {
  const ctx = setup();
  const { data } = run(ctx);
  const member = data.repos.find(x => !x.err && x.role.includes('팀원'));
  const allFiles = Object.values(member.commits).flatMap(c => c.files).map(f => f.p);
  assert.ok(allFiles.includes('한글.txt'), '따옴표/이스케이프 없이 한글 파일명이 나와야 한다: ' + allFiles.join(','));
  assert.ok(allFiles.includes('w.txt'), '워크트리 커밋의 파일도 있어야 한다');
});

test('두 번째 실행은 캐시를 쓰고 결과가 같으며, 캐시가 깨져도 결과가 같고, 새 커밋은 바로 보인다', () => {
  const ctx = setup();
  const first = run(ctx);
  const cache = path.join(ctx.tmp, 'ctm-git-graph-files.json');
  assert.ok(fs.existsSync(cache), '캐시 파일이 만들어져야 한다');
  const strip = d => JSON.stringify(d, (k, v) => (k === 'at' ? undefined : v));
  const second = run(ctx);
  assert.strictEqual(strip(second.data), strip(first.data), '캐시를 써도 결과가 같아야 한다');
  fs.writeFileSync(cache, '{ 깨진 json');
  const third = run(ctx);
  assert.strictEqual(third.r.status, 0);
  assert.strictEqual(strip(third.data), strip(first.data), '캐시가 깨져도 결과가 같아야 한다');
  fs.writeFileSync(path.join(ctx.lead, 'new.txt'), 'n'); git(ctx.lead, 'add', '-A'); git(ctx.lead, 'commit', '-q', '-m', '새 커밋');
  const fourth = run(ctx);
  const leadRepo = fourth.data.repos.find(x => !x.err && x.role.includes('설계'));
  assert.strictEqual(leadRepo.all.n, 4, '캐시가 있어도 새 커밋이 바로 보여야 한다');
  assert.ok(Object.values(leadRepo.commits).flatMap(c => c.files).some(f => f.p === 'new.txt'));
});

test('질의 방식: 브랜치 목록 새로고침(refs)이 새 브랜치를 바로 보여 준다(캐시로 낡지 않는다)', () => {
  const ctx = setup();
  const before = call(ctx, { op: 'refs', repo: ctx.memberA });
  assert.strictEqual(before.ok, true);
  assert.deepStrictEqual(before.branches.map(b => b.n).sort(), ['feature', 'main', 'wt-branch']);
  git(ctx.memberA, 'branch', 'brand-new');
  const after = call(ctx, { op: 'refs', repo: ctx.memberA });
  assert.ok(after.branches.some(b => b.n === 'brand-new'), '새 브랜치가 바로 목록에 있어야 한다');
  assert.notStrictEqual(after.fp, before.fp, '브랜치 목록이 바뀌면 지문(fp)도 바뀐다');
});

test('질의 방식: 브랜치별 그래프, 더 보기(limit), 새 커밋 반영(tip)', () => {
  const ctx = setup();
  // 커밋 15개짜리 브랜치
  git(ctx.memberA, 'checkout', '-q', '-b', 'long');
  for (let i = 0; i < 15; i++) { fs.writeFileSync(path.join(ctx.memberA, `f${i}.txt`), String(i)); git(ctx.memberA, 'add', '-A'); git(ctx.memberA, 'commit', '-q', '-m', `긴 브랜치 ${i}`); }
  git(ctx.memberA, 'checkout', '-q', 'main');
  const g10 = call(ctx, { op: 'graph', repo: ctx.memberA, rev: 'refs/heads/long', limit: 10 });
  assert.strictEqual(g10.ok, true);
  assert.strictEqual(g10.n, 10); assert.strictEqual(g10.more, true, '더 있으면 more=true');
  const g20 = call(ctx, { op: 'graph', repo: ctx.memberA, rev: 'refs/heads/long', limit: 20 });
  assert.strictEqual(g20.n, 17); assert.strictEqual(g20.more, false, '끝까지 가져왔으면 more=false(2 + 15)');
  assert.ok(Object.keys(g20.commits).length === 17 && g20.c.every(c => g20.commits[c[0]]), '그래프의 모든 커밋에 내용이 있어야 한다');
  const other = call(ctx, { op: 'graph', repo: ctx.memberA, rev: 'refs/heads/feature', limit: 50 });
  assert.strictEqual(other.n, 2, '브랜치마다 자기 기록만 — feature는 main과 같은 2개');
  // 새 커밋이 생기면 같은 요청이 바로 새 tip과 새 커밋을 돌려준다
  git(ctx.memberA, 'checkout', '-q', 'long'); fs.writeFileSync(path.join(ctx.memberA, 'late.txt'), 'late'); git(ctx.memberA, 'add', '-A'); git(ctx.memberA, 'commit', '-q', '-m', '나중 커밋'); git(ctx.memberA, 'checkout', '-q', 'main');
  const g20b = call(ctx, { op: 'graph', repo: ctx.memberA, rev: 'refs/heads/long', limit: 20 });
  assert.notStrictEqual(g20b.tip, g20.tip, '브랜치 끝이 바뀌면 tip이 달라 화면이 "새 커밋"을 알 수 있다');
  assert.strictEqual(g20b.n, 18);
  assert.ok(Object.values(g20b.commits).some(c => c.subject === '나중 커밋'));
});

test('질의 방식: 잘못된/악의적 요청은 거절하고 아무 일도 하지 않는다', () => {
  const ctx = setup();
  const pwned = path.join(ctx.base, 'pwned.txt');
  const bad = [
    { op: 'graph', repo: path.join(os.tmpdir()), rev: '', limit: 10 },                 // 허용되지 않은 저장소
    { op: 'graph', repo: ctx.memberA + '/..', rev: '', limit: 10 },                      // 경로로 벗어나기
    { op: 'graph', repo: ctx.notGit, rev: '', limit: 10 },                               // git 저장소가 아님
    { op: 'graph', repo: ctx.memberA, rev: '--output=' + pwned, limit: 10 },             // 옵션 주입
    { op: 'graph', repo: ctx.memberA, rev: 'main; calc.exe', limit: 10 },                // 셸 문자
    { op: 'graph', repo: ctx.memberA, rev: 'refs/heads/없는브랜치', limit: 10 },
    { op: 'graph', repo: ctx.memberA, rev: 'deadbeefdeadbeef', limit: 10 },              // 없는 커밋 해시
    { op: 'bogus', repo: ctx.memberA },
    '{깨진 json', '"문자열만"', '[]', 'null',
  ];
  for (const req of bad) {
    const res = call(ctx, req);
    assert.strictEqual(res.ok, false, JSON.stringify(req) + ' → ' + JSON.stringify(res).slice(0, 120));
    assert.ok(typeof res.error === 'string' && res.error.length > 0);
  }
  assert.ok(!fs.existsSync(pwned), '옵션 주입으로 파일이 만들어졌다');
  // limit 상한: 터무니없는 값도 상한으로 줄여 처리한다
  const big = call(ctx, { op: 'graph', repo: ctx.memberA, rev: '', limit: 99999999 });
  assert.strictEqual(big.ok, true); assert.ok(big.limit <= 2000);
});

test('팀장 폴더가 git 저장소가 아니면 안내 문구를 내고 정상 종료한다', () => {
  const ctx = setup();
  fs.writeFileSync(ctx.leadsFile, '[]');
  const { r, out } = run(ctx, { CTM_LEAD_DIR: ctx.notGit });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(out.includes('git 저장소가 아닙니다'), out.slice(0, 300));
});

test('팀장을 고르지 않으면 안내만 출력한다(질의 방식에서는 오류 JSON)', () => {
  const ctx = setup();
  const { r, out } = run(ctx, { CTM_LEAD_DIR: '' });
  assert.strictEqual(r.status, 0);
  assert.ok(out.includes('팀장을 선택하세요'));
  const q = spawnSync(process.execPath, [ctx.scriptFile], { encoding: 'utf8', env: { ...process.env, CTM_LEAD_DIR: '', CTM_REQUEST: '{"op":"refs"}' } });
  assert.strictEqual(JSON.parse(q.stdout).ok, false);
});

test('저장소와 브랜치가 많아도 페이지가 한도 안이고, 모든 브랜치가 목록에 있으며, 브랜치 그래프는 질의로 불러온다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-gg-big-'));
  const REPOS = 6, BRANCHES = 8, PER = 30, FILES = 25;
  const dirs = [];
  for (let r = 0; r < REPOS; r++) {
    const d = path.join(base, 'repo' + r); mk(d); dirs.push(d);
    git(d, 'init', '-q', '-b', 'main');
    let stream = ''; let mark = 1;
    for (let b = 0; b < BRANCHES; b++) {
      const ref = b === 0 ? 'refs/heads/main' : 'refs/heads/feat' + b;
      for (let c = 0; c < PER; c++) {
        stream += `commit ${ref}\nmark :${mark}\ncommitter t <t@t> ${1700000000 + b * 1000 + c} +0000\ndata <<EOM\n긴 커밋 제목 ${b}-${c} — 데이터 크기를 키우기 위한 문장입니다 abcdefghijklmnopqrstuvwxyz\nEOM\n`;
        if (c > 0) stream += `from :${mark - 1}\n`;
        for (let f = 0; f < FILES; f++) stream += `M 100644 inline src/module${b}/dir${f % 5}/파일_${f}_${c}.js\ndata 2\nx\n`;
        mark++;
      }
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: d, input: stream, stdio: ['pipe', 'ignore', 'pipe'] });
    git(d, 'checkout', '-q', '-f', 'main');
    for (let b = 1; b < BRANCHES; b++) git(d, 'worktree', 'add', '-q', path.join(base, `wt${r}_${b}`), 'feat' + b);
  }
  const leadsFile = path.join(base, 'leads.json');
  fs.writeFileSync(leadsFile, JSON.stringify([{ id: 'L1', sessionId: 's1', targetDir: dirs[0], approvedMembers: dirs.slice(1) }]));
  const scriptFile = path.join(base, 'graph.js'); fs.writeFileSync(scriptFile, SCRIPT);
  const ctx = { tmp: path.join(base, 'tmp'), lead: dirs[0], leadsFile, scriptFile, base };
  const { r, data, out } = run(ctx);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(out.length < 1000000, `출력 ${out.length}자가 한도를 넘는다`);
  assert.ok(out.trimEnd().endsWith('</script>'), '끝의 화면 코드가 잘리면 안 된다');
  assert.strictEqual(data.repos.filter(x => !x.err).length, REPOS);
  for (const repo of data.repos) {
    assert.strictEqual(repo.branches.length, BRANCHES, repo.name + ': 모든 브랜치가 목록에 있어야 한다');
    assert.ok(repo.all && repo.all.n > 0);
    assert.strictEqual(repo.wts.filter(w => w.bf).length, BRANCHES, repo.name + ': 워크트리 행이 모두 눌러서 불러올 대상을 가져야 한다');
  }
  // 어느 저장소의 어떤 브랜치든 질의로 불러온다
  const rr = data.repos[3];
  const g = call(ctx, { op: 'graph', repo: rr.dir, rev: rr.branches.find(b => b.n === 'feat5').f, limit: 100 });
  assert.strictEqual(g.ok, true); assert.strictEqual(g.n, PER);
  assert.ok(JSON.stringify(g).length < 900000);
});
