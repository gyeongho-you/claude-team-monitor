// 실행 환경 사전 점검 — 이 앱이 일하려면 사용자 PC에 `claude` CLI와 `node`가 있어야 한다(팀원 생성용 MCP 서버를 `node`로 띄운다).
// 없거나 너무 오래된 채로 쓰다가 "왜 안 되지?" 하고 막히는 일이 없도록, 앱이 시작할 때 한 번 확인해서 화면 위쪽에 알기 쉽게 안내한다(env-banner).
//
// 판단은 순수 함수(parse_version, assess_*)로 분리해 어떤 OS에서든 시험하고, 실제 `--version` 실행만 얇게 감쌌다.
// claude CLI는 공개 호환성 보장이 없어서(이 앱은 `--bg`, `agents --json` 같은 관찰된 동작에 의존한다) "검증한 버전"을 기록해 두고,
// 그보다 새 minor 버전이면 막지는 않고 "검증하지 않은 버전"이라고만 알린다.

use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

/// 이 앱을 실제로 돌려 확인한 claude CLI 버전(major.minor). 올릴 때는 실제로 확인한 뒤에만 올린다.
pub(crate) const CLAUDE_TESTED: (u32, u32) = (2, 1);
/// 이 아래 major 버전은 `--bg` 같은 기능이 없어 동작하지 않는다.
pub(crate) const CLAUDE_MIN_MAJOR: u32 = 2;
pub(crate) const NODE_MIN_MAJOR: u32 = 18;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub found: bool,
    pub version: Option<String>,
    /// 사용자에게 보여 줄 문제 설명(없으면 None)
    pub problem: Option<String>,
    /// true면 앱이 제대로 일하지 못하는 문제(없음/너무 오래됨), false면 참고용 안내(검증하지 않은 버전 등)
    pub blocking: bool,
}

/// 앱이 실행 중에 읽는 파일(팀원 생성 MCP 서버, 팀장 스킬)이 있는지.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResourceStatus {
    pub name: String,
    pub path: String,
    pub exists: bool,
    /// true면 실행 파일 옆(설치된 배치)에서 찾았다, false면 개발용 폴백(빌드한 PC의 소스 폴더)이다
    pub packaged: bool,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvCheck {
    pub claude: ToolStatus,
    pub node: ToolStatus,
    pub resources: Vec<ResourceStatus>,
    /// 막는 문제가 하나도 없으면 true
    pub ok: bool,
}

/// 파일이 없으면 설치가 불완전하다는 안내를 붙인다. 개발용 폴백(packaged=false)으로 찾았더라도 파일이 있으면 문제없다(개발 PC).
pub(crate) fn assess_resource(name: &str, path: &std::path::Path, packaged: bool) -> ResourceStatus {
    let exists = path.exists();
    let problem = if exists {
        None
    } else {
        Some(format!("앱 설치가 불완전합니다: {name} 파일을 찾지 못했습니다({}). 팀원 생성·스킬 설치가 되지 않습니다. 설치 파일(*-setup.exe)로 설치하거나, 압축 파일을 쓴다면 exe 옆에 dist/와 resources/ 폴더를 함께 두세요.", path.display()))
    };
    ResourceStatus { name: name.to_string(), path: path.to_string_lossy().to_string(), exists, packaged, problem }
}

/// `--version` 출력에서 "2.1.318"처럼 점으로 이어진 첫 번째 숫자 버전을 뽑는다("2.1.318 (Claude Code)", "v22.14.0" 모두 처리).
pub(crate) fn parse_version(output: &str) -> Option<String> {
    for token in output.split_whitespace() {
        let t = token.trim_start_matches(['v', 'V']);
        let parts: Vec<&str> = t.split('.').collect();
        if parts.len() >= 2 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) {
            return Some(t.to_string());
        }
    }
    None
}

pub(crate) fn version_tuple(v: &str) -> Option<(u32, u32, u32)> {
    let mut it = v.split('.').map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

pub(crate) fn assess_claude(version: Option<&str>) -> ToolStatus {
    let Some(v) = version else {
        return ToolStatus { found: true, version: None, problem: Some("claude CLI는 찾았지만 버전을 읽지 못했습니다. 터미널에서 `claude --version`이 되는지 확인하세요.".into()), blocking: false };
    };
    let Some((major, minor, _)) = version_tuple(v) else {
        return ToolStatus { found: true, version: Some(v.into()), problem: Some(format!("claude CLI 버전({v})을 해석하지 못했습니다.")), blocking: false };
    };
    if major < CLAUDE_MIN_MAJOR {
        return ToolStatus {
            found: true,
            version: Some(v.into()),
            problem: Some(format!("claude CLI {v}는 너무 오래됐습니다(백그라운드 세션 기능이 필요합니다). {}.x 이상으로 업데이트하세요: `claude update`", CLAUDE_MIN_MAJOR)),
            blocking: true,
        };
    }
    if (major, minor) > CLAUDE_TESTED {
        return ToolStatus {
            found: true,
            version: Some(v.into()),
            problem: Some(format!("claude CLI {v}는 이 앱이 검증한 버전({}.{}.x)보다 새롭습니다. 대부분 동작하겠지만 팀장·팀원 시작이 이상하면 이 점을 먼저 의심하세요.", CLAUDE_TESTED.0, CLAUDE_TESTED.1)),
            blocking: false,
        };
    }
    ToolStatus { found: true, version: Some(v.into()), problem: None, blocking: false }
}

pub(crate) fn assess_node(version: Option<&str>) -> ToolStatus {
    let Some(v) = version else {
        return ToolStatus { found: true, version: None, problem: Some("node는 찾았지만 버전을 읽지 못했습니다.".into()), blocking: false };
    };
    match version_tuple(v) {
        Some((major, _, _)) if major < NODE_MIN_MAJOR => ToolStatus {
            found: true,
            version: Some(v.into()),
            problem: Some(format!("Node.js {v}는 너무 오래됐습니다. {NODE_MIN_MAJOR} 이상이 필요합니다(팀원 생성용 MCP 서버를 node로 실행합니다)."))
            ,
            blocking: true,
        },
        _ => ToolStatus { found: true, version: Some(v.into()), problem: None, blocking: false },
    }
}

fn not_found(name: &str, how: &str) -> ToolStatus {
    ToolStatus { found: false, version: None, problem: Some(format!("{name}를 찾지 못했습니다. {how}")), blocking: true }
}

/// `<program> --version`을 5초 안에 실행해 출력을 돌려준다. 실행 자체가 안 되면 None(= 없음).
fn run_version(program: &str) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        s
    });
    match child.wait_timeout(Duration::from_secs(5)) {
        Ok(Some(_)) => Some(reader.join().unwrap_or_default()),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Some(String::new())
        }
    }
}

pub(crate) fn check_environment_with(run: &dyn Fn(&str) -> Option<String>, resources: Vec<ResourceStatus>) -> EnvCheck {
    let claude = match run("claude") {
        None => not_found("claude CLI", "https://docs.claude.com/claude-code 에서 설치하고 로그인한 뒤 앱을 다시 시작하세요."),
        Some(out) => assess_claude(parse_version(&out).as_deref()),
    };
    let node = match run("node") {
        None => not_found("Node.js", "https://nodejs.org 에서 설치하고 앱을 다시 시작하세요(팀원 생성용 MCP 서버를 node로 실행합니다)."),
        Some(out) => assess_node(parse_version(&out).as_deref()),
    };
    let ok = !claude.blocking && !node.blocking && resources.iter().all(|r| r.exists);
    EnvCheck { claude, node, resources, ok }
}

fn current_resources() -> Vec<ResourceStatus> {
    let mcp = crate::paths::team_member_server_js_path();
    let skill = crate::paths::skill_src_path();
    let (p1, p2) = (crate::paths::is_next_to_exe(&mcp), crate::paths::is_next_to_exe(&skill));
    vec![assess_resource("dist/teamMemberServer.js", &mcp, p1), assess_resource("resources/skills/team-lead/SKILL.md", &skill, p2)]
}

#[tauri::command]
pub async fn check_environment_command() -> Result<EnvCheck, String> {
    tokio::task::spawn_blocking(|| check_environment_with(&run_version, current_resources())).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_parsed_from_real_world_outputs() {
        assert_eq!(parse_version("2.1.318 (Claude Code)\n").as_deref(), Some("2.1.318"));
        assert_eq!(parse_version("v22.14.0\n").as_deref(), Some("22.14.0"));
        assert_eq!(parse_version("Claude Code version 2.1.5").as_deref(), Some("2.1.5"));
        assert_eq!(parse_version("node: command not found"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("1.2.x"), None, "숫자가 아닌 조각이 섞이면 버전이 아니다");
        assert_eq!(version_tuple("2.1.318"), Some((2, 1, 318)));
        assert_eq!(version_tuple("22.14"), Some((22, 14, 0)));
        assert_eq!(version_tuple("abc"), None);
    }

    #[test]
    fn claude_versions_are_judged_old_tested_or_newer() {
        let tested = assess_claude(Some("2.1.318"));
        assert!(tested.problem.is_none() && !tested.blocking, "검증한 버전이면 안내가 없다");
        assert!(assess_claude(Some("2.1.999")).problem.is_none(), "같은 2.1.x면 패치 버전은 상관없다");
        let old = assess_claude(Some("1.9.0"));
        assert!(old.blocking && old.problem.as_deref().unwrap().contains("업데이트"), "major가 낮으면 막는 문제");
        let newer = assess_claude(Some("2.2.0"));
        assert!(!newer.blocking && newer.problem.as_deref().unwrap().contains("검증한 버전"), "새 minor는 막지 않고 알리기만 한다");
        assert!(!assess_claude(Some("3.0.0")).blocking);
        let unreadable = assess_claude(None);
        assert!(unreadable.found && !unreadable.blocking && unreadable.problem.is_some());
    }

    #[test]
    fn node_versions_below_the_minimum_block() {
        assert!(assess_node(Some("22.14.0")).problem.is_none());
        assert!(assess_node(Some("18.0.0")).problem.is_none());
        assert!(assess_node(Some("16.20.2")).blocking);
        assert!(!assess_node(None).blocking);
    }

    #[test]
    fn missing_tools_are_reported_with_how_to_fix_and_make_the_check_not_ok() {
        let none = check_environment_with(&|_| None, vec![]);
        assert!(!none.ok && !none.claude.found && !none.node.found);
        assert!(none.claude.problem.as_deref().unwrap().contains("docs.claude.com") && none.node.problem.as_deref().unwrap().contains("nodejs.org"));
        let good = check_environment_with(&|p| Some(if p == "claude" { "2.1.318 (Claude Code)".to_string() } else { "v22.14.0".to_string() }), vec![]);
        assert!(good.ok && good.claude.problem.is_none() && good.node.problem.is_none());
        // 새 minor의 claude는 참고용 안내만 있고 전체는 ok
        let newer = check_environment_with(&|p| Some(if p == "claude" { "2.3.1".to_string() } else { "v20.0.0".to_string() }), vec![]);
        assert!(newer.ok && newer.claude.problem.is_some());
        // 오래된 node는 막는다
        assert!(!check_environment_with(&|p| Some(if p == "claude" { "2.1.1".to_string() } else { "v14.0.0".to_string() }), vec![]).ok);
    }

    #[test]
    fn missing_resource_files_mean_an_incomplete_install_and_block() {
        let dir = std::env::temp_dir().join(format!("ctm_env_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let present = dir.join("a.js");
        std::fs::write(&present, "x").unwrap();
        let ok = assess_resource("a.js", &present, true);
        assert!(ok.exists && ok.problem.is_none() && ok.packaged);
        let dev = assess_resource("a.js", &present, false);
        assert!(dev.problem.is_none(), "개발용 폴백이라도 파일이 있으면 문제없다");
        let missing = assess_resource("dist/teamMemberServer.js", &dir.join("nope.js"), false);
        assert!(!missing.exists && missing.problem.as_deref().unwrap().contains("설치가 불완전") && missing.problem.as_deref().unwrap().contains("*-setup.exe"));
        let tools_ok = |p: &str| Some(if p == "claude" { "2.1.318".to_string() } else { "v22.1.0".to_string() });
        assert!(check_environment_with(&tools_ok, vec![ok]).ok);
        assert!(!check_environment_with(&tools_ok, vec![missing]).ok, "리소스가 없으면 전체가 ok가 아니다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_run_version_finds_node_and_reports_missing_programs() {
        // 이 시험을 도는 환경에는 node가 있다(JS 시험과 스크립트 시험도 node를 쓴다)
        let out = run_version("node").expect("node가 PATH에 있어야 한다");
        assert!(parse_version(&out).is_some(), "{out}");
        assert!(run_version("ctm-definitely-not-a-program-xyz").is_none());
    }
}
