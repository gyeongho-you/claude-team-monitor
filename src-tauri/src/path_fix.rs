// macOS(와 리눅스)에서 Dock·Finder·Launchpad로 연 앱은 터미널의 PATH를 물려받지 않고 /usr/bin:/bin:/usr/sbin:/sbin 정도만 갖는다. 그러면 ~/.local/bin·Homebrew·nvm 등에
// 설치된 claude와 node를 못 찾아서, 앱이 'claude agents --json'을 실행하지 못하고(실패하면 빈 목록으로 넘어간다) 세션을 띄워도 앱에는 아무것도 안 보인다. 팀원 생성용 MCP
// 서버가 'node'로 실행되는 것도 같은 PATH를 쓴다. 그래서 시작할 때 (1) 사용자의 로그인 셸이 가진 PATH를 읽어 오고 (2) 흔한 설치 위치를 더해서 이 프로세스의 PATH를 보정한다
// (이 프로세스가 띄우는 모든 자식 프로세스가 물려받는다). 실패해도 앱은 그대로 동작한다. Windows는 PATH가 시스템 전체에 적용돼 있어 할 일이 없다.
// 주의: 이 파일은 Windows에서만 개발·시험했다 — 순수 함수(표식 해석, PATH 합치기)만 시험하고, 실제 로그인 셸 호출은 macOS에서 확인하지 못했다.

use std::collections::HashSet;

const START: &str = "__CTM_PATH_START__";
const END: &str = "__CTM_PATH_END__";

/// 셸 출력에서 표식 사이의 PATH를 뽑는다(셸이 시작 메시지 등을 같이 찍어도 안전하게).
pub(crate) fn extract_marked_path(output: &str) -> Option<String> {
    let s = output.find(START)? + START.len();
    let e = output[s..].find(END)? + s;
    let p = output[s..e].trim();
    if p.is_empty() {
        None
    } else {
        Some(p.to_string())
    }
}

/// 여러 PATH 문자열을 앞에서부터 순서대로 합친다(중복·빈 항목 제거).
pub(crate) fn merge_path_lists(lists: &[&str], sep: char) -> String {
    let mut seen = HashSet::new();
    let mut out: Vec<&str> = Vec::new();
    for list in lists {
        for p in list.split(sep) {
            if !p.is_empty() && seen.insert(p) {
                out.push(p);
            }
        }
    }
    out.join(&sep.to_string())
}

#[cfg(windows)]
pub fn fix_path_env() {}

// 시험 빌드에서는 Windows에서도 컴파일해서(맥 전용 코드의 문법 오류를 개발 PC에서 잡는다) 폴더 탐색 등을 시험한다.
#[cfg(any(not(windows), test))]
#[cfg_attr(test, allow(dead_code))]
mod unix {
    use super::*;
    use std::io::Read;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use wait_timeout::ChildExt;

    /// 로그인 셸이 가진 PATH. 시작 파일(.zprofile/.zshrc)에서 nvm 등이 PATH를 더하므로 -i -l로 읽고, 5초 안에 못 끝나면 -l만으로 다시 해 본다.
    fn login_shell_path() -> Option<String> {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".to_string());
        let script = format!("printf '%s' \"{START}$PATH{END}\"");
        for flags in ["-ilc", "-lc"] {
            let mut child = match Command::new(&shell).args([flags, &script]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
                Ok(c) => c,
                Err(_) => continue,
            };
            let mut stdout = child.stdout.take()?;
            let reader = std::thread::spawn(move || {
                let mut buf = String::new();
                let _ = stdout.read_to_string(&mut buf);
                buf
            });
            match child.wait_timeout(Duration::from_secs(5)) {
                Ok(Some(_)) => {
                    if let Some(p) = extract_marked_path(&reader.join().unwrap_or_default()) {
                        return Some(p);
                    }
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        None
    }

    /// 흔한 CLI 설치 위치 중 실제로 있는 폴더.
    pub(super) fn common_bin_dirs(home: &Path) -> Vec<String> {
        let mut dirs: Vec<std::path::PathBuf> = vec![
            home.join(".local/bin"),
            home.join(".claude/local"),
            home.join(".npm-global/bin"),
            home.join(".bun/bin"),
            home.join(".volta/bin"),
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
        ];
        // nvm: 설치된 node 버전 중 이름순 마지막(가장 새 버전)의 bin
        if let Ok(rd) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut vers: Vec<std::path::PathBuf> = rd.flatten().map(|e| e.path().join("bin")).filter(|p| p.is_dir()).collect();
            vers.sort();
            if let Some(last) = vers.pop() {
                dirs.push(last);
            }
        }
        dirs.into_iter().filter(|d| d.is_dir()).map(|d| d.to_string_lossy().to_string()).collect()
    }

    pub fn fix_path_env() {
        let existing = std::env::var("PATH").unwrap_or_default();
        let login = login_shell_path();
        let home = std::env::var("HOME").unwrap_or_default();
        let common = common_bin_dirs(Path::new(&home)).join(":");
        // 사용자의 로그인 PATH를 가장 앞에 둬서 그 사람이 쓰는 claude/node가 시스템 것보다 먼저 잡히게 한다.
        let merged = merge_path_lists(&[login.as_deref().unwrap_or(""), &existing, &common], ':');
        if merged != existing {
            std::env::set_var("PATH", &merged);
        }
        let claude = merged.split(':').map(|d| Path::new(d).join("claude")).find(|p| p.is_file());
        crate::logging::log_critical(&format!(
            "[path] PATH를 보정했습니다(로그인 셸 PATH: {}, claude 위치: {})",
            if login.is_some() { "읽음" } else { "못 읽음" },
            claude.map(|p| p.display().to_string()).unwrap_or_else(|| "못 찾음 — 앱이 세션을 보려면 claude가 PATH에 있어야 합니다".to_string())
        ));
    }
}

#[cfg(not(windows))]
pub use unix::fix_path_env;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marked_path_is_extracted_even_with_shell_noise() {
        assert_eq!(extract_marked_path("Last login: Mon\n__CTM_PATH_START__/a:/b__CTM_PATH_END__\n").as_deref(), Some("/a:/b"));
        assert_eq!(extract_marked_path("__CTM_PATH_START____CTM_PATH_END__"), None, "비어 있으면 없는 것");
        assert_eq!(extract_marked_path("표식 없음"), None);
        assert_eq!(extract_marked_path("__CTM_PATH_START__/a:/b"), None, "닫는 표식이 없으면 없는 것");
    }

    #[test]
    fn common_bin_dirs_lists_only_existing_folders_and_the_newest_nvm_node() {
        let home = std::env::temp_dir().join(format!("ctm_pathfix_{}", uuid::Uuid::new_v4()));
        for d in [".local/bin", ".nvm/versions/node/v18.1.0/bin", ".nvm/versions/node/v20.2.0/bin"] {
            std::fs::create_dir_all(home.join(d)).unwrap();
        }
        let dirs = unix::common_bin_dirs(&home);
        let has = |frag: &str| dirs.iter().any(|d| d.replace('\\', "/").contains(frag));
        assert!(has(".local/bin"), "있는 폴더는 포함");
        assert!(has("v20.2.0/bin") && !has("v18.1.0"), "nvm은 가장 새 버전만");
        assert!(!has(".bun/bin") && !has(".volta"), "없는 폴더는 제외");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn path_lists_merge_in_order_without_duplicates_or_empties() {
        assert_eq!(merge_path_lists(&["/u/bin:/usr/bin", "/usr/bin:/bin:", "", "/opt/x:/u/bin"], ':'), "/u/bin:/usr/bin:/bin:/opt/x");
        assert_eq!(merge_path_lists(&["", ""], ':'), "");
        assert_eq!(merge_path_lists(&["C:\\a;C:\\b", "C:\\b;C:\\c"], ';'), "C:\\a;C:\\b;C:\\c");
    }
}
