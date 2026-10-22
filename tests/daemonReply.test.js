const test = require('node:test');
const assert = require('node:assert');
const { controlPathFromRoster, buildReplyLine, parseReplyResponse } = require('../src/lib/daemonReply');

test('제어 소켓 경로는 roster의 워커 소켓 경로에서 만든다', () => {
  const roster = JSON.stringify({ proto: 1, workers: { '77e4c4d5': { rendezvousSock: '\\\\.\\pipe\\cc-daemon-3a724ee05e173573-rv-77e4c4d5', ptySock: '\\\\.\\pipe\\cc-daemon-3a724ee05e173573-pty-77e4c4d5' } } });
  assert.strictEqual(controlPathFromRoster(roster), '\\\\.\\pipe\\cc-daemon-3a724ee05e173573-control');
  assert.strictEqual(controlPathFromRoster('{"workers":{}}'), null);
  assert.strictEqual(controlPathFromRoster('not json'), null);
  assert.strictEqual(controlPathFromRoster('{"workers":{"a":{"pid":1}}}'), null);
});

test('reply 요청은 모든 필드를 가진 한 줄 JSON이다(메시지 안의 줄바꿈은 이스케이프)', () => {
  const line = buildReplyLine('c728206b', '줄1\n줄2 "따옴표"', 'KEY');
  assert.ok(line.endsWith('\n'));
  assert.strictEqual(line.split('\n').length, 2);
  assert.deepStrictEqual(JSON.parse(line), { proto: 1, op: 'reply', short: 'c728206b', text: '줄1\n줄2 "따옴표"', auth: 'KEY' });
});

test('응답이 ok면 통과, 아니면 코드를 담은 오류', () => {
  assert.strictEqual(parseReplyResponse('{"ok":true,"op":"reply"}'), true);
  assert.throws(() => parseReplyResponse('{"ok":false,"error":"no key","code":"EAUTH"}'), /^Error: EAUTH/);
  assert.throws(() => parseReplyResponse('garbage'), /해석하지 못했습니다/);
});
