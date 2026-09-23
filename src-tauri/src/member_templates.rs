// 이번 청크 — get-member-templates/add-member-template/update-member-template/
// toggle-member-template-approved/delete-member-template(main.ts:2521-2562)의 포팅.
//
// lead_lifecycle.rs에도 MemberTemplate이 있지만(approvedMemberBriefing 전용, id/model 필드가
// 없는 읽기 전용 부분집합) 이 모듈의 MemberTemplate과는 별개 타입이다 — CRUD IPC는 main.ts의
// MemberTemplate 전체 필드(id/model 포함)가 필요해서 여기 새로 정의한다.
//
// memberTemplates.json은 여러 팀장 세션이 launchTeamLead/adoptLead 브리핑 때마다 읽고, 사용자는
// 화면에서 add/update/toggle/delete로 동시에 고칠 수 있다 — favorites.json/leads.json/
// pendingNotices.json과 같은 이유로 전용 전역 락(with_member_templates_lock)을 새로 만든다.

use crate::json_file::write_json_file_atomic;
use crate::paths::member_templates_path;
use crate::timing::now_ms;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex as AsyncMutex;

// lib/appSettings.js의 MEMBER_MODEL_OPTIONS/normalizeMemberModel과 동일 — 'default'는 이 앱이
// 모델을 따로 지정하지 않고 claude CLI 기본값을 그대로 쓴다는 뜻.
const MEMBER_MODEL_OPTIONS: [&str; 4] = ["default", "haiku", "sonnet", "opus"];

/// normalizeMemberModel(lib/appSettings.js)와 동일 — 화이트리스트 밖 값(구버전 템플릿·조작된 값
/// 등)은 'default'로 취급한다.
fn normalize_member_model(model: Option<&str>) -> String {
    match model {
        Some(m) if MEMBER_MODEL_OPTIONS.contains(&m) => m.to_string(),
        _ => "default".to_string(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberTemplate {
    pub id: String,
    #[serde(default)]
    pub scope: String, // 'shared' | <팀장 디렉토리 경로>
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub instruction: String,
    #[serde(default)]
    pub approved: bool, // path가 있을 때만 의미 있음
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>, // 없으면(구버전 템플릿) 'default'와 동일하게 취급
}

fn load_member_templates_from(path: &Path) -> Vec<MemberTemplate> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Vec<MemberTemplate>>(&raw).unwrap_or_default()
}

/// loadMemberTemplates(main.ts)와 동일 — 읽기 전용 호출부는 락 없이 직접 쓴다.
pub fn load_member_templates() -> Vec<MemberTemplate> {
    load_member_templates_from(&member_templates_path())
}

fn save_member_templates_to(path: &Path, templates: &[MemberTemplate]) {
    if let Err(e) = write_json_file_atomic(path, &templates) {
        eprintln!("[save_member_templates] memberTemplates.json 저장 실패: {e}");
    }
}

// ---------------------------------------------------------------------------------------------
// memberTemplates.json 전용 전역 락 — favorites.rs/session_registry.rs의 with_leads_lock/
// notice_queue.rs의 with_pending_notices_lock과 정확히 같은 이유·같은 구조.
// ---------------------------------------------------------------------------------------------

fn member_templates_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

pub(crate) async fn with_member_templates_lock_at<F, R>(path: &Path, lock: &AsyncMutex<()>, mutate: F) -> R
where
    F: FnOnce(&mut Vec<MemberTemplate>) -> (bool, R),
{
    let _guard = lock.lock().await;
    let mut templates = load_member_templates_from(path);
    let (dirty, result) = mutate(&mut templates);
    if dirty {
        save_member_templates_to(path, &templates);
    }
    result
}

pub async fn with_member_templates_lock<F, R>(mutate: F) -> R
where
    F: FnOnce(&mut Vec<MemberTemplate>) -> (bool, R),
{
    with_member_templates_lock_at(&member_templates_path(), member_templates_lock(), mutate).await
}

fn basename(dir: &str) -> String {
    PathBuf::from(dir).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.to_string())
}

#[tauri::command]
pub fn get_member_templates_command() -> Vec<MemberTemplate> {
    load_member_templates()
}

#[tauri::command]
pub async fn add_member_template_command(
    scope: String,
    dir: Option<String>,
    name: String,
    role: String,
    instruction: String,
    model: Option<String>,
) -> Vec<MemberTemplate> {
    with_member_templates_lock(move |templates| {
        let id = format!("tpl-{}", now_ms());
        let resolved_name = if !name.is_empty() {
            name.clone()
        } else if let Some(d) = &dir {
            basename(d)
        } else if !role.is_empty() {
            role.clone()
        } else {
            "역할".to_string()
        };
        templates.push(MemberTemplate {
            id,
            scope: if scope.is_empty() { "shared".to_string() } else { scope.clone() },
            path: dir.clone(),
            name: resolved_name,
            role: role.clone(),
            instruction: instruction.clone(),
            approved: false,
            model: Some(normalize_member_model(model.as_deref())),
        });
        (true, templates.clone())
    })
    .await
}

/// main.ts의 `Partial<Pick<MemberTemplate, 'name'|'role'|'instruction'|'model'>>`과 동일한 부분
/// 갱신 — 각 필드가 None이면 "이번엔 안 바꾼다"는 뜻이다. main.ts는 `'model' in next`로 model
/// 키가 아예 보내졌는지까지 구분하지만, 렌더러가 model에 명시적으로 null을 보내는 호출부가 없어서
/// (항상 값을 보내거나 아예 키를 생략) Option<String>으로도 그 구분과 동일한 결과를 낸다.
#[derive(Debug, Deserialize)]
pub struct MemberTemplateUpdateFields {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[tauri::command]
pub async fn update_member_template_command(id: String, fields: MemberTemplateUpdateFields) -> Vec<MemberTemplate> {
    with_member_templates_lock(move |templates| {
        let Some(t) = templates.iter_mut().find(|t| t.id == id) else {
            return (false, templates.clone());
        };
        if let Some(name) = &fields.name {
            t.name = name.clone();
        }
        if let Some(role) = &fields.role {
            t.role = role.clone();
        }
        if let Some(instruction) = &fields.instruction {
            t.instruction = instruction.clone();
        }
        if fields.model.is_some() {
            t.model = Some(normalize_member_model(fields.model.as_deref()));
        }
        (true, templates.clone())
    })
    .await
}

#[tauri::command]
pub async fn toggle_member_template_approved_command(id: String) -> Vec<MemberTemplate> {
    with_member_templates_lock(move |templates| {
        let Some(t) = templates.iter_mut().find(|t| t.id == id) else {
            return (false, templates.clone());
        };
        t.approved = !t.approved;
        (true, templates.clone())
    })
    .await
}

#[tauri::command]
pub async fn delete_member_template_command(id: String) -> Vec<MemberTemplate> {
    with_member_templates_lock(move |templates| {
        let before = templates.len();
        templates.retain(|t| t.id != id);
        let changed = templates.len() != before;
        (changed, templates.clone())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_member_templates_{tag}_{}.json", uuid::Uuid::new_v4()))
    }

    fn fake_template(id: &str) -> MemberTemplate {
        MemberTemplate {
            id: id.to_string(),
            scope: "shared".to_string(),
            path: Some("C:\\proj".to_string()),
            name: "이름".to_string(),
            role: "리뷰어".to_string(),
            instruction: "지시".to_string(),
            approved: false,
            model: Some("default".to_string()),
        }
    }

    #[test]
    fn normalize_member_model_falls_back_to_default_for_unknown_values() {
        assert_eq!(normalize_member_model(Some("opus")), "opus");
        assert_eq!(normalize_member_model(Some("gpt-5")), "default");
        assert_eq!(normalize_member_model(None), "default");
    }

    #[tokio::test]
    async fn update_only_touches_provided_fields() {
        let path = temp_path("update");
        let lock = AsyncMutex::new(());
        save_member_templates_to(&path, &[fake_template("t1")]);

        let after = with_member_templates_lock_at(&path, &lock, |templates| {
            let Some(t) = templates.iter_mut().find(|t| t.id == "t1") else { return (false, templates.clone()) };
            let fields = MemberTemplateUpdateFields { name: Some("새이름".to_string()), role: None, instruction: None, model: None };
            if let Some(name) = &fields.name {
                t.name = name.clone();
            }
            (true, templates.clone())
        })
        .await;
        assert_eq!(after[0].name, "새이름");
        assert_eq!(after[0].role, "리뷰어", "안 보낸 필드는 그대로여야 한다");

        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn toggle_approved_flips_boolean() {
        let path = temp_path("toggle");
        let lock = AsyncMutex::new(());
        save_member_templates_to(&path, &[fake_template("t1")]);

        let after1 = with_member_templates_lock_at(&path, &lock, |templates| {
            let Some(t) = templates.iter_mut().find(|t| t.id == "t1") else { return (false, templates.clone()) };
            t.approved = !t.approved;
            (true, templates.clone())
        })
        .await;
        assert!(after1[0].approved);

        let _ = std::fs::remove_file(&path);
    }

    // ------------------------------------------------------------------------------------
    // memberTemplates.json 동시 쓰기 — favorites.rs/session_registry.rs/notice_queue.rs와
    // 정확히 같은 가상 시계 기반 결정적 패턴.
    // ------------------------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn member_templates_lost_update_is_reproducible_without_the_lock() {
        let path = temp_path("unlocked");
        save_member_templates_to(&path, &[]);

        let path_a = path.clone();
        let task_a = tokio::spawn(async move {
            let mut templates = load_member_templates_from(&path_a);
            tokio::time::sleep(Duration::from_millis(30)).await;
            templates.push(fake_template("tpl-a"));
            save_member_templates_to(&path_a, &templates);
        });
        let path_b = path.clone();
        let task_b = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            let mut templates = load_member_templates_from(&path_b);
            templates.push(fake_template("tpl-b"));
            save_member_templates_to(&path_b, &templates);
        });
        let _ = tokio::join!(task_a, task_b);

        let final_templates = load_member_templates_from(&path);
        let _ = std::fs::remove_file(&path);

        let has_a = final_templates.iter().any(|t| t.id == "tpl-a");
        let has_b = final_templates.iter().any(|t| t.id == "tpl-b");
        assert!(!(has_a && has_b), "락 없이 두 쓰기가 겹치면 lost update가 재현돼야 하는데 둘 다 반영됐다: {final_templates:?}");
        assert!(has_a);
        assert!(!has_b);
    }

    #[tokio::test(start_paused = true)]
    async fn with_member_templates_lock_prevents_lost_update_under_concurrent_writes() {
        for (slow_a_ms, slow_b_ms) in [(30u64, 5u64), (5u64, 30u64)] {
            let path = temp_path("locked");
            let lock = AsyncMutex::new(());
            save_member_templates_to(&path, &[]);

            let task_a = async {
                tokio::time::sleep(Duration::from_millis(slow_a_ms)).await;
                with_member_templates_lock_at(&path, &lock, |templates| {
                    templates.push(fake_template("tpl-a"));
                    (true, ())
                })
                .await;
            };
            let task_b = async {
                tokio::time::sleep(Duration::from_millis(slow_b_ms)).await;
                with_member_templates_lock_at(&path, &lock, |templates| {
                    templates.push(fake_template("tpl-b"));
                    (true, ())
                })
                .await;
            };
            tokio::join!(task_a, task_b);

            let final_templates = load_member_templates_from(&path);
            let _ = std::fs::remove_file(&path);
            assert!(final_templates.iter().any(|t| t.id == "tpl-a"), "slow_a={slow_a_ms}/slow_b={slow_b_ms}: tpl-a 사라지면 안 됨");
            assert!(final_templates.iter().any(|t| t.id == "tpl-b"), "slow_a={slow_a_ms}/slow_b={slow_b_ms}: tpl-b 사라지면 안 됨");
        }
    }
}
