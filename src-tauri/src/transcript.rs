// 이번 청크 — get-lead-transcript(main.ts:2638-2643)의 포팅. daily-journal 기록(read_journal_entries,
// live_rows.rs가 이미 포팅해뒀다)을 우선 신뢰하고, 거기 없는(원본 세션 파일에는 있는) 뒷부분만
// 원본 세션 파일(~/.claude/projects/<cwd 인코딩>/<sessionId>.jsonl)에서 보완해서 이어붙인다
// (fillMissingTranscriptFromRawSession, main.ts:557-579) — 완전히 원본으로 교체하지 않는다.

use crate::live_rows::{encode_project_dir_name, read_journal_entries, resolve_project_name};
use crate::paths::projects_dir;
use crate::session_registry::load_leads;
use chrono::{Local, TimeZone};
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

// parseJournalTimeLoose(main.ts)와 동일 — "YYYY-MM-DD HH:MM" 문자열을 로컬 시각 기준 epoch ms로
// 되돌린다. 형식이 안 맞으면(예전 스키마 등) None.
fn parse_journal_time_loose(time: &str) -> Option<i64> {
    let bytes = time.as_bytes();
    if bytes.len() != 16 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b' ' || bytes[13] != b':' {
        return None;
    }
    let y: i32 = time.get(0..4)?.parse().ok()?;
    let mo: u32 = time.get(5..7)?.parse().ok()?;
    let d: u32 = time.get(8..10)?.parse().ok()?;
    let h: u32 = time.get(11..13)?.parse().ok()?;
    let mi: u32 = time.get(14..16)?.parse().ok()?;
    let naive = chrono::NaiveDate::from_ymd_opt(y, mo, d)?.and_hms_opt(h, mi, 0)?;
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.timestamp_millis()),
        chrono::LocalResult::Ambiguous(dt, _) => Some(dt.timestamp_millis()),
        chrono::LocalResult::None => None,
    }
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
fn session_file_path(cwd: &str, session_id: &str) -> PathBuf {
    session_file_path_in(&projects_dir(), cwd, session_id)
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
fn read_raw_session_transcript_cached(file: &Path) -> Vec<TranscriptEntry> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::SystemTime;
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (SystemTime, Vec<TranscriptEntry>)>>> = OnceLock::new();
    let Ok(mtime) = std::fs::metadata(file).and_then(|m| m.modified()) else { return Vec::new() };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((cached_mtime, entries)) = cache.lock().unwrap_or_else(|e| e.into_inner()).get(file) {
        if *cached_mtime == mtime {
            return entries.clone();
        }
    }
    let entries = read_raw_session_transcript_from_file(file);
    cache.lock().unwrap_or_else(|e| e.into_inner()).insert(file.to_path_buf(), (mtime, entries.clone()));
    entries
}

fn read_raw_session_transcript_from_file(file: &Path) -> Vec<TranscriptEntry> {
    let Ok(content) = std::fs::read_to_string(file) else { return Vec::new() };

    let mut entries: Vec<TranscriptEntry> = Vec::new();
    let mut current_prompt: Option<(String, String)> = None; // (time, prompt)
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
                    if let Some((time, prompt)) = current_prompt.take() {
                        if !prompt.trim().is_empty() {
                            entries.push(TranscriptEntry { time, prompt, answer: current_answer_parts.join("\n").trim().to_string() });
                        }
                    }
                    current_answer_parts.clear();
                    let time = format_raw_session_timestamp(rec.get("timestamp").and_then(|t| t.as_str()));
                    current_prompt = Some((time, text));
                }
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
    if let Some((time, prompt)) = current_prompt.take() {
        if !prompt.trim().is_empty() {
            entries.push(TranscriptEntry { time, prompt, answer: current_answer_parts.join("\n").trim().to_string() });
        }
    }
    entries
}

// findLastMatchingRawIndex(main.ts:604-620)와 동일 — journalEntries의 마지막 항목과 똑같은 prompt
// 텍스트가 원본 세션 파일에 정확히 어디 있었는지 찾는다. 이 앱이 자동으로 넣는 정형 문구([알림] 등)는
// 여러 번 글자 하나 안 틀리고 반복될 수 있어서, 단순히 "끝에서부터 훑어 처음 일치"가 아니라 시간이
// 가장 가까운 후보를 고른다(1시간 여유, 대기열에서 오래 기다린 경우까지 감안).
fn find_last_matching_raw_index(last_entry: &TranscriptEntry, raw_entries: &[TranscriptEntry]) -> i64 {
    let Some(last_time) = parse_journal_time_loose(&last_entry.time) else {
        for i in (0..raw_entries.len()).rev() {
            if raw_entries[i].prompt == last_entry.prompt {
                return i as i64;
            }
        }
        return -1;
    };
    const MATCH_SLACK_MS: i64 = 60 * 60 * 1000;
    let mut best_index: i64 = -1;
    let mut best_diff = i64::MAX;
    for i in (0..raw_entries.len()).rev() {
        if raw_entries[i].prompt != last_entry.prompt {
            continue;
        }
        let Some(raw_time) = parse_journal_time_loose(&raw_entries[i].time) else { continue };
        let diff = (raw_time - last_time).abs();
        if diff <= MATCH_SLACK_MS && diff < best_diff {
            best_diff = diff;
            best_index = i as i64;
        }
    }
    best_index
}

// fillMissingTranscriptFromRawSession(main.ts:582-599)와 동일 — daily-journal 기록이 있으면 그게
// 더 정제된 형태라 그대로 신뢰하고, 거기 없는(원본에는 있는) 뒷부분만 원본 세션 파일에서 보완해서
// 이어붙인다. daily-journal의 마지막 기록 시각 이후로 원본 파일이 수정된 적이 없으면(파일을 열
// 필요 없이 mtime만으로 확인) 새로 쌓인 턴이 없다는 뜻이니 그냥 넘어간다(비용 절감).
fn fill_missing_transcript_from_raw_session_at(journal_entries: Vec<TranscriptEntry>, file: &Path) -> Vec<TranscriptEntry> {
    if journal_entries.is_empty() {
        let raw = read_raw_session_transcript_cached(file);
        return if raw.is_empty() { journal_entries } else { raw };
    }

    let Ok(meta) = std::fs::metadata(file) else { return journal_entries };
    let Ok(modified) = meta.modified() else { return journal_entries };
    let mtime_ms = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);

    // "YYYY-MM-DD HH:MM"은 분 단위까지만 있어서 실제 mtime과 최대 1분 가까이 차이날 수 있다 —
    // 여유를 두고 비교한다(main.ts와 동일).
    if let Some(last_journal_time) = parse_journal_time_loose(&journal_entries.last().unwrap().time) {
        if mtime_ms <= last_journal_time + 2 * 60 * 1000 {
            return journal_entries;
        }
    }

    let raw_entries = read_raw_session_transcript_cached(file);
    if raw_entries.is_empty() {
        return journal_entries;
    }

    let cut_index = find_last_matching_raw_index(journal_entries.last().unwrap(), &raw_entries);
    let tail: Vec<TranscriptEntry> = if cut_index >= 0 {
        raw_entries.into_iter().skip((cut_index + 1) as usize).collect()
    } else {
        // daily-journal의 마지막 프롬프트를 원본에서 못 찾으면 개수 기준으로 대략 맞춰 보완한다
        // (main.ts와 동일 — 완벽하지 않아도 아예 안 보이는 것보다는 낫다).
        raw_entries.into_iter().skip(journal_entries.len()).collect()
    };
    if tail.is_empty() {
        journal_entries
    } else {
        let mut combined = journal_entries;
        combined.extend(tail);
        combined
    }
}

/// getTranscript(main.ts:478-483)와 동일 — daily-journal 기록을 sessionId로 걸러 먼저 채우고,
/// 원본 세션 파일로 모자란 뒷부분을 보완한다.
pub(crate) fn get_transcript(project_name: &str, session_id: &str, cwd: &str) -> Vec<TranscriptEntry> {
    let journal_entries: Vec<TranscriptEntry> = read_journal_entries(project_name)
        .into_iter()
        .filter(|e| e.session_id == session_id)
        .map(|e| TranscriptEntry { time: e.time, prompt: e.prompt, answer: e.answer })
        .collect();
    let file = session_file_path(cwd, session_id);
    let filled = fill_missing_transcript_from_raw_session_at(journal_entries, &file);
    enrich_answers_from_raw_session_at(filled, &file)
}

// enrichAnswersFromRawSession(main.ts)과 동일 — daily-journal의 answer는 Stop 훅이 넘겨주는 그
// 턴의 "마지막 assistant 메시지 한 조각"이라, 도구 호출 사이사이의 설명이나(저널이 턴 도중에
// 기록된 경우) 그 뒤에 이어진 최종 답변이 빠질 수 있다. 원본 쪽 답변이 더 길면 그쪽으로 교체한다.
// 이게 없어서 터미널엔 나온 최종 답변이 채팅창에는 안 뜨는 일이 있었다(실사용 재현).
fn enrich_answers_from_raw_session_at(entries: Vec<TranscriptEntry>, file: &Path) -> Vec<TranscriptEntry> {
    if entries.is_empty() {
        return entries;
    }
    let raw_entries = read_raw_session_transcript_cached(file);
    if raw_entries.is_empty() {
        return entries;
    }
    entries
        .into_iter()
        .map(|mut entry| {
            let idx = find_last_matching_raw_index(&entry, &raw_entries);
            if idx >= 0 {
                let raw_answer = &raw_entries[idx as usize].answer;
                if raw_answer.chars().count() > entry.answer.chars().count() {
                    entry.answer = raw_answer.clone();
                }
            }
            entry
        })
        .collect()
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
    fn parse_journal_time_loose_round_trips_with_format_raw_session_timestamp() {
        // format_raw_session_timestamp가 만든 문자열을 parse_journal_time_loose가 다시 읽을 수
        // 있어야 한다(둘 다 로컬 시각 기준이므로 왕복이 성립해야 함).
        let iso = "2026-09-17T03:04:00Z";
        let formatted = format_raw_session_timestamp(Some(iso));
        assert!(parse_journal_time_loose(&formatted).is_some(), "formatted={formatted:?}");
    }

    #[test]
    fn parse_journal_time_loose_rejects_malformed_strings() {
        assert_eq!(parse_journal_time_loose(""), None);
        assert_eq!(parse_journal_time_loose("아무말"), None);
        assert_eq!(parse_journal_time_loose("2026-13-99 99:99"), None);
    }

    #[test]
    fn format_raw_session_timestamp_returns_empty_for_missing_or_invalid() {
        assert_eq!(format_raw_session_timestamp(None), "");
        assert_eq!(format_raw_session_timestamp(Some("not-a-date")), "");
    }

    fn temp_jsonl_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_transcript_{tag}_{}.jsonl", uuid::Uuid::new_v4()))
    }

    fn write_lines(path: &Path, lines: &[&str]) {
        std::fs::write(path, lines.join("\n")).unwrap();
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

    #[test]
    fn fill_missing_transcript_reads_raw_when_journal_is_empty() {
        let path = temp_jsonl_path("empty-journal");
        write_lines(&path, &[r#"{"type":"user","timestamp":"2026-09-17T03:00:00Z","message":{"content":"원본에만 있는 질문"}}"#]);

        let result = fill_missing_transcript_from_raw_session_at(Vec::new(), &path);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].prompt, "원본에만 있는 질문");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn fill_missing_transcript_skips_raw_read_when_file_not_modified_since_last_journal_entry() {
        // 파일이 아예 없으면(mtime 확인 자체가 실패) journal_entries를 그대로 돌려줘야 한다.
        let path = temp_jsonl_path("nonexistent");
        let journal = vec![TranscriptEntry { time: "2026-09-17 03:00".to_string(), prompt: "질문".to_string(), answer: "답변".to_string() }];
        let result = fill_missing_transcript_from_raw_session_at(journal.clone(), &path);
        assert_eq!(result, journal);
    }

    #[test]
    fn fill_missing_transcript_appends_tail_found_by_matching_last_prompt() {
        let path = temp_jsonl_path("append-tail");
        write_lines(
            &path,
            &[
                r#"{"type":"user","timestamp":"2026-09-17T03:00:00Z","message":{"content":"이미 journal에 있는 질문"}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"이미 journal에 있는 답변"}]}}"#,
                r#"{"type":"user","timestamp":"2026-09-17T04:00:00Z","message":{"content":"journal엔 아직 없는 새 질문"}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"새 답변"}]}}"#,
            ],
        );
        // 파일 mtime을 journal의 마지막 기록 시각보다 충분히 뒤로 당겨서(2분 초과) raw 보완 경로를
        // 탄다 — File::create는 내용을 잘라내므로(0바이트) 쓴 줄이 사라진다, write(true)로 열어서
        // 내용은 그대로 두고 mtime만 바꾼다.
        let far_future = std::time::SystemTime::now() + std::time::Duration::from_secs(3600);
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(far_future).unwrap();

        let journal = vec![TranscriptEntry { time: "2026-09-17 03:00".to_string(), prompt: "이미 journal에 있는 질문".to_string(), answer: "이미 journal에 있는 답변".to_string() }];
        let result = fill_missing_transcript_from_raw_session_at(journal, &path);
        assert_eq!(result.len(), 2, "원본에서 찾은 새 턴 하나만 뒤에 이어붙어야 한다: {result:?}");
        assert_eq!(result[1].prompt, "journal엔 아직 없는 새 질문");
        assert_eq!(result[1].answer, "새 답변");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn find_last_matching_raw_index_prefers_closest_time_among_repeated_prompts() {
        // 같은 문구("[알림] ...")가 여러 번 반복될 때, 시간이 가장 가까운 후보를 골라야 한다.
        let raw = vec![
            TranscriptEntry { time: "2026-09-17 01:00".to_string(), prompt: "[알림] 반복".to_string(), answer: String::new() },
            TranscriptEntry { time: "2026-09-17 03:00".to_string(), prompt: "[알림] 반복".to_string(), answer: String::new() },
            TranscriptEntry { time: "2026-09-17 05:00".to_string(), prompt: "[알림] 반복".to_string(), answer: String::new() },
        ];
        let last = TranscriptEntry { time: "2026-09-17 03:05".to_string(), prompt: "[알림] 반복".to_string(), answer: String::new() };
        let idx = find_last_matching_raw_index(&last, &raw);
        assert_eq!(idx, 1, "03:00짜리(인덱스 1)가 03:05와 가장 가까워야 한다");
    }

    #[test]
    fn enrich_replaces_stale_journal_answer_with_longer_raw_answer() {
        // 저널은 턴 도중("지금 확인할게.")에 기록됐는데, 원본엔 그 뒤 도구 실행과 최종 답변까지 이어진 경우.
        let path = std::env::temp_dir().join(format!("claude_team_monitor_test_enrich_{}.jsonl", uuid::Uuid::new_v4()));
        let lines = [
            r#"{"type":"user","timestamp":"2026-09-29T01:48:00Z","message":{"content":"확인하고있지..?"}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"지금 확인할게."}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"확인했어. 최종 답변 본문입니다."}]}}"#,
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
        let raw_time = format_raw_session_timestamp(Some("2026-09-29T01:48:00Z"));
        let journal = vec![TranscriptEntry { time: raw_time, prompt: "확인하고있지..?".to_string(), answer: "지금 확인할게.".to_string() }];

        let result = enrich_answers_from_raw_session_at(journal, &path);
        assert_eq!(result.len(), 1);
        assert!(result[0].answer.contains("최종 답변 본문"), "{:?}", result[0].answer);

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
}
