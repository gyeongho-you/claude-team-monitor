const test = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeApprovalRequest, parseStallVerdict, isStatusEligibleForStall, shouldCheckStall, shouldSendNudge } = require('../src/lib/stallGuard');

test('looksLikeApprovalRequest: 물음표로 끝나면 승인 요청으로 본다', () => {
  assert.equal(looksLikeApprovalRequest('이 방식으로 진행할까요?'), true);
});

test('looksLikeApprovalRequest: 승인/확인 키워드가 있으면 승인 요청으로 본다', () => {
  assert.equal(looksLikeApprovalRequest('배포 전에 한 번 확인해 주세요.'), true);
  assert.equal(looksLikeApprovalRequest('사용자 승인 후 진행하겠습니다.'), true);
});

test('looksLikeApprovalRequest: 평범한 완료 보고는 승인 요청이 아니다', () => {
  assert.equal(looksLikeApprovalRequest('보고서를 업데이트했습니다.'), false);
});

test('looksLikeApprovalRequest: 빈 문자열/undefined는 false', () => {
  assert.equal(looksLikeApprovalRequest(''), false);
  assert.equal(looksLikeApprovalRequest(undefined), false);
});

test('parseStallVerdict: 코드펜스 없이 순수 JSON도 파싱한다', () => {
  const v = parseStallVerdict('{"shouldNudge": true, "waitingForUser": false, "reason": "테스트"}');
  assert.deepEqual(v, { shouldNudge: true, waitingForUser: false, reason: '테스트' });
});

test('parseStallVerdict: ```json 코드펜스로 감싸져 있어도 파싱한다', () => {
  const v = parseStallVerdict('```json\n{"shouldNudge": false, "waitingForUser": true, "reason": "승인 대기"}\n```');
  assert.deepEqual(v, { shouldNudge: false, waitingForUser: true, reason: '승인 대기' });
});

test('parseStallVerdict: reason 필드가 없어도 빈 문자열로 채워 통과시킨다', () => {
  const v = parseStallVerdict('{"shouldNudge": true, "waitingForUser": false}');
  assert.deepEqual(v, { shouldNudge: true, waitingForUser: false, reason: '' });
});

test('parseStallVerdict: 깨진 JSON은 null (fail-closed)', () => {
  assert.equal(parseStallVerdict('이건 JSON이 아닙니다'), null);
});

test('parseStallVerdict: shouldNudge/waitingForUser가 boolean이 아니면 null', () => {
  assert.equal(parseStallVerdict('{"shouldNudge": "yes", "waitingForUser": false}'), null);
  assert.equal(parseStallVerdict('{"shouldNudge": true}'), null);
});

test('parseStallVerdict: 문자열이 아닌 입력은 null', () => {
  assert.equal(parseStallVerdict(undefined), null);
  assert.equal(parseStallVerdict(null), null);
  assert.equal(parseStallVerdict(123), null);
});

test('parseStallVerdict: reason이 문자열이 아니면(숫자 등) 강제로 포함하지 않고 빈 문자열로 대체한다', () => {
  const v = parseStallVerdict('{"shouldNudge": true, "waitingForUser": false, "reason": 123}');
  assert.deepEqual(v, { shouldNudge: true, waitingForUser: false, reason: '' });
});

const baseParams = {
  memberStatus: 'idle',
  leadStatus: 'idle',
  memberIdleSince: 0,
  leadIdleSince: 0,
  now: 1000_000,
  idleThresholdMs: 600_000,
  lastCheckedAt: undefined,
  cooldownMs: 1_200_000,
  hasExistingAlert: false,
};

test('shouldCheckStall: 조건을 모두 만족하면 true', () => {
  assert.equal(shouldCheckStall(baseParams), true);
});

test('shouldCheckStall: 팀원이 blocked면 무조건 false (하드 게이트)', () => {
  assert.equal(shouldCheckStall({ ...baseParams, memberStatus: 'blocked' }), false);
});

test('shouldCheckStall: 팀장이 blocked면 무조건 false (하드 게이트)', () => {
  assert.equal(shouldCheckStall({ ...baseParams, leadStatus: 'blocked' }), false);
});

test('shouldCheckStall: 팀장이 busy면 false', () => {
  assert.equal(shouldCheckStall({ ...baseParams, leadStatus: 'busy' }), false);
});

test('shouldCheckStall: 팀원이 busy면 false', () => {
  assert.equal(shouldCheckStall({ ...baseParams, memberStatus: 'busy' }), false);
});

test('shouldCheckStall: 팀원 idle 지속시간이 임계값 미만이면 false', () => {
  assert.equal(shouldCheckStall({ ...baseParams, memberIdleSince: baseParams.now - 100 }), false);
});

test('shouldCheckStall: 팀장 idle 지속시간이 임계값 미만이면 false', () => {
  assert.equal(shouldCheckStall({ ...baseParams, leadIdleSince: baseParams.now - 100 }), false);
});

test('shouldCheckStall: 쿨다운 안이면 false', () => {
  assert.equal(shouldCheckStall({ ...baseParams, lastCheckedAt: baseParams.now - 1000 }), false);
});

test('shouldCheckStall: 이미 대기 중인 알림이 있으면 false', () => {
  assert.equal(shouldCheckStall({ ...baseParams, hasExistingAlert: true }), false);
});

test('shouldCheckStall: 팀장이 done 상태여도(=idle과 동급) 체크한다', () => {
  assert.equal(shouldCheckStall({ ...baseParams, leadStatus: 'done' }), true);
});

test('shouldCheckStall: 팀원 상태가 빈 문자열(status/state 필드 자체가 없음)이면 false — 확실히 idle임을 모르니 안전하게 거부', () => {
  assert.equal(shouldCheckStall({ ...baseParams, memberStatus: '' }), false);
});

test('shouldCheckStall: 팀원 idle 지속시간이 임계값과 정확히 같으면 true(경계, now - idleSince < threshold만 거부)', () => {
  assert.equal(shouldCheckStall({ ...baseParams, memberIdleSince: baseParams.now - baseParams.idleThresholdMs }), true);
});

test('shouldCheckStall: 쿨다운 시간과 정확히 같으면 통과(경계)', () => {
  assert.equal(shouldCheckStall({ ...baseParams, lastCheckedAt: baseParams.now - baseParams.cooldownMs }), true);
});

test('isStatusEligibleForStall: 정상 조합은 true', () => {
  assert.equal(isStatusEligibleForStall({ memberStatus: 'idle', leadStatus: 'idle' }), true);
  assert.equal(isStatusEligibleForStall({ memberStatus: 'done', leadStatus: 'done' }), true);
});

test('isStatusEligibleForStall: 팀원/팀장 어느 쪽이 blocked여도 false', () => {
  assert.equal(isStatusEligibleForStall({ memberStatus: 'blocked', leadStatus: 'idle' }), false);
  assert.equal(isStatusEligibleForStall({ memberStatus: 'idle', leadStatus: 'blocked' }), false);
});

test('isStatusEligibleForStall: 팀장이 busy/오프라인(그 외 상태)이면 false', () => {
  assert.equal(isStatusEligibleForStall({ memberStatus: 'idle', leadStatus: 'busy' }), false);
  assert.equal(isStatusEligibleForStall({ memberStatus: 'idle', leadStatus: 'waiting' }), false);
});

test('isStatusEligibleForStall: 팀원이 busy거나 빈 문자열이면 false', () => {
  assert.equal(isStatusEligibleForStall({ memberStatus: 'busy', leadStatus: 'idle' }), false);
  assert.equal(isStatusEligibleForStall({ memberStatus: '', leadStatus: 'idle' }), false);
});

const okVerdict = { shouldNudge: true, waitingForUser: false, reason: 'ok' };

test('shouldSendNudge: verdict가 null이면 false (fail-closed)', () => {
  assert.equal(shouldSendNudge(null, '보고서를 업데이트했습니다.'), false);
});

test('shouldSendNudge: waitingForUser가 true면 shouldNudge와 무관하게 false', () => {
  assert.equal(shouldSendNudge({ shouldNudge: true, waitingForUser: true, reason: '' }, '완료했습니다.'), false);
});

test('shouldSendNudge: 정규식 안전장치 — 마지막 답변이 승인 요청처럼 보이면 Haiku 판단과 무관하게 false', () => {
  assert.equal(shouldSendNudge(okVerdict, '이대로 진행해도 될까요?'), false);
});

test('shouldSendNudge: shouldNudge가 false면 false', () => {
  assert.equal(shouldSendNudge({ shouldNudge: false, waitingForUser: false, reason: '' }, '완료했습니다.'), false);
});

test('shouldSendNudge: 모든 조건을 통과하면 true', () => {
  assert.equal(shouldSendNudge(okVerdict, '보고서를 업데이트했습니다.'), true);
});
