// 세션 정리 탭에서 팀장/팀원을 "팀" 단위(팀장 1명 + 소속 팀원들)로 묶는 순수 로직.
// DOM/HTML을 전혀 다루지 않으므로 renderer.js(브라우저)와 테스트(node:test) 양쪽에서
// 그대로 재사용한다 — lib/status.js와 같은 dual-export 패턴.
//
// 소속 팀장이 이 목록에 없는(팀장은 꺼져있고 팀원만 떠있는) 팀원과 미등록(untracked) 세션은
// 어느 팀에도 넣지 않고 orphans로 따로 모은다 — 그래야 어디에도 안 속한 세션이 조용히 묻히지 않는다.
function groupSessionsByTeam(sessions) {
  const list = sessions || [];
  const leads = list.filter(s => s.tag === 'lead');
  const leadIds = new Set(leads.map(l => l.id));
  const teams = leads.map(lead => ({
    lead,
    members: list.filter(s => s.tag === 'member' && s.leadId === lead.id),
  }));
  const orphans = list.filter(s => s.tag !== 'lead' && !(s.tag === 'member' && s.leadId && leadIds.has(s.leadId)));
  return { teams, orphans };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { groupSessionsByTeam };
} else {
  (typeof window !== 'undefined' ? window : globalThis).groupSessionsByTeam = groupSessionsByTeam;
}
