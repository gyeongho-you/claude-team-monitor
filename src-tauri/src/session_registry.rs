use crate::agents_json::{fetch_agents_typed, AgentEntry};
use crate::json_file::write_json_file_atomic;
use crate::paths::{is_safe_id, leads_path, members_dir};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;

// main.ts의 LeadRecord — 이번 청크(서브청크 β, resume 경로)부터 leads.json 쓰기(save_leads)가
// 생겨서 Serialize도 함께 derive한다. pub(crate)로 열어 다른 조회 모듈(live_rows.rs 등)이 파일을
// 다시 읽지 않고 재사용할 수 있게 한다.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeadRecord {
    pub id: String,
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "targetDir", default)]
    pub target_dir: String,
    #[serde(rename = "launchedAt", default)]
    pub launched_at: i64,
    #[serde(rename = "approvedMembers", default)]
    pub approved_members: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    // claude가 자동 생성한 세션 주제 — main.ts는 한 번 찾으면 leads.json에 캐싱해서 다음부터는
    // 세션 파일을 다시 안 읽는다. 이번 포팅은 읽기 전용이라(leads.json 쓰기 경로 없음) 그 캐싱
    // 백필은 아직 안 하고, 폴링마다 get_session_ai_title로 다시 찾는다(작은 jsonl 한 번 훑는 정도라
    // 비용은 낮다) — leads.json에 이미 캐싱돼 있으면(Electron 시절 등) 그 값을 우선 쓴다.
    #[serde(rename = "aiTitle", default, skip_serializing_if = "Option::is_none")]
    pub ai_title: Option<String>,
    #[serde(rename = "internalId", default)]
    pub internal_id: Option<String>,
    #[serde(rename = "autoStallNudge", default, skip_serializing_if = "Option::is_none")]
    pub auto_stall_nudge: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<bool>,
    // 팀원 생성 MCP 서버가 "이 프로세스가 어느 팀장인지"를 알아내는 상관값 — issue_mcp_token이
    // 발급/저장한다(spawn_resume.rs). resumeLead는 --resume에 이 값을 다시 실어 보내지 않으므로
    // (A-1 방어, resume_spawn_with_retry 주석 참고) resume 경로 자체는 이 필드를 안 건드린다.
    #[serde(rename = "mcpToken", default, skip_serializing_if = "Option::is_none")]
    pub mcp_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MemberRecord {
    #[serde(rename = "memberId")]
    pub member_id: String,
    #[serde(rename = "leadId")]
    pub lead_id: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub secret: Option<bool>,
}

// readJsonArraySafe(main.ts)와 동일 — 파일이 없거나 배열이 아니거나 파싱에 실패하면 빈 배열로
// fail-open한다(보드/목록 표시는 "일시적으로 못 읽으면 빈 걸로 보이는" 쪽이 낫다).
//
// loadLeads(main.ts)와 마찬가지로 internalId가 없는(이 필드를 추가하기 전에 만들어진) 레코드는
// 여기서 한 번 발급해서 즉시 저장해둔다 — queueLeadOperation/resumeLead(spawn_resume.rs)가 internalId를
// 큐 키·조회 키로 쓰므로, 이게 없으면 그 레코드를 향한 resume 자체가 불가능하다(서브청크 α 시점엔
// leads.json 쓰기 경로가 아예 없어서 이 백필을 못 했다 — 이번 β가 save_leads를 처음 추가하면서
// 함께 챙긴다).
pub fn load_leads() -> Vec<LeadRecord> {
    let raw = match fs::read_to_string(leads_path()) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let mut leads = serde_json::from_str::<Vec<LeadRecord>>(&raw).unwrap_or_default();
    let mut dirty = false;
    for lead in leads.iter_mut() {
        if lead.internal_id.is_none() {
            lead.internal_id = Some(uuid::Uuid::new_v4().to_string());
            dirty = true;
        }
    }
    if dirty {
        save_leads(&leads);
    }
    leads
}

/// saveLeads(main.ts)와 동일.
pub fn save_leads(leads: &[LeadRecord]) {
    if let Err(e) = write_json_file_atomic(&leads_path(), &leads) {
        eprintln!("[save_leads] leads.json 저장 실패: {e}");
    }
}

// loadMembers(main.ts)와 동일 — 팀원별로 파일 하나(memberId.json)씩 흩어져 있다.
pub fn load_members() -> Vec<MemberRecord> {
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
