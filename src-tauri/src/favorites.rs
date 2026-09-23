// 이번 청크(남은 단순 CRUD IPC) — get-favorites/add-favorite/remove-favorite/update-favorite-name
// (main.ts:2474-2494)의 포팅. favorites.json은 "팀장 디렉토리" 즐겨찾기 목록으로, 여러 팀장/팀원
// 세션이 이 앱과 동시에 상호작용할 수 있는 환경에서 이 앱 자신의 여러 IPC 호출(add/remove/rename)이
// 겹치면 notice_queue.rs의 pendingNotices.json/session_registry.rs의 leads.json과 완전히 같은 클래스의
// lost update가 favorites.json에도 재발할 수 있다(load→mutate→save 사이클이 두 호출 사이에 겹치는
// 문제) — 그래서 그 두 파일과 정확히 같은 구조의 전용 전역 락(with_favorites_lock)을 새로 만든다.

use crate::json_file::write_json_file_atomic;
use crate::paths::favorites_path;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex as AsyncMutex;

// main.ts의 Favorite 타입과 동일 — "팀장 디렉토리" 등록 목록. favorites.json은 실제 데이터에
// {path,name} 객체 배열 외의 포맷이 존재한 적이 없어(main.ts 주석 참고) 정규화 로직 없이 그대로
// 읽는다.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Favorite {
    pub path: String,
    pub name: String,
}

fn load_favorites_from(path: &Path) -> Vec<Favorite> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    serde_json::from_str::<Vec<Favorite>>(&raw).unwrap_or_default()
}

/// loadFavorites(main.ts)와 동일 — 읽기 전용 호출부는 락 없이 이 함수를 직접 쓴다(다른 모듈의
/// load_leads()/load_pending_notices()와 같은 판단).
pub fn load_favorites() -> Vec<Favorite> {
    load_favorites_from(&favorites_path())
}

fn save_favorites_to(path: &Path, favorites: &[Favorite]) {
    if let Err(e) = write_json_file_atomic(path, &favorites) {
        eprintln!("[save_favorites] favorites.json 저장 실패: {e}");
    }
}

// ---------------------------------------------------------------------------------------------
// favorites.json 전용 전역 락 — with_leads_lock(session_registry.rs)/with_pending_notices_lock
// (notice_queue.rs)과 정확히 같은 이유·같은 구조. 이 앱의 IPC 호출은 렌더러 쪽에서 대부분 순차
// 실행되지만, 동시에 여러 창/디바이스에서 조작하거나 향후 자동화가 추가될 가능성을 열어두고, 무엇보다
// "파일 하나를 읽고-고치고-쓰는" 패턴 자체가 이 코드베이스에서 반복적으로 lost update를 냈던 전례를
// 그대로 따라가지 않기 위해 처음부터 락을 씌운다.
// ---------------------------------------------------------------------------------------------

fn favorites_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

pub(crate) async fn with_favorites_lock_at<F, R>(path: &Path, lock: &AsyncMutex<()>, mutate: F) -> R
where
    F: FnOnce(&mut Vec<Favorite>) -> (bool, R),
{
    let _guard = lock.lock().await;
    let mut favorites = load_favorites_from(path);
    let (dirty, result) = mutate(&mut favorites);
    if dirty {
        save_favorites_to(path, &favorites);
    }
    result
}

pub async fn with_favorites_lock<F, R>(mutate: F) -> R
where
    F: FnOnce(&mut Vec<Favorite>) -> (bool, R),
{
    with_favorites_lock_at(&favorites_path(), favorites_lock(), mutate).await
}

fn basename(dir: &str) -> String {
    PathBuf::from(dir).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.to_string())
}

#[tauri::command]
pub fn get_favorites_command() -> Vec<Favorite> {
    load_favorites()
}

/// addFavorite(main.ts)와 동일 — 이미 같은 path가 있으면 추가하지 않는다(중복 방지).
#[tauri::command]
pub async fn add_favorite_command(dir: String) -> Vec<Favorite> {
    with_favorites_lock(move |favorites| {
        if favorites.iter().any(|f| f.path == dir) {
            return (false, favorites.clone());
        }
        favorites.push(Favorite { name: basename(&dir), path: dir });
        (true, favorites.clone())
    })
    .await
}

#[tauri::command]
pub async fn remove_favorite_command(dir: String) -> Vec<Favorite> {
    with_favorites_lock(move |favorites| {
        let before = favorites.len();
        favorites.retain(|f| f.path != dir);
        let changed = favorites.len() != before;
        (changed, favorites.clone())
    })
    .await
}

/// updateFavoriteName(main.ts)와 동일 — 이름이 빈 문자열이면 basename으로 되돌린다.
#[tauri::command]
pub async fn update_favorite_name_command(dir: String, name: String) -> Vec<Favorite> {
    with_favorites_lock(move |favorites| {
        let Some(f) = favorites.iter_mut().find(|f| f.path == dir) else {
            return (false, favorites.clone());
        };
        f.name = if name.is_empty() { basename(&dir) } else { name.clone() };
        (true, favorites.clone())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn temp_favorites_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("claude_team_monitor_test_favorites_{tag}_{}.json", uuid::Uuid::new_v4()))
    }

    #[tokio::test]
    async fn add_favorite_round_trips_and_rejects_duplicate_path() {
        let path = temp_favorites_path("add");
        let lock = AsyncMutex::new(());
        save_favorites_to(&path, &[]);

        let after_first = with_favorites_lock_at(&path, &lock, |favs| {
            if favs.iter().any(|f| f.path == "C:\\proj\\a") {
                return (false, favs.clone());
            }
            favs.push(Favorite { path: "C:\\proj\\a".to_string(), name: "a".to_string() });
            (true, favs.clone())
        })
        .await;
        assert_eq!(after_first.len(), 1);

        // 같은 path를 다시 추가하면 dirty가 안 돼서 파일도 그대로여야 한다(main.ts의 중복 방지).
        let after_second = with_favorites_lock_at(&path, &lock, |favs| {
            if favs.iter().any(|f| f.path == "C:\\proj\\a") {
                return (false, favs.clone());
            }
            favs.push(Favorite { path: "C:\\proj\\a".to_string(), name: "a".to_string() });
            (true, favs.clone())
        })
        .await;
        assert_eq!(after_second.len(), 1, "이미 있는 path는 중복 추가되면 안 된다");

        let _ = std::fs::remove_file(&path);
    }

    // ------------------------------------------------------------------------------------
    // favorites.json 동시 쓰기 — session_registry.rs/notice_queue.rs의 leads.json/pendingNotices.json
    // 락 테스트와 정확히 같은 가상 시계 기반 결정적 패턴(§3-1과 같은 클래스의 lost update 검증).
    // ------------------------------------------------------------------------------------

    #[tokio::test(start_paused = true)]
    async fn favorites_lost_update_is_reproducible_without_the_lock() {
        let path = temp_favorites_path("unlocked");
        save_favorites_to(&path, &[]);

        let path_a = path.clone();
        let task_a = tokio::spawn(async move {
            let mut favs = load_favorites_from(&path_a);
            tokio::time::sleep(Duration::from_millis(30)).await;
            favs.push(Favorite { path: "C:\\a".to_string(), name: "a".to_string() });
            save_favorites_to(&path_a, &favs);
        });
        let path_b = path.clone();
        let task_b = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(5)).await;
            let mut favs = load_favorites_from(&path_b);
            favs.push(Favorite { path: "C:\\b".to_string(), name: "b".to_string() });
            save_favorites_to(&path_b, &favs);
        });
        let _ = tokio::join!(task_a, task_b);

        let final_favs = load_favorites_from(&path);
        let _ = std::fs::remove_file(&path);

        let has_a = final_favs.iter().any(|f| f.path == "C:\\a");
        let has_b = final_favs.iter().any(|f| f.path == "C:\\b");
        assert!(!(has_a && has_b), "락 없이 두 쓰기가 겹치면 lost update가 재현돼야 하는데 둘 다 반영됐다: {final_favs:?}");
        assert!(has_a, "나중에 쓰는 쪽(A, 가상 30ms)의 추가는 남아있어야 한다");
        assert!(!has_b, "먼저 읽고 나중에 덮어써지는 쪽(B)의 추가가 사라져야 한다(lost update)");
    }

    #[tokio::test(start_paused = true)]
    async fn with_favorites_lock_prevents_lost_update_under_concurrent_writes() {
        for (slow_a_ms, slow_b_ms) in [(30u64, 5u64), (5u64, 30u64)] {
            let path = temp_favorites_path("locked");
            let lock = AsyncMutex::new(());
            save_favorites_to(&path, &[]);

            let task_a = async {
                tokio::time::sleep(Duration::from_millis(slow_a_ms)).await;
                with_favorites_lock_at(&path, &lock, |favs| {
                    favs.push(Favorite { path: "C:\\a".to_string(), name: "a".to_string() });
                    (true, ())
                })
                .await;
            };
            let task_b = async {
                tokio::time::sleep(Duration::from_millis(slow_b_ms)).await;
                with_favorites_lock_at(&path, &lock, |favs| {
                    favs.push(Favorite { path: "C:\\b".to_string(), name: "b".to_string() });
                    (true, ())
                })
                .await;
            };
            tokio::join!(task_a, task_b);

            let final_favs = load_favorites_from(&path);
            let _ = std::fs::remove_file(&path);
            assert!(
                final_favs.iter().any(|f| f.path == "C:\\a"),
                "slow_a={slow_a_ms}ms/slow_b={slow_b_ms}ms 조합에서 C:\\a 추가가 사라지면 안 된다: {final_favs:?}"
            );
            assert!(
                final_favs.iter().any(|f| f.path == "C:\\b"),
                "slow_a={slow_a_ms}ms/slow_b={slow_b_ms}ms 조합에서 C:\\b 추가가 사라지면 안 된다: {final_favs:?}"
            );
        }
    }

    #[tokio::test]
    async fn update_favorite_name_falls_back_to_basename_when_empty() {
        let path = temp_favorites_path("rename");
        let lock = AsyncMutex::new(());
        save_favorites_to(&path, &[Favorite { path: "C:\\proj\\sub".to_string(), name: "custom".to_string() }]);

        let after = with_favorites_lock_at(&path, &lock, |favs| {
            let Some(f) = favs.iter_mut().find(|f| f.path == "C:\\proj\\sub") else { return (false, favs.clone()) };
            let name = "";
            f.name = if name.is_empty() { basename("C:\\proj\\sub") } else { name.to_string() };
            (true, favs.clone())
        })
        .await;
        assert_eq!(after[0].name, "sub");

        let _ = std::fs::remove_file(&path);
    }
}
