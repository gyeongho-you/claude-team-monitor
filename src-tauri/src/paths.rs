use std::path::{Path, PathBuf};

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

// installTeamLeadSkill(main.ts)의 REQUESTS_DIR — 팀장 세션(claude 프로세스, 이 앱과 별개)도 알아야
// 하는 고정 경로라서 앱 userData가 아니라 ~/.claude 밑에 둔다(main.ts와 동일한 이유).
pub fn requests_dir() -> PathBuf {
    claude_home().join("claude-team-monitor").join("requests")
}

// installTeamLeadSkill(main.ts)의 SKILL_DEST_DIR과 동일.
pub fn skill_dest_dir() -> PathBuf {
    claude_home().join("skills").join("team-lead")
}

// ---------------------------------------------------------------------------------------------
// 서브청크 γ(TAURI_NOTICE_QUEUE_DESIGN.md §2)에서 처음 필요해진 "이 앱 자신이 번들한 리소스"
// 경로 해석 — β까지는 이런 리소스를 읽는 함수가 없어서 이 문제 자체가 없었다. main.ts의
// getResourcesRoot()는 app.getAppPath()(dev=프로젝트 루트, 패키징 후=resources/app)를 쓰는데,
// Tauri에는 그 API 동치물이 AppHandle을 통해서만 있고(tauri::Manager::path().resource_dir()),
// 이 크레이트의 다른 순수 함수들(install_team_lead_skill 등)은 AppHandle 없이 호출되는 관례라서
// (concurrency.rs의 큐 액터 등에서 AppHandle을 들고 다니게 만드는 건 이번 청크 범위를 크게
// 벗어난다) 대신 실행 파일 기준 상대 경로를 우선 시도하고, 못 찾으면 컴파일 시점의
// CARGO_MANIFEST_DIR(src-tauri/) 기준 리포 루트로 폴백한다 — 후자는 `cargo test`/`tauri dev`
// 양쪽에서 항상 유효하다. 패키징(tauri build) 후에도 전자 경로가 맞으려면 tauri.conf.json의
// bundle.resources로 resources/·dist/ 폴더를 실행 파일 옆에 복사해둬야 하는데, dist/는 `npm run
// build`(esbuild)가 만드는 산출물이라 그 스크립트를 먼저 안 돌리면 존재하지 않고, tauri-build의
// build.rs는 bundle.resources에 적힌 경로가 `cargo build` 시점에 실재하지 않으면 빌드 자체를
// 실패시킨다(실측 확인 — `cargo test`가 아예 안 돌아갔다) — 그래서 이번 청크에서는
// tauri.conf.json에 그 설정을 추가하지 않았다. 패키징을 실제로 준비할 때는 `npm run build`를
// 먼저 실행해 dist/를 만든 뒤 bundle.resources를 추가하거나, tauri.conf.json을 여러 프로필로
// 나눠야 한다 — 이번 청크 범위 밖의 알려진 후속 작업으로 남긴다(I-3와 같은 성격의 "알려졌지만
// 이번엔 안 고친" 항목).
fn packaged_root() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf))
}

fn repo_root_dev() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

pub fn resources_root() -> PathBuf {
    if let Some(dir) = packaged_root() {
        let candidate = dir.join("resources");
        if candidate.exists() {
            return candidate;
        }
    }
    repo_root_dev().join("resources")
}

// installTeamLeadSkill(main.ts)의 SKILL_SRC와 동일.
pub fn skill_src_path() -> PathBuf {
    resources_root().join("skills").join("team-lead").join("SKILL.md")
}

// buildMemberSpawnCliArgs(main.ts)가 --mcp-config의 command/args로 넘기는 팀원 생성 MCP 서버
// 스크립트 경로 — esbuild가 dist/teamMemberServer.js로 번들한다(package.json build 스크립트 참고).
// resources_root()와 같은 이유로 실행 파일 옆 dist/를 먼저 보고, 없으면 리포 루트의 dist/로 폴백한다.
pub fn team_member_server_js_path() -> PathBuf {
    if let Some(dir) = packaged_root() {
        let candidate = dir.join("dist").join("teamMemberServer.js");
        if candidate.exists() {
            return candidate;
        }
    }
    repo_root_dev().join("dist").join("teamMemberServer.js")
}

// approvedMemberBriefing(main.ts)이 읽는 MEMBER_TEMPLATES_PATH와 동일 — app_data_dir()(아래)
// 밑에 둔다(Electron의 app.getPath('userData')와 같은 값).
pub fn member_templates_path() -> PathBuf {
    app_data_dir().join("memberTemplates.json")
}

// src/lib/teamMemberPaths.js의 PROMPTS_DIR과 정확히 같은 경로여야 한다 — long_prompt_guard.rs가
// argv 길이 한도를 넘는 지시문을 파일로 대신 써두는 곳(resolveLongPrompt와 동일한 이유).
pub fn prompts_dir() -> PathBuf {
    claude_home().join("claude-team-monitor").join("prompts")
}

// Electron의 app.getPath('userData') 기본값은 path.join(appData, app.getName())이고, app.getName()은
// package.json의 "name"(=claude-team-monitor)을 그대로 쓴다(main.ts에 app.setName 호출 없음을
// 확인함) — favorites.json/settings.json 등은 여전히 이 경로 밑에 둔다(leads.json만 예외, 아래
// leads_path()/legacy_leads_path() 참고).
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

// 예전엔 app_data_dir()(Electron의 app.getPath('userData')와 같은 값) 밑에 있었다 — 그러다 보니
// 이 경로를 Electron/Tauri 앱이 실행 중이어야만 알 수 있어서, 팀원 생성 MCP 서버(외부 claude
// 프로세스, 앱과 별개)는 --mcp-config env로 매번 전달받아야 했다. 앱 없이 터미널+스킬+MCP만으로
// 팀장을 등록/운영할 수 있게 하려면 MCP 서버가 이 경로를 스스로 계산할 수 있어야 해서,
// members_dir()/prompts_dir()과 같은 CLAUDE_HOME 컨벤션으로 옮겼다(src/lib/teamMemberPaths.js의
// LEADS_PATH와 정확히 같은 경로여야 한다). 기존 사용자의 구 경로 데이터는
// migrate_legacy_leads_path_if_needed()가 최초 1회 이전한다.
pub fn leads_path() -> PathBuf {
    claude_home().join("claude-team-monitor").join("leads.json")
}

// leads.json의 구 위치(app_data_dir() 밑, Electron 시절 경로) — 1회성 마이그레이션 전용으로만
// 쓴다(session_registry.rs의 migrate_legacy_leads_path_if_needed 참고).
pub fn legacy_leads_path() -> PathBuf {
    app_data_dir().join("leads.json")
}

// main.ts의 FAVORITES_PATH — "팀장 디렉토리" 즐겨찾기(Favorite) 목록.
pub fn favorites_path() -> PathBuf {
    app_data_dir().join("favorites.json")
}

// main.ts의 JOBS_DIR — claude CLI 자신의 daemon job 상태 파일(state.json)이 있는 곳.
// get-pending-choice/get-chat-unresolvable-detail이 여기서 읽는다.
pub fn jobs_dir() -> PathBuf {
    claude_home().join("jobs")
}

// main.ts의 STALL_ALERTS_PATH — 정체 감시가 만들어낸, 사용자 확인을 기다리는 StallAlert 목록.
pub fn stall_alerts_path() -> PathBuf {
    app_data_dir().join("stallAlerts.json")
}

// main.ts의 SETTINGS_PATH — stallIdleThresholdMin/stallCooldownMin 등 사용자가 바꿀 수 있는 값.
pub fn settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

// main.ts의 PENDING_NOTICES_PATH(서브청크 δ, TAURI_NOTICE_QUEUE_DESIGN.md §2) — 팀장에게
// 아직 전달 안 된 대기열 알림(PendingNotice) 목록.
pub fn pending_notices_path() -> PathBuf {
    app_data_dir().join("pendingNotices.json")
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
