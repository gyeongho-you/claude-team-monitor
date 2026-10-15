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

/** @returns {number | null} */
function daemonLocalAgentCount(jobsDir, shortId) {
  if (!/^[A-Za-z0-9_-]+$/.test(shortId || '')) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(jobsDir, shortId, 'state.json'), 'utf-8'));
    const f = data && data.inFlight;
    if (!f || !Array.isArray(f.kinds) || typeof f.tasks !== 'number') return null;
    return f.kinds.includes('local_agent') && f.tasks > 0 ? f.tasks : null;
  } catch { return null; }
}

/** @returns {string[]} */
function runningNamesFromFiles(parentJsonl, subagentsDir) {
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
  return [...last].filter(([, run]) => run).map(([id]) => desc.get(id) || id);
}

/**
 * 라이브 팀장 한 명의 서브에이전트 현황. 하나도 안 돌면 null.
 * @param {string} jobsDir
 * @param {string} shortId
 * @param {string} sessionFile - 팀장 세션 원본 jsonl 경로
 * @returns {{count: number, names: string[]} | null}
 */
function liveSubagents(jobsDir, shortId, sessionFile) {
  const count = daemonLocalAgentCount(jobsDir, shortId);
  if (count === null) return null;
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  return { count, names: runningNamesFromFiles(sessionFile, dir).slice(0, count) };
}

module.exports = { daemonLocalAgentCount, runningNamesFromFiles, liveSubagents };
