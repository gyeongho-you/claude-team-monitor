// 서브청크 δ(TAURI_NOTICE_QUEUE_DESIGN.md §2)가 소비하는 IPC 중 approve-request/deny-request가
// 필요로 하는 MemberRequest 최소 포팅. main.ts의 MemberRequest 타입/writeRequestDecision을 옮겼다.
//
// 이번 청크(남은 단순 CRUD IPC)에서 loadPendingRequests(main.ts:1542-1558)를 추가로 포팅한다 —
// refresh-board 상당 커맨드(live_rows.rs의 refresh_board_command)가 반환하는 requests 필드가
// 이 함수를 재사용한다.

use crate::paths::{is_safe_id, requests_dir};
use serde::{Deserialize, Serialize};
use std::path::Path;

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

/// loadPendingRequests(main.ts:1542-1558)와 동일 — REQUESTS_DIR 안의 *.json을 전부 읽어 status가
/// 'pending'인 것만, createdAt 오름차순으로 돌려준다. id가 안전한 형식이 아니면 걸러서(외부 세션이
/// 직접 쓰는 파일이라 값을 신뢰할 수 없다 — memberId와 같은 이유) writeRequestDecision이 이 값을
/// 파일 경로에 그대로 쓰는 경로로 절대 넘어가지 않게 한다.
pub(crate) fn load_pending_requests_from(dir: &Path) -> Vec<MemberRequest> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<MemberRequest> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|ext| ext.to_str()) == Some("json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|raw| serde_json::from_str::<MemberRequest>(&raw).ok())
        .filter(|r| r.status == "pending")
        .filter(|r| {
            if is_safe_id(&r.id) {
                true
            } else {
                eprintln!("[load_pending_requests] 요청 id 형식이 안전하지 않아 무시합니다: {:?}", r.id);
                false
            }
        })
        .collect();
    out.sort_by_key(|r| r.created_at);
    out
}

/// loadPendingRequests(main.ts)와 동일 — 실제 REQUESTS_DIR을 읽는다.
pub fn load_pending_requests() -> Vec<MemberRequest> {
    load_pending_requests_from(&requests_dir())
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

    fn temp_requests_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_requests_{tag}_{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn load_pending_requests_only_returns_pending_sorted_by_created_at() {
        let dir = temp_requests_dir("load");
        std::fs::create_dir_all(&dir).unwrap();

        let mut newer = pending_request("req-newer", None);
        newer.created_at = 2_000;
        let mut older = pending_request("req-older", None);
        older.created_at = 1_000;
        let mut decided = pending_request("req-decided", None);
        decided.status = "approved".to_string();
        decided.created_at = 500;

        for (name, req) in [("req-newer.json", &newer), ("req-older.json", &older), ("req-decided.json", &decided)] {
            crate::json_file::write_json_file_atomic(&dir.join(name), req).unwrap();
        }
        // json이 아닌 파일은 무시돼야 한다.
        std::fs::write(dir.join("not-json.txt"), "무시돼야 함").unwrap();

        let result = load_pending_requests_from(&dir);
        assert_eq!(result.len(), 2, "pending이 아닌 요청은 빠져야 한다");
        assert_eq!(result[0].id, "req-older", "createdAt 오름차순이어야 한다");
        assert_eq!(result[1].id, "req-newer");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_pending_requests_returns_empty_for_missing_directory() {
        let dir = temp_requests_dir("missing").join("does-not-exist");
        assert!(load_pending_requests_from(&dir).is_empty());
    }

    #[test]
    fn load_pending_requests_filters_out_unsafe_ids() {
        let dir = temp_requests_dir("unsafe-id");
        std::fs::create_dir_all(&dir).unwrap();
        let mut req = pending_request("../escape", None);
        req.created_at = 1_000;
        // is_safe_id 검사는 req.id 필드 값을 보는 것이지 파일명을 보는 게 아니므로, 파일명은
        // 안전하게 쓰고 내용만 조작된 id를 담는다(실제 위협 모델과 동일 — 외부 세션이 파일 내용을
        // 직접 쓴다).
        crate::json_file::write_json_file_atomic(&dir.join("weird.json"), &req).unwrap();

        assert!(load_pending_requests_from(&dir).is_empty(), "id 필드가 안전하지 않으면 걸러져야 한다");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
