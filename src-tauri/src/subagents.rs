// 팀장이 임의로 띄운 서브에이전트가 지금 몇 개 돌고 있는지를 읽기 전용으로 알아낸다(실측 근거는 아래).
//
// 개수: 데몬이 job마다 쓰는 ~/.claude/jobs/<id>/state.json의 inFlight.tasks(kinds에 local_agent가 있을 때).
//   서브에이전트 시작/종료를 3~9초 안에 반영하고, 중첩(서브에이전트가 띄운 서브에이전트)도 합산한다.
//   권한 대기(blocked)로 멈춘 서브에이전트도 실행 중으로 센다. 꺼진 세션의 state.json에는 낡은 값이 남으므로
//   호출하는 쪽이 live 세션에만 써야 한다.
// 이름: 세션 폴더 <sessionId>/subagents/agent-<id>.meta.json의 description. "실행 중"은 에이전트 id별로
//   시간순 이벤트를 쌓아 마지막이 시작/재개면 실행 중으로 본다(시작 = "Async agent launched" tool_result,
//   재개 = toolUseResult.resumedAgentId, 종료 = <task-notification>의 task-id). 데몬 개수와 실시간 대조해
//   불일치 0을 확인했다. 이름 수가 개수보다 적으면 화면에서 "외 N개"로 처리한다.
// 읽기 실패나 예상과 다른 형태는 전부 조용히 없는 것으로 넘긴다.

use crate::paths::{is_safe_id, jobs_dir};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SubagentInfo {
    pub count: u32,
    pub names: Vec<String>,
}

fn read_records(file: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(file)
        .map(|c| c.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
        .unwrap_or_default()
}

/// 데몬 state.json에서 live 서브에이전트 개수. local_agent가 없거나 0이면 None.
fn daemon_local_agent_count_in(jobs_dir: &Path, short_id: &str) -> Option<u32> {
    if !is_safe_id(short_id) {
        return None;
    }
    let raw = std::fs::read_to_string(jobs_dir.join(short_id).join("state.json")).ok()?;
    let data: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let in_flight = data.get("inFlight")?;
    let has_local_agent = in_flight.get("kinds")?.as_array()?.iter().any(|k| k.as_str() == Some("local_agent"));
    let tasks = in_flight.get("tasks")?.as_u64()? as u32;
    if has_local_agent && tasks > 0 {
        Some(tasks)
    } else {
        None
    }
}

fn find_between<'a>(s: &'a str, prefix: &str, end: char) -> Option<&'a str> {
    let start = s.find(prefix)? + prefix.len();
    let rest = &s[start..];
    Some(&rest[..rest.find(end)?])
}

/// 파일 기반 규칙으로 지금 실행 중으로 보이는 서브에이전트들의 description.
fn running_names_from_files(parent_jsonl: &Path, subagents_dir: &Path) -> Vec<String> {
    let mut by_tool: HashMap<String, String> = HashMap::new();
    let mut desc: HashMap<String, String> = HashMap::new();
    let Ok(entries) = std::fs::read_dir(subagents_dir) else { return Vec::new() };
    let mut jsonls: Vec<PathBuf> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if let Some(id) = name.strip_prefix("agent-").and_then(|n| n.strip_suffix(".meta.json")) {
            if let Ok(raw) = std::fs::read_to_string(e.path()) {
                if let Ok(m) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(t) = m.get("toolUseId").and_then(|v| v.as_str()) {
                        by_tool.insert(t.to_string(), id.to_string());
                    }
                    desc.insert(id.to_string(), m.get("description").and_then(|v| v.as_str()).unwrap_or(id).to_string());
                }
            }
        } else if name.ends_with(".jsonl") {
            jsonls.push(e.path());
        }
    }
    // (시각, 에이전트 id, 실행 중이 되는 이벤트인가). 시각은 UTC ISO 문자열이라 사전순 비교가 곧 시간순이다.
    let mut events: Vec<(String, String, bool)> = Vec::new();
    let mut scan = |recs: Vec<serde_json::Value>, is_parent: bool| {
        for r in recs {
            let ts = r.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if let Some(id) = r.get("toolUseResult").and_then(|t| t.get("resumedAgentId")).and_then(|v| v.as_str()) {
                events.push((ts.clone(), id.to_string(), true));
            }
            let s = r.to_string();
            if s.contains("Async agent launched") {
                if let Some(id) = find_between(&s, "\"tool_use_id\":\"", '"').and_then(|t| by_tool.get(t)) {
                    events.push((ts.clone(), id.clone(), true));
                }
            }
            if !s.contains("<task-notification>") {
                continue;
            }
            // 부모 기록에서는 알림이 처음 생긴 시각(queue-operation enqueue)만 종료로 센다.
            let is_enqueue = r.get("type").and_then(|v| v.as_str()) == Some("queue-operation") && r.get("operation").and_then(|v| v.as_str()) == Some("enqueue");
            if is_parent && !is_enqueue {
                continue;
            }
            if let Some(id) = find_between(&s, "<task-id>", '<') {
                events.push((ts, id.to_string(), false));
            }
        }
    };
    scan(read_records(parent_jsonl), true);
    for f in &jsonls {
        scan(read_records(f), false);
    }
    events.sort_by(|a, b| a.0.cmp(&b.0));
    let mut last: HashMap<String, bool> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for (_, id, run) in events {
        if !last.contains_key(&id) {
            order.push(id.clone());
        }
        last.insert(id, run);
    }
    order
        .into_iter()
        .filter(|id| last.get(id) == Some(&true))
        .map(|id| desc.get(&id).cloned().unwrap_or(id))
        .collect()
}

/// 라이브 팀장 한 명의 서브에이전트 현황. 하나도 안 돌면 None.
pub(crate) fn live_subagents(short_id: &str, cwd: &str, session_id: &str) -> Option<SubagentInfo> {
    let count = daemon_local_agent_count_in(&jobs_dir(), short_id)?;
    let parent = crate::transcript::session_file_path(cwd, session_id);
    let dir = parent.with_extension("").join("subagents");
    let mut names = running_names_from_files(&parent, &dir);
    names.truncate(count as usize);
    Some(SubagentInfo { count, names })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ctm_subagents_{tag}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn count_requires_local_agent_kind_and_positive_tasks() {
        let jobs = tmp("count");
        let w = |id: &str, body: &str| {
            std::fs::create_dir_all(jobs.join(id)).unwrap();
            std::fs::write(jobs.join(id).join("state.json"), body).unwrap();
        };
        w("aaaa1111", r#"{"inFlight":{"tasks":2,"queued":0,"kinds":["local_agent"]}}"#);
        w("bbbb2222", r#"{"inFlight":{"tasks":1,"queued":0,"kinds":["artifact_watch"]}}"#);
        w("cccc3333", r#"{"inFlight":{"tasks":0,"queued":0,"kinds":[]}}"#);
        assert_eq!(daemon_local_agent_count_in(&jobs, "aaaa1111"), Some(2));
        assert_eq!(daemon_local_agent_count_in(&jobs, "bbbb2222"), None);
        assert_eq!(daemon_local_agent_count_in(&jobs, "cccc3333"), None);
        assert_eq!(daemon_local_agent_count_in(&jobs, "../x"), None);
        assert_eq!(daemon_local_agent_count_in(&jobs, "nothere1"), None);
    }

    #[test]
    fn running_names_follow_last_event_per_agent() {
        let d = tmp("names");
        let sub = d.join("sess").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("agent-a1.meta.json"), r#"{"description":"끝난 일","toolUseId":"toolu_A"}"#).unwrap();
        std::fs::write(sub.join("agent-b2.meta.json"), r#"{"description":"도는 일","toolUseId":"toolu_B"}"#).unwrap();
        std::fs::write(sub.join("agent-c3.meta.json"), r#"{"description":"재개된 일","toolUseId":"toolu_C"}"#).unwrap();
        let parent = d.join("sess.jsonl");
        let lines = [
            r#"{"timestamp":"2026-01-01T00:00:01.000Z","type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_A","content":"Async agent launched"}]}}"#,
            r#"{"timestamp":"2026-01-01T00:00:02.000Z","type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_B","content":"Async agent launched"}]}}"#,
            r#"{"timestamp":"2026-01-01T00:00:03.000Z","type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_C","content":"Async agent launched"}]}}"#,
            r#"{"timestamp":"2026-01-01T00:00:04.000Z","type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>a1</task-id></task-notification>"}"#,
            r#"{"timestamp":"2026-01-01T00:00:05.000Z","type":"queue-operation","operation":"enqueue","content":"<task-notification><task-id>c3</task-id></task-notification>"}"#,
            r#"{"timestamp":"2026-01-01T00:00:06.000Z","type":"user","toolUseResult":{"resumedAgentId":"c3"}}"#,
        ];
        std::fs::write(&parent, lines.join("\n")).unwrap();
        assert_eq!(running_names_from_files(&parent, &sub), vec!["도는 일".to_string(), "재개된 일".to_string()]);
    }
}
