use std::path::PathBuf;

// src/lib/teamMemberPaths.js와 정확히 같은 경로여야 한다 — 팀원 생성 MCP 서버(외부 claude 세션)도
// 이 디렉토리에 직접 파일을 쓰므로, 한쪽만 경로를 바꾸면 "분명 등록했는데 안 보인다" 사고로 이어진다.
pub fn claude_home() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".claude")
}

pub fn members_dir() -> PathBuf {
    claude_home().join("claude-team-monitor").join("members")
}

// src/lib/teamMemberPaths.js의 PROMPTS_DIR과 정확히 같은 경로여야 한다 — long_prompt_guard.rs가
// argv 길이 한도를 넘는 지시문을 파일로 대신 써두는 곳(resolveLongPrompt와 동일한 이유).
pub fn prompts_dir() -> PathBuf {
    claude_home().join("claude-team-monitor").join("prompts")
}

// Electron의 app.getPath('userData') 기본값은 path.join(appData, app.getName())이고, app.getName()은
// package.json의 "name"(=claude-team-monitor)을 그대로 쓴다(main.ts에 app.setName 호출 없음을
// 확인함) — 실제로 %APPDATA%\claude-team-monitor\leads.json에 데이터가 있는 것도 확인했다. 이
// 앱(Tauri)도 같은 경로를 읽어야 Electron 시절에 등록된 팀장/팀원이 그대로 보인다.
pub fn app_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        PathBuf::from(appdata).join("claude-team-monitor")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("claude-team-monitor")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".config").join("claude-team-monitor")
    }
}

pub fn leads_path() -> PathBuf {
    app_data_dir().join("leads.json")
}

// main.ts의 STALL_ALERTS_PATH — 정체 감시가 만들어낸, 사용자 확인을 기다리는 StallAlert 목록.
pub fn stall_alerts_path() -> PathBuf {
    app_data_dir().join("stallAlerts.json")
}

// main.ts의 SETTINGS_PATH — stallIdleThresholdMin/stallCooldownMin 등 사용자가 바꿀 수 있는 값.
pub fn settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

// main.ts의 APP_LOG_PATH — logCritical(logging.rs)이 원인을 알 수 없이 겪는 실패의 핵심 실패
// 지점만 콘솔과 별개로 남기는 곳.
pub fn app_log_path() -> PathBuf {
    app_data_dir().join("app.log")
}

// daily-journal 자신의 config.ts(getTodayDir)와 같은 순서로 읽는다 — main.ts의
// resolveJournalDataDir과 동일. daily-journal은 별도 설치 플러그인이라 없을 수도 있다(fail-open).
pub fn daily_journal_dir() -> PathBuf {
    claude_home().join("daily-journal")
}

// main.ts의 SESSION_EDITS_DIR — daily-journal이 세션당 캐시해둔 프로젝트명을 읽는 데 쓴다
// (resolveProjectName).
pub fn session_edits_dir() -> PathBuf {
    claude_home().join("session-edits")
}

// main.ts의 PROJECTS_DIR — claude CLI 자신이 세션마다 남기는 원본 트랜스크립트(jsonl) 위치.
// getSessionAiTitle(자동 생성된 세션 주제 찾기)가 여기서 읽는다.
pub fn projects_dir() -> PathBuf {
    claude_home().join("projects")
}

// pathGuard.js의 isSafeId와 동일한 규칙. 팀원 등록 파일(~/.claude/claude-team-monitor/members/*.json)은
// 이 앱이 아니라 외부(팀장) claude 세션이 SKILL.md 안내에 따라 직접 파일로 써서 남긴다 — memberId
// 필드값을 검증 없이 신뢰하면 안 된다(팀원 코드리뷰에서 지적된 경로 조작 위험. 이번 포팅 범위는
// 읽기 전용 조회라 삭제/쓰기 경로에 직접 이어붙이진 않지만, 화면에 잘못된 값이 그대로 노출되는 것도
// 막기 위해 원본과 동일하게 걸러낸다).
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
