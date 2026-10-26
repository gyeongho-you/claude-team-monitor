// 서브에이전트·팀원의 대화(활동) 기록과 팀장의 백그라운드 셸 작업을 읽어 화면에 보여준다(src/lib/activity.js와 같은 규칙).
//
// 배경(실측 2026-10-26, 디자인 팀장): 팀장이 개발 서버 같은 명령을 백그라운드로 돌리면 데몬은 이를 local_bash로 세어 "백그라운드 N개"로만 알려
// 주고, 어떤 명령인지는 어디에도 안 보였다. 서브에이전트·팀원도 대화를 볼 방법이 없었다. 모두 원본 세션 기록(jsonl)에 남아 있다:
//  - 서브에이전트: <세션폴더>/subagents/agent-<id>.jsonl — 일반 대화 기록(user/assistant, 도구 호출 포함)
//  - 팀원: 팀원 자신의 세션 파일 — 같은 형식
//  - 백그라운드 셸: 팀장 기록의 Bash(run_in_background) 호출 + tool_result "Command running in background with ID: <id>. Output is being
//    written to: <경로>" + 완료 때의 <task-notification>(<task-id>, <status>) — 알림이 없으면 아직 안 끝난 것(또는 방치된 것)이다.
// 읽기 전용이며, 실패나 예상과 다른 형태는 전부 조용히 빈 목록으로 넘긴다.

use crate::paths::is_safe_id;
use chrono::Local;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_ITEMS: usize = 300;
const MAX_TEXT_CHARS: usize = 3000;
const TAIL_BYTES: u64 = 6 * 1024 * 1024;
const OUTPUT_TAIL_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ActivityItem {
    /// "user" | "assistant" | "tool"
    pub kind: String,
    pub time: String,
    pub text: String,
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

fn format_time(iso: Option<&str>) -> String {
    let Some(iso) = iso else { return String::new() };
    chrono::DateTime::parse_from_rfc3339(iso).map(|d| d.with_timezone(&Local).format("%m-%d %H:%M:%S").to_string()).unwrap_or_default()
}

fn tool_brief(input: &serde_json::Value) -> String {
    for key in ["command", "description", "file_path", "pattern", "query", "url", "prompt", "path"] {
        if let Some(s) = input.get(key).and_then(|v| v.as_str()) {
            return clip(&s.split_whitespace().collect::<Vec<_>>().join(" "), 160);
        }
    }
    String::new()
}

/// 도구 호출처럼 기록되지만 실제로는 에이전트 사이의 "대화"인 것들 — 서브에이전트의 최종 보고(SubagentHandback), 에이전트 간 전달(SendMessage), 서브에이전트·팀원에게
/// 준 지시(Agent/Task, spawn_team_member). 도구 줄로 접어 두면 무슨 말이 오갔는지 알 수 없어서(사용자 지적 2026-10-26) 본문(kind "message")으로 크게 보여준다.
fn communication_text(name: &str, input: Option<&serde_json::Value>) -> Option<String> {
    let input = input?;
    let s = |key: &str| input.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|v| !v.is_empty());
    if name == "SubagentHandback" {
        return s("message").map(|m| format!("최종 보고: {m}"));
    }
    if name == "SendMessage" {
        let to = s("to").unwrap_or("?");
        return s("message").map(|m| format!("→ {to}: {m}"));
    }
    if name == "Agent" || name == "Task" {
        let desc = s("description").unwrap_or("");
        return s("prompt").map(|p| format!("서브에이전트 지시({desc}): {p}"));
    }
    if name.ends_with("spawn_team_member") {
        let label = s("label").unwrap_or("");
        return s("instruction").map(|i| format!("팀원 지시({label}): {i}"));
    }
    None
}

/// jsonl 내용을 활동 목록으로 바꾼다(순수 함수). 최근 MAX_ITEMS개만 남긴다.
pub(crate) fn parse_activity_lines(content: &str) -> Vec<ActivityItem> {
    let mut items: Vec<ActivityItem> = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let time = format_time(rec.get("timestamp").and_then(|t| t.as_str()));
        match rec.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "user" => {
                let Some(content) = rec.get("message").and_then(|m| m.get("content")) else { continue };
                let mut texts: Vec<String> = Vec::new();
                if let Some(s) = content.as_str() {
                    texts.push(s.to_string());
                } else if let Some(arr) = content.as_array() {
                    for b in arr {
                        if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                texts.push(t.to_string());
                            }
                        }
                    }
                }
                for t in texts {
                    // 하네스가 끼워 넣는 안내문은 대화가 아니라 제외한다.
                    if t.trim().is_empty() || t.trim_start().starts_with("<system-reminder>") {
                        continue;
                    }
                    items.push(ActivityItem { kind: "user".into(), time: time.clone(), text: clip(t.trim(), MAX_TEXT_CHARS) });
                }
            }
            "assistant" => {
                let Some(arr) = rec.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else { continue };
                for b in arr {
                    match b.get("type").and_then(|t| t.as_str()) {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                                if !t.trim().is_empty() {
                                    items.push(ActivityItem { kind: "assistant".into(), time: time.clone(), text: clip(t.trim(), MAX_TEXT_CHARS) });
                                }
                            }
                        }
                        Some("tool_use") => {
                            let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                            if let Some(text) = communication_text(name, b.get("input")) {
                                items.push(ActivityItem { kind: "message".into(), time: time.clone(), text: clip(&text, MAX_TEXT_CHARS) });
                                continue;
                            }
                            let brief = b.get("input").map(tool_brief).unwrap_or_default();
                            items.push(ActivityItem { kind: "tool".into(), time: time.clone(), text: if brief.is_empty() { name.to_string() } else { format!("{name}: {brief}") } });
                        }
                        _ => {}
                    }
                }
            }
            "attachment" => {
                // 일하는 도중 끼어든 메시지(queued_command) — 완료 알림은 제외한다(transcript.rs와 같은 규칙).
                if let Some(att) = rec.get("attachment") {
                    if att.get("type").and_then(|t| t.as_str()) == Some("queued_command") {
                        if let Some(p) = att.get("prompt").and_then(|p| p.as_str()) {
                            if !p.trim().is_empty() && !p.contains("<task-notification>") {
                                items.push(ActivityItem { kind: "user".into(), time: time.clone(), text: clip(p.trim(), MAX_TEXT_CHARS) });
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if items.len() > MAX_ITEMS {
        items.drain(..items.len() - MAX_ITEMS);
    }
    items
}

/// 파일 끝부분만 읽는다(수십 MB짜리 팀원·팀장 세션 파일 전체를 매번 읽지 않기 위해). 앞쪽이 잘렸으면 첫 줄은 버린다.
fn read_tail_string(path: &Path, max_bytes: u64) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(max_bytes);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    let mut s = String::from_utf8_lossy(&buf).to_string();
    if start > 0 {
        if let Some(i) = s.find('\n') {
            s = s[i + 1..].to_string();
        }
    }
    Some(s)
}

pub(crate) fn read_activity(path: &Path) -> Vec<ActivityItem> {
    read_tail_string(path, TAIL_BYTES).map(|c| parse_activity_lines(&c)).unwrap_or_default()
}

fn subagent_file(lead_cwd: &str, lead_session_id: &str, agent_id: &str) -> Option<PathBuf> {
    if !is_safe_id(agent_id) {
        return None;
    }
    let parent = crate::transcript::session_file_path(lead_cwd, lead_session_id);
    Some(parent.with_extension("").join("subagents").join(format!("agent-{agent_id}.jsonl")))
}

// ---------------------------------------------------------------------------------------------
// 백그라운드 셸 작업
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BackgroundTask {
    #[serde(rename = "taskId")]
    pub task_id: String,
    pub command: String,
    pub description: String,
    pub started: String,
    /// "unfinished"(완료 알림 없음) | "completed" | "failed" | "stopped" | 그 외 알림 상태 그대로
    pub status: String,
    /// 알림이 없는 것 중 데몬이 센 개수만큼 가장 최근 것 — 프로세스를 확인하지 못할 때만 쓰는 대체 추정.
    #[serde(rename = "runningGuess")]
    pub running_guess: bool,
    /// 알림이 없는 작업이 지금 실제로 떠 있는지(그 명령을 감싼 bash 프로세스가 있는지). 프로세스 목록을 못 얻었거나 끝난 작업이면 None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alive: Option<bool>,
    #[serde(rename = "outputBytes")]
    pub output_bytes: u64,
    #[serde(rename = "outputModifiedMs", skip_serializing_if = "Option::is_none")]
    pub output_modified_ms: Option<i64>,
    #[serde(skip)]
    pub output_path: String,
}

#[derive(Default, Clone)]
struct TaskScan {
    offset: u64,
    /// tool_use id -> (command, description, time) — 시작 결과가 아직 안 온 호출
    pending: HashMap<String, (String, String, String)>,
    /// 시작 순서대로
    launches: Vec<(String, String, String, String, String)>, // (taskId, command, description, time, outputPath)
    done: HashMap<String, String>,
}

fn between<'a>(s: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let a = s.find(start)? + start.len();
    let rest = &s[a..];
    Some(&rest[..rest.find(end)?])
}

fn scan_task_line(scan: &mut TaskScan, line: &str) {
    if !(line.contains("run_in_background") || line.contains("running in background with ID") || line.contains("<task-notification>")) {
        return;
    }
    let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else { return };
    let time = format_time(rec.get("timestamp").and_then(|t| t.as_str()));
    match rec.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "assistant" => {
            for b in rec.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()).into_iter().flatten() {
                if b.get("type").and_then(|t| t.as_str()) == Some("tool_use") && b.get("name").and_then(|n| n.as_str()) == Some("Bash") {
                    let input = b.get("input");
                    if input.and_then(|i| i.get("run_in_background")).and_then(|v| v.as_bool()) == Some(true) {
                        let id = b.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                        let cmd = input.and_then(|i| i.get("command")).and_then(|c| c.as_str()).unwrap_or("");
                        let desc = input.and_then(|i| i.get("description")).and_then(|c| c.as_str()).unwrap_or("");
                        scan.pending.insert(id, (clip(&cmd.split_whitespace().collect::<Vec<_>>().join(" "), 240), clip(desc, 120), time.clone()));
                    }
                }
            }
        }
        "user" => {
            for b in rec.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()).into_iter().flatten() {
                if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                    continue;
                }
                let text = match b.get("content") {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(v) => v.to_string(),
                    None => continue,
                };
                let Some(task_id) = between(&text, "running in background with ID: ", ".") else { continue };
                // 경로 뒤에 ". You will be notified when it completes …" 같은 안내 문장이 이어지므로 ".output"까지만 경로로 읽는다(실측).
                let out_raw = text.split("Output is being written to: ").nth(1).unwrap_or("");
                let out = match out_raw.find(".output") {
                    Some(i) => &out_raw[..i + ".output".len()],
                    None => out_raw.lines().next().unwrap_or("").trim(),
                };
                let tool_use_id = b.get("tool_use_id").and_then(|i| i.as_str()).unwrap_or("");
                let (cmd, desc, t) = scan.pending.remove(tool_use_id).unwrap_or_default();
                scan.launches.push((task_id.trim().to_string(), cmd, desc, if t.is_empty() { time.clone() } else { t }, out.replace("\\\\", "\\").trim().to_string()));
            }
        }
        "queue-operation" => {
            if rec.get("operation").and_then(|o| o.as_str()) == Some("enqueue") {
                if let Some(c) = rec.get("content").and_then(|c| c.as_str()) {
                    if let (Some(id), Some(status)) = (between(c, "<task-id>", "</task-id>"), between(c, "<status>", "</status>")) {
                        scan.done.insert(id.trim().to_string(), status.trim().to_string());
                    }
                }
            }
        }
        _ => {}
    }
}

/// 파일을 마지막으로 읽은 위치부터 이어서만 읽는다(수십 MB 기록을 폴링마다 다시 읽지 않기 위해). 줄이 덜 써진 끝부분은 다음에 읽는다.
fn update_scan(path: &Path, scan: &mut TaskScan) {
    let Ok(mut f) = std::fs::File::open(path) else { return };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return };
    if len < scan.offset {
        *scan = TaskScan::default(); // 파일이 줄었으면(교체) 처음부터
    }
    if len == scan.offset || f.seek(SeekFrom::Start(scan.offset)).is_err() {
        return;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return;
    }
    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else { return };
    for line in String::from_utf8_lossy(&buf[..last_nl]).lines() {
        scan_task_line(scan, line);
    }
    scan.offset += (last_nl + 1) as u64;
}

// 알림이 없는 작업이 지금도 떠 있는지는 프로세스로 확인한다(실측 2026-10-26, 디자인 팀장): 백그라운드 명령은 `bash.exe -c "… eval '<원래 명령>' …"`
// 래퍼 안에서 돌아서, 그 bash 프로세스의 명령줄에 원래 명령 문구가 그대로 들어 있다. 끝난 작업은 래퍼도 사라진다. "알림 없음 = 실행 중"이라고
// 가정하면 오래전에 끝난·방치된 작업까지 실행 중으로 보였다(알림 없는 6개 중 실제로 살아 있는 건 3개였다).
// 따옴표·역슬래시는 래퍼가 이스케이프를 바꾸므로, 공백·따옴표·역슬래시를 뺀 문자열로 비교한다.
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace() && !matches!(c, '\'' | '"' | '\\')).collect()
}

/// 명령에서 프로세스 명령줄과 대조할 대표 조각을 뽑는다(짧으면 전체, 길면 가운데 60자 — 앞의 cd와 뒤의 잘림 표시를 피한다).
fn command_needle(command: &str) -> String {
    let q: Vec<char> = squash(command).chars().collect();
    if q.len() <= 80 {
        return q.into_iter().collect();
    }
    let start = (q.len() - 60) / 2;
    q[start..start + 60].iter().collect()
}

fn task_alive(command: &str, squashed_process_cmds: &[String]) -> bool {
    let needle = command_needle(command);
    !needle.is_empty() && squashed_process_cmds.iter().any(|p| p.contains(&needle))
}

/// 지금 떠 있는 bash.exe들의 명령줄(공백·따옴표 정리 후). 10초 캐시 — PowerShell 호출이라 폴링마다 부르면 무겁다. 목록을 못 얻으면 None.
fn live_bash_command_lines() -> Option<Vec<String>> {
    use std::time::{Duration, Instant};
    static CACHE: OnceLock<Mutex<Option<(Instant, Option<Vec<String>>)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, value)) = guard.as_ref() {
        if at.elapsed() < Duration::from_secs(10) {
            return value.clone();
        }
    }
    let value = query_bash_command_lines();
    *guard = Some((Instant::now(), value.clone()));
    value
}

#[cfg(windows)]
fn query_bash_command_lines() -> Option<Vec<String>> {
    use std::os::windows::process::CommandExt;
    let script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='bash.exe'\" | ForEach-Object { $_.CommandLine }";
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]).creation_flags(0x0800_0000);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).lines().map(squash).filter(|s| !s.is_empty()).collect())
}

#[cfg(not(windows))]
fn query_bash_command_lines() -> Option<Vec<String>> {
    None
}

/// 스캔 결과를 화면용 목록으로 만든다(순수 함수). procs가 있으면 알림 없는 작업마다 실제로 떠 있는지(alive)를 채우고, 없으면 알림 없는 것 중
/// 최신 running_count개에 runningGuess를 켠다.
fn build_tasks(scan: &TaskScan, running_count: usize, procs: Option<&[String]>) -> Vec<BackgroundTask> {
    let mut tasks: Vec<BackgroundTask> = scan
        .launches
        .iter()
        .map(|(id, cmd, desc, time, out)| {
            let status = scan.done.get(id).cloned().unwrap_or_else(|| "unfinished".to_string());
            let meta = std::fs::metadata(out).ok();
            BackgroundTask {
                task_id: id.clone(),
                command: cmd.clone(),
                description: desc.clone(),
                started: time.clone(),
                status,
                running_guess: false,
                alive: None,
                output_bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                output_modified_ms: meta.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64),
                output_path: out.clone(),
            }
        })
        .collect();
    if let Some(procs) = procs {
        let commands: HashMap<&str, &str> = scan.launches.iter().map(|(id, cmd, ..)| (id.as_str(), cmd.as_str())).collect();
        for t in tasks.iter_mut().filter(|t| t.status == "unfinished") {
            t.alive = Some(task_alive(commands.get(t.task_id.as_str()).copied().unwrap_or(""), procs));
        }
    } else {
        let mut flagged = 0;
        for t in tasks.iter_mut().rev() {
            if t.status == "unfinished" && flagged < running_count {
                t.running_guess = true;
                flagged += 1;
            }
        }
    }
    tasks.reverse(); // 최신이 위로
    tasks
}

fn scan_cache() -> &'static Mutex<HashMap<PathBuf, TaskScan>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, TaskScan>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn background_tasks_for(session_file: &Path, running_count: usize) -> Vec<BackgroundTask> {
    let mut cache = scan_cache().lock().unwrap_or_else(|e| e.into_inner());
    let scan = cache.entry(session_file.to_path_buf()).or_default();
    update_scan(session_file, scan);
    let procs = live_bash_command_lines();
    build_tasks(scan, running_count, procs.as_deref())
}

fn lead_session_file(lead_id: &str) -> Option<(PathBuf, usize)> {
    let lead = crate::session_registry::load_leads().into_iter().find(|l| l.id == lead_id)?;
    // 데몬이 센 백그라운드 셸 개수(state.json) — 알림 없는 것 중 몇 개가 지금 돌고 있는지 추정하는 기준
    let running = crate::subagents::live_local_bash_count(&lead.id).unwrap_or(0) as usize;
    Some((crate::transcript::session_file_path(&lead.target_dir, &lead.session_id), running))
}

// ---------------------------------------------------------------------------------------------
// Tauri 커맨드 — 파일 읽기는 블로킹이라 async + spawn_blocking(동기 커맨드는 UI 스레드를 막는다)
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn get_member_activity_command(cwd: String, session_id: String) -> Vec<ActivityItem> {
    if !is_safe_id(&session_id) {
        return Vec::new();
    }
    tokio::task::spawn_blocking(move || read_activity(&crate::transcript::session_file_path(&cwd, &session_id))).await.unwrap_or_default()
}

#[tauri::command]
pub async fn get_subagent_activity_command(lead_id: String, agent_id: String) -> Vec<ActivityItem> {
    tokio::task::spawn_blocking(move || {
        let Some(lead) = crate::session_registry::load_leads().into_iter().find(|l| l.id == lead_id) else { return Vec::new() };
        subagent_file(&lead.target_dir, &lead.session_id, &agent_id).map(|p| read_activity(&p)).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn get_background_tasks_command(lead_id: String) -> Vec<BackgroundTask> {
    tokio::task::spawn_blocking(move || match lead_session_file(&lead_id) {
        Some((file, running)) => background_tasks_for(&file, running),
        None => Vec::new(),
    })
    .await
    .unwrap_or_default()
}

/// 백그라운드 작업의 출력 끝부분. 출력 경로는 기록에 적힌 값이라 임의 파일을 읽지 않도록 임시 폴더의 claude 작업 폴더 안인 것만 허용한다.
#[tauri::command]
pub async fn get_task_output_command(lead_id: String, task_id: String) -> String {
    if !is_safe_id(&task_id) {
        return String::new();
    }
    tokio::task::spawn_blocking(move || {
        let Some((file, running)) = lead_session_file(&lead_id) else { return String::new() };
        let Some(task) = background_tasks_for(&file, running).into_iter().find(|t| t.task_id == task_id) else { return String::new() };
        let allowed_root = std::env::temp_dir().join("claude");
        let path = PathBuf::from(&task.output_path);
        let ok = path.starts_with(&allowed_root) && path.extension().and_then(|e| e.to_str()) == Some("output");
        if !ok {
            return String::new();
        }
        read_tail_string(&path, OUTPUT_TAIL_BYTES).unwrap_or_default()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(v: serde_json::Value) -> String {
        v.to_string()
    }

    #[test]
    fn activity_shows_user_assistant_text_and_tool_calls_but_not_tool_results_or_reminders() {
        let lines = [
            rec(serde_json::json!({"type":"user","timestamp":"2026-10-26T05:00:00Z","message":{"content":"리뷰해 줘"}})),
            rec(serde_json::json!({"type":"user","timestamp":"2026-10-26T05:00:01Z","message":{"content":"<system-reminder>\n안내문</system-reminder>"}})),
            rec(serde_json::json!({"type":"assistant","timestamp":"2026-10-26T05:00:02Z","message":{"content":[{"type":"text","text":"먼저 파일을 읽겠습니다"},{"type":"tool_use","name":"Read","input":{"file_path":"C:/a/b.ts"}},{"type":"thinking","thinking":"비공개"}]}})),
            rec(serde_json::json!({"type":"user","timestamp":"2026-10-26T05:00:03Z","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"긴 결과"}]}})),
            rec(serde_json::json!({"type":"attachment","timestamp":"2026-10-26T05:00:04Z","attachment":{"type":"queued_command","prompt":"추가 요청"}})),
            rec(serde_json::json!({"type":"attachment","attachment":{"type":"queued_command","prompt":"<task-notification>x</task-notification>"}})),
        ]
        .join("\n");
        let items = parse_activity_lines(&lines);
        let kinds: Vec<(&str, &str)> = items.iter().map(|i| (i.kind.as_str(), i.text.as_str())).collect();
        assert_eq!(kinds, vec![("user", "리뷰해 줘"), ("assistant", "먼저 파일을 읽겠습니다"), ("tool", "Read: C:/a/b.ts"), ("user", "추가 요청")]);
    }

    #[test]
    fn activity_keeps_only_the_most_recent_items() {
        let lines: Vec<String> = (0..(MAX_ITEMS + 25)).map(|i| rec(serde_json::json!({"type":"user","message":{"content":format!("메시지 {i}")}}))).collect();
        let items = parse_activity_lines(&lines.join("\n"));
        assert_eq!(items.len(), MAX_ITEMS);
        assert_eq!(items.last().unwrap().text, format!("메시지 {}", MAX_ITEMS + 24));
    }

    fn launch_lines(id: &str, tool_use: &str, cmd: &str) -> Vec<String> {
        vec![
            rec(serde_json::json!({"type":"assistant","timestamp":"2026-10-26T01:00:00Z","message":{"content":[{"type":"tool_use","id":tool_use,"name":"Bash","input":{"command":cmd,"description":"설명","run_in_background":true}}]}})),
            rec(serde_json::json!({"type":"user","timestamp":"2026-10-26T01:00:01Z","message":{"content":[{"type":"tool_result","tool_use_id":tool_use,"content":format!("Command running in background with ID: {id}. Output is being written to: C:\\Temp\\claude\\proj\\sess\\tasks\\{id}.output. You will be notified when it completes — do not poll that file.\nSession cwd remains C:\\x.")}]}})),
        ]
    }

    #[test]
    fn background_tasks_are_matched_launch_to_notification_and_recent_unfinished_are_guessed_running() {
        let mut lines = Vec::new();
        lines.extend(launch_lines("aaa111", "tu1", "nuxt dev"));
        lines.extend(launch_lines("bbb222", "tu2", "gradlew bootRun"));
        lines.extend(launch_lines("ccc333", "tu3", "node img-server.mjs"));
        lines.push(rec(serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>aaa111</task-id><status>completed</status></task-notification>"})));
        let mut scan = TaskScan::default();
        for l in &lines {
            scan_task_line(&mut scan, l);
        }
        let tasks = build_tasks(&scan, 1, None);
        // 최신이 위: ccc333, bbb222, aaa111
        assert_eq!(tasks.iter().map(|t| t.task_id.as_str()).collect::<Vec<_>>(), vec!["ccc333", "bbb222", "aaa111"]);
        assert_eq!(tasks[2].status, "completed");
        assert_eq!(tasks[1].status, "unfinished");
        assert!(tasks[0].running_guess && !tasks[1].running_guess, "데몬이 1개라고 하면 알림 없는 것 중 가장 최근 1개만 실행 중 추정");
        assert_eq!(tasks[0].command, "node img-server.mjs");
        assert_eq!(tasks[0].output_path, r"C:\Temp\claude\proj\sess\tasks\ccc333.output");
    }

    #[test]
    fn alive_is_decided_by_whether_a_bash_wrapper_with_the_same_command_is_still_running() {
        let mut scan = TaskScan::default();
        for l in launch_lines("aaa111", "tu1", "cd /c/x && node img-server.mjs > img.log 2>&1")
            .into_iter()
            .chain(launch_lines("bbb222", "tu2", "cd /c/y && ./gradlew :app:bootRun --no-daemon"))
        {
            scan_task_line(&mut scan, &l);
        }
        // 래퍼는 명령을 eval '...' 안에 넣고 따옴표 이스케이프가 달라질 수 있다 — 공백·따옴표를 뺀 문자열로 비교한다.
        let procs = vec![squash(r#"bash.exe -c "source /snap.sh && eval 'cd /c/x && node img-server.mjs > img.log 2>&1' < /dev/null""#)];
        let tasks = build_tasks(&scan, 2, Some(&procs));
        let by_id = |id: &str| tasks.iter().find(|t| t.task_id == id).unwrap();
        assert_eq!(by_id("aaa111").alive, Some(true), "래퍼가 떠 있으면 실행 중");
        assert_eq!(by_id("bbb222").alive, Some(false), "래퍼가 없으면 끝났거나 방치된 것");
        assert!(!by_id("aaa111").running_guess, "프로세스를 확인했으면 추정은 쓰지 않는다");
        assert_eq!(build_tasks(&scan, 1, None).iter().filter(|t| t.running_guess).count(), 1, "프로세스를 못 얻으면 이전 추정으로 대체");
    }

    #[test]
    fn command_needle_is_whole_for_short_commands_and_the_middle_for_long_ones() {
        assert_eq!(command_needle("node a.mjs"), "nodea.mjs");
        let long = format!("cd /c/x && {} && tail", "A".repeat(200));
        let n = command_needle(&long);
        assert_eq!(n.chars().count(), 60);
        assert!(squash(&long).contains(&n));
    }

    #[test]
    fn agent_communication_tools_are_shown_as_messages_not_as_tool_lines() {
        let lines = [
            rec(serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Agent","input":{"description":"코드 리뷰","prompt":"변경분을 리뷰해 줘"}}]}})),
            rec(serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"SendMessage","input":{"to":"tm-1234","message":"후속 지시입니다"}}]}})),
            rec(serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"SubagentHandback","input":{"message":"리뷰 끝: 이슈 2건"}}]}})),
            rec(serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"mcp__team-monitor__spawn_team_member","input":{"label":"BO","instruction":"BO 화면을 구현해"}}]}})),
            rec(serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"C:/a.ts"}}]}})),
        ]
        .join("\n");
        let items = parse_activity_lines(&lines);
        let got: Vec<(&str, &str)> = items.iter().map(|i| (i.kind.as_str(), i.text.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("message", "서브에이전트 지시(코드 리뷰): 변경분을 리뷰해 줘"),
                ("message", "→ tm-1234: 후속 지시입니다"),
                ("message", "최종 보고: 리뷰 끝: 이슈 2건"),
                ("message", "팀원 지시(BO): BO 화면을 구현해"),
                ("tool", "Read: C:/a.ts"),
            ]
        );
    }

    #[test]
    fn incremental_scan_reads_only_appended_complete_lines() {
        let dir = std::env::temp_dir().join(format!("ctm_activity_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("s.jsonl");
        let first = launch_lines("aaa111", "tu1", "nuxt dev").join("\n") + "\n";
        std::fs::write(&file, &first).unwrap();
        assert_eq!(background_tasks_for(&file, 1).len(), 1);
        // 줄이 반쯤만 써진 상태에서는 아직 반영하지 않는다
        let second = launch_lines("bbb222", "tu2", "gradlew").join("\n");
        let half = &second[..second.len() / 2];
        std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all_for_test(half.as_bytes());
        assert_eq!(background_tasks_for(&file, 1).len(), 1);
        std::fs::OpenOptions::new().append(true).open(&file).unwrap().write_all_for_test(format!("{}\n", &second[second.len() / 2..]).as_bytes());
        assert_eq!(background_tasks_for(&file, 1).len(), 2);
    }

    trait WriteAllForTest {
        fn write_all_for_test(&mut self, b: &[u8]);
    }
    impl WriteAllForTest for std::fs::File {
        fn write_all_for_test(&mut self, b: &[u8]) {
            use std::io::Write;
            self.write_all(b).unwrap();
        }
    }

    #[test]
    fn subagent_file_rejects_unsafe_ids() {
        assert!(subagent_file("C:/x", "sess", "../evil").is_none());
        assert!(subagent_file("C:/x", "sess", "aa5ec3cdb7a092e0c").is_some());
    }
}
