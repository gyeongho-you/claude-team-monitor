// 실행 중인 팀장/팀원 세션의 모델을 바꾼다.
//
// 실측(2026-11-03, claude 2.1.310, 시험 세션으로 확인):
//  - 정지한 세션에 'claude --bg --resume <세션> --model opus'처럼 플래그를 주면 "백그라운드 세션은 저장된 옵션을 유지하므로 플래그를 주면
//    복사본을 시작한다"며 새 세션(다른 짧은 id)이 만들어진다 — 팀장/팀원 등록과 맞지 않아 쓸 수 없다.
//  - 플래그 없이 '--resume'하면 "저장된 옵션(--model)으로 깨운다". 그 저장된 옵션은 데몬이 job마다 관리하는 ~/.claude/jobs/<id>/state.json의
//    respawnFlags(예: ["--model","haiku"])다. 세션을 정지한 뒤 이 값을 고쳐 두고 플래그 없이 --resume하면 같은 세션(같은 id)이 새 모델로
//    이어지는 것을 확인했다(대화 기록의 응답 모델이 haiku → sonnet으로 바뀜).
// 데몬의 내부 파일을 쓰는 방식이라 반드시 "정지가 끝난 뒤, 재개 직전"에만 고치고, 다른 필드는 그대로 둔 채 임시 파일에 쓴 뒤 바꿔치기한다.
// claude 버전이 바뀌어 이 방식이 안 통하면(재개 후에도 모델이 안 바뀜) 화면에는 읽은 respawnFlags 기준의 모델이 그대로 보이므로 어긋남을 알 수 있다.

use crate::paths::{is_safe_id, jobs_dir};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// 화면에서 고를 수 있는 모델(claude --model 별칭). "default"는 --model 없이(claude 기본값) 쓴다는 뜻.
pub(crate) const MODEL_CHOICES: [&str; 5] = ["default", "haiku", "sonnet", "opus", "fable"];

pub(crate) fn is_known_model(model: &str) -> bool {
    MODEL_CHOICES.contains(&model)
}

fn state_path(jobs_dir: &Path, id: &str) -> std::path::PathBuf {
    jobs_dir.join(id).join("state.json")
}

/// job의 respawnFlags에 저장된 --model 값(없으면 None = 기본 모델). 예: "haiku", "sonnet[1m]".
pub(crate) fn read_model_in(jobs_dir: &Path, id: &str) -> Option<String> {
    if !is_safe_id(id) {
        return None;
    }
    let raw = std::fs::read_to_string(state_path(jobs_dir, id)).ok()?;
    let data: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let flags = data.get("respawnFlags")?.as_array()?;
    let pos = flags.iter().position(|f| f.as_str() == Some("--model"))?;
    flags.get(pos + 1)?.as_str().map(str::to_string)
}

pub(crate) fn read_model(id: &str) -> Option<String> {
    read_model_in(&jobs_dir(), id)
}

/// respawnFlags의 --model을 바꾼다("default"면 --model 자체를 뺀다). 다른 필드는 그대로 두고 임시 파일에 쓴 뒤 바꿔치기한다.
pub(crate) fn write_model_in(jobs_dir: &Path, id: &str, model: &str) -> Result<(), String> {
    if !is_safe_id(id) || !is_known_model(model) {
        return Err("모델 또는 세션 id가 올바르지 않습니다".to_string());
    }
    let path = state_path(jobs_dir, id);
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("세션 상태 파일을 읽지 못했습니다: {e}"))?;
    let mut data: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("세션 상태 파일 형식이 예상과 다릅니다: {e}"))?;
    let obj = data.as_object_mut().ok_or_else(|| "세션 상태 파일 형식이 예상과 다릅니다".to_string())?;
    let mut flags: Vec<serde_json::Value> = obj.get("respawnFlags").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    if let Some(pos) = flags.iter().position(|f| f.as_str() == Some("--model")) {
        flags.remove(pos);
        if pos < flags.len() {
            flags.remove(pos); // 값
        }
    }
    if model != "default" {
        flags.push(serde_json::Value::String("--model".to_string()));
        flags.push(serde_json::Value::String(model.to_string()));
    }
    obj.insert("respawnFlags".to_string(), serde_json::Value::Array(flags));
    let body = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    let tmp = path.with_file_name("state.json.ctm-tmp");
    std::fs::write(&tmp, body).map_err(|e| format!("임시 파일을 쓰지 못했습니다: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("세션 상태 파일을 바꾸지 못했습니다: {e}")
    })?;
    // 쓴 값이 실제로 읽히는지 확인한다(데몬이 곧바로 덮어쓴 경우를 잡는다).
    let expected = if model == "default" { None } else { Some(model.to_string()) };
    if read_model_in(jobs_dir, id) != expected {
        return Err("모델 설정을 쓴 직후 다시 읽어 보니 반영되지 않았습니다(데몬이 덮어썼을 수 있음)".to_string());
    }
    Ok(())
}

fn pending() -> &'static Mutex<HashMap<String, String>> {
    static P: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 팀장 재개(resume_lead)가 "정지가 끝난 뒤, 재개 직전"에 적용할 모델을 예약한다.
pub(crate) fn set_pending(id: &str, model: &str) {
    pending().lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), model.to_string());
}

pub(crate) fn clear_pending(id: &str) {
    pending().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
}

/// 예약된 모델이 있으면 지금 적용한다(재개 직전에 resume_lead가 부른다). 실패하면 이유를 돌려주고 예약은 그대로 지운다.
pub(crate) fn apply_pending(id: &str) -> Result<bool, String> {
    let model = pending().lock().unwrap_or_else(|e| e.into_inner()).remove(id);
    match model {
        None => Ok(false),
        Some(m) => write_model_in(&jobs_dir(), id, &m).map(|_| true),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangeModelResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn model_label(model: &str) -> &str {
    match model {
        "default" => "기본 모델",
        "haiku" => "Haiku",
        "sonnet" => "Sonnet",
        "opus" => "Opus",
        "fable" => "Fable",
        other => other,
    }
}

fn notice_for(model: &str) -> String {
    format!(
        "[알림] 사용자가 이 세션의 모델을 {}(으)로 바꿨습니다(세션을 잠시 멈췄다 같은 대화로 이어서 재개했습니다). 하던 작업이 있었다면 이어서 진행하고, 없었다면 \"모델 변경 확인\"이라고만 한 줄로 답하세요.",
        model_label(model)
    )
}

/// 실행 중(또는 쉬는 중)인 팀장/팀원의 모델을 바꾼다. 세션을 정지 → 모델 저장 → 같은 세션으로 재개한다(작업 중이면 그 작업은 중단된다).
#[tauri::command]
pub async fn change_session_model_command(id: String, model: String) -> ChangeModelResult {
    let fail = |msg: &str| ChangeModelResult { ok: false, error: Some(msg.to_string()) };
    if !is_known_model(&model) {
        return fail("지원하지 않는 모델입니다.");
    }
    if !is_safe_id(&id) {
        return fail("세션 id가 올바르지 않습니다.");
    }
    let message = notice_for(&model);
    if let Some(lead) = crate::session_registry::load_leads().into_iter().find(|l| l.id == id) {
        let Some(internal_id) = lead.internal_id.clone() else { return fail("이 팀장 기록에 내부 id가 없어 재개할 수 없습니다.") };
        set_pending(&id, &model);
        let resumed = crate::resume::resume_lead_command(internal_id, message).await;
        clear_pending(&id);
        return if resumed.is_some() { ChangeModelResult { ok: true, error: None } } else { fail("세션을 재개하지 못했습니다 — 팀장이 멈춘 채일 수 있으니 목록에서 확인하고 메시지를 보내 다시 이어 주세요.") };
    }
    if crate::session_registry::load_members().iter().any(|m| m.member_id == id) {
        return match crate::resume::resume_member_with_model(&id, &model, &message).await {
            Ok(()) => ChangeModelResult { ok: true, error: None },
            Err(e) => ChangeModelResult { ok: false, error: Some(e) },
        };
    }
    fail("등록된 팀장/팀원이 아닙니다.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ctm_model_{tag}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_state(jobs: &Path, id: &str, body: &str) {
        std::fs::create_dir_all(jobs.join(id)).unwrap();
        std::fs::write(jobs.join(id).join("state.json"), body).unwrap();
    }

    #[test]
    fn reads_the_model_from_respawn_flags() {
        let jobs = tmp("read");
        write_state(&jobs, "aaaa1111", r#"{"state":"done","respawnFlags":["--model","sonnet[1m]"]}"#);
        write_state(&jobs, "bbbb2222", r#"{"state":"done","respawnFlags":[]}"#);
        write_state(&jobs, "cccc3333", r#"{"state":"done"}"#);
        assert_eq!(read_model_in(&jobs, "aaaa1111").as_deref(), Some("sonnet[1m]"));
        assert_eq!(read_model_in(&jobs, "bbbb2222"), None);
        assert_eq!(read_model_in(&jobs, "cccc3333"), None);
        assert_eq!(read_model_in(&jobs, "../x"), None);
    }

    #[test]
    fn writes_the_model_and_keeps_every_other_field_and_flag() {
        let jobs = tmp("write");
        write_state(&jobs, "aaaa1111", r#"{"state":"done","detail":"x","respawnFlags":["--model","haiku","--effort","high"],"inFlight":{"tasks":0}}"#);
        write_model_in(&jobs, "aaaa1111", "opus").unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(jobs.join("aaaa1111").join("state.json")).unwrap()).unwrap();
        assert_eq!(v["respawnFlags"], serde_json::json!(["--effort", "high", "--model", "opus"]));
        assert_eq!(v["detail"], "x");
        assert_eq!(v["inFlight"]["tasks"], 0);
        assert!(!jobs.join("aaaa1111").join("state.json.ctm-tmp").exists());
        write_model_in(&jobs, "aaaa1111", "default").unwrap();
        assert_eq!(read_model_in(&jobs, "aaaa1111"), None);
        // respawnFlags가 없던 상태에서도 만든다
        write_state(&jobs, "bbbb2222", r#"{"state":"done"}"#);
        write_model_in(&jobs, "bbbb2222", "fable").unwrap();
        assert_eq!(read_model_in(&jobs, "bbbb2222").as_deref(), Some("fable"));
    }

    #[test]
    fn rejects_unknown_models_unsafe_ids_and_unreadable_state() {
        let jobs = tmp("reject");
        write_state(&jobs, "aaaa1111", r#"{"respawnFlags":[]}"#);
        assert!(write_model_in(&jobs, "aaaa1111", "gpt").is_err());
        assert!(write_model_in(&jobs, "../x", "opus").is_err());
        assert!(write_model_in(&jobs, "nothere1", "opus").is_err());
        write_state(&jobs, "bad00000", "이건 JSON이 아님");
        assert!(write_model_in(&jobs, "bad00000", "opus").is_err());
    }

    #[test]
    fn model_choices_include_fable() {
        assert!(is_known_model("fable") && is_known_model("default") && !is_known_model("gpt"));
    }
}
