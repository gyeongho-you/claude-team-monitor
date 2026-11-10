use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use wait_timeout::ChildExt;

// main.ts의 AgentEntry 타입과 대응한다. claude agents --json 출력은 id/pid/name/status/state/
// waitingFor를 조건에 따라 생략할 수 있어(interactive 세션, 아직 질문에 안 걸린 세션 등) 대부분
// optional로 둔다 — 한 항목의 필드 하나가 예상과 달라도 배열 전체 파싱이 깨지지 않게 하기 위함.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEntry {
    pub id: Option<String>,
    pub pid: Option<i64>,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub kind: String,
    #[serde(rename = "startedAt", default)]
    pub started_at: Option<i64>,
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    pub name: Option<String>,
    pub status: Option<String>,
    pub state: Option<String>,
    #[serde(rename = "waitingFor")]
    pub waiting_for: Option<String>,
}

// claude agents --json 자체가 daemon 문제로 응답 없이 멈추면, 이 호출 하나가 프론트엔드의 폴링
// 체인 전체를 영구히 막을 수 있다(Electron 버전의 src/lib/agentsJson.js가 exec에 타임아웃을 준
// 것과 같은 이유). Rust 표준 라이브러리엔 프로세스 대기에 타임아웃이 없어서 wait-timeout 크레이트로
// 흉내낸다.
const AGENTS_JSON_TIMEOUT: Duration = Duration::from_secs(10);

/// 이 앱이 `claude agents --json`을 부른 횟수와 그 호출 직후 `~/.claude`에 OAuth 갱신 잠금의 임시 파일(`.oauth_refresh.lock.owner.tmp.*`)이 늘었는지 센다.
/// 이 파일은 앱이 아니라 claude CLI가 토큰 갱신 때 남기는 것인데, 앱이 3초마다 claude를 새로 띄우므로 "내 호출 직후에 생기는가"를 직접 보려는 계측이다(원인 확정용 — 앱 동작은 바꾸지 않는다).
/// 같은 순간 다른 claude 프로세스가 만든 파일도 섞일 수 있어서, 한 번의 증가는 증거가 아니고 "여러 번 반복되는 패턴"을 본다.
struct CallStats {
    calls: AtomicU64,
    total_ms: AtomicU64,
    max_ms: AtomicU64,
    failures: AtomicU64,
    slow: AtomicU64,
    tmp_increases: AtomicU64,
    last_increase_unix_ms: AtomicU64,
    last_tmp_count: AtomicU64,
    last_slow_log_unix_ms: AtomicU64,
    first_logged: AtomicBool,
}
static STATS: CallStats = CallStats {
    calls: AtomicU64::new(0),
    total_ms: AtomicU64::new(0),
    max_ms: AtomicU64::new(0),
    failures: AtomicU64::new(0),
    slow: AtomicU64::new(0),
    tmp_increases: AtomicU64::new(0),
    last_increase_unix_ms: AtomicU64::new(0),
    last_tmp_count: AtomicU64::new(0),
    last_slow_log_unix_ms: AtomicU64::new(0),
    first_logged: AtomicBool::new(false),
};
const OAUTH_OWNER_TMP_PREFIX: &str = ".oauth_refresh.lock.owner.tmp.";
const SLOW_CALL_MS: u64 = 3000;
const SLOW_LOG_MIN_GAP_MS: u64 = 30_000;

/// 폴더 안의 OAuth 갱신 잠금 임시 파일 개수(시험용으로 폴더를 받는다).
pub(crate) fn count_oauth_owner_tmp_files_in(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir).map(|rd| rd.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with(OAUTH_OWNER_TMP_PREFIX)).count() as u64).unwrap_or(0)
}

/// 느리거나 실패한 호출을 로그에 남길지 — 앞 기록과 최소 간격(30초)을 둬서 로그가 쌓이지 않게 한다.
pub(crate) fn should_log_rate_limited(last_unix_ms: u64, now_unix_ms: u64, min_gap_ms: u64) -> bool {
    last_unix_ms == 0 || now_unix_ms.saturating_sub(last_unix_ms) >= min_gap_ms
}

/// 진단 정보에 넣을 요약(앱을 켠 뒤 지금까지).
pub(crate) fn call_stats_summary() -> String {
    let calls = STATS.calls.load(Ordering::Relaxed);
    let avg = if calls == 0 { 0 } else { STATS.total_ms.load(Ordering::Relaxed) / calls };
    let last = STATS.last_increase_unix_ms.load(Ordering::Relaxed);
    let last_txt = if last == 0 { "없음".to_string() } else { format!("{}", chrono::DateTime::from_timestamp_millis(last as i64).map(|d| d.with_timezone(&chrono::Local).format("%m-%d %H:%M:%S").to_string()).unwrap_or_default()) };
    format!(
        "- `claude agents --json` 호출(앱을 켠 뒤): {calls}회, 평균 {avg}ms, 최대 {}ms, 실패 {}회, {SLOW_CALL_MS}ms 넘게 걸린 호출 {}회\n- 호출 직후 OAuth 갱신 잠금 임시 파일이 늘어난 횟수: {}회(마지막: {last_txt}) / 지금 ~/.claude의 임시 파일: {}개",
        STATS.max_ms.load(Ordering::Relaxed),
        STATS.failures.load(Ordering::Relaxed),
        STATS.slow.load(Ordering::Relaxed),
        STATS.tmp_increases.load(Ordering::Relaxed),
        STATS.last_tmp_count.load(Ordering::Relaxed),
    )
}

fn run_claude_agents_json() -> Result<String, String> {
    let home = crate::paths::claude_home();
    let before = count_oauth_owner_tmp_files_in(&home);
    let started = std::time::Instant::now();
    let result = run_claude_agents_json_inner();
    let ms = started.elapsed().as_millis() as u64;
    let after = count_oauth_owner_tmp_files_in(&home);
    record_call(ms, result.as_ref().err().map(String::as_str), before, after);
    result
}

fn record_call(ms: u64, err: Option<&str>, before: u64, after: u64) {
    let now = crate::timing::now_ms().max(0) as u64;
    STATS.calls.fetch_add(1, Ordering::Relaxed);
    STATS.total_ms.fetch_add(ms, Ordering::Relaxed);
    STATS.max_ms.fetch_max(ms, Ordering::Relaxed);
    STATS.last_tmp_count.store(after, Ordering::Relaxed);
    if err.is_some() {
        STATS.failures.fetch_add(1, Ordering::Relaxed);
    }
    if ms >= SLOW_CALL_MS {
        STATS.slow.fetch_add(1, Ordering::Relaxed);
    }
    if !STATS.first_logged.swap(true, Ordering::Relaxed) {
        crate::logging::log_critical(&format!("[agents 계측] 시작 — 이 앱이 부르는 claude agents --json의 소요 시간과, 호출 직후 ~/.claude의 OAuth 갱신 잠금 임시 파일(.oauth_refresh.lock.owner.tmp.*) 증가를 기록합니다(현재 {after}개)."));
    }
    if after > before {
        STATS.tmp_increases.fetch_add(1, Ordering::Relaxed);
        STATS.last_increase_unix_ms.store(now, Ordering::Relaxed);
        crate::logging::log_critical(&format!(
            "[agents 계측] 호출 직후 OAuth 임시 파일이 {before}→{after}개로 늘었습니다(소요 {ms}ms, 결과 {}, 누적 증가 {}회 / 호출 {}회). 같은 순간의 다른 claude 프로세스가 만든 것일 수도 있어 반복되는 패턴으로 판단하세요.",
            match err { Some(e) => format!("오류: {e}"), None => "정상".to_string() },
            STATS.tmp_increases.load(Ordering::Relaxed),
            STATS.calls.load(Ordering::Relaxed),
        ));
    } else if (err.is_some() || ms >= SLOW_CALL_MS) && should_log_rate_limited(STATS.last_slow_log_unix_ms.load(Ordering::Relaxed), now, SLOW_LOG_MIN_GAP_MS) {
        STATS.last_slow_log_unix_ms.store(now, Ordering::Relaxed);
        crate::logging::log_critical(&format!("[agents 계측] 호출이 {} — {ms}ms (임시 파일 {after}개)", match err { Some(e) => format!("실패했습니다({e})"), None => "느렸습니다".to_string() }));
    }
}

fn run_claude_agents_json_inner() -> Result<String, String> {
    let mut cmd = Command::new("claude");
    cmd.args(["agents", "--json"]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 콘솔 창이 잠깐 깜빡이는 걸 막는다(Electron 쪽 windowsHide: true와 동일한 효과).
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("claude 실행 실패: {e}"))?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");

    // stdout/stderr을 별도 스레드로 즉시 비워둔다 — 대기 중에 파이프 버퍼가 가득 차서 자식 프로세스가
    // 멈추는 걸 막기 위함(Node의 exec가 maxBuffer로 같은 문제를 다루는 것과 같은 이유).
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });

    match child
        .wait_timeout(AGENTS_JSON_TIMEOUT)
        .map_err(|e| format!("claude 대기 실패: {e}"))?
    {
        Some(status) => {
            let stdout_bytes = stdout_reader.join().unwrap_or_default();
            let _ = stderr_reader.join();
            if !status.success() {
                return Err(format!(
                    "claude agents --json 종료 코드 {:?}",
                    status.code()
                ));
            }
            String::from_utf8(stdout_bytes).map_err(|e| format!("stdout 디코딩 실패: {e}"))
        }
        None => {
            // 타임아웃 — 죽여서 좀비로 안 남게 한다.
            let _ = child.kill();
            let _ = child.wait();
            Err("claude agents --json 응답 시간 초과(10s)".to_string())
        }
    }
}

/// `claude agents --json`을 실행해 파싱한 결과를 그대로 돌려준다. exec/파싱이 실패하면(타임아웃
/// 포함) 에러를 그대로 전달한다 — "실패"와 "빈 목록"을 구분해야 하는 호출부를 위해 여기서 빈
/// 배열로 뭉개지 않는다(src/lib/agentsJson.js의 execAgentsJson과 같은 설계). "빈 목록으로 봐도
/// 되는" 호출부는 프론트엔드에서 .catch(() => [])로 감싸서 쓴다(같은 파일의 fetchAgents와 동일).
#[tauri::command]
pub fn get_agents_json() -> Result<Value, String> {
    let raw = run_claude_agents_json()?;
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("JSON 파싱 실패: {e}"))
}

/// src/main.ts의 fetchAgents()와 같은 설계 — exec/파싱 실패 시 빈 배열로 fail-open한다. 보드/세션
/// 목록 표시처럼 "일시적으로 몇 초 못 그려도 그만"인 호출부 전용이다(생존 확인처럼 "빈 배열=확실히
/// 죽었다"로 오판하면 안 되는 곳엔 쓰면 안 된다 — 그런 곳이 생기면 run_claude_agents_json을 직접
/// 호출하는 strict 버전을 별도로 추가할 것).
/// `claude agents --json`을 실행해 파싱한다 — 실패(실행·타임아웃·종료 코드·JSON 형식)를 "세션이 0개"와 구분해 Err로 돌려준다.
/// 팀원 등록을 정리하거나 팀장을 오프라인으로 보는 판단은 반드시 이쪽을 써야 한다(조회 실패를 빈 목록으로 오해하면 살아 있는 팀원의 등록이 보관함으로 옮겨진다).
pub fn fetch_agents_result() -> Result<Vec<AgentEntry>, String> {
    let raw = run_claude_agents_json()?;
    serde_json::from_str::<Vec<AgentEntry>>(&raw).map_err(|e| format!("JSON 파싱 실패: {e}"))
}

pub fn fetch_agents_typed() -> Vec<AgentEntry> {
    match run_claude_agents_json() {
        Ok(raw) => serde_json::from_str::<Vec<AgentEntry>>(&raw).unwrap_or_default(),
        Err(e) => {
            // 실패하면 빈 목록으로 넘어가서 화면에는 세션이 하나도 안 보인다 — 원인(claude를 못 찾음 등)을 알 수 있게 첫 실패만 앱 로그에 남긴다.
            static LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if !LOGGED.swap(true, std::sync::atomic::Ordering::Relaxed) {
                crate::logging::log_critical(&format!("[agents] claude agents --json을 실행하지 못해 앱이 세션을 볼 수 없습니다 — {e}"));
            }
            Vec::new()
        }
    }
}

/// async 컨텍스트(queue_lead_operation의 job 등)에서 fetch_agents_typed()를 쓸 때 전용 —
/// 이 안의 claude 실행/대기는 최대 AGENTS_JSON_TIMEOUT(10s)까지 블로킹이라, tokio worker 스레드를
/// 그대로 막지 않도록 spawn_blocking으로 감싼다(TAURI_NOTICE_QUEUE_DESIGN.md §2-β 리뷰 지침 1번).
/// fetch_agents_typed()와 마찬가지로 fail-open(실패 시 빈 배열)이다.
pub async fn fetch_agents_typed_async() -> Vec<AgentEntry> {
    tokio::task::spawn_blocking(fetch_agents_typed).await.unwrap_or_default()
}

/// src/main.ts의 fetchAgentsStrict()와 같은 설계 — exec/파싱 실패 시 빈 배열로 fail-open하지
/// 않고 에러를 그대로 전달한다. stopSession의 생존 확인, resumeLead의 "지금 실제로 떠있는지"
/// 판정처럼 "확인 안 됨"을 "안 살아있음"으로 잘못 해석하면 안 되는 fail-closed 호출부 전용이다
/// (TAURI_NOTICE_QUEUE_DESIGN.md §1 A-2/B-1 — fail-open으로 잘못 판정하면 아직 살아있는 세션에
/// resume을 걸어 복사본이 생기는 사고로 이어진다).
pub async fn fetch_agents_typed_strict() -> Result<Vec<AgentEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let raw = run_claude_agents_json()?;
        serde_json::from_str::<Vec<AgentEntry>>(&raw).map_err(|e| format!("JSON 파싱 실패: {e}"))
    })
    .await
    .map_err(|e| format!("agents --json 조회 태스크가 panic했습니다: {e}"))?
}

// renderer/lib/status.js의 getStatus 핵심 로직 — main.ts(Node)/renderer.js(브라우저) 양쪽이
// 공유하는 그 파일과 동일한 규칙이다: state가 'done'/'blocked'면 status가 못 따라온 낡은 값이어도
// 최우선 취급하고, 그 외에는 status를 우선하고 state로 폴백한다. AgentEntry가 이 모듈 소유라 여기
// 두고, stall_watchdog.rs(get_status_row/get_status_agent)와 notice_queue.rs(isLeadTooBusyToInterrupt/
// notifyLeadsOfFinishedMembers)가 함께 재사용한다 — 상태 판정 규칙이 두 곳에서 따로 갈라지는 걸
// 막기 위해 반드시 이 함수 하나만 거치게 한다.
pub(crate) fn get_status(status: Option<&str>, state: Option<&str>) -> String {
    if state == Some("done") {
        return "done".to_string();
    }
    if state == Some("blocked") {
        return "blocked".to_string();
    }
    let s = status.filter(|v| !v.is_empty());
    let st = state.filter(|v| !v.is_empty());
    s.or(st).unwrap_or("").to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_status_prioritizes_done_and_blocked_state_over_status() {
        assert_eq!(get_status(Some("idle"), Some("done")), "done");
        assert_eq!(get_status(Some("busy"), Some("blocked")), "blocked");
        assert_eq!(get_status(Some("Busy"), None), "busy");
        assert_eq!(get_status(None, Some("Working")), "working");
        assert_eq!(get_status(None, None), "");
    }

    // 진짜 `claude agents --json`을 실행한다 — claude CLI가 없는 환경(CI 등)에서는 통과할 수 없으므로 기본 실행에서 뺐다. 수동: cargo test -- --ignored parses_real_claude_agents_output
    #[test]
    #[ignore = "실제 claude CLI가 필요하다. 수동으로만: cargo test -- --ignored parses_real_claude_agents_output"]
    fn parses_real_claude_agents_output() {
        let value = get_agents_json().expect("claude agents --json 실행 실패 — PATH에 claude가 있는지 확인 필요");
        assert!(value.is_array(), "claude agents --json은 배열을 돌려줘야 한다");
    }
}

#[cfg(test)]
mod instrument_tests {
    use super::*;

    #[test]
    fn counts_only_oauth_owner_tmp_files() {
        let d = std::env::temp_dir().join(format!("ctm_instr_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        for n in [".oauth_refresh.lock.owner.tmp.0075b450", ".oauth_refresh.lock.owner.tmp.ffff0000", ".oauth_refresh.lock.owner", ".oauth_refresh.lock", "other.tmp.0075b450", "settings.json"] {
            std::fs::write(d.join(n), b"x").unwrap();
        }
        assert_eq!(count_oauth_owner_tmp_files_in(&d), 2, "임시 파일(.tmp.*)만 센다 — 진짜 소유자 기록·잠금은 세지 않는다");
        assert_eq!(count_oauth_owner_tmp_files_in(&d.join("없는폴더")), 0);
    }

    #[test]
    fn slow_or_failed_calls_are_logged_at_most_once_per_gap() {
        assert!(should_log_rate_limited(0, 1_000, 30_000), "처음은 남긴다");
        assert!(!should_log_rate_limited(1_000, 20_000, 30_000), "30초 안에는 또 남기지 않는다");
        assert!(should_log_rate_limited(1_000, 31_000, 30_000));
    }

    #[test]
    fn summary_text_reports_counts_without_panicking() {
        let s = call_stats_summary();
        assert!(s.contains("claude agents --json") && s.contains("임시 파일"), "{s}");
    }
}

