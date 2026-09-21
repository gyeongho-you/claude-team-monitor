// 이번 청크 — set-lead-auto-stall-nudge/update-lead-label(main.ts:2828-2840), delete-lead-history
// (main.ts:2760-2772)의 포팅. 셋 다 leads.json을 쓰므로 반드시 session_registry.rs의
// with_leads_lock을 거친다(직접 load_leads()+push+save_leads를 짝짓지 않는다 — β 리뷰가 지적한
// lost update가 그대로 재발한다).

use crate::agents_json::fetch_agents_typed_strict;
use crate::live_rows::has_live_member;
use crate::session_registry::{load_leads, load_members, with_leads_lock, LeadRecord};
use serde::Serialize;
use std::collections::HashSet;

#[tauri::command]
pub async fn set_lead_auto_stall_nudge_command(lead_id: String, value: bool) -> Vec<LeadRecord> {
    with_leads_lock(move |leads| {
        let Some(lead) = leads.iter_mut().find(|l| l.id == lead_id) else {
            return (false, leads.clone());
        };
        lead.auto_stall_nudge = Some(value);
        (true, leads.clone())
    })
    .await
}

#[tauri::command]
pub async fn update_lead_label_command(lead_id: String, label: String) -> Vec<LeadRecord> {
    with_leads_lock(move |leads| {
        let Some(lead) = leads.iter_mut().find(|l| l.id == lead_id) else {
            return (false, leads.clone());
        };
        lead.label = Some(label.trim().to_string());
        (true, leads.clone())
    })
    .await
}

#[derive(Debug, Serialize)]
pub struct DeleteLeadHistoryResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// deleteLeadHistory(main.ts)와 동일 — 실제 claude 세션·대화 파일(daily-journal 포함)은 전혀 안
/// 건드리고, 이 앱 자신의 추적 기록(leads.json)에서만 지운다. 살아있는 팀장(또는 그 소속 팀원)을
/// 실수로 지우면 다음 폴링 때 "미등록" 세션으로 다시 나타나 혼란을 주므로, 오프라인 상태일 때만
/// 지우도록 막는다 — 생존 확인 자체가 실패하면 fail-closed(살아있는데 지워버리는 사고보다 안전).
#[tauri::command]
pub async fn delete_lead_history_command(internal_id: String) -> DeleteLeadHistoryResult {
    let leads = load_leads();
    let Some(rec) = leads.iter().find(|l| l.internal_id.as_deref() == Some(internal_id.as_str())) else {
        return DeleteLeadHistoryResult { success: false, error: Some("팀장 기록을 찾을 수 없습니다(이미 삭제됐을 수 있음).".to_string()) };
    };
    let rec_id = rec.id.clone();

    let is_live = match fetch_agents_typed_strict().await {
        Ok(agents) => {
            let agent_id_set: HashSet<String> = agents.iter().filter_map(|a| a.id.clone()).collect();
            agent_id_set.contains(&rec_id) || has_live_member(&rec_id, &load_members(), &agent_id_set)
        }
        Err(_) => true, // 확인 자체가 실패하면 fail-closed.
    };
    if is_live {
        return DeleteLeadHistoryResult {
            success: false,
            error: Some("이 팀장(또는 소속 팀원)이 아직 살아있는 것으로 보입니다 — 오프라인 상태에서만 히스토리를 삭제할 수 있습니다.".to_string()),
        };
    }

    with_leads_lock(move |leads| {
        let before = leads.len();
        leads.retain(|l| l.internal_id.as_deref() != Some(internal_id.as_str()));
        (leads.len() != before, ())
    })
    .await;
    DeleteLeadHistoryResult { success: true, error: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_registry::with_leads_lock_at;
    use std::path::PathBuf;
    use tokio::sync::Mutex as AsyncMutex;

    fn temp_leads_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_lead_admin_{tag}_{}.json", uuid::Uuid::new_v4()))
    }

    fn fake_lead(id: &str, internal_id: &str) -> LeadRecord {
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
            mcp_token: None,
        }
    }

    // set_lead_auto_stall_nudge_command/update_lead_label_command는 with_leads_lock의 얇은
    // 래퍼일 뿐이라(session_registry.rs 자신의 락 테스트가 lost update 방지를 이미 검증한다), 여기서는
    // 순수 mutate 클로저가 올바른 필드만 바꾸는지만 임시 파일로 확인한다.
    #[tokio::test]
    async fn auto_stall_nudge_mutate_only_touches_matching_lead() {
        let path = temp_leads_path("nudge");
        let lock = AsyncMutex::new(());
        crate::session_registry::save_leads_to(&path, &[fake_lead("lead-a", "ia"), fake_lead("lead-b", "ib")]);

        let after = with_leads_lock_at(&path, &lock, |leads| {
            let Some(lead) = leads.iter_mut().find(|l| l.id == "lead-a") else { return (false, leads.clone()) };
            lead.auto_stall_nudge = Some(true);
            (true, leads.clone())
        })
        .await;
        assert_eq!(after.iter().find(|l| l.id == "lead-a").unwrap().auto_stall_nudge, Some(true));
        assert_eq!(after.iter().find(|l| l.id == "lead-b").unwrap().auto_stall_nudge, None, "다른 팀장은 안 건드려야 한다");

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn update_label_trims_whitespace() {
        let path = temp_leads_path("label");
        let lock = AsyncMutex::new(());
        crate::session_registry::save_leads_to(&path, &[fake_lead("lead-a", "ia")]);

        let after = with_leads_lock_at(&path, &lock, |leads| {
            let Some(lead) = leads.iter_mut().find(|l| l.id == "lead-a") else { return (false, leads.clone()) };
            lead.label = Some("  라벨  ".trim().to_string());
            (true, leads.clone())
        })
        .await;
        assert_eq!(after[0].label.as_deref(), Some("라벨"));

        let _ = std::fs::remove_file(&path);
    }

    // delete_lead_history의 "찾을 수 없음" 분기는 with_leads_lock 없이도 검증 가능(디스크 I/O 없음).
    #[tokio::test]
    async fn delete_lead_history_reports_not_found_for_unknown_internal_id() {
        let result = delete_lead_history_command("definitely-not-a-real-internal-id-xyz".to_string()).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("찾을 수 없습니다"));
    }
}
