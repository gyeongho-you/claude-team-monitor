// 서브청크 β(TAURI_NOTICE_QUEUE_DESIGN.md §2) — 실제 stop→resume spawn + 크래시 감지/재시도.
// 포팅 대상: stopSession/runClaudeBg/resumeOnce/resumeRetryFrom/scheduleBackgroundResumeHealing/
// resumeSpawnWithRetry/resumeLead/findSessionIdByShortId(Retrying)/checkClaudeBinaryOnce/
// issueMcpToken(main.ts). 포함 사고: A-1~A-3, B-1~B-2, E-1(패턴만), I-1~I-3.
//
// α 리뷰에서 나온 두 가지 추가 지침을 이 파일 전체에 반영한다:
// 1) blocking I/O(claude 프로세스 spawn/wait, 최대 RESUME_SPAWN_WORST_CASE_MS=184초)는 전부
//    tokio::task::spawn_blocking으로 감싼다 — 그대로 async 태스크 안에서 blocking하면 여러 팀장이
//    동시에 떠있을 때 tokio 워커 스레드 풀이 고갈돼 다른 팀장의 폴링/IPC까지 지연될 수 있다.
// 2) resume_lead(및 이 파일의 모든 async fn)는 내부에서 panic하지 않고 항상 Option/Result로
//    실패를 표현한다(.unwrap()/.expect()를 프로덕션 경로에 쓰지 않는다) — queue_lead_operation을
//    호출하는 지점(resume_lead_command)에서도 tokio::spawn + JoinError로 한 번 더 방어해서, 혹시
//    이 불변식이 깨지더라도(버그) 후속 로직이 조용히 사라지는 대신 app.log에 흔적을 남긴다.
//
// β 리뷰에서 나온 치명적 버그 수정: queue_lead_operation은 같은 internalId끼리만 직렬화하므로,
// 서로 다른 팀장을 향한 resume이 거의 동시에 leads.json의 "쓰기 직전 재조회"(E-1 패턴) 지점에
// 도달하면 한쪽의 저장이 다른 쪽에 덮어써지는 lost update가 실측 재현됐다(5회 중 4회,
// TAURI_NOTICE_QUEUE_DESIGN.md §3-1이 예견한 문제). resume_lead/background_resume_healing_job/
// issue_mcp_token 전부 leads.json 쓰기를 session_registry::with_leads_lock(전역
// tokio::sync::Mutex 하나로 load+mutate+save를 원자화)으로 옮겨서 고쳤다 — leads.json에 쓰는
// 지점을 새로 추가할 때는 반드시 이 헬퍼를 거쳐야 하고, load_leads()/save_leads()를 직접 짝지어
// 쓰면 안 된다.

use crate::agents_json::{fetch_agents_typed_async, fetch_agents_typed_strict};
use crate::board_state::{state, ResumeRetryStatus};
use crate::claude_bg_output::{extract_backgrounded_id, extract_started_copy_id};
use crate::claude_readiness::{check_directory_claude_ready, claude_not_ready_message};
use crate::concurrency::queue_lead_operation;
use crate::logging::log_critical;
use crate::long_prompt_guard::resolve_long_prompt;
use crate::session_registry::{load_leads, with_leads_lock, LeadRecord};
use crate::timing::{
    MAX_RESUME_ATTEMPTS, RESUME_RETRY_GAP_MS, RESUME_SETTLE_CHECK_MS, RUN_CLAUDE_TIMEOUT_MS, STOP_SESSION_TIMEOUT_MS,
};
use std::future::Future;
use std::io::Read;
use std::pin::Pin;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::OnceCell;
use wait_timeout::ChildExt;

#[cfg(windows)]
fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn hide_console_window(_cmd: &mut Command) {}

// ---------------------------------------------------------------------------------------------
// checkClaudeBinaryOnce(main.ts) — I-3: claude가 .exe가 아니면(.cmd/.bat) Windows에서는 spawn 시
// 내부적으로 셸을 거쳐 인자/셸 인젝션 위험이 생긴다. 앱이 CLI 설치 형태를 강제로 바꿀 수 없으므로
// 경고 로그만 남긴다 — 이건 "아직 해결 안 된 알려진 위험"이지 이번 청크가 새로 막는 취약점이 아니다.
// ---------------------------------------------------------------------------------------------

static CLAUDE_BINARY_CHECK: OnceCell<()> = OnceCell::const_new();

fn check_claude_binary_blocking() {
    let mut cmd = Command::new("where");
    cmd.arg("claude");
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    hide_console_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "[check_claude_binary_once] claude 실행 파일 경로를 확인하지 못했습니다(where claude 실행 실패, {e}) — .exe 여부 검증을 생략합니다."
            );
            return;
        }
    };
    let stdout_reader = child.stdout.take().map(|mut s| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
            buf
        })
    });
    let stderr_reader = child.stderr.take().map(|mut s| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
        })
    });

    // 타임아웃 없이 이 조회가 멈추면(예: PATH에 응답 없는 네트워크 드라이브가 섞여있는 경우), 이
    // 결과가 앱 수명 내내 캐시된 채로 절대 채워지지 않아 이후 팀장/팀원 스폰이 전부 영구히 막힌다
    // (팀원 버그헌팅에서 지적) — 5초 타임아웃을 준다(main.ts와 동일).
    match child.wait_timeout(Duration::from_millis(5000)) {
        Ok(Some(status)) => {
            let stdout_bytes = stdout_reader.map(|r| r.join().unwrap_or_default()).unwrap_or_default();
            if let Some(r) = stderr_reader {
                let _ = r.join();
            }
            if !status.success() {
                eprintln!(
                    "[check_claude_binary_once] claude 실행 파일 경로를 확인하지 못했습니다(where claude 종료 코드 {:?}) — .exe 여부 검증을 생략합니다.",
                    status.code()
                );
                return;
            }
            let stdout_text = String::from_utf8_lossy(&stdout_bytes);
            let Some(first_path) = stdout_text.lines().map(str::trim).find(|s| !s.is_empty()) else { return };
            if !first_path.to_lowercase().ends_with(".exe") {
                eprintln!(
                    "[check_claude_binary_once] 경고: claude 실행 파일이 .exe가 아닙니다({first_path}). \
Windows에서 .cmd/.bat 스크립트는 spawn 시 셸을 거쳐 실행되어 인자 이스케이프 방식이 달라질 수 있습니다 \
(인자/셸 인젝션 위험). claude CLI를 네이티브 실행 파일로 설치하는 것을 권장합니다."
                );
            }
        }
        Ok(None) => {
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("[check_claude_binary_once] where claude가 5초 안에 끝나지 않아 포기합니다(.exe 여부 검증 생략).");
        }
        Err(e) => {
            eprintln!("[check_claude_binary_once] where claude 대기 실패: {e}");
        }
    }
}

/// checkClaudeBinaryOnce(main.ts)와 동일 — 최초 1회만 검사해서 캐싱한다. blocking 조회이므로
/// spawn_blocking으로 감싼다(위 파일 상단 지침 1).
pub async fn check_claude_binary_once() {
    CLAUDE_BINARY_CHECK
        .get_or_init(|| async {
            let _ = tokio::task::spawn_blocking(check_claude_binary_blocking).await;
        })
        .await;
}

// ---------------------------------------------------------------------------------------------
// runClaudeBg(main.ts) — I-1(가변인자 플래그 뒤 `--` 명시)/I-2(shell:false는 Rust 기본값이라
// 공짜)를 반영한다. prompt는 반드시 flags와 분리된 별도 인자로 받아서, `--`를 배열의 한 원소로
// 명시적으로 끼워 넣고서야 argv에 싣는다 — 문자열 join은 절대 하지 않는다.
// ---------------------------------------------------------------------------------------------

fn best_effort_stop(id: &str) {
    let mut cmd = Command::new("claude");
    cmd.args(["stop", id]);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    hide_console_window(&mut cmd);
    // fire-and-forget — 실패해도(child.spawn 자체가 실패해도) 호출부는 어차피 실패로 반환한다.
    if let Err(e) = cmd.spawn() {
        eprintln!("[run_claude_bg] 복사본({id}) 정리 시도 자체가 실패했습니다(best-effort라 무시): {e}");
    }
}

fn run_claude_bg_blocking(flags: &[String], prompt: &str, cwd: &str) -> Option<String> {
    // I-1: `--`를 배열의 한 원소로 명시적으로 끼워 넣는다 — --allowedTools/--mcp-config 같은
    // 가변인자 플래그 바로 뒤에 구분자 없이 prompt를 붙이면 CLI가 prompt 전체를 "허용할 도구 이름
    // 하나 더"로 먹어버린다(실측 확인, 2026-09-18).
    let mut args: Vec<&str> = flags.iter().map(String::as_str).collect();
    args.push("--");
    args.push(prompt);

    let mut cmd = Command::new("claude");
    cmd.args(&args);
    cmd.current_dir(cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    hide_console_window(&mut cmd);
    // shell:false(Rust std::process::Command의 기본값)를 그대로 쓴다 — I-2 방어는 Rust에서
    // 공짜로 얻어진다(단, claude가 .cmd/.bat이면 OS 레벨에서 여전히 셸을 거친다 — I-3 참고).

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[run_claude_bg] claude 프로세스를 실행하지 못했습니다: {e}");
            return None;
        }
    };
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
    });

    match child.wait_timeout(Duration::from_millis(RUN_CLAUDE_TIMEOUT_MS as u64)) {
        Ok(Some(_status)) => {
            let out_bytes = stdout_reader.join().unwrap_or_default();
            let _ = stderr_reader.join();
            let out = String::from_utf8_lossy(&out_bytes).into_owned();

            // stop 후 곧바로 resume하면 daemon이 원본 정리를 아직 못 끝냈을 수 있고, 그러면
            // 원본을 잇는 대신 복사본을 만들어버린다(A-1/A-2) — 이 마커가 있으면 원치 않는
            // 복사본이므로 곧바로(best-effort로) 정리하고 실패로 반환한다.
            if let Some(copy_id) = extract_started_copy_id(&out) {
                log_critical(&format!(
                    "[run_claude_bg] daemon이 아직 원본을 정리하지 못해 복사본({copy_id})을 새로 만들었습니다 — 원치 않는 복사본이라 정리하고 실패로 처리합니다(재시도로 이어짐)."
                ));
                best_effort_stop(&copy_id);
                return None;
            }
            let id = extract_backgrounded_id(&out);
            if id.is_none() {
                eprintln!("[run_claude_bg] claude stdout에서 \"backgrounded\" 마커를 찾지 못했습니다. 원문: {out}");
            }
            id
        }
        Ok(None) => {
            eprintln!("[run_claude_bg] claude 프로세스가 응답 없이 대기 중이라 강제 종료합니다. args={args:?} cwd={cwd}");
            let _ = child.kill();
            let _ = child.wait();
            None
        }
        Err(e) => {
            eprintln!("[run_claude_bg] claude 대기 실패: {e}");
            None
        }
    }
}

/// runClaudeBg(main.ts)와 동일. blocking 프로세스 spawn/wait(최대 RUN_CLAUDE_TIMEOUT_MS=45초)을
/// spawn_blocking으로 감싼다(위 파일 상단 지침 1).
pub async fn run_claude_bg(flags: Vec<String>, prompt: String, cwd: String) -> Option<String> {
    check_claude_binary_once().await;
    tokio::task::spawn_blocking(move || run_claude_bg_blocking(&flags, &prompt, &cwd))
        .await
        .unwrap_or_else(|e| {
            eprintln!("[run_claude_bg] claude spawn 태스크가 panic했습니다(있어서는 안 되는 상황): {e}");
            None
        })
}

// ---------------------------------------------------------------------------------------------
// stopSession(main.ts) — exit code만으로는 부족해서(타임아웃으로 kill한 경우 등) claude agents
// --json으로 실제로 목록에서 사라졌는지까지 확인한다. 생존 확인 자체가 실패하면 fail-open(안
// 살아있다고 단정)하지 않고 fail-closed(정지 실패로 간주)한다.
// ---------------------------------------------------------------------------------------------

fn stop_session_blocking(id: &str) -> bool {
    let mut cmd = Command::new("claude");
    cmd.args(["stop", id]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    hide_console_window(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[stop_session] claude stop 프로세스를 실행하지 못했습니다: {e}");
            return false;
        }
    };
    // 내용은 안 쓰지만, 대기 중에 파이프 버퍼가 가득 차서 자식 프로세스가 멈추는 걸 막기 위해
    // 비워둬야 한다(agents_json.rs와 같은 이유).
    let stdout_reader = child.stdout.take().map(|mut s| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
        })
    });
    let stderr_reader = child.stderr.take().map(|mut s| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
        })
    });

    match child.wait_timeout(Duration::from_millis(STOP_SESSION_TIMEOUT_MS as u64)) {
        Ok(Some(status)) => {
            if let Some(r) = stdout_reader {
                let _ = r.join();
            }
            if let Some(r) = stderr_reader {
                let _ = r.join();
            }
            if !status.success() {
                eprintln!("[stop_session] claude stop {id} 이 실패했습니다(exit code {:?}).", status.code());
            }
            status.success()
        }
        Ok(None) => {
            eprintln!("[stop_session] claude stop {id} 이 응답 없이 대기 중이라 강제 종료합니다.");
            let _ = child.kill();
            let _ = child.wait();
            false
        }
        Err(e) => {
            eprintln!("[stop_session] claude 대기 실패: {e}");
            false
        }
    }
}

/// stopSession(main.ts)과 동일. blocking 프로세스 spawn/wait을 spawn_blocking으로 감싼다.
pub async fn stop_session(id: String) -> bool {
    let id_for_blocking = id.clone();
    let exited_cleanly = tokio::task::spawn_blocking(move || stop_session_blocking(&id_for_blocking))
        .await
        .unwrap_or_else(|e| {
            eprintln!("[stop_session] claude stop 태스크가 panic했습니다(있어서는 안 되는 상황): {e}");
            false
        });

    match fetch_agents_typed_strict().await {
        Ok(agents) => {
            let still_alive = agents.iter().any(|a| a.id.as_deref() == Some(id.as_str()));
            if still_alive {
                eprintln!("[stop_session] claude stop {id} 이후에도 agents 목록에 여전히 남아있습니다 — 정지 실패로 간주합니다.");
            }
            exited_cleanly && !still_alive
        }
        Err(e) => {
            eprintln!("[stop_session] claude stop {id} 이후 생존 여부 확인 자체가 실패했습니다 — 안전을 위해 정지 실패로 간주합니다: {e}");
            false
        }
    }
}

// ---------------------------------------------------------------------------------------------
// resumeOnce/resumeRetryFrom/scheduleBackgroundResumeHealing/resumeSpawnWithRetry(main.ts) —
// A-1~A-3의 크래시 감지+재시도 상태 기계. 실제 프로세스 spawn(run_claude_bg)과 생존 확인
// (fetch_agents_typed_strict 기반)을 ResumePorts로 추상화해서, TAURI_NOTICE_QUEUE_DESIGN.md
// §4가 요구하는 "정상/1차 실패 후 재시도 성공/전부 실패/포크 감지" 네 시나리오를 실제 claude
// 프로세스 없이 결정론적으로 재현할 수 있게 한다(§2-β "독립적 검증 가능성" 요구사항).
// ---------------------------------------------------------------------------------------------

type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

#[derive(Clone)]
struct ResumePorts {
    // run_claude_bg(flags, prompt, cwd) 상당 — "started a copy" 감지/정리까지 포함된 결과를
    // 그대로 흉내 낸다.
    run_claude_bg: Arc<dyn Fn(Vec<String>, String, String) -> BoxFuture<Option<String>> + Send + Sync>,
    // candidate 짧은 id가 지금 agents 목록에 살아있는지 — fetchAgentsStrict 상당(Err면 조회 자체 실패).
    agents_alive: Arc<dyn Fn(String) -> BoxFuture<Result<bool, String>> + Send + Sync>,
    // resumeOnce가 id 불일치(포크)를 감지했을 때의 best-effort 정리(`claude stop <copyId>`).
    cleanup_fork: Arc<dyn Fn(String) + Send + Sync>,
    // resumeSpawnWithRetry의 첫 시도 성공 시 백그라운드 치유를 예약하는 부분.
    schedule_healing: Arc<dyn Fn(String, LeadRecord, String, String) + Send + Sync>,
}

fn real_ports() -> ResumePorts {
    ResumePorts {
        run_claude_bg: Arc::new(|flags, prompt, cwd| Box::pin(run_claude_bg(flags, prompt, cwd))),
        agents_alive: Arc::new(|id| {
            Box::pin(async move {
                fetch_agents_typed_strict()
                    .await
                    .map(|agents| agents.iter().any(|a| a.id.as_deref() == Some(id.as_str())))
            })
        }),
        cleanup_fork: Arc::new(|id| best_effort_stop(&id)),
        schedule_healing: Arc::new(|internal_id, current, message, candidate_id| {
            schedule_background_resume_healing(internal_id, current, message, candidate_id);
        }),
    }
}

async fn resume_once_with_ports(
    ports: &ResumePorts,
    internal_id: &str,
    current: &LeadRecord,
    message: &str,
    attempt: i64,
) -> Option<String> {
    // A-1: --resume에 mcp-config/allowedTools를 절대 다시 싣지 않는다 — 최초 실행 때 이미 저장된
    // 옵션을 CLI가 그대로 물려받으므로 다시 넘길 필요가 없다(restartLead류의 완전히 새 세션
    // 경로와 정반대 요구사항이니 혼동하면 안 된다 — 그건 γ 범위).
    let flags = vec!["--bg".to_string(), "--resume".to_string(), current.session_id.clone()];
    let prompt = resolve_long_prompt(message);
    let candidate_id = (ports.run_claude_bg)(flags, prompt, current.target_dir.clone()).await?;
    if candidate_id != current.id {
        log_critical(&format!(
            "[resumeLead] 팀장 {internal_id}의 resume 시도 {attempt}/{MAX_RESUME_ATTEMPTS}가 다른 짧은 id로 떴습니다\
({}→{candidate_id}) — \"started a copy\" 문구를 놓쳤더라도 id 불일치로 복사본임을 감지해 정리합니다.",
            current.id
        ));
        (ports.cleanup_fork)(candidate_id);
        return None;
    }
    Some(candidate_id)
}

async fn resume_retry_from_with_ports(
    ports: &ResumePorts,
    internal_id: &str,
    current: &LeadRecord,
    message: &str,
    start_attempt: i64,
) -> Option<String> {
    let result = resume_retry_from_inner_with_ports(ports, internal_id, current, message, start_attempt).await;
    let mut guard = state().lock().unwrap();
    guard.resume_retry_status.remove(internal_id);
    result
}

async fn resume_retry_from_inner_with_ports(
    ports: &ResumePorts,
    internal_id: &str,
    current: &LeadRecord,
    message: &str,
    start_attempt: i64,
) -> Option<String> {
    for attempt in start_attempt..=MAX_RESUME_ATTEMPTS {
        {
            let mut guard = state().lock().unwrap();
            guard
                .resume_retry_status
                .insert(internal_id.to_string(), ResumeRetryStatus { attempt: attempt as i32, max: MAX_RESUME_ATTEMPTS as i32 });
        }
        tokio::time::sleep(Duration::from_millis(RESUME_RETRY_GAP_MS as u64)).await;
        match resume_once_with_ports(ports, internal_id, current, message, attempt).await {
            Some(candidate_id) => {
                tokio::time::sleep(Duration::from_millis(RESUME_SETTLE_CHECK_MS as u64)).await;
                // 확인 자체가 실패하면 fail-closed(성공으로 간주) — 불필요한 재시도를 피한다.
                let survived = (ports.agents_alive)(candidate_id.clone()).await.unwrap_or(true);
                if survived {
                    return Some(candidate_id);
                }
                log_critical(&format!(
                    "[resumeLead] 팀장 {internal_id}의 resume 시도 {attempt}/{MAX_RESUME_ATTEMPTS}가 크래시한 것으로 보입니다({candidate_id}, 원인 미확정)."
                ));
            }
            None => {
                log_critical(&format!(
                    "[resumeLead] 팀장 {internal_id}의 resume 시도 {attempt}/{MAX_RESUME_ATTEMPTS}가 실패했습니다(\"backgrounded\" 마커 없음/타임아웃 또는 복사본으로 감지되어 정리됨)."
                ));
            }
        }
    }
    None
}

async fn resume_spawn_with_retry_with_ports(
    ports: &ResumePorts,
    internal_id: &str,
    current: &LeadRecord,
    message: &str,
) -> Option<String> {
    match resume_once_with_ports(ports, internal_id, current, message, 1).await {
        Some(candidate_id) => {
            (ports.schedule_healing)(internal_id.to_string(), current.clone(), message.to_string(), candidate_id.clone());
            Some(candidate_id)
        }
        None => resume_retry_from_with_ports(ports, internal_id, current, message, 2).await,
    }
}

// resumeOnce(main.ts)는 원본에서도 resumeRetryFrom/resumeSpawnWithRetry 내부에서만 쓰이는 헬퍼라
// (다른 모듈이나 IPC가 직접 부르지 않음), 여기서도 별도의 pub 논-ports 래퍼를 두지 않는다 —
// resume_once_with_ports(위)가 실제 구현이고, 테스트도 이 ports 버전을 직접 부른다.

/// resumeRetryFrom(main.ts)과 동일.
pub async fn resume_retry_from(internal_id: &str, current: &LeadRecord, message: &str, start_attempt: i64) -> Option<String> {
    resume_retry_from_with_ports(&real_ports(), internal_id, current, message, start_attempt).await
}

/// resumeSpawnWithRetry(main.ts)와 동일 — 첫 시도는 기다리지 않고 바로 반환하고, 실패했을
/// 때만(동기적으로) 재시도한다는 비대칭 구조를 그대로 유지한다.
pub async fn resume_spawn_with_retry(internal_id: &str, current: &LeadRecord, message: &str) -> Option<String> {
    resume_spawn_with_retry_with_ports(&real_ports(), internal_id, current, message).await
}

/// scheduleBackgroundResumeHealing(main.ts)과 동일 — 첫 시도가 성공한 것처럼 보여도
/// RESUME_SETTLE_CHECK_MS 뒤 백그라운드로 한 번 더 생존을 확인한다. 응답은 이미 즉시 반환한
/// 뒤라 호출자를 기다리게 하지 않는다.
///
/// 이 함수가 queue_lead_operation을 호출하는 지점이다 — job(background_resume_healing_job)이
/// panic해도(있어서는 안 되지만) 이 태스크 자체가 조용히 죽어 사라지지 않도록, 실제 job을 한 번
/// 더 안쪽 tokio::spawn으로 감싸 JoinError를 관찰한다(파일 상단 지침 2 — queue_lead_operation
/// 호출부의 추가 방어선).
pub fn schedule_background_resume_healing(internal_id: String, current: LeadRecord, message: String, expected_id: String) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(RESUME_SETTLE_CHECK_MS as u64)).await;

        let queue_key = internal_id.clone();
        let job_internal_id = internal_id.clone();
        let job_handle = tokio::spawn(async move {
            queue_lead_operation(&queue_key, move || {
                background_resume_healing_job(job_internal_id, current, message, expected_id)
            })
            .await
        });
        if let Err(join_err) = job_handle.await {
            log_critical(&format!(
                "[resumeLead] 팀장 {internal_id} 백그라운드 복구 큐 처리 중 panic이 발생했습니다(있어서는 안 되는 상황, D-6과 같은 클래스의 유실 위험) — {join_err}"
            ));
        }
    });
}

async fn background_resume_healing_job(internal_id: String, current: LeadRecord, message: String, expected_id: String) {
    let leads = load_leads();
    let Some(rec) = leads.iter().find(|l| l.internal_id.as_deref() == Some(internal_id.as_str())) else { return };
    if rec.id != expected_id {
        return; // 이미 다른 작업으로 대체됨 — 간섭하지 않는다.
    }

    let survived = match fetch_agents_typed_strict().await {
        Ok(agents) => agents.iter().any(|a| a.id.as_deref() == Some(expected_id.as_str())),
        // 생존 확인 자체가 실패하면, 정말 죽었는지도 모르는 채로 또 stop/resume을 거는 게 더
        // 위험하다 — 다음 폴링이나 사용자 조작 때 다시 기회가 있으니 여기서는 그냥 넘어간다.
        Err(_) => return,
    };
    if survived {
        return;
    }
    log_critical(&format!(
        "[resumeLead] 팀장 {internal_id}({expected_id})가 백그라운드 확인(spawn 후 {RESUME_SETTLE_CHECK_MS}ms) 중 사라진 것을 발견했습니다 — 재시도로 복구를 시도합니다."
    ));
    let Some(healed_id) = resume_retry_from(&internal_id, &current, &message, 2).await else {
        log_critical(&format!(
            "[resumeLead] 팀장 {internal_id} 백그라운드 복구가 남은 재시도를 모두 실패했습니다 — 이 팀장이 실제로 오프라인 상태일 수 있어 수동 확인이 필요합니다."
        ));
        return;
    };

    let new_session_id = find_session_id_by_short_id_retrying(&healed_id).await;
    // 치명적 버그 수정(β 리뷰): 여기서 "재조회→판정"과 "저장"을 분리하면 그 사이(락 밖)에 다른
    // 팀장의 resume이 leads.json을 저장해 lost update가 재현된다(TAURI_NOTICE_QUEUE_DESIGN.md
    // §3-1) — still_current 판정 자체도 with_leads_lock 안에서 최신 상태로 다시 해야 한다(락 밖에서
    // 미리 판정해두면 그 판정과 실제 쓰기 사이에도 같은 lost update 창이 남는다).
    with_leads_lock(|latest_leads| {
        let still_current = latest_leads
            .iter()
            .any(|l| l.internal_id.as_deref() == Some(internal_id.as_str()) && l.id == expected_id);
        if !still_current {
            return (false, ());
        }
        let updated = apply_resume_session_update(
            latest_leads,
            &internal_id,
            &expected_id,
            &current.session_id,
            &healed_id,
            new_session_id.as_deref(),
        );
        (updated, ())
    })
    .await;
}

// ---------------------------------------------------------------------------------------------
// findSessionIdByShortId/findSessionIdByShortIdRetrying(main.ts) — B-2: 방금 spawn된 짧은 id가
// claude agents --json에 아직 안 잡히는 반영 지연을 봐주기 위해 재시도한다.
// ---------------------------------------------------------------------------------------------

/// findSessionIdByShortId(main.ts)와 동일 — fail-open(fetch_agents_typed_async)을 쓴다(main.ts도
/// fetchAgents를 씀, strict가 아님).
pub async fn find_session_id_by_short_id(short_id: &str) -> Option<String> {
    let agents = fetch_agents_typed_async().await;
    agents.into_iter().find(|a| a.id.as_deref() == Some(short_id)).map(|a| a.session_id)
}

/// findSessionIdByShortIdRetrying(main.ts)과 동일 — 800ms→1500ms, 총 3회(즉시 1회 포함).
pub async fn find_session_id_by_short_id_retrying(short_id: &str) -> Option<String> {
    if let Some(found) = find_session_id_by_short_id(short_id).await {
        return Some(found);
    }
    for delay in [800u64, 1500u64] {
        tokio::time::sleep(Duration::from_millis(delay)).await;
        if let Some(found) = find_session_id_by_short_id(short_id).await {
            return Some(found);
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------
// resumeLead(main.ts) — 호출부는 반드시 queue_lead_operation(internalId, ...)으로 감싸서
// 호출해야 한다(이 함수 자체는 그 전제 위에서만 안전하다). 큐에서 대기하는 동안 다른 작업이 이미
// 짧은 id/sessionId를 바꿔놨을 수 있으므로, 실행 시점에 internalId로 최신 레코드를 다시 찾는다.
// ---------------------------------------------------------------------------------------------

/// resumeLead(main.ts:2067-2093)의 leads.json 쓰기 판정부만 뽑은 순수 함수 — B-1 fail-closed
/// 가드(짧은 id는 그대로인데 sessionId만 달라 보이면 조회 결과를 신뢰하지 않고 기존 값 유지)를
/// 디스크 I/O 없이 단위 테스트로 검증하기 위함이다. internalId가 일치하는 레코드를 제자리에서
/// 갱신하고, 그런 레코드가 없으면 아무 것도 안 하고 false를 반환한다(호출부는 true일 때만 저장).
fn apply_resume_session_update(
    leads: &mut [LeadRecord],
    internal_id: &str,
    current_id: &str,
    current_session_id: &str,
    new_id: &str,
    new_session_id: Option<&str>,
) -> bool {
    let Some(rec) = leads.iter_mut().find(|l| l.internal_id.as_deref() == Some(internal_id)) else {
        return false;
    };
    rec.id = new_id.to_string();
    match new_session_id {
        // 짧은 id가 stop 이전과 동일한데 sessionId만 달라진 조합은 정상 resume이라면 있을 수
        // 없다(B-1) — 조회 자체를 못 믿는 게 낫다. 기존 값을 그대로 유지한다.
        Some(sid) if new_id == current_id && sid != current_session_id => {
            log_critical(&format!(
                "[resumeLead] 팀장 {internal_id}({new_id}) — 짧은 id는 그대로인데 sessionId만 달라진 걸로 조회됐습니다\
({current_session_id}→{sid}). 정상 resume이라면 있을 수 없는 조합이라 신뢰하지 않고 기존 sessionId를 유지합니다."
            ));
        }
        Some(sid) => {
            rec.session_id = sid.to_string();
        }
        None => {
            log_critical(&format!(
                "[resumeLead] 팀장 {internal_id}({new_id})의 새 sessionId를 확인하지 못했습니다 — leads.json이 낡은 sessionId({})를 계속 가리킬 수 있습니다.",
                rec.session_id
            ));
        }
    }
    true
}

/// resumeLead(main.ts)와 동일. 호출부(resume_lead_command)가 queue_lead_operation으로 감싸야
/// 한다 — 이 함수 스스로는 직렬화를 강제하지 않는다(main.ts 원본과 같은 책임 분리).
pub async fn resume_lead(internal_id: String, message: String) -> Option<String> {
    let leads = load_leads();
    let current = leads.into_iter().find(|l| l.internal_id.as_deref() == Some(internal_id.as_str()))?;

    let readiness = check_directory_claude_ready(&current.target_dir);
    if !readiness.ready {
        log_critical(&claude_not_ready_message(&current.target_dir, readiness.reason.as_deref().unwrap_or("")));
        return None;
    }

    // fail-closed: 확인이 안 되면 "혹시 몰라 살아있다고 가정"하고 stop을 한 번 거친다(그렇지
    // 않으면 실제로 살아있는 세션에 곧장 --resume을 걸어 복사본이 생기는 사고로 이어진다).
    let is_currently_live = match fetch_agents_typed_strict().await {
        Ok(agents) => agents.iter().any(|a| a.id.as_deref() == Some(current.id.as_str())),
        Err(_) => true,
    };

    if is_currently_live {
        let mut stopped = stop_session(current.id.clone()).await;
        if !stopped {
            stopped = stop_session(current.id.clone()).await;
        }
        if !stopped {
            log_critical(&format!(
                "[resumeLead] 팀장 {internal_id}({}) 정지에 실패해 세션 포크 위험이 있어 resume을 중단합니다.",
                current.id
            ));
            return None;
        }
        // A-2: 정확한 방지 효과는 불확실하지만 해될 게 없는 짧은 유예(main.ts 주석과 동일한
        // 판단) — 진짜 안전장치는 아래 resume_spawn_with_retry의 크래시 감지+재시도다.
        tokio::time::sleep(Duration::from_millis(3000)).await;
    }

    let new_id = resume_spawn_with_retry(&internal_id, &current, &message).await?;

    let new_session_id = find_session_id_by_short_id_retrying(&new_id).await;
    // 치명적 버그 수정(β 리뷰, TAURI_NOTICE_QUEUE_DESIGN.md §3-1): queue_lead_operation은 같은
    // internalId끼리만 직렬화하므로, 서로 다른 팀장을 향한 resume이 거의 동시에 이 지점에 도달하면
    // 둘 다 load_leads()로 최신 배열을 각자 읽어와 자기 레코드만 고친 뒤 저장한다 — 그 사이 다른
    // 쪽의 저장이 통째로 덮어써질 수 있다(실측 재현, 5회 중 4회). with_leads_lock으로 이
    // read-modify-write 전체를 원자적으로 만든다.
    with_leads_lock(|leads| {
        let updated = apply_resume_session_update(leads, &internal_id, &current.id, &current.session_id, &new_id, new_session_id.as_deref());
        (updated, ())
    })
    .await;
    Some(new_id)
}

/// send-to-lead 등 IPC 커맨드(서브청크 δ)가 resumeLead를 호출할 때 반드시 거쳐야 하는 진입점 —
/// queue_lead_operation(internalId, ...)으로 감싸는 것 자체가 A~E군 방어의 전제다(concurrency.rs
/// 참고). δ(send-to-lead 등 실제 알림 큐 IPC)는 아직 이관되지 않아 프런트엔드가 지금 이 커맨드를
/// 호출하는 곳은 없지만, queue_lead_operation의 첫 실제 호출부는 이 β가 추가한다(α가 남겨둔
/// #[allow(dead_code)]를 이 청크에서 뗀다).
#[tauri::command]
pub async fn resume_lead_command(internal_id: String, message: String) -> Option<String> {
    let queue_key = internal_id.clone();
    let job_internal_id = internal_id.clone();
    let handle = tokio::spawn(async move { queue_lead_operation(&queue_key, move || resume_lead(job_internal_id, message)).await });
    match handle.await {
        Ok(result) => result,
        Err(join_err) => {
            log_critical(&format!(
                "[resumeLead] 팀장 {internal_id} resume 큐 작업이 panic했습니다(있어서는 안 되는 상황 — 알림 재큐 등 후속 로직이 실행되지 못했을 수 있습니다) — {join_err}"
            ));
            None
        }
    }
}

// ---------------------------------------------------------------------------------------------
// issueMcpToken(main.ts) — 스폰 전에 이미 internalId를 아는 경로(restartLead)에서 기존 레코드에
// 새 토큰을 즉시 발급해 저장한다. resumeLead는 이 함수를 쓰지 않는다 — --resume에 mcp-config를
// 다시 싣지 않으므로(A-1) 새 토큰을 만들어도 전달할 방법이 없고, 마지막으로 실제 --mcp-config를
// 실어 떴을 때(launchTeamLead/restartLead) 발급된 값이 세션 자신의 저장된 옵션으로 계속 유효하다
// (resume_lead 위 주석 참고). 서브청크 γ(lead_lifecycle.rs)의 restart_lead가 이 함수의 첫 실제
// 호출부다 — α의 queue_lead_operation이 β를 기다렸던 것과 같은 패턴이라 β 시점엔 dead_code였다.
// ---------------------------------------------------------------------------------------------

fn apply_mcp_token(leads: &mut [LeadRecord], internal_id: &str, token: &str) -> bool {
    let Some(rec) = leads.iter_mut().find(|l| l.internal_id.as_deref() == Some(internal_id)) else {
        return false;
    };
    rec.mcp_token = Some(token.to_string());
    true
}

/// issueMcpToken(main.ts)과 동일 — 치명적 버그 수정(β 리뷰)으로 leads.json 쓰기를
/// with_leads_lock 안에서 하게 되면서 async fn이 됐다.
pub async fn issue_mcp_token(internal_id: &str) -> String {
    let token = uuid::Uuid::new_v4().to_string();
    with_leads_lock(|leads| (apply_mcp_token(leads, internal_id, &token), ())).await;
    token
}

// ---------------------------------------------------------------------------------------------
// stop-background-session(main.ts:2507-2510) IPC — 서브청크 δ가 소비하는 IPC 목록에 포함돼
// 있지만, 알림 큐와는 무관하고 이 파일의 stop_session/session_registry.rs의
// get_all_background_sessions를 그대로 호출만 하는 얇은 IPC 껍데기다.
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn stop_background_session_command(short_id: String) -> Vec<crate::session_registry::BackgroundSessionRow> {
    stop_session(short_id).await;
    crate::session_registry::get_all_background_sessions()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::sync::Mutex as StdMutex;

    fn fake_lead(internal_id: &str, id: &str, session_id: &str, target_dir: &str) -> LeadRecord {
        LeadRecord {
            id: id.to_string(),
            session_id: session_id.to_string(),
            target_dir: target_dir.to_string(),
            launched_at: 1_000,
            approved_members: Vec::new(),
            label: None,
            ai_title: None,
            internal_id: Some(internal_id.to_string()),
            auto_stall_nudge: None,
            secret: None,
            mcp_token: None,
        }
    }

    // schedule_healing을 no-op으로 둔 포트 — resume_spawn_with_retry_with_ports를 직접 테스트할
    // 때, 실제 schedule_background_resume_healing(real_ports() 기반 13초 백그라운드 치유)이
    // 테스트 프로세스 안에서 방치된 채로 실제 claude 프로세스를 spawn 시도하지 않게 막는다.
    fn noop_healing() -> Arc<dyn Fn(String, LeadRecord, String, String) + Send + Sync> {
        Arc::new(|_, _, _, _| {})
    }

    // ---- 시나리오 1: 정상 케이스(1회 성공) ----
    #[tokio::test(start_paused = true)]
    async fn resume_spawn_with_retry_succeeds_on_first_attempt_without_any_retry_gap() {
        let call_count = Arc::new(AtomicI64::new(0));
        let call_count_clone = call_count.clone();
        let ports = ResumePorts {
            run_claude_bg: Arc::new(move |_flags, _prompt, _cwd| {
                call_count_clone.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Some("lead1".to_string()) })
            }),
            agents_alive: Arc::new(|_id| Box::pin(async { Ok(true) })),
            cleanup_fork: Arc::new(|_id| panic!("정상 케이스에서는 cleanup_fork가 호출되면 안 된다")),
            schedule_healing: noop_healing(),
        };
        let current = fake_lead("internal-1", "lead1", "session-1", "C:\\fake");
        let result = resume_spawn_with_retry_with_ports(&ports, "internal-1", &current, "hi").await;
        assert_eq!(result, Some("lead1".to_string()));
        // 정상 경로는 resumeOnce를 딱 한 번만 호출하고(재시도 없음) 곧바로 반환해야 한다 —
        // resumeSpawnWithRetry의 "첫 시도는 기다리지 않고 바로 반환" 비대칭 구조 검증.
        assert_eq!(call_count.load(Ordering::SeqCst), 1);
    }

    // ---- 시나리오 2: 1차 실패 후 재시도 성공 ----
    #[tokio::test(start_paused = true)]
    async fn resume_retries_after_first_attempt_fails_and_second_succeeds() {
        let call_count = Arc::new(AtomicI64::new(0));
        let call_count_clone = call_count.clone();
        let ports = ResumePorts {
            run_claude_bg: Arc::new(move |_flags, _prompt, _cwd| {
                let n = call_count_clone.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if n == 0 {
                        None // 1차 시도: "backgrounded" 마커 없음/타임아웃
                    } else {
                        Some("lead1".to_string())
                    }
                })
            }),
            agents_alive: Arc::new(|_id| Box::pin(async { Ok(true) })),
            cleanup_fork: Arc::new(|_id| panic!("이 시나리오에서는 포크가 감지되면 안 된다")),
            schedule_healing: noop_healing(),
        };
        let current = fake_lead("internal-2", "lead1", "session-2", "C:\\fake");
        let result = resume_spawn_with_retry_with_ports(&ports, "internal-2", &current, "hi").await;
        assert_eq!(result, Some("lead1".to_string()));
        assert_eq!(call_count.load(Ordering::SeqCst), 2, "1차 실패 + 2차 성공으로 정확히 두 번 호출돼야 한다");

        // 성공 후에는 resumeRetryStatus가 지워져 있어야 한다(재시도 완료 후 정리).
        let guard = state().lock().unwrap();
        assert!(!guard.resume_retry_status.contains_key("internal-2"));
    }

    // ---- 시나리오 3: 전부 실패 ----
    #[tokio::test(start_paused = true)]
    async fn resume_gives_up_after_max_attempts_all_fail() {
        let call_count = Arc::new(AtomicI64::new(0));
        let call_count_clone = call_count.clone();
        let ports = ResumePorts {
            run_claude_bg: Arc::new(move |_flags, _prompt, _cwd| {
                call_count_clone.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { None })
            }),
            agents_alive: Arc::new(|_id| Box::pin(async { Ok(true) })),
            cleanup_fork: Arc::new(|_id| panic!("이 시나리오에서는 포크가 감지되면 안 된다")),
            schedule_healing: noop_healing(),
        };
        let current = fake_lead("internal-3", "lead1", "session-3", "C:\\fake");
        let result = resume_spawn_with_retry_with_ports(&ports, "internal-3", &current, "hi").await;
        assert_eq!(result, None);
        assert_eq!(call_count.load(Ordering::SeqCst), MAX_RESUME_ATTEMPTS, "MAX_RESUME_ATTEMPTS(3)번 전부 시도하고 포기해야 한다");

        let guard = state().lock().unwrap();
        assert!(!guard.resume_retry_status.contains_key("internal-3"), "실패로 끝나도 재시도 상태는 정리돼야 한다");
    }

    // ---- 시나리오 4: 짧은 id 불일치로 감지되는 포크 ----
    #[tokio::test(start_paused = true)]
    async fn resume_once_detects_fork_by_id_mismatch_and_cleans_up() {
        let cleanup_called_with: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
        let cleanup_called_with_clone = cleanup_called_with.clone();
        let ports = ResumePorts {
            // "started a copy" 문구를 놓쳤다고 가정 — run_claude_bg가 그냥 다른 짧은 id를 돌려준다.
            run_claude_bg: Arc::new(|_flags, _prompt, _cwd| Box::pin(async { Some("forked-copy-id".to_string()) })),
            agents_alive: Arc::new(|_id| Box::pin(async { Ok(true) })),
            cleanup_fork: Arc::new(move |id| {
                *cleanup_called_with_clone.lock().unwrap() = Some(id);
            }),
            schedule_healing: Arc::new(|_, _, _, _| panic!("포크로 감지되면 resumeOnce가 None을 반환하므로 healing이 예약되면 안 된다")),
        };
        let current = fake_lead("internal-4", "original-id", "session-4", "C:\\fake");
        let result = resume_once_with_ports(&ports, "internal-4", &current, "hi", 1).await;
        assert_eq!(result, None, "id가 다르면 성공으로 취급하면 안 된다");
        assert_eq!(cleanup_called_with.lock().unwrap().as_deref(), Some("forked-copy-id"), "복사본 정리가 정확한 id로 호출돼야 한다");
    }

    // resumeRetryFrom의 크래시 감지(A-3) — resumeOnce는 성공하지만(같은 id로 돌아옴)
    // RESUME_SETTLE_CHECK_MS 뒤 생존 확인에서 죽어있는 것으로 나오면 실패로 취급하고 재시도해야
    // 한다.
    #[tokio::test(start_paused = true)]
    async fn resume_retry_treats_post_settle_crash_as_failure_and_retries() {
        let attempt_count = Arc::new(AtomicI64::new(0));
        let attempt_count_clone = attempt_count.clone();
        let ports = ResumePorts {
            run_claude_bg: Arc::new(move |_flags, _prompt, _cwd| {
                attempt_count_clone.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Some("lead1".to_string()) })
            }),
            // 첫 생존 확인만 실패(크래시)로 응답하고, 이후엔 살아있다고 응답한다.
            agents_alive: {
                let checked = Arc::new(AtomicI64::new(0));
                Arc::new(move |_id| {
                    let n = checked.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async move { Ok(n > 0) })
                })
            },
            cleanup_fork: Arc::new(|_id| {}),
            schedule_healing: noop_healing(),
        };
        let current = fake_lead("internal-5", "lead1", "session-5", "C:\\fake");
        let result = resume_retry_from_with_ports(&ports, "internal-5", &current, "hi", 1).await;
        assert_eq!(result, Some("lead1".to_string()));
        assert_eq!(attempt_count.load(Ordering::SeqCst), 2, "첫 settle 확인이 크래시로 나오면 한 번 더 시도해야 한다");
    }

    // agents_alive 조회 자체가 실패하면 fail-closed(성공으로 간주)해서 불필요한 재시도를 피해야
    // 한다(A-3 주석 그대로).
    #[tokio::test(start_paused = true)]
    async fn resume_retry_fails_closed_when_survival_check_itself_errors() {
        let ports = ResumePorts {
            run_claude_bg: Arc::new(|_flags, _prompt, _cwd| Box::pin(async { Some("lead1".to_string()) })),
            agents_alive: Arc::new(|_id| Box::pin(async { Err("agents --json 조회 실패".to_string()) })),
            cleanup_fork: Arc::new(|_id| {}),
            schedule_healing: noop_healing(),
        };
        let current = fake_lead("internal-6", "lead1", "session-6", "C:\\fake");
        let result = resume_retry_from_with_ports(&ports, "internal-6", &current, "hi", 1).await;
        assert_eq!(result, Some("lead1".to_string()), "생존 확인 자체가 실패하면 fail-closed로 성공 취급해야 한다");
    }

    // ---- apply_resume_session_update: B-1 fail-closed 가드 순수 함수 테스트 ----
    #[test]
    fn apply_resume_session_update_keeps_old_session_id_when_short_id_unchanged_but_session_id_differs() {
        let mut leads = vec![fake_lead("internal-b1", "lead1", "old-session", "C:\\fake")];
        let updated = apply_resume_session_update(&mut leads, "internal-b1", "lead1", "old-session", "lead1", Some("suspicious-new-session"));
        assert!(updated);
        assert_eq!(leads[0].session_id, "old-session", "짧은 id가 안 바뀌었는데 sessionId만 달라 보이면 기존 값을 유지해야 한다(B-1)");
        assert_eq!(leads[0].id, "lead1");
    }

    #[test]
    fn apply_resume_session_update_accepts_new_session_id_when_short_id_actually_changed() {
        // 짧은 id 자체가 바뀐 경우(진짜 포크로부터 복구된 경우 등)는 B-1 가드에 안 걸리므로
        // 정상적으로 갱신돼야 한다.
        let mut leads = vec![fake_lead("internal-b1b", "old-lead-id", "old-session", "C:\\fake")];
        let updated = apply_resume_session_update(&mut leads, "internal-b1b", "old-lead-id", "old-session", "new-lead-id", Some("new-session"));
        assert!(updated);
        assert_eq!(leads[0].id, "new-lead-id");
        assert_eq!(leads[0].session_id, "new-session");
    }

    #[test]
    fn apply_resume_session_update_keeps_old_session_id_when_lookup_failed() {
        let mut leads = vec![fake_lead("internal-b2", "lead1", "old-session", "C:\\fake")];
        let updated = apply_resume_session_update(&mut leads, "internal-b2", "lead1", "old-session", "lead1", None);
        assert!(updated);
        assert_eq!(leads[0].session_id, "old-session", "새 sessionId 조회가 실패하면 낡은 값이라도 유지해야 한다");
    }

    #[test]
    fn apply_resume_session_update_returns_false_when_internal_id_not_found() {
        let mut leads = vec![fake_lead("internal-other", "lead1", "session", "C:\\fake")];
        let updated = apply_resume_session_update(&mut leads, "internal-missing", "lead1", "session", "lead1", Some("session2"));
        assert!(!updated);
    }

    #[test]
    fn apply_mcp_token_sets_token_on_matching_record_only() {
        let mut leads = vec![fake_lead("internal-x", "lead1", "session-x", "C:\\fake"), fake_lead("internal-y", "lead2", "session-y", "C:\\fake")];
        assert!(apply_mcp_token(&mut leads, "internal-x", "token-123"));
        assert_eq!(leads[0].mcp_token.as_deref(), Some("token-123"));
        assert_eq!(leads[1].mcp_token, None);
        assert!(!apply_mcp_token(&mut leads, "internal-missing", "token-456"));
    }

    // "먼저 들어온 resume_lead_command 호출이 큐 직렬화를 실제로 타는지"까지 확인하는 통합
    // 테스트는 leads.json 실제 파일 I/O + queue_lead_operation을 함께 검증해야 해서 무겁다 —
    // concurrency.rs의 queued_operations_on_same_key_run_strictly_in_order가 큐 자체의 직렬화를
    // 이미 검증하고, 위 apply_resume_session_update/apply_mcp_token 테스트가 leads.json 쓰기
    // 판정 로직을 디스크 I/O 없이 검증하므로 이 둘을 합치는 실제 파일 기반 통합 테스트는 중복이라
    // 생략한다(설계 문서 §2-β "독립적 검증 가능성" — 계층별로 이미 커버됨). 다만 "서로 다른
    // internalId끼리(=서로 다른 큐 액터끼리) leads.json에 동시에 쓰면 어떻게 되는지"는 큐 직렬화
    // 테스트가 전혀 커버하지 못하는 별개의 축이다 — 이건 session_registry.rs의
    // leads_json_lost_update_is_reproducible_without_the_lock/
    // with_leads_lock_prevents_lost_update_under_concurrent_writes_to_different_leads가
    // 실제 파일 I/O로 검증한다(β 리뷰가 지적한 치명적 버그의 재현/수정 확인).
    //
    // 실제 claude 프로세스를 spawn하는 통합 테스트에 대한 판단: check_claude_binary_once(아래)는
    // `where claude`만 실행하는 읽기 전용 조회라 안전하지만, run_claude_bg/stop_session/
    // resume_once를 실제 claude 프로세스로 끝까지 돌리는 테스트는 `claude --bg`가 실제 백그라운드
    // 세션을 만들고 `claude stop`이 실제 세션을 종료시킨다 — 이 저장소 자체가 지금 팀장/팀원
    // 세션으로 운영되고 있는 실제 개발 머신에서 자동 테스트로 실행하기엔 위험이 너무 크다(잘못된
    // 세션을 stop하거나 고아 세션을 남길 위험). 그래서 실제 claude --bg/--resume/stop 통합 테스트는
    // 의도적으로 추가하지 않았다 — 이 판단 자체를 문서화해서(요청받은 "포기한 이유 문서화" 원칙,
    // J-1 처리 방식과 동일) 리뷰어가 빠뜨린 게 아니라 의식적인 선택임을 알 수 있게 한다.
    #[test]
    fn checks_real_claude_binary_location_readonly() {
        // 부작용 없는 유일한 실제 프로세스 테스트 — where claude 실행 결과 자체는 검증하지 않고
        // (설치 환경마다 다름) panic 없이 끝나는지만 확인한다.
        check_claude_binary_blocking();
    }
}
