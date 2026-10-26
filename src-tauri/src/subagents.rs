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
pub struct SubagentRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SubagentInfo {
    pub count: u32,
    pub names: Vec<String>,
    /// 이름과 같은 순서의 (id, 이름) — id가 있어야 그 서브에이전트의 대화를 열어 볼 수 있다.
    pub items: Vec<SubagentRef>,
}

fn read_records(file: &Path) -> Vec<serde_json::Value> {
    std::fs::read_to_string(file)
        .map(|c| c.lines().filter_map(|l| serde_json::from_str(l).ok()).collect())
        .unwrap_or_default()
}

/// 데몬 state.json의 (inFlight.tasks, kinds). tasks가 0이거나 읽을 수 없으면 None.
fn daemon_in_flight_in(jobs_dir: &Path, short_id: &str) -> Option<(u32, Vec<String>)> {
    if !is_safe_id(short_id) {
        return None;
    }
    let raw = std::fs::read_to_string(jobs_dir.join(short_id).join("state.json")).ok()?;
    let data: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let in_flight = data.get("inFlight")?;
    let tasks = in_flight.get("tasks")?.as_u64()? as u32;
    let kinds: Vec<String> = in_flight.get("kinds")?.as_array()?.iter().filter_map(|k| k.as_str().map(str::to_string)).collect();
    if tasks == 0 {
        return None;
    }
    // tasks에는 서브에이전트·백그라운드 명령 말고 다른 종류(artifact_watch 등)도 들어 있다(실측 2026-10-26: [artifact_watch, local_agent] = tasks 2인데
    // 서브에이전트는 1개). 다른 종류는 종류마다 1개로 보고(artifact_watch는 drainableMonitors 개수) 빼서 센다.
    let drainable = in_flight.get("drainableMonitors").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let others: u32 = kinds.iter().filter(|k| *k != "local_agent" && *k != "local_bash").map(|k| if k == "artifact_watch" { drainable.max(1) } else { 1 }).sum();
    let counted = kinds.iter().any(|k| k == "local_agent" || k == "local_bash");
    Some((if counted { tasks.saturating_sub(others).max(1) } else { tasks }, kinds))
}

/// 데몬의 tasks는 종류를 가리지 않은 합계다(실측 2026-10-26: 서브에이전트 1 + 서브에이전트가 띄운 백그라운드 명령 1 = tasks 2,
/// kinds [local_agent, local_bash]). 종류가 섞이면 서브에이전트 수는 파일 규칙으로 센 값(실행 중 이름 수)을 기준으로 삼고,
/// 백그라운드 명령 수는 나머지로 본다. (서브에이전트 수, 백그라운드 명령 수) — 해당 종류가 없으면 None.
fn split_in_flight(tasks: u32, kinds: &[String], files_agents: usize) -> (Option<u32>, Option<u32>) {
    let has = |k: &str| kinds.iter().any(|x| x == k);
    let (has_agent, has_bash) = (has("local_agent"), has("local_bash"));
    let files_agents = files_agents as u32;
    match (has_agent, has_bash) {
        (true, false) => (Some(tasks), None),
        (false, true) => (None, Some(tasks)),
        (true, true) => {
            let agents = files_agents.clamp(1, tasks.saturating_sub(1).max(1));
            (Some(agents), Some(tasks.saturating_sub(agents)).filter(|n| *n > 0))
        }
        (false, false) => (None, None),
    }
}

fn running_agents_for(cwd: &str, session_id: &str) -> Vec<(String, String)> {
    let parent = crate::transcript::session_file_path(cwd, session_id);
    let dir = parent.with_extension("").join("subagents");
    running_agents_from_files(&parent, &dir)
}

/// 데몬이 센 백그라운드 셸 명령(local_bash) 개수 — 화면의 "백그라운드 작업" 칸이 알림 없는 것 중 몇 개가 지금 돌고 있는지 추정하는 기준.
pub(crate) fn live_local_bash_count(short_id: &str, cwd: &str, session_id: &str) -> Option<u32> {
    let (tasks, kinds) = daemon_in_flight_in(&jobs_dir(), short_id)?;
    let files = if kinds.iter().any(|k| k == "local_agent") { running_agents_for(cwd, session_id).len() } else { 0 };
    split_in_flight(tasks, &kinds, files).1
}

/// 팀장은 쉬는 중인데 백그라운드 명령(개발 서버 등)만 남아 데몬이 busy로 보고하는 경우의 정보.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BackgroundOnly {
    pub count: u32,
    pub kinds: Vec<String>,
}

// 실측(2026-10-22, 디자인 팀장이 nuxt dev를 백그라운드로 띄워둔 채 쉬던 사례 + 같은 상황 재현 시험): 데몬은 이 경우에도
// agents status를 busy로 주지만 state.json은 state=working / tempo=idle 이고 inFlight.kinds에 local_bash 등만 있다.
// 서브에이전트(local_agent)가 도는 동안은 tempo가 active로 유지되므로 구분된다. 그래서 "working + tempo idle + 진행 중
// 작업 있음 + local_agent 없음"일 때만 백그라운드 작업만 남은 상태로 본다.
fn background_only_in(jobs_dir: &Path, short_id: &str) -> Option<BackgroundOnly> {
    if !is_safe_id(short_id) {
        return None;
    }
    let raw = std::fs::read_to_string(jobs_dir.join(short_id).join("state.json")).ok()?;
    let data: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if data.get("state")?.as_str()? != "working" || data.get("tempo")?.as_str()? != "idle" {
        return None;
    }
    let in_flight = data.get("inFlight")?;
    let tasks = in_flight.get("tasks")?.as_u64()? as u32;
    let kinds: Vec<String> = in_flight.get("kinds")?.as_array()?.iter().filter_map(|k| k.as_str().map(str::to_string)).collect();
    if tasks == 0 || kinds.iter().any(|k| k == "local_agent") {
        return None;
    }
    Some(BackgroundOnly { count: tasks, kinds })
}

pub(crate) fn live_background_only(short_id: &str) -> Option<BackgroundOnly> {
    background_only_in(&jobs_dir(), short_id)
}

fn find_between<'a>(s: &'a str, prefix: &str, end: char) -> Option<&'a str> {
    let start = s.find(prefix)? + prefix.len();
    let rest = &s[start..];
    Some(&rest[..rest.find(end)?])
}

/// 파일 기반 규칙으로 지금 실행 중으로 보이는 서브에이전트들의 description.
fn running_names_from_files(parent_jsonl: &Path, subagents_dir: &Path) -> Vec<String> {
    running_agents_from_files(parent_jsonl, subagents_dir).into_iter().map(|(_, name)| name).collect()
}

/// 위와 같은 규칙으로 (id, description)을 돌려준다 — id가 있어야 그 서브에이전트의 대화 파일(agent-<id>.jsonl)을 열 수 있다.
fn running_agents_from_files(parent_jsonl: &Path, subagents_dir: &Path) -> Vec<(String, String)> {
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
        .map(|id| {
            let name = desc.get(&id).cloned().unwrap_or_else(|| id.clone());
            (id, name)
        })
        .collect()
}

/// 라이브 팀장 한 명의 서브에이전트 현황. 하나도 안 돌면 None.
pub(crate) fn live_subagents(short_id: &str, cwd: &str, session_id: &str) -> Option<SubagentInfo> {
    let (tasks, kinds) = daemon_in_flight_in(&jobs_dir(), short_id)?;
    if !kinds.iter().any(|k| k == "local_agent") {
        return None;
    }
    let mut agents = running_agents_for(cwd, session_id);
    let count = split_in_flight(tasks, &kinds, agents.len()).0?;
    agents.truncate(count as usize);
    let names = agents.iter().map(|(_, n)| n.clone()).collect();
    let items = agents.into_iter().map(|(id, name)| SubagentRef { id, name }).collect();
    Some(SubagentInfo { count, names, items })
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
        let agents = |id: &str| daemon_in_flight_in(&jobs, id).and_then(|(t, k)| split_in_flight(t, &k, 0).0);
        assert_eq!(agents("aaaa1111"), Some(2));
        assert_eq!(agents("bbbb2222"), None);
        assert_eq!(agents("cccc3333"), None);
        assert_eq!(agents("../x"), None);
        assert_eq!(agents("nothere1"), None);
    }

    #[test]
    fn other_kinds_like_artifact_watch_are_not_counted_as_subagents() {
        let jobs = tmp("others");
        std::fs::create_dir_all(jobs.join("aaaa1111")).unwrap();
        // 실측: 서브에이전트 1개 + 산출물 감시 1개 → tasks 2
        std::fs::write(jobs.join("aaaa1111").join("state.json"), r#"{"inFlight":{"tasks":2,"queued":0,"kinds":["artifact_watch","local_agent"],"drainableMonitors":1}}"#).unwrap();
        assert_eq!(daemon_in_flight_in(&jobs, "aaaa1111").map(|(t, _)| t), Some(1));
    }

    #[test]
    fn mixed_kinds_split_agents_and_background_commands() {
        let k = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // 실측: 서브에이전트 1개 + 그 서브에이전트가 띄운 백그라운드 명령 1개 → tasks 2
        assert_eq!(split_in_flight(2, &k(&["local_agent", "local_bash"]), 1), (Some(1), Some(1)));
        // 파일 규칙이 0개로 읽어도 local_agent가 있으니 최소 1개, 나머지는 백그라운드
        assert_eq!(split_in_flight(2, &k(&["local_agent", "local_bash"]), 0), (Some(1), Some(1)));
        // 서브에이전트 둘 + 명령 하나
        assert_eq!(split_in_flight(3, &k(&["local_agent", "local_bash"]), 2), (Some(2), Some(1)));
        // 종류가 하나면 tasks 그대로
        assert_eq!(split_in_flight(2, &k(&["local_agent"]), 1), (Some(2), None));
        assert_eq!(split_in_flight(3, &k(&["local_bash", "artifact_watch"]), 0), (None, Some(3)));
        assert_eq!(split_in_flight(1, &k(&["artifact_watch"]), 0), (None, None));
    }

    #[test]
    fn background_only_means_working_but_idle_tempo_with_no_subagents() {
        let jobs = tmp("bgonly");
        let w = |id: &str, body: &str| {
            std::fs::create_dir_all(jobs.join(id)).unwrap();
            std::fs::write(jobs.join(id).join("state.json"), body).unwrap();
        };
        // 실측 사례: 디자인 팀장(nuxt dev 백그라운드 + 아티팩트 감시)
        w("aaaa1111", r#"{"state":"working","tempo":"idle","inFlight":{"tasks":3,"kinds":["local_bash","artifact_watch"]}}"#);
        w("bbbb2222", r#"{"state":"working","tempo":"active","inFlight":{"tasks":1,"kinds":["local_bash"]}}"#);
        w("cccc3333", r#"{"state":"working","tempo":"idle","inFlight":{"tasks":1,"kinds":["local_agent"]}}"#);
        w("dddd4444", r#"{"state":"done","tempo":"idle","inFlight":{"tasks":0,"kinds":[]}}"#);
        assert_eq!(background_only_in(&jobs, "aaaa1111"), Some(BackgroundOnly { count: 3, kinds: vec!["local_bash".into(), "artifact_watch".into()] }));
        assert_eq!(background_only_in(&jobs, "bbbb2222"), None, "모델이 일하는 중(tempo active)이면 해당 없음");
        assert_eq!(background_only_in(&jobs, "cccc3333"), None, "서브에이전트가 돌면 진짜 작업 중");
        assert_eq!(background_only_in(&jobs, "dddd4444"), None);
        assert_eq!(background_only_in(&jobs, "../x"), None);
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
