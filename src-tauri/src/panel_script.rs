// 오른쪽 패널의 "스크립트" 슬롯 실행기 — 사용자가 쓰거나(또는 AI가 써 준) 작은 스크립트를 이 PC에서 돌리고, 표준 출력(마크다운)을 패널에 보여 준다.
//
// 안전에 대한 판단: 이 앱은 서버와 연결돼 있지 않고 스크립트는 사용자 본인의 PC 권한으로 본인이 저장한 것만 돌기 때문에 샌드박스는 두지 않았다
// (잘못되거나 나쁜 스크립트의 피해는 그 사용자에게만 간다). 대신 앱이 같이 멈추지 않게 (1) 슬롯마다 정한 제한 시간(ms), (2) 출력 길이 제한을 둔다.
// 알려진 한계: 제한 시간이 지나면 스크립트 프로세스만 종료한다 — 스크립트가 띄운 자식 프로세스(git 등)는 그대로 끝날 때까지 남을 수 있다.
//
// 스크립트는 슬롯 id로 정한 파일(~/.claude/claude-team-monitor/panel/scripts/<id>.<확장자>)에 써서 실행한다(명령줄 인용·길이 문제를 피한다).
// 팀장 정보는 환경 변수로 넘긴다: CTM_LEAD_ID, CTM_LEAD_LABEL, CTM_LEAD_DIR, CTM_SESSION_ID, CTM_SESSION_FILE (선택한 팀장이 없으면 비어 있다).

use crate::session_registry::LeadRecord;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

pub(crate) const INTERPRETERS: [&str; 3] = ["node", "python", "shell"];
pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub(crate) const MIN_TIMEOUT_MS: u64 = 500;
pub(crate) const MAX_TIMEOUT_MS: u64 = 600_000;
pub(crate) const MAX_SCRIPT_CHARS: usize = 20_000;
const MAX_OUTPUT_CHARS: usize = 16_000;

// ---------------------------------------------------------------------------------------------
// 스크립트에 앱이 주는 정보 — 이 표가 유일한 기준이다: 실제로 넘기는 환경 변수(script_env), 설정 화면의 안내, AI에게 주는 요청문이 모두 여기서 나온다.
// 새 정보를 주려면 여기에 한 줄을 더하고 script_env에서 값을 채우면 안내와 AI 요청문에 자동으로 반영된다(둘이 어긋나면 시험이 실패한다).
// ---------------------------------------------------------------------------------------------

pub(crate) struct EnvVarDoc {
    pub name: &'static str,
    /// 무엇인지(값의 모양 포함)
    pub what: &'static str,
    /// 비어 있는 경우
    pub when_empty: &'static str,
}

pub(crate) const ENV_VAR_DOCS: [EnvVarDoc; 9] = [
    EnvVarDoc { name: "CTM_LEAD_ID", what: "선택한 팀장의 앱 내부 id (예: `ed09bf70`)", when_empty: "팀장을 고르지 않았을 때" },
    EnvVarDoc { name: "CTM_LEAD_LABEL", what: "사용자가 팀장에게 붙인 이름 (예: `g1cl-front-leader`)", when_empty: "팀장을 고르지 않았거나 이름을 안 붙였을 때" },
    EnvVarDoc { name: "CTM_LEAD_TITLE", what: "claude가 세션에 자동으로 붙인 주제 (예: `team lead launch setup`)", when_empty: "팀장을 고르지 않았거나 아직 주제가 없을 때" },
    EnvVarDoc { name: "CTM_LEAD_DIR", what: "선택한 팀장의 작업 폴더 절대 경로. 스크립트의 현재 작업 디렉터리(cwd)이기도 하다", when_empty: "팀장을 고르지 않았을 때(이때 cwd는 임시 폴더)" },
    EnvVarDoc { name: "CTM_SESSION_ID", what: "선택한 팀장의 claude 세션 id (UUID)", when_empty: "팀장을 고르지 않았을 때" },
    EnvVarDoc { name: "CTM_SESSION_FILE", what: "선택한 팀장의 대화 기록 파일 경로(JSONL: 한 줄이 JSON 하나. 사용자·답변·도구 호출·도구 결과가 시간순으로 들어 있고 각 줄에 `timestamp`가 있다). 팀장이 한 일을 직접 분석할 때 읽는다", when_empty: "팀장을 고르지 않았을 때(파일이 아직 없으면 경로만 있고 파일은 없을 수 있다)" },
    EnvVarDoc { name: "CTM_LEADS_FILE", what: "이 앱에 등록된 **모든** 팀장 목록 파일 경로(JSON 배열). 항목: `id`, `label`(선택), `aiTitle`(선택), `targetDir`, `sessionId`, `launchedAt`(시작 시각, epoch ms), `internalId`, `approvedMembers`(허용한 팀원 폴더 배열). 종료된(히스토리) 팀장도 들어 있다. 읽기 전용으로만 쓸 것(고치면 앱이 망가진다)", when_empty: "항상 채워진다(팀장 선택과 무관)" },
    EnvVarDoc { name: "CTM_CLAUDE_HOME", what: "claude 홈 폴더 절대 경로(보통 사용자 홈의 `.claude`). 아래에 `projects/`(대화 기록), `jobs/`(백그라운드 세션 상태) 등이 있다", when_empty: "항상 채워진다" },
    EnvVarDoc { name: "CTM_APP_VERSION", what: "이 앱의 버전 문자열 (예: `0.1.1`)", when_empty: "항상 채워진다" },
];

/// 스크립트에 넘길 환경 변수 전부(팀장이 없으면 팀장 관련 값은 빈 문자열). 이름은 ENV_VAR_DOCS와 같아야 한다.
pub(crate) fn script_env(lead: Option<&LeadRecord>) -> Vec<(&'static str, String)> {
    let (id, label, title, dir, session_id, session_file) = match lead {
        Some(l) => (
            l.id.clone(),
            l.label.clone().unwrap_or_default(),
            l.ai_title.clone().unwrap_or_default(),
            l.target_dir.clone(),
            l.session_id.clone(),
            crate::transcript::session_file_path(&l.target_dir, &l.session_id).to_string_lossy().to_string(),
        ),
        None => Default::default(),
    };
    vec![
        ("CTM_LEAD_ID", id),
        ("CTM_LEAD_LABEL", label),
        ("CTM_LEAD_TITLE", title),
        ("CTM_LEAD_DIR", dir),
        ("CTM_SESSION_ID", session_id),
        ("CTM_SESSION_FILE", session_file),
        ("CTM_LEADS_FILE", crate::paths::leads_path().to_string_lossy().to_string()),
        ("CTM_CLAUDE_HOME", crate::paths::claude_home().to_string_lossy().to_string()),
        ("CTM_APP_VERSION", env!("CARGO_PKG_VERSION").to_string()),
    ]
}

/// 스크립트 작성 안내(마크다운) — 설정 화면에 그대로 보여 주고, AI에게도 그대로 준다. 사실이 바뀌면 여기만 고친다.
pub(crate) fn reference_markdown() -> String {
    let table: String = ENV_VAR_DOCS.iter().map(|d| format!("| `{}` | {} | {} |\n", d.name, d.what, d.when_empty)).collect();
    format!(
        "## 스크립트가 받는 정보 (환경 변수)\n\n\
        앱이 스크립트를 실행할 때 아래 환경 변수를 넣어 준다. 이 표에 없는 것은 앱이 주지 않는다.\n\n\
        | 이름 | 내용 | 비어 있을 때 |\n|---|---|---|\n{table}\n\
        ## 실행 방식\n\n\
        - 스크립트는 **실행할 때마다 새 프로세스**로 돈다(이전 실행의 변수·상태가 남지 않는다). 패널을 보는 동안 몇 초마다, 새로고침 버튼을 누를 때, 팀장을 바꿀 때 실행된다.\n\
        - 실행 환경: Node.js(`node`), Python(`python`; macOS·Linux는 `python3`), 셸(Windows는 PowerShell, 그 외는 `sh`). 외부 패키지 설치는 전제하지 않는다 — 내장 모듈만 쓴다.\n\
        - 표준 입력은 비어 있다(대화형 입력 불가). 이 앱을 띄운 사용자 계정의 환경변수·PATH를 그대로 물려받으므로 `git`, `gh` 같은 명령도 그 사용자 PC에 설치돼 있으면 쓸 수 있다.\n\
        - 종료 코드가 0이 아니면 실패로 보고, 표준 오류의 앞부분이 패널에 오류로 표시된다. 정상일 때 표준 오류는 표시되지 않는다.\n\
        - 슬롯마다 정한 제한 시간(ms)을 넘으면 중단된다(기본 10000ms). 출력은 16000자까지만 보인다.\n\n\
        ## 출력 형식\n\n\
        - **표준 출력에 낸 마크다운**이 그대로 패널에 표시된다.\n\
        - 지원: 제목(`#`은 한 단계 낮춰 보임), **굵게**, *기울임*, `인라인 코드`, 코드 블록, 목록(`-`, `1.`), 표, 인용(`>`), 구분선(`---`), 링크 `[글](https://주소)`와 맨 주소(**http/https만** 링크가 되며 누르면 기본 브라우저로 열린다).\n\
        - 지원하지 않음: HTML, 이미지, 색·글꼴 지정, 버튼·입력 같은 상호작용, 자동 새로고침 간격 지정.\n\n\
        ## 앱이 주지 않는 것\n\n\
        - 팀장의 실시간 상태(작업 중/대기), 팀원 목록, 토큰·비용 사용량, 다른 패널 슬롯의 내용은 환경 변수로 주지 않는다. 필요하면 `CTM_SESSION_FILE`(대화 기록)이나 `CTM_LEADS_FILE`을 직접 읽어서 계산하거나, 이 PC의 명령(`git`, `gh` 등)을 실행해서 알아낸다.\n\
        - 앱이나 팀장 세션을 조작하는 기능(메시지 보내기, 종료 등)은 없다. 스크립트는 **보여 주기 전용**이다.\n\n\
        ## 쓸 때 권장\n\n\
        - 읽기만 하는 명령을 쓴다(상태를 바꾸는 `git commit`·`checkout`, 파일 삭제·수정은 하지 않는다).\n\
        - 팀장을 고르지 않아 `CTM_LEAD_DIR`이 비어 있는 경우를 먼저 처리해 안내 문구를 출력하고 끝낸다.\n\
        - 외부 명령은 실패할 수 있으니 예외로 죽지 말고 읽을 수 있는 문구를 출력한다.\n"
    )
}

/// (실행 파일, 파일 확장자, 앞에 붙일 인자들 — 파일 경로는 그 뒤에 붙는다)
pub(crate) fn interpreter_spec(interpreter: &str) -> Option<(&'static str, &'static str, Vec<&'static str>)> {
    match interpreter {
        "node" => Some(("node", "js", vec![])),
        #[cfg(windows)]
        "python" => Some(("python", "py", vec![])),
        #[cfg(not(windows))]
        "python" => Some(("python3", "py", vec![])),
        #[cfg(windows)]
        "shell" => Some(("powershell", "ps1", vec!["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])),
        #[cfg(not(windows))]
        "shell" => Some(("sh", "sh", vec![])),
        _ => None,
    }
}

/// 스크립트 파일 내용(셸이 윈도우 PowerShell이면 한글이 깨지지 않게 출력 인코딩을 UTF-8로 맞추는 줄을 앞에 붙인다).
fn script_file_text(interpreter: &str, script: &str) -> String {
    if cfg!(windows) && interpreter == "shell" {
        format!("\u{feff}[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n{script}\r\n")
    } else {
        script.to_string()
    }
}

fn truncate_chars(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        (s.to_string(), false)
    } else {
        (s.chars().take(max).collect(), true)
    }
}

fn find_lead<'a>(leads: &'a [LeadRecord], id: &str) -> Option<&'a LeadRecord> {
    leads.iter().find(|l| l.id == id || l.internal_id.as_deref() == Some(id))
}

/// 스크립트를 한 번 실행해서 패널에 보일 마크다운을 돌려준다(실패·시간 초과도 읽을 수 있는 마크다운으로 돌려준다).
pub(crate) fn run_script(scripts_dir: &Path, file_stem: &str, interpreter: &str, script: &str, timeout_ms: u64, lead: Option<&LeadRecord>) -> String {
    run_script_with(scripts_dir, file_stem, interpreter, script, timeout_ms, lead, false)
}

/// show_stderr: 정상 종료(종료 코드 0)여도 표준 오류 출력을 결과 끝에 붙인다 — 설정 화면의 시험 실행용(패널에서는 오류가 아니면 숨긴다).
pub(crate) fn run_script_with(scripts_dir: &Path, file_stem: &str, interpreter: &str, script: &str, timeout_ms: u64, lead: Option<&LeadRecord>, show_stderr: bool) -> String {
    let Some((program, ext, pre_args)) = interpreter_spec(interpreter) else { return "**알 수 없는 실행 환경입니다.**".to_string() };
    if let Err(e) = std::fs::create_dir_all(scripts_dir) {
        return format!("**스크립트 폴더를 만들지 못했습니다:** {e}");
    }
    let file: PathBuf = scripts_dir.join(format!("{file_stem}.{ext}"));
    if let Err(e) = std::fs::write(&file, script_file_text(interpreter, script)) {
        return format!("**스크립트 파일을 쓰지 못했습니다:** {e}");
    }
    let mut cmd = Command::new(program);
    cmd.args(&pre_args).arg(&file);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    let work_dir = lead.map(|l| PathBuf::from(&l.target_dir)).filter(|p| p.is_dir()).unwrap_or_else(std::env::temp_dir);
    cmd.current_dir(&work_dir);
    for (name, value) in script_env(lead) {
        cmd.env(name, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return format!("**{program}을(를) 실행하지 못했습니다:** {e}\n\n이 PC에 {program}이(가) 설치돼 있고 PATH에 있어야 합니다."),
    };
    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else { return "**출력을 열지 못했습니다.**".to_string() };
    let out_reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stdout.read_to_end(&mut b);
        b
    });
    let err_reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b);
        b
    });
    let status = match child.wait_timeout(Duration::from_millis(timeout_ms)) {
        Ok(Some(s)) => s,
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return format!("**제한 시간({timeout_ms}ms)을 넘어 중단했습니다.**\n\n이 슬롯의 설정에서 제한 시간(ms)을 늘릴 수 있습니다.");
        }
    };
    let out = String::from_utf8_lossy(&out_reader.join().unwrap_or_default()).to_string();
    let err = String::from_utf8_lossy(&err_reader.join().unwrap_or_default()).to_string();
    if !status.success() {
        let (e, _) = truncate_chars(err.trim(), 1500);
        let shown = if e.is_empty() { "(오류 출력 없음)".to_string() } else { e };
        return format!("**스크립트가 실패했습니다**(종료 코드 {})\n\n```\n{}\n```{}", status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".to_string()), shown, if out.trim().is_empty() { String::new() } else { format!("\n\n{}", out.trim()) });
    }
    let (text, cut) = truncate_chars(out.trim(), MAX_OUTPUT_CHARS);
    let stderr_note = if show_stderr && !err.trim().is_empty() {
        let (e, _) = truncate_chars(err.trim(), 1500);
        format!("\n\n---\n[표준 오류 출력 — 시험 실행에서만 보입니다]\n{e}")
    } else {
        String::new()
    };
    if text.is_empty() {
        return format!("(스크립트가 아무것도 출력하지 않았습니다 — 마크다운을 표준 출력으로 내보내야 패널에 보입니다){stderr_note}");
    }
    if cut {
        format!("{text}\n\n…(출력이 길어서 {MAX_OUTPUT_CHARS}자까지만 보여 줍니다){stderr_note}")
    } else {
        format!("{text}{stderr_note}")
    }
}

/// 선택한 팀장 id(앱이 쓰는 id 또는 내부 id)로 팀장을 찾는다.
pub(crate) fn lead_by_id(leads: &[LeadRecord], id: Option<&str>) -> Option<LeadRecord> {
    id.filter(|s| !s.is_empty()).and_then(|id| find_lead(leads, id)).cloned()
}

/// AI에게 스크립트를 쓰게 할 때 줄 요청문.
pub(crate) fn build_generate_prompt(request: &str, interpreter: &str) -> String {
    let lang = match interpreter {
        "node" => "Node.js(CommonJS, 외부 패키지 없이 내장 모듈만)",
        "python" => "Python 3(표준 라이브러리만)",
        _ => {
            if cfg!(windows) {
                "Windows PowerShell"
            } else {
                "POSIX sh"
            }
        }
    };
    format!(
        "너는 데스크톱 앱의 '오른쪽 패널' 슬롯에서 주기적으로 실행될 작은 스크립트를 쓴다. 아래 요구를 만족하는 {lang} 스크립트 하나만 써라.\n\
        규칙:\n\
        - 결과는 마크다운으로 표준 출력에 낸다(제목은 ## 부터, 목록·표·굵게·`코드`·[글](https://주소) 링크 사용 가능. HTML·이미지는 표시되지 않는다).\n\
        - 아래 '앱 안내'에 적힌 것만 앱이 주는 정보다. 거기 없는 환경 변수·기능을 지어내서 쓰지 마라.\n\
        - 설명 없이 코드 블록(```) 하나만 답한다.\n\n\
        ===== 앱 안내 =====\n{reference}\n===== 앱 안내 끝 =====\n\n\
        요구: {request}",
        reference = reference_markdown()
    )
}

/// 시험 실행에서 나온 문제(오류·이상한 출력)를 보고 스크립트를 고치게 할 때 줄 요청문.
pub(crate) fn build_fix_prompt(script: &str, problem: &str, note: &str, interpreter: &str) -> String {
    let base = build_generate_prompt("(아래 스크립트를 고치는 일이다 — 새로 쓰지 말고 문제만 고쳐라)", interpreter);
    let note_line = if note.trim().is_empty() { String::new() } else { format!("\n사용자가 덧붙인 말: {}\n", note.trim()) };
    format!(
        "{base}\n\n===== 지금 스크립트 =====\n{script}\n===== 지금 스크립트 끝 =====\n\n===== 시험 실행에서 나온 결과(오류 포함) =====\n{problem}\n===== 결과 끝 =====\n{note_line}\n위 결과에서 보이는 문제의 원인을 찾아 고친 **전체 스크립트**를 코드 블록 하나로만 답해라. 원래 하려던 일은 바꾸지 마라."
    )
}

/// 모델 답에서 코드 블록 안쪽만 꺼낸다(블록이 없으면 답 전체).
pub(crate) fn extract_code_block(text: &str) -> String {
    let t = text.trim();
    if let Some(start) = t.find("```") {
        let after = &t[start + 3..];
        let body_start = after.find('\n').map(|i| i + 1).unwrap_or(0);
        let body = &after[body_start..];
        let end = body.find("```").unwrap_or(body.len());
        return body[..end].trim_end().to_string();
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("ctm_script_{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn documented_variables_are_exactly_the_ones_passed_and_ai_prompt_carries_the_reference() {
        let passed: Vec<&str> = script_env(None).iter().map(|(n, _)| *n).collect();
        let documented: Vec<&str> = ENV_VAR_DOCS.iter().map(|d| d.name).collect();
        assert_eq!(passed, documented, "안내 표와 실제로 넘기는 환경 변수가 어긋났다");
        let reference = reference_markdown();
        assert!(documented.iter().all(|n| reference.contains(n)), "안내 문서에 모든 변수가 있어야 한다");
        let prompt = build_generate_prompt("브랜치 보여줘", "node");
        assert!(prompt.contains(&reference) && prompt.contains("브랜치 보여줘"), "AI 요청문에 안내 문서와 요구가 모두 들어가야 한다");
    }

    #[test]
    fn script_really_receives_every_documented_variable() {
        let dir = scratch();
        let names: Vec<String> = ENV_VAR_DOCS.iter().map(|d| format!("'{}'", d.name)).collect();
        let script = format!("const n=[{}]; console.log(n.map(k=>k+'='+(process.env[k]===undefined?'UNDEFINED':(process.env[k]===''?'EMPTY':'SET'))).join('\\n'))", names.join(","));
        let out = run_script(&dir, "t6", "node", &script, 8000, None);
        for d in ENV_VAR_DOCS.iter() {
            assert!(!out.contains(&format!("{}=UNDEFINED", d.name)), "{} 가 스크립트에 전달되지 않았다:\n{out}", d.name);
        }
        // 팀장이 없어도 항상 채워진다고 안내한 것들은 실제로 채워져 있어야 한다
        for always in ["CTM_LEADS_FILE", "CTM_CLAUDE_HOME", "CTM_APP_VERSION"] {
            assert!(out.contains(&format!("{always}=SET")), "{always}는 항상 채워져야 한다:\n{out}");
        }
        assert!(out.contains("CTM_LEAD_DIR=EMPTY"), "{out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stderr_is_hidden_on_success_in_the_panel_but_shown_in_test_runs() {
        let dir = scratch();
        let js = "console.log('## 제목'); console.error('경고: 일부 실패'); process.exitCode = 0;";
        let panel = run_script(&dir, "t7", "node", js, 8000, None);
        assert!(panel.contains("## 제목") && !panel.contains("경고: 일부 실패"), "{panel}");
        let test = run_script_with(&dir, "t7", "node", js, 8000, None, true);
        assert!(test.contains("## 제목") && test.contains("표준 오류 출력") && test.contains("경고: 일부 실패"), "{test}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_prompt_carries_script_error_note_and_reference() {
        let p = build_fix_prompt("const a = 1; a = 2;", "TypeError: Assignment to constant variable.", "표로 보여줘", "node");
        assert!(p.contains("const a = 1; a = 2;") && p.contains("Assignment to constant variable") && p.contains("표로 보여줘") && p.contains(&reference_markdown()));
    }

    #[test]
    fn code_block_is_extracted_with_or_without_fences() {
        assert_eq!(extract_code_block("설명\n```js\nconsole.log(1)\n```\n끝"), "console.log(1)");
        assert_eq!(extract_code_block("```\na\nb\n```"), "a\nb");
        assert_eq!(extract_code_block("console.log(2)"), "console.log(2)");
    }

    #[test]
    fn output_is_returned_and_lead_env_is_passed() {
        let dir = scratch();
        let out = run_script(&dir, "t1", "node", "console.log('## 안녕\\n' + (process.env.CTM_LEAD_ID === '' ? '비어있음' : 'x'))", 8000, None);
        assert!(out.contains("## 안녕") && out.contains("비어있음"), "{out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failures_and_empty_output_are_readable_markdown() {
        let dir = scratch();
        let fail = run_script(&dir, "t2", "node", "console.error('boom'); process.exit(3)", 8000, None);
        assert!(fail.contains("실패") && fail.contains("종료 코드 3") && fail.contains("boom"), "{fail}");
        let empty = run_script(&dir, "t3", "node", "", 8000, None);
        assert!(empty.contains("아무것도 출력하지 않았습니다"), "{empty}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn slow_scripts_are_stopped_at_the_per_script_time_limit() {
        let dir = scratch();
        let t = std::time::Instant::now();
        let out = run_script(&dir, "t4", "node", "setTimeout(() => console.log('late'), 5000)", 700, None);
        assert!(out.contains("제한 시간(700ms)"), "{out}");
        assert!(t.elapsed() < Duration::from_secs(4), "제한 시간이 지나면 바로 끝나야 한다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_output_is_cut() {
        let dir = scratch();
        let out = run_script(&dir, "t5", "node", "console.log('가'.repeat(20000))", 8000, None);
        assert!(out.contains("까지만 보여 줍니다") && out.chars().count() < 16_200, "len {}", out.chars().count());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
