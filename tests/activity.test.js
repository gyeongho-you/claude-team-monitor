const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseActivityLines, subagentFile, scanTaskLine, newScan, buildTasks, backgroundTasksFor, commandNeedle, squash, MAX_ITEMS } = require('../src/lib/activity');

const j = o => JSON.stringify(o);

test('활동은 사용자·응답 텍스트와 도구 호출을 보여주고 도구 결과·안내문·생각은 뺀다', () => {
  const lines = [
    j({ type: 'user', timestamp: '2026-10-26T05:00:00Z', message: { content: '리뷰해 줘' } }),
    j({ type: 'user', timestamp: '2026-10-26T05:00:01Z', message: { content: '<system-reminder>\n안내문</system-reminder>' } }),
    j({ type: 'assistant', timestamp: '2026-10-26T05:00:02Z', message: { content: [{ type: 'text', text: '먼저 파일을 읽겠습니다' }, { type: 'tool_use', name: 'Read', input: { file_path: 'C:/a/b.ts' } }, { type: 'thinking', thinking: '비공개' }] } }),
    j({ type: 'user', timestamp: '2026-10-26T05:00:03Z', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: '긴 결과' }] } }),
    j({ type: 'attachment', timestamp: '2026-10-26T05:00:04Z', attachment: { type: 'queued_command', prompt: '추가 요청' } }),
    j({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>x</task-notification>' } }),
  ].join('\n');
  assert.deepStrictEqual(parseActivityLines(lines).map(i => [i.kind, i.text]), [['user', '리뷰해 줘'], ['assistant', '먼저 파일을 읽겠습니다'], ['tool', 'Read: C:/a/b.ts'], ['user', '추가 요청']]);
});

test('활동은 최근 항목만 남긴다', () => {
  const lines = Array.from({ length: MAX_ITEMS + 25 }, (_, i) => j({ type: 'user', message: { content: `메시지 ${i}` } })).join('\n');
  const items = parseActivityLines(lines);
  assert.strictEqual(items.length, MAX_ITEMS);
  assert.strictEqual(items[items.length - 1].text, `메시지 ${MAX_ITEMS + 24}`);
});

const launchLines = (id, toolUse, cmd) => [
  j({ type: 'assistant', timestamp: '2026-10-26T01:00:00Z', message: { content: [{ type: 'tool_use', id: toolUse, name: 'Bash', input: { command: cmd, description: '설명', run_in_background: true } }] } }),
  j({ type: 'user', timestamp: '2026-10-26T01:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: toolUse, content: `Command running in background with ID: ${id}. Output is being written to: C:\\Temp\\claude\\proj\\sess\\tasks\\${id}.output. You will be notified when it completes — do not poll that file.\nSession cwd remains C:\\x.` }] } }),
];

test('백그라운드 작업은 시작과 완료 알림이 짝지어지고 알림 없는 최근 것이 실행 중으로 추정된다', () => {
  const lines = [...launchLines('aaa111', 'tu1', 'nuxt dev'), ...launchLines('bbb222', 'tu2', 'gradlew bootRun'), ...launchLines('ccc333', 'tu3', 'node img-server.mjs'),
    j({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification><task-id>aaa111</task-id><status>completed</status></task-notification>' })];
  const scan = newScan();
  for (const l of lines) scanTaskLine(scan, l);
  const tasks = buildTasks(scan, 1, null);
  assert.deepStrictEqual(tasks.map(t => t.taskId), ['ccc333', 'bbb222', 'aaa111']); // 최신이 위
  assert.strictEqual(tasks[2].status, 'completed');
  assert.strictEqual(tasks[1].status, 'unfinished');
  assert.ok(tasks[0].runningGuess && !tasks[1].runningGuess, '데몬이 1개라고 하면 알림 없는 것 중 가장 최근 1개만 실행 중 추정');
  assert.strictEqual(tasks[0].command, 'node img-server.mjs');
  assert.strictEqual(tasks[0].outputPath, 'C:\\Temp\\claude\\proj\\sess\\tasks\\ccc333.output');
});

test('알림 없는 작업이 살아 있는지는 같은 명령의 bash 래퍼가 떠 있는지로 정한다', () => {
  const scan = newScan();
  for (const l of [...launchLines('aaa111', 'tu1', 'cd /c/x && node img-server.mjs > img.log 2>&1'), ...launchLines('bbb222', 'tu2', 'cd /c/y && ./gradlew :app:bootRun --no-daemon')]) scanTaskLine(scan, l);
  // 래퍼는 명령을 eval '...' 안에 넣고 따옴표 이스케이프가 달라질 수 있다 — 공백·따옴표를 뺀 문자열로 비교한다.
  const procs = [squash('bash.exe -c "source /snap.sh && eval \'cd /c/x && node img-server.mjs > img.log 2>&1\' < /dev/null"')];
  const tasks = buildTasks(scan, 2, procs);
  const byId = id => tasks.find(t => t.taskId === id);
  assert.strictEqual(byId('aaa111').alive, true, '래퍼가 떠 있으면 실행 중');
  assert.strictEqual(byId('bbb222').alive, false, '래퍼가 없으면 끝났거나 방치된 것');
  assert.strictEqual(byId('aaa111').runningGuess, false, '프로세스를 확인했으면 추정은 쓰지 않는다');
  assert.strictEqual(buildTasks(scan, 1, null).filter(t => t.runningGuess).length, 1, '프로세스를 못 얻으면 이전 추정으로 대체');
});

test('명령 대표 조각은 짧으면 전체, 길면 가운데 60자', () => {
  assert.strictEqual(commandNeedle('node a.mjs'), 'nodea.mjs');
  const long = `cd /c/x && ${'A'.repeat(200)} && tail`;
  assert.strictEqual(commandNeedle(long).length, 60);
  assert.ok(squash(long).includes(commandNeedle(long)));
});

test('에이전트 간 보고·전달·지시는 도구 줄이 아니라 대화(message)로 보인다', () => {
  const tool = (name, input) => j({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const items = parseActivityLines([
    tool('Agent', { description: '코드 리뷰', prompt: '변경분을 리뷰해 줘' }),
    tool('SendMessage', { to: 'tm-1234', message: '후속 지시입니다' }),
    tool('SubagentHandback', { message: '리뷰 끝: 이슈 2건' }),
    tool('mcp__team-monitor__spawn_team_member', { label: 'BO', instruction: 'BO 화면을 구현해' }),
    tool('Read', { file_path: 'C:/a.ts' }),
  ].join('\n'));
  assert.deepStrictEqual(items.map(i => [i.kind, i.text]), [
    ['message', '서브에이전트 지시(코드 리뷰): 변경분을 리뷰해 줘'],
    ['message', '→ tm-1234: 후속 지시입니다'],
    ['message', '최종 보고: 리뷰 끝: 이슈 2건'],
    ['message', '팀원 지시(BO): BO 화면을 구현해'],
    ['tool', 'Read: C:/a.ts'],
  ]);
});

test('증분 스캔은 새로 붙은 완성된 줄만 읽는다(덜 써진 줄은 다음에)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-activity-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, launchLines('aaa111', 'tu1', 'nuxt dev').join('\n') + '\n');
  assert.strictEqual(backgroundTasksFor(file, 1).length, 1);
  const second = launchLines('bbb222', 'tu2', 'gradlew').join('\n');
  fs.appendFileSync(file, second.slice(0, Math.floor(second.length / 2)));
  assert.strictEqual(backgroundTasksFor(file, 1).length, 1);
  fs.appendFileSync(file, second.slice(Math.floor(second.length / 2)) + '\n');
  assert.strictEqual(backgroundTasksFor(file, 1).length, 2);
});

test('서브에이전트가 띄운 백그라운드 명령도 찾고 그 기록의 완료 알림과 짝짓는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-activity-sub-'));
  const sub = path.join(dir, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess.jsonl'), launchLines('par111', 'tp1', 'nuxt dev').join('\n') + '\n');
  const subLines = [...launchLines('sub222', 'ts1', 'node img-server.mjs'), ...launchLines('sub333', 'ts2', 'gradlew bootRun'),
    j({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>sub333</task-id>\n<status>completed</status>\n</task-notification>' } })];
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), subLines.join('\n') + '\n');
  const tasks = backgroundTasksFor(path.join(dir, 'sess.jsonl'), 2);
  const status = id => (tasks.find(t => t.taskId === id) || {}).status;
  assert.strictEqual(tasks.length, 3);
  assert.strictEqual(status('par111'), 'unfinished');
  assert.strictEqual(status('sub222'), 'unfinished');
  assert.strictEqual(status('sub333'), 'completed');
});

test('서브에이전트 파일 경로는 안전한 id만 만든다', () => {
  assert.strictEqual(subagentFile('/x/sess.jsonl', '../evil'), null);
  assert.ok(subagentFile('/x/sess.jsonl', 'aa5ec3cdb7a092e0c').endsWith(path.join('sess', 'subagents', 'agent-aa5ec3cdb7a092e0c.jsonl')));
});
