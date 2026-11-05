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
    match lead {
        Some(l) => {
            let label = l.label.clone().unwrap_or_default();
            cmd.env("CTM_LEAD_ID", &l.id).env("CTM_LEAD_LABEL", label).env("CTM_LEAD_DIR", &l.target_dir).env("CTM_SESSION_ID", &l.session_id).env(
                "CTM_SESSION_FILE",
                crate::transcript::session_file_path(&l.target_dir, &l.session_id).to_string_lossy().to_string(),
            );
        }
        None => {
            for k in ["CTM_LEAD_ID", "CTM_LEAD_LABEL", "CTM_LEAD_DIR", "CTM_SESSION_ID", "CTM_SESSION_FILE"] {
                cmd.env(k, "");
            }
        }
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
    if text.is_empty() {
        return "(스크립트가 아무것도 출력하지 않았습니다 — 마크다운을 표준 출력으로 내보내야 패널에 보입니다)".to_string();
    }
    if cut {
        format!("{text}\n\n…(출력이 길어서 {MAX_OUTPUT_CHARS}자까지만 보여 줍니다)")
    } else {
        text
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
        - 팀장 정보는 환경 변수로 받는다: CTM_LEAD_ID, CTM_LEAD_LABEL, CTM_LEAD_DIR(팀장의 작업 폴더, 현재 작업 디렉터리이기도 하다), CTM_SESSION_ID, CTM_SESSION_FILE. 팀장을 고르지 않았으면 모두 빈 문자열이니 그 경우 안내 문구를 출력하고 끝낸다.\n\
        - 읽기만 하는 명령을 쓴다. 파일 삭제·수정, git 커밋·푸시·체크아웃 같은 상태를 바꾸는 일은 하지 않는다.\n\
        - 몇 초 안에 끝나야 한다. 명령이 실패해도 예외로 죽지 말고 읽을 수 있는 문구를 출력한다.\n\
        - 설명 없이 코드 블록(```) 하나만 답한다.\n\n\
        요구: {request}"
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
