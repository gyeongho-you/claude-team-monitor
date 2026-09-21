// 별도 트랙(TAURI_NOTICE_QUEUE_DESIGN.md §2, "attach 터미널 경합 방지") — open-in-terminal/
// open-terminal-for-approval IPC와, 그게 채워야 하는 attachTerminalPids(H-2)의 포팅.
// 포팅 대상: isAttachTerminalOpenFor/trackAttachTerminal/attachTerminalPids/
// envWithoutClaudeCodeSessionMarkers/openTerminalRunning(main.ts:2865-2988).
//
// 가드 자체(isAttachTerminalOpenFor 동치)는 이 청크 이전에 이미 board_state.rs::
// is_attach_terminal_open_for로 구현돼 있고, resume.rs(DeliveryPorts를 통한 send-to-lead류)와
// notice_queue.rs(send_to_lead_command, deliver_dequeue_step)가 이미 그걸 호출한다 —
// board_state.rs 42-45행 주석이 명시하듯, 그동안 attach_terminal_pids 맵을 실제로 채우는 쪽이
// 없어서 그 가드는 지금까지 "항상 attach 없음"(false)으로만 판정됐다. 이 파일이 그 맵을 실제로
// 채우는 마지막 조각이다 — 이 파일이 머지되는 순간부터 board_state.rs/notice_queue.rs를 다시
// 건드리지 않아도 H-2 가드가 자동으로 실제 동작한다(설계 문서의 "구현은 병렬이어도 인터페이스
// 합의는 먼저" 요구사항 그대로).

use crate::claude_readiness::{check_directory_claude_ready, Readiness};
use crate::paths::is_safe_id;
use crate::session_registry::{load_leads, LeadRecord};
use crate::timing::TRACK_ATTACH_TERMINAL_DELAY_MS;
use std::collections::HashSet;
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

// ---------------------------------------------------------------------------------------------
// openTerminalRunning(main.ts:2865-2887) — Windows(cmd.exe)/macOS(Terminal.app, osascript)를
// 각각의 방식으로 지원한다. env는 Windows에서만 의미가 있다(main.ts 주석과 동일한 이유 — macOS의
// Terminal.app은 osascript의 자식이 아니라 Apple Event로 메시지만 받는 완전히 별개의 이미 떠있는
// 앱이라 osascript의 env를 물려받지 않는다).
//
// 이 앱은 Windows 전용이 아니다 — tauri.conf.json의 bundle.targets가 "all"이고, package.json에
// electron 시절 macOS dmg 빌드 타깃(build.mac.target)이 그대로 남아있다(git history 확인). 그래서
// main.ts의 darwin 분기를 그대로 옮긴다. attach PID 추적(트랙 뒤 track_attach_terminal)은 Windows
// 전용으로 남는다 — macOS는 osascript가 이미 떠있는 Terminal.app에 Apple Event로 명령만 보내는
// 방식이라 새로 생기는 자식 프로세스가 없어서 PID로 추적할 방법이 구조적으로 없다(main.ts 주석과
// 동일한 한계, 아래 track_attach_terminal 주석 참고).
// ---------------------------------------------------------------------------------------------

/// openTerminalRunning(main.ts)과 동일. cwd/win_env는 open-terminal-for-approval(Windows 전용
/// 의미)에서만 쓰인다.
pub fn open_terminal_running(command: &str, cwd: Option<&str>, win_env: Option<Vec<(String, String)>>) {
    if cfg!(target_os = "windows") {
        open_terminal_running_windows(command, cwd, win_env);
    } else if cfg!(target_os = "macos") {
        open_terminal_running_macos(command, cwd);
    } else {
        eprintln!(
            "[open_terminal_running] 이 OS({})에서는 터미널 자동 열기를 지원하지 않습니다.",
            std::env::consts::OS
        );
    }
}

#[cfg(windows)]
fn open_terminal_running_windows(command: &str, cwd: Option<&str>, win_env: Option<Vec<(String, String)>>) {
    // I-1/I-2 정신 그대로 — 명령을 문자열로 join하지 않고 배열의 각 원소로 넘긴다. `start`의 다음
    // 인자가 인용부호 없는 `cmd.exe`라 창 제목으로 오인될 위험이 없다(main.ts와 동일한 인자 순서).
    let mut cmd = Command::new("cmd.exe");
    cmd.args(["/c", "start", "cmd.exe", "/k", command]);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(envs) = win_env {
        // env_without_claude_code_session_markers()가 이미 "CLAUDE_CODE_ 접두사만 뺀 전체 env"를
        // 돌려주므로, 여기서 부모 env를 통째로 물려받은 뒤 그 마커만 지우면 다시 새는 걸 막기
        // 위해 clear 후 이 목록으로만 채운다(envWithoutClaudeCodeSessionMarkers를 spawn의 env에
        // 그대로 넘기는 main.ts와 동일한 최종 상태).
        cmd.env_clear();
        cmd.envs(envs);
    }
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    // detached:true + child.unref()(main.ts)와 동일한 효과 — spawn만 하고 Child를 기다리지 않고
    // 버린다. std::process::Child는 Drop에서 자식을 죽이지 않으므로 그대로 살아남는다.
    match cmd.spawn() {
        Ok(_child) => {}
        Err(e) => eprintln!("[open_terminal_running] 터미널을 여는 데 실패했습니다: {e}"),
    }
}
#[cfg(not(windows))]
fn open_terminal_running_windows(_command: &str, _cwd: Option<&str>, _win_env: Option<Vec<(String, String)>>) {}

#[cfg(target_os = "macos")]
fn open_terminal_running_macos(command: &str, cwd: Option<&str>) {
    let shell_command = match cwd {
        Some(dir) => format!("cd {} && {command}", shell_single_quote(dir)),
        None => command.to_string(),
    };
    let script = format!("tell application \"Terminal\" to do script \"{}\"", escape_apple_script_string(&shell_command));
    if let Err(e) = Command::new("osascript").args(["-e", &script]).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
        eprintln!("[open_terminal_running] 터미널을 여는 데 실패했습니다: {e}");
    }
}
#[cfg(not(target_os = "macos"))]
fn open_terminal_running_macos(_command: &str, _cwd: Option<&str>) {}

/// src/lib/terminalCommand.js의 shellSingleQuote와 동일 — macOS 셸 명령 안에 경로를 안전하게 넣는다.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// src/lib/terminalCommand.js의 escapeAppleScriptString과 동일 — 그 쉘 명령 전체를 AppleScript
/// 문자열 리터럴("...") 안에 넣는다. shell_single_quote와 순서를 지켜야 한다(파일 상단 원본 주석과
/// 동일한 주의사항 — 하나만 하면 특수문자 든 경로에서 조용히 깨지거나 의도 안 한 명령이 실행될 수
/// 있다).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn escape_apple_script_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

// ---------------------------------------------------------------------------------------------
// envWithoutClaudeCodeSessionMarkers(main.ts:2957-2974)
// ---------------------------------------------------------------------------------------------

pub(crate) fn filter_out_claude_code_markers(env: Vec<(String, String)>) -> Vec<(String, String)> {
    env.into_iter().filter(|(k, _)| !k.starts_with("CLAUDE_CODE_")).collect()
}

/// envWithoutClaudeCodeSessionMarkers(main.ts)와 동일 — CLAUDE_CODE_ 접두사가 붙은 환경변수를
/// 전부 지운, 그 외에는 부모 프로세스 env와 동일한 전체 목록을 돌려준다.
pub fn env_without_claude_code_session_markers() -> Vec<(String, String)> {
    filter_out_claude_code_markers(std::env::vars().collect())
}

// ---------------------------------------------------------------------------------------------
// attachTerminalPids/trackAttachTerminal(main.ts:2889-2945) — H-2. "터미널에서 직접 열기"로 띄운
// attach 창이 열려있는 동안 앱이 같은 세션에 stop→resume을 걸면 daemon이 복사본을 만드는 경합이
// 실제로 재현됐다(2026-09-18, daemon.log에 fleet/shell 태그가 몇 초 간격으로 번갈아 찍히며 6연속
// 포크). isAttachTerminalOpenFor(board_state.rs, 이미 포팅됨)가 이 맵을 읽는다 — 이 함수는 그
// 맵을 실제로 채우는 쪽이다.
// ---------------------------------------------------------------------------------------------

/// trackAttachTerminal의 WMI stdout 파싱부만 뽑은 순수 함수 — 실제 powershell 프로세스 없이
/// 단위 테스트로 검증하기 위함.
pub(crate) fn parse_pids_from_output(output: &str) -> Vec<i64> {
    output.split_whitespace().filter_map(|s| s.parse::<i64>().ok()).collect()
}

#[cfg(windows)]
fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
#[allow(dead_code)]
fn hide_console_window(_cmd: &mut Command) {}

// openTerminalRunning으로 claude attach 터미널을 띄운 직후, 그 창의 실제 PID를 WMI로 찾는다
// (main.ts 주석과 동일한 이유 — `cmd.exe /c start cmd.exe /k <command>`의 child.pid로는 실제 창의
// PID를 못 잡는다, `start`가 새 창을 띄우자마자 그 자신은 곧바로 종료돼버리기 때문). main.ts에는
// 없는 5초 타임아웃을 추가했다 — powershell이 응답 없이 멈추면(예: WMI 서비스 자체가 죽어있는
// 환경) 이 조회가 spawn_blocking 스레드 풀에서 영원히 자리를 차지하는 걸 막기 위함이다
// (checkClaudeBinaryOnce가 이미 같은 이유로 5초 타임아웃을 두고 있다, resume.rs 참고) — 이 조회
// 자체는 best-effort(못 찾아도 이 세션에 대해서만 경합 감지를 못 하는 것뿐이고 이 기능 추가 전과
// 같은 동작으로 남는다)이므로 타임아웃돼도 실패로만 처리하고 재시도하지 않는다.
#[cfg(windows)]
fn track_attach_terminal_blocking(session_short_id: &str) -> Vec<i64> {
    let needle = format!("claude attach {session_short_id}");
    let ps_command = format!(
        "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object {{ $_.CommandLine -like '*{needle}*' }} | Select-Object -ExpandProperty ProcessId"
    );
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &ps_command]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    hide_console_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[track_attach_terminal] powershell을 실행하지 못했습니다(best-effort라 무시): {e}");
            return Vec::new();
        }
    };
    let stdout_reader = child.stdout.take().map(|mut s| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
            buf
        })
    });

    match child.wait_timeout(Duration::from_millis(5000)) {
        Ok(Some(_status)) => {
            let out_bytes = stdout_reader.map(|r| r.join().unwrap_or_default()).unwrap_or_default();
            parse_pids_from_output(&String::from_utf8_lossy(&out_bytes))
        }
        Ok(None) => {
            eprintln!("[track_attach_terminal] powershell이 5초 안에 끝나지 않아 포기합니다(best-effort).");
            let _ = child.kill();
            let _ = child.wait();
            Vec::new()
        }
        Err(e) => {
            eprintln!("[track_attach_terminal] powershell 대기 실패: {e}");
            Vec::new()
        }
    }
}
#[cfg(not(windows))]
fn track_attach_terminal_blocking(_session_short_id: &str) -> Vec<i64> {
    Vec::new()
}

/// trackAttachTerminal(main.ts)과 동일 — `start`가 실제로 새 창을 띄우기까지 걸리는
/// TRACK_ATTACH_TERMINAL_DELAY_MS(800ms) 뒤에 WMI로 조회한다. Windows에서만 동작한다(파일 상단
/// 주석 참고 — macOS는 attach가 새 자식 프로세스를 만들지 않아 PID 추적이 구조적으로 불가능).
/// 호출부(open_in_terminal_command)를 기다리게 하지 않는다(fire-and-forget, main.ts의 setTimeout과
/// 동일한 논블로킹 성격).
pub fn track_attach_terminal(session_short_id: String) {
    if !cfg!(windows) {
        return;
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(TRACK_ATTACH_TERMINAL_DELAY_MS as u64)).await;
        let id_for_blocking = session_short_id.clone();
        let pids = tokio::task::spawn_blocking(move || track_attach_terminal_blocking(&id_for_blocking))
            .await
            .unwrap_or_else(|e| {
                eprintln!("[track_attach_terminal] powershell 조회 태스크가 panic했습니다(있어서는 안 되는 상황): {e}");
                Vec::new()
            });
        // 못 찾아도(예: powershell 자체가 없는 환경) 이 세션에 대해서만 경합 감지를 못 하는
        // 것뿐이고, 이 기능 추가 전과 같은 동작(attach_terminal_pids에 아무것도 안 남음 →
        // is_attach_terminal_open_for가 항상 false)으로 남으므로 best-effort로 둔다(main.ts와
        // 동일한 판단).
        if !pids.is_empty() {
            crate::board_state::state().lock().unwrap().attach_terminal_pids.insert(session_short_id, pids);
        }
    });
}

// ---------------------------------------------------------------------------------------------
// computeUnapprovedDirs(main.ts:1463-1475) — open-terminal-for-approval IPC가 렌더러가 넘긴
// targetDir을 "이 앱이 실제로 알고 있고 아직 승인이 안 된 디렉토리"인지 서버 쪽에서 재확인하는 데
// 쓴다(F-3과 같은 원칙 — 실제 spawn 대상이 될 수 있는 디렉토리(팀장의 targetDir + 사전승인된
// approvedMembers)만 검사하고, "지금 이 순간의 cwd"는 안 본다). 이 청크 범위는 아니지만(§2,
// F-2/F-3 참고) open-terminal-for-approval을 쓸모있게 포팅하려면 이 판정이 반드시 있어야 해서
// 함께 옮긴다 — claude_readiness.rs가 이미 포팅해둔 check_directory_claude_ready를 그대로 쓴다.
// ---------------------------------------------------------------------------------------------

/// compute_unapproved_dirs의 판정부 — readiness 조회를 주입 가능하게 해서(β/δ의 ResumePorts/
/// DeliveryPorts와 같은 정신) ~/.claude.json 실제 파일 없이 단위 테스트로 검증한다.
pub(crate) fn compute_unapproved_dirs_with<F>(leads: &[LeadRecord], mut is_ready: F) -> Vec<(String, String)>
where
    F: FnMut(&str) -> Readiness,
{
    let mut dirs: HashSet<String> = HashSet::new();
    for lead in leads {
        dirs.insert(lead.target_dir.clone());
        for dir in &lead.approved_members {
            dirs.insert(dir.clone());
        }
    }
    let mut result = Vec::new();
    for dir in dirs {
        let readiness = is_ready(&dir);
        if !readiness.ready {
            result.push((dir, readiness.reason.unwrap_or_default()));
        }
    }
    result
}

/// computeUnapprovedDirs(main.ts)와 동일.
pub fn compute_unapproved_dirs(leads: &[LeadRecord]) -> Vec<(String, String)> {
    compute_unapproved_dirs_with(leads, |dir| check_directory_claude_ready(dir))
}

// ---------------------------------------------------------------------------------------------
// open-in-terminal / open-terminal-for-approval IPC(main.ts:2947-2989)
// ---------------------------------------------------------------------------------------------

/// open-in-terminal(main.ts)과 동일 — claude attach는 인터랙티브 터미널이 필요해서 새 콘솔 창을
/// 띄워 그 안에서 attach를 실행하고, 그 창의 PID를 추적한다(H-2 경합 방지의 시작점).
#[tauri::command]
pub async fn open_in_terminal_command(session_short_id: String) {
    // main.ts의 SESSION_SHORT_ID_RE(main.ts:2857)와 동일한 규칙 — pathGuard.js의 isSafeId와도
    // 같은 정규식이라 paths.rs가 이미 포팅해둔 is_safe_id를 그대로 재사용한다(렌더러가 넘긴 값을
    // shell 명령 문자열에 심기 전에 형식을 방어적으로 검증).
    if !is_safe_id(&session_short_id) {
        eprintln!("[open_in_terminal] 유효하지 않은 세션 id라 거부합니다: {session_short_id}");
        return;
    }
    open_terminal_running(&format!("claude attach {session_short_id}"), None, None);
    track_attach_terminal(session_short_id);
}

/// open-terminal-for-approval(main.ts)과 동일 — 렌더러가 임의의 경로를 넘겨서 아무 데서나 터미널을
/// 열게 하면 안 되므로, 지금 이 앱이 실제로 알고 있고 아직 승인이 안 된 디렉토리인지 재확인한다.
#[tauri::command]
pub async fn open_terminal_for_approval_command(target_dir: String) {
    let is_known_unapproved = compute_unapproved_dirs(&load_leads()).into_iter().any(|(dir, _)| dir == target_dir);
    if !is_known_unapproved {
        eprintln!("[open_terminal_for_approval] 알 수 없거나 이미 승인된 디렉토리라 거부합니다: {target_dir}");
        return;
    }
    open_terminal_running("claude", Some(&target_dir), Some(env_without_claude_code_session_markers()));
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------------------------------------
    // parse_pids_from_output — WMI stdout 파싱.
    // ------------------------------------------------------------------------------------

    #[test]
    fn parse_pids_from_output_parses_whitespace_separated_numbers() {
        assert_eq!(parse_pids_from_output("1234\r\n5678\r\n"), vec![1234, 5678]);
    }

    #[test]
    fn parse_pids_from_output_returns_empty_for_no_matches() {
        assert_eq!(parse_pids_from_output(""), Vec::<i64>::new());
        assert_eq!(parse_pids_from_output("\r\n \r\n"), Vec::<i64>::new());
    }

    #[test]
    fn parse_pids_from_output_ignores_non_numeric_garbage() {
        // powershell 오류 메시지 등이 섞여 나와도(예: 권한 문제) 숫자만 뽑고 나머지는 무시한다 —
        // best-effort 성격(main.ts 주석과 동일).
        assert_eq!(parse_pids_from_output("1234\nWARNING: something\n5678"), vec![1234, 5678]);
    }

    // ------------------------------------------------------------------------------------
    // filter_out_claude_code_markers — envWithoutClaudeCodeSessionMarkers 판정부.
    // ------------------------------------------------------------------------------------

    #[test]
    fn filter_out_claude_code_markers_removes_only_claude_code_prefixed_keys() {
        let env = vec![
            ("CLAUDE_CODE_CHILD_SESSION".to_string(), "1".to_string()),
            ("CLAUDE_CODE_ENTRYPOINT".to_string(), "cli".to_string()),
            ("PATH".to_string(), "C:\\bin".to_string()),
            ("CLAUDE_HOME".to_string(), "C:\\home\\.claude".to_string()),
        ];
        let filtered = filter_out_claude_code_markers(env);
        let keys: Vec<&str> = filtered.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["PATH", "CLAUDE_HOME"], "CLAUDE_CODE_ 접두사만 지워야 하고, CLAUDE_HOME처럼 접두사가 다른 값은 남아야 한다");
    }

    #[test]
    fn filter_out_claude_code_markers_is_noop_when_nothing_matches() {
        let env = vec![("PATH".to_string(), "C:\\bin".to_string())];
        assert_eq!(filter_out_claude_code_markers(env.clone()), env);
    }

    // ------------------------------------------------------------------------------------
    // compute_unapproved_dirs_with — F-3 원칙(실제 spawn 대상 디렉토리만 검사).
    // ------------------------------------------------------------------------------------

    fn fake_lead(target_dir: &str, approved_members: Vec<&str>) -> LeadRecord {
        LeadRecord {
            id: "lead1".to_string(),
            session_id: "session1".to_string(),
            target_dir: target_dir.to_string(),
            launched_at: 1_000,
            approved_members: approved_members.into_iter().map(str::to_string).collect(),
            label: None,
            ai_title: None,
            internal_id: Some("internal-1".to_string()),
            auto_stall_nudge: None,
            secret: None,
            mcp_token: None,
        }
    }

    fn not_ready(reason: &str) -> Readiness {
        Readiness { ready: false, reason: Some(reason.to_string()) }
    }
    fn ready() -> Readiness {
        Readiness { ready: true, reason: None }
    }

    #[test]
    fn compute_unapproved_dirs_includes_target_dir_and_approved_members() {
        let leads = vec![fake_lead("C:\\lead-dir", vec!["C:\\member-dir"])];
        let result = compute_unapproved_dirs_with(&leads, |_dir| not_ready("승인 안 됨"));
        let dirs: HashSet<&str> = result.iter().map(|(d, _)| d.as_str()).collect();
        assert_eq!(dirs, HashSet::from(["C:\\lead-dir", "C:\\member-dir"]));
    }

    #[test]
    fn compute_unapproved_dirs_excludes_already_ready_dirs() {
        let leads = vec![fake_lead("C:\\ready-dir", vec!["C:\\not-ready-dir"])];
        let result = compute_unapproved_dirs_with(&leads, |dir| if dir == "C:\\ready-dir" { ready() } else { not_ready("미승인") });
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].0, "C:\\not-ready-dir");
    }

    #[test]
    fn compute_unapproved_dirs_deduplicates_when_target_dir_equals_an_approved_member() {
        // Set(main.ts) 동치 — 같은 디렉토리가 targetDir과 approvedMembers 양쪽에 있어도 한 번만
        // 검사/보고돼야 한다(중복 보고는 렌더러에서 같은 알림이 두 번 뜨는 사고로 이어질 수 있다).
        let leads = vec![fake_lead("C:\\same-dir", vec!["C:\\same-dir"])];
        let mut call_count = 0;
        let result = compute_unapproved_dirs_with(&leads, |_dir| {
            call_count += 1;
            not_ready("미승인")
        });
        assert_eq!(result.len(), 1);
        assert_eq!(call_count, 1, "같은 디렉토리를 두 번 조회하면 안 된다");
    }

    #[test]
    fn compute_unapproved_dirs_returns_empty_when_no_leads() {
        let result = compute_unapproved_dirs_with(&[], |_dir| not_ready("호출되면 안 됨"));
        assert!(result.is_empty());
    }

    // ------------------------------------------------------------------------------------
    // shell_single_quote/escape_apple_script_string — macOS 전용이라도 로직 자체는 플랫폼 무관하게
    // 검증 가능하다(main.ts의 lib/terminalCommand.js 테스트와 같은 대상).
    // ------------------------------------------------------------------------------------

    #[test]
    fn shell_single_quote_escapes_embedded_single_quotes() {
        assert_eq!(shell_single_quote("it's a path"), "'it'\\''s a path'");
    }

    #[test]
    fn escape_apple_script_string_escapes_backslashes_and_quotes() {
        assert_eq!(escape_apple_script_string(r#"say "hi" \ done"#), r#"say \"hi\" \\ done"#);
    }

    // ------------------------------------------------------------------------------------
    // 실제 콘솔 창을 띄우는 통합 검증 — 자동 테스트 스위트에는 포함하지 않는다(cargo test 중에
    // 매번 cmd.exe 창이 튀어오르면 CI/개발자 머신 모두에 방해가 되고, 이 저장소 자체가 실제
    // 팀장/팀원 세션으로 운영되고 있어 예기치 않은 부작용을 최소화해야 한다는 resume.rs/
    // notice_queue.rs의 판단과 동일하다). #[ignore]로 남겨서 `cargo test -- --ignored
    // open_in_terminal_command_opens_a_real_window_and_records_its_pid`로 수동 실행만 가능하게
    // 한다 — 이 테스트를 실행하면 실제 콘솔 창이 뜨므로 확인 후 반드시 직접 닫아야 한다.
    // ------------------------------------------------------------------------------------

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "실제 콘솔 창을 띄운다 — 수동으로만 실행하고 확인 후 직접 닫을 것"]
    async fn open_in_terminal_command_opens_a_real_window_and_records_its_pid() {
        let probe_id = format!("manualtest{}", crate::timing::now_ms());
        open_in_terminal_command(probe_id.clone()).await;
        tokio::time::sleep(Duration::from_millis(TRACK_ATTACH_TERMINAL_DELAY_MS as u64 + 1500)).await;
        let recorded = crate::board_state::state().lock().unwrap().attach_terminal_pids.get(&probe_id).cloned();
        assert!(recorded.is_some(), "새 콘솔 창의 PID가 attach_terminal_pids에 기록돼야 한다");
        println!(
            "[manual test] 세션 id {probe_id}로 콘솔 창을 띄우고 PID {recorded:?}를 기록했습니다 — 이 창은 실제 claude 세션이 없어 'attach' 자체는 에러로 끝나지만, 창은 열려 있으니 확인 후 직접 닫으세요."
        );
    }
}
