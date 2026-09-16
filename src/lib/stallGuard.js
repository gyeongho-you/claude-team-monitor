// "정체 감시(stall watchdog)" — 팀장이 팀원의 보고를 받고도 다음 지시를 깜빡해서, 팀원이
// idle/done 상태로 방치되는 사고(실사용 재현: g1cl-test/c7aa91ed가 state: done인 채로 계속
// 대기)를 잡기 위한 순수 판단 로직. 파일 I/O·claude CLI 호출은 전부 main.ts가 맡고, 여기는
// "찔러도 되는 상황인지" 판정만 한다 — 단위 테스트하기 쉽게 하기 위해서다.
//
// 핵심 설계: 저비용 서브 에이전트(Haiku)의 판단 하나만으로 재촉 메시지를 보내지 않는다.
// 승인/확인을 기다리는 중인 세션은 Haiku의 판단과 무관하게 앱 코드 자체가 독립적으로 막는다
// (shouldCheckStall의 blocked 하드게이트 + shouldSendNudge의 정규식 안전장치, 이중 방어).

// 팀장의 마지막 답변이 질문/승인 요청처럼 보이면 절대 재촉하지 않는다 — 이 패턴에 걸리면
// Haiku가 뭐라고 판단했든(설령 Haiku가 이 신호를 놓쳤어도) 최종 발송을 거부한다.
const APPROVAL_PATTERN = /(\?|승인|컨펌|확인해\s*주세요|확인\s*부탁|괜찮을까요|진행할까요|어떻게\s*할까요|어떤\s*(거|것|걸)로|선택해\s*주세요|해도\s*될까요|알려주세요|답변\s*부탁)/;

/**
 * @param {string} text - 팀장의 마지막 답변 원문
 * @returns {boolean}
 */
function looksLikeApprovalRequest(text) {
  if (!text) return false;
  return APPROVAL_PATTERN.test(text);
}

/**
 * Haiku 서브 에이전트의 raw 응답(````json` 코드펜스로 감싸져 있을 수 있음)을 엄격하게 검증해서
 * 파싱한다. 필드 타입이 하나라도 안 맞거나 파싱 자체가 실패하면 null을 반환한다 — 호출부는
 * null을 "재촉 안 함"으로 처리해야 한다(fail-closed: 애매하면 아무것도 안 하는 쪽이 안전).
 * @param {unknown} rawResult
 * @returns {{shouldNudge: boolean, waitingForUser: boolean, reason: string} | null}
 */
function parseStallVerdict(rawResult) {
  if (typeof rawResult !== 'string') return null;
  const fenceMatch = rawResult.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = (fenceMatch ? fenceMatch[1] : rawResult).trim();
  if (!jsonText) return null;
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.shouldNudge !== 'boolean') return null;
  if (typeof parsed.waitingForUser !== 'boolean') return null;
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  return { shouldNudge: parsed.shouldNudge, waitingForUser: parsed.waitingForUser, reason };
}

/**
 * "지금 이 상태값 조합이면 건드려도 되는 상황인가"만 따로 뽑은 게이트 — shouldCheckStall(최초
 * 후보 선정)과 main.ts의 발송 직전 최종 재확인이 정확히 같은 규칙을 쓰게 하려고 공용 함수로
 * 뽑았다(재확인 쪽에서 이 규칙의 일부만 손으로 다시 구현하면, 둘이 은근슬쩍 갈라져서 최초
 * 선정에서는 걸렀을 상태가 재확인은 통과하는 사고가 날 수 있다). blocked는 팀원/팀장 어느
 * 쪽이든 절대 통과 못 한다. memberStatus가 빈 문자열('' — status/state 필드 자체가 없다는 뜻,
 * getStatus 참고)이면 "확실히 idle/done임을 모른다"는 뜻이라 안전하게 거부한다.
 * @param {{memberStatus: string, leadStatus: string}} params
 * @returns {boolean}
 */
function isStatusEligibleForStall({ memberStatus, leadStatus }) {
  if (memberStatus === 'blocked' || leadStatus === 'blocked') return false;
  if (leadStatus !== 'idle' && leadStatus !== 'done') return false; // 팀장이 바쁘거나 오프라인이면 스스로 처리할 여지를 준다
  if (memberStatus === 'busy' || memberStatus === '') return false;
  return true;
}

/**
 * 이 후보(팀원 하나)에 대해 (비용이 드는) Haiku 호출을 걸 가치가 있는 상황인지 판정한다.
 * @param {{
 *   memberStatus: string,
 *   leadStatus: string,
 *   memberIdleSince: number | undefined,
 *   leadIdleSince: number | undefined,
 *   now: number,
 *   idleThresholdMs: number,
 *   lastCheckedAt: number | undefined,
 *   cooldownMs: number,
 *   hasExistingAlert: boolean,
 * }} params
 * @returns {boolean}
 */
function shouldCheckStall(params) {
  const {
    memberStatus, leadStatus, memberIdleSince, leadIdleSince,
    now, idleThresholdMs, lastCheckedAt, cooldownMs, hasExistingAlert,
  } = params;
  if (hasExistingAlert) return false;
  if (!isStatusEligibleForStall({ memberStatus, leadStatus })) return false;
  if (memberIdleSince == null || now - memberIdleSince < idleThresholdMs) return false;
  if (leadIdleSince == null || now - leadIdleSince < idleThresholdMs) return false;
  if (lastCheckedAt != null && now - lastCheckedAt < cooldownMs) return false;
  return true;
}

/**
 * Haiku 판단 + 정적 안전장치를 모두 통과해야 최종 발송 허가. verdict.waitingForUser거나
 * lastAnswerText가 승인 요청처럼 보이면, shouldNudge가 true여도 무조건 거부한다.
 * @param {{shouldNudge: boolean, waitingForUser: boolean, reason: string} | null} verdict
 * @param {string} lastAnswerText
 * @returns {boolean}
 */
function shouldSendNudge(verdict, lastAnswerText) {
  if (!verdict) return false;
  if (verdict.waitingForUser) return false;
  if (looksLikeApprovalRequest(lastAnswerText)) return false;
  return !!verdict.shouldNudge;
}

module.exports = { looksLikeApprovalRequest, parseStallVerdict, isStatusEligibleForStall, shouldCheckStall, shouldSendNudge };
