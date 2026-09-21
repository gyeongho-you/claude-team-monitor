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

    // 아래 두 개는 서브청크 α에서 저장소만 마련해뒀던 것 — 실제로 채우고 읽는 로직은 δ 범위라
    // 아직 여기서는 저장소만 준비한다. §3-4(폴링 루프를 단일 소유자로) 원칙은 "폴링 태스크만
    // mutate"가 아니라 "모든 접근이 항상 이 BoardState 하나의 Mutex를 짧게 잠그고 원자적으로
    // 끝난다"는 형태로 지킨다 — attach_terminal_pids처럼 폴링 루프가 아닌 IPC 핸들러(open-in-terminal)가
    // 쓰는 맵도 이 규칙만 지키면(다단계 갱신 중간에 .await를 끼우지 않으면) 별도의 "단일 소유
    // 태스크"가 없어도 B-3/B-4류의 TOCTOU 경합이 재발하지 않는다.
    /// resumeRetryStatus(main.ts:95) 동치 — 서브청크 β(resume.rs)가 resume_retry_from에서
    /// 실제로 채우고/지우기 시작했다(α의 #[allow(dead_code)]는 여기서 뗀다).
    pub resume_retry_status: HashMap<String, ResumeRetryStatus>,
    /// attachTerminalPids(main.ts:2895) 동치 — key: 세션 짧은 id, value: WMI로 찾은 PID 목록.
    /// 서브청크 δ부터 is_attach_terminal_open_for(아래)가 실제로 읽는다 — 이 맵을 채우는
    /// open-in-terminal IPC(별도 트랙, TAURI_NOTICE_QUEUE_DESIGN.md §2)는 아직 미포팅이라 지금은
    /// 항상 비어있고, is_attach_terminal_open_for는 그래서 지금은 항상 false를 반환한다(안전한
    /// 기본값 — "attach 터미널 없음"과 같은 뜻). 그 트랙이 채워지는 순간부터 자동으로 올바르게
    /// 동작한다(설계 문서의 "구현은 병렬이어도 인터페이스 합의는 먼저" 요구사항).
    pub attach_terminal_pids: HashMap<String, Vec<i64>>,
    #[allow(dead_code)]
    /// memberFirstMissAt(main.ts:879) 동치 — cleanupStaleMembers(팀원용 first-miss 유예 판정)가
    /// 쓴다. lead_first_miss_at과 값 타입은 같지만 키 공간이 다르므로(팀원 memberId) 별도 필드.
    pub member_first_miss_at: HashMap<String, i64>,
    /// lastMemberStatus(main.ts:853) 동치 — key: 팀원의 짧은 id(main.ts와 동일하게 sessionId가
    /// 아니라 짧은 id다). notifyLeadsOfFinishedMembers(notice_queue.rs)가 폴링마다 busy→idle/done
    /// 전이를 감지하는 데 쓴다.
    pub last_member_status: HashMap<String, String>,
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
            last_member_status: HashMap::new(),
        }
    }
}

pub fn state() -> &'static Mutex<BoardState> {
    static STATE: OnceLock<Mutex<BoardState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(BoardState::new()))
}

// ---------------------------------------------------------------------------------------------
// isAttachTerminalOpenFor(main.ts) — resumeLead/deliverPendingNotices가 stop→resume을 걸기 전에
// 확인한다(D-3/H-2). 살아있는 PID가 하나도 없으면(창을 닫았거나 애초에 못 찾았으면) false를
// 돌려주면서 지도도 정리한다. Windows에서 프로세스 생존을 확인하는 표준 API가 std에 없어서
// tasklist를 그대로 spawn한다(main.ts의 WMI 조회와 같은 "외부 명령으로 확인" 방식 — 새 crate
// 의존성을 추가하지 않는다).
// ---------------------------------------------------------------------------------------------

#[cfg(windows)]
fn is_process_alive(pid: i64) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}
#[cfg(not(windows))]
fn is_process_alive(_pid: i64) -> bool {
    false
}

/// isAttachTerminalOpenFor(main.ts:2908)와 동일. 맵 접근은 state()의 Mutex로 짧게 잠그고,
/// 블로킹 프로세스 조회(is_process_alive)는 그 락을 놓은 뒤에 한다 — 락을 쥔 채로 자식 프로세스를
/// spawn하면 다른 board_state 접근자가 그동안(짧지만) 기다려야 한다.
pub fn is_attach_terminal_open_for(session_short_id: &str) -> bool {
    let pids = {
        let guard = state().lock().unwrap();
        match guard.attach_terminal_pids.get(session_short_id) {
            Some(p) if !p.is_empty() => p.clone(),
            _ => return false,
        }
    };
    let alive: Vec<i64> = pids.iter().copied().filter(|&pid| is_process_alive(pid)).collect();
    let mut guard = state().lock().unwrap();
    if alive.is_empty() {
        guard.attach_terminal_pids.remove(session_short_id);
        false
    } else {
        if alive.len() != pids.len() {
            guard.attach_terminal_pids.insert(session_short_id.to_string(), alive);
        }
        true
    }
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

    // is_attach_terminal_open_for(δ) — 맵에 아예 없거나 빈 목록이면 false, 죽은 PID만 있으면
    // false로 정리(맵에서 제거), 하나라도 살아있으면 true + 죽은 것만 걸러서 갱신.
    #[test]
    fn is_attach_terminal_open_for_reports_liveness_and_prunes_dead_pids() {
        let key = "board-state-attach-terminal-test-key";
        struct Cleanup(&'static str);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                state().lock().unwrap().attach_terminal_pids.remove(self.0);
            }
        }
        let _cleanup = Cleanup(key);

        // 맵에 아예 없으면 false.
        assert!(!is_attach_terminal_open_for(key));

        // 절대 살아있을 수 없는 PID(0은 System Idle Process라 tasklist가 실제 프로세스로 안 잡음,
        // 아주 큰 값도 마찬가지)만 있으면 false로 정리되고, 맵에서도 지워져야 한다.
        state().lock().unwrap().attach_terminal_pids.insert(key.to_string(), vec![999_999_999]);
        assert!(!is_attach_terminal_open_for(key));
        assert!(state().lock().unwrap().attach_terminal_pids.get(key).is_none(), "죽은 PID만 있었으면 맵에서 지워져야 한다");

        // 지금 이 테스트 프로세스 자신의 PID는 항상 살아있다 — true를 반환해야 한다.
        let my_pid = std::process::id() as i64;
        state().lock().unwrap().attach_terminal_pids.insert(key.to_string(), vec![my_pid, 999_999_999]);
        assert!(is_attach_terminal_open_for(key), "살아있는 PID가 하나라도 있으면 true여야 한다");
        assert_eq!(
            state().lock().unwrap().attach_terminal_pids.get(key),
            Some(&vec![my_pid]),
            "죽은 PID는 걸러지고 살아있는 것만 남아야 한다"
        );
    }
}
