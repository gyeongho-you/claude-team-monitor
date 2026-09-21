// src/lib/claudeBgOutput.js의 포팅 — claude --bg / claude --bg --resume 프로세스의 stdout에서
// 짧은 id(또는 원치 않는 복사본 id)를 뽑아내는 순수 파싱 함수. run_claude_bg(spawn_resume.rs)와
// 팀원 생성 MCP 서버(아직 Rust로 안 옮김) 양쪽이 같은 파싱 규칙을 써야 하므로 공용 모듈로 뽑는다
// (main.ts/claudeBgOutput.js와 같은 이유 — 각자 구현하면 CLI 출력 형식이 바뀔 때 한쪽만 고치고
// 잊어버리는 드리프트가 생기기 쉽다).

use regex::Regex;
use std::sync::OnceLock;

fn ansi_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").expect("고정 패턴"))
}

fn backgrounded_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)backgrounded\s*[·:]\s*([a-f0-9]+)").expect("고정 패턴"))
}

fn started_copy_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)started a copy as\s*([a-f0-9]+)").expect("고정 패턴"))
}

fn strip_ansi(stdout: &str) -> String {
    ansi_pattern().replace_all(stdout, "").into_owned()
}

/// extractBackgroundedId(claudeBgOutput.js)와 동일 — claude가 실행 환경에 따라 id에 ANSI 색상
/// 코드를 입혀서 찍을 때가 있어(실측 확인: MCP 서버 자식 프로세스로 spawn했을 때) 매칭 전에 먼저
/// 걷어낸다.
pub fn extract_backgrounded_id(stdout: &str) -> Option<String> {
    let clean = strip_ansi(stdout);
    backgrounded_pattern().captures(&clean).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
}

/// extractStartedCopyId(claudeBgOutput.js)와 동일 — "started a copy as <id>" 문구를 잡아낸다
/// (A-1/A-2 방어의 1차 방어선, TAURI_NOTICE_QUEUE_DESIGN.md §1 A-1 참고).
pub fn extract_started_copy_id(stdout: &str) -> Option<String> {
    let clean = strip_ansi(stdout);
    started_copy_pattern().captures(&clean).and_then(|c| c.get(1)).map(|m| m.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_plain_backgrounded_id() {
        assert_eq!(extract_backgrounded_id("backgrounded · a7471441"), Some("a7471441".to_string()));
        assert_eq!(extract_backgrounded_id("backgrounded: a7471441"), Some("a7471441".to_string()));
        // (?i)는 매칭만 대소문자 무관하게 할 뿐 캡처된 문자열 자체를 소문자로 바꾸지는 않는다 —
        // claudeBgOutput.js의 /i 플래그와 동일한 동작(원본 JS도 대소문자를 안 바꾼다).
        assert_eq!(extract_backgrounded_id("BACKGROUNDED · A7471441"), Some("A7471441".to_string()));
    }

    #[test]
    fn extracts_backgrounded_id_through_ansi_codes() {
        // 실측 확인된 실제 출력 형태(MCP 서버 자식 프로세스 spawn 시).
        let stdout = "backgrounded \u{00b7} \x1b[36ma7471441\x1b[39m (idle)";
        assert_eq!(extract_backgrounded_id(stdout), Some("a7471441".to_string()));
    }

    #[test]
    fn returns_none_without_marker() {
        assert_eq!(extract_backgrounded_id("some unrelated output"), None);
        assert_eq!(extract_backgrounded_id(""), None);
    }

    #[test]
    fn extracts_started_copy_id() {
        let stdout = "note: session abc123 is already running in the background, so this started a copy as def456.";
        assert_eq!(extract_started_copy_id(stdout), Some("def456".to_string()));
    }

    #[test]
    fn started_copy_id_absent_on_normal_resume() {
        assert_eq!(extract_started_copy_id("backgrounded · a7471441"), None);
    }
}
