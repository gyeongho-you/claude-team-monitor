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
            // grace_ms<=0은 "유예 없이 즉시 만료"를 의도한 호출(예: 앱 재시작 직후 첫 폴링, 또는
            // endLeadWork가 확정 종료를 알리려고 유예를 건너뛰는 경우)인데, 이 id를 처음 보는
            // 순간이면(map에 아직 기록이 없으면) 항상 FirstMiss만 반환해서 grace_ms를 사실상 무시하고
            // 있었다(실측 UI 테스트에서 죽은 팀장이 앱 재시작 후 ~217초 동안 어느 탭에도 안 보이는
            // 것으로 재현됨).
            //
            // 1차 수정(grace_ms<=0이면 Expired 반환)만으로는 부족했다 — first_miss_at을 now로
            // 기록해버리면, 바로 다음 폴링부터 has_completed_first_poll이 true가 돼 grace_ms가
            // 원래 유예(LEAD_OFFLINE_GRACE_MS, 3분 이상)로 늘어나는데, 그 큰 유예를 "방금 기록한
            // now" 기준으로 다시 재는 바람에 now-first_miss_at(수 초)<grace_ms가 성립해 WithinGrace로
            // 되돌아간다 — endLeadWork(main.ts의 leadFirstMissAt.set(id,0))와 정확히 같은 이유로,
            // 여기서도 now 대신 0(아주 오래 전)을 기록해야 이후 어떤 grace_ms가 오더라도 다시
            // 유예 안으로 들어가지 않는다(실측 UI 재검증에서 첫 폴링엔 정상 해소됐다가 t=97~220초
            // 구간에 다시 공백이 재현되는 것으로 확인, 원인을 여기로 추적함).
            map.insert(id.to_string(), if grace_ms <= 0 { 0 } else { now });
            if grace_ms <= 0 {
                FirstMissResult::Expired
            } else {
                FirstMissResult::FirstMiss
            }
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

// migrateLastKnownLiveLeadRow(main.ts, 오늘 Electron에서 실사용 재현 후 신규 추가) 포팅 —
// last_known_live_lead_row는 팀장의 짧은 id를 키로 캐시한다. resume_lead/restart_lead가 그 id를
// 바꾸는 순간부터, live_rows::get_live_session_rows_inner가 다음 폴링에서 claude agents --json으로
// 그 새 id를 실제 살아있다고 확인할 때까지는 이 캐시가 여전히 "옛 id" 밑에만 있다. 그 사이 도는
// 폴링은 이 팀장을 옛 id로도(agents 스냅샷에 없음) 새 id로도(캐시에 아직 없음) 못 찾아 rows에서
// 통째로 빠뜨리고, 렌더러가 "선택된 팀장이 없어졌다"고 오판해 다른(아무) 온라인 팀장으로 화면을
// 튕겨버릴 수 있다 — 오늘 Electron main.ts에서 실사용으로 재현·수정된 것과 완전히 같은 사고다.
// id가 바뀌는 바로 그 자리(resume.rs/lead_lifecycle.rs가 leads.json에 새 id를 쓰는 지점)에서
// 캐시도 새 id로 함께 옮겨두면, agents 스냅샷이 따라잡을 때까지의 그 짧은 틈에도 옛 스냅숏을
// 새 id로 계속 보여줄 수 있다. 캐시에 옛 id 밑 항목이 아예 없으면(한 번도 라이브로 안 잡혔던
// 경우 등) 조용히 아무 일도 안 한다 — 안전한 no-op.
pub fn migrate_last_known_live_lead_row(old_id: &str, new_id: &str) {
    if old_id == new_id {
        return;
    }
    let mut guard = state().lock().unwrap();
    if let Some(mut row) = guard.last_known_live_lead_row.remove(old_id) {
        row.agent.id = Some(new_id.to_string());
        guard.last_known_live_lead_row.insert(new_id.to_string(), row);
    }
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

    // 실측 UI 테스트로 재현됨(2026-09-22): 앱을 새로 켜면 lead_first_miss_at이 메모리라 전부
    // 비어서, 이미 죽어있던 팀장도 정상 유예(LEAD_OFFLINE_GRACE_MS, 3분 이상)만큼 화면 어디에도
    // 안 보이는 공백이 생겼다. computeOfflineLeads는 앱 시작 직후 첫 폴링에만 grace_ms=0을 주는데,
    // 예전엔 이 함수가 "처음 보는 id"면 grace_ms 값과 무관하게 항상 FirstMiss만 반환해서, 그
    // grace_ms=0이 있으나 마나였다(같은 버그가 Node 쪽 firstMissTracker.js에도 있었다).
    #[test]
    fn zero_grace_expires_immediately_even_on_first_sighting() {
        let mut map = HashMap::new();
        assert_eq!(track_first_miss(&mut map, false, "lead-a", 1_000, 0), FirstMissResult::Expired);
        assert_eq!(map.get("lead-a"), Some(&0)); // now가 아니라 0으로 기록돼야 한다(아래 테스트가 그 이유)
        assert_eq!(track_first_miss(&mut map, false, "lead-a", 1_001, 0), FirstMissResult::Expired);
    }

    // 실측 UI 재검증(2026-09-23)으로 발견된 회귀: 위 수정이 first_miss_at을 now로 기록했더니,
    // has_completed_first_poll이 true로 바뀌어 grace_ms가 LEAD_OFFLINE_GRACE_MS(3분 이상)로
    // 늘어나는 바로 다음 폴링에서, "방금 기록한 now" 기준으로 그 큰 유예를 다시 재는 바람에
    // WithinGrace로 되돌아갔다 — 앱 재시작 후 화면에 잠깐 보였다가 다시 사라지는 것으로 재현됨.
    #[test]
    fn zero_grace_expiry_stays_expired_even_after_grace_grows_on_a_later_poll() {
        // now는 실제 운영 환경처럼 Date.now() 규모(현실적인 epoch ms)여야 한다 — first_miss_at을
        // 0으로 기록하는 이 수정은 "now가 충분히 커서 now-0이 어떤 grace_ms보다도 크다"는 전제에
        // 기대기 때문에, 테스트에서도 작은 상대값(예: 1_000)을 쓰면 이 전제가 깨져 회귀를 못 잡는다.
        let base: i64 = 1_790_000_000_000;
        let mut map = HashMap::new();
        // 앱 재시작 직후 첫 폴링: grace_ms=0으로 즉시 만료.
        assert_eq!(track_first_miss(&mut map, false, "lead-a", base, 0), FirstMissResult::Expired);
        // has_completed_first_poll이 true로 바뀌어 그 다음 폴링부터는 원래 유예(3분 이상)가 온다 —
        // 그래도 여전히 Expired여야 한다(이미 기록이 0이라 어떤 실제 시각을 넣어도 유예 안에 못 든다).
        assert_eq!(track_first_miss(&mut map, false, "lead-a", base + 4_000, 214_000), FirstMissResult::Expired);
        assert_eq!(track_first_miss(&mut map, false, "lead-a", base + 300_000, 214_000), FirstMissResult::Expired);
    }

    #[test]
    fn prunes_keys_missing_from_current_set() {
        let mut map: HashMap<String, i64> = HashMap::from([("a".to_string(), 1), ("b".to_string(), 2)]);
        let current: HashSet<String> = HashSet::from(["a".to_string()]);
        prune_missing_keys(&mut map, &current);
        assert!(map.contains_key("a"));
        assert!(!map.contains_key("b"));
    }

    fn fake_row_for_migration_test(id: &str, internal_id: &str) -> crate::live_rows::SessionRow {
        crate::live_rows::SessionRow {
            agent: crate::agents_json::AgentEntry {
                id: Some(id.to_string()),
                pid: None,
                cwd: String::new(),
                kind: "background".to_string(),
                started_at: None,
                session_id: "migrate-test-session".to_string(),
                name: None,
                status: Some("idle".to_string()),
                state: None,
                waiting_for: None,
            },
            project_name: "test-project".to_string(),
            preview: None,
            is_lead: true,
            lead_id: None,
            role: None,
            label: None,
            offline: false,
            internal_id: Some(internal_id.to_string()),
            auto_stall_nudge: None,
            secret: None,
        }
    }

    // migrate_last_known_live_lead_row — resume_lead/restart_lead가 짧은 id를 바꾸는 순간, 캐시된
    // 스냅숏도 옛 id에서 새 id로 옮겨지고 그 안의 agent.id도 함께 갱신돼야 한다(다른 필드는 그대로
    // 보존).
    #[test]
    fn migrate_last_known_live_lead_row_moves_cache_entry_to_new_id() {
        let old_id = "migrate-test-old-id";
        let new_id = "migrate-test-new-id";

        struct Cleanup(&'static str, &'static str);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let mut guard = state().lock().unwrap();
                guard.last_known_live_lead_row.remove(self.0);
                guard.last_known_live_lead_row.remove(self.1);
            }
        }
        let _cleanup = Cleanup(old_id, new_id);

        state().lock().unwrap().last_known_live_lead_row.insert(old_id.to_string(), fake_row_for_migration_test(old_id, "migrate-test-internal"));

        migrate_last_known_live_lead_row(old_id, new_id);

        let guard = state().lock().unwrap();
        assert!(guard.last_known_live_lead_row.get(old_id).is_none(), "옛 id 밑 항목은 지워져야 한다");
        let migrated = guard.last_known_live_lead_row.get(new_id).expect("새 id 밑으로 옮겨져야 한다");
        assert_eq!(migrated.agent.id.as_deref(), Some(new_id), "옮긴 행의 내부 agent.id도 새 id로 갱신돼야 한다");
        assert_eq!(migrated.internal_id.as_deref(), Some("migrate-test-internal"), "다른 필드는 그대로 보존돼야 한다");
    }

    // 캐시에 옛 id 항목이 아예 없으면(한 번도 라이브로 안 잡혔던 경우 등) 조용히 아무 일도 안 해야
    // 한다 — 안전한 no-op.
    #[test]
    fn migrate_last_known_live_lead_row_is_noop_when_no_cache_entry_exists() {
        migrate_last_known_live_lead_row("migrate-test-missing-old", "migrate-test-missing-new");
        let guard = state().lock().unwrap();
        assert!(guard.last_known_live_lead_row.get("migrate-test-missing-new").is_none());
    }

    // old_id == new_id면(호출부가 이미 걸러야 하지만) 이중 방어로 아무 일도 안 해야 한다 — 패닉만
    // 안 나면 통과.
    #[test]
    fn migrate_last_known_live_lead_row_is_noop_when_ids_are_equal() {
        migrate_last_known_live_lead_row("migrate-test-same-id", "migrate-test-same-id");
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
