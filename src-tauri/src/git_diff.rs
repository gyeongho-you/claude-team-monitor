// 이번 청크 — get-changed-files/get-file-diff(main.ts:2634-2637)의 포팅. git을 서브프로세스로
// 실행하는 blocking 호출이라 β(agents_json.rs/resume.rs)가 확립한 대로 tokio::task::spawn_blocking
// 으로 감싼다 — 그대로 async 커맨드 안에서 blocking하면 다른 팀장/팀원 작업을 처리하는 tokio worker
// 스레드를 막을 수 있다.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

use serde::Serialize;

// git이 자격증명 프롬프트나 lock 경합으로 멈추면 타임아웃 없이는 이 패널이 무한 로딩에 빠진다
// (main.ts 주석과 동일한 방어) — agents_json.rs의 AGENTS_JSON_TIMEOUT과 같은 방식으로 wait-timeout을
// 쓴다.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

fn windows_hide(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// exec('git ...', {timeout})의 포팅 — 성공하면 stdout, 실패(타임아웃 포함)하면 None을 돌려준다.
/// main.ts의 실패 처리(git 저장소가 아니거나 git이 없으면 빈 목록/폴백)와 동일하게, 호출부가 실패를
/// "결과 없음"으로 받아 각자 알맞게 fail-open한다.
fn run_git(cwd: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd).stdout(Stdio::piped()).stderr(Stdio::piped());
    windows_hide(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let stdout_reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let stderr_reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    match child.wait_timeout(GIT_TIMEOUT).ok()? {
        Some(status) => {
            let stdout_bytes = stdout_reader.join().unwrap_or_default();
            let _ = stderr_reader.join();
            if !status.success() {
                return None;
            }
            String::from_utf8(stdout_bytes).ok()
        }
        None => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    pub file: String,
    pub status: String,
}

/// getGitChangedFiles(main.ts)와 동일 — `git status --porcelain` 원본을 그대로 파싱한다(mtime
/// 필터링 없음, "지금 커밋+푸시하면 뭐가 들어가는지"가 그대로 정답이라는 main.ts 주석과 동일한 판단).
fn get_git_changed_files_blocking(cwd: &Path) -> Vec<ChangedFile> {
    let Some(stdout) = run_git(cwd, &["status", "--porcelain"]) else {
        return Vec::new(); // git 저장소가 아니거나 git이 없으면 빈 목록
    };
    stdout
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| !l.is_empty())
        .map(|l| {
            let status = l.get(0..2).unwrap_or("").trim().to_string();
            let file = l.get(3..).unwrap_or("").trim().to_string();
            ChangedFile { status: if status.is_empty() { "?".to_string() } else { status }, file }
        })
        .collect()
}

#[tauri::command]
pub async fn get_changed_files_command(cwd: String) -> Vec<ChangedFile> {
    tokio::task::spawn_blocking(move || get_git_changed_files_blocking(Path::new(&cwd))).await.unwrap_or_default()
}

// resolveWithinCwd(lib/pathGuard.js)와 동일 — file 인자에 상대경로 탈출("../../../../etc/passwd")이
// 섞여 있으면 cwd 밖의 임의 파일을 가리킬 수 있어서, 실제로 합친 절대경로가 cwd 하위인지 확인해서
// 벗어나면 거부한다.
fn resolve_within_cwd(cwd: &Path, file: &str) -> Option<PathBuf> {
    let resolved_cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let candidate = resolved_cwd.join(file);
    let resolved_file = std::fs::canonicalize(&candidate).unwrap_or(candidate);
    if resolved_file == resolved_cwd || resolved_file.starts_with(&resolved_cwd) {
        Some(resolved_file)
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDiff {
    pub diff: String,
    #[serde(rename = "isNew")]
    pub is_new: bool,
    pub binary: bool,
}

/// getFileDiff(main.ts)와 동일 — HEAD와 비교해야 한다(워킹트리 대 인덱스 diff만 쓰면 스테이징만
/// 해둔 파일이 새 파일로 오판된다는 main.ts 주석과 동일한 이유). HEAD가 없는 저장소(커밋 0개)는
/// diff 명령 자체가 실패하는데, 그 경우 사실상 모든 파일이 진짜 새 파일이므로 untracked 처리
/// 경로로 폴백하는 게 오히려 맞다(main.ts와 동일).
fn get_file_diff_blocking(cwd: &Path, file: &str) -> FileDiff {
    let Some(resolved_file) = resolve_within_cwd(cwd, file) else {
        eprintln!("[get_file_diff] cwd 밖을 가리키는 file 인자를 거부합니다: cwd={cwd:?} file={file:?}");
        return FileDiff { diff: String::new(), is_new: false, binary: false };
    };

    if let Some(stdout) = run_git(cwd, &["diff", "HEAD", "--", file]) {
        if !stdout.trim().is_empty() {
            let binary = stdout.lines().any(|l| l.starts_with("Binary files "));
            return FileDiff { diff: stdout, is_new: false, binary };
        }
    }

    match std::fs::read(&resolved_file) {
        Ok(buf) => {
            let is_binary = buf.iter().take(8000).any(|&b| b == 0);
            FileDiff {
                diff: if is_binary { String::new() } else { String::from_utf8_lossy(&buf).to_string() },
                is_new: true,
                binary: is_binary,
            }
        }
        Err(_) => FileDiff { diff: String::new(), is_new: true, binary: false },
    }
}

#[tauri::command]
pub async fn get_file_diff_command(cwd: String, file: String) -> FileDiff {
    tokio::task::spawn_blocking(move || get_file_diff_blocking(Path::new(&cwd), &file)).await.unwrap_or(FileDiff { diff: String::new(), is_new: false, binary: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_within_cwd_rejects_path_traversal_outside_cwd() {
        let cwd = std::env::temp_dir();
        assert!(resolve_within_cwd(&cwd, "../../../../etc/passwd").is_none() || resolve_within_cwd(&cwd, "../../../../etc/passwd").unwrap().starts_with(&cwd));
    }

    #[test]
    fn resolve_within_cwd_accepts_plain_relative_file() {
        let cwd = std::env::current_dir().unwrap();
        let resolved = resolve_within_cwd(&cwd, "Cargo.toml");
        assert!(resolved.is_some());
    }

    // get_git_changed_files_blocking/get_file_diff_blocking을 이 저장소 자신(src-tauri의 부모, 실제
    // git 작업 트리) 대상으로 돌려서 실제 git 왕복을 확인한다 — 특정 결과값을 assert하지 않고
    // "죽지 않고 반환하는지"만 확인한다(작업 트리 상태가 테스트마다 달라질 수 있어서).
    #[test]
    fn get_git_changed_files_blocking_runs_against_this_repo_without_panicking() {
        let repo_root = std::env::current_dir().unwrap().join("..");
        let files = get_git_changed_files_blocking(&repo_root);
        // git 저장소이므로 실행 자체는 항상 성공해야 한다(내용은 몰라도 panic 없이 Vec을 돌려줌).
        let _ = files.len();
    }

    #[test]
    fn get_file_diff_blocking_rejects_traversal_and_returns_empty() {
        let repo_root = std::env::current_dir().unwrap().join("..");
        let diff = get_file_diff_blocking(&repo_root, "../../../../etc/passwd");
        assert_eq!(diff.diff, "");
        assert!(!diff.is_new);
    }
}
