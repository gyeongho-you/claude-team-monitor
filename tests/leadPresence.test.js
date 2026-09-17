const test = require('node:test');
const assert = require('node:assert/strict');
const { hasLiveMember } = require('../src/lib/leadPresence');

test('hasLiveMember: 살아있는 팀원이 있으면 true', () => {
  const members = [{ leadId: 'lead1', memberId: 'm1' }];
  const agentIdSet = new Set(['m1']);
  assert.equal(hasLiveMember('lead1', members, agentIdSet), true);
});

test('hasLiveMember: 팀원은 있지만 안 살아있으면 false', () => {
  const members = [{ leadId: 'lead1', memberId: 'm1' }];
  const agentIdSet = new Set(['other']);
  assert.equal(hasLiveMember('lead1', members, agentIdSet), false);
});

test('hasLiveMember: 다른 팀장 소속 팀원은 세지 않는다', () => {
  const members = [{ leadId: 'lead2', memberId: 'm1' }];
  const agentIdSet = new Set(['m1']);
  assert.equal(hasLiveMember('lead1', members, agentIdSet), false);
});

test('hasLiveMember: 팀원이 여러 명이면 하나라도 살아있으면 true', () => {
  const members = [
    { leadId: 'lead1', memberId: 'm1' },
    { leadId: 'lead1', memberId: 'm2' },
  ];
  const agentIdSet = new Set(['m2']);
  assert.equal(hasLiveMember('lead1', members, agentIdSet), true);
});

test('hasLiveMember: 팀원이 없으면 false', () => {
  assert.equal(hasLiveMember('lead1', [], new Set(['m1'])), false);
});
