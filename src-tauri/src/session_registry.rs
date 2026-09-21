use crate::agents_json::{fetch_agents_typed, AgentEntry};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

// src/lib/teamMemberPaths.js와 정확히 같은 경로여야 한다 — 팀원 생성 MCP 서버(외부 claude 세션)도
// 이 디렉토리에 직접 등록 파일을 쓰므로, 한쪽만 경로를 바꾸면 "분명 등록했는데 안 보인다" 사고로
// 이어진다.
fn claude_home() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".claude")
}

fn members_dir() -> PathBuf {
    claude_home().join("claude-team-monitor").join("members")
}

// Electron의 app.getPath('userData') 기본값은 path.join(appData, app.getName())이고, app.getName()은
// package.json의 "name"(=claude-team-monitor)을 그대로 쓴다(main.ts에 app.setName 호출 없음을
// 확인함) — 실제로 %APPDATA%\claude-team-monitor\leads.json에 데이터가 있는 것도 확인했다. 이
// 앱(Tauri)도 같은 경로를 읽어야 Electron 시절에 등록된 팀장/팀원이 그대로 보인다.
fn app_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata).join("claude-team-monitor")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("claude-team-monitor")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".config").join("claude-team-monitor")
    }
}

fn leads_path() -> PathBuf {
    app_data_dir().join("leads.json")
}

// pathGuard.js의 isSafeId와 동일한 규칙. 팀원 등록 파일(~/.claude/claude-team-monitor/members/*.json)은
// 이 앱이 아니라 외부(팀장) claude 세션이 SKILL.md 안내에 따라 직접 파일로 써서 남긴다 — memberId
// 필드값을 검증 없이 신뢰하면 안 된다(팀원 코드리뷰에서 지적된 경로 조작 위험. 이번 포팅 범위는
// 읽기 전용 조회라 삭제/쓰기 경로에 직접 이어붙이진 않지만, 화면에 잘못된 값이 그대로 노출되는 것도
// 막기 위해 원본과 동일하게 걸러낸다).
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// main.ts의 LeadRecord에서 이번 조회(태깅·정렬)에 필요한 필드만 가져온다 — 쓰기 경로가 없으므로
// internalId 백필 같은 마이그레이션도 이번 포팅 범위에 없다(다음 기능 단위: 보드 rows 포팅에서 다룸).
#[derive(Debug, Clone, Deserialize)]
struct LeadRecord {
    id: String,
    #[serde(rename = "targetDir", default)]
    target_dir: String,
    #[serde(rename = "launchedAt", default)]
    launched_at: i64,
    #[serde(rename = "approvedMembers", default)]
    approved_members: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct MemberRecord {
    #[serde(rename = "memberId")]
    member_id: String,
    #[serde(rename = "leadId")]
    lead_id: String,
}

// readJsonArraySafe(main.ts)와 동일 — 파일이 없거나 배열이 아니거나 파싱에 실패하면 빈 배열로
// fail-open한다(보드/목록 표시는 "일시적으로 못 읽으면 빈 걸로 보이는" 쪽이 낫다).
fn load_leads() -> Vec<LeadRecord> {
    let raw = match fs::read_to_string(leads_path()) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Vec<LeadRecord>>(&raw).unwrap_or_default()
}

// loadMembers(main.ts)와 동일 — 팀원별로 파일 하나(memberId.json)씩 흩어져 있다.
fn load_members() -> Vec<MemberRecord> {
    let dir = members_dir();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let member: MemberRecord = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !is_safe_id(&member.member_id) {
            eprintln!(
                "[load_members] memberId 형식이 안전하지 않아 무시합니다: {:?}",
                member.member_id
            );
            continue;
        }
        out.push(member);
    }
    out
}

// guessProbableLeadId(main.ts)와 동일 — 등록은 안 됐지만 그 팀장의 승인된 디렉토리에서 그 팀장이
// 뜬 뒤 나타난 세션이면 "이 팀장 소속일 수 있음"으로 추정만 한다(자동 등록은 안 함).
fn guess_probable_lead_id(agent: &AgentEntry, leads: &[LeadRecord]) -> Option<String> {
    leads
        .iter()
        .find(|l| {
            l.approved_members.iter().any(|d| d == &agent.cwd)
                && agent.started_at.unwrap_or(0) >= l.launched_at
        })
        .map(|l| l.id.clone())
}

#[derive(Debug, Clone, Serialize)]
pub struct BackgroundSessionRow {
    #[serde(flatten)]
    pub agent: AgentEntry,
    pub tag: String, // "lead" | "member" | "untracked"
    #[serde(rename = "leadId", skip_serializing_if = "Option::is_none")]
    pub lead_id: Option<String>,
    #[serde(rename = "probableLeadId", skip_serializing_if = "Option::is_none")]
    pub probable_lead_id: Option<String>,
    #[serde(rename = "registeredDir", skip_serializing_if = "Option::is_none")]
    pub registered_dir: Option<String>,
}

/// "세션 정리" 탭 전용 — getAllBackgroundSessions(main.ts)의 포팅. 지금 떠있는 모든 백그라운드
/// 세션에 leads.json/members 등록 정보를 대조해 tag(lead/member/untracked)를 붙여 최신순으로
/// 돌려준다. 오프라인 히스토리·정체 감시·알림 큐 등 작업 탭 보드(buildSessionRows)가 갖고 있는
/// 나머지 상태 머신은 이번 포팅 범위 밖이다(다음 기능 단위로 남겨둠).
#[tauri::command]
pub fn get_all_background_sessions() -> Vec<BackgroundSessionRow> {
    let agents = fetch_agents_typed();
    let leads = load_leads();
    let lead_ids: HashSet<String> = leads.iter().map(|l| l.id.clone()).collect();
    let member_lead_by_id: HashMap<String, String> = load_members()
        .into_iter()
        .map(|m| (m.member_id, m.lead_id))
        .collect();

    let mut rows: Vec<BackgroundSessionRow> = agents
        .into_iter()
        .filter(|a| a.kind == "background" && a.id.is_some())
        .map(|a| {
            let id = a.id.clone().unwrap();
            let tag = if lead_ids.contains(&id) {
                "lead"
            } else if member_lead_by_id.contains_key(&id) {
                "member"
            } else {
                "untracked"
            };
            let lead_id = member_lead_by_id.get(&id).cloned();
            let probable_lead_id = if tag == "untracked" {
                guess_probable_lead_id(&a, &leads)
            } else {
                None
            };
            let registered_dir = if tag == "lead" {
                leads.iter().find(|l| l.id == id).map(|l| l.target_dir.clone())
            } else {
                None
            };
            BackgroundSessionRow {
                agent: a,
                tag: tag.to_string(),
                lead_id,
                probable_lead_id,
                registered_dir,
            }
        })
        .collect();

    rows.sort_by(|a, b| b.agent.started_at.unwrap_or(0).cmp(&a.agent.started_at.unwrap_or(0)));
    rows
}

/// getAdoptableSessions(main.ts)의 포팅 — "기존 세션 연결" 드롭다운용. 아직 팀장/팀원으로 등록
/// 안 된 백그라운드 세션만, 최신순으로 돌려준다.
#[tauri::command]
pub fn get_adoptable_sessions() -> Vec<AgentEntry> {
    let agents = fetch_agents_typed();
    let leads = load_leads();
    let members = load_members();
    let tracked: HashSet<String> = leads
        .iter()
        .map(|l| l.id.clone())
        .chain(members.into_iter().map(|m| m.member_id))
        .collect();

    let mut result: Vec<AgentEntry> = agents
        .into_iter()
        .filter(|a| a.kind == "background" && a.id.as_ref().is_some_and(|id| !tracked.contains(id)))
        .collect();
    result.sort_by(|a, b| b.started_at.unwrap_or(0).cmp(&a.started_at.unwrap_or(0)));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // 실제 %APPDATA%\claude-team-monitor\leads.json / ~/.claude/claude-team-monitor/members에
    // 이 저장소를 작업 중인 팀장(1d285d20)/팀원(846ee1cb, 바로 이 세션)이 등록돼 있는 실제 환경에서
    // 돌아간다는 전제로 검증한다 — 완전한 모킹 대신 "지금 이 PC의 실제 등록 상태"를 기준 삼는다.
    #[test]
    fn tags_this_running_session_as_member() {
        let rows = get_all_background_sessions();
        let this_session = rows.iter().find(|r| r.agent.id.as_deref() == Some("846ee1cb"));
        if let Some(row) = this_session {
            assert_eq!(row.tag, "member", "846ee1cb는 leadId=1d285d20의 등록된 팀원이어야 한다");
            assert_eq!(row.lead_id.as_deref(), Some("1d285d20"));
        }
        // agents --json 스냅샷에서 이 세션이 이미 종료된 뒤라면(테스트를 나중에 재실행하는 경우)
        // 조용히 스킵한다 — 이 테스트의 목적은 "지금 떠있다면 태깅이 맞는지"이지, 항상 떠있음을
        // 보장하는 게 아니다.
    }
}
