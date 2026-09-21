use crate::live_rows::SessionRow;
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

/// main.ts 모듈 스코프의 leadFirstMissAt/lastKnownLiveLeadRow/hasCompletedFirstPoll을 그대로
/// 옮긴 것 — Tauri 프로세스가 살아있는 동안(=main.ts의 Electron 메인 프로세스가 살아있는 동안과
/// 같은 수명) 폴링 사이에 유지돼야 하는 상태다. 앱을 재시작하면 그대로 비워진다(원본과 동일한
/// 동작 — LEAD_OFFLINE_GRACE_MS 계산 시 hasCompletedFirstPoll로 첫 폴링만 예외 처리하는 이유도
/// 바로 이 재시작 시 초기화 때문이다).
pub struct BoardState {
    pub lead_first_miss_at: HashMap<String, i64>,
    pub last_known_live_lead_row: HashMap<String, SessionRow>,
    pub has_completed_first_poll: bool,
}

impl BoardState {
    fn new() -> Self {
        Self {
            lead_first_miss_at: HashMap::new(),
            last_known_live_lead_row: HashMap::new(),
            has_completed_first_poll: false,
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
}
