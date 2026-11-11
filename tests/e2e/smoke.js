// 실제 앱 화면 E2E 점검(Windows 전용 — WebView2). 빌드한 exe를 별도 프로필로 띄워서 Chrome DevTools 프로토콜(CDP)로 화면을 조작·확인한다.
//
// 쓰는 법:   npm run tauri:build && npm run test:e2e
//   CTM_EXE=<exe 경로>               기본: src-tauri/target/release/app.exe (없으면 "Claude Team Monitor.exe")
//   CTM_E2E_SINGLE_INSTANCE=1        단일 실행 보호까지 확인한다(이미 앱이 켜져 있는 PC에서는 그 창을 건드리므로 기본은 건너뜀 — CI에서만 켠다)
//
// 안전: 앱 데이터(APPDATA)와 WebView 프로필을 임시 폴더로 돌리고 CTM_ALLOW_MULTI=1로 띄우므로 이미 실행 중인 앱과 부딪히지 않는다.
//       단 ~/.claude(팀장 기록)는 읽기만 하며, 이 시험은 팀장을 만들거나 지우지 않는다. claude CLI가 없어도 통과하도록 썼다.
// 알려진 제약: USERPROFILE을 임시 폴더로 바꾼 셸에서는 WebView2의 원격 디버그 포트가 열리지 않는다(앱은 뜨지만 이 시험이 연결하지 못함). APPDATA만 바꾸는 것은 괜찮다.
// 프레임워크 없이 node만으로 돈다(Node 22의 내장 WebSocket 사용).
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const REPO = path.join(__dirname, '..', '..');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const results = [];
const children = [];
const tmpDirs = [];

function pickExe() {
  if (process.env.CTM_EXE) return path.resolve(process.env.CTM_EXE);
  for (const n of ['app.exe', 'Claude Team Monitor.exe']) {
    const p = path.join(REPO, 'src-tauri', 'target', 'release', n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });
function tmp(prefix) { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; }

function launch({ exe, port, appdata, wv, allowMulti }) {
  const env = { ...process.env, APPDATA: appdata, WEBVIEW2_USER_DATA_FOLDER: wv, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
  if (allowMulti) env.CTM_ALLOW_MULTI = '1'; else delete env.CTM_ALLOW_MULTI;
  const child = spawn(exe, [], { env, stdio: 'ignore', windowsHide: false });
  child.exitCode_ = null; child.spawnError_ = null;
  child.on('exit', c => { child.exitCode_ = c === null ? 'signal' : c; });
  child.on('error', e => { child.spawnError_ = e.message; });
  children.push(child);
  return child;
}

async function connect(port, timeoutMs = 90000, child = null) {
  const t0 = Date.now();
  let ver;
  while (Date.now() - t0 < timeoutMs) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(500); }
  }
  if (!ver) {
    const state = !child ? '' : child.spawnError_ ? ` — 앱 실행 실패: ${child.spawnError_}` : child.exitCode_ !== null ? ` — 앱 프로세스가 종료 코드 ${child.exitCode_}로 끝났습니다(뜨자마자 죽음)` : ' — 앱 프로세스는 살아 있는데 포트가 안 열렸습니다(WebView2 초기화 실패 가능)';
    const homeNote = process.env.USERPROFILE && os.homedir() !== process.env.USERPROFILE ? ' (참고: USERPROFILE이 바뀐 셸에서는 WebView2 디버그 포트가 열리지 않을 수 있습니다 — 원래 셸에서 다시 실행해 보세요)' : '';
    throw new Error('앱의 디버그 포트가 열리지 않았습니다' + state + homeNote);
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (sessionId, method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
  // 페이지 타겟이 나타날 때까지 기다린다
  let page;
  for (let i = 0; i < 120 && !page; i++) {
    page = (await send(null, 'Target.getTargets')).result.targetInfos.find(t => t.type === 'page' && /tauri\.localhost|localhost/.test(t.url));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('앱 화면(페이지)을 찾지 못했습니다');
  const session = (await send(null, 'Target.attachToTarget', { targetId: page.targetId, flatten: true })).result.sessionId;
  const evalIn = async (expr, sess) => {
    const r = (await send(sess || session, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result;
    if (r.exceptionDetails) throw new Error('화면 스크립트 오류: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const frameSession = async match => {
    const t = (await send(null, 'Target.getTargets')).result.targetInfos.find(x => String(x.url).includes(match));
    return t ? (await send(null, 'Target.attachToTarget', { targetId: t.targetId, flatten: true })).result.sessionId : null;
  };
  return { eval: evalIn, frameSession, close: () => ws.close() };
}

async function check(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}
const ok = (cond, msg) => { if (!cond) throw new Error(msg); };

function killAll() {
  for (const c of children) {
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); else c.kill('SIGKILL'); } catch { /* 이미 끝남 */ }
  }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 잠겨 있으면 OS가 나중에 정리 */ } }
}

async function main() {
  if (process.platform !== 'win32') { console.log('E2E는 Windows(WebView2)에서만 돕니다 — 건너뜁니다.'); return 0; }
  const exe = pickExe();
  if (!exe || !fs.existsSync(exe)) { console.error('앱 exe를 찾지 못했습니다. 먼저 `npm run tauri:build`를 하거나 CTM_EXE로 경로를 알려 주세요.'); return 2; }
  console.log(`앱: ${exe}\n`);
  const port = await freePort();
  const first = launch({ exe, port, appdata: tmp('ctm-e2e-appdata-'), wv: tmp('ctm-e2e-wv-'), allowMulti: true });
  const app = await connect(port, 90000, first);
  await sleep(1500);

  console.log('화면·보안');
  await check(`제목과 버전 표시가 package.json(${pkgVersion})과 같다`, async () => {
    ok((await app.eval('document.title')) === 'Claude Team Monitor', '창 제목이 다릅니다');
    const v = await app.eval("document.getElementById('version-btn').textContent");
    ok(v.includes(`v${pkgVersion}`), `버전 표시가 다릅니다: ${v}`);
  });
  await check('인라인 스크립트가 CSP로 막힌다', async () => {
    const blocked = await app.eval("new Promise(res => { window.__x = 0; const s = document.createElement('script'); s.textContent = 'window.__x = 1'; document.body.appendChild(s); setTimeout(() => res(window.__x === 0), 200); })");
    ok(blocked === true, '인라인 스크립트가 실행됐습니다');
  });
  await check('외부 주소로의 fetch가 CSP로 막힌다', async () => {
    const r = await app.eval("fetch('https://example.com').then(() => 'allowed').catch(() => 'blocked')");
    ok(r === 'blocked', `외부 접속이 허용됐습니다: ${r}`);
  });

  console.log('\n접근성');
  await check('화면 탭이 tablist/tab 역할과 aria-selected를 갖고 클릭하면 바뀐다', async () => {
    const roles = await app.eval("JSON.stringify({ list: document.querySelector('nav.tabs').getAttribute('role'), tabs: [...document.querySelectorAll('.tab-btn')].map(b => b.getAttribute('role')) })");
    const r = JSON.parse(roles);
    ok(r.list === 'tablist' && r.tabs.length === 5 && r.tabs.every(x => x === 'tab'), roles);
    await app.eval("document.querySelector('.tab-btn[data-tab=\"history\"]').click(); 1");
    const sel = await app.eval("[...document.querySelectorAll('.tab-btn')].map(b => b.getAttribute('aria-selected')).join(',')");
    ok(sel === 'false,true,false,false,false', `aria-selected: ${sel}`);
    await app.eval("document.querySelector('.tab-btn[data-tab=\"work\"]').click(); 1");
  });
  await check('모달 패널은 전부 대화상자 역할이고 아이콘 버튼에 이름이 있다', async () => {
    const r = JSON.parse(await app.eval("JSON.stringify({ dialogs: document.querySelectorAll('.modal-panel[role=dialog][aria-modal=true]').length, all: document.querySelectorAll('.modal-panel').length, help: document.getElementById('help-btn').getAttribute('aria-label'), theme: document.getElementById('theme-toggle-btn').getAttribute('aria-label') })"));
    ok(r.dialogs === r.all && r.all >= 5 && r.help && r.theme, JSON.stringify(r));
  });

  console.log('\n도움말');
  await check('도움말 탭 12개가 있고 탭마다 해당 항목 하나만 보인다', async () => {
    await app.eval("document.getElementById('help-btn').click(); 1");
    await sleep(300);
    const keys = JSON.parse(await app.eval("JSON.stringify([...document.querySelectorAll('#help-tabs [data-help-tab]')].map(b => b.dataset.helpTab))"));
    ok(keys.length === 12, `탭 수 ${keys.length}`);
    for (const k of keys) {
      await app.eval(`document.querySelector('#help-tabs [data-help-tab="${k}"]').click(); 1`);
      const shown = JSON.parse(await app.eval("JSON.stringify([...document.querySelectorAll('.help-section')].filter(s => getComputedStyle(s).display !== 'none').map(s => s.dataset.help))"));
      ok(shown.length === 1 && shown[0] === k, `${k}: ${JSON.stringify(shown)}`);
    }
  });

  console.log('\n스크립트 슬롯(새 사용자 기본 꺼짐 → 허용 → 실행 → 끄면 차단)');
  const script = "console.log('## E2E'); console.log('ok')";
  const slot = JSON.stringify({ name: 'e2e', mode: 'script', scope: 'all', preset: 'artifact-reports', instruction: '', autoUpdate: false, aiModel: 'sonnet', aiInclude: 'none', enabled: true, interpreter: 'node', script, timeoutMs: 8000, outputFormat: 'markdown', allowJs: false });
  await check('처음에는 꺼져 있고 저장·시험 실행이 막힌다', async () => {
    const cfg = JSON.parse(await app.eval('(async () => JSON.stringify(await window.api.getPanelConfig()))()'));
    ok(cfg.scriptsAllowed === false && cfg.slots.length === 0, `초기 설정: ${JSON.stringify(cfg)}`);
    const save = await app.eval(`window.api.savePanelSlot(${slot}).then(() => 'SAVED', e => String(e))`);
    const test = await app.eval(`window.api.testPanelScript('node', ${JSON.stringify(script)}, 8000, null, 'markdown', false).then(() => 'RAN', e => String(e))`);
    ok(/꺼져 있습니다/.test(save) && /꺼져 있습니다/.test(test), `save=${save} test=${test}`);
  });
  await check('화면에서 허용을 켜면(확인창 승인) 시험 실행과 저장이 된다', async () => {
    await app.eval("document.querySelector('.tab-btn[data-tab=\"app-settings\"]').click(); showSettingsSection('panel'); window.confirm = () => true; document.getElementById('panel-scripts-input').click(); 1");
    await sleep(800);
    const cfg = JSON.parse(await app.eval('(async () => JSON.stringify(await window.api.getPanelConfig()))()'));
    ok(cfg.scriptsAllowed === true, '허용이 켜지지 않았습니다');
    const out = await app.eval(`window.api.testPanelScript('node', ${JSON.stringify(script)}, 8000, null, 'markdown', false).then(x => x.output.trim().replace(/\\n/g, ' | '), e => 'ERR ' + e)`);
    ok(out === '## E2E | ok', `시험 실행 결과: ${out}`);
    const saved = await app.eval(`window.api.savePanelSlot(${slot}).then(c => c.slots.length, e => 'ERR ' + e)`);
    ok(saved === 1, `저장 결과: ${saved}`);
  });
  await check('다시 끄면 이미 만든 슬롯도 실행되지 않는다', async () => {
    await app.eval("document.getElementById('panel-scripts-input').click(); 1");
    await sleep(800);
    const id = await app.eval('(async () => (await window.api.getPanelConfig()).slots[0].id)()');
    const text = await app.eval(`window.api.getPanelContent(${JSON.stringify(id)}, null, true).then(x => x.markdown + ' || ' + x.note)`);
    ok(/꺼져 있습니다/.test(text), text);
  });

  console.log('\n스크립트 그래픽(격리 프레임)');
  await check('JavaScript 허용 슬롯의 프레임: 스크립트는 돌지만 네트워크·부모 접근은 막힌다', async () => {
    await app.eval('window.api.setScriptsEnabled(true)');
    // 데이터를 빼내려는 "주소 이동" 시도(location 변경·window.open·이미지·링크)가 이 PC의 로컬 서버에 닿는지 센다.
    const hits = [];
    const sink = require('node:http').createServer((req, res) => { hits.push(req.url); res.end('x'); });
    await new Promise(r => sink.listen(0, '127.0.0.1', r));
    const sinkBase = `http://127.0.0.1:${sink.address().port}`;
    const frameScript = [
      "console.log('<div id=\"out\">정적</div>');",
      "console.log('<script>', \"document.getElementById('out').textContent = 'JS 실행됨';\",",
      "  \"window.__info = { ctm: typeof window.ctm, parent: (() => { try { return typeof window.parent.document } catch (e) { return 'blocked' } })() };\",",
      "  \"setTimeout(function(){ try { location.href = '" + sinkBase + "/nav'; } catch (e) {} }, 1200);\",",
      "  \"try { window.open('" + sinkBase + "/open'); } catch (e) {}\",",
      "  \"var im = new Image(); im.src = '" + sinkBase + "/img'; var lk = document.createElement('link'); lk.rel = 'prefetch'; lk.href = '" + sinkBase + "/link'; document.head.appendChild(lk);\",",
      "  \"fetch('https://example.com').then(() => { window.__fetch = 'allowed' }).catch(() => { window.__fetch = 'blocked' });\",",
      "  '<' + '/script>');",
    ].join('\n');
    await app.eval(`(() => { const m = document.getElementById('ps-mode'); m.value = 'script'; m.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('ps-interp').value = 'node'; document.getElementById('ps-format').value = 'html'; const js = document.getElementById('ps-allow-js'); js.checked = true; js.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('ps-script').value = ${JSON.stringify(frameScript)}; document.getElementById('ps-test-btn').click(); return 1 })()`);
    let fs_ = null;
    for (let i = 0; i < 30 && !fs_; i++) { await sleep(500); fs_ = await app.frameSession('ctmframe'); }
    ok(fs_, '격리 프레임이 뜨지 않았습니다');
    await sleep(800);
    const r = JSON.parse(await app.eval("JSON.stringify({ text: document.getElementById('out') && document.getElementById('out').textContent, info: window.__info, fetch: window.__fetch })", fs_));
    ok(r.text === 'JS 실행됨', `프레임 안 스크립트가 실행되지 않았습니다: ${JSON.stringify(r)}`);
    ok(r.info && r.info.ctm === 'object' && r.info.parent === 'blocked' && r.fetch === 'blocked', `격리가 새고 있습니다: ${JSON.stringify(r)}`);
    await sleep(3500); // 1.2초 뒤 시도하는 주소 이동까지 기다린다
    sink.close();
    ok(hits.length === 0, `프레임이 바깥 주소로 요청을 보냈습니다: ${JSON.stringify(hits)}`);
  });

  console.log('\n그래픽이 스크립트를 다시 부르기(ctm.call)');
  await check('ctm.call: 요청이 CTM_REQUEST로 가고 출력이 돌아오며, 실패·큰 응답·동시 요청·허용 안 된 슬롯은 거절된다', async () => {
    await app.eval('(async () => { const c = await window.api.getPanelConfig(); for (const sl of c.slots) await window.api.deletePanelSlot(sl.id); })()');
    const callScript = [
      "if (process.env.CTM_REQUEST) {",
      "  const r = JSON.parse(process.env.CTM_REQUEST);",
      "  if (r.op === 'fail') { console.error('boom'); process.exit(3); }",
      "  if (r.op === 'big') { console.log('x'.repeat(1100000)); process.exit(0); }",
      "  if (r.op === 'slow') { setTimeout(() => { console.log(JSON.stringify({ slow: true })); }, 1500); return; }",
      "  console.log(JSON.stringify({ pong: r.x, han: r.han || null, page: false }));",
      "  return;",
      "}",
      "console.log('<div id=\"out\">대기</div>');",
      "console.log('<script>', \"window.__run = function (req) { return ctm.call(req).then(function (x) { return 'OK:' + x; }, function (e) { return 'ERR:' + e.message; }); };\", '<' + '/script>');",
    ].join('\n');
    const mk = (extra) => JSON.stringify(Object.assign({ name: 'callslot', mode: 'script', scope: 'all', preset: 'artifact-reports', instruction: '', autoUpdate: false, aiModel: 'sonnet', aiInclude: 'none', enabled: true, interpreter: 'node', script: callScript, timeoutMs: 8000, outputFormat: 'html', allowJs: true }, extra || {}));
    const saved = JSON.parse(await app.eval(`window.api.savePanelSlot(${mk()}).then(c => JSON.stringify(c.slots.map(s => s.id)))`));
    const slotId = saved[saved.length - 1];
    // API 직통: 정상
    const direct = await app.eval(`window.api.callPanelScript(${JSON.stringify(slotId)}, null, ${JSON.stringify(JSON.stringify({ op: 'x', x: 7, han: '한글 "따옴표"' }))}).then(x => x, e => 'ERR:' + e)`);
    const dv = JSON.parse(direct);
    ok(dv.pong === 7 && dv.han === '한글 "따옴표"' && dv.page === false, `요청이 스크립트에 그대로 전달되지 않았습니다: ${direct}`);
    const failed = await app.eval(`window.api.callPanelScript(${JSON.stringify(slotId)}, null, ${JSON.stringify(JSON.stringify({ op: 'fail' }))}).then(x => 'OK:' + x, e => 'ERR:' + e)`);
    ok(/^ERR:/.test(failed) && failed.includes('종료 코드 3') && failed.includes('boom'), `스크립트 실패가 오류로 오지 않았습니다: ${failed}`);
    const big = await app.eval(`window.api.callPanelScript(${JSON.stringify(slotId)}, null, ${JSON.stringify(JSON.stringify({ op: 'big' }))}).then(x => 'OK:' + x.length, e => 'ERR:' + e)`);
    ok(/^ERR:/.test(big) && big.includes('넘어'), `너무 큰 응답이 오류로 오지 않았습니다: ${big.slice(0, 120)}`);
    const longReq = await app.eval(`window.api.callPanelScript(${JSON.stringify(slotId)}, null, 'x'.repeat(20001)).then(x => 'OK', e => 'ERR:' + e)`);
    ok(/^ERR:/.test(longReq) && longReq.includes('너무 깁니다'), `긴 요청이 거절되지 않았습니다: ${longReq}`);
    const nope = await app.eval(`window.api.callPanelScript('slot-없음', null, '{}').then(x => 'OK', e => 'ERR:' + e)`);
    ok(/^ERR:/.test(nope), '없는 슬롯이 거절되지 않았습니다');
    // 허용되지 않은 슬롯(JavaScript 허용 꺼짐)
    const nojs = JSON.parse(await app.eval(`window.api.savePanelSlot(${mk({ name: 'nojs', allowJs: false })}).then(c => JSON.stringify(c.slots.map(s => s.id)))`));
    const nojsId = nojs[nojs.length - 1];
    const denied = await app.eval(`window.api.callPanelScript(${JSON.stringify(nojsId)}, null, '{}').then(x => 'OK', e => 'ERR:' + e)`);
    ok(/^ERR:/.test(denied) && denied.includes('ctm.call을 쓸 수 없습니다'), `JS 허용이 꺼진 슬롯이 거절되지 않았습니다: ${denied}`);
    // 화면 경로: 프레임 안에서 ctm.call
    await app.eval(`document.querySelector('.tab-btn[data-tab="work"]').click(); 1`); await sleep(300); // 패널은 작업 탭에서만 보인다
    await app.eval(`(async () => { await window.api.setPanelEnabled(true); panelConfig = await window.api.getPanelConfig(); panelActiveId = ${JSON.stringify(slotId)}; try { localStorage.setItem('ctm.panelCollapsed', '0'); } catch (e) {} renderPanelChrome(); await refreshPanelContent(true, true); return 1 })()`);
    let fsx = null;
    for (let i = 0; i < 40 && !fsx; i++) { await sleep(500); fsx = await app.frameSession('ctmframe'); }
    ok(fsx, '패널 그래픽 프레임이 뜨지 않았습니다');
    await sleep(800);
    const r1 = await app.eval(`window.__run({op:'x',x:42})`, fsx);
    ok(r1 === 'OK:' + JSON.stringify({ pong: 42, han: null, page: false }), `프레임 안 ctm.call 결과가 다릅니다: ${r1}`);
    const r2 = await app.eval(`window.__run({op:'fail'})`, fsx);
    ok(r2.startsWith('ERR:') && r2.includes('종료 코드 3'), `프레임 안에서 실패가 거부로 오지 않았습니다: ${r2}`);
    // 동시에 둘: 하나는 처리, 하나는 '너무 잦습니다'
    const both = JSON.parse(await app.eval(`Promise.all([window.__run({op:'slow'}), window.__run({op:'x',x:1})]).then(a => JSON.stringify(a))`, fsx));
    ok(both.some(x => x.startsWith('OK:')) && both.some(x => x.startsWith('ERR:') && x.includes('잦습니다')), `동시 요청이 한 번에 하나만 처리되지 않았습니다: ${JSON.stringify(both)}`);
    // 왕복 시간(작은 요청 5번)
    const times = [];
    for (let i = 0; i < 5; i++) { const t0 = Date.now(); await app.eval(`window.__run({op:'x',x:${i}})`, fsx); times.push(Date.now() - t0); }
    console.log(`      · 요청 왕복(스크립트 실행 포함, 작은 요청 5번): ${times.join(', ')}ms`);
    ok(Math.max(...times) < 5000, `요청이 너무 느립니다: ${times}`);
    await app.eval('(async () => { const c = await window.api.getPanelConfig(); for (const sl of c.slots) await window.api.deletePanelSlot(sl.id); })()');
  });

  console.log('\n진단·환경');
  await check('진단 정보에 버전과 환경 점검이 들어 있고 스크립트 본문은 없다', async () => {
    const text = await app.eval('window.api.getDiagnostics()');
    ok(text.includes(`v${pkgVersion}`) && text.includes('### 환경 점검') && text.includes('### 설정 요약'), '진단 형식이 다릅니다');
    ok(!text.includes('JS 실행됨') && !text.includes("console.log('## E2E')"), '스크립트 본문이 진단에 들어 있습니다');
  });
  await check('환경 점검 API가 구조화된 결과를 돌려준다(claude가 없어도)', async () => {
    const env = JSON.parse(await app.eval('(async () => JSON.stringify(await window.api.checkEnvironment()))()'));
    ok(env.claude && env.claudeFeatures && env.node && Array.isArray(env.resources) && typeof env.ok === 'boolean', JSON.stringify(Object.keys(env)));
    ok(env.node.blocking === false, 'Node.js는 더 이상 막는 문제가 아닙니다');
  });
  // 이 시험이 만든 슬롯(과 그 스크립트 파일)을 지운다
  await app.eval('(async () => { const c = await window.api.getPanelConfig(); for (const s of c.slots) await window.api.deletePanelSlot(s.id); })()');
  app.close();

  if (process.env.CTM_E2E_SINGLE_INSTANCE === '1') {
    console.log('\n단일 실행 보호');
    await check('같은 앱을 두 번 켜면 두 번째는 바로 끝난다', async () => {
      const p1 = await freePort();
      const one = launch({ exe, port: p1, appdata: tmp('ctm-e2e-si1-'), wv: tmp('ctm-e2e-si1wv-'), allowMulti: false });
      const a = await connect(p1, 90000, one); await sleep(1500); a.close();
      const second = launch({ exe, port: await freePort(), appdata: tmp('ctm-e2e-si2-'), wv: tmp('ctm-e2e-si2wv-'), allowMulti: false });
      const code = await new Promise(res => { const t = setTimeout(() => res('시간 초과(두 번째가 끝나지 않음)'), 20000); second.on('exit', c => { clearTimeout(t); res(c); }); });
      ok(code === 0, `두 번째 실행의 종료 코드: ${code}`);
    });
  } else {
    console.log('\n(단일 실행 보호 점검은 건너뜀 — CTM_E2E_SINGLE_INSTANCE=1로 켜세요)');
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 통과${failed.length ? ` — 실패: ${failed.map(f => f.name).join(' / ')}` : ''}`);
  return failed.length ? 1 : 0;
}

main().then(code => { killAll(); process.exit(code); }, e => { console.error('E2E 중단:', e.message); killAll(); process.exit(1); });
