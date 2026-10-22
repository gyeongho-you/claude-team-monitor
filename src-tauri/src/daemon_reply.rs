// 실행 중인 팀장 세션에 정지 없이 메시지를 전달한다(src/lib/daemonReply.js와 같은 규칙).
//
// 배경(실측 2026-10-22, 디자인 팀장): 팀장이 개발 서버 같은 백그라운드 명령을 띄워두고 쉬면 데몬은 agents status를
// 계속 busy로 보고하고, 앱은 "작업 중이니 끝나면 전달"로 사용자 메시지를 대기열에 쌓는다 — 그런데 그 서버는 끝나지
// 않으니 메시지가 영영 안 간다(36분째 대기 확인). 대안인 stop→resume은 백그라운드 프로세스를 죽이진 않지만(실측: 정지 후 56초 넘게 ping이 계속 살아 있었다) 다시 깨어난 세션은 그 작업을 추적하지 못하고 방치된 채로 남기며, 정지·재기동 자체의 위험(세션 포크 등)도 있다.
// 그래서 데몬 제어 소켓의 `reply` 명령(에이전트 뷰의 "답장"이 쓰는 경로)으로 직접 전달한다 — 시험 세션에서 백그라운드
// ping이 계속 도는 채로 메시지가 전달돼 답이 오는 것을 확인했다. 기록에도 일반 사용자 메시지(같은 문구, promptId 포함)로
// 남아서 앱의 전달 판정이 그대로 동작한다.
//
// 주의: 이건 CLI 내부 프로토콜이라 버전이 바뀌면 깨질 수 있다(데몬이 EAUTH/ESKEW/ENOREPLY 등으로 거절). 그래서 호출하는 쪽은
// 실패하면 반드시 기존 동작(대기열)으로 되돌아가야 한다. 프로토콜: 줄바꿈으로 끝나는 JSON 한 줄을 보내면 JSON 한 줄이 돌아오고,
// proto=1, 인증은 ~/.claude/daemon/control.key 내용(auth), 소켓은 \\.\pipe\cc-daemon-<해시>-control — 해시는
// ~/.claude/daemon/roster.json의 워커 소켓 경로에서 얻는다.

use crate::paths::claude_home;
use std::path::Path;
use std::time::Duration;

const PROTO: u32 = 1;
const IO_TIMEOUT: Duration = Duration::from_secs(5);

/// roster.json의 워커 소켓 경로(…\cc-daemon-<해시>-rv-<id> 또는 …-pty-<id>)에서 제어 소켓 경로를 만든다.
pub(crate) fn control_path_from_roster(roster_json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(roster_json).ok()?;
    for worker in v.get("workers")?.as_object()?.values() {
        for field in ["rendezvousSock", "ptySock"] {
            let Some(sock) = worker.get(field).and_then(|s| s.as_str()) else { continue };
            for marker in ["-rv-", "-pty-"] {
                if let Some(idx) = sock.rfind(marker) {
                    return Some(format!("{}-control", &sock[..idx]));
                }
            }
        }
    }
    None
}

pub(crate) fn build_reply_line(short_id: &str, text: &str, key: &str) -> String {
    format!("{}\n", serde_json::json!({ "proto": PROTO, "op": "reply", "short": short_id, "text": text, "auth": key }))
}

/// 데몬 응답 한 줄을 해석한다. ok면 Ok, 아니면 코드와 사유를 담은 Err.
pub(crate) fn parse_reply_response(line: &str) -> Result<(), String> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).map_err(|e| format!("응답을 해석하지 못했습니다: {e}"))?;
    if v.get("ok").and_then(|o| o.as_bool()) == Some(true) {
        return Ok(());
    }
    let code = v.get("code").and_then(|c| c.as_str()).unwrap_or("?");
    let error = v.get("error").and_then(|c| c.as_str()).unwrap_or("");
    Err(format!("{code}: {error}"))
}

fn read_trimmed(path: &Path) -> Option<String> {
    let s = std::fs::read_to_string(path).ok()?;
    let t = s.trim();
    if t.is_empty() { None } else { Some(t.to_string()) }
}

#[cfg(windows)]
async fn exchange(path: &str, line: &str) -> Result<String, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::windows::named_pipe::ClientOptions;
    let work = async {
        // 파이프가 잠깐 바쁠 수 있어(ERROR_PIPE_BUSY=231) 몇 번 재시도한다.
        let mut client = None;
        for _ in 0..5 {
            match ClientOptions::new().open(path) {
                Ok(c) => { client = Some(c); break; }
                Err(e) if e.raw_os_error() == Some(231) => tokio::time::sleep(Duration::from_millis(50)).await,
                Err(e) => return Err(format!("제어 소켓에 연결하지 못했습니다: {e}")),
            }
        }
        let mut client = client.ok_or_else(|| "제어 소켓이 계속 바쁩니다".to_string())?;
        client.write_all(line.as_bytes()).await.map_err(|e| format!("전송 실패: {e}"))?;
        let mut reader = BufReader::new(client);
        let mut resp = String::new();
        reader.read_line(&mut resp).await.map_err(|e| format!("응답 읽기 실패: {e}"))?;
        if resp.trim().is_empty() { Err("데몬이 빈 응답을 보냈습니다".to_string()) } else { Ok(resp) }
    };
    tokio::time::timeout(IO_TIMEOUT, work).await.map_err(|_| "데몬 응답 시간 초과".to_string())?
}

#[cfg(not(windows))]
async fn exchange(_path: &str, _line: &str) -> Result<String, String> {
    Err("이 플랫폼에서는 지원하지 않습니다".to_string())
}

/// 실행 중인 세션(짧은 id)에 메시지를 다음 사용자 턴으로 전달한다. 세션을 멈추지 않는다.
pub async fn reply_to_session(short_id: &str, text: &str) -> Result<(), String> {
    let daemon_dir = claude_home().join("daemon");
    let key = read_trimmed(&daemon_dir.join("control.key")).ok_or("데몬 제어 키(control.key)를 읽지 못했습니다")?;
    let roster = std::fs::read_to_string(daemon_dir.join("roster.json")).map_err(|e| format!("roster.json을 읽지 못했습니다: {e}"))?;
    let path = control_path_from_roster(&roster).ok_or("roster.json에서 제어 소켓 경로를 찾지 못했습니다")?;
    let resp = exchange(&path, &build_reply_line(short_id, text, &key)).await?;
    parse_reply_response(&resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_path_is_derived_from_worker_socket_paths() {
        let roster = r#"{"proto":1,"workers":{"77e4c4d5":{"rendezvousSock":"\\\\.\\pipe\\cc-daemon-3a724ee05e173573-rv-77e4c4d5","ptySock":"\\\\.\\pipe\\cc-daemon-3a724ee05e173573-pty-77e4c4d5"}}}"#;
        assert_eq!(control_path_from_roster(roster).as_deref(), Some(r"\\.\pipe\cc-daemon-3a724ee05e173573-control"));
        // 워커가 없거나 소켓 정보가 없으면 만들 수 없다
        assert_eq!(control_path_from_roster(r#"{"workers":{}}"#), None);
        assert_eq!(control_path_from_roster("not json"), None);
        assert_eq!(control_path_from_roster(r#"{"workers":{"a":{"pid":1}}}"#), None);
    }

    #[test]
    fn reply_line_is_single_line_json_with_all_fields() {
        let line = build_reply_line("c728206b", "줄1\n줄2 \"따옴표\"", "KEY");
        assert!(line.ends_with('\n') && line.matches('\n').count() == 1, "메시지 안의 줄바꿈은 이스케이프돼야 한다");
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["op"], "reply");
        assert_eq!(v["proto"], 1);
        assert_eq!(v["short"], "c728206b");
        assert_eq!(v["text"], "줄1\n줄2 \"따옴표\"");
        assert_eq!(v["auth"], "KEY");
    }

    #[test]
    fn response_ok_and_error_codes_are_distinguished() {
        assert!(parse_reply_response(r#"{"ok":true,"op":"reply"}"#).is_ok());
        let e = parse_reply_response(r#"{"ok":false,"error":"this window didn't present the daemon control key","code":"EAUTH"}"#).unwrap_err();
        assert!(e.starts_with("EAUTH"), "{e}");
        assert!(parse_reply_response("garbage").is_err());
    }
}
