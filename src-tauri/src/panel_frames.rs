// 패널의 HTML 그래픽 중 JavaScript를 허용한 것(슬롯의 "JavaScript 허용")을 담는 별도 문서 서버.
//
// 왜 필요한가: 앱 화면의 CSP(script-src 'self')는 그 안의 iframe(srcdoc)에도 상속돼서, srcdoc 프레임 안에서는 인라인 스크립트가 아예 실행되지 않는다(실험으로 확인).
// 그래서 JavaScript가 필요한 그래픽은 앱 화면과 **다른 출처**의 문서(ctmframe 주소)로 띄운다. 이 문서는 응답 헤더에 자기 CSP를 달고 나가므로 앱의 CSP를 상속하지 않는다.
//
// 격리(시험으로 확인한 것은 panel 관련 시험 기록 참고):
//  - 응답 CSP: 네트워크 접속(connect-src 'none')·외부 이미지·외부 스크립트·폼 전송을 막고, 인라인 스크립트·스타일과 data: 이미지·글꼴만 허용한다.
//  - 앱 화면 쪽에서 iframe에 sandbox="allow-scripts"만 준다(allow-same-origin 없음 → 앱과 같은 출처가 아니라서 앱 화면의 변수·함수·Tauri 호출에 닿지 못한다).
//  - 앱 화면 CSP의 frame-src에는 이 주소만 허용해서, 프레임 안 코드가 자기 주소를 바깥 사이트로 바꿔 데이터를 내보내는 길도 막는다.
// 문서 내용은 앱 화면이 만들어 등록(store)하고 토큰으로 가져간다. 오래된 것은 버린다(최근 MAX_FRAMES개만 유지).

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

pub(crate) const SCHEME: &str = "ctmframe";
const MAX_FRAMES: usize = 32;
pub(crate) const MAX_FRAME_BYTES: usize = 4_000_000;

struct Frame {
    token: String,
    html: String,
}

fn frames() -> &'static Mutex<VecDeque<Frame>> {
    static F: OnceLock<Mutex<VecDeque<Frame>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(VecDeque::new()))
}

/// 문서를 등록하고 토큰을 돌려준다.
pub(crate) fn store(html: String) -> Result<String, String> {
    if html.len() > MAX_FRAME_BYTES {
        return Err("그래픽이 너무 큽니다.".to_string());
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut list = frames().lock().unwrap_or_else(|e| e.into_inner());
    list.push_back(Frame { token: token.clone(), html });
    while list.len() > MAX_FRAMES {
        list.pop_front();
    }
    Ok(token)
}

pub(crate) fn lookup(token: &str) -> Option<String> {
    frames().lock().unwrap_or_else(|e| e.into_inner()).iter().find(|f| f.token == token).map(|f| f.html.clone())
}

/// 앱 화면이 iframe에 넣을 주소. Windows의 WebView2는 사용자 정의 스킴을 http://<스킴>.localhost 로 다룬다.
pub(crate) fn frame_url(token: &str) -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{token}")
    } else {
        format!("{SCHEME}://localhost/{token}")
    }
}

/// 응답 CSP. 앱의 CSP를 상속하지 않는 별도 문서라서 여기서 전부 정한다.
pub(crate) fn response_csp() -> &'static str {
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts"
}

/// 요청 경로("/토큰")에서 토큰을 뽑는다(영문·숫자만).
pub(crate) fn token_from_path(path: &str) -> Option<&str> {
    let t = path.trim_start_matches('/');
    if !t.is_empty() && t.len() <= 64 && t.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(t)
    } else {
        None
    }
}

/// ctmframe 요청 처리(lib.rs의 register_uri_scheme_protocol에서 부른다).
pub(crate) fn handle(path: &str) -> tauri::http::Response<Vec<u8>> {
    let build = |status: u16, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", "text/html; charset=utf-8")
            .header("Content-Security-Policy", response_csp())
            .header("X-Content-Type-Options", "nosniff")
            .header("Cache-Control", "no-store")
            .body(body)
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
    };
    match token_from_path(path).and_then(lookup) {
        Some(html) => build(200, html.into_bytes()),
        None => build(404, b"not found".to_vec()),
    }
}

/// 앱을 다시 시작한다 — 멈춘(무한 루프 등) JS 그래픽의 프레임 프로세스는 앱을 닫아야만 정리된다(시험으로 확인: 기다려도, 화면을 새로고침해도 복구되지 않는다).
#[tauri::command]
pub fn restart_app_command(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
pub fn register_panel_frame_command(html: String) -> Result<String, String> {
    let token = store(html)?;
    Ok(frame_url(&token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_parsed_strictly() {
        assert_eq!(token_from_path("/abc123"), Some("abc123"));
        assert_eq!(token_from_path("/"), None);
        assert_eq!(token_from_path("/a/b"), None);
        assert_eq!(token_from_path("/../etc"), None);
        assert_eq!(token_from_path("/ab%20c"), None);
        assert_eq!(token_from_path(&format!("/{}", "a".repeat(65))), None);
    }

    #[test]
    fn stored_frames_are_served_and_old_ones_dropped() {
        let first = store("<p>first</p>".into()).unwrap();
        assert_eq!(lookup(&first).as_deref(), Some("<p>first</p>"));
        let resp = handle(&format!("/{first}"));
        assert_eq!(resp.status(), 200);
        assert!(resp.headers().get("Content-Security-Policy").unwrap().to_str().unwrap().contains("connect-src 'none'"));
        assert_eq!(handle("/nope").status(), 404);
        for i in 0..(MAX_FRAMES + 2) {
            store(format!("<p>{i}</p>")).unwrap();
        }
        assert!(lookup(&first).is_none(), "오래된 문서는 버려져야 한다");
        assert!(store("x".repeat(MAX_FRAME_BYTES + 1)).is_err());
    }

    #[test]
    fn csp_blocks_network_forms_and_external_resources() {
        let csp = response_csp();
        for must in ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "img-src data:", "sandbox allow-scripts"] {
            assert!(csp.contains(must), "{must}");
        }
        assert!(!csp.contains("http") && !csp.contains("'self'") && !csp.contains("unsafe-eval"));
    }
}
