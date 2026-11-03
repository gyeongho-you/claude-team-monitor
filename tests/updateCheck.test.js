const test = require('node:test');
const assert = require('node:assert');
const { isNewer, interpretResponse, isSafeReleaseUrl } = require('../src/lib/updateCheck');

test('새 버전은 숫자 조각으로 비교한다', () => {
  assert.ok(isNewer('v0.2.0', '0.1.0'));
  assert.ok(isNewer('0.1.10', '0.1.9'), '문자열이 아니라 숫자로 비교');
  assert.ok(isNewer('1.0', '0.9.9'));
  assert.ok(!isNewer('0.1.0', '0.1.0'));
  assert.ok(!isNewer('0.1.0', '0.2.0'));
  assert.ok(!isNewer('v0.1', '0.1.0'), '빠진 조각은 0');
});

test('시험판은 같은 숫자의 정식보다 오래된 것이고, 해석 못 하는 버전은 업데이트로 보지 않는다', () => {
  assert.ok(isNewer('0.2.0', '0.2.0-beta'));
  assert.ok(!isNewer('0.2.0-beta', '0.2.0'));
  assert.ok(!isNewer('latest', '0.1.0'));
  assert.ok(!isNewer('', '0.1.0'));
  assert.ok(!isNewer('0.2.0', 'dev'));
});

test('최신 릴리스 응답 해석', () => {
  const body = JSON.stringify({ tag_name: 'v0.2.0', name: '0.2.0 릴리스', html_url: 'https://github.com/gyeongho-you/claude-team-monitor/releases/tag/v0.2.0', published_at: '2026-11-03T00:00:00Z' });
  const r = interpretResponse('0.1.0', 200, body);
  assert.ok(r.updateAvailable);
  assert.strictEqual(r.latest, 'v0.2.0');
  assert.strictEqual(r.url, 'https://github.com/gyeongho-you/claude-team-monitor/releases/tag/v0.2.0');
  assert.ok(!interpretResponse('0.2.0', 200, body).updateAvailable);
});

test('응답 예외 상황', () => {
  assert.ok(interpretResponse('0.1.0', 404, '{}').noRelease);
  assert.ok(interpretResponse('0.1.0', 403, '{}').error);
  assert.ok(interpretResponse('0.1.0', 500, '{}').error);
  assert.ok(interpretResponse('0.1.0', 200, '이건 JSON이 아님').error);
  assert.ok(interpretResponse('0.1.0', 200, '{}').error);
  const r = interpretResponse('0.1.0', 200, JSON.stringify({ tag_name: 'v9.0.0', html_url: 'https://evil.example/x' }));
  assert.ok(r.updateAvailable && r.url === null, '다른 저장소 주소는 열 주소로 믿지 않는다');
});

test('이 저장소의 릴리스 페이지만 열 수 있다', () => {
  assert.ok(isSafeReleaseUrl('https://github.com/gyeongho-you/claude-team-monitor/releases/tag/v0.2.0'));
  assert.ok(!isSafeReleaseUrl('https://github.com/other/repo/releases'));
  assert.ok(!isSafeReleaseUrl('https://github.com/gyeongho-you/claude-team-monitor/releases&calc'));
  assert.ok(!isSafeReleaseUrl('file:///c:/windows/system32/calc.exe'));
});
