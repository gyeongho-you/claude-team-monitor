// 서브청크 γ(TAURI_NOTICE_QUEUE_DESIGN.md §2) — restartLead/endLeadWork/launchTeamLead/launchMember/
// adoptLead/forkSessionAsLead(main.ts)와 그 공통 헬퍼(installTeamLeadSkill/approvedMemberBriefing/
// buildMemberSpawnCliArgs/SECRET_MODE_CLI_ARGS)의 포팅. 전부 β(resume.rs)가 만든
// run_claude_bg/stop_session/find_session_id_by_short_id/resume_lead와
// α(concurrency.rs)의 queue_lead_operation, session_registry.rs의 with_leads_lock을 그대로
// 재사용하는 "다른 spawn 경로들"이다 — 이 파일 자체는 새로운 동시성 primitive를 만들지 않는다.
//
// 포함 사고: F-1(restartLead가 짧은 id를 바꾸는데 MemberRecord.leadId는 안 건드리는 버그),
// E-2(forkSessionAsLead의 leads.json lost update — with_leads_lock 재사용으로 방지).
//
// A-1 타입 분리(TAURI_NOTICE_QUEUE_DESIGN.md §1 A-1 마지막 문단): resume 경로(β)는 --resume에
// mcp-config/allowedTools를 절대 다시 실으면 안 되고, 이 파일이 다루는 완전히 새 세션 스폰 경로
// (restart_lead/launch_team_lead/fork_session_as_lead)는 정반대로 반드시 실어야 한다 — 리뷰에서
// "이 구분이 타입 시스템이 아니라 우연히 지켜지는 수준"이라는 지적이 있었다. 이번 청크가 새로
// 만드는 함수들은 전부 FreshLaunchArgs(아래)를 거쳐서만 flags를 조립하게 강제해서, 이 모듈 안에서는
// "그냥 Vec<String>을 손으로 조립해 run_claude_bg에 넘기는" 경로 자체가 없다. 다만 β(resume.rs)의
// resume_once_with_ports는 여전히 인라인 vec!["--bg","--resume",...]를 쓴다 — 대응하는
// ResumeArgs 타입으로 분리해 FreshLaunchArgs와 컴파일 타임에 완전히 못 섞이게 만드는 리팩터는
// β를 다시 여는 작업이라 이번 커밋 범위에는 포함하지 않았다(커밋 메시지에도 명시).

use crate::agents_json::fetch_agents_typed_async;
use crate::board_state::{migrate_last_known_live_lead_row, state as board_state};
use crate::claude_readiness::{check_directory_claude_ready, claude_not_ready_message};
use crate::concurrency::queue_lead_operation;
use crate::logging::log_critical;
use crate::long_prompt_guard::resolve_long_prompt;
use crate::paths::{member_templates_path, members_dir, requests_dir, skill_dest_dir, skill_src_path, team_member_server_js_path};
use crate::resume::{find_session_id_by_short_id_retrying, resume_lead, run_claude_bg, stop_session};
use crate::session_registry::{load_leads, load_members, register_member, with_leads_lock, LeadRecord, MemberRecord};
use crate::timing::{now_ms, RUN_CLAUDE_TIMEOUT_MS};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------------------------
// installTeamLeadSkill(main.ts) — SKILL.md를 ~/.claude/skills/team-lead에 설치/갱신하고, 팀장
// 세션이 알아야 하는 requests/members 디렉토리를 미리 만들어둔다. 설치가 실패해도(권한 문제 등)
// 이미 설치돼 있던 스킬로 계속 진행할 수 있어야 하므로 각 단계는 실패해도 계속 진행한다(main.ts의
// try/catch 한 덩어리와 동등한 fail-open — 어느 단계에서 실패하든 앱 동작 자체는 막지 않는다).
// ---------------------------------------------------------------------------------------------

pub fn install_team_lead_skill() {
    if let Err(e) = std::fs::create_dir_all(skill_dest_dir()) {
        eprintln!("[install_team_lead_skill] 팀장 스킬 설치/갱신 실패 — 기존에 설치돼 있던 스킬로 계속 진행합니다: {e}");
    } else if let Err(e) = std::fs::copy(skill_src_path(), skill_dest_dir().join("SKILL.md")) {
        eprintln!("[install_team_lead_skill] 팀장 스킬 설치/갱신 실패 — 기존에 설치돼 있던 스킬로 계속 진행합니다: {e}");
    }
    if let Err(e) = std::fs::create_dir_all(requests_dir()) {
        eprintln!("[install_team_lead_skill] requests 디렉토리 생성 실패(무시하고 계속 진행): {e}");
    }
    if let Err(e) = std::fs::create_dir_all(members_dir()) {
        eprintln!("[install_team_lead_skill] members 디렉토리 생성 실패(무시하고 계속 진행): {e}");
    }
}

// ---------------------------------------------------------------------------------------------
// approvedMemberBriefing(main.ts) — 사전승인된 팀원 디렉토리/역할 템플릿을 팀장 프롬프트에 붙일
// 안내문으로 조립한다. MemberTemplate/loadMemberTemplates는 이번 청크에서 처음 필요해졌다(β까지는
// 아무 함수도 이걸 안 썼다).
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct MemberTemplate {
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub instruction: String,
    #[serde(default)]
    pub approved: bool,
}

// loadMemberTemplates(main.ts)와 동일 — readJsonArraySafe와 같은 fail-open(파일 없음/파싱 실패
// 시 빈 배열).
fn load_member_templates() -> Vec<MemberTemplate> {
    let raw = match std::fs::read_to_string(member_templates_path()) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Vec<MemberTemplate>>(&raw).unwrap_or_default()
}

// approvedMemberBriefing(main.ts)의 순수 조립부 — 디스크 I/O(load_member_templates)와 분리해서
// 단위 테스트한다.
fn build_member_briefing(templates: &[MemberTemplate], caller_dir: &str) -> (Vec<String>, String) {
    let scoped: Vec<&MemberTemplate> = templates.iter().filter(|t| t.scope == "shared" || t.scope == caller_dir).collect();
    let approved_with_path: Vec<&MemberTemplate> = scoped.iter().copied().filter(|t| t.approved && t.path.is_some()).collect();
    let without_path: Vec<&MemberTemplate> = scoped.iter().copied().filter(|t| t.path.is_none()).collect();

    let mut parts: Vec<String> = Vec::new();
    if !approved_with_path.is_empty() {
        let lines: Vec<String> = approved_with_path
            .iter()
            .map(|t| {
                let role = if t.role.is_empty() { String::new() } else { format!(" (역할: {})", t.role) };
                let instr = if t.instruction.is_empty() { String::new() } else { format!(" — 추천 지시: \"{}\"", t.instruction) };
                format!("- {}{role}{instr}", t.path.as_deref().unwrap_or_default())
            })
            .collect();
        parts.push(format!("사전 승인된 팀원 디렉토리 목록(이 안에서는 바로 팀원을 띄워도 됨):\n{}", lines.join("\n")));
    } else {
        parts.push("사전 승인된 팀원 디렉토리가 없음 — 팀원이 필요하면 반드시 승인 요청부터 거쳐라.".to_string());
    }
    if !without_path.is_empty() {
        let lines: Vec<String> = without_path
            .iter()
            .map(|t| {
                let role = if t.role.is_empty() { "미지정".to_string() } else { t.role.clone() };
                let instr = if t.instruction.is_empty() { String::new() } else { format!(" — 기본 지시: \"{}\"", t.instruction) };
                format!("- {}(역할: {role}){instr}", t.name)
            })
            .collect();
        parts.push(format!(
            "특정 프로젝트에 묶이지 않은 역할(필요한 디렉토리에 적용해서 써라 — 그 디렉토리가 위 사전승인 목록에 없으면 승인 요청부터 거쳐라):\n{}",
            lines.join("\n")
        ));
    }
    let paths: Vec<String> = approved_with_path.iter().filter_map(|t| t.path.clone()).collect();
    (paths, parts.join("\n\n"))
}

/// approvedMemberBriefing(main.ts)과 동일.
pub fn approved_member_briefing(caller_dir: &str) -> (Vec<String>, String) {
    build_member_briefing(&load_member_templates(), caller_dir)
}

// ---------------------------------------------------------------------------------------------
// buildMemberSpawnCliArgs/SECRET_MODE_CLI_ARGS(main.ts) — 팀원 생성 MCP 서버를 팀장 세션에
// 붙이는 CLI 인자 조립.
// ---------------------------------------------------------------------------------------------

const MEMBER_SPAWN_MCP_SERVER_NAME: &str = "team-monitor";
const MEMBER_SPAWN_TOOL_NAME: &str = "mcp__team-monitor__spawn_team_member";
// 이 앱을 거치지 않고 터미널+스킬만으로 시작한 세션도 스스로를 팀장으로 등록할 수 있는 툴 —
// 이 앱이 띄운 세션은 이미 등록된 채로 시작하니 보통 쓸 일이 없지만, 혹시 모를 상황(등록이
// 누락된 채로 남는 경우 등)을 위해 같이 화이트리스트해둔다(main.ts의 buildMemberSpawnCliArgs와
// 동일한 이유).
const MEMBER_REGISTER_TOOL_NAME: &str = "mcp__team-monitor__register_as_lead";

// 예전엔 이 함수가 스폰 직전에 발급한 토큰(mcp_token)을 env로 실어 보냈다 — 이제 MCP 서버가
// process.ppid로 자기 자신을 identify하므로(teamMemberServer.ts의 resolveCallingLead 참고) 더
// 이상 토큰도, leads.json 경로를 env로 넘겨줄 필요도 없다(MCP 서버가 lib/teamMemberPaths에서
// 직접 계산한다 — paths.rs의 leads_path()와 정확히 같은 경로).
/// buildMemberSpawnCliArgs(main.ts)와 동일.
pub fn build_member_spawn_cli_args() -> Vec<String> {
    let config = serde_json::json!({
        "mcpServers": {
            MEMBER_SPAWN_MCP_SERVER_NAME: {
                "command": "node",
                "args": [team_member_server_js_path().to_string_lossy()],
            }
        }
    });
    vec![
        "--mcp-config".to_string(),
        config.to_string(),
        "--allowedTools".to_string(),
        format!("{MEMBER_SPAWN_TOOL_NAME},{MEMBER_REGISTER_TOOL_NAME}"),
    ]
}

/// SECRET_MODE_CLI_ARGS(main.ts)와 동일.
pub const SECRET_MODE_CLI_ARGS: [&str; 2] = ["--setting-sources", "project,local"];

/// A-1 타입 분리 — 이 파일 맨 위 주석 참고. 완전히 새 세션을 스폰하는 이 청크의 함수들은 전부 이
/// 타입을 거쳐서만 run_claude_bg에 넘길 flags를 만든다.
#[derive(Default)]
pub struct FreshLaunchArgs {
    secret: bool,
    resume_session_id: Option<String>,
}

impl FreshLaunchArgs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn secret(mut self, secret: bool) -> Self {
        self.secret = secret;
        self
    }

    // forkSessionAsLead(main.ts)의 "새 세션" 경로가 --resume <sessionId>를 덧붙이는 특수 케이스 —
    // A-1이 막는 건 "이미 stop된 세션을 이어가는" resumeLead 전용 조합이고, 여기는 leads.json에
    // 아직 레코드가 없는 완전히 새 claude 프로세스를 interactive 세션의 대화 이어받기로 띄우는
    // 것이라 다르다(원본이 아직 살아있으므로 CLI가 자동으로 복사본을 만들어주는 게 이 기능의
    // 의도된 동작 — main.ts 주석 참고).
    pub fn resume_session_id(mut self, session_id: impl Into<String>) -> Self {
        self.resume_session_id = Some(session_id.into());
        self
    }

    pub fn into_flags(self) -> Vec<String> {
        let mut flags = vec!["--bg".to_string()];
        flags.extend(build_member_spawn_cli_args());
        if self.secret {
            flags.extend(SECRET_MODE_CLI_ARGS.iter().map(|s| s.to_string()));
        }
        if let Some(session_id) = self.resume_session_id {
            flags.push("--resume".to_string());
            flags.push(session_id);
        }
        flags
    }
}

// ---------------------------------------------------------------------------------------------
// restartLead(main.ts) — F-1: 짧은 id가 바뀌는 시점에 소속 팀원 전부를 새 id로 같이 옮겨써야 한다.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum RestartLeadOutcome {
    Success { id: String },
    Failure { error: String },
}

/// F-1의 핵심 불변식만 뽑은 순수 함수 — 디스크 I/O 없이 단위 테스트한다. old_id에 소속됐던
/// 팀원만 new_id로 lead_id를 바꾼 새 목록을 돌려준다(그 외 레코드는 그대로).
fn migrate_members_lead_id(members: Vec<MemberRecord>, old_id: &str, new_id: &str) -> Vec<MemberRecord> {
    members
        .into_iter()
        .map(|m| if m.lead_id == old_id { MemberRecord { lead_id: new_id.to_string(), ..m } } else { m })
        .collect()
}

/// restartLead(main.ts)와 동일. 호출부(restart_lead_command)가 queue_lead_operation(internalId)로
/// 감싸야 한다(resume_lead와 같은 이유).
pub async fn restart_lead(internal_id: String, instruction: String) -> RestartLeadOutcome {
    let leads = load_leads();
    let Some(current) = leads.into_iter().find(|l| l.internal_id.as_deref() == Some(internal_id.as_str())) else {
        return RestartLeadOutcome::Failure {
            error: "팀장 레코드를 찾을 수 없습니다(이미 삭제됐거나 internalId가 어긋났을 수 있음).".to_string(),
        };
    };
    // 2026-09-21 재검증(claude_readiness.rs 주석 참고: claude CLI v2.1.278, 한 번도 실행한 적
    // 없는 새 디렉토리 3곳에서 백그라운드 스폰 3/3 모두 트러스트 다이얼로그 없이 정상 완료) 이후로는
    // main.ts의 restartLead와 같은 이유로 이 판정을 더 이상 spawn 차단에 쓰지 않는다 — 경고만
    // 남기고 그대로 진행한다. 아래에서 spawn 자체가 실패하면 이 판정이 원인일 수 있다는 걸 실패
    // 메시지에 같이 담는다(실측 UI 테스트에서 이 하드 블락이 스크래치 디렉토리의 정상적인 재시작
    // 시도를 전부 막던 것을 확인해 완화함).
    let readiness = check_directory_claude_ready(&current.target_dir);
    if !readiness.ready {
        let reason = readiness.reason.clone().unwrap_or_default();
        log_critical(&format!("[restartLead] {} (경고만 하고 spawn은 계속 시도합니다)", claude_not_ready_message(&current.target_dir, &reason)));
    }

    // 히스토리 탭에서 이미 오프라인인 팀장을 재시작해도 여기까지 그대로 들어온다 — 지금 실제로
    // 떠있을 때만 stop을 호출한다(main.ts와 동일한 이유, 불필요한 stop 타임아웃 낭비 방지).
    let agents = fetch_agents_typed_async().await;
    let is_currently_live = agents.iter().any(|a| a.id.as_deref() == Some(current.id.as_str()));
    if is_currently_live {
        let _ = stop_session(current.id.clone()).await;
    }

    install_team_lead_skill();
    let (approved_members, approved_text) = approved_member_briefing(&current.target_dir);
    let prompt = format!("/team-lead {instruction}\n\n{approved_text}");

    // 재시작은 완전히 새 세션(--resume이 아님)이라 SECRET_MODE_CLI_ARGS도 이 시점에 다시 실어야
    // 한다(resumeLead와 정반대 요구사항, A-1 참고).
    let flags = FreshLaunchArgs::new().secret(current.secret.unwrap_or(false)).into_flags();
    let Some(new_id) = run_claude_bg(flags, resolve_long_prompt(&prompt), current.target_dir.clone()).await else {
        return RestartLeadOutcome::Failure {
            error: format!(
                "claude --bg가 {}초 안에 새 세션 시작을 확인해주지 못했습니다(타임아웃 또는 \"backgrounded\" 표시를 못 찾음). claude CLI 로그인/설치 상태를 확인해보세요 — 자세한 로그는 앱 콘솔에 남습니다.",
                RUN_CLAUDE_TIMEOUT_MS / 1000
            ),
        };
    };
    let new_session_id = find_session_id_by_short_id_retrying(&new_id).await.unwrap_or_else(|| new_id.clone());

    let new_id_for_lock = new_id.clone();
    let new_session_id_for_lock = new_session_id.clone();
    let approved_members_for_lock = approved_members.clone();
    let old_id = with_leads_lock(move |leads| {
        let Some(rec) = leads.iter_mut().find(|l| l.internal_id.as_deref() == Some(internal_id.as_str())) else {
            return (false, None);
        };
        let old_id = rec.id.clone();
        rec.id = new_id_for_lock;
        rec.session_id = new_session_id_for_lock;
        rec.launched_at = now_ms();
        rec.approved_members = approved_members_for_lock;
        // 재시작은 완전히 새 세션(새 sessionId)이라 예전 대화 주제가 더 이상 안 맞는다 — 안 지우면
        // 히스토리 탭에 재시작 이전 대화의 주제가 그대로 남아 보인다.
        rec.ai_title = None;
        (true, Some(old_id))
    })
    .await;

    // F-1: restartLead가 짧은 id를 항상 새로 발급하면서도 MemberRecord.leadId는 안 건드려서
    // (실측 확인) 그 팀장 소속 팀원들이 재시작 직후부터 전부 leadId 불일치를 겪었다 — endLeadWork가
    // 그 팀원들을 아예 못 찾아 종료가 안 되고, 화면에도 "소속 팀장 없음"으로 잘못 보였다. 짧은 id가
    // 바뀌는 시점(위 with_leads_lock 안)에 old_id를 캡처해두고, 락 밖에서 소속 팀원 전부를 새
    // id로 같이 옮겨쓴다.
    if let Some(old_id) = old_id {
        let members = load_members();
        let target_members: Vec<MemberRecord> = members.into_iter().filter(|m| m.lead_id == old_id).collect();
        for m in migrate_members_lead_id(target_members, &old_id, &new_id) {
            register_member(&m);
        }
        // 오늘 Electron main.ts에서 실사용 재현·수정된 것과 같은 사고(board_state.rs의
        // migrate_last_known_live_lead_row 주석 참고) — restartLead도 resumeLead와 마찬가지로
        // 짧은 id를 바꾸는 자리에서 캐시를 같이 옮겨야 agents 스냅샷이 새 id를 따라잡을 때까지의
        // 틈에 화면에서 이 팀장이 사라지는 걸 막을 수 있다.
        migrate_last_known_live_lead_row(&old_id, &new_id);
    }

    RestartLeadOutcome::Success { id: new_id }
}

/// restart-lead IPC 핸들러(main.ts:2842-2847)의 포팅 — 짧은 id로 팀장을 찾아 internalId로
/// queue_lead_operation에 감싼 뒤 restart_lead를 호출한다(resume_lead_command와 같은 패턴).
#[tauri::command]
pub async fn restart_lead_command(lead_id: String, instruction: String) -> RestartLeadOutcome {
    let leads = load_leads();
    let Some(lead) = leads.into_iter().find(|l| l.id == lead_id) else {
        return RestartLeadOutcome::Failure { error: "팀장을 찾을 수 없습니다 — 이미 종료됐거나 목록이 갱신됐을 수 있습니다.".to_string() };
    };
    let Some(internal_id) = lead.internal_id else {
        return RestartLeadOutcome::Failure { error: "팀장 레코드에 internalId가 없습니다(비정상 상태 — 앱을 재시작해보세요).".to_string() };
    };
    let trimmed = instruction.trim();
    let final_instruction = if trimmed.is_empty() { "지금 상황을 파악하고 다음 작업을 시작해줘.".to_string() } else { trimmed.to_string() };

    let queue_key = internal_id.clone();
    let handle = tokio::spawn(async move { queue_lead_operation(&queue_key, move || restart_lead(internal_id, final_instruction)).await });
    match handle.await {
        Ok(result) => result,
        Err(join_err) => {
            log_critical(&format!("[restartLead] 팀장 {lead_id} 재시작 큐 작업이 panic했습니다(있어서는 안 되는 상황) — {join_err}"));
            RestartLeadOutcome::Failure { error: "재시작 작업이 예기치 않게 실패했습니다 — 앱 로그를 확인하세요.".to_string() }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// endLeadWork(main.ts) — "작업 종료": 팀원을 전부 먼저 끄고, 마지막에 팀장 자신을 끈다.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct EndLeadWorkOutcome {
    pub success: bool,
    #[serde(rename = "memberFailures")]
    pub member_failures: Vec<String>,
}

/// endLeadWork(main.ts)와 동일. 호출부(end_lead_work_command)가 queue_lead_operation으로 감싼다.
pub async fn end_lead_work(internal_id: String) -> EndLeadWorkOutcome {
    let leads = load_leads();
    let Some(lead) = leads.into_iter().find(|l| l.internal_id.as_deref() == Some(internal_id.as_str())) else {
        return EndLeadWorkOutcome { success: false, member_failures: Vec::new() };
    };
    let members: Vec<MemberRecord> = load_members().into_iter().filter(|m| m.lead_id == lead.id).collect();
    let mut member_failures = Vec::new();
    for m in members {
        // 팀원 하나씩 정지하는 이 루프가 도는 동안 reconcileMemberIds(다음 청크)가 이 팀원의
        // 짧은 id를 앱 밖 재시작으로 바꿔놨을 수 있다 — sessionId로 지금 최신 등록 파일을 다시
        // 찾아서 정지한다(main.ts와 동일한 이유).
        let current = match m.session_id.clone() {
            Some(sid) => load_members().into_iter().find(|x| x.session_id.as_deref() == Some(sid.as_str())).unwrap_or(m),
            None => m,
        };
        let stopped = stop_session(current.member_id.clone()).await;
        if !stopped {
            member_failures.push(current.member_id.clone());
        }
        let _ = std::fs::remove_file(members_dir().join(format!("{}.json", current.member_id)));
    }

    // 팀원 정리 루프가 도는 동안 팀장 자신의 짧은 id도 바뀌었을 수 있다 — internalId로 최신
    // 레코드를 다시 찾아서 정지한다(resumeLead/restartLead와 같은 이유).
    let current_lead_id = load_leads().into_iter().find(|l| l.internal_id.as_deref() == Some(internal_id.as_str())).map(|l| l.id).unwrap_or(lead.id);
    let mut lead_stopped = stop_session(current_lead_id.clone()).await;
    if !lead_stopped {
        lead_stopped = stop_session(current_lead_id.clone()).await;
    }
    // computeOfflineLeads(live_rows.rs)는 agents 스냅샷에 한 번 안 잡힌 것만으로 바로 오프라인
    // 확정하지 않고 LEAD_OFFLINE_GRACE_MS(stop→resume 재기동 오판 방지용, 3분 이상)를 기다린다 —
    // 근데 지금은 사용자가 "작업 종료"를 직접 눌러서 확실하게 정지시킨 것이라 재기동 오판 걱정이
    // 없다. main.ts의 endLeadWork(leadFirstMissAt.set(currentLead.id, 0))와 동일하게, 정지가
    // 실제로 성공했으면 lead_first_miss_at을 유예 시간 이전 시각(0)으로 미리 채워서 다음 폴링에서
    // 곧바로 오프라인/히스토리로 넘어가게 한다(실측 UI 테스트에서 이 처리가 빠져 최대 214초 동안
    // 카드가 "온라인"으로 잘못 남아있는 걸 확인해 추가함). 정지 자체가 실패했으면 아직 살아있을 수
    // 있으므로 건드리지 않고 평소 유예 판정을 그대로 둔다.
    if lead_stopped {
        board_state().lock().unwrap().lead_first_miss_at.insert(current_lead_id, 0);
    }
    EndLeadWorkOutcome { success: lead_stopped, member_failures }
}

/// end-lead-work IPC 핸들러(main.ts:2849-2853)의 포팅.
#[tauri::command]
pub async fn end_lead_work_command(lead_id: String) -> EndLeadWorkOutcome {
    let leads = load_leads();
    let Some(lead) = leads.into_iter().find(|l| l.id == lead_id) else {
        return EndLeadWorkOutcome { success: false, member_failures: Vec::new() };
    };
    let Some(internal_id) = lead.internal_id else {
        return EndLeadWorkOutcome { success: false, member_failures: Vec::new() };
    };
    let queue_key = internal_id.clone();
    let handle = tokio::spawn(async move { queue_lead_operation(&queue_key, move || end_lead_work(internal_id)).await });
    match handle.await {
        Ok(result) => result,
        Err(join_err) => {
            log_critical(&format!("[endLeadWork] 팀장 {lead_id} 종료 큐 작업이 panic했습니다(있어서는 안 되는 상황) — {join_err}"));
            EndLeadWorkOutcome { success: false, member_failures: Vec::new() }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// launchTeamLead(main.ts) — 브랜드 뉴 팀장을 새로 띄운다.
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum LaunchTeamLeadOutcome {
    Success { id: String },
    Failure { error: String },
}

/// launchTeamLead(main.ts)와 동일 — readiness 실패는(main.ts와 같은 이유, restart_lead 위 주석
/// 참고) 더 이상 spawn 차단에 쓰지 않고 경고만 남긴 채 그대로 진행한다. spawn 자체가 실패하면
/// 그 판정이 원인일 수 있다는 걸 실패 메시지에 같이 담는다.
pub async fn launch_team_lead(target_dir: String, instruction: String, label: Option<String>, secret: bool) -> LaunchTeamLeadOutcome {
    let readiness = check_directory_claude_ready(&target_dir);
    if !readiness.ready {
        log_critical(&format!("[launchTeamLead] {} (경고만 하고 spawn은 계속 시도합니다)", claude_not_ready_message(&target_dir, readiness.reason.as_deref().unwrap_or(""))));
    }
    install_team_lead_skill();
    let (approved_members, approved_text) = approved_member_briefing(&target_dir);
    let prompt = format!("/team-lead {instruction}\n\n{approved_text}");

    let flags = FreshLaunchArgs::new().secret(secret).into_flags();
    let Some(id) = run_claude_bg(flags, resolve_long_prompt(&prompt), target_dir.clone()).await else {
        if !readiness.ready {
            return LaunchTeamLeadOutcome::Failure {
                error: format!(
                    "팀장 세션 시작에 실패했습니다 — \"{target_dir}\"에서 {} 이게 원인일 수 있습니다. 그 디렉토리에서 터미널로 claude를 한 번 실행해 승인창을 눌러준 뒤 다시 시도해보세요.",
                    readiness.reason.as_deref().unwrap_or("")
                ),
            };
        }
        return LaunchTeamLeadOutcome::Failure {
            error: format!(
                "claude --bg가 {}초 안에 새 세션 시작을 확인해주지 못했습니다(타임아웃 또는 \"backgrounded\" 표시를 못 찾음) — 터미널을 직접 열어 claude --version, claude --bg가 정상 동작하는지 확인해보세요(CLI 미설치·PATH 문제·로그인 만료가 흔한 원인입니다).",
                RUN_CLAUDE_TIMEOUT_MS / 1000
            ),
        };
    };

    let session_id = find_session_id_by_short_id_retrying(&id).await.unwrap_or_else(|| id.clone());
    let trimmed_label = label.map(|l| l.trim().to_string()).filter(|l| !l.is_empty());

    let record = LeadRecord {
        id: id.clone(),
        session_id,
        target_dir,
        launched_at: now_ms(),
        approved_members,
        label: trimmed_label,
        ai_title: None,
        internal_id: Some(uuid::Uuid::new_v4().to_string()),
        auto_stall_nudge: None,
        secret: Some(secret),
    };
    with_leads_lock(move |leads| {
        leads.push(record);
        (true, ())
    })
    .await;

    LaunchTeamLeadOutcome::Success { id }
}

/// launch-team-lead IPC 핸들러(main.ts:2496-2499)의 포팅. 반환 타입이 예전엔 Option<String>이라
/// 성공/실패를 구분할 방법이 프론트에 없었다(실측 UI 테스트에서, 인자 버그를 고쳐도 성공 케이스가
/// result.id 부재로 항상 실패로 보였을 결함) — restart_lead_command/RestartLeadOutcome과 같은
/// {id}|{error} untagged 모양으로 맞춘다.
#[tauri::command]
pub async fn launch_team_lead_command(target_dir: String, instruction: String, label: Option<String>, secret: Option<bool>) -> LaunchTeamLeadOutcome {
    let final_instruction = if instruction.is_empty() { "지금 상황을 파악하고 다음 작업을 시작해줘.".to_string() } else { instruction };
    launch_team_lead(target_dir, final_instruction, label, secret.unwrap_or(false)).await
}

// ---------------------------------------------------------------------------------------------
// adoptLead(main.ts) — 터미널에서 사용자가 직접 띄운 세션을 이 앱에 등록한다.
// ---------------------------------------------------------------------------------------------

/// adoptLead(main.ts)와 동일.
pub async fn adopt_lead(short_id: String) -> Option<String> {
    let agents = fetch_agents_typed_async().await;
    let agent = agents.into_iter().find(|a| a.id.as_deref() == Some(short_id.as_str()) && a.kind == "background")?;
    install_team_lead_skill();
    let (approved_members, _) = approved_member_briefing(&agent.cwd);
    let agent_id = agent.id.clone()?;
    let record = LeadRecord {
        id: agent_id.clone(),
        session_id: agent.session_id,
        target_dir: agent.cwd,
        launched_at: agent.started_at.unwrap_or_else(now_ms),
        approved_members,
        label: None,
        ai_title: None,
        internal_id: Some(uuid::Uuid::new_v4().to_string()),
        auto_stall_nudge: None,
        secret: None,
    };
    with_leads_lock(move |leads| {
        leads.push(record);
        (true, ())
    })
    .await;
    Some(agent_id)
}

/// adopt-lead IPC 핸들러(main.ts:2515)의 포팅.
#[tauri::command]
pub async fn adopt_lead_command(short_id: String) -> Option<String> {
    adopt_lead(short_id).await
}

// ---------------------------------------------------------------------------------------------
// forkSessionAsLead(main.ts) — E-2: 브랜드 뉴 세션 경로가 leads.json에 새 레코드를 push할 때
// run_claude_bg/find_session_id_by_short_id 두 await 동안 다른 팀장의 동시 변경을 덮어쓸 수 있다
// (Node 시뮬레이션으로 재현 확인된 lost update) — with_leads_lock으로 쓰기 직전에 최신 상태를
// 다시 읽어 그 위에 얹는다.
// ---------------------------------------------------------------------------------------------

/// forkSessionAsLead(main.ts)와 동일.
pub async fn fork_session_as_lead(session_id: String, cwd: String) -> Option<String> {
    install_team_lead_skill();
    let leads = load_leads();
    // 이 sessionId가 이미 이 앱이 추적 중인 레코드라면 새 레코드를 또 만들지 말고 resumeLead로
    // 그 레코드를 그대로 이어서 깨운다 — 안 그러면 같은 세션을 가리키는 레코드가 leads.json에
    // 두 개 생겨서 internalId 기반의 큐/알림이 서로 다른 레코드로 갈라진다.
    if let Some(existing) = leads.iter().find(|l| l.session_id == session_id) {
        let internal_id = existing.internal_id.clone()?;
        let message = "지금 이 대화를 Claude Team Monitor로 다시 불러왔습니다. 계속 진행하세요.".to_string();
        let queue_key = internal_id.clone();
        return queue_lead_operation(&queue_key, move || resume_lead(internal_id, message)).await;
    }

    let flags = FreshLaunchArgs::new().resume_session_id(session_id).into_flags();
    let id = run_claude_bg(
        flags,
        "지금 이 대화를 Claude Team Monitor로 가져왔습니다(별도 복사본, 원본 세션과는 별개). 계속 진행하세요.".to_string(),
        cwd.clone(),
    )
    .await?;
    let new_session_id = find_session_id_by_short_id_retrying(&id).await.unwrap_or_else(|| id.clone());
    let (approved_members, _) = approved_member_briefing(&cwd);

    // E-2: 위 두 await(run_claude_bg/find_session_id_by_short_id) 동안 최대 수십 초가 지날 수
    // 있고, 그 사이 다른 팀장을 향한 resume/restart가 leads.json을 저장했을 수 있다 — 맨 위에서
    // 캡처해둔 leads 배열(위 load_leads())을 그대로 쓰면 그 변경을 통째로 덮어쓴다. β가 만든
    // with_leads_lock으로 쓰기 직전에 다시 최신 상태를 읽어 그 위에 얹는다(launch_team_lead/
    // adopt_lead와 같은 패턴) — 절대 load_leads()+직접 push+save_leads_to를 락 없이 짝짓지 않는다.
    let record = LeadRecord {
        id: id.clone(),
        session_id: new_session_id,
        target_dir: cwd,
        launched_at: now_ms(),
        approved_members,
        label: None,
        ai_title: None,
        internal_id: Some(uuid::Uuid::new_v4().to_string()),
        auto_stall_nudge: None,
        secret: None,
    };
    with_leads_lock(move |latest_leads| {
        latest_leads.push(record);
        (true, ())
    })
    .await;

    Some(id)
}

/// fork-session-as-lead IPC 핸들러(main.ts:2519)의 포팅.
#[tauri::command]
pub async fn fork_session_as_lead_command(session_id: String, cwd: String) -> Option<String> {
    fork_session_as_lead(session_id, cwd).await
}

// ---------------------------------------------------------------------------------------------
// launchMember(main.ts) — 사용자가 직접 특정 역할을 주고 팀원을 띄운다.
// ---------------------------------------------------------------------------------------------

pub const TEAM_MEMBER_BRIEFING: &str = "너는 지금 \"팀장\" 세션이 배정한 \"팀원\" 세션이다. 사람이 실시간으로 지켜보며 답해주는 세션이 아니니, 중간에 사용자에게 되묻지 말고 스스로 판단해서 진행해라.\n\n정보가 부족하면 저장소 안에서 직접 조사해서 합리적으로 판단하고, 정말로 진행이 불가능할 때만 왜 막혔는지를 최종 답변에 명확히 남기고 멈춰라(질문만 던지고 끝내지 마라).\n\nAskUserQuestion 같은 화살표 선택형 인터랙티브 도구는 절대 쓰지 마라 — 백그라운드 세션이라 실제 터미널이 안 붙어있어서 그 메뉴에 아무도 응답할 수 없고, 세션이 그대로 영구히 멈춘다(텍스트로 되묻는 것보다 훨씬 심각하게 막힘).\n\n같은 이유로 EnterWorktree/ExitWorktree 도구도 쓰지 마라 — 사전 승인 안 된 경로로 permission root를 옮기려 하면 \"진행할까요? Yes/No\" 확인 프롬프트가 뜨는데 이것도 아무도 응답 못 해서 똑같이 멈춘다(실측 확인). 워크트리가 필요하면 `git worktree add <경로> <브랜치>`를 Bash로 직접 실행하고, 그 경로를 Edit/Write/Bash의 대상 경로로 그냥 지정해서 작업해라 — permission root 자체를 옮기는 도구만 피하면 된다.\n\n작업을 마치면 무엇을 확인했고 결과가 무엇인지 최종 답변에 구조적으로 정리해라 — 그 답변이 팀장에게 전달되는 유일한 보고 내용이다.";

pub const TEAM_MEMBER_STANDBY_NOTE: &str = "아래는 앞으로 맡을 작업에 대한 참고용 사전 지시다 — 이번 턴에서 곧바로 실행하지 마라. 내용을 확인했다는 짧은 준비 완료 응답만 남기고(예: \"확인했습니다. 아래 작업을 맡을 준비가 됐습니다.\"), 실제로 작업을 시작하라는 팀장의 다음 메시지가 올 때까지 기다려라. 팀장이 다시 메시지를 보내기 전까지는 어떤 파일도 고치거나 만들지 마라.";

const MEMBER_MODEL_OPTIONS: [&str; 4] = ["default", "haiku", "sonnet", "opus"];

/// normalizeMemberModel(lib/appSettings.js)과 동일 — 화이트리스트 밖이면 'default'로 취급한다.
fn normalize_member_model(model: Option<&str>) -> &'static str {
    MEMBER_MODEL_OPTIONS.iter().copied().find(|&opt| Some(opt) == model).unwrap_or("default")
}

/// launchMember(main.ts)와 동일. 빈 이름은 별도 에러로 구분해서 돌려준다(렌더러가 CLI 실행
/// 실패와 구분해서 보여줄 수 있게).
pub async fn launch_member(
    lead_id: String,
    target_dir: String,
    instruction: String,
    role: String,
    label: String,
    model: Option<String>,
) -> Result<Option<String>, String> {
    if label.trim().is_empty() {
        return Err("이 팀원을 구분할 이름을 입력해주세요.".to_string());
    }
    let role_line = if role.is_empty() { String::new() } else { format!("역할: {role}\n\n") };
    let prompt = format!("{TEAM_MEMBER_BRIEFING}\n\n{role_line}{TEAM_MEMBER_STANDBY_NOTE}\n\n\"\"\"\n{instruction}\n\"\"\"");
    let normalized_model = normalize_member_model(model.as_deref());
    let mut flags = vec!["--bg".to_string()];
    if normalized_model != "default" {
        flags.push("--model".to_string());
        flags.push(normalized_model.to_string());
    }
    let Some(id) = run_claude_bg(flags, resolve_long_prompt(&prompt), target_dir.clone()).await else {
        return Ok(None);
    };

    // 알림 메시지는 register_member가 role을 소비(move)하기 전에 먼저 조립한다 — main.ts의
    // launchMember(main.ts:2432)와 동일한 문구.
    let role_suffix = if role.is_empty() { String::new() } else { format!(", 역할: {role}") };
    let notice_message = format!(
        "[알림] 사용자가 직접 팀원을 추가했습니다 — 이름: {label}, 디렉토리: {target_dir}{role_suffix}, 사전 지시(참고용): \"{instruction}\", 세션 id: {id}. \
이 팀원은 이미 팀원 공통 브리핑(백그라운드 세션 유의사항)을 전달받은 상태이며, 지금 준비 완료 응답만 남기고 대기 중이니, 필요하면 관리 대상에 추가하고 실제 \
작업을 시작하라는 메시지를 직접 보내라(stop→resume). 완료되면 확인해서 최종 보고에 포함시켜라."
    );

    register_member(&MemberRecord {
        member_id: id.clone(),
        lead_id: lead_id.clone(),
        created_at: now_ms(),
        role: if role.is_empty() { None } else { Some(role) },
        label: Some(label.trim().to_string()),
        session_id: None,
        secret: None,
    });

    // 팀장이 스스로 띄운 게 아니라서 알려주지 않으면 이 팀원의 존재도 결과도 영원히 모른다 — 다만
    // 팀장이 지금 다른 작업으로 busy일 수 있어서 즉시 stop→resume으로 끼어들지 않고 큐에 쌓아둔다
    // (δ의 deliverPendingNotices가 폴링마다 이 큐를 보고, 팀장이 idle/blocked가 됐을 때만 실제로
    // 전달한다). queueLeadNotice는 internalId를 받으므로, IPC로 넘어온 짧은 id(leadId)를 여기서
    // 변환한다.
    if let Some(lead_rec) = load_leads().into_iter().find(|l| l.id == lead_id) {
        if let Some(internal_id) = lead_rec.internal_id {
            crate::notice_queue::queue_lead_notice(&internal_id, &notice_message, crate::notice_queue::NoticeOrigin::System).await;
        } else {
            eprintln!("[launch_member] 팀장 {lead_id} 레코드에 internalId가 없어 알림을 큐잉하지 못했습니다.");
        }
    } else {
        eprintln!("[launch_member] 팀원 {id}을 등록했지만 소속 팀장({lead_id}) 레코드를 찾지 못해 알림 대상도 특정할 수 없습니다.");
    }

    Ok(Some(id))
}

/// launch-member IPC 핸들러(main.ts:2564 근방)의 포팅.
#[tauri::command]
pub async fn launch_member_command(
    lead_id: String,
    target_dir: String,
    instruction: String,
    role: String,
    label: String,
    model: Option<String>,
) -> Result<Option<String>, String> {
    launch_member(lead_id, target_dir, instruction, role, label, model).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_registry::{load_leads_from, load_members_from, register_member_in, save_leads_to, with_leads_lock_at};
    use tokio::sync::Mutex as AsyncMutex;

    // ------------------------------------------------------------------------------------
    // FreshLaunchArgs — A-1 타입 분리 검증. resume 경로(β)와 절대 못 섞이게 만든 게 목적이므로,
    // 이 타입이 만든 flags가 항상 신규 실행에 필요한 인자를 갖추는지만 확인한다(resume.rs 쪽
    // 인자 조립은 이 파일 범위가 아니다).
    // ------------------------------------------------------------------------------------

    #[test]
    fn fresh_launch_args_always_include_bg_and_member_spawn_mcp_config() {
        let flags = FreshLaunchArgs::new().into_flags();
        assert_eq!(flags[0], "--bg");
        assert!(flags.contains(&"--mcp-config".to_string()));
        assert!(flags.contains(&"--allowedTools".to_string()));
        assert!(!flags.contains(&"--resume".to_string()), "resume_session_id를 안 붙였으면 --resume이 없어야 한다");
    }

    #[test]
    fn fresh_launch_args_allows_both_spawn_and_register_tools() {
        let flags = FreshLaunchArgs::new().into_flags();
        let pos = flags.iter().position(|f| f == "--allowedTools").expect("--allowedTools가 있어야 한다");
        let tools = &flags[pos + 1];
        assert!(tools.contains("mcp__team-monitor__spawn_team_member"));
        assert!(tools.contains("mcp__team-monitor__register_as_lead"));
    }

    #[test]
    fn fresh_launch_args_secret_appends_secret_mode_flags() {
        let flags = FreshLaunchArgs::new().secret(true).into_flags();
        assert!(flags.windows(2).any(|w| w == ["--setting-sources", "project,local"]), "flags={flags:?}");
    }

    #[test]
    fn fresh_launch_args_without_secret_has_no_secret_mode_flags() {
        let flags = FreshLaunchArgs::new().secret(false).into_flags();
        assert!(!flags.contains(&"--setting-sources".to_string()));
    }

    #[test]
    fn fresh_launch_args_resume_session_id_appends_resume_flag_pair_at_the_end() {
        let flags = FreshLaunchArgs::new().resume_session_id("session-xyz").into_flags();
        let pos = flags.iter().position(|f| f == "--resume").expect("--resume 플래그가 있어야 한다");
        assert_eq!(flags[pos + 1], "session-xyz");
    }

    // ------------------------------------------------------------------------------------
    // approved_member_briefing의 순수 조립부(build_member_briefing) — main.ts의 분기(사전승인
    // 있음/없음, 역할 없는 템플릿 있음/없음, scope 필터링) 그대로 검증.
    // ------------------------------------------------------------------------------------

    fn template(scope: &str, path: Option<&str>, name: &str, role: &str, instruction: &str, approved: bool) -> MemberTemplate {
        MemberTemplate {
            scope: scope.to_string(),
            path: path.map(str::to_string),
            name: name.to_string(),
            role: role.to_string(),
            instruction: instruction.to_string(),
            approved,
        }
    }

    #[test]
    fn briefing_defaults_to_no_approved_dir_message_when_nothing_matches() {
        let (paths, text) = build_member_briefing(&[], "C:\\proj");
        assert!(paths.is_empty());
        assert!(text.contains("사전 승인된 팀원 디렉토리가 없음"));
    }

    #[test]
    fn briefing_includes_approved_path_with_role_and_instruction() {
        let templates = vec![template("shared", Some("C:\\proj\\api"), "n", "reviewer", "리뷰해줘", true)];
        let (paths, text) = build_member_briefing(&templates, "C:\\proj");
        assert_eq!(paths, vec!["C:\\proj\\api".to_string()]);
        assert!(text.contains("C:\\proj\\api"));
        assert!(text.contains("역할: reviewer"));
        assert!(text.contains("추천 지시: \"리뷰해줘\""));
    }

    #[test]
    fn briefing_excludes_templates_scoped_to_a_different_lead_directory() {
        let templates = vec![template("C:\\other-project", Some("C:\\x"), "n", "", "", true)];
        let (paths, text) = build_member_briefing(&templates, "C:\\proj");
        assert!(paths.is_empty());
        assert!(text.contains("사전 승인된 팀원 디렉토리가 없음"));
    }

    #[test]
    fn briefing_lists_pathless_templates_with_default_role_label_when_role_missing() {
        let templates = vec![template("shared", None, "코드리뷰어", "", "", false)];
        let (_paths, text) = build_member_briefing(&templates, "C:\\proj");
        assert!(text.contains("코드리뷰어(역할: 미지정)"));
    }

    #[test]
    fn briefing_only_counts_approved_templates_with_a_path_toward_the_approved_list() {
        // approved=false면 path가 있어도 "사전 승인" 목록엔 안 들어가고, path가 없으면 template.name
        // 목록(역할 안내)에 들어간다 — main.ts의 두 필터(approvedWithPath/withoutPath)가 서로
        // 배타적이지 않다는 점(둘 다 아닌 "미승인+path있음" 템플릿은 어느 쪽에도 안 뜬다)까지 확인.
        let templates = vec![template("shared", Some("C:\\unapproved"), "n", "", "", false)];
        let (paths, text) = build_member_briefing(&templates, "C:\\proj");
        assert!(paths.is_empty());
        assert!(!text.contains("C:\\unapproved"));
        assert!(text.contains("사전 승인된 팀원 디렉토리가 없음"));
    }

    // ------------------------------------------------------------------------------------
    // normalize_member_model
    // ------------------------------------------------------------------------------------

    #[test]
    fn normalize_member_model_falls_back_to_default_for_unknown_values() {
        assert_eq!(normalize_member_model(Some("gpt-5")), "default");
        assert_eq!(normalize_member_model(None), "default");
        assert_eq!(normalize_member_model(Some("opus")), "opus");
    }

    // ------------------------------------------------------------------------------------
    // F-1: migrate_members_lead_id 순수 함수 + 실제 등록 파일 왕복.
    // ------------------------------------------------------------------------------------

    fn member(member_id: &str, lead_id: &str) -> MemberRecord {
        MemberRecord {
            member_id: member_id.to_string(),
            lead_id: lead_id.to_string(),
            created_at: 1_000,
            role: None,
            label: None,
            session_id: None,
            secret: None,
        }
    }

    #[test]
    fn migrate_members_lead_id_only_updates_members_of_the_restarted_lead() {
        let members = vec![member("m1", "old-lead"), member("m2", "old-lead"), member("m3", "other-lead")];
        let migrated = migrate_members_lead_id(members, "old-lead", "new-lead");
        assert_eq!(migrated.iter().find(|m| m.member_id == "m1").unwrap().lead_id, "new-lead");
        assert_eq!(migrated.iter().find(|m| m.member_id == "m2").unwrap().lead_id, "new-lead");
        assert_eq!(migrated.iter().find(|m| m.member_id == "m3").unwrap().lead_id, "other-lead");
    }

    // F-1 실제 파일 왕복 검증 — register_member_in/load_members_from을 프로덕션 members_dir()
    // (지금 이 저장소를 작업 중인 실제 팀장/팀원의 등록 파일이 있는 곳)이 아니라 전용 임시
    // 디렉토리에 대해 그대로 돌려서, restart_lead가 실제로 쓰는 것과 같은 I/O 경로(등록 파일
    // 덮어쓰기)가 "소속 팀원 전부를 새 id로 옮겨쓴다"는 불변식을 실제로 지키는지 확인한다.
    #[test]
    fn restart_lead_member_migration_round_trips_through_real_registration_files() {
        let dir = std::env::temp_dir().join(format!("claude_team_monitor_test_members_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp members dir 생성 실패");

        register_member_in(&dir, &member("m1", "old-lead"));
        register_member_in(&dir, &member("m2", "old-lead"));
        register_member_in(&dir, &member("m3", "other-lead"));

        let target_members: Vec<MemberRecord> = load_members_from(&dir).into_iter().filter(|m| m.lead_id == "old-lead").collect();
        for m in migrate_members_lead_id(target_members, "old-lead", "new-lead") {
            register_member_in(&dir, &m);
        }

        let after = load_members_from(&dir);
        assert_eq!(after.iter().find(|m| m.member_id == "m1").unwrap().lead_id, "new-lead");
        assert_eq!(after.iter().find(|m| m.member_id == "m2").unwrap().lead_id, "new-lead");
        assert_eq!(after.iter().find(|m| m.member_id == "m3").unwrap().lead_id, "other-lead", "다른 팀장 소속 팀원은 그대로여야 한다");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------------------------------
    // E-2: forkSessionAsLead의 "새 레코드 push"가 with_leads_lock 없이는 lost update를 일으킨다는
    // 사실은 이미 session_registry.rs가 일반적으로(같은 파일에 대한 두 개의 read-modify-write가
    // 겹치면) 증명했다(leads_json_lost_update_is_reproducible_without_the_lock/
    // with_leads_lock_prevents_lost_update_under_concurrent_writes_to_different_leads). 여기서는
    // fork_session_as_lead가 실제로 만드는 모양(기존 레코드를 고치는 게 아니라 완전히 새 레코드를
    // push하는 것)이 그 일반 증명과 같은 보호를 받는지, β와 같은 가상 시계 기반 결정적 재현
    // 패턴으로 다시 확인한다(β 리뷰가 요구한 "Node 시뮬레이션 검증과 같은 정신").
    // ------------------------------------------------------------------------------------

    fn fake_lead(internal_id: &str, id: &str, session_id: &str) -> LeadRecord {
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
        }
    }

    #[tokio::test(start_paused = true)]
    async fn fork_session_as_lead_new_record_push_does_not_lose_a_concurrent_leads_json_write() {
        let path = std::env::temp_dir().join(format!("claude_team_monitor_test_leads_fork_{}", uuid::Uuid::new_v4()));
        let lock = AsyncMutex::new(());
        let initial = vec![fake_lead("race-existing", "lead-existing", "session-existing")];
        save_leads_to(&path, &initial);

        let path_fork = path.clone();
        let lock_ref = &lock;
        let fork_task = async {
            // fork_session_as_lead의 run_claude_bg/find_session_id_by_short_id 두 await에 해당하는
            // "느린" 구간(가상 30ms) 뒤에 완전히 새 레코드를 push한다 — 실제 함수와 같은 모양.
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            with_leads_lock_at(&path_fork, lock_ref, |leads| {
                leads.push(fake_lead("race-forked", "lead-forked", "session-forked"));
                (true, ())
            })
            .await;
        };

        let path_other = path.clone();
        let other_task = async {
            // 그 사이(가상 5ms) 다른 팀장(resume 등)의 leads.json 갱신이 먼저 끼어든다.
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            with_leads_lock_at(&path_other, lock_ref, |leads| {
                for l in leads.iter_mut() {
                    if l.internal_id.as_deref() == Some("race-existing") {
                        l.session_id = "session-existing-resumed".to_string();
                    }
                }
                (true, ())
            })
            .await;
        };

        tokio::join!(fork_task, other_task);

        let final_leads = load_leads_from(&path);
        let _ = std::fs::remove_file(&path);

        assert!(
            final_leads.iter().any(|l| l.internal_id.as_deref() == Some("race-forked")),
            "새로 fork된 레코드가 유실되면 안 된다: {final_leads:?}"
        );
        assert_eq!(
            final_leads.iter().find(|l| l.internal_id.as_deref() == Some("race-existing")).map(|l| l.session_id.as_str()),
            Some("session-existing-resumed"),
            "동시에 일어난 다른 팀장의 갱신도 유실되면 안 된다(E-2): {final_leads:?}"
        );
    }

    // ------------------------------------------------------------------------------------
    // 팀원 공통 브리핑 문구 — src/lib/teamMemberBriefing.js와 내용이 갈라지면(둘 중 하나만
    // 고치는 실수) 이 앱이 직접 띄우는 팀원과 spawn_team_member MCP 툴이 띄우는 팀원이 서로 다른
    // 안내를 받게 된다. tests/skillBriefingSync.test.js는 TS 쪽 두 파일의 import 동일성만
    // 검증하므로, 이 Rust 사본까지는 커버하지 않는다 — 완전한 자동 동기화 검증(파일 내용을 서로
    // 읽어 비교)은 이번 청크 범위 밖이라, 최소한 핵심 문구가 살아있는지만 스모크 테스트한다(리뷰어가
    // 이 갭을 인지하도록 명시).
    // ------------------------------------------------------------------------------------

    #[test]
    fn team_member_briefing_smoke_check_contains_key_phrases() {
        assert!(TEAM_MEMBER_BRIEFING.contains("AskUserQuestion"));
        assert!(TEAM_MEMBER_BRIEFING.contains("EnterWorktree/ExitWorktree"));
        assert!(TEAM_MEMBER_STANDBY_NOTE.contains("확인했습니다"));
    }
}
