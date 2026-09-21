use crate::agents_json::{fetch_agents_typed, AgentEntry};
use crate::board_state::{prune_missing_keys, state};
use crate::json_file::write_json_file_atomic;
use crate::live_rows::{read_journal_entries, resolve_project_name, SessionRow};
use crate::paths::{settings_path, stall_alerts_path};
use crate::session_registry::{load_leads, LeadRecord, MemberRecord};
use crate::timing::{
    now_ms, STALL_CLASSIFIER_TIMEOUT_MS, STALL_IDLE_THRESHOLD_MS_DEFAULT, STALL_RECHECK_COOLDOWN_MS_DEFAULT,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use wait_timeout::ChildExt;

// stallGuard.js의 APPROVAL_PATTERN과 정확히 같은 패턴이어야 한다 — 이게 정체 감시의 마지막
// 안전장치 중 하나(Haiku의 판단과 무관하게 절대 재촉하지 않는 정적 게이트)라서 한 글자라도
// 갈라지면 승인 대기중인 팀장을 잘못 찔러버릴 수 있다.
fn approval_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(\?|승인|컨펌|확인해\s*주세요|확인\s*부탁|괜찮을까요|진행할까요|어떻게\s*할까요|어떤\s*(거|것|걸)로|선택해\s*주세요|해도\s*될까요|알려주세요|답변\s*부탁)",
        )
        .expect("APPROVAL_PATTERN 정규식은 컴파일 타임에 고정된 값이라 항상 유효해야 한다")
    })
}

/// looksLikeApprovalRequest(stallGuard.js)와 동일.
pub fn looks_like_approval_request(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    approval_pattern().is_match(text)
}

#[derive(Debug, Clone, PartialEq)]
pub struct StallVerdict {
    pub should_nudge: bool,
    pub waiting_for_user: bool,
    pub reason: String,
}

fn fence_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    // (?s)로 .이 개행도 매칭하게 한다 — JS의 [\s\S]와 동등.
    PATTERN.get_or_init(|| Regex::new(r"(?s)```(?:json)?\s*(.*?)```").expect("고정 패턴"))
}

/// parseStallVerdict(stallGuard.js)와 동일 — Haiku의 raw 응답(코드펜스로 감싸져 있을 수 있음)을
/// 엄격하게 검증해서 파싱한다. 하나라도 안 맞으면 None(fail-closed: 애매하면 아무것도 안 함).
pub fn parse_stall_verdict(raw_result: &str) -> Option<StallVerdict> {
    let json_text = match fence_pattern().captures(raw_result) {
        Some(caps) => caps.get(1).map(|m| m.as_str()).unwrap_or("").trim().to_string(),
        None => raw_result.trim().to_string(),
    };
    if json_text.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(&json_text).ok()?;
    let obj = parsed.as_object()?;
    let should_nudge = obj.get("shouldNudge")?.as_bool()?;
    let waiting_for_user = obj.get("waitingForUser")?.as_bool()?;
    let reason = obj.get("reason").and_then(|r| r.as_str()).unwrap_or("").to_string();
    Some(StallVerdict { should_nudge, waiting_for_user, reason })
}

/// isStatusEligibleForStall(stallGuard.js)와 동일 — shouldCheckStall(최초 후보 선정)과 발송
/// 직전 최종 재확인이 정확히 같은 규칙을 쓰게 하려고 공용 함수로 뽑았다.
pub fn is_status_eligible_for_stall(member_status: &str, lead_status: &str) -> bool {
    if member_status == "blocked" || lead_status == "blocked" {
        return false;
    }
    if lead_status != "idle" && lead_status != "done" {
        return false;
    }
    if member_status == "busy" || member_status.is_empty() {
        return false;
    }
    true
}

pub struct ShouldCheckStallParams<'a> {
    pub member_status: &'a str,
    pub lead_status: &'a str,
    pub member_idle_since: Option<i64>,
    pub lead_idle_since: Option<i64>,
    pub now: i64,
    pub idle_threshold_ms: i64,
    pub last_checked_at: Option<i64>,
    pub cooldown_ms: i64,
    pub has_existing_alert: bool,
}

/// shouldCheckStall(stallGuard.js)와 동일 — 이 후보(팀원 하나)에 (비용 드는) Haiku 호출을 걸
/// 가치가 있는 상황인지 판정한다.
pub fn should_check_stall(p: ShouldCheckStallParams) -> bool {
    if p.has_existing_alert {
        return false;
    }
    if !is_status_eligible_for_stall(p.member_status, p.lead_status) {
        return false;
    }
    match p.member_idle_since {
        None => return false,
        Some(t) if p.now - t < p.idle_threshold_ms => return false,
        _ => {}
    }
    match p.lead_idle_since {
        None => return false,
        Some(t) if p.now - t < p.idle_threshold_ms => return false,
        _ => {}
    }
    if let Some(t) = p.last_checked_at {
        if p.now - t < p.cooldown_ms {
            return false;
        }
    }
    true
}

/// shouldSendNudge(stallGuard.js)와 동일 — Haiku 판단 + 정적 안전장치를 모두 통과해야 발송 허가.
pub fn should_send_nudge(verdict: Option<&StallVerdict>, last_answer_text: &str) -> bool {
    let Some(v) = verdict else { return false };
    if v.waiting_for_user {
        return false;
    }
    if looks_like_approval_request(last_answer_text) {
        return false;
    }
    v.should_nudge
}

/// buildStallClassifierPrompt(main.ts)와 동일.
pub fn build_stall_classifier_prompt(tail_text: &str, member_desc: &str) -> String {
    let tail = if tail_text.is_empty() { "(대화 기록 없음)" } else { tail_text };
    [
        "당신은 팀장 세션이 방치되고 있는지 판단하는 보조 도구입니다. 아래는 어떤 \"팀장\" AI 세션의".to_string(),
        "최근 대화 일부와, 그 팀장에게 소속된 팀원 상태 설명입니다.".to_string(),
        String::new(),
        format!("[팀원 상태] {member_desc}"),
        String::new(),
        "[팀장의 최근 대화]".to_string(),
        tail.to_string(),
        String::new(),
        "이 정보만 보고 판단하세요:".to_string(),
        "- shouldNudge: 팀장이 실수로 다음 지시를 깜빡한 것으로 보이면 true, 이미 할 일이 다 끝났거나".to_string(),
        "  판단하기 애매하면 false.".to_string(),
        "- waitingForUser: 팀장이 사람의 확인/승인/선택을 기다리고 있는 것으로 조금이라도 보이면 true.".to_string(),
        "  이 경우 shouldNudge 값과 무관하게 절대 재촉하면 안 되는 상황이니, 조금이라도 의심되면".to_string(),
        "  반드시 true로 답하세요(애매하면 true 쪽으로 치우치세요).".to_string(),
        "- reason: 판단 근거를 한국어 한 문장으로.".to_string(),
        String::new(),
        "다른 설명 없이 이 형식의 JSON만 출력하세요:".to_string(),
        "{\"shouldNudge\": boolean, \"waitingForUser\": boolean, \"reason\": string}".to_string(),
    ]
    .join("\n")
}

// runStallClassifier(main.ts)의 프로세스 실행부 — agents_json.rs의 claude 실행 패턴(타임아웃 +
// CREATE_NO_WINDOW)과 동일하게 만든다. -p(1회성 응답) + --model haiku + --output-format json으로
// 세션 컨텍스트 없이 값싼 단발 판단만 받는다. cwd를 임시 디렉토리로 둬서(main.ts와 동일) 어떤
// 프로젝트의 CLAUDE.md도 로드하지 않게 한다.
fn run_claude_stall_classifier(prompt: &str) -> Option<String> {
    let mut cmd = Command::new("claude");
    cmd.args(["-p", "--model", "haiku", "--output-format", "json", prompt]);
    cmd.current_dir(std::env::temp_dir());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[run_stall_classifier] claude 프로세스를 실행하지 못했습니다: {e}");
            return None;
        }
    };
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

    match child.wait_timeout(Duration::from_millis(STALL_CLASSIFIER_TIMEOUT_MS)) {
        Ok(Some(status)) => {
            let out = stdout_reader.join().unwrap_or_default();
            let _ = stderr_reader.join();
            if !status.success() {
                eprintln!("[run_stall_classifier] claude 종료 코드 {:?}", status.code());
            }
            String::from_utf8(out).ok()
        }
        Ok(None) => {
            eprintln!("[run_stall_classifier] Haiku 분류 호출이 응답 없이 대기 중이라 강제 종료합니다.");
            let _ = child.kill();
            let _ = child.wait();
            None
        }
        Err(e) => {
            eprintln!("[run_stall_classifier] claude 대기 실패: {e}");
            None
        }
    }
}

/// runStallClassifier(main.ts)와 동일 — Haiku로 단발성 판단만 받는다. exec/파싱 실패는 모두
/// None(fail-closed)으로 처리한다.
pub fn run_stall_classifier(tail_text: &str, member_desc: &str) -> Option<StallVerdict> {
    let prompt = build_stall_classifier_prompt(tail_text, member_desc);
    let raw = run_claude_stall_classifier(&prompt)?;
    let envelope: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[run_stall_classifier] Haiku 응답 파싱 실패(fail-closed로 처리): {e}");
            return None;
        }
    };
    let result = envelope.get("result")?.as_str()?;
    parse_stall_verdict(result)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StallAlert {
    pub id: String,
    #[serde(rename = "leadInternalId")]
    pub lead_internal_id: String,
    #[serde(rename = "memberId")]
    pub member_id: String,
    #[serde(rename = "memberSessionId")]
    pub member_session_id: String,
    pub reason: String,
    #[serde(rename = "suggestedMessage")]
    pub suggested_message: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

/// loadStallAlerts(main.ts)와 동일 — 파일이 없거나 배열이 아니거나 파싱 실패하면 빈 배열.
pub fn load_stall_alerts() -> Vec<StallAlert> {
    let raw = match fs::read_to_string(stall_alerts_path()) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Vec<StallAlert>>(&raw).unwrap_or_default()
}

/// saveStallAlerts(main.ts)와 동일.
pub fn save_stall_alerts(alerts: &[StallAlert]) {
    if let Err(e) = write_json_file_atomic(&stall_alerts_path(), &alerts) {
        eprintln!("[save_stall_alerts] stallAlerts.json 저장 실패: {e}");
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StallAlertForUi {
    #[serde(flatten)]
    pub alert: StallAlert,
    #[serde(rename = "leadId", skip_serializing_if = "Option::is_none")]
    pub lead_id: Option<String>,
}

// listStallAlertsForUi(main.ts)의 순수 매핑 부분만 뽑았다 — 디스크 I/O 없이 테스트하려고
// load_stall_alerts()/load_leads() 호출과 분리한다.
fn attach_lead_ids(alerts: Vec<StallAlert>, leads: &[LeadRecord]) -> Vec<StallAlertForUi> {
    alerts
        .into_iter()
        .map(|alert| {
            let lead_id = leads
                .iter()
                .find(|l| l.internal_id.as_deref() == Some(alert.lead_internal_id.as_str()))
                .map(|l| l.id.clone());
            StallAlertForUi { alert, lead_id }
        })
        .collect()
}

/// listStallAlertsForUi(main.ts)와 동일 — 렌더러는 internalId를 모르니 화면 표시용 짧은
/// leadId를 붙여서 내려준다. poll()의 agents-update 푸시(fetchBoardSnapshot)와 get_stall_alerts
/// 양쪽에서 재사용한다.
pub fn list_stall_alerts_for_ui() -> Vec<StallAlertForUi> {
    attach_lead_ids(load_stall_alerts(), &load_leads())
}

#[tauri::command]
pub fn get_stall_alerts() -> Vec<StallAlertForUi> {
    list_stall_alerts_for_ui()
}

// confirmStallAlert/dismissStallAlert(main.ts) 둘 다 "id로 하나 찾아서 목록에서 뺀다"는 같은
// 순수 로직을 쓴다 — 디스크 I/O 없이 테스트하려고 따로 뽑았다. id가 여러 개 있을 리 없지만
// (STALL_ALERT_SEQ로 유일성 보장) 혹시 몰라 첫 매치 하나만 뗀다.
fn remove_stall_alert(alerts: Vec<StallAlert>, alert_id: &str) -> (Vec<StallAlert>, Option<StallAlert>) {
    let mut removed = None;
    let mut remaining = Vec::with_capacity(alerts.len());
    for a in alerts {
        if removed.is_none() && a.id == alert_id {
            removed = Some(a);
        } else {
            remaining.push(a);
        }
    }
    (remaining, removed)
}

/// confirmStallAlert(main.ts)의 포팅 — 단, main.ts는 여기서 queueLeadNotice로 실제 팀장에게
/// suggestedMessage를 전달까지 한다. 알림 큐(queueLeadNotice/deliverPendingNotices)는 이번
/// 청크 범위 밖(팀장/팀원에게 실제로 메시지를 찔러 넣는 코드라 더 신중한 별도 리뷰가 필요하다고
/// 명시적으로 제외됨)이라, 여기서는 alert을 목록에서 제거하는 파일 조작까지만 한다 — 실제 전달은
/// 알림 큐가 포팅되는 다음 청크에서 이어붙일 예정이다. 그때까지는 "이어서 진행 지시" 버튼을 눌러도
/// 목록에서만 사라질 뿐, 팀장에게 실제로 메시지가 가지 않는다(의도된 임시 상태 — 아래 eprintln 참고).
#[tauri::command]
pub fn confirm_stall_alert(alert_id: String) -> bool {
    let (remaining, removed) = remove_stall_alert(load_stall_alerts(), &alert_id);
    let Some(alert) = removed else { return false };
    eprintln!(
        "[confirm_stall_alert] alert {}를 목록에서 제거했지만, 알림 큐(queueLeadNotice)가 아직 \
         Rust로 포팅되지 않아 팀장({})에게 실제 메시지 전달은 하지 않았습니다 — 다음 청크에서 이어붙여야 합니다.",
        alert.id, alert.lead_internal_id
    );
    save_stall_alerts(&remaining);
    true
}

/// dismissStallAlert(main.ts)와 동일 — 전달 없이 목록에서만 조용히 제거한다.
#[tauri::command]
pub fn dismiss_stall_alert(alert_id: String) -> bool {
    let (remaining, removed) = remove_stall_alert(load_stall_alerts(), &alert_id);
    if removed.is_none() {
        return false;
    }
    save_stall_alerts(&remaining);
    true
}

// clampMinutes(lib/appSettings.js)와 동일 — 손상된 값/범위 밖 값을 안전하게 정리한다.
fn clamp_minutes(value: Option<f64>, fallback: i64, min: i64, max: i64) -> i64 {
    match value {
        Some(v) if v.is_finite() => (v.round() as i64).clamp(min, max),
        _ => fallback,
    }
}

// JSON 값에서 숫자를 뽑는다 — settings.json은 사용자가 수동으로 편집할 수 있어서(main.ts 주석
// 참고) 문자열로 저장된 숫자("15")도 JS의 Number(value)처럼 관대하게 받아준다.
fn value_to_f64(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                t.parse::<f64>().ok()
            }
        }
        _ => None,
    }
}

struct StallSettings {
    stall_idle_threshold_min: i64,
    stall_cooldown_min: i64,
}

// loadSettings(main.ts)의 정체 감시 관련 필드만 옮긴 것 — get-settings/update-settings IPC
// 전체는 이번 포팅 범위 밖이라(사용자가 설정 화면에서 값을 바꾸는 쓰기 경로는 아직 없음) 읽기만
// 한다. 파일이 없거나 손상됐으면 기본값으로 fail-open한다.
fn load_stall_settings() -> StallSettings {
    let raw: serde_json::Value = fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null);
    let idle_raw = raw.get("stallIdleThresholdMin").and_then(value_to_f64);
    let cooldown_raw = raw.get("stallCooldownMin").and_then(value_to_f64);
    StallSettings {
        stall_idle_threshold_min: clamp_minutes(idle_raw, STALL_IDLE_THRESHOLD_MS_DEFAULT / 60_000, 1, 24 * 60),
        stall_cooldown_min: clamp_minutes(cooldown_raw, STALL_RECHECK_COOLDOWN_MS_DEFAULT / 60_000, 1, 24 * 60),
    }
}

fn get_status_core(status: Option<&str>, state: Option<&str>) -> String {
    if state == Some("done") {
        return "done".to_string();
    }
    if state == Some("blocked") {
        return "blocked".to_string();
    }
    let s = status.filter(|v| !v.is_empty());
    let st = state.filter(|v| !v.is_empty());
    s.or(st).unwrap_or("").to_lowercase()
}

/// renderer/lib/status.js의 getStatus와 동일(SessionRow 버전).
fn get_status_row(row: &SessionRow) -> String {
    get_status_core(row.agent.status.as_deref(), row.agent.state.as_deref())
}

/// getStatus(AgentEntry 버전) — freshAgents 재확인 단계에서 쓴다.
fn get_status_agent(agent: &AgentEntry) -> String {
    get_status_core(agent.status.as_deref(), agent.state.as_deref())
}

fn get_transcript_tail(project_name: &str, session_id: &str) -> Vec<crate::live_rows::JournalEntry> {
    // getTranscript(main.ts)는 daily-journal 기록에 원본 세션 파일(fillMissingTranscriptFromRawSession)을
    // 보완해서 합치지만, 이번 포팅은 그 보완 병합까지는 하지 않는다(요청받은 함수 목록에 없음) —
    // daily-journal 기록만으로도 정체 감시의 입력(최근 몇 턴 요약)으로는 충분하고, 승인 요청 정규식·
    // Haiku의 waitingForUser 판단·발송 직전 재확인까지 이어지는 다중 안전장치는 트랜스크립트
    // 완결성과 무관하게 항상 적용된다.
    read_journal_entries(project_name).into_iter().filter(|e| e.session_id == session_id).collect()
}

static STALL_WATCHDOG_IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static STALL_ALERT_SEQ: AtomicU64 = AtomicU64::new(0);

/// runStallWatchdog(main.ts)와 동일하게 fire-and-forget으로 건다 — 호출한 쪽(get_live_session_rows)의
/// 반환을 막지 않는다. 이미 실행 중이면 아무것도 안 하고 조용히 리턴한다(stallWatchdogInFlight와
/// 동일한 역할의 원자적 플래그).
pub fn spawn_stall_watchdog_if_idle(live_rows: Vec<SessionRow>, leads: Vec<LeadRecord>, members: Vec<MemberRecord>) {
    if STALL_WATCHDOG_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        run_stall_watchdog(&live_rows, &leads, &members);
        STALL_WATCHDOG_IN_FLIGHT.store(false, Ordering::SeqCst);
    });
}

/// runStallWatchdog(main.ts)의 포팅 — 방치된 팀원을 감지해 StallAlert를 만들어 파일에 기록하는
/// 것까지가 이번 청크의 목표다. 팀장에게 실제로 메시지를 보내는 알림 큐(queueLeadNotice/
/// deliverPendingNotices)는 이번 범위 밖이라, autoStallNudge가 켜진 팀장은 자동 재촉을 아직
/// 실행하지 않고 건너뛴다(다음 청크에서 알림 큐를 포팅하면서 이어붙일 예정).
fn run_stall_watchdog(live_rows: &[SessionRow], leads: &[LeadRecord], members: &[MemberRecord]) {
    let now = now_ms();
    let settings = load_stall_settings();
    let idle_threshold_ms = settings.stall_idle_threshold_min * 60_000;
    let cooldown_ms = settings.stall_cooldown_min * 60_000;

    let member_rows_by_id: HashMap<&str, &SessionRow> = live_rows
        .iter()
        .filter(|r| !r.is_lead)
        .filter_map(|r| r.agent.id.as_deref().map(|id| (id, r)))
        .collect();
    let lead_rows_by_id: HashMap<&str, &SessionRow> = live_rows
        .iter()
        .filter(|r| r.is_lead)
        .filter_map(|r| r.agent.id.as_deref().map(|id| (id, r)))
        .collect();

    {
        let mut guard = state().lock().unwrap();

        let live_member_session_ids: HashSet<String> = member_rows_by_id.values().map(|r| r.agent.session_id.clone()).collect();
        for row in member_rows_by_id.values() {
            if get_status_row(row) == "busy" {
                guard.member_idle_since.remove(&row.agent.session_id);
                continue;
            }
            guard.member_idle_since.entry(row.agent.session_id.clone()).or_insert(now);
        }
        prune_missing_keys(&mut guard.member_idle_since, &live_member_session_ids);
        prune_missing_keys(&mut guard.stall_last_checked_at, &live_member_session_ids);

        let live_lead_session_ids: HashSet<String> = lead_rows_by_id.values().map(|r| r.agent.session_id.clone()).collect();
        for row in lead_rows_by_id.values() {
            if get_status_row(row) == "busy" {
                guard.lead_idle_since.remove(&row.agent.session_id);
                continue;
            }
            guard.lead_idle_since.entry(row.agent.session_id.clone()).or_insert(now);
        }
        prune_missing_keys(&mut guard.lead_idle_since, &live_lead_session_ids);
    }

    struct Candidate<'a> {
        member: &'a MemberRecord,
        member_row: &'a SessionRow,
        lead: &'a LeadRecord,
        lead_row: &'a SessionRow,
    }

    let existing_alerts = load_stall_alerts();
    let mut candidates: Vec<Candidate> = Vec::new();
    {
        let guard = state().lock().unwrap();
        for m in members {
            let Some(&member_row) = member_rows_by_id.get(m.member_id.as_str()) else { continue };
            let Some(lead) = leads.iter().find(|l| l.id == m.lead_id) else { continue };
            let Some(&lead_row) = lead_rows_by_id.get(lead.id.as_str()) else { continue };

            let check = should_check_stall(ShouldCheckStallParams {
                member_status: &get_status_row(member_row),
                lead_status: &get_status_row(lead_row),
                member_idle_since: guard.member_idle_since.get(&member_row.agent.session_id).copied(),
                lead_idle_since: guard.lead_idle_since.get(&lead_row.agent.session_id).copied(),
                now,
                idle_threshold_ms,
                last_checked_at: guard.stall_last_checked_at.get(&member_row.agent.session_id).copied(),
                cooldown_ms,
                has_existing_alert: existing_alerts.iter().any(|a| a.member_session_id == member_row.agent.session_id),
            });
            if check {
                candidates.push(Candidate { member: m, member_row, lead, lead_row });
            }
        }
    }
    if candidates.is_empty() {
        return;
    }

    for candidate in candidates {
        let Candidate { member, member_row, lead, lead_row } = candidate;

        let project_name = resolve_project_name(&lead.session_id, &lead.target_dir);
        let transcript = get_transcript_tail(&project_name, &lead.session_id);
        let start = transcript.len().saturating_sub(4);
        let last_entries = &transcript[start..];
        if last_entries.is_empty() {
            continue; // 대화 기록이 없으면 판단할 근거가 없다 — 쿨다운 없이 다음 폴링에 다시 시도
        }

        let last_answer = last_entries.last().map(|e| e.answer.clone()).unwrap_or_default();
        if looks_like_approval_request(&last_answer) {
            continue;
        }

        // 여기서부터는 실제로 Haiku를 호출한다 — 지금 마크해서 실패해도 쿨다운 동안 재시도 안 함.
        {
            let mut guard = state().lock().unwrap();
            guard.stall_last_checked_at.insert(member_row.agent.session_id.clone(), now_ms());
        }

        let joined = last_entries.iter().map(|e| format!("사용자: {}\n팀장: {}", e.prompt, e.answer)).collect::<Vec<_>>().join("\n\n");
        let tail_text: String = {
            let chars: Vec<char> = joined.chars().collect();
            if chars.len() > 3000 {
                chars[chars.len() - 3000..].iter().collect()
            } else {
                joined
            }
        };
        let idle_since = {
            let guard = state().lock().unwrap();
            guard.member_idle_since.get(&member_row.agent.session_id).copied().unwrap_or_else(now_ms)
        };
        let idle_minutes = (((now_ms() - idle_since) as f64) / 60000.0).round().max(1.0) as i64;
        let member_desc = format!(
            "팀원 {}(역할: {})가 {}분째 {} 상태로 멈춰있습니다.",
            member.member_id,
            member.role.as_deref().unwrap_or("미지정"),
            idle_minutes,
            get_status_row(member_row),
        );

        let verdict = run_stall_classifier(&tail_text, &member_desc);
        if !should_send_nudge(verdict.as_ref(), &last_answer) {
            continue;
        }

        // 발송 여부를 판단하는 사이(Haiku 호출 대기 중) 상태가 바뀌었을 수 있으니, 최종적으로
        // 알림을 만들기 직전에 한 번 더 최신 상태를 sessionId로 다시 확인한다.
        let fresh_agents = fetch_agents_typed();
        let fresh_lead_agent = fresh_agents.iter().find(|a| a.session_id == lead_row.agent.session_id);
        let Some(fresh_lead_agent) = fresh_lead_agent else { continue }; // 팀장이 그 사이 완전히 내려갔으면 재촉할 대상이 없다
        let fresh_member_agent = fresh_agents.iter().find(|a| a.session_id == member_row.agent.session_id);
        let fresh_member_status = fresh_member_agent.map(get_status_agent).unwrap_or_default();
        if !is_status_eligible_for_stall(&fresh_member_status, &get_status_agent(fresh_lead_agent)) {
            continue;
        }

        let suggested_message = format!(
            "[정체 감지] 팀원 {}가 {}분째 대기 중입니다. 남은 작업이 있으면 이어서 지시하고, 이미 다 끝났으면 그렇다고 확인해주세요.",
            member.member_id, idle_minutes
        );

        let Some(lead_internal_id) = lead.internal_id.clone() else { continue }; // internalId 없는 낡은 레코드는 알림 큐가 못 찾으므로 스킵

        if lead.auto_stall_nudge == Some(true) {
            // queueLeadNotice(알림 큐)는 이번 청크 범위 밖이다("팀장 조작" 계열이라 다음 청크로
            // 미루기로 함) — 자동 재촉 모드 팀장은 원래 확인 알림(StallAlert) 자체를 만들지 않고
            // 곧장 메시지를 보내므로, 여기서 대신 StallAlert를 만들면 원래 동작(확인 없이 자동
            // 진행)과 달라진다. 그래서 이 경우엔 아무것도 만들지 않고 건너뛴다 — 다음 폴링에
            // 다시 후보로 잡히고, 알림 큐가 포팅되면 그때부터 정상적으로 자동 재촉된다.
            eprintln!(
                "[run_stall_watchdog] 팀장 {lead_internal_id}은 autoStallNudge가 켜져 있지만, 알림 큐가 아직 포팅되지 않아 자동 재촉을 건너뜁니다."
            );
            continue;
        }

        let mut alerts = load_stall_alerts();
        if alerts.iter().any(|a| a.member_session_id == member_row.agent.session_id) {
            continue; // 그 사이 이미 생성됐으면 중복 방지
        }
        let verdict_reason = verdict.map(|v| v.reason).unwrap_or_default();
        alerts.push(StallAlert {
            id: format!("stall-{}-{}", now_ms(), STALL_ALERT_SEQ.fetch_add(1, Ordering::Relaxed)),
            lead_internal_id,
            member_id: member.member_id.clone(),
            member_session_id: member_row.agent.session_id.clone(),
            reason: verdict_reason,
            suggested_message,
            created_at: now_ms(),
        });
        save_stall_alerts(&alerts);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_request_patterns_match_main_ts_examples() {
        assert!(looks_like_approval_request("이대로 진행할까요?"));
        assert!(looks_like_approval_request("승인 부탁드립니다"));
        // 패턴 `어떤\s*(거|것|걸)로`는 "것"/"거"/"걸"에 조사 "로"가 바로 붙는 축약형만 잡는다 —
        // "어떤 것으로"(것+으로)처럼 "으"가 끼면 매칭 대상이 아니다(원본 정규식 그대로 옮긴 것 —
        // main.ts의 실제 동작이지 이식 과정에서 생긴 버그가 아니다).
        assert!(looks_like_approval_request("어떤 걸로 하시겠어요"));
        assert!(!looks_like_approval_request("어떤 것으로 하시겠어요"));
        assert!(looks_like_approval_request("확인해 주세요"));
        assert!(looks_like_approval_request("그냥 물음표만?"));
        assert!(!looks_like_approval_request("작업을 완료했습니다."));
        assert!(!looks_like_approval_request(""));
    }

    #[test]
    fn parses_fenced_and_plain_verdict_json() {
        let plain = parse_stall_verdict(r#"{"shouldNudge": true, "waitingForUser": false, "reason": "테스트"}"#).unwrap();
        assert_eq!(plain, StallVerdict { should_nudge: true, waiting_for_user: false, reason: "테스트".to_string() });

        let fenced = parse_stall_verdict("```json\n{\"shouldNudge\": false, \"waitingForUser\": true, \"reason\": \"승인 대기\"}\n```").unwrap();
        assert_eq!(fenced, StallVerdict { should_nudge: false, waiting_for_user: true, reason: "승인 대기".to_string() });
    }

    #[test]
    fn rejects_malformed_verdicts_fail_closed() {
        assert!(parse_stall_verdict("이건 JSON이 아닙니다").is_none());
        assert!(parse_stall_verdict(r#"{"shouldNudge": "true", "waitingForUser": false}"#).is_none()); // 타입 안 맞음
        assert!(parse_stall_verdict(r#"{"waitingForUser": false, "reason": "x"}"#).is_none()); // 필드 누락
        assert!(parse_stall_verdict("").is_none());
        assert!(parse_stall_verdict(123.to_string().as_str()).is_none());
    }

    #[test]
    fn status_eligibility_gates_blocked_and_busy() {
        assert!(is_status_eligible_for_stall("idle", "idle"));
        assert!(is_status_eligible_for_stall("done", "done"));
        assert!(!is_status_eligible_for_stall("blocked", "idle"));
        assert!(!is_status_eligible_for_stall("idle", "blocked"));
        assert!(!is_status_eligible_for_stall("busy", "idle"));
        assert!(!is_status_eligible_for_stall("", "idle"));
        assert!(!is_status_eligible_for_stall("idle", "busy"));
    }

    #[test]
    fn should_check_stall_requires_both_idle_past_threshold_and_cooldown() {
        let base = |member_idle: Option<i64>, lead_idle: Option<i64>, last_checked: Option<i64>, existing: bool| {
            should_check_stall(ShouldCheckStallParams {
                member_status: "idle",
                lead_status: "idle",
                member_idle_since: member_idle,
                lead_idle_since: lead_idle,
                now: 1_000_000,
                idle_threshold_ms: 600_000,
                last_checked_at: last_checked,
                cooldown_ms: 1_200_000,
                has_existing_alert: existing,
            })
        };
        assert!(base(Some(0), Some(0), None, false)); // 둘 다 임계값 이상 idle, 쿨다운 없음
        assert!(!base(None, Some(0), None, false)); // 팀원 idle 시각 모름
        assert!(!base(Some(500_000), Some(0), None, false)); // 팀원 idle 시간 부족
        assert!(!base(Some(0), Some(999_000), None, false)); // 팀장 idle 시간 부족
        assert!(!base(Some(0), Some(0), Some(900_000), false)); // 쿨다운 안 지남
        assert!(!base(Some(0), Some(0), None, true)); // 이미 알림 있음
    }

    #[test]
    fn should_send_nudge_requires_verdict_and_blocks_waiting_or_approval_text() {
        let nudge = StallVerdict { should_nudge: true, waiting_for_user: false, reason: "r".into() };
        assert!(should_send_nudge(Some(&nudge), "네 진행하겠습니다."));
        assert!(!should_send_nudge(None, "아무 텍스트"));

        let waiting = StallVerdict { should_nudge: true, waiting_for_user: true, reason: "r".into() };
        assert!(!should_send_nudge(Some(&waiting), "그냥 텍스트"));

        // waitingForUser는 false여도 마지막 답변 자체가 승인 요청처럼 보이면 정적 게이트가 막는다.
        assert!(!should_send_nudge(Some(&nudge), "이대로 진행할까요?"));

        let no_nudge = StallVerdict { should_nudge: false, waiting_for_user: false, reason: "r".into() };
        assert!(!should_send_nudge(Some(&no_nudge), "그냥 텍스트"));
    }

    #[test]
    fn clamp_minutes_falls_back_on_invalid_or_missing_values() {
        assert_eq!(clamp_minutes(None, 10, 1, 1440), 10);
        assert_eq!(clamp_minutes(Some(f64::NAN), 10, 1, 1440), 10);
        assert_eq!(clamp_minutes(Some(0.0), 10, 1, 1440), 1); // 최소값으로 클램프
        assert_eq!(clamp_minutes(Some(99999.0), 10, 1, 1440), 1440); // 최대값으로 클램프
        assert_eq!(clamp_minutes(Some(15.4), 10, 1, 1440), 15); // 반올림
    }

    fn sample_alert(id: &str, lead_internal_id: &str) -> StallAlert {
        StallAlert {
            id: id.to_string(),
            lead_internal_id: lead_internal_id.to_string(),
            member_id: "member-a".to_string(),
            member_session_id: "sess-a".to_string(),
            reason: "테스트 사유".to_string(),
            suggested_message: "이어서 진행해주세요".to_string(),
            created_at: 1_000,
        }
    }

    #[test]
    fn remove_stall_alert_extracts_only_matching_id() {
        let alerts = vec![sample_alert("a", "lead-1"), sample_alert("b", "lead-2")];
        let (remaining, removed) = remove_stall_alert(alerts, "a");
        assert_eq!(removed.map(|a| a.id), Some("a".to_string()));
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "b");
    }

    #[test]
    fn remove_stall_alert_returns_none_when_id_not_found() {
        let alerts = vec![sample_alert("a", "lead-1")];
        let (remaining, removed) = remove_stall_alert(alerts, "missing");
        assert!(removed.is_none());
        assert_eq!(remaining.len(), 1);
    }

    #[test]
    fn attach_lead_ids_matches_by_internal_id_and_leaves_unmatched_none() {
        let leads = vec![LeadRecord {
            id: "lead-short".to_string(),
            session_id: String::new(),
            target_dir: String::new(),
            launched_at: 0,
            approved_members: vec![],
            label: None,
            ai_title: None,
            internal_id: Some("internal-1".to_string()),
            auto_stall_nudge: None,
            secret: None,
            mcp_token: None,
        }];
        let alerts = vec![sample_alert("a", "internal-1"), sample_alert("b", "internal-unknown")];
        let result = attach_lead_ids(alerts, &leads);
        assert_eq!(result[0].lead_id.as_deref(), Some("lead-short"));
        assert_eq!(result[1].lead_id, None);
    }

    #[test]
    fn build_prompt_contains_member_desc_and_tail_text() {
        let prompt = build_stall_classifier_prompt("사용자: 안녕\n팀장: 네", "팀원 abc가 5분째 idle 상태로 멈춰있습니다.");
        assert!(prompt.contains("팀원 abc가 5분째 idle 상태로 멈춰있습니다."));
        assert!(prompt.contains("사용자: 안녕\n팀장: 네"));
        assert!(prompt.contains("shouldNudge"));

        let empty_tail = build_stall_classifier_prompt("", "desc");
        assert!(empty_tail.contains("(대화 기록 없음)"));
    }

    // 실제 claude -p --model haiku 왕복이 되는지 확인하는 통합 테스트 — 비용이 드니 최소한으로만
    // (이거 하나) 돌린다. LLM 출력의 정확한 판단 내용까지 검증하진 않고(비결정적일 수 있음),
    // 구조(파싱 가능한 JSON 응답)만 확인한다.
    #[test]
    fn run_stall_classifier_real_haiku_roundtrip() {
        let tail = "사용자: 팀원 A의 작업이 끝났다고 보고가 왔어\n팀장: 확인했습니다. 다음 작업으로 넘어가겠습니다.\n\n사용자: 이제 B 작업도 마저 지시해줘\n팀장: 네, B 작업을 지시했습니다.";
        let desc = "팀원 test-member(역할: implementer)가 15분째 idle 상태로 멈춰있습니다.";
        let verdict = run_stall_classifier(tail, desc);
        assert!(verdict.is_some(), "claude -p --model haiku 호출이 파싱 가능한 verdict를 돌려줘야 한다 — PATH에 claude가 있는지 확인 필요");
        let v = verdict.unwrap();
        assert!(!v.reason.is_empty(), "reason은 항상 채워져야 한다(스키마상 필수는 아니지만 Haiku가 보통 채움)");
    }
}
