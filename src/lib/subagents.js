// src-tauri/src/subagents.rs와 같은 규칙의 Electron 쪽 구현 — 팀장이 임의로 띄운 서브에이전트가 지금
// 몇 개 돌고 있는지 읽기 전용으로 알아낸다.
// 개수: 데몬 ~/.claude/jobs/<id>/state.json의 inFlight.tasks(kinds에 local_agent가 있을 때). 꺼진 세션의
//   state.json에는 낡은 값이 남으므로 호출하는 쪽이 live 세션에만 써야 한다.
// 이름: <세션>/subagents/agent-<id>.meta.json의 description. 에이전트 id별 시간순 이벤트(시작=
//   "Async agent launched" tool_result, 재개=toolUseResult.resumedAgentId, 종료=<task-notification>의
//   task-id)를 쌓아 마지막이 시작/재개면 실행 중. 읽기 실패나 예상과 다른 형태는 조용히 없는 것으로 넘긴다.

const fs = require('fs');
const path = require('path');

function readRecords(file) {
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** 데몬 state.json의 {tasks, kinds}. tasks가 0이거나 읽을 수 없으면 null. */
function daemonInFlight(jobsDir, shortId) {
  if (!/^[A-Za-z0-9_-]+$/.test(shortId || '')) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(jobsDir, shortId, 'state.json'), 'utf-8'));
    const f = data && data.inFlight;
    if (!f || !Array.isArray(f.kinds) || typeof f.tasks !== 'number' || f.tasks <= 0) return null;
    // tasks에는 서브에이전트·백그라운드 명령 말고 다른 종류(artifact_watch 등)도 들어 있다(실측 2026-10-26: [artifact_watch, local_agent] = tasks 2인데
    // 서브에이전트는 1개). 다른 종류는 종류마다 1개로 보고(artifact_watch는 drainableMonitors 개수) 빼서 센다.
    const drainable = typeof f.drainableMonitors === 'number' ? f.drainableMonitors : 0;
    const others = f.kinds.filter(k => k !== 'local_agent' && k !== 'local_bash').reduce((n, k) => n + (k === 'artifact_watch' ? Math.max(drainable, 1) : 1), 0);
    const counted = f.kinds.includes('local_agent') || f.kinds.includes('local_bash');
    return { tasks: counted ? Math.max(f.tasks - others, 1) : f.tasks, kinds: f.kinds };
  } catch { return null; }
}

/**
 * 데몬의 tasks는 종류를 가리지 않은 합계다(실측 2026-10-26: 서브에이전트 1 + 서브에이전트가 띄운 백그라운드 명령 1 = tasks 2,
 * kinds [local_agent, local_bash]). 종류가 섞이면 서브에이전트 수는 파일 규칙으로 센 값을 기준으로 삼고 백그라운드 명령 수는 나머지로 본다.
 * @returns {{agents: number | null, bash: number | null}}
 */
function splitInFlight(tasks, kinds, filesAgents) {
  const hasAgent = kinds.includes('local_agent');
  const hasBash = kinds.includes('local_bash');
  if (hasAgent && !hasBash) return { agents: tasks, bash: null };
  if (!hasAgent && hasBash) return { agents: null, bash: tasks };
  if (!hasAgent) return { agents: null, bash: null };
  const agents = Math.min(Math.max(filesAgents, 1), Math.max(tasks - 1, 1));
  return { agents, bash: tasks - agents > 0 ? tasks - agents : null };
}

function daemonLocalAgentCount(jobsDir, shortId) {
  const f = daemonInFlight(jobsDir, shortId);
  return f ? splitInFlight(f.tasks, f.kinds, 0).agents : null;
}

function sessionAgentsDir(sessionFile) { return path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents'); }

/** 데몬이 센 백그라운드 셸 명령(local_bash) 개수 — 화면의 "백그라운드 작업" 칸이 알림 없는 것 중 몇 개가 지금 돌고 있는지 추정하는 기준. */
function daemonLocalBashCount(jobsDir, shortId, sessionFile) {
  const f = daemonInFlight(jobsDir, shortId);
  if (!f) return null;
  const files = f.kinds.includes('local_agent') && sessionFile ? runningAgentsFromFiles(sessionFile, sessionAgentsDir(sessionFile)).length : 0;
  return splitInFlight(f.tasks, f.kinds, files).bash;
}

/**
 * 팀장은 쉬는 중인데 백그라운드 명령(개발 서버 등)만 남아 데몬이 busy로 보고하는 경우.
 * 실측(2026-10-22): 이때 state.json은 state=working / tempo=idle 이고 inFlight.kinds에 local_bash 등만 있다.
 * 서브에이전트(local_agent)가 도는 동안은 tempo가 active로 유지되므로 구분된다.
 * @returns {{count: number, kinds: string[]} | null}
 */
function backgroundOnly(jobsDir, shortId) {
  if (!/^[A-Za-z0-9_-]+$/.test(shortId || '')) return null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(jobsDir, shortId, 'state.json'), 'utf-8'));
    const f = s && s.inFlight;
    if (!s || s.state !== 'working' || s.tempo !== 'idle' || !f || !Array.isArray(f.kinds) || typeof f.tasks !== 'number') return null;
    if (f.tasks === 0 || f.kinds.includes('local_agent')) return null;
    return { count: f.tasks, kinds: f.kinds };
  } catch { return null; }
}

/** @returns {string[]} */
function runningNamesFromFiles(parentJsonl, subagentsDir) {
  return runningAgentsFromFiles(parentJsonl, subagentsDir).map(a => a.name);
}

/** 위와 같은 규칙으로 {id, name}을 돌려준다 — id가 있어야 그 서브에이전트의 대화 파일(agent-<id>.jsonl)을 열 수 있다. @returns {{id: string, name: string}[]} */
function runningAgentsFromFiles(parentJsonl, subagentsDir) {
  let files;
  try { files = fs.readdirSync(subagentsDir); } catch { return []; }
  const byTool = new Map();
  const desc = new Map();
  for (const f of files) {
    const m = f.match(/^agent-(.+)\.meta\.json$/);
    if (!m) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, f), 'utf-8'));
      if (typeof meta.toolUseId === 'string') byTool.set(meta.toolUseId, m[1]);
      desc.set(m[1], typeof meta.description === 'string' ? meta.description : m[1]);
    } catch { /* 손상된 meta는 건너뛴다 */ }
  }
  const events = []; // [시각(UTC ISO라 사전순=시간순), 에이전트 id, 실행 중이 되는 이벤트인가]
  const scan = (recs, isParent) => {
    for (const r of recs) {
      const ts = typeof r.timestamp === 'string' ? r.timestamp : '';
      if (r.toolUseResult && typeof r.toolUseResult.resumedAgentId === 'string') events.push([ts, r.toolUseResult.resumedAgentId, true]);
      const s = JSON.stringify(r);
      if (s.includes('Async agent launched')) {
        const m = s.match(/"tool_use_id":"([^"]+)"/);
        if (m && byTool.has(m[1])) events.push([ts, byTool.get(m[1]), true]);
      }
      if (!s.includes('<task-notification>')) continue;
      // 부모 기록에서는 알림이 처음 생긴 시각(queue-operation enqueue)만 종료로 센다.
      if (isParent && !(r.type === 'queue-operation' && r.operation === 'enqueue')) continue;
      const m = s.match(/<task-id>([^<]+)</);
      if (m) events.push([ts, m[1], false]);
    }
  };
  scan(readRecords(parentJsonl), true);
  for (const f of files.filter(x => x.endsWith('.jsonl'))) scan(readRecords(path.join(subagentsDir, f)), false);
  events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const last = new Map();
  for (const [, id, run] of events) last.set(id, run);
  return [...last].filter(([, run]) => run).map(([id]) => ({ id, name: desc.get(id) || id }));
}

/**
 * 라이브 팀장 한 명의 서브에이전트 현황. 하나도 안 돌면 null.
 * @param {string} jobsDir
 * @param {string} shortId
 * @param {string} sessionFile - 팀장 세션 원본 jsonl 경로
 * @returns {{count: number, names: string[]} | null}
 */
function liveSubagents(jobsDir, shortId, sessionFile) {
  const f = daemonInFlight(jobsDir, shortId);
  if (!f || !f.kinds.includes('local_agent')) return null;
  const all = runningAgentsFromFiles(sessionFile, sessionAgentsDir(sessionFile));
  const count = splitInFlight(f.tasks, f.kinds, all.length).agents;
  if (count === null) return null;
  const items = all.slice(0, count);
  return { count, names: items.map(a => a.name), items };
}

module.exports = { splitInFlight, daemonLocalAgentCount, daemonLocalBashCount, runningNamesFromFiles, runningAgentsFromFiles, liveSubagents, backgroundOnly };
