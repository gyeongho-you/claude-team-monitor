use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
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

fn run_claude_agents_json() -> Result<String, String> {
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
pub fn fetch_agents_typed() -> Vec<AgentEntry> {
    match run_claude_agents_json() {
        Ok(raw) => serde_json::from_str::<Vec<AgentEntry>>(&raw).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_real_claude_agents_output() {
        let value = get_agents_json().expect("claude agents --json 실행 실패 — PATH에 claude가 있는지 확인 필요");
        assert!(value.is_array(), "claude agents --json은 배열을 돌려줘야 한다");
    }
}
