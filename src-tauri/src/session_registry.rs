use crate::agents_json::{fetch_agents_typed, fetch_agents_typed_async, AgentEntry};
use crate::json_file::write_json_file_atomic;
use crate::paths::{is_safe_id, leads_path, members_dir};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use tokio::sync::Mutex as AsyncMutex;

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

// 서브청크 γ(TAURI_NOTICE_QUEUE_DESIGN.md §2)부터 이 앱이 직접 팀원 등록 파일을 쓰기 시작해서
// (launchMember/restartLead의 F-1 전파) Serialize도 함께 derive한다 — β가 LeadRecord에 Serialize를
// 추가했던 것과 같은 이유. createdAt/sessionId를 main.ts의 MemberRecord 타입 그대로 추가했다
// (지금까지는 읽기 전용이라 이 두 필드가 필요 없었다).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberRecord {
    #[serde(rename = "memberId")]
    pub member_id: String,
    #[serde(rename = "leadId")]
    pub lead_id: String,
    #[serde(rename = "createdAt", default)]
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    // reconcileMemberIds(main.ts)가 짧은 id 드리프트를 되찾는 데 쓰는 안정적인 식별자 — 이 필드를
    // 추가하기 전에 등록된 레코드에는 없을 수 있어 optional이다(main.ts 주석과 동일).
    #[serde(rename = "sessionId", default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
    load_leads_from(&leads_path())
}

// pub(crate) — γ의 E-2 재검증 테스트(lead_lifecycle.rs)가 production leads.json을 건드리지 않고
// 같은 read-modify-write 코드 경로를 임시 파일에 대해 그대로 재현하는 데 쓴다(session_registry.rs
// 자신의 β 시절 테스트와 동일한 이유).
pub(crate) fn load_leads_from(path: &Path) -> Vec<LeadRecord> {
    let raw = match fs::read_to_string(path) {
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
        save_leads_to(path, &leads);
    }
    leads
}

// saveLeads(main.ts)와 동일한 파일 쓰기 — 의도적으로 pub이 아니다. leads.json에 쓰는 모든 지점은
// with_leads_lock(아래)을 거쳐야 한다(β 리뷰가 지적한 lost update, TAURI_NOTICE_QUEUE_DESIGN.md
// §3-1) — 이 함수를 직접 pub으로 열어두면 "락을 깜빡하고 load_leads()/save_leads()를 직접
// 짝지어 쓰는" 실수가 컴파일은 되면서 조용히 재발할 수 있다. 그래서 이 모듈 밖에서는 애초에 호출할
// 방법이 없게 막아둔다(A-1의 "타입 시스템으로 강제" 정신을 이 범위에 적용한 것).
pub(crate) fn save_leads_to(path: &Path, leads: &[LeadRecord]) {
    if let Err(e) = write_json_file_atomic(path, &leads) {
        eprintln!("[save_leads] leads.json 저장 실패: {e}");
    }
}

// ---------------------------------------------------------------------------------------------
// leads.json 전용 전역 락(TAURI_NOTICE_QUEUE_DESIGN.md §3-1) — β 리뷰에서 실측 재현된 치명적
// 버그: `queue_lead_operation`(concurrency.rs)은 같은 internalId끼리만 직렬화하므로, 서로 다른
// 팀장을 향한 resume이 거의 동시에 일어나면(각자 다른 internalId라 서로 다른 액터로 완전히 병렬
// 실행됨) 한쪽이 "쓰기 직전 재조회"(load_leads → mutate → save_leads)를 하는 동안 다른 쪽도 같은
// 패턴으로 leads.json을 저장할 수 있다 — 파일 시스템 레벨의 write는 원자적이어도(writeJsonFileAtomic),
// 두 read-modify-write "사이클"이 서로 겹치는 것 자체는 막아주지 못해 lost update가 실측으로
// 재현됐다(리뷰 지적, 5회 중 4회). leads.json을 쓰는 모든 지점(resume_lead/
// background_resume_healing_job/issue_mcp_token 등, resume.rs)은 반드시 이 락 안에서
// load_leads_from~save_leads_to를 수행해야 한다 — 이 함수(with_leads_lock)를 거치지 않고
// load_leads()/save_leads()를 직접 짝지어 쓰면 이 버그가 그대로 재발한다. 순수 읽기만 하는
// 호출부(get_all_background_sessions/get_adoptable_sessions/live_rows.rs/stall_watchdog.rs)는
// save_leads를 스스로 부르지 않으므로 이 락이 굳이 필요 없다(§3-1이 명시한 것과 같은 판단).
// ---------------------------------------------------------------------------------------------

fn leads_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

/// leads.json의 읽기-수정-쓰기 전체를 leads_lock() 하나로 원자적으로 감싼다. `mutate`는 최신
/// leads 배열을 받아 필요한 갱신을 적용하고 `(저장이 필요한지, 임의의 반환값)`을 돌려준다 —
/// 저장이 필요 없으면(예: 대기하는 동안 대상 레코드가 이미 다른 작업으로 대체됨) false를 반환해
/// 불필요한 디스크 쓰기를 피한다. `mutate`는 락을 쥔 채로 동기적으로 실행되므로 그 안에서
/// `.await`를 쓰면 안 된다(파일 I/O 자체는 작은 JSON이라 빠르므로 별도 스레드로 옮기지 않는다 —
/// 다른 호출부들도 이미 load_leads()/save_leads()를 async fn 안에서 직접 동기 호출한다).
pub async fn with_leads_lock<F, R>(mutate: F) -> R
where
    F: FnOnce(&mut Vec<LeadRecord>) -> (bool, R),
{
    with_leads_lock_at(&leads_path(), leads_lock(), mutate).await
}

pub(crate) async fn with_leads_lock_at<F, R>(path: &Path, lock: &AsyncMutex<()>, mutate: F) -> R
where
    F: FnOnce(&mut Vec<LeadRecord>) -> (bool, R),
{
    let _guard = lock.lock().await;
    let mut leads = load_leads_from(path);
    let (dirty, result) = mutate(&mut leads);
    if dirty {
        save_leads_to(path, &leads);
    }
    result
}

// loadMembers(main.ts)와 동일 — 팀원별로 파일 하나(memberId.json)씩 흩어져 있다. 실제 경로를
// 받는 형태(load_members_from)로 분리해뒀다 — lead_lifecycle.rs의 F-1 테스트가 실제
// ~/.claude/claude-team-monitor/members(지금 이 저장소를 작업 중인 실제 팀장/팀원의 등록 파일이
// 있는 곳)를 건드리지 않고 임시 디렉토리로 등록→갱신 왕복을 검증할 수 있게 하기 위함이다.
pub fn load_members() -> Vec<MemberRecord> {
    load_members_from(&members_dir())
}

pub fn load_members_from(dir: &Path) -> Vec<MemberRecord> {
    let entries = match fs::read_dir(dir) {
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

// registerMember(main.ts)와 동일 — memberId.json 파일 하나로 팀원 하나를 등록/갱신한다. memberId가
// 파일 경로에 직접 쓰이므로 is_safe_id로 한 번 더 막는다(main.ts 주석과 동일한 이중 방어 이유 —
// 지금 있는 호출부는 전부 이미 안전한 memberId만 넘기지만, 이 함수 자체도 방어선을 이중화해둔다).
pub fn register_member(member: &MemberRecord) {
    register_member_in(&members_dir(), member);
}

pub fn register_member_in(dir: &Path, member: &MemberRecord) {
    if !is_safe_id(&member.member_id) {
        eprintln!(
            "[register_member] memberId 형식이 안전하지 않아 등록을 거부합니다: {:?}",
            member.member_id
        );
        return;
    }
    if let Err(e) = write_json_file_atomic(&dir.join(format!("{}.json", member.member_id)), member) {
        eprintln!("[register_member] 팀원 등록 파일 저장 실패: {e}");
    }
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

// ---------------------------------------------------------------------------------------------
// registerProbableMember(main.ts:2311-2318) — 세션 정리 탭에서 "이 팀장 소속일 수 있음" 추정
// 세션을 사람이 확인하고 누르는 "팀원으로 등록" 버튼용. agentId는 실제로 지금 떠있어야 하고(가짜
// 등록 방지), leadId도 실제 등록된 팀장이어야 한다 — 둘 다 아니면 아무 일도 안 하고 false를
// 반환한다.
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn register_probable_member_command(agent_id: String, lead_id: String) -> bool {
    let agents = fetch_agents_typed_async().await;
    let Some(agent) = agents.iter().find(|a| a.id.as_deref() == Some(agent_id.as_str()) && a.kind == "background") else {
        return false;
    };
    if !load_leads().iter().any(|l| l.id == lead_id) {
        return false;
    }
    register_member(&MemberRecord {
        member_id: agent_id,
        lead_id,
        created_at: crate::timing::now_ms(),
        role: None,
        label: None,
        session_id: Some(agent.session_id.clone()),
        secret: None,
    });
    true
}

// ---------------------------------------------------------------------------------------------
// getInteractiveSessions(main.ts:2345-2350) — interactive 세션(사용자가 지금 타이핑 중일 수도
// 있는 진짜 터미널) 목록. "기존 세션 연결" 화면의 forkSessionAsLead 대상 후보용.
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn get_interactive_sessions_command() -> Vec<AgentEntry> {
    let mut agents: Vec<AgentEntry> = fetch_agents_typed_async().await.into_iter().filter(|a| a.kind == "interactive").collect();
    agents.sort_by(|a, b| b.started_at.unwrap_or(0).cmp(&a.started_at.unwrap_or(0)));
    agents
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

    // ---------------------------------------------------------------------------------------
    // leads.json 전역 락(β 리뷰가 지적한 치명적 lost update) — 재현/수정 확인.
    //
    // 실제 %APPDATA%\claude-team-monitor\leads.json은 지금 이 저장소를 작업 중인 실제 팀장/팀원
    // 세션의 등록 정보를 담고 있어서(위 tags_this_running_session_as_member 테스트 주석 참고),
    // 이 파일에 직접 동시 쓰기를 거는 테스트를 돌리면 실제 세션 데이터를 손상시킬 위험이 있다 —
    // 그래서 load_leads_from/save_leads_to/with_leads_lock_at을 경로를 받는 형태로 분리해뒀고
    // (session_registry.rs 위쪽 참고), 아래 두 테스트는 std::env::temp_dir() 안의 전용 임시
    // 파일에 대해서만 이 함수들을 직접 호출한다 — 프로덕션 경로(leads_path())는 전혀 건드리지
    // 않는다.
    fn fake_lead_for_race(internal_id: &str, id: &str, session_id: &str) -> LeadRecord {
        LeadRecord {
            id: id.to_string(),
            session_id: session_id.to_string(),
            target_dir: "C:\\fake".to_string(),
            launched_at: 1_000,
            approved_members: Vec::new(),
            label: None,
            ai_title: None,
            internal_id: Some(internal_id.to_string()),
            auto_stall_nudge: None,
            secret: None,
            mcp_token: None,
        }
    }

    fn temp_leads_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_leads_{tag}_{}.json", uuid::Uuid::new_v4()))
    }

    fn session_id_of<'a>(leads: &'a [LeadRecord], internal_id: &str) -> Option<&'a str> {
        leads.iter().find(|l| l.internal_id.as_deref() == Some(internal_id)).map(|l| l.session_id.as_str())
    }

    // 이 테스트는 "고쳐지기 전" resume_lead/background_resume_healing_job이 실제로 했던 패턴
    // (load_leads → 오래 걸리는 비동기 작업 → save_leads, 락 없음)을 서로 다른 두 internalId에
    // 대해 동시에 재현한다 — β 리뷰가 실측한 lost update(5회 중 4회)와 같은 원인·같은 모양이다.
    // start_paused=true로 가상 시계를 쓰므로 타이밍이 완전히 결정적이다(실제 wall-clock sleep의
    // 미세한 흔들림에 의존하지 않는다) — A는 "sessionId 재조회"에 해당하는 30ms(가상)짜리 지연 뒤에
    // 쓰고, B는 5ms(가상) 지연 뒤에 쓴다. B의 읽기(t=5ms)는 A의 쓰기(t=30ms)보다 먼저 일어나므로
    // A가 캡처해둔 낡은 스냅숏이 그대로 저장되면서 B의 갱신을 통째로 덮어쓴다.
    #[tokio::test(start_paused = true)]
    async fn leads_json_lost_update_is_reproducible_without_the_lock() {
        let path = temp_leads_path("unlocked");
        let initial = vec![
            fake_lead_for_race("race-a", "lead-a", "session-a-orig"),
            fake_lead_for_race("race-b", "lead-b", "session-b-orig"),
        ];
        save_leads_to(&path, &initial);

        let path_a = path.clone();
        let task_a = tokio::spawn(async move {
            let mut leads = load_leads_from(&path_a);
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            for l in leads.iter_mut() {
                if l.internal_id.as_deref() == Some("race-a") {
                    l.session_id = "session-a-resumed".to_string();
                }
            }
            save_leads_to(&path_a, &leads);
        });
        let path_b = path.clone();
        let task_b = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            let mut leads = load_leads_from(&path_b);
            for l in leads.iter_mut() {
                if l.internal_id.as_deref() == Some("race-b") {
                    l.session_id = "session-b-resumed".to_string();
                }
            }
            save_leads_to(&path_b, &leads);
        });
        let _ = tokio::join!(task_a, task_b);

        let final_leads = load_leads_from(&path);
        let _ = std::fs::remove_file(&path);

        let a_applied = session_id_of(&final_leads, "race-a") == Some("session-a-resumed");
        let b_applied = session_id_of(&final_leads, "race-b") == Some("session-b-resumed");
        assert!(
            !(a_applied && b_applied),
            "락 없이 두 internalId를 거의 동시에 갱신하면 lost update가 재현돼야 하는데, 이번엔 둘 다 반영됐다\
(final={final_leads:?}) — 재현 조건(타이밍)이 바뀌었는지 확인 필요"
        );
        // race-a는 나중에 쓰기 때문에(가상 시계상 30ms) 항상 남아있고, race-b가 사라진 쪽이어야 한다.
        assert!(a_applied, "나중에 쓰는 쪽(race-a)의 갱신은 남아있어야 한다");
        assert!(!b_applied, "먼저 쓰고 나중에 덮어써지는 쪽(race-b)의 갱신이 사라져야 한다(lost update)");
    }

    // 위와 완전히 같은 경합을 with_leads_lock_at(=프로덕션 with_leads_lock이 실제로 쓰는 함수)으로
    // 감싸서 돌린다 — 두 internalId 모두 각각 다른 "느린 비동기 작업" 뒤에 자기 레코드만 저장하려고
    // 하지만, 이제는 load+mutate+save 전체가 하나의 tokio::sync::Mutex 안에서 원자적으로 실행되므로
    // 어느 쪽이 락을 먼저 잡든 나중에 실행되는 쪽이 "이미 반영된 최신 배열"을 다시 읽어와 그 위에
    // 얹는다 — 두 갱신 다 최종 파일에 남아야 한다. 두 순서(A가 느릴 때/B가 느릴 때) 모두 검증한다.
    #[tokio::test(start_paused = true)]
    async fn with_leads_lock_prevents_lost_update_under_concurrent_writes_to_different_leads() {
        for (slow_a_ms, slow_b_ms) in [(30u64, 5u64), (5u64, 30u64)] {
            let path = temp_leads_path("locked");
            let lock = AsyncMutex::new(());
            let initial = vec![
                fake_lead_for_race("race-a", "lead-a", "session-a-orig"),
                fake_lead_for_race("race-b", "lead-b", "session-b-orig"),
            ];
            save_leads_to(&path, &initial);

            let task_a = async {
                tokio::time::sleep(std::time::Duration::from_millis(slow_a_ms)).await;
                with_leads_lock_at(&path, &lock, |leads| {
                    for l in leads.iter_mut() {
                        if l.internal_id.as_deref() == Some("race-a") {
                            l.session_id = "session-a-resumed".to_string();
                        }
                    }
                    (true, ())
                })
                .await;
            };
            let task_b = async {
                tokio::time::sleep(std::time::Duration::from_millis(slow_b_ms)).await;
                with_leads_lock_at(&path, &lock, |leads| {
                    for l in leads.iter_mut() {
                        if l.internal_id.as_deref() == Some("race-b") {
                            l.session_id = "session-b-resumed".to_string();
                        }
                    }
                    (true, ())
                })
                .await;
            };
            tokio::join!(task_a, task_b);

            let final_leads = load_leads_from(&path);
            let _ = std::fs::remove_file(&path);

            assert_eq!(
                session_id_of(&final_leads, "race-a"),
                Some("session-a-resumed"),
                "slow_a={slow_a_ms}ms/slow_b={slow_b_ms}ms 조합에서 race-a의 갱신이 사라지면 안 된다(final={final_leads:?})"
            );
            assert_eq!(
                session_id_of(&final_leads, "race-b"),
                Some("session-b-resumed"),
                "slow_a={slow_a_ms}ms/slow_b={slow_b_ms}ms 조합에서 race-b의 갱신이 사라지면 안 된다(final={final_leads:?})"
            );
        }
    }

    // register_probable_member_command — 존재하지 않는 agentId/leadId는 항상 false여야 한다(가짜
    // 등록 방지). 실제 떠있는 세션으로 성공 경로까지 재현하려면 실제 claude 프로세스가 필요해서
    // (실사용 상태에 의존) 실패 경로만 결정적으로 검증한다.
    #[tokio::test]
    async fn register_probable_member_rejects_unknown_agent_or_lead() {
        assert!(!register_probable_member_command("definitely-not-a-live-agent-xyz".to_string(), "1d285d20".to_string()).await);
        assert!(!register_probable_member_command("846ee1cb".to_string(), "definitely-not-a-real-lead-xyz".to_string()).await);
    }

    // get_interactive_sessions_command — kind가 항상 interactive인지, 실제 세션이 하나도 없어도
    // (headless 환경 등) 빈 배열로 안전하게 돌아오는지.
    #[tokio::test]
    async fn get_interactive_sessions_only_returns_interactive_kind() {
        let sessions = get_interactive_sessions_command().await;
        assert!(sessions.iter().all(|a| a.kind == "interactive"));
    }
}
