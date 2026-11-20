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
      "console.log('<script>', \"window.__run = function (req) { return ctm.call(req).then(function (x) { return 'OK:' + x; }, function (e) { return 'ERR:' + e.message; }); };\", \"window.__md = function (t) { return ctm.renderMarkdown(t).then(function (h) { return 'OK:' + h; }, function (e) { return 'ERR:' + e.message; }); };\", '<' + '/script>');",
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
    await app.eval(`(async () => { await window.api.setPanelEnabled(true); panelConfig = await window.api.getPanelConfig(); panelLayout = { count: 1, slots: [${JSON.stringify(slotId)}], weights: [], weightsH: [], dir: 'v', pins: [] }; try { localStorage.setItem('ctm.panelCollapsed', '0'); } catch (e) {} renderPanelChrome(); await refreshPanelContent(true, true); return 1 })()`);
    let fsx = null;
    for (let i = 0; i < 40 && !fsx; i++) { await sleep(500); fsx = await app.frameSession('ctmframe'); }
    ok(fsx, '패널 그래픽 프레임이 뜨지 않았습니다');
    await sleep(800);
    const r1 = await app.eval(`window.__run({op:'x',x:42})`, fsx);
    ok(r1 === 'OK:' + JSON.stringify({ pong: 42, han: null, page: false }), `프레임 안 ctm.call 결과가 다릅니다: ${r1}`);
    const r2 = await app.eval(`window.__run({op:'fail'})`, fsx);
    ok(r2.startsWith('ERR:') && r2.includes('종료 코드 3'), `프레임 안에서 실패가 거부로 오지 않았습니다: ${r2}`);
    // 프레임 안 ctm.renderMarkdown: 앱의 변환기로 서식 있는 HTML을 받고, HTML은 이스케이프되며, 너무 긴 글·글자가 아닌 값은 거부된다
    const md1 = await app.eval(`window.__md('# 제목\\n- [x] 끝\\n  - 안쪽\\n<script>x</script>')`, fsx);
    ok(md1.startsWith('OK:') && md1.includes('<h2>제목</h2>') && md1.includes('<ul><li>☑ 끝<ul><li>안쪽</li></ul></li></ul>') && md1.includes('&lt;script&gt;') && !md1.includes('<script'), `마크다운 변환이 다릅니다: ${md1}`);
    const mdBig = await app.eval(`window.__md('x'.repeat(400001))`, fsx);
    ok(mdBig.startsWith('ERR:') && mdBig.includes('너무 깁니다'), `너무 긴 글이 거부되지 않았습니다: ${mdBig.slice(0, 80)}`);
    const mdBad = await app.eval(`window.__md(5)`, fsx);
    ok(mdBad.startsWith('ERR:') && mdBad.includes('글자만'), `글자가 아닌 값이 거부되지 않았습니다: ${mdBad}`);
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

  console.log('\n화면 분할');
  await check('오른쪽 패널을 1~최대 개수 칸으로 나누고, 칸마다 슬롯을 따로 고르며, 경계선을 끌어 칸 높이를 조절하고, 최대 개수 설정이 반영된다', async () => {
    await app.eval('(async () => { const c = await window.api.getPanelConfig(); for (const sl of c.slots) await window.api.deletePanelSlot(sl.id); })()');
    const mkSlot = (name, text) => JSON.stringify({ name, mode: 'script', scope: 'all', preset: 'artifact-reports', instruction: '', autoUpdate: false, aiModel: 'sonnet', aiInclude: 'none', enabled: true, interpreter: 'node', script: `console.log(${JSON.stringify(text)})`, timeoutMs: 8000, outputFormat: 'markdown', allowJs: false });
    await app.eval(`window.api.savePanelSlot(${mkSlot('슬롯A', '# 슬롯 A 내용')}).then(() => 1)`);
    await app.eval(`window.api.savePanelSlot(${mkSlot('슬롯B', '# 슬롯 B 내용')}).then(() => 1)`);
    await app.eval(`document.querySelector('.tab-btn[data-tab="work"]').click(); 1`); await sleep(300);
    const ids = JSON.parse(await app.eval(`(async () => { await window.api.setPanelEnabled(true); panelConfig = await window.api.getPanelConfig(); try { localStorage.setItem('ctm.panelCollapsed', '0'); localStorage.removeItem('ctm.panelMaxSplit'); localStorage.removeItem('ctm.panelLayout'); } catch (e) {} panelLayout = { count: 1, slots: [], weights: [], weightsH: [], dir: 'v', pins: [] }; renderPanelChrome(); await refreshPanelContent(true, true); return JSON.stringify(panelConfig.slots.map(s => s.id)); })()`));
    ok(ids.length === 2, `슬롯이 둘이어야 합니다: ${ids}`);
    const info = async () => JSON.parse(await app.eval(`JSON.stringify({ panes: [...document.querySelectorAll('#sp-panes .sp-pane')].map(p => ({ h: Math.round(p.getBoundingClientRect().height), body: p.querySelector('.sp-body').textContent, active: (p.querySelector('.sp-tab.active') || {}).textContent })), dividers: document.querySelectorAll('#sp-panes .sp-divider').length, split: document.getElementById('side-panel').classList.contains('split'), btns: [...document.querySelectorAll('[data-sp-split]')].map(b => b.dataset.spSplit + (b.classList.contains('active') ? '*' : '')), wrapHidden: document.getElementById('sp-split-wrap').hidden })`));
    let r = await info();
    ok(r.panes.length === 1 && r.dividers === 0 && !r.split && r.btns.join(',') === '1*,2,3', `처음에는 한 칸이고 분할 버튼은 1~3(기본 최대 3)이어야 합니다: ${JSON.stringify(r)}`);
    // 3칸으로: 슬롯은 서로 다른 것부터 차례로 배정(2개뿐이라 셋째 칸은 첫 슬롯을 다시), 높이는 비슷하고 각각 최소 높이 이상
    await app.eval(`document.querySelector('[data-sp-split="3"]').click(); 1`);
    for (let i = 0; i < 20; i++) { await sleep(300); r = await info(); if (r.panes.length === 3 && r.panes.every(p => p.body.includes('슬롯'))) break; }
    ok(r.panes.length === 3 && r.dividers === 2 && r.split, `3칸이어야 합니다: ${JSON.stringify(r)}`);
    ok(r.panes[0].body.includes('슬롯 A') && r.panes[1].body.includes('슬롯 B') && r.panes[2].body.includes('슬롯 A'), `칸마다 슬롯 내용이 달라야 합니다(같은 슬롯도 가능): ${JSON.stringify(r.panes.map(p => p.body))}`);
    ok(Math.max(...r.panes.map(p => p.h)) - Math.min(...r.panes.map(p => p.h)) <= 6 && r.panes.every(p => p.h >= 110), `처음에는 칸 높이가 비슷해야 합니다: ${r.panes.map(p => p.h)}`);
    // 둘째 칸을 첫 슬롯으로 바꾸면 그 칸만 바뀐다(같은 슬롯을 여러 칸에)
    await app.eval(`panes[1].tabsEl.querySelector('[data-sp-tab="${ids[0]}"]').click(); 1`);
    for (let i = 0; i < 20; i++) { await sleep(300); r = await info(); if (r.panes[1].body.includes('슬롯 A')) break; }
    ok(r.panes[0].body.includes('슬롯 A') && r.panes[1].body.includes('슬롯 A') && r.panes[2].body.includes('슬롯 A') && r.panes.map(p => p.active).join(',') === '슬롯A,슬롯A,슬롯A', `같은 슬롯을 여러 칸에 띄울 수 있어야 합니다: ${JSON.stringify(r.panes)}`);
    // 경계선 끌기: 첫 경계선을 60px 내리면 첫 칸은 커지고 둘째 칸은 줄며 셋째 칸은 그대로
    const before = r.panes.map(p => p.h);
    await app.eval(`(() => { const d = document.querySelectorAll('#sp-panes .sp-divider')[0]; const b = d.getBoundingClientRect(); const y = b.top + b.height / 2; const ev = (t, dy) => d.dispatchEvent(new PointerEvent(t, { bubbles: true, clientY: y + dy, pointerId: 7 })); ev('pointerdown', 0); ev('pointermove', 60); ev('pointerup', 60); return 1; })()`);
    await sleep(300);
    r = await info();
    ok(Math.abs((r.panes[0].h - before[0]) - 60) <= 4 && Math.abs((before[1] - r.panes[1].h) - 60) <= 4 && Math.abs(r.panes[2].h - before[2]) <= 3, `경계선을 끌면 이웃한 두 칸만 바뀌어야 합니다: ${before} → ${r.panes.map(p => p.h)}`);
    const saved = JSON.parse(await app.eval(`localStorage.getItem('ctm.panelLayout')`));
    ok(saved.count === 3 && saved.weights.length === 3 && saved.weights[0] > saved.weights[1] && saved.slots.length >= 3, `칸 수·높이 비율·슬롯이 저장돼야 합니다: ${JSON.stringify(saved)}`);
    // 너무 작게 끌지는 못한다(최소 110px)
    await app.eval(`(() => { const d = document.querySelectorAll('#sp-panes .sp-divider')[0]; const b = d.getBoundingClientRect(); const y = b.top + b.height / 2; const ev = (t, dy) => d.dispatchEvent(new PointerEvent(t, { bubbles: true, clientY: y + dy, pointerId: 8 })); ev('pointerdown', 0); ev('pointermove', -2000); ev('pointerup', -2000); return 1; })()`);
    await sleep(300);
    r = await info();
    ok(r.panes[0].h >= 108 && r.panes[0].h <= 114, `칸은 최소 높이 아래로 줄지 않아야 합니다: ${r.panes.map(p => p.h)}`);
    // 앱 설정의 최대 개수를 2로 줄이면 버튼은 1~2, 보이는 칸도 2개로(저장된 칸 수 3은 그대로 두되 최대 안으로 줄여 보인다)
    await app.eval(`(() => { const i = document.getElementById('panel-maxsplit-input'); i.value = '2'; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
    await sleep(500); r = await info();
    ok(r.panes.length === 2 && r.dividers === 1 && r.btns.join(',') === '1,2*', `최대 개수 2: ${JSON.stringify({ n: r.panes.length, d: r.dividers, b: r.btns })}`);
    await app.eval(`(() => { const i = document.getElementById('panel-maxsplit-input'); i.value = '1'; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
    await sleep(500); r = await info();
    ok(r.panes.length === 1 && !r.split && r.wrapHidden, `최대 개수 1이면 분할 버튼이 없어야 합니다: ${JSON.stringify({ n: r.panes.length, wrap: r.wrapHidden })}`);
    const v99 = await app.eval(`(() => { const i = document.getElementById('panel-maxsplit-input'); i.value = '99'; i.dispatchEvent(new Event('change', { bubbles: true })); return document.getElementById('panel-maxsplit-input').value; })()`);
    ok(v99 === '6', `최대 개수는 6까지만(입력 99 → ${v99})`);
    // 정리
    await app.eval(`(() => { const i = document.getElementById('panel-maxsplit-input'); i.value = '3'; i.dispatchEvent(new Event('change', { bubbles: true })); try { localStorage.removeItem('ctm.panelLayout'); localStorage.removeItem('ctm.panelMaxSplit'); } catch (e) {} panelLayout = { count: 1, slots: [], weights: [], weightsH: [], dir: 'v', pins: [] }; return 1; })()`);
    await app.eval('(async () => { const c = await window.api.getPanelConfig(); for (const sl of c.slots) await window.api.deletePanelSlot(sl.id); })()');
  });

  await check('나누는 방향을 위아래/좌우로 고를 수 있고, 좌우로 나누면 칸이 나란히 서며 패널이 넓어지고, 경계선을 끌면 너비가 바뀌며, 방향마다 크기 비율이 따로 저장된다', async () => {
    await app.eval('(async () => { const c = await window.api.getPanelConfig(); for (const sl of c.slots) await window.api.deletePanelSlot(sl.id); })()');
    const mkSlot = (name, text) => JSON.stringify({ name, mode: 'script', scope: 'all', preset: 'artifact-reports', instruction: '', autoUpdate: false, aiModel: 'sonnet', aiInclude: 'none', enabled: true, interpreter: 'node', script: `console.log(${JSON.stringify(text)})`, timeoutMs: 8000, outputFormat: 'markdown', allowJs: false });
    await app.eval(`window.api.savePanelSlot(${mkSlot('슬롯A', '# 슬롯 A 내용')}).then(() => 1)`);
    await app.eval(`window.api.savePanelSlot(${mkSlot('슬롯B', '# 슬롯 B 내용')}).then(() => 1)`);
    await app.eval(`document.querySelector('.tab-btn[data-tab="work"]').click(); 1`); await sleep(300);
    await app.eval(`(async () => { await window.api.setPanelEnabled(true); panelConfig = await window.api.getPanelConfig(); try { localStorage.setItem('ctm.panelCollapsed', '0'); localStorage.removeItem('ctm.panelMaxSplit'); localStorage.removeItem('ctm.panelLayout'); } catch (e) {} panelLayout = { count: 2, dir: 'v', slots: [], weights: [], weightsH: [], pins: [] }; localStorage.removeItem('ctm.panelWidth'); renderPanelChrome(); await refreshPanelContent(true, true); return 1; })()`);
    const geo = async () => JSON.parse(await app.eval(`JSON.stringify({ panes: [...document.querySelectorAll('#sp-panes .sp-pane')].map(p => { const r = p.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), body: p.querySelector('.sp-body').textContent }; }), div: [...document.querySelectorAll('#sp-panes .sp-divider')].map(d => { const r = d.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }), aside: Math.round(document.getElementById('side-panel').getBoundingClientRect().width), cls: document.getElementById('side-panel').className, dirBtns: [...document.querySelectorAll('[data-sp-dir]')].map(b => b.dataset.spDir + (b.classList.contains('active') ? '*' : '')) })`));
    for (let i = 0; i < 20; i++) { await sleep(300); const g = await geo(); if (g.panes.length === 2 && g.panes.every(p => p.body.includes('슬롯'))) break; }
    let g = await geo();
    ok(g.dirBtns.join(',') === 'v*,h' && g.panes.length === 2 && Math.abs(g.panes[0].l - g.panes[1].l) <= 2 && g.panes[1].t > g.panes[0].t, `처음은 위아래로 쌓여야 합니다: ${JSON.stringify(g)}`);
    const asideV = g.aside;
    // 좌우로
    await app.eval(`document.querySelector('[data-sp-dir="h"]').click(); 1`);
    await sleep(600); g = await geo();
    ok(g.dirBtns.join(',') === 'v,h*' && g.cls.includes('hsplit'), `좌우 버튼이 눌린 상태여야 합니다: ${JSON.stringify({ b: g.dirBtns, c: g.cls })}`);
    ok(Math.abs(g.panes[0].t - g.panes[1].t) <= 2 && g.panes[1].l > g.panes[0].l && g.div.length === 1 && g.div[0].w <= 12 && g.div[0].h > 100, `좌우로 나란히 서고 경계선은 세로 막대여야 합니다: ${JSON.stringify(g)}`);
    ok(Math.abs(g.panes[0].w - g.panes[1].w) <= 6 && g.panes.every(p => p.w >= 160), `처음에는 너비가 비슷하고 최소 너비 이상이어야 합니다: ${g.panes.map(p => p.w)}`);
    ok(g.aside >= 2 * 250 && g.panes.every(p => p.w >= 230), `좌우로 나누면 칸당 260px쯤 되게 패널이 넓어져야 합니다: ${asideV} → ${g.aside} / ${g.panes.map(p => p.w)}`);
    // 경계선 끌기(가로 방향): 오른쪽으로 40px
    const before = g.panes.map(p => p.w);
    await app.eval(`(() => { const d = document.querySelectorAll('#sp-panes .sp-divider')[0]; const b = d.getBoundingClientRect(); const x = b.left + b.width / 2; const ev = (t, dx) => d.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x + dx, pointerId: 11 })); ev('pointerdown', 0); ev('pointermove', 40); ev('pointerup', 40); return 1; })()`);
    await sleep(300); g = await geo();
    ok(Math.abs((g.panes[0].w - before[0]) - 40) <= 4 && Math.abs((before[1] - g.panes[1].w) - 40) <= 4, `경계선을 끌면 너비가 바뀌어야 합니다: ${before} → ${g.panes.map(p => p.w)}`);
    let saved = JSON.parse(await app.eval(`localStorage.getItem('ctm.panelLayout')`));
    ok(saved.dir === 'h' && saved.weightsH.length === 2 && saved.weightsH[0] > saved.weightsH[1] && saved.weights.length === 0, `좌우 비율은 weightsH에만 저장돼야 합니다: ${JSON.stringify(saved)}`);
    // 너무 좁게 끌지는 못한다
    await app.eval(`(() => { const d = document.querySelectorAll('#sp-panes .sp-divider')[0]; const b = d.getBoundingClientRect(); const x = b.left + b.width / 2; const ev = (t, dx) => d.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: x + dx, pointerId: 12 })); ev('pointerdown', 0); ev('pointermove', -3000); ev('pointerup', -3000); return 1; })()`);
    await sleep(300); g = await geo();
    ok(g.panes[0].w >= 168 && g.panes[0].w <= 174, `칸은 최소 너비 아래로 줄지 않아야 합니다: ${g.panes.map(p => p.w)}`);
    // 다시 위아래로: 쌓이고, 위아래 비율(weights)은 그대로 비어 있으며, 패널 너비는 원래대로
    await app.eval(`document.querySelector('[data-sp-dir="v"]').click(); 1`);
    await sleep(600); g = await geo();
    ok(Math.abs(g.panes[0].l - g.panes[1].l) <= 2 && g.panes[1].t > g.panes[0].t && !g.cls.includes('hsplit'), `다시 위아래로 쌓여야 합니다: ${JSON.stringify(g)}`);
    ok(g.aside <= asideV + 2, `위아래로 돌아오면 패널 너비도 원래대로여야 합니다: ${asideV} → ${g.aside}`);
    saved = JSON.parse(await app.eval(`localStorage.getItem('ctm.panelLayout')`));
    ok(saved.dir === 'v' && saved.weightsH.length === 2, `방향을 바꿔도 좌우 비율은 남아 있어야 합니다: ${JSON.stringify(saved)}`);
    // 정리
    await app.eval(`(() => { try { localStorage.removeItem('ctm.panelLayout'); localStorage.removeItem('ctm.panelMaxSplit'); for (const k of Object.keys(localStorage)) if (k.startsWith('ctm.panelWidth')) localStorage.removeItem(k); } catch (e) {} panelLayout = { count: 1, dir: 'v', slots: [], weights: [], weightsH: [], pins: [] }; renderPanelChrome(); return 1; })()`);
    await app.eval('(async () => { const c = await window.api.getPanelConfig(); for (const sl of c.slots) await window.api.deletePanelSlot(sl.id); })()');
  });

  await check('칸에 팀장을 고정(📌)하면 다른 팀장을 골라도 그 칸은 따라가지 않고, 고정한 팀장의 짧은 id가 바뀌어도(재개) 따라가며, 풀면 다시 선택한 팀장을 따라간다', async () => {
    const r = JSON.parse(await app.eval(`(() => {
      const saved = { rows: lastRows, sel: selectedLeadId, pins: panelLayout.pins };
      const out = {};
      try {
        syncPaneDom(1);
        const rows = ids => ids.map(([id, internalId, label]) => ({ id, isLead: true, internalId, label }));
        lastRows = rows([['L1', 'I1', '가팀장'], ['L2', 'I2', '나팀장']]);
        selectedLeadId = 'L1'; panelLayout.pins = [];
        out.unpinned = paneLeadId(panes[0]);
        panes[0].pinBtn.click(); // 지금 선택한 팀장(L1)에 고정
        out.pin = JSON.stringify(panelLayout.pins[0]);
        out.pressed = panes[0].pinBtn.classList.contains('on');
        selectedLeadId = 'L2'; out.afterSwitch = paneLeadId(panes[0]); // 다른 팀장을 골라도 L1
        lastRows = rows([['L1b', 'I1', '가팀장'], ['L2', 'I2', '나팀장']]); out.afterResume = paneLeadId(panes[0]); // 짧은 id가 L1b로 바뀌어도 따라간다
        lastRows = rows([['L2', 'I2', '나팀장']]); out.gone = paneLeadId(panes[0]); // 고정한 팀장이 사라지면 null
        lastRows = rows([['L1b', 'I1', '가팀장'], ['L2', 'I2', '나팀장']]);
        panes[0].pinBtn.click(); // 풀기
        out.released = paneLeadId(panes[0]); out.pin2 = JSON.stringify(panelLayout.pins[0] || null);
        selectedLeadId = null; panelLayout.pins = [];
        panes[0].pinBtn.click(); // 팀장을 고르지 않았으면 고정할 수 없다
        out.noLead = JSON.stringify(panelLayout.pins[0] || null);
      } finally { lastRows = saved.rows; selectedLeadId = saved.sel; panelLayout.pins = saved.pins; savePanelLayout(); }
      return JSON.stringify(out);
    })()`));
    ok(r.unpinned === 'L1' && JSON.parse(r.pin).internalId === 'I1' && r.pressed, `고정: ${JSON.stringify(r)}`);
    ok(r.afterSwitch === 'L1', `다른 팀장을 골라도 고정한 칸은 그대로여야 합니다: ${r.afterSwitch}`);
    ok(r.afterResume === 'L1b', `고정한 팀장의 짧은 id가 바뀌어도 따라가야 합니다: ${r.afterResume}`);
    ok(r.gone === null, `고정한 팀장이 목록에 없으면 null이어야 합니다: ${r.gone}`);
    ok(r.released === 'L2' && r.pin2 === 'null', `풀면 선택한 팀장을 따라가야 합니다: ${JSON.stringify(r)}`);
    ok(r.noLead === 'null', `팀장을 고르지 않았으면 고정되면 안 됩니다: ${r.noLead}`);
  });

  console.log('\n승인 요청 표시');
  await check('승인 요청은 위쪽에 팀장별 알림으로 뜨고, 카드는 선택한 팀장 것만 보이며, 하나를 처리해도 같은 팀장의 다른 카드가 잠기지 않는다', async () => {
    // 백엔드 없이 화면 로직만 확인한다 — 승인/새로고침 API를 가짜로 바꿔 끼우고(끝나면 되돌린다) 상태를 직접 넣는다.
    const r = JSON.parse(await app.eval(`(async () => {
      const out = {};
      const origApprove = window.api.approveRequest, origRefresh = window.api.refreshBoard;
      const savedRows = lastRows, savedSel = selectedLeadId;
      const req = (id, lead) => ({ id, type: 'dir-approval', requestedDir: 'C:/x/' + id, reason: '시험', teamLeadId: lead, createdAt: Date.now() });
      const all = [req('r1', 'L1'), req('r2', 'L1'), req('r3', 'L2')];
      lastRows = [{ id: 'L1', isLead: true, label: '가팀장' }, { id: 'L2', isLead: true, label: '나팀장' }];
      selectedLeadId = 'L1';
      try {
        renderRequests(all);
        const alerts = [...document.querySelectorAll('#request-alerts-list .request-alert-card .stall-alert-title')].map(e => e.textContent);
        out.alerts = alerts;
        out.cardsForL1 = [...document.querySelectorAll('#requests-list .request-card')].length;
        selectedLeadId = 'L2'; renderRequests(all);
        out.cardsForL2 = [...document.querySelectorAll('#requests-list .request-card')].length;
        selectedLeadId = 'L1'; renderRequests(all);
        let release; window.api.approveRequest = () => new Promise(res => { release = res; });
        window.api.refreshBoard = async () => { throw new Error('시험: 화면 갱신은 건너뜀'); };
        const dis = id => [...document.querySelectorAll('#requests-list [data-team-lead]')].filter(b => (b.dataset.approve || b.dataset.deny) === id).map(b => b.disabled);
        document.querySelector('#requests-list [data-approve="r1"]').click();
        out.duringR1 = dis('r1'); out.duringR2 = dis('r2');
        release({ decided: true, delivered: true });
        await new Promise(res => setTimeout(res, 100));
        out.busyAfter = busyLeadIds.size + decidingRequestIds.size + decisionLeadCount.size;
        out.afterR2 = dis('r2');
      } finally {
        window.api.approveRequest = origApprove; window.api.refreshBoard = origRefresh;
        lastRows = savedRows; selectedLeadId = savedSel; renderRequests([]);
      }
      return JSON.stringify(out);
    })()`));
    ok(r.alerts.length === 2 && r.alerts[0].includes('가팀장') && r.alerts[0].includes('2건') && r.alerts[1].includes('나팀장'), `위쪽 알림: ${JSON.stringify(r.alerts)}`);
    ok(r.cardsForL1 === 2 && r.cardsForL2 === 1, `선택한 팀장 것만 보여야 합니다: ${r.cardsForL1}/${r.cardsForL2}`);
    ok(r.duringR1.every(x => x === true), `처리 중인 카드는 잠겨야 합니다: ${r.duringR1}`);
    ok(r.duringR2.every(x => x === false), `같은 팀장의 다른 카드는 잠기면 안 됩니다: ${r.duringR2}`);
    ok(r.busyAfter === 0 && r.afterR2.every(x => x === false), `처리가 끝나면 잠금이 남지 않아야 합니다: ${JSON.stringify(r)}`);
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
