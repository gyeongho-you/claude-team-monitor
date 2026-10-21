// 채팅에 붙여넣은 이미지를 파일로 저장한다(src/lib/pastedImages.js와 같은 규칙).
//
// 팀장 세션은 이미지를 "파일 경로"로만 읽을 수 있어서(Read 도구), 클립보드 이미지를 실제 파일로 만들어 그 경로를
// 첨부로 넘긴다. 저장 위치는 OS 임시 폴더가 아니라 ~/.claude/claude-team-monitor/attachments/ 다 — 임시 폴더는
// Windows가 임의로 정리할 수 있어서 팀장이 나중에 다시 읽으려 할 때 파일이 없어질 수 있다. 대신 3일이 지난
// 붙여넣기 이미지는 저장할 때와 앱을 켤 때 자동으로 지운다(paste- 로 시작하는 우리가 만든 파일만).

use crate::paths::claude_home;
use base64::Engine;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const RETENTION: Duration = Duration::from_secs(3 * 24 * 3600);
const FILE_PREFIX: &str = "paste-";

pub fn attachments_dir() -> PathBuf {
    claude_home().join("claude-team-monitor").join("attachments")
}

fn extension_for_mime(mime: &str) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

/// 3일이 지난 붙여넣기 이미지를 지운다. 삭제한 개수를 돌려준다.
pub(crate) fn purge_old_in(dir: &Path, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with(FILE_PREFIX) {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map_or(false, |age| age > RETENTION);
        if old && std::fs::remove_file(e.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

pub(crate) fn save_pasted_image_in(dir: &Path, data_base64: &str, mime: &str) -> Result<PathBuf, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("이미지 데이터를 해석하지 못했습니다: {e}"))?;
    if bytes.is_empty() {
        return Err("이미지 데이터가 비어 있습니다.".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("이미지가 너무 큽니다(최대 20MB).".to_string());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("첨부 폴더를 만들지 못했습니다: {e}"))?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let rand = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let path = dir.join(format!("{FILE_PREFIX}{stamp}-{rand}.{}", extension_for_mime(mime)));
    std::fs::write(&path, bytes).map_err(|e| format!("이미지를 저장하지 못했습니다: {e}"))?;
    purge_old_in(dir, SystemTime::now());
    Ok(path)
}

/// 앱을 켤 때 한 번 — 3일 지난 붙여넣기 이미지 정리.
pub fn purge_old_attachments() {
    purge_old_in(&attachments_dir(), SystemTime::now());
}

#[tauri::command]
pub fn save_pasted_image_command(data: String, mime: String) -> Result<String, String> {
    save_pasted_image_in(&attachments_dir(), &data, &mime).map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("ctm_pasted_{tag}_{}", uuid::Uuid::new_v4()))
    }

    // 1x1 투명 PNG
    const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

    #[test]
    fn saves_decoded_bytes_with_mime_extension() {
        let dir = tmp("save");
        let p = save_pasted_image_in(&dir, PNG_1X1, "image/png").unwrap();
        assert!(p.starts_with(&dir));
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("paste-") && name.ends_with(".png"), "{name}");
        assert_eq!(&std::fs::read(&p).unwrap()[..4], &[0x89, b'P', b'N', b'G']);
        assert!(save_pasted_image_in(&dir, PNG_1X1, "image/jpeg").unwrap().to_string_lossy().ends_with(".jpg"));
    }

    #[test]
    fn rejects_garbage_and_empty_data() {
        let dir = tmp("bad");
        assert!(save_pasted_image_in(&dir, "!!!not base64!!!", "image/png").is_err());
        assert!(save_pasted_image_in(&dir, "", "image/png").is_err());
    }

    #[test]
    fn purge_removes_only_old_paste_files() {
        let dir = tmp("purge");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("paste-old.png"), b"x").unwrap();
        std::fs::write(dir.join("keep-me.txt"), b"x").unwrap();
        // 4일 뒤의 시각으로 보면 방금 만든 파일도 3일을 넘긴 것이 된다
        let future = SystemTime::now() + Duration::from_secs(4 * 24 * 3600);
        assert_eq!(purge_old_in(&dir, future), 1);
        assert!(!dir.join("paste-old.png").exists());
        assert!(dir.join("keep-me.txt").exists(), "우리가 만든 paste- 파일이 아니면 건드리지 않는다");
        // 방금 만든 파일은 지금 기준으로는 그대로 둔다
        std::fs::write(dir.join("paste-new.png"), b"x").unwrap();
        assert_eq!(purge_old_in(&dir, SystemTime::now()), 0);
    }
}
