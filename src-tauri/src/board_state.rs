use crate::live_rows::SessionRow;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

/// main.ts 모듈 스코프의 leadFirstMissAt/lastKnownLiveLeadRow/hasCompletedFirstPoll을 그대로
/// 옮긴 것 — Tauri 프로세스가 살아있는 동안(=main.ts의 Electron 메인 프로세스가 살아있는 동안과
/// 같은 수명) 폴링 사이에 유지돼야 하는 상태다. 앱을 재시작하면 그대로 비워진다(원본과 동일한
/// 동작 — LEAD_OFFLINE_GRACE_MS 계산 시 hasCompletedFirstPoll로 첫 폴링만 예외 처리하는 이유도
/// 바로 이 재시작 시 초기화 때문이다).
/// resumeRetryStatus(main.ts:95)의 값 타입 — `{ attempt, max }`. resumeRetryFrom(서브청크 β)이
/// 재시도 중 채우고, buildSessionRowsInternal(main.ts:1512-1517)이 매 폴링 이 맵을 읽어
/// SessionRow.resumeRetrying으로 렌더러에 실어 보낸다(그 필드 자체는 β/δ 범위 — 여기선 상태
/// 저장소만 마련해둔다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResumeRetryStatus {
    pub attempt: i32,
    pub max: i32,
}

pub struct BoardState {
    pub lead_first_miss_at: HashMap<String, i64>,
    pub last_known_live_lead_row: HashMap<String, SessionRow>,
    pub has_completed_first_poll: bool,
    // 정체 감시(runStallWatchdog) 전용 — main.ts 주석대로 반드시 짧은 id가 아니라 sessionId로
    // 키를 잡는다. 짧은 id로 잡으면 stop→resume 등으로 짧은 id만 바뀌어도(세션 자체는 그대로)
    // "처음 보는 키"가 돼서 조용히 리셋되고, 정체 감지가 무기한 미뤄질 수 있다.
    pub member_idle_since: HashMap<String, i64>, // 팀원 sessionId -> idle/done으로 바뀐 시각
    pub lead_idle_since: HashMap<String, i64>,   // 팀장 sessionId -> idle/done으로 바뀐 시각
    pub stall_last_checked_at: HashMap<String, i64>, // 팀원 sessionId -> 마지막으로 실제 Haiku를 호출한 시각

    // 아래 세 개는 이번 서브청크(α)에서 새로 추가 — TAURI_NOTICE_QUEUE_DESIGN.md §2가 지정한
    // "모듈 스코프 Map들의 Rust 동치물 설계" 대상 중 lead_first_miss_at/last_known_live_lead_row/
    // has_completed_first_poll을 뺀 나머지. 실제로 채우고 읽는 로직(resumeRetryFrom/
    // trackAttachTerminal/cleanupStaleMembers 상당)은 β/δ 범위라 여기서는 저장소만 준비한다.
    // §3-4(폴링 루프를 단일 소유자로) 원칙은 "폴링 태스크만 mutate"가 아니라 "모든 접근이 항상
    // 이 BoardState 하나의 Mutex를 짧게 잠그고 원자적으로 끝난다"는 형태로 지킨다 — 이미 있던
    // lead_first_miss_at/last_known_live_lead_row도 같은 패턴이고(get_live_session_rows가
    // await 없이 짧게 lock()만 잡았다 푼다), attach_terminal_pids처럼 폴링 루프가 아닌 IPC
    // 핸들러(open-in-terminal)가 쓰는 맵도 이 규칙만 지키면(다단계 갱신 중간에 .await를 끼우지
    // 않으면) 별도의 "단일 소유 태스크"가 없어도 B-3/B-4류의 TOCTOU 경합이 재발하지 않는다.
    // 이 셋은 β/δ가 쓰기 시작하기 전까지는 프로덕션 코드에서 읽는 곳이 없어(테스트에서만 읽음)
    // `cargo build`(테스트 제외 빌드)가 dead_code 경고를 낸다 — β/δ가 실제 읽기/쓰기 호출부를
    // 추가하는 즉시 이 allow는 지워야 한다.
    #[allow(dead_code)]
    /// resumeRetryStatus(main.ts:95) 동치.
    pub resume_retry_status: HashMap<String, ResumeRetryStatus>,
    #[allow(dead_code)]
    /// attachTerminalPids(main.ts:2895) 동치 — key: 세션 짧은 id, value: WMI로 찾은 PID 목록.
    pub attach_terminal_pids: HashMap<String, Vec<i64>>,
    #[allow(dead_code)]
    /// memberFirstMissAt(main.ts:879) 동치 — cleanupStaleMembers(팀원용 first-miss 유예 판정)가
    /// 쓴다. lead_first_miss_at과 값 타입은 같지만 키 공간이 다르므로(팀원 memberId) 별도 필드.
    pub member_first_miss_at: HashMap<String, i64>,
}

impl BoardState {
    fn new() -> Self {
        Self {
            lead_first_miss_at: HashMap::new(),
            last_known_live_lead_row: HashMap::new(),
            has_completed_first_poll: false,
            member_idle_since: HashMap::new(),
            lead_idle_since: HashMap::new(),
            stall_last_checked_at: HashMap::new(),
            resume_retry_status: HashMap::new(),
            attach_terminal_pids: HashMap::new(),
            member_first_miss_at: HashMap::new(),
        }
    }
}

pub fn state() -> &'static Mutex<BoardState> {
    static STATE: OnceLock<Mutex<BoardState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(BoardState::new()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstMissResult {
    Present,
    FirstMiss,
    WithinGrace,
    Expired,
}

/// firstMissTracker.js의 trackFirstMiss와 동일 — 팀원 정리와 팀장 오프라인 판정이 겪는 TOCTOU
/// 유예 로직이 완전히 같아서 하나로 공유한다(main.ts와 같은 이유).
pub fn track_first_miss(map: &mut HashMap<String, i64>, is_present: bool, id: &str, now: i64, grace_ms: i64) -> FirstMissResult {
    if is_present {
        map.remove(id);
        return FirstMissResult::Present;
    }
    match map.get(id) {
        None => {
            map.insert(id.to_string(), now);
            FirstMissResult::FirstMiss
        }
        Some(&first_miss_at) => {
            if now - first_miss_at < grace_ms {
                FirstMissResult::WithinGrace
            } else {
                FirstMissResult::Expired
            }
        }
    }
}

/// firstMissTracker.js의 pruneMissingKeys와 동일 — 다른 경로로 이미 사라진 id의 기록이 Map에
/// 무한정 쌓이지 않게 한다.
pub fn prune_missing_keys<T>(map: &mut HashMap<String, T>, current_ids: &HashSet<String>) {
    map.retain(|k, _| current_ids.contains(k));
}

#[cfg(test)]
mod tests {
    use super::*;

    // main.ts 주석의 상태 전이(살아있으면 기록 삭제 / 처음 놓치면 기록만 / 유예 안이면 대기 /
    // 유예 지나면 만료, 만료돼도 기록은 안 지움)를 그대로 검증한다.
    #[test]
    fn tracks_first_miss_transitions() {
        let mut map = HashMap::new();

        // 살아있으면 항상 Present, 기록 없음.
        assert_eq!(track_first_miss(&mut map, true, "lead-a", 1_000, 5_000), FirstMissResult::Present);
        assert!(!map.contains_key("lead-a"));

        // 처음 못 잡히면 FirstMiss, 그 시각을 기록.
        assert_eq!(track_first_miss(&mut map, false, "lead-a", 1_000, 5_000), FirstMissResult::FirstMiss);
        assert_eq!(map.get("lead-a"), Some(&1_000));

        // 유예 안이면 WithinGrace, 기록은 그대로.
        assert_eq!(track_first_miss(&mut map, false, "lead-a", 3_000, 5_000), FirstMissResult::WithinGrace);
        assert_eq!(map.get("lead-a"), Some(&1_000));

        // 유예가 지나면 Expired — 호출부(computeOfflineLeads)는 지워도 되지만 이 함수 자체는
        // 지우지 않는다(계속 Expired를 내야 하는 팀장 오프라인 판정이 이 성질에 의존한다).
        assert_eq!(track_first_miss(&mut map, false, "lead-a", 6_500, 5_000), FirstMissResult::Expired);
        assert_eq!(map.get("lead-a"), Some(&1_000));
        assert_eq!(track_first_miss(&mut map, false, "lead-a", 999_999, 5_000), FirstMissResult::Expired);

        // 다시 살아있는 것으로 잡히면 기록이 지워지고, 다음번엔 다시 처음부터(FirstMiss) 시작한다.
        assert_eq!(track_first_miss(&mut map, true, "lead-a", 999_999, 5_000), FirstMissResult::Present);
        assert!(!map.contains_key("lead-a"));
    }

    #[test]
    fn prunes_keys_missing_from_current_set() {
        let mut map: HashMap<String, i64> = HashMap::from([("a".to_string(), 1), ("b".to_string(), 2)]);
        let current: HashSet<String> = HashSet::from(["a".to_string()]);
        prune_missing_keys(&mut map, &current);
        assert!(map.contains_key("a"));
        assert!(!map.contains_key("b"));
    }

    // 이번 서브청크(α)에서 새로 추가한 세 필드가 BoardState 하나의 Mutex 밑에서 정상적으로
    // 읽고 쓰이는지 — β/δ가 채울 실제 로직은 없지만, 저장소 자체는 동작해야 한다.
    #[test]
    fn new_alpha_fields_are_reachable_through_the_shared_mutex() {
        let key = "board-state-alpha-fields-test-key";
        struct Cleanup(&'static str);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let mut guard = state().lock().unwrap();
                guard.resume_retry_status.remove(self.0);
                guard.attach_terminal_pids.remove(self.0);
                guard.member_first_miss_at.remove(self.0);
            }
        }
        let _cleanup = Cleanup(key);

        {
            let mut guard = state().lock().unwrap();
            guard.resume_retry_status.insert(key.to_string(), ResumeRetryStatus { attempt: 1, max: 3 });
            guard.attach_terminal_pids.insert(key.to_string(), vec![1234, 5678]);
            // member_first_miss_at는 lead_first_miss_at과 값 타입이 같으므로 같은 track_first_miss
            // 함수를 그대로 재사용할 수 있어야 한다(키 공간만 다를 뿐 동작은 동일해야 함).
            let result = track_first_miss(&mut guard.member_first_miss_at, false, key, 1_000, 5_000);
            assert_eq!(result, FirstMissResult::FirstMiss);
        }

        let guard = state().lock().unwrap();
        assert_eq!(guard.resume_retry_status.get(key), Some(&ResumeRetryStatus { attempt: 1, max: 3 }));
        assert_eq!(guard.attach_terminal_pids.get(key), Some(&vec![1234, 5678]));
        assert_eq!(guard.member_first_miss_at.get(key), Some(&1_000));
    }
}
