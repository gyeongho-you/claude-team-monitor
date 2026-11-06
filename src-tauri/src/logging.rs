// main.ts의 logCritical과 동일 — 원인을 알 수 없이 겪는 실패("왜 메시지가 하나도 안 가지")로
// 이어지는 핵심 실패 지점만 골라 콘솔(eprintln!)과 별개로 app.log에도 남긴다. 모든 eprintln!을
// 다 이걸로 바꾸지 않는다(그러면 이 파일이 통상적인 디버그 로그가 돼서 정작 봐야 할 때 못 찾는다)
// — main.ts가 logCritical을 쓴 지점(resume/stop 크래시·포크 감지·sessionId 불일치 등)에서만 쓴다.

use crate::paths::app_log_path;
use std::io::Write;
use std::path::Path;

/// app.log가 이 크기를 넘으면 app.log.1로 넘기고 새로 시작한다(이전 .1은 덮어쓴다 — 로그가 끝없이 커지지 않게, 최대 약 2배까지만 쓴다).
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

pub(crate) fn rotate_if_large(path: &Path, max_bytes: u64) {
    let too_big = std::fs::metadata(path).map(|m| m.len() > max_bytes).unwrap_or(false);
    if !too_big {
        return;
    }
    let mut rotated = path.as_os_str().to_owned();
    rotated.push(".1");
    let rotated = std::path::PathBuf::from(rotated);
    let _ = std::fs::remove_file(&rotated);
    // 옮기지 못해도(다른 프로세스가 잡고 있는 등) 로그 기록 자체는 계속한다
    let _ = std::fs::rename(path, &rotated);
}

pub fn log_critical(message: &str) {
    eprintln!("{message}");
    log_critical_to(&app_log_path(), message);
}

/// 경로를 받는 버전 — 시험이 사용자의 실제 app.log를 건드리지 않고 임시 파일에 쓰게 하려고 나눴다.
pub(crate) fn log_critical_to(path: &Path, message: &str) {
    let line = format!("[{}] {message}\n", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"));
    let path = path.to_path_buf();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[log_critical] app.log 디렉토리를 만들지 못했습니다: {e}");
            return;
        }
    }
    rotate_if_large(&path, MAX_LOG_BYTES);
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

    fn temp_log(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ctm_log_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn appends_timestamped_line_to_the_log_file() {
        // 사용자의 실제 app.log가 아니라 임시 파일에 쓴다
        let path = temp_log("app.log");
        log_critical_to(&path, "[log_critical test] 유일한 마커 문자열 abc123");
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("abc123"));
        // "[2026-09-21T..." 형태의 ISO8601 타임스탬프 프리픽스가 붙어있어야 한다.
        assert!(after.starts_with('['), "타임스탬프 대괄호로 시작해야 한다: {after}");
        assert!(after.contains('T') && after.contains('Z'), "ISO8601 UTC 타임스탬프 형식이어야 한다: {after}");
        log_critical_to(&path, "둘째 줄");
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 2, "이어서 쓴다");
    }

    #[test]
    fn a_large_log_is_rotated_to_dot_1_and_the_old_dot_1_is_replaced() {
        let path = temp_log("app.log");
        let rotated = std::path::PathBuf::from(format!("{}.1", path.display()));
        std::fs::write(&path, "A".repeat(100)).unwrap();
        rotate_if_large(&path, 1000); // 작으면 그대로
        assert!(path.exists() && !rotated.exists());
        rotate_if_large(&path, 50); // 크면 .1로
        assert!(!path.exists() && std::fs::read_to_string(&rotated).unwrap() == "A".repeat(100));
        std::fs::write(&path, "B".repeat(100)).unwrap();
        rotate_if_large(&path, 50); // 한 번 더 — 이전 .1을 덮어쓴다(.2, .3이 쌓이지 않는다)
        assert_eq!(std::fs::read_to_string(&rotated).unwrap(), "B".repeat(100));
        // 회전 뒤 기록은 새 파일로 이어진다
        log_critical_to(&path, "새 파일 첫 줄");
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 1);
        // 파일이 아예 없어도 조용히 지나간다
        rotate_if_large(&temp_log("none.log"), 10);
    }
}
