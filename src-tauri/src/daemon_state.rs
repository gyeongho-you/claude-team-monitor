// 이번 청크 — get-pending-choice/get-chat-unresolvable-detail(main.ts:2655-2701)의 포팅. 둘 다
// claude CLI 자신이 job마다 관리하는 ~/.claude/jobs/<shortId>/state.json을 읽는 순수 파일 읽기다
// (claude agents --json엔 이 상세 내용이 없다, 실측 확인). 이 파일은 daemon이 수시로 덮어쓰는 내부
// 상태라 스키마가 안 바뀐다는 보장이 없으므로, 읽기 실패나 예상과 다른 형태는 전부 조용히 None으로
// 넘긴다(main.ts와 동일 — 안내를 못 보여줄 뿐, 채팅 자체는 그대로 정상 동작해야 한다).

use crate::paths::{is_safe_id, jobs_dir};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct PendingChoiceOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingChoiceQuestion {
    pub question: String,
    pub options: Vec<PendingChoiceOption>,
}

fn state_json_path(jobs_dir: &Path, short_id: &str) -> std::path::PathBuf {
    jobs_dir.join(short_id).join("state.json")
}

/// readPendingChoiceQuestions(main.ts:2655-2669)와 동일 — AskUserQuestion으로 멈춘 세션이 실제로
/// 무엇을 물었는지(질문 문구 + 선택지)를 daemon의 state.json(block.questions)에서 읽는다.
fn read_pending_choice_questions_in(jobs_dir: &Path, short_id: &str) -> Option<Vec<PendingChoiceQuestion>> {
    if !is_safe_id(short_id) {
        return None;
    }
    let raw = std::fs::read_to_string(state_json_path(jobs_dir, short_id)).ok()?;
    let data: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let questions = data.get("block")?.get("questions")?.as_array()?;
    if questions.is_empty() {
        return None;
    }
    let result: Vec<PendingChoiceQuestion> = questions
        .iter()
        .filter_map(|q| {
            let question = q.get("question")?.as_str()?.to_string();
            let options_val = q.get("options")?.as_array()?;
            let options: Vec<PendingChoiceOption> = options_val
                .iter()
                .filter_map(|o| {
                    let label = o.get("label")?.as_str()?.to_string();
                    let description = o.get("description").and_then(|d| d.as_str()).map(str::to_string);
                    Some(PendingChoiceOption { label, description })
                })
                .collect();
            if options.is_empty() {
                None
            } else {
                Some(PendingChoiceQuestion { question, options })
            }
        })
        .collect();
    Some(result)
}

#[tauri::command]
pub fn get_pending_choice_command(short_id: String) -> Option<Vec<PendingChoiceQuestion>> {
    read_pending_choice_questions_in(&jobs_dir(), &short_id)
}

// CHAT_UNRESOLVABLE_DETAIL_PATTERNS(main.ts:2678) — 채팅으로는 절대 못 풀리는 blocked 상태를
// 좁게 잡는다(사람이 터미널에서 직접 /login 등을 해야 풀리는 경우, 실사용 확인: 2026-09-17). claude
// CLI가 로그인 갱신 실패 때 남기는 문구가 이것뿐이라는 보장은 없다(버전이 바뀌면 문구가 달라질 수
// 있음, main.ts의 extractStartedCopyId와 같은 한계) — 오탐(진짜 채팅으로 풀리는 질문을 "터미널
// 가라"고 잘못 안내)보다는 미탐(놓쳐서 그냥 "확인 필요"로만 보이는 것)이 덜 위험하다고 판단해 패턴을
// 넓히지 않는다.
fn chat_unresolvable_detail_patterns() -> &'static [&'static str] {
    &["could not refresh your login"]
}

fn matches_any_pattern(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    chat_unresolvable_detail_patterns().iter().any(|p| lower.contains(p))
}

/// readChatUnresolvableBlockDetail(main.ts:2679-2687)과 동일.
fn read_chat_unresolvable_block_detail_in(jobs_dir: &Path, short_id: &str) -> Option<String> {
    if !is_safe_id(short_id) {
        return None;
    }
    let raw = std::fs::read_to_string(state_json_path(jobs_dir, short_id)).ok()?;
    let data: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if data.get("state").and_then(|s| s.as_str()) != Some("blocked") {
        return None;
    }
    let detail = data.get("detail")?.as_str()?;
    if !matches_any_pattern(detail) {
        return None;
    }
    Some(detail.to_string())
}

#[tauri::command]
pub fn get_chat_unresolvable_detail_command(short_id: String) -> Option<String> {
    read_chat_unresolvable_block_detail_in(&jobs_dir(), &short_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_jobs_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_jobs_{tag}_{}", uuid::Uuid::new_v4()))
    }

    fn write_state(jobs_dir: &Path, short_id: &str, content: &str) {
        let dir = jobs_dir.join(short_id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("state.json"), content).unwrap();
    }

    #[test]
    fn read_pending_choice_questions_rejects_unsafe_short_id() {
        let dir = temp_jobs_dir("unsafe");
        assert!(read_pending_choice_questions_in(&dir, "../escape").is_none());
    }

    #[test]
    fn read_pending_choice_questions_returns_none_when_no_questions_block() {
        let dir = temp_jobs_dir("no-block");
        write_state(&dir, "job1", r#"{"state":"running"}"#);
        assert!(read_pending_choice_questions_in(&dir, "job1").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_pending_choice_questions_parses_valid_questions() {
        let dir = temp_jobs_dir("valid");
        write_state(
            &dir,
            "job1",
            r#"{"block":{"questions":[{"question":"어느 쪽?","options":[{"label":"A","description":"설명A"},{"label":"B"}]}]}}"#,
        );
        let result = read_pending_choice_questions_in(&dir, "job1").expect("파싱돼야 한다");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].question, "어느 쪽?");
        assert_eq!(result[0].options.len(), 2);
        assert_eq!(result[0].options[0].description.as_deref(), Some("설명A"));
        assert_eq!(result[0].options[1].description, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_pending_choice_questions_drops_questions_with_no_valid_options() {
        let dir = temp_jobs_dir("empty-options");
        write_state(&dir, "job1", r#"{"block":{"questions":[{"question":"질문","options":[]}]}}"#);
        let result = read_pending_choice_questions_in(&dir, "job1").expect("배열 자체는 반환돼야 한다");
        assert!(result.is_empty(), "옵션이 없는 질문은 걸러져야 한다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_pending_choice_questions_returns_none_on_malformed_json() {
        let dir = temp_jobs_dir("malformed");
        write_state(&dir, "job1", "이건 JSON이 아님");
        assert!(read_pending_choice_questions_in(&dir, "job1").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_chat_unresolvable_detail_matches_login_refresh_pattern_case_insensitively() {
        let dir = temp_jobs_dir("login");
        write_state(&dir, "job1", r#"{"state":"blocked","detail":"Could Not Refresh Your Login because another process is refreshing it"}"#);
        let detail = read_chat_unresolvable_block_detail_in(&dir, "job1").expect("매칭돼야 한다");
        assert!(detail.contains("Refresh Your Login"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_chat_unresolvable_detail_ignores_non_blocked_state() {
        let dir = temp_jobs_dir("not-blocked");
        write_state(&dir, "job1", r#"{"state":"running","detail":"could not refresh your login"}"#);
        assert!(read_chat_unresolvable_block_detail_in(&dir, "job1").is_none(), "state가 blocked가 아니면 무시해야 한다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_chat_unresolvable_detail_ignores_unrelated_blocked_reason() {
        let dir = temp_jobs_dir("unrelated");
        write_state(&dir, "job1", r#"{"state":"blocked","detail":"어떤 다른 이유로 멈춤"}"#);
        assert!(read_chat_unresolvable_block_detail_in(&dir, "job1").is_none(), "알려진 패턴이 아니면 None이어야 한다(오탐보다 미탐이 낫다는 판단)");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
