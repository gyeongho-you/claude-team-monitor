// 새 버전 확인 — GitHub 저장소의 "최신 릴리스"와 지금 앱 버전을 비교해 알려준다(자동 설치는 하지 않는다: 이 앱은 설치 프로그램 없이 exe를 직접
// 바꿔 끼우는 방식이라 알림 + 릴리스 페이지 열기까지만 한다).
// 렌더러는 CSP(default-src 'self')라 외부 요청을 못 하므로 여기서 한다. HTTP 클라이언트 크레이트를 새로 들이지 않고 Windows에 기본 내장된
// curl.exe를 쓴다(attach_terminal.rs 등이 이미 외부 프로세스를 같은 방식으로 부른다).

use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};

const REPO: &str = "gyeongho-you/claude-team-monitor";
const RELEASE_URL_PREFIX: &str = "https://github.com/gyeongho-you/claude-team-monitor/";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpdateCheckResult {
    pub current: String,
    pub latest: Option<String>,
    #[serde(rename = "updateAvailable")]
    pub update_available: bool,
    pub url: Option<String>,
    pub name: Option<String>,
    #[serde(rename = "publishedAt")]
    pub published_at: Option<String>,
    /// 저장소에 릴리스가 아직 하나도 없다(GitHub가 404를 돌려줌).
    #[serde(rename = "noRelease")]
    pub no_release: bool,
    pub error: Option<String>,
}

impl UpdateCheckResult {
    fn base(current: &str) -> Self {
        UpdateCheckResult { current: current.to_string(), latest: None, update_available: false, url: None, name: None, published_at: None, no_release: false, error: None }
    }
    fn failed(current: &str, msg: impl Into<String>) -> Self {
        UpdateCheckResult { error: Some(msg.into()), ..Self::base(current) }
    }
}

/// "v0.2.1", "0.2" 같은 태그를 숫자 조각으로 바꾼다. 숫자로 시작하지 않으면 None. "-beta" 같은 꼬리표는 떼고 (조각들, 꼬리표 있음)을 돌려준다.
fn parse_version(v: &str) -> Option<(Vec<u64>, bool)> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let (core, pre) = match v.split_once(['-', '+']) {
        Some((c, _)) => (c, true),
        None => (v, false),
    };
    let parts: Option<Vec<u64>> = core.split('.').map(|p| p.parse::<u64>().ok()).collect();
    let parts = parts?;
    if parts.is_empty() {
        None
    } else {
        Some((parts, pre))
    }
}

/// latest가 current보다 새 버전이면 true. 해석할 수 없으면 false(알림을 잘못 띄우는 쪽보다 놓치는 쪽이 낫다).
pub(crate) fn is_newer(latest: &str, current: &str) -> bool {
    let (Some((l, l_pre)), Some((c, c_pre))) = (parse_version(latest), parse_version(current)) else { return false };
    let n = l.len().max(c.len());
    for i in 0..n {
        let (a, b) = (l.get(i).copied().unwrap_or(0), c.get(i).copied().unwrap_or(0));
        if a != b {
            return a > b;
        }
    }
    // 숫자가 같으면: 정식(꼬리표 없음)이 시험판(꼬리표 있음)보다 새 것이다.
    c_pre && !l_pre
}

#[derive(Deserialize)]
struct ReleaseJson {
    tag_name: Option<String>,
    name: Option<String>,
    html_url: Option<String>,
    published_at: Option<String>,
}

/// GitHub "latest release" 응답 본문을 해석한다(순수 함수 — 시험하기 쉽게 HTTP와 분리).
pub(crate) fn interpret_response(current: &str, http_code: u16, body: &str) -> UpdateCheckResult {
    if http_code == 404 {
        return UpdateCheckResult { no_release: true, ..UpdateCheckResult::base(current) };
    }
    if http_code == 403 || http_code == 429 {
        return UpdateCheckResult::failed(current, "GitHub가 요청을 잠시 막았습니다(요청이 너무 많음). 잠시 후 다시 확인하세요.");
    }
    if http_code != 200 {
        return UpdateCheckResult::failed(current, format!("GitHub 응답이 예상과 다릅니다(HTTP {http_code})."));
    }
    let Ok(rel) = serde_json::from_str::<ReleaseJson>(body) else {
        return UpdateCheckResult::failed(current, "GitHub 응답을 해석하지 못했습니다.");
    };
    let Some(tag) = rel.tag_name.filter(|t| !t.is_empty()) else {
        return UpdateCheckResult::failed(current, "최신 릴리스의 버전(태그)을 찾지 못했습니다.");
    };
    UpdateCheckResult {
        update_available: is_newer(&tag, current),
        latest: Some(tag),
        // 열 주소는 이 저장소의 릴리스 페이지일 때만 믿는다.
        url: rel.html_url.filter(|u| u.starts_with(RELEASE_URL_PREFIX)),
        name: rel.name.filter(|n| !n.is_empty()),
        published_at: rel.published_at,
        ..UpdateCheckResult::base(current)
    }
}

fn fetch_latest_release() -> Result<(u16, String), String> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let mut cmd = Command::new("curl");
    cmd.args(["-sS", "-L", "--max-time", "10", "-H", "Accept: application/vnd.github+json", "-H", "User-Agent: claude-team-monitor", "-w", "\n%{http_code}", &url]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("curl를 실행하지 못했습니다: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("GitHub에 연결하지 못했습니다(인터넷 연결을 확인하세요): {}", err.trim().lines().next().unwrap_or("")));
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    let (body, code) = text.rsplit_once('\n').ok_or_else(|| "응답 형식이 올바르지 않습니다.".to_string())?;
    let code: u16 = code.trim().parse().map_err(|_| "응답 코드를 읽지 못했습니다.".to_string())?;
    Ok((code, body.to_string()))
}

pub(crate) fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[tauri::command]
pub fn get_app_version_command() -> String {
    current_version().to_string()
}

#[tauri::command]
pub async fn check_for_update_command() -> UpdateCheckResult {
    let current = current_version().to_string();
    tokio::task::spawn_blocking(move || match fetch_latest_release() {
        Ok((code, body)) => interpret_response(&current, code, &body),
        Err(e) => UpdateCheckResult::failed(&current, e),
    })
    .await
    .unwrap_or_else(|_| UpdateCheckResult::failed(current_version(), "업데이트 확인 중 오류가 발생했습니다."))
}

fn is_safe_release_url(url: &str) -> bool {
    url.starts_with(RELEASE_URL_PREFIX) && url.len() < 300 && url.chars().all(|c| c.is_ascii_alphanumeric() || "/._-:%#?=~".contains(c))
}

/// 릴리스 페이지를 기본 브라우저로 연다 — 이 저장소의 주소만 허용한다.
#[tauri::command]
pub fn open_release_page_command(url: String) -> bool {
    if !is_safe_release_url(&url) {
        return false;
    }
    let mut cmd = Command::new("rundll32");
    cmd.args(["url.dll,FileProtocolHandler", &url]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_versions_are_detected_by_numeric_parts() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("0.1.10", "0.1.9"), "문자열이 아니라 숫자로 비교한다");
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(!is_newer("v0.1", "0.1.0"), "빠진 조각은 0으로 본다");
    }

    #[test]
    fn prerelease_is_older_than_the_same_numbers() {
        assert!(is_newer("0.2.0", "0.2.0-beta"));
        assert!(!is_newer("0.2.0-beta", "0.2.0"));
    }

    #[test]
    fn unparseable_versions_never_claim_an_update() {
        assert!(!is_newer("latest", "0.1.0"));
        assert!(!is_newer("", "0.1.0"));
        assert!(!is_newer("0.2.0", "dev"));
    }

    #[test]
    fn response_with_a_newer_release_is_reported() {
        let body = r#"{"tag_name":"v0.2.0","name":"0.2.0 릴리스","html_url":"https://github.com/gyeongho-you/claude-team-monitor/releases/tag/v0.2.0","published_at":"2026-11-03T00:00:00Z"}"#;
        let r = interpret_response("0.1.0", 200, body);
        assert!(r.update_available);
        assert_eq!(r.latest.as_deref(), Some("v0.2.0"));
        assert_eq!(r.url.as_deref(), Some("https://github.com/gyeongho-you/claude-team-monitor/releases/tag/v0.2.0"));
        assert!(r.error.is_none() && !r.no_release);
        let same = interpret_response("0.2.0", 200, body);
        assert!(!same.update_available && same.latest.is_some());
    }

    #[test]
    fn response_edge_cases() {
        assert!(interpret_response("0.1.0", 404, "{}").no_release, "릴리스가 하나도 없으면 404");
        assert!(interpret_response("0.1.0", 403, "{}").error.is_some());
        assert!(interpret_response("0.1.0", 500, "{}").error.is_some());
        assert!(interpret_response("0.1.0", 200, "이건 JSON이 아님").error.is_some());
        assert!(interpret_response("0.1.0", 200, "{}").error.is_some(), "태그가 없으면 오류");
        // 다른 저장소 주소는 열 주소로 믿지 않는다
        let r = interpret_response("0.1.0", 200, r#"{"tag_name":"v9.0.0","html_url":"https://evil.example/x"}"#);
        assert!(r.update_available && r.url.is_none());
    }

    #[test]
    fn only_this_repos_release_pages_may_be_opened() {
        assert!(is_safe_release_url("https://github.com/gyeongho-you/claude-team-monitor/releases/tag/v0.2.0"));
        assert!(!is_safe_release_url("https://github.com/other/repo/releases"));
        assert!(!is_safe_release_url("https://github.com/gyeongho-you/claude-team-monitor/releases&calc"));
        assert!(!is_safe_release_url("file:///c:/windows/system32/calc.exe"));
    }
}
