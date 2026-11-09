// 실행 환경 사전 점검 — 이 앱이 일하려면 사용자 PC에 `claude` CLI가 있어야 하고, 그 CLI가 앱이 쓰는 기능을 갖고 있어야 한다.
// 없거나 너무 오래된 채로 쓰다가 "왜 안 되지?" 하고 막히는 일이 없도록, 앱이 시작할 때 한 번 확인해서 화면 위쪽에 알기 쉽게 안내한다(env-banner).
//
// Node.js는 더 이상 필수가 아니다 — 팀원 생성 MCP 서버를 앱 실행 파일 자신이 맡게 됐다(mcp_server.rs). Node는 스크립트 슬롯에서 "Node.js" 실행 환경을
// 고른 경우에만 필요하므로, 그런 슬롯이 있는데 node가 없거나 오래됐을 때만 참고 안내를 띄운다.
//
// 판단은 순수 함수(parse_version, assess_*)로 분리해 어떤 OS에서든 시험하고, 실제 프로그램 실행만 얇게 감쌌다.
// claude CLI는 공개 호환성 보장이 없어서(이 앱은 `--bg`, `agents --json` 같은 관찰된 동작에 의존한다) 두 가지로 확인한다:
//  - 버전: "검증한 버전"을 기록해 두고, 그보다 새 minor 버전이면 막지는 않고 "검증하지 않은 버전"이라고만 알린다.
//  - 기능: `claude --help`와 `claude agents --help`에 앱이 쓰는 플래그·하위 명령이 아직 있는지 직접 확인한다(버전 번호가 같아도 기능이 바뀌었을 수 있다).

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

/// 앱이 반드시 쓰는 claude 기능 — 하나라도 `--help`에서 사라졌으면 팀장·팀원 시작/재개/종료가 깨진다.
/// (표시 이름, `claude --help`에서 찾을 글자)
pub(crate) const CLAUDE_REQUIRED_MAIN: [(&str, &str); 6] = [
    ("--bg(백그라운드 세션 시작)", "--bg"),
    ("--resume(세션 이어가기)", "--resume"),
    ("--mcp-config(팀원 생성 도구 연결)", "--mcp-config"),
    ("--allowedTools(도구 허용)", "--allowedTools"),
    ("agents(세션 목록)", "agents"),
    ("attach/stop(세션 열기·종료)", "attach"),
];
/// `claude agents --help`에서 찾을 글자(앱은 `agents --json`으로 세션 목록을 읽는다).
pub(crate) const CLAUDE_REQUIRED_AGENTS: [(&str, &str); 1] = [("agents --json(세션 목록 읽기)", "--json")];
/// 없어도 앱은 돌지만 일부 기능이 빠지는 것.
pub(crate) const CLAUDE_OPTIONAL_MAIN: [(&str, &str); 3] = [
    ("--name(팀원 주소 지정)", "--name"),
    ("--setting-sources(시크릿 모드)", "--setting-sources"),
    ("--model(모델 선택)", "--model"),
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub found: bool,
    pub version: Option<String>,
    /// 사용자에게 보여 줄 문제 설명(없으면 None)
    pub problem: Option<String>,
    /// true면 앱이 제대로 일하지 못하는 문제(없음/너무 오래됨/필수 기능 없음), false면 참고용 안내(검증하지 않은 버전 등)
    pub blocking: bool,
}

/// 앱이 실행 중에 읽는 파일(팀장 스킬)이 있는지.
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
    /// claude CLI가 앱이 쓰는 기능(플래그·하위 명령)을 갖고 있는지
    pub claude_features: ToolStatus,
    /// Node.js — 스크립트 슬롯이 쓸 때만 의미가 있어 항상 막지 않는다(blocking=false)
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
        Some(format!("앱 설치가 불완전합니다: {name} 파일을 찾지 못했습니다({}). 팀장 스킬 설치가 되지 않습니다. 설치 파일(*-setup.exe)로 설치하거나, 압축 파일을 쓴다면 exe 옆에 resources/ 폴더를 함께 두세요.", path.display()))
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

/// 도움말에 그 글자가 "옵션이나 하위 명령으로" 있는지 — 설명 문장 속 우연한 언급이 아니라 줄 맨 앞(들여쓰기 뒤)에서 시작하는 항목만 센다.
fn help_lists(help: &str, needle: &str) -> bool {
    help.lines().any(|line| {
        let t = line.trim_start();
        // "--bg, --background  …", "-p, --print  …", "agents [options]  …", "stop|kill <id>  …"처럼 항목 줄은 옵션/명령 이름으로 시작한다
        let head = t.split("  ").next().unwrap_or(t);
        head.split([',', '|', ' ']).any(|w| w.trim() == needle)
    })
}

/// `claude --help`/`claude agents --help` 출력으로 앱이 쓰는 기능이 아직 있는지 판정한다. help가 비어 있으면(실행 실패) 판단할 근거가 없으므로 문제로 삼지 않는다.
pub(crate) fn assess_claude_features(main_help: &str, agents_help: &str) -> ToolStatus {
    if main_help.trim().is_empty() {
        return ToolStatus { found: true, version: None, problem: None, blocking: false };
    }
    let mut missing: Vec<&str> = CLAUDE_REQUIRED_MAIN.iter().filter(|(_, n)| !help_lists(main_help, n)).map(|(l, _)| *l).collect();
    // agents --help를 못 읽었으면 그 항목은 판단하지 않는다
    if !agents_help.trim().is_empty() {
        missing.extend(CLAUDE_REQUIRED_AGENTS.iter().filter(|(_, n)| !help_lists(agents_help, n)).map(|(l, _)| *l));
    }
    if !missing.is_empty() {
        return ToolStatus {
            found: true,
            version: None,
            problem: Some(format!("이 claude CLI에서 앱이 쓰는 기능을 찾지 못했습니다: {}. claude CLI가 바뀐 것 같습니다 — 팀장·팀원 시작이나 재개가 동작하지 않을 수 있습니다. 앱을 업데이트하거나 검증된 claude {}.{}.x를 쓰세요.", missing.join(", "), CLAUDE_TESTED.0, CLAUDE_TESTED.1)),
            blocking: true,
        };
    }
    let optional: Vec<&str> = CLAUDE_OPTIONAL_MAIN.iter().filter(|(_, n)| !help_lists(main_help, n)).map(|(l, _)| *l).collect();
    if !optional.is_empty() {
        return ToolStatus { found: true, version: None, problem: Some(format!("이 claude CLI에는 {}가 없어 해당 기능이 빠집니다(나머지는 정상입니다).", optional.join(", "))), blocking: false };
    }
    ToolStatus { found: true, version: None, problem: None, blocking: false }
}

/// Node.js는 스크립트 슬롯이 쓸 때만 필요하다. `slots_using_node`는 Node 실행 환경을 고른 스크립트 슬롯 이름들 — 비어 있으면 node가 없어도 문제가 아니다.
/// 어떤 경우에도 막는 문제(blocking)로 보지 않는다(앱 자체는 Node 없이 돈다).
pub(crate) fn assess_node(version: Option<&str>, found: bool, slots_using_node: &[String]) -> ToolStatus {
    let needed = !slots_using_node.is_empty();
    let list = slots_using_node.join(", ");
    if !found {
        return ToolStatus {
            found: false,
            version: None,
            problem: needed.then(|| format!("Node.js를 찾지 못했습니다. 스크립트 슬롯({list})이 Node.js로 실행되도록 설정돼 있어 그 슬롯이 동작하지 않습니다 — https://nodejs.org 에서 설치하거나 슬롯의 실행 환경을 바꾸세요.")),
            blocking: false,
        };
    }
    let Some(v) = version else {
        return ToolStatus { found: true, version: None, problem: None, blocking: false };
    };
    match version_tuple(v) {
        Some((major, _, _)) if major < NODE_MIN_MAJOR && needed => ToolStatus {
            found: true,
            version: Some(v.into()),
            problem: Some(format!("Node.js {v}는 오래됐습니다. 스크립트 슬롯({list})은 {NODE_MIN_MAJOR} 이상을 권장합니다.")),
            blocking: false,
        },
        _ => ToolStatus { found: true, version: Some(v.into()), problem: None, blocking: false },
    }
}

fn not_found(name: &str, how: &str) -> ToolStatus {
    ToolStatus { found: false, version: None, problem: Some(format!("{name}를 찾지 못했습니다. {how}")), blocking: true }
}

/// `<program> <args…>`를 5초 안에 실행해 표준 출력을 돌려준다. 실행 자체가 안 되면 None(= 없음).
fn run_program(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
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

pub(crate) fn check_environment_with(run: &dyn Fn(&str, &[&str]) -> Option<String>, resources: Vec<ResourceStatus>, slots_using_node: &[String]) -> EnvCheck {
    let claude = match run("claude", &["--version"]) {
        None => not_found("claude CLI", "https://docs.claude.com/claude-code 에서 설치하고 로그인한 뒤 앱을 다시 시작하세요."),
        Some(out) => assess_claude(parse_version(&out).as_deref()),
    };
    // 기능 점검은 claude를 찾았을 때만 한다(없으면 위에서 이미 막는 문제로 알렸다)
    let claude_features = if claude.found {
        let main_help = run("claude", &["--help"]).unwrap_or_default();
        let agents_help = run("claude", &["agents", "--help"]).unwrap_or_default();
        assess_claude_features(&main_help, &agents_help)
    } else {
        ToolStatus { found: false, version: None, problem: None, blocking: false }
    };
    let node = match run("node", &["--version"]) {
        None => assess_node(None, false, slots_using_node),
        Some(out) => assess_node(parse_version(&out).as_deref(), true, slots_using_node),
    };
    let ok = !claude.blocking && !claude_features.blocking && resources.iter().all(|r| r.exists);
    EnvCheck { claude, claude_features, node, resources, ok }
}

fn current_resources() -> Vec<ResourceStatus> {
    let skill = crate::paths::skill_src_path();
    let packaged = crate::paths::is_next_to_exe(&skill);
    vec![assess_resource("resources/skills/team-lead/SKILL.md", &skill, packaged)]
}

/// 지금 이 PC의 실제 환경을 점검한다(블로킹 — 프로그램을 몇 번 실행한다). 진단 정보(diagnostics.rs)도 같은 결과를 쓴다.
pub(crate) fn current_env_check() -> EnvCheck {
    let slots = crate::side_panel::script_slot_names_using_node();
    check_environment_with(&run_program, current_resources(), &slots)
}

#[tauri::command]
pub async fn check_environment_command() -> Result<EnvCheck, String> {
    tokio::task::spawn_blocking(current_env_check).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 이 앱이 실제로 쓰는 claude(2.1.x) --help의 관련 줄만 옮긴 것
    const MAIN_HELP: &str = "Usage: claude [options] [command] [prompt]\n\nOptions:\n  --allowedTools, --allowed-tools <tools...>   Comma-separated list of tool names\n  --bg, --background                    Start the session in the background and\n                                        return immediately.\n  --mcp-config <configs...>             Load MCP servers from JSON files\n  --model <model>                       Model for the current session.\n  --name <name>                         Set a display name\n  -p, --print                           Print response and exit\n  --resume [value]                      Resume a conversation\n  --setting-sources <sources>           Comma-separated list of setting sources\n\nCommands:\n  agents [options]                      Manage background agents\n  attach <id|name>                      Open a background session in this\n  stop|kill <id>                        Stop a background session.\n";
    const AGENTS_HELP: &str = "Usage: claude agents [options]\n\nManage background agents\n\nOptions:\n  --all                                 With --json: also include completed\n  --json                                Print sessions as JSON\n";

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

    /// 실제로 설치된 claude CLI가 앱이 쓰는 기능을 갖고 있는지 확인하는 "계약 시험" — 로그인 없이 `--version`/`--help`만 부르므로 CI에서도 돈다.
    /// claude가 필요해서 평소에는 건너뛰고(#[ignore]), 주간 호환성 점검 워크플로(.github/workflows/cli-compat.yml)가 최신 CLI를 설치해 돌린다.
    /// 로컬에서는 `cargo test --lib real_claude_cli -- --ignored`.
    #[test]
    #[ignore = "실제 claude CLI가 필요하다 — cli-compat 워크플로가 돌린다"]
    fn real_claude_cli_exposes_the_features_the_app_uses() {
        let version_out = run_program("claude", &["--version"]).expect("claude가 PATH에 있어야 한다");
        let version = parse_version(&version_out).unwrap_or_else(|| panic!("버전을 읽지 못했다: {version_out:?}"));
        let main_help = run_program("claude", &["--help"]).expect("claude --help 실행");
        let agents_help = run_program("claude", &["agents", "--help"]).expect("claude agents --help 실행");
        let features = assess_claude_features(&main_help, &agents_help);
        assert!(!features.blocking, "claude {version}에서 앱이 쓰는 기능이 사라졌다: {:?}", features.problem);
        let status = assess_claude(Some(&version));
        assert!(!status.blocking, "claude {version}: {:?}", status.problem);
        println!("claude {version} — 기능 점검 통과, 참고: {:?}", features.problem.or(status.problem));
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
    fn the_real_claude_help_passes_the_feature_check() {
        let s = assess_claude_features(MAIN_HELP, AGENTS_HELP);
        assert!(s.problem.is_none() && !s.blocking, "{:?}", s.problem);
    }

    #[test]
    fn a_missing_required_flag_or_subcommand_blocks_and_names_what_is_gone() {
        let no_bg = MAIN_HELP.replace("--bg, --background", "--foo, --bar");
        let s = assess_claude_features(&no_bg, AGENTS_HELP);
        assert!(s.blocking && s.problem.as_deref().unwrap().contains("--bg"), "{:?}", s.problem);
        let no_attach = MAIN_HELP.replace("attach <id|name>", "open <id|name>");
        assert!(assess_claude_features(&no_attach, AGENTS_HELP).problem.as_deref().unwrap().contains("attach"));
        let no_json = AGENTS_HELP.replace("--json ", "--yaml ");
        assert!(assess_claude_features(MAIN_HELP, &no_json).problem.as_deref().unwrap().contains("agents --json"));
    }

    #[test]
    fn a_mention_inside_a_description_sentence_does_not_count_as_the_feature() {
        // "--bg"가 다른 옵션의 설명 문장 속에만 나오고 자기 항목은 없는 경우
        let help = MAIN_HELP.replace("  --bg, --background                    Start the session in the background and\n", "  --other                               Similar to --bg but different\n");
        let s = assess_claude_features(&help, AGENTS_HELP);
        assert!(s.blocking, "설명 속 언급은 기능이 아니다");
    }

    #[test]
    fn a_missing_optional_flag_only_informs_and_unreadable_help_is_not_a_problem() {
        let no_name = MAIN_HELP.replace("--name <name>", "--nom <name>");
        let s = assess_claude_features(&no_name, AGENTS_HELP);
        assert!(!s.blocking && s.problem.as_deref().unwrap().contains("--name"));
        let empty = assess_claude_features("", "");
        assert!(empty.problem.is_none() && !empty.blocking, "도움말을 못 읽으면 판단하지 않는다");
        let no_agents_help = assess_claude_features(MAIN_HELP, "");
        assert!(no_agents_help.problem.is_none(), "agents --help를 못 읽으면 그 항목은 판단하지 않는다");
    }

    #[test]
    fn node_is_only_a_note_and_only_when_a_script_slot_needs_it() {
        let none: Vec<String> = vec![];
        let some = vec!["깃 그래프".to_string()];
        assert!(assess_node(None, false, &none).problem.is_none(), "필요한 슬롯이 없으면 node가 없어도 조용하다");
        let missing = assess_node(None, false, &some);
        assert!(!missing.blocking && missing.problem.as_deref().unwrap().contains("깃 그래프"), "필요한 슬롯이 있으면 어느 슬롯인지 알려 준다");
        assert!(assess_node(Some("22.14.0"), true, &some).problem.is_none());
        let old = assess_node(Some("16.20.2"), true, &some);
        assert!(!old.blocking && old.problem.is_some(), "오래된 node도 막지는 않고 알리기만 한다");
        assert!(assess_node(Some("16.20.2"), true, &none).problem.is_none());
        assert!(!assess_node(None, true, &some).blocking);
    }

    #[test]
    fn missing_claude_blocks_and_everything_else_does_not_need_node() {
        let none = check_environment_with(&|_, _| None, vec![], &[]);
        assert!(!none.ok && !none.claude.found);
        assert!(none.claude.problem.as_deref().unwrap().contains("docs.claude.com"));
        assert!(none.node.problem.is_none() && !none.node.blocking, "claude만 없는 환경에서 node 안내는 없다");
        let good = check_environment_with(
            &|p, a| Some(match (p, a.first().copied()) { ("claude", Some("--version")) => "2.1.318 (Claude Code)".into(), ("claude", Some("--help")) => MAIN_HELP.into(), ("claude", _) => AGENTS_HELP.into(), _ => "v22.14.0".into() }),
            vec![],
            &[],
        );
        assert!(good.ok && good.claude.problem.is_none() && good.claude_features.problem.is_none());
        // node가 아예 없어도 앱은 정상
        let no_node = check_environment_with(
            &|p, a| if p == "node" { None } else { Some(match a.first().copied() { Some("--version") => "2.1.318".into(), Some("--help") => MAIN_HELP.into(), _ => AGENTS_HELP.into() }) },
            vec![],
            &[],
        );
        assert!(no_node.ok && no_node.node.problem.is_none());
    }

    #[test]
    fn a_changed_claude_cli_makes_the_check_not_ok_even_when_the_version_looks_fine() {
        let changed = check_environment_with(
            &|p, a| if p == "node" { Some("v22.0.0".into()) } else { Some(match a.first().copied() { Some("--version") => "2.1.318".into(), Some("--help") => "Usage: claude\n  -p, --print   Print\n".into(), _ => "Usage: claude agents\n".into() }) },
            vec![],
            &[],
        );
        assert!(!changed.ok && changed.claude_features.blocking, "버전은 검증 범위여도 기능이 사라졌으면 알린다");
        assert!(changed.claude.problem.is_none());
    }

    #[test]
    fn missing_resource_files_mean_an_incomplete_install_and_block() {
        let dir = std::env::temp_dir().join(format!("ctm_env_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let present = dir.join("a.md");
        std::fs::write(&present, "x").unwrap();
        let ok = assess_resource("a.md", &present, true);
        assert!(ok.exists && ok.problem.is_none() && ok.packaged);
        let dev = assess_resource("a.md", &present, false);
        assert!(dev.problem.is_none(), "개발용 폴백이라도 파일이 있으면 문제없다");
        let missing = assess_resource("resources/skills/team-lead/SKILL.md", &dir.join("nope.md"), false);
        assert!(!missing.exists && missing.problem.as_deref().unwrap().contains("설치가 불완전") && missing.problem.as_deref().unwrap().contains("*-setup.exe"));
        let tools_ok = |p: &str, a: &[&str]| Some(match (p, a.first().copied()) { ("claude", Some("--version")) => "2.1.318".to_string(), ("claude", Some("--help")) => MAIN_HELP.to_string(), ("claude", _) => AGENTS_HELP.to_string(), _ => "v22.1.0".to_string() });
        assert!(check_environment_with(&tools_ok, vec![ok], &[]).ok);
        assert!(!check_environment_with(&tools_ok, vec![missing], &[]).ok, "리소스가 없으면 전체가 ok가 아니다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_run_program_finds_node_and_reports_missing_programs() {
        // 이 시험을 도는 환경에는 node가 있다(JS 시험과 스크립트 시험도 node를 쓴다)
        let out = run_program("node", &["--version"]).expect("node가 PATH에 있어야 한다");
        assert!(parse_version(&out).is_some(), "{out}");
        assert!(run_program("ctm-definitely-not-a-program-xyz", &["--version"]).is_none());
    }
}
