// 이번 청크 — get-lead-transcript(main.ts:2638-2643)의 포팅. daily-journal 기록(read_journal_entries,
// live_rows.rs가 이미 포팅해뒀다)을 우선 신뢰하고, 거기 없는(원본 세션 파일에는 있는) 뒷부분만
// 원본 세션 파일(~/.claude/projects/<cwd 인코딩>/<sessionId>.jsonl)에서 보완해서 이어붙인다
// (fillMissingTranscriptFromRawSession, main.ts:557-579) — 완전히 원본으로 교체하지 않는다.

use crate::live_rows::{encode_project_dir_name, read_journal_entries, resolve_project_name};
use crate::paths::projects_dir;
use crate::session_registry::load_leads;
use chrono::Local;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TranscriptEntry {
    pub time: String,
    pub prompt: String,
    pub answer: String,
}

// formatRawSessionTimestamp(main.ts)와 동일 — ISO8601 타임스탬프를 daily-journal과 같은
// "YYYY-MM-DD HH:MM"(로컬 시각, 분 단위) 포맷으로 바꾼다. 파싱 실패하면 빈 문자열.
fn format_raw_session_timestamp(iso: Option<&str>) -> String {
    let Some(iso) = iso else { return String::new() };
    let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso) else { return String::new() };
    dt.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string()
}

// 팀장이 team-lead 스킬로 git worktree에 들어가서 작업하면(EnterWorktree, 흔한 패턴), claude
// CLI 자신의 원본 세션 파일은 실제로 작업 중인 worktree 하위 디렉토리까지 포함해 인코딩된 폴더에
// 남는다(실측 확인: "<원래 cwd 인코딩>--claude-worktrees-<이름>" 폴더). 그런데 leads.json의
// targetDir은 팀장을 처음 띄울 때 등록한 원래 디렉토리 그대로라 이 worktree 접미사를 모른다 —
// 그 결과 원본 파일을 못 찾아서(fill_missing_transcript_from_raw_session_at이 fail-open으로
// daily-journal 기록만 신뢰) 지금 턴이 아직 안 끝나(Stop 훅 전) daily-journal에 아무것도 안 남은
// 동안은 채팅창이 그 사이 진행 상황을 전혀 못 보여준다(실사용 재현: 업무가 들어가도 그걸 인지 못
// 하고 "먹통일 수 있습니다"로 오판). 원래 경로가 없으면 이 worktree 접미사가 붙은 폴더들 중 이
// 세션 파일을 가진 걸 찾아서 대신 쓴다 — 접두사를 "--claude-worktrees-"까지 정확히 요구해서, 이름
// 뒤쪽이 우연히 겹치는 무관한 다른 프로젝트 폴더를 잘못 집는 일이 없게 한다.
pub(crate) fn session_file_path(cwd: &str, session_id: &str) -> PathBuf {
    session_file_path_in(&projects_dir(), cwd, session_id)
}

/// 팀장 세션 원본 파일의 마지막 수정 시각(ms) — daily-journal 기록이 없는 세션(시크릿 모드 등)도
/// "마지막으로 대화한 시각"을 알 수 있게 하는 보조 기준이다(히스토리 정렬용). 파일이 없으면 None.
pub(crate) fn session_last_modified_ms(cwd: &str, session_id: &str) -> Option<i64> {
    let modified = std::fs::metadata(session_file_path(cwd, session_id)).ok()?.modified().ok()?;
    modified.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

fn session_file_path_in(projects_dir: &Path, cwd: &str, session_id: &str) -> PathBuf {
    let prefix = encode_project_dir_name(cwd);
    let filename = format!("{session_id}.jsonl");
    let expected = projects_dir.join(&prefix).join(&filename);
    if expected.exists() {
        return expected;
    }
    let worktree_prefix = format!("{prefix}--claude-worktrees-");
    if let Ok(entries) = std::fs::read_dir(projects_dir) {
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            if !name.starts_with(&worktree_prefix) {
                continue;
            }
            let candidate = entry.path().join(&filename);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    expected
}

fn text_blocks(content: &serde_json::Value) -> Vec<String> {
    let Some(arr) = content.as_array() else { return Vec::new() };
    arr.iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

// readRawSessionTranscript(main.ts:508-556)와 동일 — type:"user"/"assistant" 메시지가 순서대로
// 나열된 원본 세션 파일을 파싱한다. message.content가 문자열이거나(구버전) text/tool_result 블록이
// 섞인 배열일 수 있다. tool_result만 있는 user 메시지는 도구 실행 결과일 뿐 사람이 보낸 프롬프트가
// 아니므로 건너뛴다 — 그 외(문자열이거나 text 블록이 있는 경우)는 새 턴의 시작으로 보고, 그 다음에
// 오는 assistant 메시지들의 text 블록을 모아 답변으로 짝짓는다.
// 원본 세션 파일은 수~수십 MB까지 커질 수 있어서(실측 21MB) 3초 폴링마다 통째로 다시 파싱하면
// 부담이 크다 — mtime이 그대로면 파싱 결과를 재사용한다(main.ts getCachedRawSessionTranscript와 동일).
fn read_raw_session_flagged_cached(file: &Path) -> Vec<(TranscriptEntry, bool)> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::SystemTime;
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (SystemTime, Vec<(TranscriptEntry, bool)>)>>> = OnceLock::new();
    let Ok(mtime) = std::fs::metadata(file).and_then(|m| m.modified()) else { return Vec::new() };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((cached_mtime, entries)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(file) {
        if *cached_mtime == mtime {
            return entries.clone();
        }
    }
    let entries = parse_raw_session_file(file);
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(file.to_path_buf(), (mtime, entries.clone()));
    entries
}

fn read_raw_session_transcript_cached(file: &Path) -> Vec<TranscriptEntry> {
    read_raw_session_flagged_cached(file).into_iter().map(|(e, _)| e).collect()
}

// 팀장이 일하는 도중에 데몬 reply(또는 팀원의 SendMessage)로 들어온 메시지는 일반 user 기록이 아니라
// attachment(type=queued_command, prompt=원문)로 남는다(실측 2026-10-22) — 일지(daily-journal)에도 안 남는다. 터미널에서 일하는
// 중간에 입력한 것과 같은 메시지라 새 턴의 시작으로 취급한다(그 뒤 이어지는 assistant 텍스트가 이 메시지의 답변이 된다).
// 완료 알림(<task-notification>)도 같은 형태로 들어오지만 지금까지 대화창에 안 보이던 것이라 계속 제외한다.
fn queued_command_prompt(rec: &serde_json::Value) -> Option<String> {
    let att = rec.get("attachment")?;
    if att.get("type")?.as_str()? != "queued_command" {
        return None;
    }
    let prompt = att.get("prompt")?.as_str()?;
    if prompt.trim().is_empty() || prompt.contains("<task-notification>") {
        return None;
    }
    Some(prompt.to_string())
}

/// 원본 세션 파일 파싱 — 각 항목에 "끼어든 메시지에서 온 것인가"를 함께 돌려준다.
fn parse_raw_session_file(file: &Path) -> Vec<(TranscriptEntry, bool)> {
    let Ok(content) = std::fs::read_to_string(file) else { return Vec::new() };
    parse_raw_session_text(&content)
}

fn parse_raw_session_text(content: &str) -> Vec<(TranscriptEntry, bool)> {
    let mut entries: Vec<(TranscriptEntry, bool)> = Vec::new();
    let mut current_prompt: Option<(String, String, bool)> = None; // (time, prompt, injected)
    let mut current_answer_parts: Vec<String> = Vec::new();

    for line in content.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let rec_type = rec.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if rec_type == "user" {
            let Some(message) = rec.get("message") else { continue };
            let content_val = message.get("content");
            let mut prompt_text: Option<String> = None;
            if let Some(s) = content_val.and_then(|c| c.as_str()) {
                prompt_text = Some(s.to_string());
            } else if let Some(arr) = content_val.and_then(|c| c.as_array()) {
                let all_tool_result = !arr.is_empty() && arr.iter().all(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));
                if !arr.is_empty() && !all_tool_result {
                    let parts = text_blocks(content_val.unwrap());
                    if !parts.is_empty() {
                        prompt_text = Some(parts.join("\n"));
                    }
                }
            }
            if let Some(text) = prompt_text {
                if !text.trim().is_empty() {
                    if let Some((time, prompt, injected)) = current_prompt.take() {
                        if !prompt.trim().is_empty() {
                            entries.push((TranscriptEntry { time, prompt, answer: current_answer_parts.join("\n").trim().to_string() }, injected));
                        }
                    }
                    current_answer_parts.clear();
                    let time = format_raw_session_timestamp(rec.get("timestamp").and_then(|t| t.as_str()));
                    current_prompt = Some((time, text, false));
                }
            }
        } else if rec_type == "attachment" {
            if let Some(text) = queued_command_prompt(&rec) {
                if let Some((time, prompt, injected)) = current_prompt.take() {
                    if !prompt.trim().is_empty() {
                        entries.push((TranscriptEntry { time, prompt, answer: current_answer_parts.join("\n").trim().to_string() }, injected));
                    }
                }
                current_answer_parts.clear();
                let time = format_raw_session_timestamp(rec.get("timestamp").and_then(|t| t.as_str()));
                current_prompt = Some((time, text, true));
            }
        } else if rec_type == "assistant" && current_prompt.is_some() {
            if let Some(content_val) = rec.get("message").and_then(|m| m.get("content")) {
                let parts = text_blocks(content_val);
                if !parts.is_empty() {
                    current_answer_parts.extend(parts);
                }
            }
        }
    }
    if let Some((time, prompt, injected)) = current_prompt.take() {
        if !prompt.trim().is_empty() {
            entries.push((TranscriptEntry { time, prompt, answer: current_answer_parts.join("\n").trim().to_string() }, injected));
        }
    }
    entries
}

// 대화의 기본 출처는 claude가 직접 쓰는 원본 세션 파일이다(턴이 끝나야 기록되는 daily-journal 플러그인은 기록이 빠지거나 늦어지는 일이 잦았다).
// 끼어든 메시지(queued_command)도 원본 파서가 이미 새 턴으로 읽는다. daily-journal은 원본에서 대화를 하나도 못 읽을 때만 쓰는 읽기 전용 보조다.

/// 원본 파일은 있는데 대화를 하나도 못 읽는 세션을 앱 로그에 한 번만 남긴다 — claude의 기록 형식이 바뀌었을 때 알아챌 수 있게 한다.
fn warn_if_unreadable_once(file: &Path) {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};
    static WARNED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let big_enough = std::fs::metadata(file).map(|m| m.len() > 2048).unwrap_or(false);
    if !big_enough {
        return;
    }
    let first = WARNED.get_or_init(|| Mutex::new(HashSet::new())).lock().unwrap_or_else(|e| e.into_inner()).insert(file.to_path_buf());
    if first {
        crate::logging::log_critical(&format!("[transcript] 세션 파일은 있는데 대화를 하나도 읽지 못했습니다(기록 형식이 바뀌었을 수 있음): {}", file.display()));
    }
}

fn journal_turns(project_name: &str, session_id: &str) -> Vec<TranscriptEntry> {
    read_journal_entries(project_name)
        .into_iter()
        .filter(|e| e.session_id == session_id)
        .map(|e| TranscriptEntry { time: e.time, prompt: e.prompt, answer: e.answer })
        .collect()
}

/// 세션의 전체 대화 — 원본 세션 파일 기준, 거기서 못 읽으면 daily-journal 기록(있다면).
pub(crate) fn get_transcript(project_name: &str, session_id: &str, cwd: &str) -> Vec<TranscriptEntry> {
    let file = session_file_path(cwd, session_id);
    let raw = read_raw_session_transcript_cached(&file);
    if !raw.is_empty() {
        return raw;
    }
    warn_if_unreadable_once(&file);
    journal_turns(project_name, session_id)
}

fn read_tail_turns(file: &Path) -> Vec<TranscriptEntry> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(file) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    for window in [256 * 1024u64, 2 * 1024 * 1024, 16 * 1024 * 1024] {
        let start = len.saturating_sub(window);
        if f.seek(SeekFrom::Start(start)).is_err() {
            break;
        }
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() {
            break;
        }
        let text = String::from_utf8_lossy(&buf);
        // 시작 위치가 줄 중간일 수 있으니 첫 줄은 버린다.
        let body = if start > 0 { text.split_once('\n').map(|(_, rest)| rest).unwrap_or("") } else { &text };
        let entries: Vec<TranscriptEntry> = parse_raw_session_text(body).into_iter().map(|(e, _)| e).collect();
        if !entries.is_empty() {
            return entries;
        }
        if start == 0 {
            break;
        }
    }
    Vec::new()
}

/// 세션의 최근 대화 몇 턴 — 파일 끝부분만 읽어서(수십 MB 파일을 폴링마다 통째로 파싱하지 않기 위해) 카드 미리보기·정체 감시에 쓴다.
/// 끝부분에 사용자 메시지가 하나도 없으면(긴 도구 실행 구간) 읽는 범위를 넓혀 다시 본다. 원본에서 못 읽으면 daily-journal(있다면).
pub(crate) fn recent_turns(project_name: &str, session_id: &str, cwd: &str) -> Vec<TranscriptEntry> {
    let file = session_file_path(cwd, session_id);
    let tail = read_tail_turns(&file);
    if !tail.is_empty() {
        return tail;
    }
    if file.exists() {
        warn_if_unreadable_once(&file);
    }
    journal_turns(project_name, session_id)
}

/// getLeadTranscript(main.ts:2638-2643) IPC — 팀장과의 "대화" 패널용 전체 왕복 기록.
#[tauri::command]
pub fn get_lead_transcript_command(lead_id: String) -> Vec<TranscriptEntry> {
    let Some(lead) = load_leads().into_iter().find(|l| l.id == lead_id) else { return Vec::new() };
    let project_name = resolve_project_name(&lead.session_id, &lead.target_dir);
    get_transcript(&project_name, &lead.session_id, &lead.target_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_raw_session_timestamp_returns_empty_for_missing_or_invalid() {
        assert_eq!(format_raw_session_timestamp(None), "");
        assert_eq!(format_raw_session_timestamp(Some("not-a-date")), "");
    }

    fn read_raw_session_transcript_from_file(file: &Path) -> Vec<TranscriptEntry> {
        parse_raw_session_file(file).into_iter().map(|(e, _)| e).collect()
    }

    fn temp_jsonl_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_transcript_{tag}_{}.jsonl", uuid::Uuid::new_v4()))
    }

    fn write_lines(path: &Path, lines: &[&str]) {
        std::fs::write(path, lines.join("\n")).unwrap();
    }

    fn queued_command_line(ts: &str, prompt: &str) -> String {
        serde_json::json!({ "type": "attachment", "timestamp": ts, "attachment": { "type": "queued_command", "prompt": prompt } }).to_string()
    }

    fn user_line(ts: &str, text: &str) -> String {
        serde_json::json!({ "type": "user", "timestamp": ts, "message": { "role": "user", "content": text } }).to_string()
    }

    fn assistant_line(ts: &str, text: &str) -> String {
        serde_json::json!({ "type": "assistant", "timestamp": ts, "message": { "content": [{ "type": "text", "text": text }] } }).to_string()
    }

    #[test]
    fn queued_command_attachment_becomes_a_new_turn_whose_answer_is_what_follows() {
        let path = temp_jsonl_path("queued");
        let lines = [
            user_line("2026-10-22T06:25:12Z", "원래 작업을 해줘"),
            assistant_line("2026-10-22T06:25:15Z", "시작합니다"),
            queued_command_line("2026-10-22T06:25:20Z", "추가 요청: 끝에 메모접수를 붙여줘"),
            assistant_line("2026-10-22T06:25:40Z", "끝 +메모접수"),
        ];
        write_lines(&path, &lines.iter().map(String::as_str).collect::<Vec<_>>());
        let flagged = parse_raw_session_file(&path);
        assert_eq!(flagged.len(), 2);
        assert!(!flagged[0].1 && flagged[1].1, "두 번째만 끼어든 메시지");
        assert_eq!(flagged[0].0.prompt, "원래 작업을 해줘");
        assert_eq!(flagged[0].0.answer, "시작합니다");
        assert_eq!(flagged[1].0.prompt, "추가 요청: 끝에 메모접수를 붙여줘");
        assert_eq!(flagged[1].0.answer, "끝 +메모접수");
    }

    #[test]
    fn task_notifications_and_empty_prompts_arriving_as_queued_commands_are_ignored() {
        let path = temp_jsonl_path("queued_skip");
        let lines = [
            user_line("2026-10-22T06:25:12Z", "작업"),
            queued_command_line("2026-10-22T06:25:20Z", "<task-notification><task-id>abc</task-id></task-notification>"),
            queued_command_line("2026-10-22T06:25:21Z", "   "),
            assistant_line("2026-10-22T06:25:30Z", "답"),
        ];
        write_lines(&path, &lines.iter().map(String::as_str).collect::<Vec<_>>());
        let flagged = parse_raw_session_file(&path);
        assert_eq!(flagged.len(), 1, "알림은 지금까지처럼 대화창에 안 넣는다");
        assert_eq!(flagged[0].0.answer, "답");
    }

    #[test]
    fn read_raw_session_transcript_pairs_prompts_with_following_assistant_text() {
        let path = temp_jsonl_path("pairing");
        write_lines(
            &path,
            &[
                r#"{"type":"user","timestamp":"2026-09-17T03:00:00Z","message":{"content":"첫 질문"}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"첫 답변 파트1"},{"type":"text","text":"파트2"}]}}"#,
                r#"{"type":"user","timestamp":"2026-09-17T03:05:00Z","message":{"content":[{"type":"tool_result","content":"무시돼야 함"}]}}"#,
                r#"{"type":"user","timestamp":"2026-09-17T03:06:00Z","message":{"content":[{"type":"text","text":"두번째 질문"}]}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"두번째 답변"}]}}"#,
            ],
        );

        let entries = read_raw_session_transcript_from_file(&path);
        assert_eq!(entries.len(), 2, "tool_result만 있는 user 메시지는 새 턴으로 안 잡혀야 한다: {entries:?}");
        assert_eq!(entries[0].prompt, "첫 질문");
        assert_eq!(entries[0].answer, "첫 답변 파트1\n파트2");
        assert_eq!(entries[1].prompt, "두번째 질문");
        assert_eq!(entries[1].answer, "두번째 답변");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_raw_session_transcript_skips_malformed_lines() {
        let path = temp_jsonl_path("malformed");
        write_lines(&path, &["이건 JSON이 아님", r#"{"type":"user","timestamp":"2026-09-17T03:00:00Z","message":{"content":"질문"}}"#]);
        let entries = read_raw_session_transcript_from_file(&path);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].prompt, "질문");
        let _ = std::fs::remove_file(&path);
    }

    fn temp_projects_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_projects_{tag}_{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn session_file_path_in_uses_direct_folder_when_it_exists() {
        let dir = temp_projects_dir("direct");
        let direct = dir.join("C--Users-x-g1cl-mgt");
        std::fs::create_dir_all(&direct).unwrap();
        std::fs::write(direct.join("sess1.jsonl"), "").unwrap();

        let result = session_file_path_in(&dir, "C:\\Users\\x\\g1cl-mgt", "sess1");
        assert_eq!(result, direct.join("sess1.jsonl"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_file_path_in_falls_back_to_worktree_suffixed_folder() {
        // 팀장이 git worktree로 들어가서 작업하면(EnterWorktree), 원본 세션 파일은 원래 cwd
        // 폴더가 아니라 "<원래 cwd 인코딩>--claude-worktrees-<이름>" 폴더에 남는다 — leads.json의
        // targetDir은 원래 디렉토리 그대로라 직접 조합한 경로엔 파일이 없다.
        let dir = temp_projects_dir("worktree");
        let worktree_dir = dir.join("C--Users-x-g1cl-mgt--claude-worktrees-keen-painting-walrus");
        std::fs::create_dir_all(&worktree_dir).unwrap();
        std::fs::write(worktree_dir.join("sess1.jsonl"), "").unwrap();

        let result = session_file_path_in(&dir, "C:\\Users\\x\\g1cl-mgt", "sess1");
        assert_eq!(result, worktree_dir.join("sess1.jsonl"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_file_path_in_ignores_unrelated_folder_with_similar_prefix() {
        // "g1cl-mgt2" 같은 무관한 다른 프로젝트 폴더가 우연히 같은 문자열로 시작한다고 해서
        // 잘못 집으면 안 된다 — 접두사가 정확히 "--claude-worktrees-"로 이어질 때만 인정한다.
        let dir = temp_projects_dir("unrelated");
        let unrelated_dir = dir.join("C--Users-x-g1cl-mgt2");
        std::fs::create_dir_all(&unrelated_dir).unwrap();
        std::fs::write(unrelated_dir.join("sess1.jsonl"), "").unwrap();

        let result = session_file_path_in(&dir, "C:\\Users\\x\\g1cl-mgt", "sess1");
        assert_eq!(result, dir.join("C--Users-x-g1cl-mgt").join("sess1.jsonl"), "무관한 폴더를 집으면 안 되고, 못 찾았으니 원래 기대 경로로 폴백해야 한다");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_tail_turns_reads_the_last_turns_even_when_the_window_starts_mid_line() {
        let path = temp_jsonl_path("tail");
        let mut lines: Vec<String> = Vec::new();
        for i in 0..4000 {
            lines.push(user_line("2026-09-17T03:00:00Z", &format!("질문 {i} {}", "가".repeat(120))));
            lines.push(assistant_line("2026-09-17T03:00:01Z", &format!("답변 {i}")));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_lines(&path, &refs);
        let turns = read_tail_turns(&path);
        assert!(!turns.is_empty());
        assert!(turns.len() < 4000, "파일 끝부분만 읽는다");
        assert!(turns.last().unwrap().prompt.starts_with("질문 3999"));
        assert_eq!(turns.last().unwrap().answer, "답변 3999");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_tail_turns_widens_the_window_when_the_tail_has_no_user_message() {
        let path = temp_jsonl_path("tail-wide");
        let mut lines: Vec<String> = vec![user_line("2026-09-17T03:00:00Z", "오래된 질문"), assistant_line("2026-09-17T03:00:01Z", "오래된 답")];
        for _ in 0..3000 {
            lines.push(assistant_line("2026-09-17T03:00:02Z", &"도구 사이 설명 ".repeat(30)));
        }
        let refs: Vec<&str> = lines.iter().map(|s| s.as_str()).collect();
        write_lines(&path, &refs);
        let turns = read_tail_turns(&path);
        assert_eq!(turns.last().map(|t| t.prompt.as_str()), Some("오래된 질문"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_tail_turns_returns_nothing_for_an_unknown_format() {
        let path = temp_jsonl_path("tail-unknown");
        write_lines(&path, &[r#"{"kind":"새 형식","body":"..."}"#]);
        assert!(read_tail_turns(&path).is_empty(), "알 수 없는 형식은 비어서 daily-journal 보조/경고 경로로 넘어간다");
        let _ = std::fs::remove_file(&path);
    }
}
