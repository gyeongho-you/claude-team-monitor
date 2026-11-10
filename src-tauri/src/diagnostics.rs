// 진단 정보 — 사용자가 문제를 알릴 때 그대로 붙여 넣을 수 있는 한 덩어리 글을 만든다("앱 설정 → 앱 정보"의 "진단 정보 복사").
//
// 개인 정보가 새지 않게 한다: 홈 폴더 경로는 `~`로 바꾸고, 팀장 지시문·스크립트 본문·대화 내용은 넣지 않는다(슬롯 종류별 개수만).
// 앱이 스스로 원격으로 보내는 일은 없다 — 사용자가 복사해서 직접 붙여 넣을 때만 밖으로 나간다.

use crate::env_check::{EnvCheck, ToolStatus};
use crate::side_panel::PanelConfig;

/// 로그에서 끝쪽 몇 줄만 싣는다(너무 길면 붙여 넣기 어렵다).
const LOG_TAIL_LINES: usize = 60;
const LOG_READ_BYTES: u64 = 64 * 1024;

/// 텍스트 안의 홈 폴더 경로를 `~`로 바꾼다(슬래시·역슬래시 둘 다, 대소문자 무시 — Windows 경로 표기가 섞여 나온다).
pub(crate) fn redact_home(text: &str, home: &str) -> String {
    let home = home.trim_end_matches(['\\', '/']);
    if home.len() < 3 {
        return text.to_string();
    }
    let variants = [home.to_string(), home.replace('\\', "/"), home.replace('/', "\\"), home.replace('\\', "\\\\")];
    let mut out = text.to_string();
    for v in variants {
        out = replace_ignore_ascii_case(&out, &v, "~");
    }
    out
}

fn replace_ignore_ascii_case(haystack: &str, needle: &str, with: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let (h, n) = (haystack.to_ascii_lowercase(), needle.to_ascii_lowercase());
    let mut out = String::with_capacity(haystack.len());
    let mut i = 0;
    while let Some(pos) = h[i..].find(&n) {
        out.push_str(&haystack[i..i + pos]);
        out.push_str(with);
        i += pos + n.len();
    }
    out.push_str(&haystack[i..]);
    out
}

pub(crate) fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn tool_line(label: &str, t: &ToolStatus) -> String {
    // 기능 점검(claude 기능)에는 버전이 없다 — 문제가 없으면 "정상"으로 보인다.
    let no_version_word = if label == "claude 기능" { if t.problem.is_some() { "확인 필요" } else { "정상" } } else { "있음(버전 모름)" };
    let state = if !t.found { "없음".to_string() } else { t.version.clone().unwrap_or_else(|| no_version_word.to_string()) };
    match &t.problem {
        Some(p) => format!("- {label}: {state} — {}{}", if t.blocking { "[막는 문제] " } else { "[참고] " }, p),
        None => format!("- {label}: {state}"),
    }
}

pub(crate) struct DiagInfo<'a> {
    pub version: &'a str,
    pub build_unix: u64,
    pub os: &'a str,
    pub arch: &'a str,
    pub env: &'a EnvCheck,
    pub panel: &'a PanelConfig,
    pub leads_count: usize,
    pub log_tail: &'a str,
    pub generated_at: &'a str,
    pub home: &'a str,
}

pub(crate) fn render(info: &DiagInfo) -> String {
    let mut modes = std::collections::BTreeMap::new();
    for s in &info.panel.slots {
        *modes.entry(s.mode.as_str()).or_insert(0usize) += 1;
    }
    let slots = if modes.is_empty() { "없음".to_string() } else { modes.iter().map(|(m, c)| format!("{m} {c}개")).collect::<Vec<_>>().join(", ") };
    let resources: Vec<String> = info
        .env
        .resources
        .iter()
        .map(|r| format!("- {}: {}{}", r.name, if r.exists { "있음" } else { "없음" }, if r.packaged { "(설치 배치)" } else { "(개발용 경로)" }))
        .collect();
    let text = format!(
        "## Claude Team Monitor 진단 정보\n생성: {}\n\n### 앱\n- 버전: v{} (빌드 유닉스 시각 {})\n- 운영체제: {} / {}\n\n### 환경 점검\n{}\n{}\n{}\n{}\n\n### 설정 요약(내용은 싣지 않음)\n- 등록된 팀장 기록: {}개\n- 오른쪽 패널: {}, 슬롯 {}\n- 스크립트 슬롯 허용: {}\n\n### 최근 로그(app.log 끝 {}줄)\n{}\n",
        info.generated_at,
        info.version,
        info.build_unix,
        info.os,
        info.arch,
        tool_line("claude CLI", &info.env.claude),
        tool_line("claude 기능", &info.env.claude_features),
        tool_line("Node.js(스크립트용)", &info.env.node),
        resources.join("\n"),
        info.leads_count,
        if info.panel.enabled { "켜짐" } else { "꺼짐" },
        slots,
        if info.panel.scripts_allowed { "예" } else { "아니오" },
        LOG_TAIL_LINES,
        if info.log_tail.trim().is_empty() { "(비어 있음)" } else { info.log_tail },
    );
    let text = format!("{text}\n### claude 호출 계측(앱을 켠 뒤)\n{}\n{}\n", crate::agents_json::call_stats_summary(), crate::oauth_tmp_cleanup::summary());
    redact_home(&text, info.home)
}

fn read_log_tail() -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(crate::paths::app_log_path()) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(LOG_READ_BYTES)));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    tail_lines(&String::from_utf8_lossy(&buf), LOG_TAIL_LINES)
}

fn home_dir() -> String {
    std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_default()
}

#[tauri::command]
pub async fn get_diagnostics_command() -> Result<String, String> {
    tokio::task::spawn_blocking(|| {
        let env = crate::env_check::current_env_check();
        let panel = crate::side_panel::load_panel_config();
        let leads_count = crate::session_registry::load_leads().len();
        let tail = read_log_tail();
        let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC").to_string();
        render(&DiagInfo {
            version: crate::update_check::current_version(),
            build_unix: crate::update_check::build_unix_seconds(),
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            env: &env,
            panel: &panel,
            leads_count,
            log_tail: &tail,
            generated_at: &now,
            home: &home_dir(),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// 로그가 있는 폴더(앱 데이터 폴더)를 파일 탐색기로 연다. 경로는 앱이 정한 고정 위치라 사용자 입력이 섞이지 않는다.
#[tauri::command]
pub fn open_log_folder_command() -> Result<(), String> {
    let dir = crate::paths::app_data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("폴더를 만들지 못했습니다: {e}"))?;
    let program = if cfg!(windows) { "explorer" } else if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    std::process::Command::new(program).arg(&dir).spawn().map(|_| ()).map_err(|e| format!("폴더를 열지 못했습니다: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env_check::{ResourceStatus, ToolStatus};

    fn tool(found: bool, version: Option<&str>, problem: Option<&str>, blocking: bool) -> ToolStatus {
        ToolStatus { found, version: version.map(str::to_string), problem: problem.map(str::to_string), blocking }
    }

    fn env() -> EnvCheck {
        EnvCheck {
            claude: tool(true, Some("2.1.319"), None, false),
            claude_features: tool(true, None, Some("--name이 없다"), false),
            node: tool(false, None, None, false),
            resources: vec![ResourceStatus { name: "resources/skills/team-lead/SKILL.md".into(), path: "C:\\Users\\kim\\app\\SKILL.md".into(), exists: true, packaged: true, problem: None }],
            ok: true,
        }
    }

    #[test]
    fn the_home_folder_is_replaced_in_every_spelling_and_case() {
        let t = "열기 C:\\Users\\Kim\\AppData\\x, c:/users/kim/AppData, C:\\\\Users\\\\Kim\\\\y, 다른 C:\\Users\\Lee\\z";
        let r = redact_home(t, "C:\\Users\\Kim");
        assert!(!r.to_lowercase().contains("kim"), "{r}");
        assert!(r.contains("~\\AppData\\x") && r.contains("~/AppData") && r.contains("~\\\\y"));
        assert!(r.contains("C:\\Users\\Lee"), "다른 사용자의 경로는 건드리지 않는다");
        assert_eq!(redact_home("abc", ""), "abc", "홈 경로를 모르면 그대로 둔다");
        assert_eq!(redact_home("abc", "C:"), "abc", "너무 짧은 경로로 엉뚱한 곳을 바꾸지 않는다");
    }

    #[test]
    fn tail_keeps_only_the_last_lines() {
        assert_eq!(tail_lines("a\nb\nc\nd", 2), "c\nd");
        assert_eq!(tail_lines("a\nb", 10), "a\nb");
        assert_eq!(tail_lines("", 3), "");
    }

    #[test]
    fn the_report_has_versions_environment_and_counts_but_never_instructions_scripts_or_the_home_path() {
        use crate::side_panel::PanelSlot;
        let mut panel = PanelConfig { enabled: true, scripts_allowed: true, ..Default::default() };
        let mut slot: PanelSlot = serde_json::from_value(serde_json::json!({
            "id": "s1", "name": "비밀 이름", "mode": "script", "script": "console.log('SECRET_SCRIPT_BODY')", "instruction": "SECRET_INSTRUCTION",
            "scope": "all", "preset": "artifact-reports", "autoUpdate": false, "aiModel": "sonnet", "aiInclude": "none", "enabled": true, "createdAt": 1
        }))
        .unwrap();
        panel.slots.push(slot.clone());
        slot.mode = "manual".into();
        panel.slots.push(slot);
        let e = env();
        let text = render(&DiagInfo {
            version: "0.1.2",
            build_unix: 1_800_000_000,
            os: "windows",
            arch: "x86_64",
            env: &e,
            panel: &panel,
            leads_count: 4,
            log_tail: "[t] 실패 C:\\Users\\kim\\AppData\\app.log",
            generated_at: "2026-11-09 00:00:00 UTC",
            home: "C:\\Users\\kim",
        });
        assert!(text.contains("v0.1.2") && text.contains("windows / x86_64") && text.contains("2.1.319"));
        assert!(text.contains("[참고] --name이 없다") && text.contains("Node.js(스크립트용): 없음"));
        assert!(text.contains("claude 기능: 정상") == false, "문제가 있는 기능 점검은 정상이라고 쓰지 않는다");
        assert!(text.contains("등록된 팀장 기록: 4개") && text.contains("manual 1개, script 1개") && text.contains("스크립트 슬롯 허용: 예"));
        assert!(text.contains("SKILL.md: 있음(설치 배치)"));
        assert!(!text.contains("SECRET_SCRIPT_BODY") && !text.contains("SECRET_INSTRUCTION") && !text.contains("비밀 이름"), "내용은 싣지 않는다");
        assert!(!text.to_lowercase().contains("c:\\users\\kim") && text.contains("~\\AppData\\app.log"), "{text}");
    }

    #[test]
    fn an_empty_log_is_reported_as_empty() {
        let e = env();
        let text = render(&DiagInfo { version: "1", build_unix: 0, os: "x", arch: "y", env: &e, panel: &PanelConfig::default(), leads_count: 0, log_tail: "  \n", generated_at: "t", home: "" });
        assert!(text.contains("(비어 있음)") && text.contains("슬롯 없음"));
    }
}
