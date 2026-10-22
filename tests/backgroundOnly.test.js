const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backgroundOnly } = require('../src/lib/subagents');

function jobs(map) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-bg-'));
  for (const [id, body] of Object.entries(map)) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'state.json'), JSON.stringify(body));
  }
  return dir;
}

test('쉬는 중(working+tempo idle)인데 백그라운드 명령만 남았으면 백그라운드 전용으로 본다(디자인 팀장 실측 사례)', () => {
  const dir = jobs({ a1: { state: 'working', tempo: 'idle', inFlight: { tasks: 3, kinds: ['local_bash', 'artifact_watch'] } } });
  assert.deepStrictEqual(backgroundOnly(dir, 'a1'), { count: 3, kinds: ['local_bash', 'artifact_watch'] });
});

test('모델이 일하는 중(tempo active)이거나 서브에이전트가 돌면 진짜 작업 중이다', () => {
  const dir = jobs({
    b1: { state: 'working', tempo: 'active', inFlight: { tasks: 1, kinds: ['local_bash'] } },
    c1: { state: 'working', tempo: 'idle', inFlight: { tasks: 1, kinds: ['local_agent'] } },
    d1: { state: 'done', tempo: 'idle', inFlight: { tasks: 0, kinds: [] } },
  });
  assert.strictEqual(backgroundOnly(dir, 'b1'), null);
  assert.strictEqual(backgroundOnly(dir, 'c1'), null);
  assert.strictEqual(backgroundOnly(dir, 'd1'), null);
});

test('없는 파일이나 안전하지 않은 id는 null', () => {
  const dir = jobs({});
  assert.strictEqual(backgroundOnly(dir, 'nothere1'), null);
  assert.strictEqual(backgroundOnly(dir, '../x'), null);
});
