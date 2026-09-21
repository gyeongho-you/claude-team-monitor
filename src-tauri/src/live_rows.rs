use crate::agents_json::{fetch_agents_typed, AgentEntry};
use crate::paths::{daily_journal_dir, session_edits_dir};
use crate::session_registry::{load_leads, load_members, LeadRecord, MemberRecord};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

// main.ts의 resolveJournalDataDir과 동일 — daily-journal은 별도 설치 플러그인이라 없을 수도 있고,
// 있어도 사용자가 user-config.json의 journal.output_dir로 저장 위치를 바꿔뒀을 수 있다. 그 설정을
// 못 읽으면(미설치 등) fail-open으로 기본 경로를 쓴다.
fn resolve_journal_data_dir() -> PathBuf {
    let config_path = daily_journal_dir().join("user-config.json");
    if let Ok(raw) = fs::read_to_string(&config_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(dir) = v.get("journal").and_then(|j| j.get("output_dir")).and_then(|d| d.as_str()) {
                if !dir.trim().is_empty() {
                    return PathBuf::from(dir);
                }
            }
        }
    }
    daily_journal_dir().join("data")
}

fn is_date_dir_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && name[0..4].bytes().all(|b| b.is_ascii_digit())
        && name[5..7].bytes().all(|b| b.is_ascii_digit())
        && name[8..10].bytes().all(|b| b.is_ascii_digit())
}

#[derive(Debug, Clone, Deserialize)]
struct JournalEntry {
    #[serde(rename = "sessionId", default)]
    session_id: String,
    #[serde(default)]
    time: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    answer: String,
    #[serde(default)]
    summary: Option<String>,
}

// readJournalEntries(main.ts)와 동일 — 팀장을 하루 넘겨 이어가는 경우가 있어서 daily-journal에
// 쌓인 모든 날짜(오래된 순)를 훑어서 합친다.
fn read_journal_entries(project_name: &str) -> Vec<JournalEntry> {
    let journal_dir = resolve_journal_data_dir();
    let mut dates: Vec<String> = match fs::read_dir(&journal_dir) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .filter(|name| is_date_dir_name(name))
            .collect(),
        Err(_) => return Vec::new(),
    };
    dates.sort();

    let mut out = Vec::new();
    for date in dates {
        let file = journal_dir.join(&date).join("history").join(format!("{project_name}.jsonl"));
        let content = match fs::read_to_string(&file) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(entry) = serde_json::from_str::<JournalEntry>(line) {
                out.push(entry);
            }
            // 손상된 줄은 원본(main.ts)과 동일하게 건너뛴다.
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct Preview {
    pub time: String,
    pub prompt: String,
    pub answer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

// getLatestPreview(main.ts)와 동일 — sessionId로 걸러야 같은 디렉토리의 예전 세션 기록이 새
// 세션 카드로 새어나오지 않는다.
fn get_latest_preview(project_name: &str, session_id: &str) -> Option<Preview> {
    let last = read_journal_entries(project_name)
        .into_iter()
        .filter(|e| e.session_id == session_id)
        .next_back()?;
    Some(Preview {
        time: last.time,
        prompt: last.prompt,
        answer: last.answer,
        summary: last.summary.filter(|s| !s.is_empty()),
    })
}

// resolveProjectName(main.ts)와 동일 — daily-journal이 세션당 캐시해둔 프로젝트명을 재사용하고,
// 캐시가 없으면(그 세션에서 Edit/Write가 한 번도 없었으면) cwd의 basename으로 근사한다.
fn resolve_project_name(session_id: &str, cwd: &str) -> String {
    let cache_file = session_edits_dir().join(format!("{session_id}.project.json"));
    if let Ok(raw) = fs::read_to_string(&cache_file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(name) = v.get("projectName").and_then(|n| n.as_str()) {
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    PathBuf::from(cwd)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

// main.ts의 SessionRow 중 이번 청크(라이브 rows)가 채우는 필드만 가져온다 — offline은 이번
// 범위에서 항상 false(오프라인 히스토리/그레이스 판정은 다음 청크), resumeRetrying 등 정체
// 감시·재시도 관련 필드는 아예 없다.
#[derive(Debug, Clone, Serialize)]
pub struct SessionRow {
    #[serde(flatten)]
    pub agent: AgentEntry,
    #[serde(rename = "projectName")]
    pub project_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<Preview>,
    #[serde(rename = "isLead")]
    pub is_lead: bool,
    #[serde(rename = "leadId", skip_serializing_if = "Option::is_none")]
    pub lead_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub offline: bool,
    #[serde(rename = "internalId", skip_serializing_if = "Option::is_none")]
    pub internal_id: Option<String>,
    #[serde(rename = "autoStallNudge", skip_serializing_if = "Option::is_none")]
    pub auto_stall_nudge: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
}

fn build_row(agent: AgentEntry, lead: Option<&LeadRecord>, member: Option<&MemberRecord>) -> SessionRow {
    let is_lead = lead.is_some();
    let project_name = resolve_project_name(&agent.session_id, &agent.cwd);
    let preview = get_latest_preview(&project_name, &agent.session_id);
    SessionRow {
        lead_id: member.map(|m| m.lead_id.clone()),
        role: member.and_then(|m| m.role.clone()),
        label: if is_lead {
            lead.and_then(|l| l.label.clone())
        } else {
            member.and_then(|m| m.label.clone())
        },
        offline: false,
        internal_id: lead.and_then(|l| l.internal_id.clone()),
        auto_stall_nudge: lead.and_then(|l| l.auto_stall_nudge),
        secret: if is_lead {
            lead.and_then(|l| l.secret)
        } else {
            member.and_then(|m| m.secret)
        },
        project_name,
        preview,
        is_lead,
        agent,
    }
}

/// computeLiveRows(main.ts)의 포팅 — "작업" 탭 보드가 그리는 SessionRow 목록 중 "지금 살아있는"
/// 부분만 담당한다. leads.json/members에 등록된(=팀장이거나 팀원인) 백그라운드 세션만 대상으로
/// 하고, 그 외(미등록 세션, interactive 세션)는 보드에 아예 안 보여준다(main.ts와 동일한 정책).
///
/// 오프라인 히스토리(offline/그레이스 판정), 정체 감시(runStallWatchdog), 알림 큐
/// (notifyLeadsOfFinishedMembers/deliverPendingNotices), 팀원/팀장 짧은 id 드리프트 보정
/// (reconcileLeadIds/reconcileMemberIds)은 이번 포팅 범위 밖이다 — 전부 다음 청크로 남겨뒀다.
#[tauri::command]
pub fn get_live_session_rows() -> Vec<SessionRow> {
    let leads = load_leads();
    let lead_by_id: HashMap<String, &LeadRecord> = leads.iter().map(|l| (l.id.clone(), l)).collect();
    let members = load_members();
    let member_by_id: HashMap<String, &MemberRecord> = members.iter().map(|m| (m.member_id.clone(), m)).collect();

    fetch_agents_typed()
        .into_iter()
        .filter_map(|agent| {
            let id = agent.id.clone()?;
            let lead = lead_by_id.get(&id).copied();
            let member = if lead.is_some() { None } else { member_by_id.get(&id).copied() };
            if lead.is_none() && member.is_none() {
                return None;
            }
            Some(build_row(agent, lead, member))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // session_registry.rs의 tags_this_running_session_as_member와 같은 전제 — 실제 등록 상태
    // 기준으로 검증한다(1d285d20=팀장, 846ee1cb=바로 이 세션인 팀원).
    #[test]
    fn builds_rows_for_this_running_lead_and_member() {
        let rows = get_live_session_rows();
        let member_row = rows.iter().find(|r| r.agent.id.as_deref() == Some("846ee1cb"));
        if let Some(row) = member_row {
            assert!(!row.is_lead);
            assert_eq!(row.lead_id.as_deref(), Some("1d285d20"));
            assert_eq!(row.role.as_deref(), Some("implementer"));
            assert!(!row.project_name.is_empty());
        }
        let lead_row = rows.iter().find(|r| r.agent.id.as_deref() == Some("1d285d20"));
        if let Some(row) = lead_row {
            assert!(row.is_lead);
            assert!(row.internal_id.is_some());
        }
    }
}
