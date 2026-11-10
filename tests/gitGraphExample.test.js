// 내장 예제 "깃 그래프(팀장+팀원)"를 실제 git 저장소 여러 개에 대해 실행해, 출력 데이터와 오류 처리, 캐시 동작을 확인한다.
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
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [ctx.scriptFile], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TMPDIR: ctx.tmp, TEMP: ctx.tmp, TMP: ctx.tmp, CTM_LEAD_DIR: ctx.lead, CTM_LEAD_ID: 'L1', CTM_SESSION_ID: 's1', CTM_LEADS_FILE: ctx.leadsFile, CTM_LEAD_LABEL: '시험 팀장', ...extraEnv },
  });
  const ms = Date.now() - t0;
  const dm = /<script type="application\/json" id="data">([\s\S]*?)<\/script>/.exec(r.stdout);
  return { r, ms, data: dm ? JSON.parse(dm[1]) : null, out: r.stdout };
}

test('팀장·팀원 저장소를 모두 모으고, 오류 폴더는 오류로 표시하며, 같은 저장소(워크트리)는 하나로 묶는다', () => {
  const ctx = setup();
  const { r, data, out } = run(ctx);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(data, '데이터 JSON이 출력에 없다: ' + out.slice(0, 300));
  const repos = data.repos || data;
  assert.ok(Array.isArray(repos), JSON.stringify(Object.keys(data)));
  const names = repos.map(x => x.name);
  // 팀원 저장소가 먼저, 팀장(설계)이 마지막
  const roles = repos.map(x => x.role);
  assert.ok(roles.indexOf('팀장(설계)') === roles.length - 1, roles.join(','));
  assert.ok(roles[0].includes('팀원'), roles.join(','));
  const bad = repos.filter(x => x.err);
  assert.deepStrictEqual(bad.map(x => x.err).sort(), ['git 저장소가 아닙니다', '폴더가 없습니다'].sort());
  const good = repos.filter(x => !x.err);
  assert.strictEqual(good.length, 2, '정상 저장소는 팀원 1 + 팀장 1이어야 한다(중복 승인 경로는 하나로)');
  const member = good.find(x => x.role.includes('팀원'));
  assert.ok(member.wts.length === 2, '워크트리 목록: ' + member.wts.length);
  assert.ok(Object.keys(member.graphs).length >= 2, '전체 그래프 + 워크트리 그래프');
  assert.strictEqual(member.graphs.all.n, 3, '전체 브랜치 커밋 수(구현 2 + 워크트리 1)');
  assert.ok(member.wts.every(w => w.g), '모든 워크트리(브랜치) 행이 클릭해서 볼 그래프와 연결돼 있어야 한다');
  assert.ok(member.wts.every(w => member.graphs[w.g] && member.graphs[w.g].n >= 1));
  const leadRepo = good.find(x => x.role.includes('설계'));
  assert.strictEqual(leadRepo.graphs.all.n, 3);
});

test('한글 파일 이름과 변경 파일 목록이 정확하다', () => {
  const ctx = setup();
  const { data } = run(ctx);
  const repos = data.repos || data;
  const member = repos.find(x => !x.err && x.role.includes('팀원'));
  const allFiles = Object.values(member.commits).flatMap(c => c.files).map(f => f.p);
  assert.ok(allFiles.includes('한글.txt'), '따옴표/이스케이프 없이 한글 파일명이 나와야 한다: ' + allFiles.join(','));
  assert.ok(allFiles.includes('w.txt'), '워크트리 커밋의 파일도 있어야 한다');
});

test('두 번째 실행은 캐시를 쓰고 결과가 같으며, 캐시가 깨져도 결과가 같다', () => {
  const ctx = setup();
  const first = run(ctx);
  const cache = path.join(ctx.tmp, 'ctm-git-graph-files.json');
  assert.ok(fs.existsSync(cache), '캐시 파일이 만들어져야 한다');
  const second = run(ctx);
  const strip = d => JSON.stringify(d, (k, v) => (k === 'when' ? undefined : v));
  assert.strictEqual(strip(second.data), strip(first.data), '캐시를 써도 결과가 같아야 한다');
  fs.writeFileSync(cache, '{ 깨진 json');
  const third = run(ctx);
  assert.strictEqual(third.r.status, 0);
  assert.strictEqual(strip(third.data), strip(first.data), '캐시가 깨져도 결과가 같아야 한다');
  // 새 커밋이 생기면 그 커밋의 파일만 새로 알아낸다
  fs.writeFileSync(path.join(ctx.lead, 'new.txt'), 'n'); git(ctx.lead, 'add', '-A'); git(ctx.lead, 'commit', '-q', '-m', '새 커밋');
  const fourth = run(ctx);
  const repos = fourth.data.repos || fourth.data;
  const leadRepo = repos.find(x => !x.err && x.role.includes('설계'));
  assert.strictEqual(leadRepo.graphs.all.n, 4);
  assert.ok(Object.values(leadRepo.commits).flatMap(c => c.files).some(f => f.p === 'new.txt'));
});

test('팀장 폴더가 git 저장소가 아니면 안내 문구를 내고 정상 종료한다', () => {
  const ctx = setup();
  fs.writeFileSync(ctx.leadsFile, '[]');
  const { r, out } = run(ctx, { CTM_LEAD_DIR: ctx.notGit });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(out.includes('git 저장소가 아닙니다'), out.slice(0, 300));
});

test('팀장을 고르지 않으면 안내만 출력한다', () => {
  const ctx = setup();
  const { r, out } = run(ctx, { CTM_LEAD_DIR: '' });
  assert.strictEqual(r.status, 0);
  assert.ok(out.includes('팀장을 선택하세요'));
});

test('저장소와 브랜치가 많아도 출력이 한도(200000자) 안에 들고, 모든 저장소의 브랜치 그래프가 연결돼 있다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-gg-big-'));
  const REPOS = 6, BRANCHES = 8, PER = 30, FILES = 25;
  const dirs = [];
  for (let r = 0; r < REPOS; r++) {
    const d = path.join(base, 'repo' + r); mk(d); dirs.push(d);
    git(d, 'init', '-q', '-b', 'main');
    // fast-import로 커밋을 빠르게 만든다: 브랜치마다 PER개, 커밋마다 파일 FILES개를 바꾼다
    let stream = '';
    let mark = 1;
    for (let b = 0; b < BRANCHES; b++) {
      const ref = b === 0 ? 'refs/heads/main' : 'refs/heads/feat' + b;
      for (let c = 0; c < PER; c++) {
        stream += `commit ${ref}
mark :${mark}
committer t <t@t> ${1700000000 + b * 1000 + c} +0000
data <<EOM
긴 커밋 제목 ${b}-${c} — 데이터 크기를 키우기 위한 문장입니다 abcdefghijklmnopqrstuvwxyz
EOM
`;
        if (c > 0) stream += `from :${mark - 1}
`;
        for (let f = 0; f < FILES; f++) stream += `M 100644 inline src/module${b}/dir${f % 5}/파일_${f}_${c}.js
data 2
x
`;
        mark++;
      }
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: d, input: stream, stdio: ['pipe', 'ignore', 'pipe'] });
    git(d, 'checkout', '-q', '-f', 'main');
    for (let b = 1; b < BRANCHES; b++) git(d, 'worktree', 'add', '-q', path.join(base, `wt${r}_${b}`), 'feat' + b);
  }
  const lead = dirs[0];
  const leadsFile = path.join(base, 'leads.json');
  fs.writeFileSync(leadsFile, JSON.stringify([{ id: 'L1', sessionId: 's1', targetDir: lead, approvedMembers: dirs.slice(1) }]));
  const scriptFile = path.join(base, 'graph.js'); fs.writeFileSync(scriptFile, SCRIPT);
  const ctx = { tmp: path.join(base, 'tmp'), lead, leadsFile, scriptFile };
  const { r, data, out } = run(ctx);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(out.length < 200000, `출력 ${out.length}자가 한도를 넘는다`);
  assert.ok(out.includes('</script>') && out.trimEnd().endsWith('</script>'), '끝의 화면 코드가 잘리면 안 된다');
  assert.strictEqual(data.repos.filter(x => !x.err).length, REPOS);
  // 이 정도 규모는 한도를 넘으므로 단계적으로 줄어든다: 첫(기본 선택) 저장소는 브랜치 그래프를 끝까지 유지하고, 줄였다면 화면에 안내문이 있어야 한다.
  const degraded = /브랜치별 그래프는 첫 저장소/.test(out);
  const noBranches = /브랜치별 그래프를 담지 못했습니다/.test(out);
  data.repos.forEach((repo, i) => {
    assert.ok(repo.graphs.all && repo.graphs.all.n > 0);
    if (!noBranches && (i === 0 || !degraded)) assert.ok(repo.wts.every(w => w.g && repo.graphs[w.g]), repo.name + ': 브랜치 행이 그래프와 연결돼야 한다');
  });
  assert.ok(/⚠/.test(out) || data.repos.every(x => x.wts.every(w => w.g)), '줄였다면 안내문이 있어야 한다');
});
