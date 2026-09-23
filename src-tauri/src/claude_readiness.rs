// src/lib/claudeReadiness.js의 포팅 — claude CLI가 이 디렉토리에서 최초 실행 승인(워크스페이스
// 신뢰)을 이미 받았는지 spawn 전에 확인한다. headless(--bg) 세션은 이 승인 다이얼로그에 아무도
// 답할 수 없어서, 확인 없이 spawn하면 daemon이 "stuck on a startup dialog" 상태로 영구히 멈춘다
// (실사용 재현, 2026-09-17).

use serde_json::Value;
use std::path::PathBuf;

pub struct Readiness {
    pub ready: bool,
    pub reason: Option<String>,
}

fn claude_json_path() -> PathBuf {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default();
    PathBuf::from(home).join(".claude.json")
}

// checkDirectoryClaudeReady(claudeReadiness.js)의 순수 판정부 — 디스크 I/O(~/.claude.json 읽기)와
// 분리해서 단위 테스트를 쉽게 한다.
fn check_readiness_from_config(config: &Value, target_dir: &str) -> Readiness {
    // ~/.claude.json은 이 키를 항상 슬래시(/)로 정규화해서 저장한다 — targetDir은 Windows
    // 백슬래시(\)일 수 있어 정규화 없이 그대로 조회하면 실제로 존재하는 프로젝트도 못 찾는다
    // (실측 확인).
    let normalized_target = target_dir.replace('\\', "/");
    let Some(proj) = config.get("projects").and_then(|p| p.get(&normalized_target)) else {
        return Readiness {
            ready: false,
            reason: Some("이 디렉토리에서 claude를 인터랙티브로 실행해본 적이 없습니다".to_string()),
        };
    };
    let trusted = proj.get("hasTrustDialogAccepted").and_then(Value::as_bool).unwrap_or(false);
    if !trusted {
        return Readiness { ready: false, reason: Some("워크스페이스 신뢰(trust) 승인이 안 돼 있습니다".to_string()) };
    }
    Readiness { ready: true, reason: None }
}

/// checkDirectoryClaudeReady(claudeReadiness.js)와 동일 — ~/.claude.json을 못 읽으면(파일 없음/
/// 파싱 실패) 판단할 근거가 없으므로 막지 않고 통과시킨다(fail-open — 이 사전 검사가 없던 예전과
/// 동일한 상태로 되돌아갈 뿐, 실제 spawn 실패로 이어지진 않는다).
pub fn check_directory_claude_ready(target_dir: &str) -> Readiness {
    let raw = match std::fs::read_to_string(claude_json_path()) {
        Ok(s) => s,
        Err(_) => return Readiness { ready: true, reason: None },
    };
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Readiness { ready: true, reason: None },
    };
    check_readiness_from_config(&parsed, target_dir)
}

/// claudeNotReadyMessage(claudeReadiness.js)와 동일.
pub fn claude_not_ready_message(target_dir: &str, reason: &str) -> String {
    format!(
        "\"{target_dir}\" 디렉토리가 아직 claude 최초 실행 승인이 안 돼 있어({reason}) headless 세션이 시작 단계에서 영원히 멈출 수 있습니다 — 그 디렉토리에서 터미널로 'claude'를 한 번 실행해 뜨는 승인창을 눌러준 뒤 다시 시도하세요."
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn not_ready_when_project_missing() {
        let config = json!({ "projects": {} });
        let r = check_readiness_from_config(&config, "C:\\some\\dir");
        assert!(!r.ready);
        assert!(r.reason.unwrap().contains("실행해본 적이 없습니다"));
    }

    #[test]
    fn not_ready_when_trust_dialog_not_accepted() {
        let config = json!({ "projects": { "C:/some/dir": { "hasTrustDialogAccepted": false } } });
        let r = check_readiness_from_config(&config, "C:\\some\\dir");
        assert!(!r.ready);
        assert!(r.reason.unwrap().contains("워크스페이스 신뢰"));
    }

    #[test]
    fn ready_when_trust_dialog_accepted_and_path_normalized() {
        let config = json!({ "projects": { "C:/some/dir": { "hasTrustDialogAccepted": true } } });
        // 백슬래시로 조회해도 슬래시로 정규화된 키를 찾아야 한다.
        let r = check_readiness_from_config(&config, "C:\\some\\dir");
        assert!(r.ready);
        assert!(r.reason.is_none());
    }
}
