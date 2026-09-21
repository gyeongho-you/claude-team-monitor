// main.ts의 "타이밍 상수" 섹션과 정확히 같은 값·같은 계산식이어야 한다 — 유예값이 어긋나면
// (예: 재기동 최악 시간보다 유예가 짧으면) 아직 살아있는(느리게 재기동 중인) 팀장을 오프라인으로
// 오판하는 회귀가 재현된 적이 있다(main.ts 주석 참고). 이번 청크는 팀장 쪽(LEAD_OFFLINE_GRACE_MS)만
// 실제로 쓰지만, 그 값이 의존하는 계산식 전체(STOP_AND_RELAUNCH_WORST_CASE_MS 등)와 팀원 쪽
// (MEMBER_MISS_GRACE_MS, cleanupStaleMembers가 다음 청크에서 쓸 값)까지 그대로 옮겨서 두 값이
// 서로 다른 곳에서 따로 계산되며 드리프트하는 일이 없게 한다.

pub const RUN_CLAUDE_TIMEOUT_MS: i64 = 45_000;
pub const STOP_SESSION_TIMEOUT_MS: i64 = 15_000;
pub const RESUME_SETTLE_CHECK_MS: i64 = 13_000;
pub const RESUME_RETRY_GAP_MS: i64 = 5_000;
pub const MAX_RESUME_ATTEMPTS: i64 = 3;

pub const RESUME_SPAWN_WORST_CASE_MS: i64 =
    MAX_RESUME_ATTEMPTS * (RUN_CLAUDE_TIMEOUT_MS + RESUME_SETTLE_CHECK_MS) + (MAX_RESUME_ATTEMPTS - 1) * RESUME_RETRY_GAP_MS;
pub const STOP_AND_RELAUNCH_WORST_CASE_MS: i64 = STOP_SESSION_TIMEOUT_MS + RESUME_SPAWN_WORST_CASE_MS;
pub const OFFLINE_GRACE_BUFFER_MS: i64 = 15_000;

/// 팀장 오프라인 확정 유예 — 이번 청크(computeOfflineLeads)가 실제로 쓰는 값.
pub const LEAD_OFFLINE_GRACE_MS: i64 = STOP_AND_RELAUNCH_WORST_CASE_MS + OFFLINE_GRACE_BUFFER_MS;

// 아래 두 값은 팀원 정리(cleanupStaleMembers)가 쓰는 값이라 이번 청크(팀장 오프라인 판정)엔 안
// 쓰이지만, 다음 청크가 main.ts와 똑같은 계산식을 다시 베끼지 않고 바로 재사용할 수 있게 미리
// 옮겨둔다.
#[allow(dead_code)]
pub const MEMBER_CLEANUP_GRACE_MS: i64 = 15_000;
#[allow(dead_code)]
pub const MEMBER_EXTERNAL_LEAD_ORCHESTRATION_BUFFER_MS: i64 = 30_000;
#[allow(dead_code)]
pub const MEMBER_MISS_GRACE_MS: i64 =
    STOP_AND_RELAUNCH_WORST_CASE_MS + OFFLINE_GRACE_BUFFER_MS + MEMBER_EXTERNAL_LEAD_ORCHESTRATION_BUFFER_MS;

/// 정체 감시(stall watchdog)가 쓰는 기본값 — 사용자가 settings.json으로 바꿀 수 있는 값의
/// "아직 아무것도 저장 안 됐을 때" 기본값이다. main.ts의 STALL_IDLE_THRESHOLD_MS_DEFAULT/
/// STALL_RECHECK_COOLDOWN_MS_DEFAULT와 동일.
pub const STALL_IDLE_THRESHOLD_MS_DEFAULT: i64 = 10 * 60 * 1000;
pub const STALL_RECHECK_COOLDOWN_MS_DEFAULT: i64 = 20 * 60 * 1000;
/// Haiku 서브 에이전트 한 번 호출에 걸리는 실측 시간(콜드 스타트 포함 최대 수십 초)을 감안한
/// 타임아웃 — main.ts의 STALL_CLASSIFIER_TIMEOUT_MS와 동일.
pub const STALL_CLASSIFIER_TIMEOUT_MS: u64 = 45_000;

/// deliverPendingNotices(main.ts:78)의 회로차단기 상한 — D-9. 영원히 stop이 안 되는 팀장(좀비
/// 프로세스 등)에게 무기한 재시도하며 프로세스 스폰과 에러 로그를 낭비하지 않도록, 이 횟수만큼
/// 연속 실패하면 자동 재시도를 멈추되 큐에서 제거하지는 않는다(notice_queue.rs 참고).
pub const MAX_NOTICE_DELIVERY_ATTEMPTS: i64 = 5;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_main_ts_computed_values() {
        // main.ts에서 실제로 계산되는 값(RESUME_SPAWN_WORST_CASE_MS=184000,
        // STOP_AND_RELAUNCH_WORST_CASE_MS=199000, LEAD_OFFLINE_GRACE_MS=214000,
        // MEMBER_MISS_GRACE_MS=244000)과 어긋나면 두 코드베이스의 유예 시간이 갈라진다 — 상수
        // 하나라도 잘못 옮기면 이 테스트가 바로 잡아낸다.
        assert_eq!(RESUME_SPAWN_WORST_CASE_MS, 184_000);
        assert_eq!(STOP_AND_RELAUNCH_WORST_CASE_MS, 199_000);
        assert_eq!(LEAD_OFFLINE_GRACE_MS, 214_000);
        assert_eq!(MEMBER_MISS_GRACE_MS, 244_000);
    }
}
