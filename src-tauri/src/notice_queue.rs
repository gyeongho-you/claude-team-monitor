// 서브청크 δ(TAURI_NOTICE_QUEUE_DESIGN.md §2, 이 설계 문서가 다루는 마지막 서브청크) — 알림 큐
// (queueLeadNotice/deliverPendingNotices/combinePendingNoticeMessages/migratePendingNotices/
// cancelQueuedNotice/notifyLeadsOfFinishedMembers/isLeadTooBusyToInterrupt)와 그걸 소비하는
// IPC(send-to-lead/launch-member/stop-background-session/approve-request/deny-request/
// restart-lead/end-lead-work/cancel-queued-message/get-pending-notice-ids)의 포팅.
//
// 포함 사고: C-1~C-2(단, C-2의 buildSessionRowsChain은 α에서 이미 포팅됨 — live_rows.rs의
// session_rows_lock을 그대로 쓴다), D-1~D-10.
//
// 필수 재사용: α의 queue_lead_operation(concurrency.rs), β의 resume_lead/with_leads_lock/
// stop_session(resume.rs/session_registry.rs), γ의 launch_member/restart_lead/end_lead_work
// (lead_lifecycle.rs). 이 파일은 이들을 그대로 호출만 하고 새로운 동시성 primitive를 발명하지
// 않는다 — 단 하나 예외가 아래 with_pending_notices_lock인데, 이건 leads.json 전용
// with_leads_lock(session_registry.rs)을 pendingNotices.json에 맞게 복제한 것이지(β 리뷰가
// 지적한 leads.json lost update와 같은 클래스의 문제가 재발하면 안 된다는 지시), 새로운 설계가
// 아니다.

use crate::agents_json::{fetch_agents_typed_async, get_status, AgentEntry};
use crate::board_state::{is_attach_terminal_open_for, state};
use crate::concurrency::queue_lead_operation;
use crate::json_file::write_json_file_atomic;
use crate::live_rows::SessionRow;
use crate::logging::log_critical;
use crate::member_requests::write_request_decision;
use crate::paths::pending_notices_path;
use crate::resume::{resume_lead, stop_session};
use crate::session_registry::{load_leads, with_leads_lock, LeadRecord};
use crate::timing::{now_ms, MAX_NOTICE_DELIVERY_ATTEMPTS};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex as AsyncMutex;

// ---------------------------------------------------------------------------------------------
// PendingNotice(main.ts:347) — origin은 이 알림이 사용자가 직접 보낸 채팅 메시지인지('user',
// send-to-lead 경로)인지, 시스템이 자동으로 만든 알림인지('system', 팀원 완료 알림 등)를 구분한다
// (D-1). attempts는 deliverPendingNotices가 배달(resumeLead)을 시도했다가 실패해서 큐에 되돌린
// 횟수(D-9 회로차단기의 근거값).
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NoticeOrigin {
    User,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingNotice {
    pub id: String,
    #[serde(rename = "leadInternalId")]
    pub lead_internal_id: String,
    pub message: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    pub origin: NoticeOrigin,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<i64>,
}

// ---------------------------------------------------------------------------------------------
// migratePendingNotices(main.ts:746-781) — D-10. origin 분리 리팩터 이전에 만들어진 구버전 항목은
// leadInternalId 대신 leadId(짧은 id)만 있고 origin 필드가 아예 없다. 매 로드마다 이 마이그레이션을
// 거친다(loadLeads의 internalId 백필과 같은 패턴).
//
// main.ts 대비 고친 점(버그 수정): main.ts의 migratePendingNotices는 재구성한 객체 리터럴에
// item.attempts를 옮기지 않는다 — 그 결과 로드할 때마다(다음 폴링마다) attempts가 무조건 0으로
// 리셋되어, D-9 회로차단기(MAX_NOTICE_DELIVERY_ATTEMPTS)가 attemptsSoFar를 항상 0으로만 보고
// 실질적으로 절대 작동하지 않는다(설계 문서가 D-9를 명시적으로 "반드시 재현" 대상으로 지정하고
// "상한 도달 후 정확히 멈추는지" 검증까지 요구한 것과 정면으로 모순된다 — 단순히 필드 하나를
// 객체 리터럴에서 빠뜨린 누락으로 보고, 포팅 시 attempts를 그대로 보존하도록 고쳤다). 아래
// migrate_pending_notices_preserves_attempts... 테스트가 이 보존을 검증한다.
// ---------------------------------------------------------------------------------------------

pub(crate) fn migrate_pending_notices(raw: Vec<serde_json::Value>, leads: &[LeadRecord]) -> (Vec<PendingNotice>, bool) {
    let mut notices = Vec::new();
    let mut dirty = false;
    for item in raw {
        let Some(obj) = item.as_object() else {
            dirty = true;
            continue;
        };
        let mut lead_internal_id = obj.get("leadInternalId").and_then(|v| v.as_str()).map(str::to_string);
        if lead_internal_id.is_none() {
            if let Some(lead_id) = obj.get("leadId").and_then(|v| v.as_str()) {
                match leads.iter().find(|l| l.id == lead_id) {
                    Some(lead) => {
                        lead_internal_id = lead.internal_id.clone();
                        dirty = true;
                    }
                    None => {
                        // 이미 사라진(재시작 등으로 짧은 id가 바뀌었거나 완전히 없어진) 팀장이면
                        // 더 전달할 대상이 없다 — 계속 들고 있어봐야 영원히 배달 못 된다.
                        dirty = true;
                        continue;
                    }
                }
            }
        }
        let Some(lead_internal_id) = lead_internal_id else {
            dirty = true; // 둘 다 없으면(알 수 없는 포맷) 버린다
            continue;
        };
        let message = obj.get("message").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let origin = match obj.get("origin").and_then(|v| v.as_str()) {
            Some("user") => NoticeOrigin::User,
            Some("system") => NoticeOrigin::System,
            _ => {
                dirty = true;
                // origin이 없던 구버전 항목은 문구로 추론한다(isAutoInjectedPrompt와 같은 판별).
                if message.starts_with("[알림]") || message.contains("<task-notification>") {
                    NoticeOrigin::System
                } else {
                    NoticeOrigin::User
                }
            }
        };
        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("notice-{}-{}", now_ms(), uuid::Uuid::new_v4().simple()));
        let created_at = obj.get("createdAt").and_then(|v| v.as_i64()).unwrap_or_else(now_ms);
        let attempts = obj.get("attempts").and_then(|v| v.as_i64());
        notices.push(PendingNotice { id, lead_internal_id, message, created_at, origin, attempts });
    }
    (notices, dirty)
}

fn read_raw_notices_from(path: &Path) -> Vec<serde_json::Value> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Array(items)) => items,
        _ => Vec::new(),
    }
}

// loadPendingNotices(main.ts:783-790)와 동일한 관례 — load_leads_from(session_registry.rs)이
// internalId 백필을 락 없이 즉시 저장하는 것과 같은 이유로, 마이그레이션 저장도 락을 거치지 않는다
// (이 함수 자체가 이미 with_pending_notices_lock_at의 "읽기" 단계로 재사용되므로, 여기서 락을 다시
// 잡으면 데드락이 된다).
pub(crate) fn load_pending_notices_from(path: &Path) -> Vec<PendingNotice> {
    let raw = read_raw_notices_from(path);
    let leads = load_leads();
    let (notices, dirty) = migrate_pending_notices(raw, &leads);
    if dirty {
        save_pending_notices_to(path, &notices);
    }
    notices
}

/// loadPendingNotices(main.ts)와 동일 — 읽기 전용 호출부(get-pending-notice-ids 등)는 락 없이
/// 이 함수를 직접 쓴다(load_leads()가 읽기 전용 호출부에서 락 없이 쓰이는 것과 같은 판단).
pub fn load_pending_notices() -> Vec<PendingNotice> {
    load_pending_notices_from(&pending_notices_path())
}

fn save_pending_notices_to(path: &Path, notices: &[PendingNotice]) {
    if let Err(e) = write_json_file_atomic(path, &notices) {
        eprintln!("[save_pending_notices] pendingNotices.json 저장 실패: {e}");
    }
}

// ---------------------------------------------------------------------------------------------
// pendingNotices.json 전용 전역 락 — with_leads_lock(session_registry.rs)과 정확히 같은 이유·
// 같은 구조. β 리뷰에서 leads.json에 대해 실측 재현된 lost update(서로 다른 internalId를 향한
// 쓰기가 각자 "쓰기 직전 재조회" 사이클을 밟다가 겹치면 한쪽이 사라짐)와 같은 클래스의 문제가
// pendingNotices.json에도 그대로 재발할 수 있다 — send-to-lead(사용자 메시지 큐잉)와
// deliverPendingNotices(배달 실패 시 requeue)가 서로 다른 internalId를 향해 동시에 이 파일을
// 읽고-고치고-쓸 수 있기 때문이다(queue_lead_operation은 internalId별로만 직렬화하므로 서로 다른
// 팀장을 향한 큐 조작끼리는 이 락 없이는 전혀 직렬화되지 않는다).
// ---------------------------------------------------------------------------------------------

fn pending_notices_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

// deliver_pending_notices(및 이걸 부르는 live_rows.rs의 폴링 배선)는 cargo test 중에는
// #[cfg(not(test))]로 아예 컴파일되지 않는다(이 저장소가 지금 실제 팀장/팀원 세션으로 운영 중이라,
// 테스트가 실제 leads.json/pendingNotices.json에 resume_lead까지 걸면 위험하다 — live_rows.rs의
// 해당 cfg 게이트 주석 참고). 그래서 test 빌드에서는 이 함수와, 오직 이 함수만 부르는
// with_pending_notices_lock/real_delivery_ports가 도달 불가능(dead_code)해진다 — 프로덕션
// 빌드에서는 셋 다 실제로 쓰이므로 test cfg에서만 경고를 죽인다.
#[cfg_attr(test, allow(dead_code))]
pub async fn with_pending_notices_lock<F, R>(mutate: F) -> R
where
    F: FnOnce(&mut Vec<PendingNotice>) -> (bool, R),
{
    with_pending_notices_lock_at(&pending_notices_path(), pending_notices_lock(), mutate).await
}

pub(crate) async fn with_pending_notices_lock_at<F, R>(path: &Path, lock: &AsyncMutex<()>, mutate: F) -> R
where
    F: FnOnce(&mut Vec<PendingNotice>) -> (bool, R),
{
    let _guard = lock.lock().await;
    let mut notices = load_pending_notices_from(path);
    let (dirty, result) = mutate(&mut notices);
    if dirty {
        save_pending_notices_to(path, &notices);
    }
    result
}

// ---------------------------------------------------------------------------------------------
// queueLeadNotice/cancelQueuedNotice(main.ts:822-847)
// ---------------------------------------------------------------------------------------------

pub(crate) async fn queue_lead_notice_at(
    path: &Path,
    lock: &AsyncMutex<()>,
    lead_internal_id: &str,
    message: &str,
    origin: NoticeOrigin,
) -> String {
    let id = format!("notice-{}-{}", now_ms(), uuid::Uuid::new_v4().simple());
    let notice = PendingNotice {
        id: id.clone(),
        lead_internal_id: lead_internal_id.to_string(),
        message: message.to_string(),
        created_at: now_ms(),
        origin,
        attempts: None,
    };
    with_pending_notices_lock_at(path, lock, move |notices| {
        notices.push(notice);
        (true, ())
    })
    .await;
    id
}

/// queueLeadNotice(main.ts)와 동일 — 생성한 알림의 id를 반환한다.
pub async fn queue_lead_notice(lead_internal_id: &str, message: &str, origin: NoticeOrigin) -> String {
    queue_lead_notice_at(&pending_notices_path(), pending_notices_lock(), lead_internal_id, message, origin).await
}

pub(crate) async fn cancel_queued_notice_at(
    path: &Path,
    lock: &AsyncMutex<()>,
    lead_internal_id: Option<String>,
    notice_id: &str,
) -> bool {
    with_pending_notices_lock_at(path, lock, move |notices| {
        let before = notices.len();
        notices.retain(|n| {
            if n.id != notice_id {
                return true;
            }
            match &lead_internal_id {
                // 짧은 id로 못 찾았더라도(재시작 등으로 드리프트) noticeId 자체가 전역적으로
                // 고유하므로 사용자가 화면에서 보고 누른 항목은 항상 취소돼야 한다(main.ts 주석과
                // 동일) — 그래서 lead_internal_id가 None이면 id 일치만으로 제거한다.
                Some(iid) if &n.lead_internal_id != iid => true,
                _ => false,
            }
        });
        let changed = notices.len() != before;
        (changed, changed)
    })
    .await
}

/// cancelQueuedNotice(main.ts)와 동일 — 렌더러는 짧은 id만 알고 있으므로 internalId로 변환해서
/// 대조한다. 이미 전달됐거나 이미 취소돼서 못 찾으면 false.
pub async fn cancel_queued_notice(lead_short_id: &str, notice_id: &str) -> bool {
    let lead_internal_id = load_leads().into_iter().find(|l| l.id == lead_short_id).and_then(|l| l.internal_id);
    cancel_queued_notice_at(&pending_notices_path(), pending_notices_lock(), lead_internal_id, notice_id).await
}

// ---------------------------------------------------------------------------------------------
// combinePendingNoticeMessages(main.ts:1164-1168)
// ---------------------------------------------------------------------------------------------

pub(crate) fn combine_pending_notice_messages(notices: &[PendingNotice]) -> String {
    if notices.len() == 1 {
        return notices[0].message.clone();
    }
    let lines: Vec<String> = notices.iter().enumerate().map(|(i, n)| format!("{}) {}", i + 1, n.message)).collect();
    format!("[대기 중이던 메시지 {}건을 순서대로 전달합니다]\n\n{}", notices.len(), lines.join("\n\n"))
}

// ---------------------------------------------------------------------------------------------
// isLeadTooBusyToInterrupt(main.ts:209-211) — D-3/D-4/D-5. getStatus()만 본다(state 필드는
// 절대 보지 않는다 — 한번 고쳤다가 되돌린 이력이 있는 코드다, main.ts 주석 참고: state==='working'을
// 바쁨 신호로 쓰면 끝났는데도 계속 working으로 고정된 세션(d53632df 실사용 확인)의 큐 메시지가
// 영원히 배달 안 되는, 원래 막으려던 포크 사고보다 더 나쁜 결과로 이어진다). waitingFor==='input
// needed'(AskUserQuestion으로 멈춘 상태, D-5)도 같이 막는다 — 자동 배달이 stop→resume을 걸면
// 선택지가 declined 처리된다.
// ---------------------------------------------------------------------------------------------

pub fn is_lead_too_busy_to_interrupt(agent: &AgentEntry) -> bool {
    get_status(agent.status.as_deref(), agent.state.as_deref()) == "busy" || agent.waiting_for.as_deref() == Some("input needed")
}

// ---------------------------------------------------------------------------------------------
// notifyLeadsOfFinishedMembers(main.ts:923-941) — 팀원이 busy → idle/done으로 바뀌는 순간을
// 감지해서 팀장 큐에 확인 알림을 쌓는다. board_state의 last_member_status 맵으로 "마지막으로 본
// 상태"를 기억한다(main.ts의 lastMemberStatus 모듈 스코프 Map과 동일 — 키는 세션이 아니라 짧은
// id다, main.ts 원본 그대로).
//
// compute_finished_member_notifications는 판정+맵 갱신을 하나의 짧은 락 안에서 원자적으로 끝내는
// 순수(디스크 I/O 없는) 부분이다 — 두 폴링(또는 즉시 새로고침과 겹친 폴링)의 notify 호출이 거의
// 동시에 같은 팀원 행을 보게 되더라도, "상태 비교"와 "맵 갱신"이 한 번의 락 안에서 함께 일어나므로
// 어느 한쪽만 전이를 감지하고 맵을 갱신하며, 다른 한쪽은 이미 갱신된 값을 보고 전이가 아니라고
// 판단한다(중복 알림 방지). 실제 큐잉(queue_lead_notice, 파일 I/O + 락)은 이 맵 락을 놓은 뒤에
// 한다 — 파일 I/O를 board_state의 std::sync::Mutex 밑에서 하지 않기 위함.
// ---------------------------------------------------------------------------------------------

pub(crate) fn compute_finished_member_notifications(live_rows: &[SessionRow], leads: &[LeadRecord]) -> Vec<(String, String)> {
    let mut to_notify: Vec<(String, String)> = Vec::new();
    let mut guard = state().lock().unwrap();
    for row in live_rows.iter().filter(|r| !r.is_lead) {
        let Some(id) = row.agent.id.clone() else { continue };
        let status = get_status(row.agent.status.as_deref(), row.agent.state.as_deref());
        let prev = guard.last_member_status.get(&id).cloned();
        if prev.as_deref() == Some("busy") && !status.is_empty() && status != "busy" {
            if let Some(lead_short_id) = &row.lead_id {
                if let Some(lead_rec) = leads.iter().find(|l| &l.id == lead_short_id) {
                    if let Some(internal_id) = lead_rec.internal_id.clone() {
                        let role_part = row.role.as_deref().map(|r| format!(", 역할: {r}")).unwrap_or_default();
                        let message = format!(
                            "[알림] 팀원 {id}({}{role_part})가 작업을 마친 것 같습니다(상태: {status}). stop→resume으로 \"방금 한 작업을 한국어로 짧게 요약해줘\"처럼 확인하고, 결과를 파악해서 필요하면 최종 보고에 반영하세요.",
                            row.agent.cwd
                        );
                        to_notify.push((internal_id, message));
                    }
                }
            }
        }
        if !status.is_empty() {
            guard.last_member_status.insert(id, status);
        }
    }
    to_notify
}

async fn notify_leads_of_finished_members_with_queue<F, Fut>(live_rows: &[SessionRow], leads: &[LeadRecord], queue: F)
where
    F: Fn(String, String) -> Fut,
    Fut: Future<Output = String>,
{
    let to_notify = compute_finished_member_notifications(live_rows, leads);
    for (internal_id, message) in to_notify {
        queue(internal_id, message).await;
    }
}

/// notifyLeadsOfFinishedMembers(main.ts)와 동일. live_rows.rs의 #[cfg(not(test))] 폴링 배선에서만
/// 실제로 호출된다(위 with_pending_notices_lock 주석과 같은 이유로 test cfg에선 dead_code 경고를
/// 죽인다 — 이 함수 자체의 로직은 notify_leads_of_finished_members_with_queue/
/// compute_finished_member_notifications 테스트가 이미 커버한다).
#[cfg_attr(test, allow(dead_code))]
pub async fn notify_leads_of_finished_members(live_rows: &[SessionRow], leads: &[LeadRecord]) {
    notify_leads_of_finished_members_with_queue(live_rows, leads, |internal_id, message| async move {
        queue_lead_notice(&internal_id, &message, NoticeOrigin::System).await
    })
    .await;
}

// ---------------------------------------------------------------------------------------------
// deliverPendingNotices(main.ts:1181-1249) — 대기 중인 알림 중, 그 팀장이 지금 busy가 아니면
// stop→resume으로 실제 전달한다. leadInternalId + origin이 같은 것끼리만 하나로 합친다(D-1).
// blocked는 busy와 다르게 취급해 배달을 시도한다(D-3). attach 터미널이 열려있으면 시도 횟수를
// 소모하지 않고 이번 폴링만 건너뛴다(H-2). 상한(D-9)에 도달하면 자동 재시도를 멈추되 큐에서
// 제거하지 않는다.
//
// "실제 배달 시도"(resume, 최대 ~199초 걸릴 수 있음)를 테스트에서 실제 claude 프로세스 없이
// 결정론적으로 재현하려고(§2-δ "독립적 검증 가능성", D-6/D-9 요구사항) resume/attach 판정을
// DeliveryPorts로 추상화한다 — β의 ResumePorts와 같은 정신.
// ---------------------------------------------------------------------------------------------

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone)]
struct DeliveryPorts {
    // (leadInternalId, message) -> resumeLead 결과(짧은 id 또는 실패 시 None).
    resume: Arc<dyn Fn(String, String) -> BoxFuture<Option<String>> + Send + Sync>,
    // 세션 짧은 id -> attach 터미널이 열려있는지.
    is_attach_terminal_open: Arc<dyn Fn(String) -> bool + Send + Sync>,
}

/// resumeLead를 queue_lead_operation으로 감싸 호출하는 공통 진입점 — β의 resume_lead_command와
/// 정확히 같은 이중 방어(내부 job이 panic해도 이 함수 자체는 패닉하지 않고 None을 반환하고
/// app.log에 흔적을 남긴다)를 send-to-lead/approve-request/deny-request/deliverPendingNotices가
/// 각자 따로 구현하지 않고 공유한다.
async fn resume_via_queue(internal_id: String, message: String) -> Option<String> {
    let queue_key = internal_id.clone();
    let job_internal_id = internal_id.clone();
    let handle = tokio::spawn(async move { queue_lead_operation(&queue_key, move || resume_lead(job_internal_id, message)).await });
    match handle.await {
        Ok(result) => result,
        Err(join_err) => {
            log_critical(&format!(
                "[resume_via_queue] 팀장 {internal_id} resume 큐 작업이 panic했습니다(있어서는 안 되는 상황) — {join_err}"
            ));
            None
        }
    }
}

#[cfg_attr(test, allow(dead_code))]
fn real_delivery_ports() -> DeliveryPorts {
    DeliveryPorts {
        resume: Arc::new(|internal_id, message| Box::pin(resume_via_queue(internal_id, message))),
        is_attach_terminal_open: Arc::new(|id| is_attach_terminal_open_for(&id)),
    }
}

fn group_key(n: &PendingNotice) -> String {
    let origin = match n.origin {
        NoticeOrigin::User => "user",
        NoticeOrigin::System => "system",
    };
    format!("{}|{origin}", n.lead_internal_id)
}

/// byLeadAndOrigin(main.ts) 재현 — Map 삽입 순서를 그대로 보존한다(순서가 결과에 영향을 주진
/// 않지만, main.ts의 "원래 쌓인 순서 그대로" 의도를 그대로 옮긴다).
pub(crate) fn group_by_lead_and_origin(notices: Vec<PendingNotice>) -> Vec<(String, Vec<PendingNotice>)> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<PendingNotice>> = HashMap::new();
    for n in notices {
        let key = group_key(&n);
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(n);
    }
    order.into_iter().map(|k| { let v = groups.remove(&k).unwrap_or_default(); (k, v) }).collect()
}

#[derive(Debug, PartialEq, Eq)]
enum GroupDecision {
    Deliver { internal_id: String },
    Keep, // attach 열림 / 상한 도달 / 팀장 못 찾음 또는 오프라인 / busy 중 하나
}

fn decide_group(notices: &[PendingNotice], lead_rec: Option<&LeadRecord>, live_agent: Option<&AgentEntry>, attach_open: bool) -> GroupDecision {
    if attach_open {
        return GroupDecision::Keep;
    }
    let attempts_so_far = notices.iter().map(|n| n.attempts.unwrap_or(0)).max().unwrap_or(0);
    if attempts_so_far >= MAX_NOTICE_DELIVERY_ATTEMPTS {
        return GroupDecision::Keep;
    }
    match (lead_rec, live_agent) {
        (Some(lead), Some(agent)) if !is_lead_too_busy_to_interrupt(agent) => match lead.internal_id.clone() {
            Some(internal_id) => GroupDecision::Deliver { internal_id },
            None => GroupDecision::Keep, // internalId 없는 낡은 레코드는 큐/재개 모두 못 탄다
        },
        _ => GroupDecision::Keep,
    }
}

type DeliveryJob = (String, String, Vec<PendingNotice>); // (leadInternalId, combinedMessage, attemptedNotices)

/// deliverPendingNotices의 "큐에서 뺄지 결정" 단계 — with_pending_notices_lock(_at) 안에서
/// 원자적으로 실행돼야 한다(디스크에서 읽은 뒤 배달 대상을 큐에서 제거하는 전체가 하나의
/// read-modify-write 사이클). attach 판정(ports.is_attach_terminal_open)까지 이 동기 함수 안에서
/// 끝낸다 — is_attach_terminal_open_for 자체는 블로킹이지만 이 락 스코프 안에서 io를 하는 건
/// with_leads_lock의 다른 호출부(예: restart_lead)도 이미 하는 것과 같은 수준이다.
fn deliver_dequeue_step(current: &mut Vec<PendingNotice>, agents: &[AgentEntry], leads: &[LeadRecord], ports: &DeliveryPorts) -> (bool, Vec<DeliveryJob>) {
    if current.is_empty() {
        return (false, Vec::new());
    }
    let original_len = current.len();
    let pending = std::mem::take(current);
    let groups = group_by_lead_and_origin(pending);

    let mut still_pending: Vec<PendingNotice> = Vec::new();
    let mut to_deliver: Vec<DeliveryJob> = Vec::new();

    for (_key, notices) in groups {
        let lead_rec = leads.iter().find(|l| l.internal_id.as_deref() == Some(notices[0].lead_internal_id.as_str()));
        let live_agent = lead_rec.and_then(|l| agents.iter().find(|a| a.id.as_deref() == Some(l.id.as_str())));
        let attach_open = live_agent.and_then(|a| a.id.clone()).map(|id| (ports.is_attach_terminal_open)(id)).unwrap_or(false);

        match decide_group(&notices, lead_rec, live_agent, attach_open) {
            GroupDecision::Deliver { internal_id } => {
                let message = combine_pending_notice_messages(&notices);
                let attempted: Vec<PendingNotice> =
                    notices.into_iter().map(|n| PendingNotice { attempts: Some(n.attempts.unwrap_or(0) + 1), ..n }).collect();
                to_deliver.push((internal_id, message, attempted));
            }
            GroupDecision::Keep => still_pending.extend(notices),
        }
    }

    *current = still_pending;
    let dirty = current.len() != original_len;
    (dirty, to_deliver)
}

/// resumeLead(D-6)가 None을 반환하거나(정상 실패) 큐 작업 자체가 panic해도(resume_via_queue가
/// 흡수) 이미 큐에서 빠진 이 알림들을 다시 큐로 되돌린다. requeuePendingNotices(main.ts)와 동일한
/// "그 사이 다른 경로가 새로 쌓아뒀을 수 있는 항목을 안 덮어쓴다"는 성질을 with_pending_notices_lock
/// (extend, 덮어쓰기 아님)으로 그대로 얻는다.
async fn dispatch_delivery(path: std::path::PathBuf, lock: &'static AsyncMutex<()>, internal_id: String, message: String, attempted_notices: Vec<PendingNotice>, ports: DeliveryPorts) {
    let result = (ports.resume)(internal_id.clone(), message).await;
    if result.is_some() {
        return;
    }
    let attempts = attempted_notices.first().and_then(|n| n.attempts).unwrap_or(0);
    log_critical(&format!(
        "[deliverPendingNotices] 팀장 {internal_id} 알림 배달(resume)이 실패해 큐에 되돌립니다(시도 {attempts}/{MAX_NOTICE_DELIVERY_ATTEMPTS})."
    ));
    if attempts >= MAX_NOTICE_DELIVERY_ATTEMPTS {
        log_critical(&format!(
            "[deliverPendingNotices] 팀장 {internal_id} 알림이 {MAX_NOTICE_DELIVERY_ATTEMPTS}회 연속 실패해 자동 재시도를 멈춥니다 — 채팅창에서 직접 취소하거나 다시 보내야 합니다."
        ));
    }
    with_pending_notices_lock_at(&path, lock, |current| {
        current.extend(attempted_notices);
        (true, ())
    })
    .await;
}

/// deliverPendingNotices(main.ts)와 동일 — 호출부(live_rows.rs의 폴링)는 이 함수를
/// fire-and-forget(tokio::spawn)으로 건다. resume 시도 자체는 최악의 경우 STOP_AND_RELAUNCH_
/// WORST_CASE_MS(~199초)까지 걸릴 수 있으므로, 이 함수를 await하는 호출부가 그만큼 막혀서는
/// 안 된다(main.ts도 이 함수를 await하지 않는다).
#[cfg_attr(test, allow(dead_code))]
pub async fn deliver_pending_notices(agents: &[AgentEntry], leads: &[LeadRecord]) {
    let ports = real_delivery_ports();
    let to_deliver = with_pending_notices_lock(|current| deliver_dequeue_step(current, agents, leads, &ports)).await;
    for (internal_id, message, attempted) in to_deliver {
        let ports_clone = ports.clone();
        tokio::spawn(dispatch_delivery(pending_notices_path(), pending_notices_lock(), internal_id, message, attempted, ports_clone));
    }
}

// ---------------------------------------------------------------------------------------------
// send-to-lead(main.ts:2709-2742) IPC
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum SendToLeadResult {
    NotFound,
    AttachOpen,
    Queued { id: String },
    Sent { id: String },
    Failed,
}

#[tauri::command]
pub async fn send_to_lead_command(lead_id: String, message: String) -> SendToLeadResult {
    let Some(lead) = load_leads().into_iter().find(|l| l.id == lead_id) else {
        return SendToLeadResult::NotFound;
    };
    // H-2: attach 터미널이 아직 붙어있으면 여기서 stop→resume을 걸었다가 attach 쪽의 독립적인
    // 재연결 시도와 경합해 daemon이 복사본을 만들 수 있다. 큐로 돌리지 않고(그러면 영원히 안
    // 풀릴 수 있다) 바로 실패로 알려서 사용자가 터미널을 닫고 다시 보내게 한다.
    if is_attach_terminal_open_for(&lead_id) {
        return SendToLeadResult::AttachOpen;
    }
    let Some(internal_id) = lead.internal_id.clone() else {
        return SendToLeadResult::Failed; // internalId 없는 낡은 레코드는 큐/재개 모두 못 탄다
    };
    let agents = fetch_agents_typed_async().await;
    let agent = agents.iter().find(|a| a.id.as_deref() == Some(lead_id.as_str()));
    let is_busy = agent.map(is_lead_too_busy_to_interrupt).unwrap_or(false);
    if is_busy {
        let id = queue_lead_notice(&internal_id, &message, NoticeOrigin::User).await;
        return SendToLeadResult::Queued { id };
    }
    match resume_via_queue(internal_id, message).await {
        Some(id) => SendToLeadResult::Sent { id },
        None => SendToLeadResult::Failed,
    }
}

// ---------------------------------------------------------------------------------------------
// cancel-queued-message / get-pending-notice-ids(main.ts:2745, 2784-2790) IPC
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn cancel_queued_message_command(lead_id: String, notice_id: String) -> bool {
    cancel_queued_notice(&lead_id, &notice_id).await
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingNoticeIdInfo {
    pub id: String,
    pub exhausted: bool,
}

#[tauri::command]
pub fn get_pending_notice_ids_command(lead_id: String) -> Vec<PendingNoticeIdInfo> {
    let Some(lead) = load_leads().into_iter().find(|l| l.id == lead_id) else { return Vec::new() };
    let Some(internal_id) = lead.internal_id else { return Vec::new() };
    load_pending_notices()
        .into_iter()
        .filter(|n| n.lead_internal_id == internal_id)
        .map(|n| PendingNoticeIdInfo { exhausted: n.attempts.unwrap_or(0) >= MAX_NOTICE_DELIVERY_ATTEMPTS, id: n.id })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// approve-request / deny-request(main.ts:2587-2632) IPC
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RequestDecisionOutcome {
    pub decided: bool,
    pub delivered: bool,
}

/// findLeadByShortIdWithReconcile(main.ts:2571-2580)의 축소판 — reconcile 폴백(B-3,
/// reconcileLeadIds)은 이번 청크 범위 밖이다(설계 문서 §2가 δ 대상으로 명시하지 않았고, live_rows.rs
/// 자신도 아직 이 함수를 안 쓴다). 짧은 id가 이 앱 밖 재시작으로 드리프트된 드문 순간에 승인/거부가
/// 팀장을 못 찾을 수 있다는 알려진 제약을 그대로 남긴다 — reconcileLeadIds가 포팅되면 이 함수
/// 안에 그대로 이어붙이면 된다.
async fn find_lead_by_short_id(short_id: &str) -> Option<LeadRecord> {
    load_leads().into_iter().find(|l| l.id == short_id)
}

#[tauri::command]
pub async fn approve_request_command(request_id: String) -> RequestDecisionOutcome {
    let Some(req) = write_request_decision(&request_id, "approved") else {
        return RequestDecisionOutcome { decided: false, delivered: false };
    };
    let Some(lead) = find_lead_by_short_id(&req.team_lead_id).await else {
        return RequestDecisionOutcome { decided: true, delivered: false };
    };
    let Some(internal_id) = lead.internal_id.clone() else {
        return RequestDecisionOutcome { decided: true, delivered: false };
    };

    if req.is_stop_member() {
        if let Some(member_id) = req.member_id.clone() {
            stop_session(member_id).await;
        }
        let message = format!(
            "팀원 종료 요청이 승인됐습니다 — \"{}\" 세션을 종료했습니다. 계속 진행하세요.",
            req.member_id.clone().unwrap_or_default()
        );
        let delivered = resume_via_queue(internal_id, message).await.is_some();
        return RequestDecisionOutcome { decided: true, delivered };
    }

    // E-1 패턴 — approvedMembers를 추가하는 leads.json 쓰기는 "쓰기 직전 재조회"를 보장하는
    // with_leads_lock(β)을 반드시 거친다(load_leads()+직접 push+save_leads를 락 없이 짝짓지 않는다).
    if let Some(dir) = req.requested_dir.clone() {
        let internal_id_for_lock = internal_id.clone();
        with_leads_lock(move |leads| {
            let Some(rec) = leads.iter_mut().find(|l| l.internal_id.as_deref() == Some(internal_id_for_lock.as_str())) else {
                return (false, ());
            };
            if !rec.approved_members.contains(&dir) {
                rec.approved_members.push(dir);
                return (true, ());
            }
            (false, ())
        })
        .await;
    }
    let message = format!(
        "팀원 요청이 승인됐습니다 — \"{}\"에 팀원을 띄워도 됩니다. 이어서 진행하세요.",
        req.requested_dir.clone().unwrap_or_default()
    );
    let delivered = resume_via_queue(internal_id, message).await.is_some();
    RequestDecisionOutcome { decided: true, delivered }
}

#[tauri::command]
pub async fn deny_request_command(request_id: String) -> RequestDecisionOutcome {
    let Some(req) = write_request_decision(&request_id, "denied") else {
        return RequestDecisionOutcome { decided: false, delivered: false };
    };
    let Some(lead) = find_lead_by_short_id(&req.team_lead_id).await else {
        return RequestDecisionOutcome { decided: true, delivered: false };
    };
    let Some(internal_id) = lead.internal_id.clone() else {
        return RequestDecisionOutcome { decided: true, delivered: false };
    };
    let message = if req.is_stop_member() {
        format!(
            "팀원 종료 요청이 거부됐습니다 — \"{}\"는 종료하지 말고 계속 두세요.",
            req.member_id.clone().unwrap_or_default()
        )
    } else {
        format!(
            "팀원 요청이 거부됐습니다 — \"{}\"에는 팀원을 띄우지 마세요. 다른 방법을 찾거나 사용자에게 다시 확인하세요.",
            req.requested_dir.clone().unwrap_or_default()
        )
    };
    let delivered = resume_via_queue(internal_id, message).await.is_some();
    RequestDecisionOutcome { decided: true, delivered }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_pending_notices_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_pending_notices_{tag}_{}.json", uuid::Uuid::new_v4()))
    }

    fn fake_lead(internal_id: &str, id: &str) -> LeadRecord {
        LeadRecord {
            id: id.to_string(),
            session_id: format!("{id}-session"),
            target_dir: "C:\\fake".to_string(),
            launched_at: 1_000,
            approved_members: Vec::new(),
            label: None,
            ai_title: None,
            internal_id: Some(internal_id.to_string()),
            auto_stall_nudge: None,
            secret: None,
            startup_warning: None,
        }
    }

    fn fake_agent(id: &str, status: &str) -> AgentEntry {
        AgentEntry {
            id: Some(id.to_string()),
            pid: None,
            cwd: "C:\\fake".to_string(),
            kind: "background".to_string(),
            started_at: None,
            session_id: format!("{id}-session"),
            name: None,
            status: Some(status.to_string()),
            state: None,
            waiting_for: None,
        }
    }

    fn fake_notice(id: &str, lead_internal_id: &str, origin: NoticeOrigin) -> PendingNotice {
        PendingNotice { id: id.to_string(), lead_internal_id: lead_internal_id.to_string(), message: format!("msg-{id}"), created_at: 1_000, origin, attempts: None }
    }

    // ------------------------------------------------------------------------------------
    // D-1: origin 분리 — 같은 팀장이어도 origin이 다르면 절대 같은 그룹으로 안 묶인다.
    // ------------------------------------------------------------------------------------

    #[test]
    fn group_by_lead_and_origin_never_merges_different_origins() {
        let notices = vec![fake_notice("1", "lead-a", NoticeOrigin::User), fake_notice("2", "lead-a", NoticeOrigin::System)];
        let groups = group_by_lead_and_origin(notices);
        assert_eq!(groups.len(), 2, "같은 팀장이어도 origin이 다르면 절대 같은 그룹으로 묶이면 안 된다(D-1)");
    }

    #[test]
    fn group_by_lead_and_origin_merges_same_lead_and_origin_preserving_order() {
        let notices = vec![fake_notice("1", "lead-a", NoticeOrigin::System), fake_notice("2", "lead-a", NoticeOrigin::System), fake_notice("3", "lead-b", NoticeOrigin::System)];
        let groups = group_by_lead_and_origin(notices);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].1.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(), vec!["1", "2"]);
    }

    // ------------------------------------------------------------------------------------
    // D-3/D-4/D-5: isLeadTooBusyToInterrupt
    // ------------------------------------------------------------------------------------

    #[test]
    fn is_lead_too_busy_only_blocks_status_busy_not_state_working() {
        // D-4: state==='working'은 절대 바쁨으로 보면 안 된다(한번 고쳤다가 되돌린 이력).
        let mut agent = fake_agent("lead1", "idle");
        agent.state = Some("working".to_string());
        assert!(!is_lead_too_busy_to_interrupt(&agent), "status가 idle이면 state가 working이어도 바쁨이 아니어야 한다(D-4)");

        assert!(is_lead_too_busy_to_interrupt(&fake_agent("lead1", "busy")), "status==='busy'는 바쁨이어야 한다");
    }

    #[test]
    fn is_lead_too_busy_blocks_input_needed_regardless_of_status() {
        // D-5: waitingFor==='input needed'는 status와 무관하게 막아야 한다.
        let mut agent = fake_agent("lead1", "idle");
        agent.waiting_for = Some("input needed".to_string());
        assert!(is_lead_too_busy_to_interrupt(&agent), "waitingFor==='input needed'는 status와 무관하게 바쁨 취급해야 한다(D-5)");
    }

    #[test]
    fn is_lead_too_busy_allows_blocked_status_through() {
        // D-3: blocked는 busy와 다르게 취급 — isLeadTooBusyToInterrupt 자체는 blocked를 안 막는다
        // (blocked도 배달을 "시도"해야 하므로, resumeLead 안의 안전장치가 포크 방지를 맡는다).
        assert!(!is_lead_too_busy_to_interrupt(&fake_agent("lead1", "blocked")), "blocked는 busy와 다르게 취급해 배달을 시도해야 한다(D-3)");
    }

    // ------------------------------------------------------------------------------------
    // migrate_pending_notices — D-10 + attempts 보존(버그 수정) 검증.
    // ------------------------------------------------------------------------------------

    #[test]
    fn migrate_pending_notices_converts_legacy_lead_id_to_internal_id_and_infers_system_origin() {
        let leads = vec![fake_lead("internal-x", "short-x")];
        let raw = vec![serde_json::json!({"id":"n1","leadId":"short-x","message":"[알림] 팀원 완료","createdAt":123})];
        let (notices, dirty) = migrate_pending_notices(raw, &leads);
        assert!(dirty);
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].lead_internal_id, "internal-x");
        assert_eq!(notices[0].origin, NoticeOrigin::System, "[알림] 접두어는 system으로 추론돼야 한다");
    }

    #[test]
    fn migrate_pending_notices_infers_user_origin_for_plain_messages() {
        let leads = vec![fake_lead("internal-x", "short-x")];
        let raw = vec![serde_json::json!({"id":"n1","leadId":"short-x","message":"그냥 채팅 메시지","createdAt":123})];
        let (notices, _dirty) = migrate_pending_notices(raw, &leads);
        assert_eq!(notices[0].origin, NoticeOrigin::User);
    }

    #[test]
    fn migrate_pending_notices_drops_items_whose_legacy_lead_id_no_longer_exists() {
        let leads: Vec<LeadRecord> = Vec::new();
        let raw = vec![serde_json::json!({"id":"n1","leadId":"gone","message":"hi","createdAt":123})];
        let (notices, dirty) = migrate_pending_notices(raw, &leads);
        assert!(dirty);
        assert!(notices.is_empty(), "찾을 수 없는 팀장을 가리키는 구버전 항목은 버려야 한다");
    }

    #[test]
    fn migrate_pending_notices_preserves_attempts_field_so_the_circuit_breaker_actually_works() {
        // main.ts의 migratePendingNotices는 매 로드마다 item.attempts를 새 객체에 옮기지 않는
        // 잠재 버그가 있어(§ 파일 상단 주석 참고) D-9 회로차단기가 실질적으로 절대 작동하지
        // 않는다 — 이 포팅에서는 attempts를 그대로 보존해서 실제로 동작하게 고쳤다.
        let leads: Vec<LeadRecord> = Vec::new();
        let raw = vec![serde_json::json!({
            "id":"n1","leadInternalId":"internal-x","message":"hi","createdAt":123,"origin":"user","attempts":4
        })];
        let (notices, dirty) = migrate_pending_notices(raw, &leads);
        assert!(!dirty, "이미 최신 포맷이면 dirty가 아니어야 한다");
        assert_eq!(notices[0].attempts, Some(4));
    }

    #[test]
    fn migrate_pending_notices_drops_malformed_non_object_items() {
        let raw = vec![serde_json::json!("이건 객체가 아님"), serde_json::json!(42)];
        let (notices, dirty) = migrate_pending_notices(raw, &[]);
        assert!(dirty);
        assert!(notices.is_empty());
    }

    // ------------------------------------------------------------------------------------
    // pendingNotices.json 동시 쓰기 — β의 leads.json 테스트와 같은 패턴(가상 시계, 결정적 재현).
    // "이번 청크에서 제일 꼼꼼히 봐야 하는" 부분(가장 최근 발견된 치명적 버그와 같은 클래스).
    // ------------------------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn pending_notices_lost_update_is_reproducible_without_the_lock() {
        let path = temp_pending_notices_path("unlocked");
        save_pending_notices_to(&path, &[]);

        let path_a = path.clone();
        let task_a = tokio::spawn(async move {
            let mut notices = load_pending_notices_from(&path_a);
            tokio::time::sleep(Duration::from_millis(30)).await;
            notices.push(fake_notice("notice-a", "lead-a", NoticeOrigin::User));
            save_pending_notices_to(&path_a, &notices);
        });
        let path_b = path.clone();
        let task_b = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            let mut notices = load_pending_notices_from(&path_b);
            notices.push(fake_notice("notice-b", "lead-b", NoticeOrigin::User));
            save_pending_notices_to(&path_b, &notices);
        });
        let _ = tokio::join!(task_a, task_b);

        let final_notices = load_pending_notices_from(&path);
        let _ = std::fs::remove_file(&path);

        let has_a = final_notices.iter().any(|n| n.id == "notice-a");
        let has_b = final_notices.iter().any(|n| n.id == "notice-b");
        assert!(!(has_a && has_b), "락 없이 두 쓰기가 겹치면 lost update가 재현돼야 하는데 둘 다 반영됐다: {final_notices:?}");
        assert!(has_a, "나중에 쓰는 쪽(A, 가상 30ms)의 추가는 남아있어야 한다");
        assert!(!has_b, "먼저 읽고 나중에 덮어써지는 쪽(B)의 추가가 사라져야 한다(lost update)");
    }

    #[tokio::test(start_paused = true)]
    async fn with_pending_notices_lock_prevents_lost_update_under_concurrent_writes() {
        for (slow_a_ms, slow_b_ms) in [(30u64, 5u64), (5u64, 30u64)] {
            let path = temp_pending_notices_path("locked");
            let lock = AsyncMutex::new(());
            save_pending_notices_to(&path, &[]);

            let task_a = async {
                tokio::time::sleep(Duration::from_millis(slow_a_ms)).await;
                with_pending_notices_lock_at(&path, &lock, |notices| {
                    notices.push(fake_notice("notice-a", "lead-a", NoticeOrigin::User));
                    (true, ())
                })
                .await;
            };
            let task_b = async {
                tokio::time::sleep(Duration::from_millis(slow_b_ms)).await;
                with_pending_notices_lock_at(&path, &lock, |notices| {
                    notices.push(fake_notice("notice-b", "lead-b", NoticeOrigin::User));
                    (true, ())
                })
                .await;
            };
            tokio::join!(task_a, task_b);

            let final_notices = load_pending_notices_from(&path);
            let _ = std::fs::remove_file(&path);
            assert!(
                final_notices.iter().any(|n| n.id == "notice-a"),
                "slow_a={slow_a_ms}ms/slow_b={slow_b_ms}ms 조합에서 notice-a가 사라지면 안 된다: {final_notices:?}"
            );
            assert!(
                final_notices.iter().any(|n| n.id == "notice-b"),
                "slow_a={slow_a_ms}ms/slow_b={slow_b_ms}ms 조합에서 notice-b가 사라지면 안 된다: {final_notices:?}"
            );
        }
    }

    #[tokio::test]
    async fn queue_lead_notice_and_cancel_queued_notice_round_trip_on_isolated_file() {
        let path = temp_pending_notices_path("queue-cancel");
        let lock = AsyncMutex::new(());
        save_pending_notices_to(&path, &[]);

        let id = queue_lead_notice_at(&path, &lock, "internal-q", "안녕", NoticeOrigin::User).await;
        let after_queue = load_pending_notices_from(&path);
        assert_eq!(after_queue.len(), 1);
        assert_eq!(after_queue[0].id, id);

        let cancelled = cancel_queued_notice_at(&path, &lock, Some("internal-q".to_string()), &id).await;
        assert!(cancelled);
        assert!(load_pending_notices_from(&path).is_empty());

        // 이미 취소된 걸 다시 취소하면 false.
        assert!(!cancel_queued_notice_at(&path, &lock, Some("internal-q".to_string()), &id).await);

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn cancel_queued_notice_does_not_touch_a_different_leads_notice_with_colliding_id_assumption() {
        // 렌더러가 넘긴 leadShortId가 이 alert이 실제로 속한 팀장과 다르면(예: 짧은 id 드리프트로
        // 엉뚱한 팀장을 가리키게 된 경우) 취소하면 안 된다 — noticeId 자체는 그대로 두고 실패로
        // 취급해서 다음 폴링에 정상 배달되게 한다.
        let path = temp_pending_notices_path("cancel-mismatch");
        let lock = AsyncMutex::new(());
        save_pending_notices_to(&path, &[fake_notice("n1", "internal-real-owner", NoticeOrigin::User)]);

        let cancelled = cancel_queued_notice_at(&path, &lock, Some("internal-different-lead".to_string()), "n1").await;
        assert!(!cancelled, "internalId가 다르면 취소되면 안 된다");
        assert_eq!(load_pending_notices_from(&path).len(), 1);

        let _ = std::fs::remove_file(&path);
    }

    // ------------------------------------------------------------------------------------
    // notify_leads_of_finished_members — 전이 감지가 정확히 한 번만 일어나는지.
    // ------------------------------------------------------------------------------------

    fn fake_session_row(id: &str, status: &str, lead_short_id: &str, role: Option<&str>) -> SessionRow {
        SessionRow {
            agent: fake_agent(id, status),
            project_name: "proj".to_string(),
            preview: None,
            is_lead: false,
            lead_id: Some(lead_short_id.to_string()),
            role: role.map(str::to_string),
            label: None,
            offline: false,
            internal_id: None,
            auto_stall_nudge: None,
            secret: None,
            startup_warning: None,
        }
    }

    #[test]
    fn compute_finished_member_notifications_fires_exactly_once_on_busy_to_idle_transition() {
        let key = "test-notify-member-compute-xyz";
        struct Cleanup(&'static str);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                state().lock().unwrap().last_member_status.remove(self.0);
            }
        }
        let _cleanup = Cleanup(key);
        state().lock().unwrap().last_member_status.remove(key);

        let leads = vec![fake_lead("internal-notify", "lead-notify")];

        // 1) 처음엔 busy로 기록만 하고, 아직 전환이 아니므로 알림 없음.
        let notifs1 = compute_finished_member_notifications(&[fake_session_row(key, "busy", "lead-notify", Some("reviewer"))], &leads);
        assert!(notifs1.is_empty());

        // 2) busy -> idle 전환 — 정확히 한 번 알림.
        let idle_row = fake_session_row(key, "idle", "lead-notify", Some("reviewer"));
        let notifs2 = compute_finished_member_notifications(&[idle_row.clone()], &leads);
        assert_eq!(notifs2.len(), 1);
        assert_eq!(notifs2[0].0, "internal-notify");
        assert!(notifs2[0].1.contains("역할: reviewer"));

        // 3) 같은 idle 상태가 다음 폴링에도 이어지면(전이가 아님) 다시 알리면 안 된다.
        let notifs3 = compute_finished_member_notifications(&[idle_row], &leads);
        assert!(notifs3.is_empty(), "전이가 아니면(이미 idle) 중복 알림을 만들면 안 된다");
    }

    #[tokio::test]
    async fn notify_leads_of_finished_members_with_queue_forwards_computed_notifications() {
        let key = "test-notify-member-wiring-xyz";
        state().lock().unwrap().last_member_status.insert(key.to_string(), "busy".to_string());
        struct Cleanup(&'static str);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                state().lock().unwrap().last_member_status.remove(self.0);
            }
        }
        let _cleanup = Cleanup(key);

        let leads = vec![fake_lead("internal-wire", "lead-wire")];
        let rows = vec![fake_session_row(key, "idle", "lead-wire", None)];

        let captured: Arc<std::sync::Mutex<Vec<(String, String)>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured_clone = captured.clone();
        notify_leads_of_finished_members_with_queue(&rows, &leads, move |internal_id, message| {
            let captured_inner = captured_clone.clone();
            async move {
                captured_inner.lock().unwrap().push((internal_id.clone(), message));
                "fake-notice-id".to_string()
            }
        })
        .await;

        let calls = captured.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "internal-wire");
    }

    // ------------------------------------------------------------------------------------
    // deliver_dequeue_step — D-9 회로차단기: 상한 도달 후 정확히 멈추는지, D-6: resume 실패 시
    // 실제로 큐에 복귀하는지(가상 시계 기반 결정적 동시성 재현).
    // ------------------------------------------------------------------------------------

    fn always_fail_ports() -> DeliveryPorts {
        DeliveryPorts { resume: Arc::new(|_, _| Box::pin(async { None })), is_attach_terminal_open: Arc::new(|_| false) }
    }

    fn always_succeed_ports() -> DeliveryPorts {
        DeliveryPorts { resume: Arc::new(|_, _| Box::pin(async { Some("resumed-id".to_string()) })), is_attach_terminal_open: Arc::new(|_| false) }
    }

    #[tokio::test(start_paused = true)]
    async fn d6_resume_failure_requeues_the_notice_instead_of_losing_it() {
        let path = temp_pending_notices_path("d6");
        let lock = pending_notices_lock();
        let leads = vec![fake_lead("internal-d6", "lead-d6")];
        let agents = vec![fake_agent("lead-d6", "idle")]; // 살아있고 busy 아님 -> 배달 대상

        save_pending_notices_to(&path, &[fake_notice("n1", "internal-d6", NoticeOrigin::User)]);
        let ports = always_fail_ports();

        let to_deliver = with_pending_notices_lock_at(&path, lock, |current| deliver_dequeue_step(current, &agents, &leads, &ports)).await;
        assert_eq!(to_deliver.len(), 1, "배달 가능한 그룹 하나가 큐에서 빠져나와야 한다");
        assert!(load_pending_notices_from(&path).is_empty(), "배달 시도 중엔 큐에서 빠진 상태여야 한다");

        let (internal_id, message, attempted) = to_deliver.into_iter().next().unwrap();
        dispatch_delivery(path.clone(), lock, internal_id, message, attempted, ports).await;

        let after = load_pending_notices_from(&path);
        assert_eq!(after.len(), 1, "resume이 실패(None)해도 알림이 사라지면 안 되고 큐로 되돌아와야 한다(D-6)");
        assert_eq!(after[0].attempts, Some(1));

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test(start_paused = true)]
    async fn d9_circuit_breaker_stops_retrying_exactly_at_the_cap_but_keeps_the_notice_queued() {
        let path = temp_pending_notices_path("d9");
        let lock = pending_notices_lock();
        let leads = vec![fake_lead("internal-d9", "lead-d9")];
        let agents = vec![fake_agent("lead-d9", "idle")];

        save_pending_notices_to(&path, &[fake_notice("n1", "internal-d9", NoticeOrigin::User)]);
        let ports = always_fail_ports();

        for attempt in 1..=MAX_NOTICE_DELIVERY_ATTEMPTS {
            let to_deliver = with_pending_notices_lock_at(&path, lock, |current| deliver_dequeue_step(current, &agents, &leads, &ports)).await;
            assert_eq!(to_deliver.len(), 1, "상한({attempt}/{MAX_NOTICE_DELIVERY_ATTEMPTS}) 도달 전에는 계속 배달을 시도해야 한다");
            let (internal_id, message, attempted) = to_deliver.into_iter().next().unwrap();
            dispatch_delivery(path.clone(), lock, internal_id, message, attempted, ports.clone()).await;
        }

        let after_max = load_pending_notices_from(&path);
        assert_eq!(after_max.len(), 1, "상한에 도달해도 큐에서 제거하면 안 된다(D-9)");
        assert_eq!(after_max[0].attempts, Some(MAX_NOTICE_DELIVERY_ATTEMPTS));

        // 상한을 넘은 뒤엔 더 이상 배달을 "시도"하면 안 된다(exhausted) — to_deliver가 비어있어야
        // 하고, attempts도 더 이상 늘면 안 된다.
        let to_deliver_after_exhausted = with_pending_notices_lock_at(&path, lock, |current| deliver_dequeue_step(current, &agents, &leads, &ports)).await;
        assert!(to_deliver_after_exhausted.is_empty(), "상한 도달 후엔 자동 재시도를 멈춰야 한다(D-9)");
        let still_there = load_pending_notices_from(&path);
        assert_eq!(still_there.len(), 1, "상한 도달 후에도 큐에서 제거되면 안 된다");
        assert_eq!(still_there[0].attempts, Some(MAX_NOTICE_DELIVERY_ATTEMPTS), "더 이상 시도 횟수가 늘면 안 된다");

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test(start_paused = true)]
    async fn deliver_dequeue_step_keeps_group_pending_when_lead_is_busy() {
        let leads = vec![fake_lead("internal-busy", "lead-busy")];
        let agents = vec![fake_agent("lead-busy", "busy")];
        let mut current = vec![fake_notice("n1", "internal-busy", NoticeOrigin::System)];
        let ports = always_succeed_ports();

        let (dirty, to_deliver) = deliver_dequeue_step(&mut current, &agents, &leads, &ports);
        assert!(!dirty);
        assert!(to_deliver.is_empty(), "busy인 팀장 앞으로 쌓인 알림은 배달을 시도하면 안 된다");
        assert_eq!(current.len(), 1, "busy면 큐에 그대로 남아야 한다");
    }

    #[tokio::test(start_paused = true)]
    async fn deliver_dequeue_step_attempts_delivery_for_blocked_lead_unlike_busy() {
        // D-3: blocked는 busy와 다르게 취급 — 배달을 시도해야 한다.
        let leads = vec![fake_lead("internal-blocked", "lead-blocked")];
        let agents = vec![fake_agent("lead-blocked", "blocked")];
        let mut current = vec![fake_notice("n1", "internal-blocked", NoticeOrigin::System)];
        let ports = always_succeed_ports();

        let (_dirty, to_deliver) = deliver_dequeue_step(&mut current, &agents, &leads, &ports);
        assert_eq!(to_deliver.len(), 1, "blocked는 busy와 달리 배달을 시도해야 한다(D-3)");
        assert!(current.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn deliver_dequeue_step_skips_without_consuming_attempts_when_attach_terminal_open() {
        let leads = vec![fake_lead("internal-attach", "lead-attach")];
        let agents = vec![fake_agent("lead-attach", "idle")];
        let mut current = vec![fake_notice("n1", "internal-attach", NoticeOrigin::User)];
        let ports = DeliveryPorts { resume: Arc::new(|_, _| Box::pin(async { None })), is_attach_terminal_open: Arc::new(|_| true) };

        let (dirty, to_deliver) = deliver_dequeue_step(&mut current, &agents, &leads, &ports);
        assert!(!dirty);
        assert!(to_deliver.is_empty(), "attach 터미널이 열려있으면 이번 폴링엔 배달을 시도하면 안 된다(H-2)");
        assert_eq!(current[0].attempts, None, "attach로 건너뛴 건 시도 횟수를 소모하면 안 된다");
    }

    #[tokio::test(start_paused = true)]
    async fn deliver_dequeue_step_combines_multiple_notices_in_the_same_group_into_one_message() {
        let leads = vec![fake_lead("internal-combine", "lead-combine")];
        let agents = vec![fake_agent("lead-combine", "idle")];
        let mut current = vec![fake_notice("n1", "internal-combine", NoticeOrigin::System), fake_notice("n2", "internal-combine", NoticeOrigin::System)];
        let ports = always_succeed_ports();

        let (_dirty, to_deliver) = deliver_dequeue_step(&mut current, &agents, &leads, &ports);
        assert_eq!(to_deliver.len(), 1, "같은 팀장·같은 origin이면 하나의 배달 작업으로 합쳐져야 한다");
        assert!(to_deliver[0].1.contains("2건을 순서대로 전달합니다"));
        assert_eq!(to_deliver[0].2.len(), 2);
    }
}
