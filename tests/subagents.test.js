const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { daemonLocalAgentCount, runningNamesFromFiles, liveSubagents, splitInFlight } = require('../src/lib/subagents');

test('종류가 섞인 데몬 tasks는 서브에이전트와 백그라운드 명령으로 나눈다', () => {
  const mix = ['local_agent', 'local_bash'];
  // 실측: 서브에이전트 1 + 그 서브에이전트가 띄운 백그라운드 명령 1 → tasks 2
  assert.deepStrictEqual(splitInFlight(2, mix, 1), { agents: 1, bash: 1 });
  assert.deepStrictEqual(splitInFlight(2, mix, 0), { agents: 1, bash: 1 });
  assert.deepStrictEqual(splitInFlight(3, mix, 2), { agents: 2, bash: 1 });
  assert.deepStrictEqual(splitInFlight(2, ['local_agent'], 1), { agents: 2, bash: null });
  assert.deepStrictEqual(splitInFlight(3, ['local_bash', 'artifact_watch'], 0), { agents: null, bash: 3 });
  assert.deepStrictEqual(splitInFlight(1, ['artifact_watch'], 0), { agents: null, bash: null });
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-subagents-'));

test('개수는 local_agent가 있고 tasks가 1 이상일 때만 센다', () => {
  const jobs = tmp();
  const w = (id, body) => { fs.mkdirSync(path.join(jobs, id), { recursive: true }); fs.writeFileSync(path.join(jobs, id, 'state.json'), body); };
  w('aaaa1111', '{"inFlight":{"tasks":2,"queued":0,"kinds":["local_agent"]}}');
  w('bbbb2222', '{"inFlight":{"tasks":1,"queued":0,"kinds":["artifact_watch"]}}');
  w('cccc3333', '{"inFlight":{"tasks":0,"queued":0,"kinds":[]}}');
  assert.strictEqual(daemonLocalAgentCount(jobs, 'aaaa1111'), 2);
  assert.strictEqual(daemonLocalAgentCount(jobs, 'bbbb2222'), null);
  assert.strictEqual(daemonLocalAgentCount(jobs, 'cccc3333'), null);
  assert.strictEqual(daemonLocalAgentCount(jobs, '../x'), null);
  assert.strictEqual(daemonLocalAgentCount(jobs, 'nothere1'), null);
});

test('이름은 에이전트별 마지막 이벤트가 시작/재개인 것만 남긴다', () => {
  const d = tmp();
  const sub = path.join(d, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), '{"description":"끝난 일","toolUseId":"toolu_A"}');
  fs.writeFileSync(path.join(sub, 'agent-b2.meta.json'), '{"description":"도는 일","toolUseId":"toolu_B"}');
  fs.writeFileSync(path.join(sub, 'agent-c3.meta.json'), '{"description":"재개된 일","toolUseId":"toolu_C"}');
  const launched = (t, id) => `{"timestamp":"2026-01-01T00:00:0${t}.000Z","type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"${id}","content":"Async agent launched"}]}}`;
  const notified = (t, id) => `{"timestamp":"2026-01-01T00:00:0${t}.000Z","type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>${id}</task-id></task-notification>"}`;
  const parent = path.join(d, 'sess.jsonl');
  fs.writeFileSync(parent, [launched(1, 'toolu_A'), launched(2, 'toolu_B'), launched(3, 'toolu_C'), notified(4, 'a1'), notified(5, 'c3'),
    '{"timestamp":"2026-01-01T00:00:06.000Z","type":"user","toolUseResult":{"resumedAgentId":"c3"}}'].join('\n'));
  assert.deepStrictEqual(runningNamesFromFiles(parent, sub), ['도는 일', '재개된 일']);
});

test('liveSubagents는 데몬 개수가 없으면 null, 이름 수는 개수를 넘지 않는다', () => {
  const d = tmp();
  const jobs = path.join(d, 'jobs');
  fs.mkdirSync(path.join(jobs, 'aaaa1111'), { recursive: true });
  const parent = path.join(d, 'sess.jsonl');
  fs.writeFileSync(parent, '');
  assert.strictEqual(liveSubagents(jobs, 'aaaa1111', parent), null);
  fs.writeFileSync(path.join(jobs, 'aaaa1111', 'state.json'), '{"inFlight":{"tasks":1,"queued":0,"kinds":["local_agent"]}}');
  assert.deepStrictEqual(liveSubagents(jobs, 'aaaa1111', parent), { count: 1, names: [], items: [] });
});
