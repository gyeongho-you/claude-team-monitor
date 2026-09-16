const test = require('node:test');
const assert = require('node:assert/strict');
const { groupSessionsByTeam } = require('../renderer/lib/cleanupGrouping');

test('groupSessionsByTeam: 팀장 소속 팀원을 그 팀장의 members 배열로 묶는다', () => {
  const sessions = [
    { id: 'lead1', tag: 'lead' },
    { id: 'mem1', tag: 'member', leadId: 'lead1' },
    { id: 'mem2', tag: 'member', leadId: 'lead1' },
  ];
  const { teams, orphans } = groupSessionsByTeam(sessions);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].lead.id, 'lead1');
  assert.deepEqual(teams[0].members.map(m => m.id), ['mem1', 'mem2']);
  assert.equal(orphans.length, 0);
});

test('groupSessionsByTeam: 여러 팀장이 있으면 각자 소속 팀원만 갖는다', () => {
  const sessions = [
    { id: 'lead1', tag: 'lead' },
    { id: 'lead2', tag: 'lead' },
    { id: 'mem1', tag: 'member', leadId: 'lead1' },
    { id: 'mem2', tag: 'member', leadId: 'lead2' },
  ];
  const { teams } = groupSessionsByTeam(sessions);
  assert.equal(teams.length, 2);
  assert.deepEqual(teams.find(t => t.lead.id === 'lead1').members.map(m => m.id), ['mem1']);
  assert.deepEqual(teams.find(t => t.lead.id === 'lead2').members.map(m => m.id), ['mem2']);
});

test('groupSessionsByTeam: 소속 팀장이 지금 목록에 없는 팀원은 orphans로 간다', () => {
  const sessions = [
    { id: 'mem1', tag: 'member', leadId: 'lead-not-running' },
  ];
  const { teams, orphans } = groupSessionsByTeam(sessions);
  assert.equal(teams.length, 0);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, 'mem1');
});

test('groupSessionsByTeam: 미등록(untracked) 세션은 orphans로 간다', () => {
  const sessions = [
    { id: 'lead1', tag: 'lead' },
    { id: 'x1', tag: 'untracked' },
  ];
  const { teams, orphans } = groupSessionsByTeam(sessions);
  assert.equal(teams.length, 1);
  assert.equal(teams[0].members.length, 0);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].id, 'x1');
});

test('groupSessionsByTeam: 빈 입력/undefined는 빈 결과를 준다', () => {
  assert.deepEqual(groupSessionsByTeam([]), { teams: [], orphans: [] });
  assert.deepEqual(groupSessionsByTeam(undefined), { teams: [], orphans: [] });
});
