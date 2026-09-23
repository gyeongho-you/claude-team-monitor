// src/lib/longPromptGuard.js의 포팅 — claude 프로세스는 shell:false(Rust에선 기본값)로 spawn하므로
// 인자는 셸을 거치지 않고 Windows의 CreateProcessW 규칙을 그대로 따르는데, 전체 명령줄(프로그램명+
// 모든 인자 합)엔 32767자라는 OS 한도가 있다. 지시문(instruction)은 얼마든지 길어질 수 있어서, 그
// 길이를 그대로 argv 한 자리에 실으면 이 한도를 넘겨 spawn 자체가 실패한다(실사용 확인, ENAMETOOLONG)
// — --mcp-config JSON, 여러 플래그, 이스케이프 오버헤드까지 감안해 훨씬 낮은 문턱에서 미리 파일로
// 돌린다.

use crate::paths::prompts_dir;
use std::sync::OnceLock;

pub const MAX_INLINE_PROMPT_LENGTH: usize = 4000;

fn skill_prefix_pattern() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(|| regex::Regex::new(r"^(/\S+)\s").expect("고정 패턴"))
}

// resolveLongPrompt(longPromptGuard.js)의 파일 쓰기 없이 테스트 가능한 부분 — 실제 파일 쓰기는
// resolve_long_prompt가 담당한다.
fn build_redirect_message(prompt: &str, file_path: &str) -> String {
    let skill_prefix = skill_prefix_pattern()
        .captures(prompt)
        .and_then(|c| c.get(1))
        .map(|m| format!("{} ", m.as_str()))
        .unwrap_or_default();
    format!(
        "{skill_prefix}지시문이 너무 길어 Claude Team Monitor가 대신 파일로 저장했다. 이 파일을 읽고, 그 안의 내용 \
전체를 지시로 그대로 수행해라: \"{file_path}\"\n\n(다 읽었으면 이 파일은 지워도 된다.)"
    )
}

/// resolveLongPrompt(longPromptGuard.js)와 동일 — prompt가 짧으면 그대로 돌려주고, 길면 파일에
/// 써두고 그 파일을 읽으라는 짧은 지시로 바꿔 돌려준다. 호출부(run_claude_bg에 넘길 인자 조립부)는
/// 이 함수가 돌려준 값을 그대로 argv에 실으면 된다 — 어느 경로든 길이 걱정 없이 항상 안전하다.
pub fn resolve_long_prompt(prompt: &str) -> String {
    if prompt.chars().count() <= MAX_INLINE_PROMPT_LENGTH {
        return prompt.to_string();
    }
    let dir = prompts_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[resolve_long_prompt] prompts 디렉토리를 만들지 못했습니다: {e}");
        return prompt.to_string();
    }
    let file_path = dir.join(format!("{}.md", uuid::Uuid::new_v4()));
    if let Err(e) = std::fs::write(&file_path, prompt) {
        eprintln!("[resolve_long_prompt] 긴 지시문을 파일로 쓰지 못했습니다: {e}");
        return prompt.to_string();
    }
    build_redirect_message(prompt, &file_path.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_prompt_passes_through_unchanged() {
        assert_eq!(resolve_long_prompt("짧은 지시"), "짧은 지시");
    }

    #[test]
    fn long_prompt_redirects_to_file_and_preserves_skill_prefix() {
        let long_prompt = format!("/team-lead {}", "x".repeat(5000));
        let result = resolve_long_prompt(&long_prompt);
        assert!(result.starts_with("/team-lead "), "슬래시 커맨드 토큰이 안내문 앞에 그대로 살아있어야 한다: {result}");
        assert!(result.contains("파일로 저장했다"));
        // 실제로 파일이 쓰였는지도 확인 — 안내문에 적힌 경로가 실재해야 한다.
        let path_start = result.find('"').unwrap() + 1;
        let path_end = result[path_start..].find('"').unwrap() + path_start;
        let file_path = &result[path_start..path_end];
        let written = std::fs::read_to_string(file_path).expect("resolve_long_prompt가 파일을 실제로 썼어야 한다");
        assert_eq!(written, long_prompt);
        let _ = std::fs::remove_file(file_path);
    }

    #[test]
    fn long_prompt_without_skill_prefix_has_no_prefix_in_redirect() {
        let long_prompt = "x".repeat(5000);
        let result = resolve_long_prompt(&long_prompt);
        assert!(result.starts_with("지시문이 너무 길어"));
    }
}
