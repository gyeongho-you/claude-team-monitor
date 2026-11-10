//! `~/.claude`에 쌓이는 OAuth 갱신 잠금의 임시 파일(`.oauth_refresh.lock.owner.tmp.<8자리 16진수>`) 자동 정리.
//!
//! 이 파일은 claude CLI가 토큰 갱신 잠금의 소유자 기록을 "임시 파일에 쓰고 이름 바꾸기"로 저장할 때 만드는 중간 파일이다(만든 프로세스만 이름을 안다).
//! 이름 바꾸기 도중 프로세스가 끝나면 지워지지 않고 남는다 — 난수 이름이라 다음 시도가 덮어쓰지도 않아서 토큰 갱신 시각마다 쌓인다(조사 기록: CHANGELOG·docs 참고).
//! 앱이 만드는 파일이 아니므로 **아주 보수적으로** 지운다. 다음을 모두 만족하는 것만:
//!   1) 이름이 정확히 `.oauth_refresh.lock.owner.tmp.` + 소문자 16진수 8자리이고 일반 파일(폴더·링크 아님)
//!   2) 마지막 수정이 10분 넘음 — 정상적인 쓰기·이름 바꾸기는 밀리초 단위라 10분 넘게 남은 것은 쓰다 만 것이다
//!   3) 파일 안의 `pid`가 지금 살아 있는 프로세스가 아님(읽을 수 없는 내용이면 2)만 본다)
//!   4) 지금 살아 있는 프로세스 목록을 얻지 못하면 아무것도 지우지 않는다(확인 못 함을 "죽었음"으로 보지 않는다)
//! 진짜 잠금(`.oauth_refresh.lock`)과 소유자 기록(`.oauth_refresh.lock.owner`)은 이름이 달라 절대 대상이 아니다.

use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

const PREFIX: &str = ".oauth_refresh.lock.owner.tmp.";
pub(crate) const MIN_AGE: Duration = Duration::from_secs(10 * 60);

static TOTAL_REMOVED: AtomicU64 = AtomicU64::new(0);
static LAST_REMOVED_UNIX_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct CleanupReport {
    pub removed: u64,
    pub kept_young: u64,
    pub kept_owner_alive: u64,
    pub failed: u64,
}

/// 파일 이름이 정리 대상 형식인지(접두사 + 소문자 16진수 8자리).
pub(crate) fn is_target_name(name: &str) -> bool {
    match name.strip_prefix(PREFIX) {
        Some(rest) => rest.len() == 8 && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        None => false,
    }
}

fn owner_pid(path: &Path) -> Option<u32> {
    let raw = std::fs::read(path).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    v.get("pid")?.as_u64().and_then(|p| u32::try_from(p).ok())
}

/// 폴더 하나를 정리한다. `alive`는 지금 살아 있는 프로세스 번호 집합(None이면 확인 불가 → 아무것도 지우지 않음).
pub(crate) fn cleanup_in(dir: &Path, now: SystemTime, alive: Option<&HashSet<u32>>) -> CleanupReport {
    let mut report = CleanupReport::default();
    let Some(alive) = alive else { return report };
    let Ok(rd) = std::fs::read_dir(dir) else { return report };
    for entry in rd.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_target_name(&name) {
            continue;
        }
        // symlink_metadata: 링크를 따라가지 않는다 — 일반 파일만 대상
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else { continue };
        if !meta.is_file() {
            continue;
        }
        let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok());
        if !age.map_or(false, |a| a >= MIN_AGE) {
            report.kept_young += 1;
            continue;
        }
        if let Some(pid) = owner_pid(&entry.path()) {
            if alive.contains(&pid) {
                report.kept_owner_alive += 1;
                continue;
            }
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => report.removed += 1,
            Err(_) => report.failed += 1,
        }
    }
    report
}

/// 지금 살아 있는 프로세스 번호 전체(실패하면 None).
fn alive_pids() -> Option<HashSet<u32>> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("tasklist");
        cmd.args(["/FO", "CSV", "/NH"]).creation_flags(0x0800_0000).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let set: HashSet<u32> = text.lines().filter_map(|l| l.split("\",\"").nth(1)).filter_map(|p| p.trim_matches('"').parse::<u32>().ok()).collect();
        if set.is_empty() { None } else { Some(set) }
    }
    #[cfg(not(windows))]
    {
        let out = std::process::Command::new("ps").args(["-A", "-o", "pid="]).stderr(std::process::Stdio::null()).output().ok()?;
        if !out.status.success() {
            return None;
        }
        let set: HashSet<u32> = String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse::<u32>().ok()).collect();
        if set.is_empty() { None } else { Some(set) }
    }
}

/// 실제 `~/.claude`를 정리하고 결과를 로그·통계에 남긴다.
pub fn run_once() {
    let alive = alive_pids();
    let report = cleanup_in(&crate::paths::claude_home(), SystemTime::now(), alive.as_ref());
    if alive.is_none() {
        eprintln!("[oauth 임시 파일 정리] 살아 있는 프로세스 목록을 얻지 못해 이번에는 건너뜁니다.");
        return;
    }
    if report.removed > 0 || report.failed > 0 {
        TOTAL_REMOVED.fetch_add(report.removed, Ordering::Relaxed);
        if report.removed > 0 {
            LAST_REMOVED_UNIX_MS.store(crate::timing::now_ms().max(0) as u64, Ordering::Relaxed);
        }
        crate::logging::log_critical(&format!(
            "[oauth 임시 파일 정리] 10분 넘게 남은 claude OAuth 갱신 잠금 임시 파일 {}개를 지웠습니다(삭제 실패 {}개, 방금 만들어져 보존 {}개, 소유 프로세스가 살아 있어 보존 {}개).",
            report.removed, report.failed, report.kept_young, report.kept_owner_alive
        ));
    }
}

/// 앱을 켠 30초 뒤에 한 번, 이후 30분마다 정리하는 백그라운드 스레드를 띄운다.
pub fn spawn_background() {
    let _ = std::thread::Builder::new().name("oauth-tmp-cleanup".into()).spawn(|| {
        std::thread::sleep(Duration::from_secs(30));
        loop {
            run_once();
            std::thread::sleep(Duration::from_secs(30 * 60));
        }
    });
}

/// 진단 정보용 요약.
pub(crate) fn summary() -> String {
    let last = LAST_REMOVED_UNIX_MS.load(Ordering::Relaxed);
    let last_txt = if last == 0 {
        "없음".to_string()
    } else {
        chrono::DateTime::from_timestamp_millis(last as i64).map(|d| d.with_timezone(&chrono::Local).format("%m-%d %H:%M:%S").to_string()).unwrap_or_default()
    };
    format!("- OAuth 임시 파일 자동 정리(앱을 켠 뒤): {}개 삭제(마지막: {last_txt}) — 10분 넘게 남았고 소유 프로세스가 없는 것만", TOTAL_REMOVED.load(Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ctm_oauthclean_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn put(dir: &Path, name: &str, body: &str, age: Duration) {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_modified(SystemTime::now() - age).unwrap();
    }
    const REC: &str = r#"{"pid":4242,"procStart":"1","pidDomain":"win32:pc","pidSpace":"PC","lockBirthtimeMs":1.0}"#;

    #[test]
    fn only_exact_names_are_targets() {
        assert!(is_target_name(".oauth_refresh.lock.owner.tmp.0075b450"));
        for n in [".oauth_refresh.lock.owner", ".oauth_refresh.lock", ".oauth_refresh.lock.owner.tmp.", ".oauth_refresh.lock.owner.tmp.0075B450", ".oauth_refresh.lock.owner.tmp.0075b45", ".oauth_refresh.lock.owner.tmp.0075b4500", "x.oauth_refresh.lock.owner.tmp.0075b450", "other.tmp.0075b450", ".oauth_refresh.lock.owner.tmp.0075b45g"] {
            assert!(!is_target_name(n), "{n}");
        }
    }

    #[test]
    fn deletes_only_old_files_whose_owner_is_gone_and_never_touches_real_lock_files() {
        let d = tmpdir();
        let old = Duration::from_secs(3600);
        put(&d, ".oauth_refresh.lock.owner.tmp.aaaaaaaa", REC, old); // 오래됨 + 소유자 없음 → 삭제
        put(&d, ".oauth_refresh.lock.owner.tmp.bbbbbbbb", "", old); // 쓰다 만(빈) 파일 → 삭제
        put(&d, ".oauth_refresh.lock.owner.tmp.cccccccc", REC, Duration::from_secs(30)); // 방금 만들어짐 → 보존
        put(&d, ".oauth_refresh.lock.owner.tmp.dddddddd", REC.replace("4242", "999").as_str(), old); // 소유 프로세스가 살아 있음 → 보존
        put(&d, ".oauth_refresh.lock.owner", REC, old); // 진짜 소유자 기록 → 절대 보존
        put(&d, ".oauth_refresh.lock", "x", old); // 진짜 잠금 → 절대 보존
        put(&d, "settings.json", "{}", old);
        std::fs::create_dir(d.join(".oauth_refresh.lock.owner.tmp.eeeeeeee")).unwrap(); // 이름만 같은 폴더 → 보존
        let alive: HashSet<u32> = [999u32].into_iter().collect();
        let r = cleanup_in(&d, SystemTime::now(), Some(&alive));
        assert_eq!(r, CleanupReport { removed: 2, kept_young: 1, kept_owner_alive: 1, failed: 0 });
        let left: HashSet<String> = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(left.contains(".oauth_refresh.lock.owner") && left.contains(".oauth_refresh.lock") && left.contains("settings.json"));
        assert!(left.contains(".oauth_refresh.lock.owner.tmp.cccccccc") && left.contains(".oauth_refresh.lock.owner.tmp.dddddddd") && left.contains(".oauth_refresh.lock.owner.tmp.eeeeeeee"));
        assert!(!left.contains(".oauth_refresh.lock.owner.tmp.aaaaaaaa") && !left.contains(".oauth_refresh.lock.owner.tmp.bbbbbbbb"));
    }

    #[test]
    fn deletes_nothing_when_the_process_list_is_unavailable() {
        let d = tmpdir();
        put(&d, ".oauth_refresh.lock.owner.tmp.aaaaaaaa", REC, Duration::from_secs(3600));
        let r = cleanup_in(&d, SystemTime::now(), None);
        assert_eq!(r, CleanupReport::default());
        assert!(d.join(".oauth_refresh.lock.owner.tmp.aaaaaaaa").exists(), "확인하지 못했으면 지우지 않는다");
    }

    #[test]
    fn a_missing_folder_is_not_an_error() {
        let alive: HashSet<u32> = HashSet::new();
        assert_eq!(cleanup_in(&std::env::temp_dir().join("ctm_없는폴더_xyz"), SystemTime::now(), Some(&alive)), CleanupReport::default());
    }

    #[test]
    fn real_process_list_contains_this_process() {
        let alive = alive_pids().expect("프로세스 목록을 읽을 수 있어야 한다");
        assert!(alive.contains(&std::process::id()), "자기 자신이 목록에 있어야 한다");
    }
}
