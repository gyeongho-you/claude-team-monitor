// 실제 claude 세션으로 하는 핵심 흐름 점검(선택 실행): 진짜 `claude --bg` 팀장 세션이 이 앱의 MCP 서버(<exe> --mcp-server)로
//   register_as_lead → spawn_team_member → (팀원 등록 확인)
// 을 부르는지 확인한다. smoke.js와 달리 claude CLI 설치·로그인이 필요하고, 모델 호출 비용이 든다(Haiku, 몇 번 안 됨).
//
// 쓰는 법:   npm run tauri:build && npm run test:e2e:real
//   CTM_EXE=<exe 경로>   기본: src-tauri/target/release/app.exe (또는 "Claude Team Monitor.exe")
//   CTM_TRUSTED_DIR=<폴더>  팀장·팀원이 일할 폴더 — claude를 한 번 실행해 신뢰(trust)한 폴더여야 한다(기본: 현재 폴더 = 저장소)
//
// 주의(상태를 바꾼다): 이 PC의 실제 ~/.claude/claude-team-monitor(leads.json, members/)에 팀장·팀원 기록이 잠깐 생기고 claude 백그라운드 세션이 2개 뜬다.
//   시작 전에 상태를 기록하고, 끝나면 claude stop으로 세션을 닫고 "이 시험이 만든 기록만" 지운다(다른 기록은 건드리지 않는다).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HOME = os.homedir();
const LEADS = path.join(HOME, '.claude', 'claude-team-monitor', 'leads.json');
const MEMBERS = path.join(HOME, '.claude', 'claude-team-monitor', 'members');
const TRUSTED = path.resolve(process.env.CTM_TRUSTED_DIR || process.cwd());
const results = [];
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const claude = (args, opts = {}) => spawnSync('claude', args, { encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const agents = () => { try { return JSON.parse(claude(['agents', '--json']).stdout); } catch { return []; } };
const step = (name, ok, detail) => { results.push({ name, ok }); console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

function pickExe() {
  if (process.env.CTM_EXE) return path.resolve(process.env.CTM_EXE);
  for (const n of ['app.exe', 'Claude Team Monitor.exe']) {
    const p = path.join(REPO, 'src-tauri', 'target', 'release', n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const exe = pickExe();
  if (!exe || !fs.existsSync(exe)) { console.error('앱 exe를 찾지 못했습니다. 먼저 `npm run tauri:build`를 하거나 CTM_EXE로 알려 주세요.'); return 2; }
  if (claude(['--version']).status !== 0) { console.error('claude CLI를 실행할 수 없습니다(설치·로그인 필요).'); return 2; }
  if (!fs.existsSync(LEADS)) fs.mkdirSync(path.dirname(LEADS), { recursive: true }), fs.writeFileSync(LEADS, '[]');
  console.log(`앱: ${exe}\n작업 폴더(신뢰된 폴더여야 함): ${TRUSTED}\n`);

  const membersBefore = new Set(fs.existsSync(MEMBERS) ? fs.readdirSync(MEMBERS) : []);
  const cfgPath = path.join(os.tmpdir(), `ctm-real-lead-${process.pid}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { 'team-monitor': { command: exe, args: ['--mcp-server'] } } }));
  const dir = TRUSTED.replace(/\\/g, '\\\\');
  const prompt = [
    '다음을 순서대로 하고 각 결과를 한 줄씩 보고해라.',
    `(1) register_as_lead 도구를 인자 없이 호출해라.`,
    `(2) spawn_team_member 도구를 targetDir="${dir}", label="e2e-member", model="haiku", instruction="아무 도구도 쓰지 말고 OK 라고만 답해"로 호출해라. 승인되지 않았다는 이유로 거절되면 list_leads를 한 번 호출한 뒤 같은 인자로 다시 호출해라(승인은 사용자가 따로 처리 중이다). 최대 8번까지만 반복해라.`,
    '다 끝나면 E2E-DONE 이라고 쓰고 멈춰라. 다른 도구는 쓰지 마라.',
  ].join('\n');
  const tools = ['spawn_team_member', 'register_as_lead', 'list_leads'].map(t => 'mcp__team-monitor__' + t).join(',');

  let leadId = null, member = null;
  try {
    const r = claude(['--bg', '--model', 'haiku', '--mcp-config', cfgPath, '--allowedTools', tools, '--', prompt], { cwd: TRUSTED });
    const m = (r.stdout || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').match(/backgrounded\s*[·:]\s*([a-f0-9]+)/i);
    step('claude --bg로 팀장 세션 시작', !!m, m ? `id ${m[1]}` : (r.stdout || r.stderr || '').slice(0, 200));
    if (!m) return 1;
    leadId = m[1];

    let lead = null, memberFile = null;
    let approvedAtRegister = null, approvedByUser = false;
    for (let i = 0; i < 75 && !(lead && memberFile); i++) {
      await sleep(2000);
      lead = lead || readJson(LEADS, []).find(l => l.id === leadId);
      if (lead && !approvedByUser) {
        // 승인은 사용자만 한다 — 등록 직후에는 목록이 비어 있어야 하고, 그 뒤 사용자가 승인한 것처럼 앱의 승인 흐름과 같은 필드를 채운다.
        approvedAtRegister = (lead.approvedMembers || []).length;
        const all = readJson(LEADS, []);
        const rec = all.find(l => l.id === leadId);
        rec.approvedMembers = [TRUSTED];
        fs.writeFileSync(LEADS + '.e2e.tmp', JSON.stringify(all, null, 2)); fs.renameSync(LEADS + '.e2e.tmp', LEADS);
        approvedByUser = true;
        lead = rec;
      }
      memberFile = memberFile || (fs.existsSync(MEMBERS) ? fs.readdirSync(MEMBERS) : []).find(f => !membersBefore.has(f));
    }
    step('register_as_lead: 팀장이 leads.json에 등록됨', !!lead && !!lead.internalId && approvedAtRegister === 0, lead ? `등록 직후 approvedMembers 개수=${approvedAtRegister}(0이어야 함 — 모델이 스스로 승인하면 안 된다)` : '등록되지 않음');
    member = memberFile ? readJson(path.join(MEMBERS, memberFile), null) : null;
    step('spawn_team_member: 팀원이 떴고 members/에 등록됨', !!member && !!member.memberId && !!member.sessionId, member ? `memberId=${member.memberId}, label=${member.label}` : '등록되지 않음(app.log의 [run_claude_bg] 줄을 보세요)');
    step('팀원의 leadId가 방금 등록된 팀장과 같다', !!(member && lead && member.leadId === lead.id));
    const live = member && agents().find(a => a.id === member.memberId);
    step('팀원이 claude agents 목록에 실제로 있다', !!live, live ? `kind=${live.kind}, name=${live.name}` : '');
  } finally {
    // 정리: 세션을 닫고, 이 시험이 만든 기록만 지운다
    for (const id of [leadId, member && member.memberId].filter(Boolean)) claude(['stop', id]);
    if (leadId) {
      const leads = readJson(LEADS, []);
      const kept = leads.filter(l => l.id !== leadId);
      if (kept.length !== leads.length) { fs.writeFileSync(LEADS + '.e2e.tmp', JSON.stringify(kept, null, 2)); fs.renameSync(LEADS + '.e2e.tmp', LEADS); }
    }
    if (member) { try { fs.unlinkSync(path.join(MEMBERS, member.memberId + '.json')); } catch { /* 이미 없음 */ } }
    try { fs.unlinkSync(cfgPath); } catch { /* 이미 없음 */ }
    console.log('\n(시험이 만든 세션·기록은 정리했습니다)');
  }
  const failed = results.filter(r => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} 통과${failed.length ? ' — 실패: ' + failed.map(f => f.name).join(' / ') : ''}`);
  return failed.length ? 1 : 0;
}
main().then(c => process.exit(c), e => { console.error('중단:', e.message); process.exit(1); });
