use crate::agents_json::{fetch_agents_typed, AgentEntry};
use crate::board_state::{prune_missing_keys, state, track_first_miss, FirstMissResult};
use crate::claude_readiness::check_directory_claude_ready;
use crate::member_requests::{load_pending_requests, MemberRequest};
use crate::paths::{daily_journal_dir, projects_dir, session_edits_dir};
use crate::session_registry::{load_leads, load_members, LeadRecord, MemberRecord};
use crate::stall_watchdog::{list_stall_alerts_for_ui, StallAlertForUi};
use crate::timing::{now_ms, LEAD_OFFLINE_GRACE_MS};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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

// pub(crate)로 열어 stall_watchdog.rs의 getTranscript 포팅(daily-journal 기반, 원본 세션 파일
// 병합은 이번 포팅 범위 밖)이 이 파싱 로직을 그대로 재사용하게 한다.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct JournalEntry {
    #[serde(rename = "sessionId", default)]
    pub(crate) session_id: String,
    #[serde(default)]
    pub(crate) time: String,
    #[serde(default)]
    pub(crate) prompt: String,
    #[serde(default)]
    pub(crate) answer: String,
    #[serde(default)]
    pub(crate) summary: Option<String>,
}

// readJournalEntries(main.ts)와 동일 — 팀장을 하루 넘겨 이어가는 경우가 있어서 daily-journal에
// 쌓인 모든 날짜(오래된 순)를 훑어서 합친다.
pub(crate) fn read_journal_entries(project_name: &str) -> Vec<JournalEntry> {
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
// pub(crate): stall_watchdog.rs가 팀장의 projectName을 알아내는 데도 그대로 재사용한다.
pub(crate) fn resolve_project_name(session_id: &str, cwd: &str) -> String {
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

fn compute_live_rows(agents: &[AgentEntry], lead_by_id: &HashMap<String, &LeadRecord>, member_by_id: &HashMap<String, &MemberRecord>) -> Vec<SessionRow> {
    agents
        .iter()
        .filter_map(|agent| {
            let id = agent.id.clone()?;
            let lead = lead_by_id.get(&id).copied();
            let member = if lead.is_some() { None } else { member_by_id.get(&id).copied() };
            if lead.is_none() && member.is_none() {
                return None;
            }
            Some(build_row(agent.clone(), lead, member))
        })
        .collect()
}

// encodeProjectDirName(main.ts)와 동일 — 영문/숫자가 아닌 문자를 전부 '-'로 바꿔 cwd를 디렉토리
// 이름으로 쓸 수 있게 한다(claude CLI 자신이 ~/.claude/projects 밑에 쓰는 것과 같은 인코딩).
// pub(crate): transcript.rs의 readRawSessionTranscript 포팅이 원본 세션 파일 경로를 찾는 데 그대로
// 재사용한다.
pub(crate) fn encode_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

// getSessionAiTitle(main.ts)와 동일 — claude CLI가 세션 트랜스크립트(jsonl)에 자동 생성해 남기는
// 세션 주제("ai-title" 레코드)를 찾는다. leads.json 캐싱 백필은 이번 포팅 범위 밖이라(읽기 전용)
// 매번 다시 찾지만, jsonl 한 번 훑는 정도라 비용은 낮다.
fn get_session_ai_title(session_id: &str, cwd: &str) -> Option<String> {
    let file = projects_dir().join(encode_project_dir_name(cwd)).join(format!("{session_id}.jsonl"));
    let content = fs::read_to_string(&file).ok()?;
    let mut title = None;
    for line in content.lines() {
        if !line.contains("\"type\":\"ai-title\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    if !t.is_empty() {
                        title = Some(t.to_string());
                    }
                }
            }
        }
        // 손상된 줄은 원본과 동일하게 건너뛴다.
    }
    title
}

// hasLiveMember(lib/leadPresence.js)와 동일 — 팀장 자신은 안 떠있어도 그 팀장이 등록한 팀원 중
// 하나라도 살아있으면 "이 팀장의 일이 아직 끝나지 않았다"고 본다. pub(crate): lead_admin.rs의
// deleteLeadHistory 포팅이 "살아있는 팀장(또는 그 소속 팀원)"을 판정하는 데 그대로 재사용한다.
pub(crate) fn has_live_member(lead_id: &str, members: &[MemberRecord], agent_ids: &HashSet<String>) -> bool {
    members.iter().any(|m| m.lead_id == lead_id && agent_ids.contains(&m.member_id))
}

// buildLeadRecordRow(main.ts)의 포팅 — buildOfflineRows/buildGraceRows(캐시 없는 경우)가 공유하는
// 팀장 카드 생성 로직. agents --json에는 이제 안 잡히는 팀장이라 AgentEntry를 leads.json 값으로
// 직접 구성한다(pid/status/state/waitingFor은 알 길이 없어 전부 없음).
fn build_lead_record_row(lead: &LeadRecord, offline: bool) -> SessionRow {
    let project_name = resolve_project_name(&lead.session_id, &lead.target_dir);
    let name = lead.ai_title.clone().or_else(|| get_session_ai_title(&lead.session_id, &lead.target_dir));
    let preview = get_latest_preview(&project_name, &lead.session_id);
    SessionRow {
        agent: AgentEntry {
            id: Some(lead.id.clone()),
            pid: None,
            cwd: lead.target_dir.clone(),
            kind: "background".to_string(),
            started_at: Some(lead.launched_at),
            session_id: lead.session_id.clone(),
            name,
            status: None,
            state: None,
            waiting_for: None,
        },
        project_name,
        preview,
        is_lead: true,
        lead_id: None,
        role: None,
        label: lead.label.clone(),
        offline,
        internal_id: lead.internal_id.clone(),
        auto_stall_nudge: lead.auto_stall_nudge,
        secret: lead.secret,
    }
}

// computeOfflineLeads(main.ts)의 포팅 — agents 스냅샷에서 사라진(팀원도 안 살아있는) 팀장을
// leadFirstMissAt 기준으로 유예시킨다. 유예가 끝나야만(expired) "오프라인 확정" 목록에 들어간다.
fn compute_offline_leads(leads: &[LeadRecord], agent_ids: &HashSet<String>, now: i64, grace_ms: i64, members: &[MemberRecord]) -> Vec<LeadRecord> {
    let mut offline = Vec::new();
    {
        let mut guard = state().lock().unwrap();
        for lead in leads {
            let is_present = agent_ids.contains(&lead.id) || has_live_member(&lead.id, members, agent_ids);
            let result = track_first_miss(&mut guard.lead_first_miss_at, is_present, &lead.id, now, grace_ms);
            if result == FirstMissResult::Expired {
                offline.push(lead.clone());
            }
        }
        let current_ids: HashSet<String> = leads.iter().map(|l| l.id.clone()).collect();
        prune_missing_keys(&mut guard.lead_first_miss_at, &current_ids);
    }
    offline
}

// buildGraceRows(main.ts)의 포팅 — 이번엔 agents 스냅샷에 안 잡혔지만(그레이스 구간, 아직
// 오프라인 확정도 아닌) 팀장들을 lastKnownLiveLeadRow 캐시로(없으면 팀원이라도 살아있는지 확인해
// leads.json 데이터로 새로) 카드를 만들어 "그대로 있는 것처럼" 보여준다.
fn build_grace_rows(leads: &[LeadRecord], agent_ids: &HashSet<String>, offline_leads: &[LeadRecord], members: &[MemberRecord]) -> Vec<SessionRow> {
    let offline_ids: HashSet<String> = offline_leads.iter().map(|l| l.id.clone()).collect();
    let guard = state().lock().unwrap();
    let mut rows = Vec::new();
    for lead in leads {
        if agent_ids.contains(&lead.id) || offline_ids.contains(&lead.id) {
            continue;
        }
        if let Some(cached) = guard.last_known_live_lead_row.get(&lead.id) {
            rows.push(cached.clone());
            continue;
        }
        if !has_live_member(&lead.id, members, agent_ids) {
            continue;
        }
        rows.push(build_lead_record_row(lead, false));
    }
    rows
}

// buildOfflineRows(main.ts)의 포팅 — 오프라인 확정된 팀장을 offline:true 카드로 만든다(히스토리
// 탭용). aiTitle 캐싱 백필(leadsDirty→saveLeads)은 이번 포팅 범위 밖이라 하지 않는다.
fn build_offline_rows(offline_leads: &[LeadRecord]) -> Vec<SessionRow> {
    offline_leads.iter().map(|l| build_lead_record_row(l, true)).collect()
}

/// computeLiveRows + computeOfflineLeads/buildGraceRows/buildOfflineRows(main.ts)의 포팅 —
/// "작업" 탭 보드가 그리는 SessionRow 전체 목록. leads.json/members에 등록된(=팀장이거나
/// 팀원인) 세션만 대상으로 하고, 그 외(미등록 세션, interactive 세션)는 보드에 아예 안
/// 보여준다(main.ts와 동일한 정책).
///
/// - 지금 살아있는 팀장/팀원 → 라이브 rows(offline:false)
/// - agents 스냅샷에서 막 사라진(그레이스 구간) 팀장 → 캐시나 팀원 생존 여부로 그대로 온라인처럼
///   보여줌(offline:false)
/// - 유예(LEAD_OFFLINE_GRACE_MS)가 끝난 팀장 → 오프라인 확정(offline:true, 히스토리 탭용)
///
/// 정체 감시(runStallWatchdog), 알림 큐(notifyLeadsOfFinishedMembers/deliverPendingNotices),
/// 팀원 쪽 그레이스 만료 시 등록 파일 삭제(cleanupStaleMembers), 팀원/팀장 짧은 id 드리프트 보정
/// (reconcileLeadIds/reconcileMemberIds)은 이번 포팅 범위 밖이다 — 전부 다음 청크로 남겨뒀다.
///
/// buildSessionRowsChain(main.ts:1535-1540)의 포팅 — 이 커맨드는 진입 시 전역
/// `concurrency::session_rows_lock()`을 잡아, 3초 정기 폴링과 refresh-board류 즉시 호출이 겹쳐도
/// "완료 순서가 항상 시작 순서와 같다"는 Node 원본의 성질을 그대로 재현한다(§3-3 트레이드오프 결정은
/// concurrency.rs의 session_rows_lock 문서 참고 — 지연 특성까지 그대로 유지하기로 함). 실제 로직은
/// get_live_session_rows_inner에 그대로 두고, 이 async 래퍼만 새로 추가했다(순수 로직 함수는 동기
/// 유닛 테스트에서 계속 락 없이 직접 호출한다).
#[tauri::command]
pub async fn get_live_session_rows() -> Vec<SessionRow> {
    let _guard = crate::concurrency::session_rows_lock().lock().await;
    get_live_session_rows_inner()
}

fn get_live_session_rows_inner() -> Vec<SessionRow> {
    let now = now_ms();
    let agents = fetch_agents_typed();
    let agent_id_set: HashSet<String> = agents.iter().filter_map(|a| a.id.clone()).collect();

    let leads = load_leads();
    let lead_by_id: HashMap<String, &LeadRecord> = leads.iter().map(|l| (l.id.clone(), l)).collect();
    let members = load_members();
    let member_by_id: HashMap<String, &MemberRecord> = members.iter().map(|m| (m.member_id.clone(), m)).collect();

    let live_rows = compute_live_rows(&agents, &lead_by_id, &member_by_id);

    // liveRows.filter(isLead).forEach(...)와 동일 — 다음 폴링에서 이 팀장이 그레이스 구간에
    // 들어가면 이 스냅숏을 그대로 재사용한다.
    {
        let mut guard = state().lock().unwrap();
        for row in live_rows.iter().filter(|r| r.is_lead) {
            if let Some(id) = &row.agent.id {
                guard.last_known_live_lead_row.insert(id.clone(), row.clone());
            }
        }
    }

    // notifyLeadsOfFinishedMembers/deliverPendingNotices(main.ts:1498-1499, 서브청크 δ) — 팀원
    // 완료 알림 큐잉과 대기열 배달 시도. deliverPendingNotices의 실제 배달(resumeLead)은 최악의
    // 경우 STOP_AND_RELAUNCH_WORST_CASE_MS(~199초)까지 걸릴 수 있어 이 함수(3초 폴링마다 불림)의
    // 반환을 막으면 안 된다(main.ts도 이 두 호출을 await하지 않는다) — 둘 다 I/O 바운드 async
    // 작업(tokio::sync::Mutex 큐 락, claude 프로세스 spawn)이라 tokio::spawn으로 fire-and-forget
    // 한다(아래 stall watchdog은 CPU/blocking 성격이 강한 Haiku 서브프로세스 호출이라 반대로
    // std::thread를 쓴다).
    //
    // #[cfg(not(test))]: 바로 아래 테스트(builds_rows_for_this_running_lead_and_member)가 이
    // 함수를 실제 프로덕션 leads.json/board_state로 호출한다 — 이 저장소 자신이 지금 실제 팀장
    // (1d285d20)/팀원(846ee1cb, 이 세션) 세션으로 운영 중이라, cargo test 중에 이 경로가 실제로
    // queue_lead_notice/resume_lead까지 타면 살아있는 실제 세션에 알림을 찔러 넣거나 stop→resume을
    // 걸어버릴 위험이 있다(resume.rs 테스트 주석이 같은 이유로 실제 claude 프로세스 통합 테스트를
    // 의도적으로 뺀 것과 동일한 판단). 그래서 테스트 빌드에서는 이 두 fire-and-forget 호출 자체를
    // 아예 컴파일하지 않는다 — notice_queue.rs 자신의 단위/통합 테스트는 전부 임시 파일 경로
    // (temp_pending_notices_path)로 격리돼 있어 이 가드와 무관하게 안전하게 실행된다.
    #[cfg(not(test))]
    {
        let live_rows_for_notify = live_rows.clone();
        let leads_for_notify = leads.clone();
        tokio::spawn(async move {
            crate::notice_queue::notify_leads_of_finished_members(&live_rows_for_notify, &leads_for_notify).await;
        });
    }
    #[cfg(not(test))]
    {
        let agents_for_deliver = agents.clone();
        let leads_for_deliver = leads.clone();
        tokio::spawn(async move {
            crate::notice_queue::deliver_pending_notices(&agents_for_deliver, &leads_for_deliver).await;
        });
    }

    // runStallWatchdog(main.ts)와 동일하게 fire-and-forget으로 건다 — Haiku 호출이 몇 초~몇십 초
    // 걸릴 수 있어서 이 함수(3초 폴링마다 불림)의 반환을 막으면 안 된다. 내부적으로 원자적
    // in-flight 플래그로 중복 실행만 막는다(stall_watchdog.rs 참고).
    crate::stall_watchdog::spawn_stall_watchdog_if_idle(live_rows.clone(), leads.clone(), members.clone());

    // hasCompletedFirstPoll 게이트 — 앱을 막 시작한 첫 폴링에는 "재기동 중일 수도 있다"고 봐줄
    // 근거가 없으므로 grace_ms=0을 줘서 이미 죽어있던 팀장이 바로 다음 폴링에 오프라인으로
    // 확정되게 한다(main.ts 주석 참고 — 안 그러면 앱을 껐다 켰을 때 이미 죽어있던 팀장이 유예가
    // 끝날 때까지 작업 탭에도 히스토리 탭에도 안 보이는 공백이 생긴다).
    let grace_ms = {
        let mut guard = state().lock().unwrap();
        let ms = if guard.has_completed_first_poll { LEAD_OFFLINE_GRACE_MS } else { 0 };
        guard.has_completed_first_poll = true;
        ms
    };

    let offline_leads = compute_offline_leads(&leads, &agent_id_set, now, grace_ms, &members);
    let offline_rows = build_offline_rows(&offline_leads);
    let grace_rows = build_grace_rows(&leads, &agent_id_set, &offline_leads, &members);

    {
        let mut guard = state().lock().unwrap();
        let lead_current_ids: HashSet<String> = leads.iter().map(|l| l.id.clone()).collect();
        prune_missing_keys(&mut guard.last_known_live_lead_row, &lead_current_ids);
    }

    let mut rows = live_rows;
    rows.extend(grace_rows);
    rows.extend(offline_rows);
    rows
}

#[derive(Debug, Clone, Serialize)]
pub struct UnapprovedDir {
    pub dir: String,
    pub reason: String,
}

// computeUnapprovedDirs(main.ts:1463-1475) — 이 앱이 실제로 claude --bg를 새로 스폰할 수 있는
// 디렉토리(팀장 자신의 targetDir + 사전승인된 팀원 디렉토리)만 모아서, claude 최초 실행 승인
// (checkDirectoryClaudeReady)이 안 된 곳을 화면에 알림으로 띄우는 데 쓴다. main.ts의 Set과 동일하게
// 삽입 순서를 보존한 채 중복을 제거한다(순서가 결과에 영향을 주진 않지만 원본 동작을 그대로 옮긴다).
fn compute_unapproved_dirs(leads: &[LeadRecord]) -> Vec<UnapprovedDir> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut dirs: Vec<String> = Vec::new();
    for lead in leads {
        if seen.insert(lead.target_dir.clone()) {
            dirs.push(lead.target_dir.clone());
        }
        for d in &lead.approved_members {
            if seen.insert(d.clone()) {
                dirs.push(d.clone());
            }
        }
    }
    dirs.into_iter()
        .filter_map(|dir| {
            let readiness = check_directory_claude_ready(&dir);
            if readiness.ready {
                None
            } else {
                Some(UnapprovedDir { reason: readiness.reason.unwrap_or_default(), dir })
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct RefreshBoardResult {
    pub rows: Vec<SessionRow>,
    pub requests: Vec<MemberRequest>,
    #[serde(rename = "unapprovedDirs")]
    pub unapproved_dirs: Vec<UnapprovedDir>,
    #[serde(rename = "stallAlerts")]
    pub stall_alerts: Vec<StallAlertForUi>,
}

/// refresh-board(main.ts:2513, `{...(await buildSessionRows()), stallAlerts: listStallAlertsForUi()}`)
/// 상당 — 작업 탭 카드에서 "새로고침"/"삭제"를 눌렀을 때 3초 폴링을 기다리지 않고 바로 최신 보드를
/// 준다. rows는 get_live_session_rows_inner를 그대로 재사용하고 session_rows_lock으로 감싸(3초
/// 폴링·다른 refresh-board 호출과 겹쳐도 완료 순서가 시작 순서와 같게 유지, get_live_session_rows
/// 커맨드와 동일한 이유) requests/unapprovedDirs/stallAlerts까지 채워서 main.ts와 동일한 필드
/// 전체를 반환한다.
#[tauri::command]
pub async fn refresh_board_command() -> RefreshBoardResult {
    let _guard = crate::concurrency::session_rows_lock().lock().await;
    let rows = get_live_session_rows_inner();
    let leads = load_leads();
    RefreshBoardResult {
        rows,
        requests: load_pending_requests(),
        unapproved_dirs: compute_unapproved_dirs(&leads),
        stall_alerts: list_stall_alerts_for_ui(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // get_live_session_rows(비동기 tauri 커맨드)가 session_rows_lock을 실제로 잡고
    // get_live_session_rows_inner에 위임하는지 — 두 번 연달아(직렬로) 호출해도 정상적으로 매번
    // 반환되는지 확인한다(락을 잡은 채로 반환을 깜빡해 다음 호출이 영구히 멈추는 회귀를 잡는다).
    #[tokio::test]
    async fn async_command_wrapper_delegates_through_the_global_lock() {
        let first = get_live_session_rows().await;
        let second = get_live_session_rows().await;
        assert_eq!(first.len(), second.len(), "연속 호출 모두 정상적으로 반환돼야 한다(락이 안 풀리는 회귀 방지)");
    }

    // session_registry.rs의 tags_this_running_session_as_member와 같은 전제 — 실제 등록 상태
    // 기준으로 검증한다(1d285d20=팀장, 846ee1cb=바로 이 세션인 팀원).
    #[test]
    fn builds_rows_for_this_running_lead_and_member() {
        let rows = get_live_session_rows_inner();
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

    fn fake_lead(id: &str) -> LeadRecord {
        LeadRecord {
            id: id.to_string(),
            session_id: format!("{id}-session"),
            target_dir: "C:\\fake\\does-not-exist".to_string(),
            launched_at: 1_000,
            approved_members: Vec::new(),
            label: Some("가짜 팀장".to_string()),
            ai_title: None,
            internal_id: Some("fake-internal-id".to_string()),
            auto_stall_nudge: None,
            secret: None,
            mcp_token: None,
        }
    }

    // 실제 세션/파일을 전혀 건드리지 않는 순수 값으로 오프라인/그레이스 전이를 검증한다 — 진짜
    // 팀장을 죽여서 테스트할 수는 없으므로(그 팀장이 지금 이 작업을 시키고 있는 세션 자신이다),
    // agents 스냅샷에 절대 나타나지 않을 가짜 id를 써서 "죽은 세션"을 흉내낸다. 전역 상태(state())를
    // 건드리므로 이 테스트만 쓰는 고유 id를 써서 다른 테스트와 안 겹치게 한다.
    #[test]
    fn offline_grace_transition_with_synthetic_lead() {
        let lead_id = "test-fake-lead-offline-grace-xyz";
        let lead = fake_lead(lead_id);
        let leads = vec![lead.clone()];
        let agent_ids: HashSet<String> = HashSet::new(); // 이 팀장은 agents 스냅샷에 아예 없음
        let members: Vec<MemberRecord> = Vec::new(); // 대신 살아있는 팀원도 없음

        // 정리: 이 테스트가 남긴 상태를 항상 지운다(다른 테스트에 영향 안 주게).
        struct Cleanup(&'static str);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let mut guard = state().lock().unwrap();
                guard.lead_first_miss_at.remove(self.0);
                guard.last_known_live_lead_row.remove(self.0);
            }
        }
        let _cleanup = Cleanup(lead_id);
        {
            let mut guard = state().lock().unwrap();
            guard.lead_first_miss_at.remove(lead_id);
            guard.last_known_live_lead_row.remove(lead_id);
        }

        // 1) 처음 못 잡힘 — 아직 오프라인 확정 전(유예 구간), 그레이스 캐시도 없고 팀원도 없으니
        //    graceRows에도 안 잡혀야 한다(= "다음 폴링까지 조용히 건너뛴다").
        let offline1 = compute_offline_leads(&leads, &agent_ids, 1_000, 5_000, &members);
        assert!(offline1.is_empty(), "첫 미스는 아직 오프라인 확정이면 안 된다");
        let grace1 = build_grace_rows(&leads, &agent_ids, &offline1, &members);
        assert!(grace1.is_empty(), "캐시도 팀원도 없으면 그레이스 카드도 없어야 한다");

        // 2) 유예 시간이 지나면 오프라인 확정.
        let offline2 = compute_offline_leads(&leads, &agent_ids, 10_000, 5_000, &members);
        assert_eq!(offline2.len(), 1);
        assert_eq!(offline2[0].id, lead_id);
        let offline_rows = build_offline_rows(&offline2);
        assert_eq!(offline_rows.len(), 1);
        assert!(offline_rows[0].offline, "오프라인 확정 카드는 offline:true여야 한다");
        assert_eq!(offline_rows[0].label.as_deref(), Some("가짜 팀장"));
        assert_eq!(offline_rows[0].agent.id.as_deref(), Some(lead_id));

        // 3) 다시 살아있는 것으로 잡히면(agent_ids에 포함) 기록이 지워지고 더 이상 오프라인이
        //    아니어야 한다.
        let agent_ids_alive: HashSet<String> = HashSet::from([lead_id.to_string()]);
        let offline3 = compute_offline_leads(&leads, &agent_ids_alive, 20_000, 5_000, &members);
        assert!(offline3.is_empty(), "다시 살아있으면 오프라인 목록에서 빠져야 한다");
    }

    // buildGraceRows가 lastKnownLiveLeadRow 캐시를 우선 재사용하는지 — 팀장이 stop→resume
    // 재기동 중이라 agents 스냅샷에 잠깐 안 잡혀도, 직전에 살아있었을 때의 카드를 그대로
    // 돌려줘야 대화창이 순간적으로 사라지지 않는다(main.ts 주석 참고).
    #[test]
    fn grace_rows_reuse_last_known_live_snapshot() {
        let lead_id = "test-fake-lead-grace-cache-xyz";
        let lead = fake_lead(lead_id);
        let leads = vec![lead.clone()];
        let agent_ids: HashSet<String> = HashSet::new();
        let members: Vec<MemberRecord> = Vec::new();

        struct Cleanup(&'static str);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let mut guard = state().lock().unwrap();
                guard.lead_first_miss_at.remove(self.0);
                guard.last_known_live_lead_row.remove(self.0);
            }
        }
        let _cleanup = Cleanup(lead_id);

        let cached_row = build_lead_record_row(&lead, false);
        {
            let mut guard = state().lock().unwrap();
            guard.last_known_live_lead_row.insert(lead_id.to_string(), cached_row.clone());
        }

        let offline_leads = compute_offline_leads(&leads, &agent_ids, 1_000, 999_999_999, &members);
        assert!(offline_leads.is_empty(), "유예 시간이 크므로 아직 오프라인이 아니어야 한다");
        let grace_rows = build_grace_rows(&leads, &agent_ids, &offline_leads, &members);
        assert_eq!(grace_rows.len(), 1);
        assert!(!grace_rows[0].offline, "그레이스 카드는 offline:false로 보여야 한다");
        assert_eq!(grace_rows[0].agent.id, cached_row.agent.id);
    }

    // compute_unapproved_dirs — claude 최초 실행 승인이 안 된(실제로 ~/.claude.json에 등록됐을 리
    // 없는 가짜 경로) targetDir/approvedMembers를 걸러내는지, 같은 경로가 여러 번 나와도 중복
    // 없이 한 번만 잡히는지.
    #[test]
    fn compute_unapproved_dirs_flags_never_trusted_dirs_without_duplicates() {
        let mut lead = fake_lead("test-fake-lead-unapproved-dirs-xyz");
        lead.target_dir = "C:\\definitely-not-trusted-dir-xyz".to_string();
        lead.approved_members = vec!["C:\\definitely-not-trusted-dir-xyz".to_string(), "C:\\another-untrusted-dir-xyz".to_string()];
        let leads = vec![lead];

        let result = compute_unapproved_dirs(&leads);
        assert_eq!(result.len(), 2, "targetDir과 겹치는 approvedMembers 항목은 중복 없이 한 번만 잡혀야 한다: {result:?}");
        assert!(result.iter().any(|r| r.dir == "C:\\definitely-not-trusted-dir-xyz"));
        assert!(result.iter().any(|r| r.dir == "C:\\another-untrusted-dir-xyz"));
        assert!(result.iter().all(|r| !r.reason.is_empty()));
    }

    #[test]
    fn compute_unapproved_dirs_empty_for_no_leads() {
        assert!(compute_unapproved_dirs(&[]).is_empty());
    }

    // refresh_board_command — 죽지 않고 main.ts와 같은 네 필드(rows/requests/unapprovedDirs/
    // stallAlerts)를 채워 돌려주는지만 스모크 테스트한다(실제 값 내용은 이미 각 필드를 만드는
    // 함수들의 개별 테스트가 검증한다).
    #[tokio::test]
    async fn refresh_board_command_returns_without_hanging() {
        let result = refresh_board_command().await;
        let _ = (result.rows.len(), result.requests.len(), result.unapproved_dirs.len(), result.stall_alerts.len());
    }
}
