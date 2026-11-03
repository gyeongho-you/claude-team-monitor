const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MODEL_CHOICES, isKnownModel, readSessionModel, writeSessionModel } = require('../src/lib/sessionModel');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-model-'));
const write = (jobs, id, body) => { fs.mkdirSync(path.join(jobs, id), { recursive: true }); fs.writeFileSync(path.join(jobs, id, 'state.json'), body); };

test('respawnFlags의 --model 값을 읽는다', () => {
  const jobs = tmp();
  write(jobs, 'aaaa1111', '{"respawnFlags":["--model","sonnet[1m]"]}');
  write(jobs, 'bbbb2222', '{"respawnFlags":[]}');
  write(jobs, 'cccc3333', '{"state":"done"}');
  assert.strictEqual(readSessionModel(jobs, 'aaaa1111'), 'sonnet[1m]');
  assert.strictEqual(readSessionModel(jobs, 'bbbb2222'), null);
  assert.strictEqual(readSessionModel(jobs, 'cccc3333'), null);
  assert.strictEqual(readSessionModel(jobs, '../x'), null);
});

test('모델을 쓰면 다른 필드와 다른 플래그는 그대로 둔다', () => {
  const jobs = tmp();
  write(jobs, 'aaaa1111', '{"state":"done","detail":"x","respawnFlags":["--model","haiku","--effort","high"],"inFlight":{"tasks":0}}');
  writeSessionModel(jobs, 'aaaa1111', 'opus');
  const v = JSON.parse(fs.readFileSync(path.join(jobs, 'aaaa1111', 'state.json'), 'utf-8'));
  assert.deepStrictEqual(v.respawnFlags, ['--effort', 'high', '--model', 'opus']);
  assert.strictEqual(v.detail, 'x');
  assert.strictEqual(v.inFlight.tasks, 0);
  assert.ok(!fs.existsSync(path.join(jobs, 'aaaa1111', 'state.json.ctm-tmp')));
  writeSessionModel(jobs, 'aaaa1111', 'default');
  assert.strictEqual(readSessionModel(jobs, 'aaaa1111'), null);
  write(jobs, 'bbbb2222', '{"state":"done"}');
  writeSessionModel(jobs, 'bbbb2222', 'fable');
  assert.strictEqual(readSessionModel(jobs, 'bbbb2222'), 'fable');
});

test('모르는 모델·위험한 id·읽을 수 없는 상태 파일은 거부한다', () => {
  const jobs = tmp();
  write(jobs, 'aaaa1111', '{"respawnFlags":[]}');
  assert.throws(() => writeSessionModel(jobs, 'aaaa1111', 'gpt'));
  assert.throws(() => writeSessionModel(jobs, '../x', 'opus'));
  assert.throws(() => writeSessionModel(jobs, 'nothere1', 'opus'));
  write(jobs, 'bad00000', '이건 JSON이 아님');
  assert.throws(() => writeSessionModel(jobs, 'bad00000', 'opus'));
});

test('선택 가능한 모델에 fable이 있다', () => {
  assert.ok(isKnownModel('fable') && isKnownModel('default') && !isKnownModel('gpt'));
  assert.deepStrictEqual(MODEL_CHOICES, ['default', 'haiku', 'sonnet', 'opus', 'fable']);
});
