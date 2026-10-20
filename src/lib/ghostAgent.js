// resume 직전 `claude stop`이 실패했을 때, 정말 정지할 대상(실행 중인 프로세스)이 없는 "유령" 항목인지
// 판정하는 순수 로직. src-tauri/src/resume.rs의 is_ghost_agent와 같은 규칙이다.
//
// 배경(실측 2026-10-20, g1cl-mgt-leader): 세션이 유휴 60분으로 데몬에 의해 종료 처리돼도 그 job의
// state.json이 비종료 상태(blocked 등)로 남아 있으면, 데몬이 없을 때 `claude agents`는 프로세스 없이
// 그 파일만 보고 항목을 계속 목록에 올린다(pid/status가 없다). 한편 마지막 세션이 정리되면 데몬도 5초
// 뒤 스스로 내려가는데, 데몬이 없으면 `claude stop`은 "couldn't confirm ... the background service may
// be restarting"(exit 1)로 영구 실패하고(재시도·대기로도 안 풀린다, 데몬을 되살리는 건 --bg spawn뿐),
// 앱은 포크 위험 때문에 resume을 중단해서 서로 물려 영영 resume이 안 됐다.
// 프로세스가 없는 항목은 정지할 것도 포크될 것도 없다 — 정지 없이 --resume을 걸면 같은 짧은 id로
// 깨어나는 것을 실측 확인했다. 반대로 살아있는(blocked 포함) 세션은 항상 pid와 status를 가진다 —
// 과거 포크 사고(blocked 팀장에 stop이 실패한 채 resume)는 이쪽이라 반드시 계속 막아야 한다.

/**
 * @param {{pid?: number | null, status?: string | null} | undefined | null} agent - agents 목록의 그 항목(없으면 undefined)
 * @returns {boolean} 항목이 목록에 없거나 pid·status가 모두 없으면 true(정지할 프로세스 없음)
 */
function hasNoLiveProcess(agent) {
  if (!agent) return true;
  return (agent.pid === undefined || agent.pid === null) && (agent.status === undefined || agent.status === null);
}

module.exports = { hasNoLiveProcess };
