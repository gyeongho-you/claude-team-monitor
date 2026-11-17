// 팀장이 "새 작업 시작(맥락 초기화)"이나 resume으로 새 sessionId를 받으면 leads.json의 sessionId는 새 값으로 덮어써진다. 앱의 자동 수집(보고서·PR 링크)과
// 스크립트 패널은 팀장의 "현재 세션" 기록 파일만 보기 때문에, 초기화하는 순간 이전 세션에서 모은 링크가 목록에서 사라졌다.
// 그래서 덮어쓰기 직전의 sessionId를 팀장의 internalId별로 따로 적어 둔다 — leads.json 형식은 건드리지 않는다(구버전 앱·MCP 서버·사용자 스크립트와 호환).
// 이 파일이 없거나 못 읽어도 동작은 "현재 세션만 보기"로 되돌아갈 뿐이라 실패해도 앱 동작을 막지 않는다.

use crate::json_file::{lock_file_for, read_json_text_guarded, write_json_file_atomic};
use crate::session_registry::LeadRecord;
use std::collections::BTreeMap;
use std::path::Path;

/// 팀장 하나가 기억하는 이전 세션 개수 상한(오래된 것부터 버린다).
const MAX_PREVIOUS_PER_LEAD: usize = 30;

type History = BTreeMap<String, Vec<String>>;

fn history_path() -> std::path::PathBuf {
    crate::paths::session_history_path()
}

fn read_at(path: &Path) -> History {
    let Some(raw) = read_json_text_guarded(path) else { return History::new() };
    serde_json::from_str::<History>(&raw).unwrap_or_default()
}

/// sessionId가 `old`에서 `new`로 바뀌는 시점에 부른다. 같은 값이거나 비어 있으면 아무 것도 안 한다.
pub fn remember_replaced_session(internal_id: &str, old_session_id: &str, new_session_id: &str) {
    remember_replaced_session_at(&history_path(), internal_id, old_session_id, new_session_id)
}

pub(crate) fn remember_replaced_session_at(path: &Path, internal_id: &str, old_session_id: &str, new_session_id: &str) {
    if internal_id.is_empty() || old_session_id.is_empty() || old_session_id == new_session_id {
        return;
    }
    let _lock = lock_file_for(path);
    let mut all = read_at(path);
    let list = all.entry(internal_id.to_string()).or_default();
    list.retain(|s| s != old_session_id && s != new_session_id);
    list.push(old_session_id.to_string());
    if list.len() > MAX_PREVIOUS_PER_LEAD {
        let extra = list.len() - MAX_PREVIOUS_PER_LEAD;
        list.drain(..extra);
    }
    if let Err(e) = write_json_file_atomic(path, &all) {
        eprintln!("[sessionHistory] 이전 세션 id를 저장하지 못했습니다(자동 수집이 이전 세션을 못 볼 수 있음): {e}");
    }
}

/// 이 팀장의 이전 세션 id들(오래된 것부터).
pub fn previous_session_ids(internal_id: &str) -> Vec<String> {
    previous_session_ids_at(&history_path(), internal_id)
}

pub(crate) fn previous_session_ids_at(path: &Path, internal_id: &str) -> Vec<String> {
    if internal_id.is_empty() {
        return Vec::new();
    }
    read_at(path).remove(internal_id).unwrap_or_default()
}

/// 현재 세션 id가 맨 앞, 그 뒤로 이전 세션 id들(최신 것부터). 중복 없음.
pub fn all_session_ids(lead: &LeadRecord) -> Vec<String> {
    let previous = lead.internal_id.as_deref().map(previous_session_ids).unwrap_or_default();
    merge_ids(&lead.session_id, previous)
}

fn merge_ids(current: &str, previous_oldest_first: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if !current.is_empty() {
        out.push(current.to_string());
    }
    for s in previous_oldest_first.into_iter().rev() {
        if !s.is_empty() && !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ctm-session-history-{}-{}-{}", tag, std::process::id(), crate::timing::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("sessionHistory.json")
    }

    #[test]
    fn remembers_replaced_sessions_in_order_without_duplicates() {
        let p = temp_file("order");
        remember_replaced_session_at(&p, "lead-a", "s1", "s2");
        remember_replaced_session_at(&p, "lead-a", "s2", "s3");
        remember_replaced_session_at(&p, "lead-a", "s2", "s3");
        assert_eq!(previous_session_ids_at(&p, "lead-a"), vec!["s1".to_string(), "s2".to_string()]);
        assert!(previous_session_ids_at(&p, "lead-b").is_empty(), "다른 팀장 것은 섞이지 않는다");
    }

    #[test]
    fn ignores_empty_or_unchanged_ids() {
        let p = temp_file("noop");
        remember_replaced_session_at(&p, "lead-a", "", "s2");
        remember_replaced_session_at(&p, "lead-a", "s2", "s2");
        remember_replaced_session_at(&p, "", "s1", "s2");
        assert!(!p.exists(), "기록할 게 없으면 파일도 만들지 않는다");
    }

    #[test]
    fn drops_the_oldest_beyond_the_cap_and_never_lists_the_new_current_session() {
        let p = temp_file("cap");
        for i in 0..(MAX_PREVIOUS_PER_LEAD + 5) {
            remember_replaced_session_at(&p, "lead-a", &format!("s{i}"), &format!("s{}", i + 1));
        }
        let ids = previous_session_ids_at(&p, "lead-a");
        assert_eq!(ids.len(), MAX_PREVIOUS_PER_LEAD);
        assert_eq!(ids.first().map(String::as_str), Some("s5"), "가장 오래된 것부터 버린다");
        // 예전 세션으로 되돌아온 경우(새 값이 이미 목록에 있음) 현재 세션은 이전 목록에서 빠진다
        remember_replaced_session_at(&p, "lead-a", "x", "s10");
        assert!(!previous_session_ids_at(&p, "lead-a").contains(&"s10".to_string()));
    }

    #[test]
    fn corrupt_file_reads_as_empty_instead_of_failing() {
        let p = temp_file("corrupt");
        std::fs::write(&p, "{ not json").unwrap();
        assert!(previous_session_ids_at(&p, "lead-a").is_empty());
    }

    #[test]
    fn merge_puts_current_first_then_previous_newest_first_without_duplicates() {
        let merged = merge_ids("cur", vec!["a".into(), "b".into(), "cur".into(), "a".into()]);
        assert_eq!(merged, vec!["cur".to_string(), "a".to_string(), "b".to_string()]);
        assert_eq!(merge_ids("", vec!["a".into()]), vec!["a".to_string()]);
    }
}
