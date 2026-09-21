// 서브청크 δ(TAURI_NOTICE_QUEUE_DESIGN.md §2)가 소비하는 IPC 중 approve-request/deny-request가
// 필요로 하는 MemberRequest 최소 포팅. main.ts의 MemberRequest 타입/writeRequestDecision만
// 옮긴다 — loadPendingRequests(요청 목록 전체 조회, "승인 대기" 탭 렌더링용)는 이번 청크의 소비
// IPC 목록에 없어서 범위 밖이다(approve-request/deny-request는 렌더러가 이미 알고 있는 requestId를
// 그대로 IPC 인자로 넘기므로 목록 조회가 필요 없다).

use crate::paths::{is_safe_id, requests_dir};
use serde::{Deserialize, Serialize};

/// main.ts의 MemberRequest와 동일. `type`은 러스트 예약어라 `request_type`으로 옮기고
/// `#[serde(rename = "type")]`로 JSON 필드명을 맞춘다. 구버전 요청(type 필드 자체가 없음)은
/// main.ts와 동일하게 dir-approval로 취급한다(요청 처리부가 직접 판단).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberRequest {
    pub id: String,
    #[serde(rename = "teamLeadId")]
    pub team_lead_id: String,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub request_type: Option<String>,
    #[serde(rename = "requestedDir", default, skip_serializing_if = "Option::is_none")]
    pub requested_dir: Option<String>,
    #[serde(rename = "memberId", default, skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    pub reason: String,
    pub status: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

impl MemberRequest {
    /// main.ts가 `req.type === 'stop-member'`로 분기하는 것과 동일한 판정.
    pub fn is_stop_member(&self) -> bool {
        self.request_type.as_deref() == Some("stop-member")
    }
}

/// writeRequestDecision(main.ts)의 판정부만 뽑은 순수 함수 — 디스크 I/O 없이 CAS(현재 상태가
/// pending일 때만 갱신) 규칙을 테스트한다.
fn apply_decision(mut req: MemberRequest, status: &str) -> Option<MemberRequest> {
    if req.status != "pending" {
        return None;
    }
    req.status = status.to_string();
    Some(req)
}

/// writeRequestDecision(main.ts)과 동일 — requestId가 안전한 형식이 아니거나, 파일이 없거나
/// 파싱에 실패하거나, 이미 pending이 아니면(모순된 메시지가 두 번 전달되는 걸 막는 CAS) None.
pub fn write_request_decision(request_id: &str, status: &str) -> Option<MemberRequest> {
    if !is_safe_id(request_id) {
        return None;
    }
    let file = requests_dir().join(format!("{request_id}.json"));
    let raw = std::fs::read_to_string(&file).ok()?;
    let req: MemberRequest = serde_json::from_str(&raw).ok()?;
    let decided = apply_decision(req, status)?;
    if let Err(e) = crate::json_file::write_json_file_atomic(&file, &decided) {
        eprintln!("[write_request_decision] 요청 상태 저장 실패: {e}");
        return None;
    }
    Some(decided)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending_request(id: &str, request_type: Option<&str>) -> MemberRequest {
        MemberRequest {
            id: id.to_string(),
            team_lead_id: "lead1".to_string(),
            request_type: request_type.map(str::to_string),
            requested_dir: Some("C:\\proj\\sub".to_string()),
            member_id: None,
            reason: "테스트".to_string(),
            status: "pending".to_string(),
            created_at: 1_000,
        }
    }

    #[test]
    fn apply_decision_updates_pending_request_to_given_status() {
        let req = pending_request("req1", Some("dir-approval"));
        let decided = apply_decision(req, "approved").expect("pending 요청은 결정돼야 한다");
        assert_eq!(decided.status, "approved");
    }

    #[test]
    fn apply_decision_refuses_already_decided_request() {
        let mut req = pending_request("req2", None);
        req.status = "denied".to_string();
        assert!(apply_decision(req, "approved").is_none(), "이미 처리된 요청은 다시 결정하면 안 된다(CAS)");
    }

    #[test]
    fn is_stop_member_matches_type_field_only() {
        assert!(pending_request("r", Some("stop-member")).is_stop_member());
        assert!(!pending_request("r", Some("dir-approval")).is_stop_member());
        assert!(!pending_request("r", None).is_stop_member(), "구버전(타입 없음) 요청은 dir-approval로 취급한다");
    }

    // write_request_decision 실제 파일 왕복 — 임시 requests 디렉토리 대신 프로덕션
    // requests_dir()에 직접 쓰는 건 이 저장소를 작업 중인 실제 팀장의 요청 파일을 건드릴 위험이
    // 있어서(session_registry.rs의 members_dir 테스트와 같은 우려), is_safe_id를 만족하는 고유
    // 테스트 전용 requestId를 실제 requests_dir()에 만들고 테스트 끝에 반드시 지운다.
    #[test]
    fn write_request_decision_round_trips_through_real_requests_file() {
        let id = format!("test-notice-queue-delta-{}", uuid::Uuid::new_v4().simple());
        let file = requests_dir().join(format!("{id}.json"));
        let req = pending_request(&id, Some("dir-approval"));
        crate::json_file::write_json_file_atomic(&file, &req).expect("테스트 요청 파일 생성 실패");

        let decided = write_request_decision(&id, "approved").expect("pending 요청은 승인돼야 한다");
        assert_eq!(decided.status, "approved");

        let reloaded: MemberRequest = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(reloaded.status, "approved", "디스크에도 결정이 반영돼야 한다");

        // 이미 approved인 요청을 다시 거부하려 하면 CAS에 걸려 None이어야 한다.
        assert!(write_request_decision(&id, "denied").is_none());

        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn write_request_decision_rejects_unsafe_request_id() {
        assert!(write_request_decision("../escape", "approved").is_none());
    }
}
