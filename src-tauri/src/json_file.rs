use crate::timing::now_ms;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

// lib/jsonFile.js의 writeJsonFileAtomic과 동일 — 쓰는 도중 죽어도(정전, 강제 종료, 예외) 원본
// 파일이 잘린 채로 남지 않도록, 임시 파일에 먼저 쓰고 같은 폴더 안에서 rename으로 교체한다
// (rename은 원자적이다).
pub fn write_json_file_atomic<T: Serialize>(path: &Path, data: &T) -> std::io::Result<()> {
    // 직전에 이 파일을 읽지 못했다면(OneDrive·백신이 잠시 잡고 있는 등) 읽은 내용은 "빈 목록"으로 처리됐을 것이다 — 그 위에 쓰면 기존 데이터가 사라진다.
    // 그래서 그런 파일은 다음에 한 번이라도 정상적으로 읽힐 때까지 덮어쓰지 않는다(호출부는 저장 실패로 보고 로그를 남긴다).
    if unreadable().lock().unwrap_or_else(|e| e.into_inner()).contains(path) {
        return Err(std::io::Error::other(format!("{} 을(를) 읽지 못한 직후라 기존 내용을 지키려고 덮어쓰지 않았습니다(잠시 뒤 다시 시도됩니다)", path.display())));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp_name = format!("{file_name}.{}.{}.tmp", std::process::id(), now_ms());
    let tmp_path = path.with_file_name(tmp_name);
    let json = serde_json::to_string_pretty(data).map_err(std::io::Error::other)?;
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

fn unreadable() -> &'static Mutex<HashSet<PathBuf>> {
    static SET: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// "읽어서 고친 뒤 다시 쓰는" JSON 파일(팀장 기록, 대기 알림, 즐겨찾기, 템플릿 등)을 읽는 안전한 방법.
/// - 파일이 없으면 None(처음 쓰는 것이니 빈 목록이 맞다).
/// - 읽기가 실패하면(공유 위반 등) 짧게 몇 번 다시 시도하고, 그래도 안 되면 None을 돌려주되 그 파일을 "읽지 못함"으로 표시해
///   [`write_json_file_atomic`]이 덮어쓰지 않게 한다. 다음에 정상으로 읽히면 표시는 풀린다.
pub fn read_json_text_guarded(path: &Path) -> Option<String> {
    read_json_text_guarded_with(path, 4, std::time::Duration::from_millis(150))
}

pub(crate) fn read_json_text_guarded_with(path: &Path, attempts: u32, gap: std::time::Duration) -> Option<String> {
    for i in 0..attempts.max(1) {
        match std::fs::read(path) {
            Ok(bytes) => {
                unreadable().lock().unwrap_or_else(|e| e.into_inner()).remove(path);
                // 쓰는 도중 읽어 멀티바이트 문자가 잘린 경우에도 전체를 버리지 않는다(깨진 글자만 대체 문자로)
                return Some(String::from_utf8_lossy(&bytes).into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                unreadable().lock().unwrap_or_else(|e| e.into_inner()).remove(path);
                return None;
            }
            Err(_) if i + 1 < attempts.max(1) => std::thread::sleep(gap),
            Err(e) => {
                eprintln!("[json_file] {} 을(를) 읽지 못했습니다: {e} — 이 파일은 정상으로 읽힐 때까지 덮어쓰지 않습니다", path.display());
                unreadable().lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_path_buf());
                return None;
            }
        }
    }
    None
}

/// 파일 하나에 대한 프로세스 간 잠금 — `<파일>.lock`을 새로 만들어 쥐고, 닫히면(Drop) 지운다. 앱 본체와 `--mcp-server` 프로세스가 같은 leads.json을
/// 동시에 "읽고 고쳐 쓰기" 해서 서로의 변경을 덮어쓰는 것을 막는다. 오래된 잠금 파일(15초 넘음)은 무시하고 지우며, 5초 안에 못 얻으면 잠금 없이 진행한다 —
/// 잠금 때문에 앱이 영영 멈추는 것보다 드문 경합을 감수하는 쪽을 택한다(그때는 로그를 남긴다).
pub struct FileLock(Option<PathBuf>);

impl Drop for FileLock {
    fn drop(&mut self) {
        if let Some(p) = self.0.take() {
            let _ = std::fs::remove_file(p);
        }
    }
}

pub fn lock_file_for(path: &Path) -> FileLock {
    lock_file_for_with(path, std::time::Duration::from_secs(5), std::time::Duration::from_secs(15))
}

pub(crate) fn lock_file_for_with(path: &Path, wait: std::time::Duration, stale_after: std::time::Duration) -> FileLock {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".lock");
    let lock_path = path.with_file_name(name);
    let started = std::time::Instant::now();
    loop {
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&lock_path) {
            Ok(_) => return FileLock(Some(lock_path)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(&lock_path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map_or(false, |age| age > stale_after);
                if stale {
                    // 두 대기자가 같은 낡은 잠금을 동시에 지우고, 한쪽이 그 사이에 새로 만든 잠금까지 지우는 일을 막는다 —
                    // 고유한 이름으로 바꾸기(rename)에 성공한 한 쪽만 지운다(다른 쪽은 NotFound로 실패해 다시 시도).
                    let mut grave = lock_path.clone().into_os_string();
                    grave.push(format!(".stale-{}-{}", std::process::id(), started.elapsed().as_nanos()));
                    let grave = PathBuf::from(grave);
                    if std::fs::rename(&lock_path, &grave).is_ok() {
                        let _ = std::fs::remove_file(&grave);
                    }
                    continue;
                }
            }
            Err(_) => {}
        }
        if started.elapsed() >= wait {
            eprintln!("[json_file] {} 잠금을 얻지 못해 잠금 없이 진행합니다", lock_path.display());
            return FileLock(None);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// 내용은 있는데 파싱할 수 없는 파일은 빈 목록으로 취급해 그 위에 새로 쓰기 전에, 원본을 `<파일>.corrupt-<해시>`로 보관한다(같은 내용은 한 번만).
pub fn backup_corrupt_json(path: &Path, raw: &str) {
    if raw.trim().is_empty() {
        return;
    }
    let mut h: u64 = 0xcbf29ce484222325;
    for b in raw.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let name = format!("{}.corrupt-{:08x}", path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), h as u32);
    let dest = path.with_file_name(name);
    if !dest.exists() {
        let _ = std::fs::write(&dest, raw);
        crate::logging::log_critical(&format!("[json_file] {} 의 내용을 해석하지 못해 원본을 {} 로 보관했습니다(앱은 빈 목록으로 계속합니다)", path.display(), dest.display()));
    }
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    #[test]
    fn file_lock_excludes_second_holder_until_dropped_and_recovers_from_stale_lock() {
        let dir = std::env::temp_dir().join(format!("ctm_lock_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("leads.json");
        let g1 = lock_file_for_with(&target, std::time::Duration::from_secs(1), std::time::Duration::from_secs(60));
        assert!(g1.0.is_some());
        let started = std::time::Instant::now();
        let g2 = lock_file_for_with(&target, std::time::Duration::from_millis(200), std::time::Duration::from_secs(60));
        assert!(g2.0.is_none() && started.elapsed() >= std::time::Duration::from_millis(200), "이미 잠겨 있으면 기다린 뒤 잠금 없이 진행한다");
        drop(g2);
        assert!(dir.join("leads.json.lock").exists(), "잠금 없이 진행한 쪽이 남의 잠금 파일을 지우면 안 된다");
        drop(g1);
        assert!(!dir.join("leads.json.lock").exists());
        std::fs::write(dir.join("leads.json.lock"), b"").unwrap();
        let g3 = lock_file_for_with(&target, std::time::Duration::from_secs(1), std::time::Duration::from_millis(0));
        assert!(g3.0.is_some(), "오래된 잠금 파일은 넘겨받는다");
    }

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ctm-jsonguard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_missing_file_reads_as_none_and_can_be_created() {
        let d = tmpdir();
        let p = d.join("a.json");
        assert!(read_json_text_guarded(&p).is_none());
        write_json_file_atomic(&p, &vec![1, 2]).expect("없던 파일은 새로 만들 수 있다");
        assert!(read_json_text_guarded(&p).unwrap().contains('2'));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_file_that_could_not_be_read_is_not_overwritten_until_it_reads_again() {
        let d = tmpdir();
        let p = d.join("locked.json");
        std::fs::write(&p, "[1,2,3]").unwrap();
        // 파일 대신 같은 이름의 "폴더"를 두면 읽기가 NotFound가 아닌 오류로 실패한다(공유 위반과 같은 효과)
        std::fs::remove_file(&p).unwrap();
        std::fs::create_dir_all(&p).unwrap();
        assert!(read_json_text_guarded_with(&p, 2, std::time::Duration::from_millis(5)).is_none());
        let err = write_json_file_atomic(&p, &vec![9]).unwrap_err();
        assert!(err.to_string().contains("덮어쓰지 않았습니다"), "{err}");
        // 다시 정상 파일이 되고 한 번 읽히면 쓰기가 풀린다
        std::fs::remove_dir_all(&p).unwrap();
        std::fs::write(&p, "[1]").unwrap();
        assert!(read_json_text_guarded(&p).is_some());
        write_json_file_atomic(&p, &vec![5]).expect("정상으로 읽힌 뒤에는 쓸 수 있다");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_truncated_multibyte_file_is_still_read_with_replacement_characters() {
        let d = tmpdir();
        let p = d.join("cut.json");
        let mut bytes = "[\"가나다\"]".as_bytes().to_vec();
        bytes.truncate(bytes.len() - 3); // 마지막 글자 한가운데를 자른다
        std::fs::write(&p, &bytes).unwrap();
        assert!(read_json_text_guarded(&p).is_some(), "UTF-8이 잘려도 읽기 자체는 실패하지 않는다");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn corrupt_content_is_backed_up_once_per_distinct_content() {
        let d = tmpdir();
        let p = d.join("leads.json");
        backup_corrupt_json(&p, "{ 깨진 json");
        backup_corrupt_json(&p, "{ 깨진 json");
        backup_corrupt_json(&p, "   ");
        let backups: Vec<_> = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().contains(".corrupt-")).collect();
        assert_eq!(backups.len(), 1, "같은 내용은 한 번만, 빈 내용은 보관하지 않는다");
        assert_eq!(std::fs::read_to_string(backups[0].path()).unwrap(), "{ 깨진 json");
        let _ = std::fs::remove_dir_all(&d);
    }
}
