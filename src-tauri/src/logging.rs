// main.ts의 logCritical과 동일 — 원인을 알 수 없이 겪는 실패("왜 메시지가 하나도 안 가지")로
// 이어지는 핵심 실패 지점만 골라 콘솔(eprintln!)과 별개로 app.log에도 남긴다. 모든 eprintln!을
// 다 이걸로 바꾸지 않는다(그러면 이 파일이 통상적인 디버그 로그가 돼서 정작 봐야 할 때 못 찾는다)
// — main.ts가 logCritical을 쓴 지점(resume/stop 크래시·포크 감지·sessionId 불일치 등)에서만 쓴다.

use crate::paths::app_log_path;
use std::io::Write;

pub fn log_critical(message: &str) {
    eprintln!("{message}");
    let line = format!("[{}] {message}\n", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"));
    let path = app_log_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[log_critical] app.log 디렉토리를 만들지 못했습니다: {e}");
            return;
        }
    }
    let result = std::fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut f| f.write_all(line.as_bytes()));
    // 로그 자체가 실패해도(디스크 문제 등) 앱 동작에는 지장이 없어야 한다 — main.ts의 try/catch와
    // 동일한 fail-open.
    if let Err(e) = result {
        eprintln!("[log_critical] app.log 기록 실패(무시): {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_timestamped_line_to_app_log() {
        let path = app_log_path();
        let before = std::fs::read_to_string(&path).unwrap_or_default();
        log_critical("[log_critical test] 유일한 마커 문자열 abc123");
        let after = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(after.len() > before.len(), "app.log가 새 줄만큼 늘어나야 한다");
        assert!(after.contains("abc123"));
        // "[2026-09-21T..." 형태의 ISO8601 타임스탬프 프리픽스가 붙어있어야 한다.
        let new_part = &after[before.len()..];
        assert!(new_part.starts_with('['), "타임스탬프 대괄호로 시작해야 한다: {new_part}");
        assert!(new_part.contains('T') && new_part.contains('Z'), "ISO8601 UTC 타임스탬프 형식이어야 한다: {new_part}");
    }
}
