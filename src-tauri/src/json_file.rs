use crate::timing::now_ms;
use serde::Serialize;
use std::path::Path;

// lib/jsonFile.js의 writeJsonFileAtomic과 동일 — 쓰는 도중 죽어도(정전, 강제 종료, 예외) 원본
// 파일이 잘린 채로 남지 않도록, 임시 파일에 먼저 쓰고 같은 폴더 안에서 rename으로 교체한다
// (rename은 원자적이다).
pub fn write_json_file_atomic<T: Serialize>(path: &Path, data: &T) -> std::io::Result<()> {
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
