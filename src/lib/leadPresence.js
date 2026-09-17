// 팀장 자신의 프로세스는 안 떠 있어도, 그 팀장이 등록한 팀원 중 하나라도 아직 agents 스냅샷에
// 잡히면 "이 팀장의 일이 아직 끝나지 않았다"고 본다 — 팀장만 먼저 내려가고 팀원이 계속 일하는
// 상황은 실제로 생긴다(실사용 재현: g1cl-mgt 팀장 프로세스는 없어졌는데 g1cl-test 팀원은 계속
// 작업 중이었는데도 팀장 카드가 히스토리로 넘어가 작업 탭에서 안 보였다). 순수 함수로 뽑아서
// main.ts의 computeOfflineLeads/buildGraceRows 양쪽이 정확히 같은 판정을 쓰게 한다.

/**
 * @param {string} leadId - 짧은 id
 * @param {{leadId: string, memberId: string}[]} members
 * @param {Set<string | undefined>} agentIdSet - 지금 살아있는 세션들의 짧은 id 집합
 * @returns {boolean}
 */
function hasLiveMember(leadId, members, agentIdSet) {
  return members.some(m => m.leadId === leadId && agentIdSet.has(m.memberId));
}

module.exports = { hasLiveMember };
