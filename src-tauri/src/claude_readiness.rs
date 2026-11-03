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
    let normalized_target = normalized_target.trim_end_matches('/');
    // 신뢰는 상위 폴더에서 이어받는다(실측 2026-11-03, claude 2.1.310: ~/.claude.json에 없는 하위 폴더도 신뢰된 저장소 안이면 --bg가 바로 뜬다).
    // 그래서 정확히 그 폴더의 기록만 보면 멀쩡한 폴더를 "승인 안 됨"으로 오판한다 — 상위 폴더 중 하나라도 신뢰돼 있으면 통과시킨다.
    if is_trusted_in_config(config, normalized_target) {
        return Readiness { ready: true, reason: None };
    }
    match config.get("projects").and_then(|p| p.get(normalized_target)) {
        None => Readiness { ready: false, reason: Some("이 디렉토리에서 claude를 인터랙티브로 실행해본 적이 없습니다".to_string()) },
        Some(_) => Readiness { ready: false, reason: Some("워크스페이스 신뢰(trust) 승인이 안 돼 있습니다".to_string()) },
    }
}

/// 그 폴더 또는 상위 폴더 중 하나라도 ~/.claude.json에서 hasTrustDialogAccepted=true인가.
fn is_trusted_in_config(config: &Value, normalized_dir: &str) -> bool {
    let Some(projects) = config.get("projects") else { return false };
    let mut cur = normalized_dir.to_string();
    loop {
        if projects.get(&cur).and_then(|p| p.get("hasTrustDialogAccepted")).and_then(Value::as_bool).unwrap_or(false) {
            return true;
        }
        match cur.rfind('/') {
            Some(i) if i > 0 => cur.truncate(i),
            _ => return false,
        }
    }
}

/// git worktree 폴더의 `.git` 파일("gitdir: <원본>/.git/worktrees/<이름>") 내용에서 원본 저장소 폴더를 뽑는다. worktree는 원본 저장소의 신뢰를 이어받는다
/// (실측: ~/.claude.json에 없는 worktree 폴더에서 --bg가 정상 시작).
fn worktree_main_repo(git_file_content: &str) -> Option<String> {
    let line = git_file_content.lines().find_map(|l| l.trim().strip_prefix("gitdir:"))?.trim().replace('\\', "/");
    let idx = line.find("/.git/worktrees/")?;
    Some(line[..idx].to_string())
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
    let result = check_readiness_from_config(&parsed, target_dir);
    if result.ready {
        return result;
    }
    // worktree라면 원본 저장소의 신뢰를 이어받는다.
    if let Ok(git_file) = std::fs::read_to_string(std::path::Path::new(target_dir).join(".git")) {
        if let Some(main_repo) = worktree_main_repo(&git_file) {
            if check_readiness_from_config(&parsed, &main_repo).ready {
                return Readiness { ready: true, reason: None };
            }
        }
    }
    result
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
    fn ready_when_a_parent_folder_is_trusted_even_if_the_folder_itself_is_unknown() {
        let config = json!({ "projects": { "C:/repo": { "hasTrustDialogAccepted": true } } });
        assert!(check_readiness_from_config(&config, "C:\\repo\\sub\\deep").ready);
        assert!(check_readiness_from_config(&config, "C:\\repo\\").ready, "끝의 구분자는 무시");
        assert!(!check_readiness_from_config(&config, "C:\\repo2\\x").ready, "이름만 비슷한 다른 폴더는 이어받지 않는다");
        let untrusted_parent = json!({ "projects": { "C:/Users/me": { "hasTrustDialogAccepted": false } } });
        assert!(!check_readiness_from_config(&untrusted_parent, "C:\\Users\\me\\new").ready, "상위가 승인 안 됐으면 그대로 미승인");
    }

    #[test]
    fn worktree_gitfile_points_to_the_main_repo() {
        assert_eq!(
            worktree_main_repo("gitdir: C:/Users/me/proj/.git/worktrees/feat-x\n").as_deref(),
            Some("C:/Users/me/proj")
        );
        assert_eq!(worktree_main_repo("gitdir: C:\\Users\\me\\proj\\.git\\worktrees\\x").as_deref(), Some("C:/Users/me/proj"));
        assert_eq!(worktree_main_repo("gitdir: C:/Users/me/proj/.git/modules/sub"), None, "서브모듈은 해당 없음");
        assert_eq!(worktree_main_repo("이상한 내용"), None);
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
