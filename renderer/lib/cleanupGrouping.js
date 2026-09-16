// 세션 정리 탭에서 팀장/팀원을 "팀" 단위(팀장 1명 + 소속 팀원들)로 묶는 순수 로직.
// DOM/HTML을 전혀 다루지 않으므로 renderer.js(브라우저)와 테스트(node:test) 양쪽에서
// 그대로 재사용한다 — lib/status.js와 같은 dual-export 패턴.
//
// 소속 팀장이 이 목록에 없는(팀장은 꺼져있고 팀원만 떠있는) 팀원과, 어느 팀장의 probableLeadId
// 추정에도 안 걸리는 미등록(untracked) 세션은 어느 팀에도 넣지 않고 orphans로 따로 모은다 —
// 그래야 어디에도 안 속한 세션이 조용히 묻히지 않는다. probableLeadId(정식 등록은 안 됐지만
// "이 팀장 소속일 수 있음"으로 추정된 것, main.ts의 guessProbableLeadId 참고)가 걸린 미등록
// 세션은 그 팀장의 members 배열에 같이 넣어서(호출부가 tag로 구분해 다르게 렌더링) 눈에 띄게 한다.
function isMemberOfLead(session, leadId) {
  if (session.tag === 'member') return session.leadId === leadId;
  if (session.tag === 'untracked') return session.probableLeadId === leadId;
  return false;
}

function groupSessionsByTeam(sessions) {
  const list = sessions || [];
  const leads = list.filter(s => s.tag === 'lead');
  const teams = leads.map(lead => ({
    lead,
    members: list.filter(s => isMemberOfLead(s, lead.id)),
  }));
  const orphans = list.filter(s => s.tag !== 'lead' && !leads.some(lead => isMemberOfLead(s, lead.id)));
  return { teams, orphans };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { groupSessionsByTeam };
} else {
  (typeof window !== 'undefined' ? window : globalThis).groupSessionsByTeam = groupSessionsByTeam;
}
