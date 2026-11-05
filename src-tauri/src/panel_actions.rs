// 패널 HTML 그래픽(JavaScript 허용)이 앱에 요청할 수 있는 "파일 위치 보기"와 "편집기로 열기".
//
// 상태를 바꾸는 동작(커밋 등)은 일부러 넣지 않았다 — 여기 있는 것은 열어서 보는 동작뿐이다.
// 안전장치:
//  - 경로는 절대 경로여야 하고, 존재해야 하며, 선택한 팀장의 작업 폴더·허용한 팀원 폴더·그 저장소의 git 워크트리 폴더 **안**이어야 한다(심볼릭 링크는 실제 위치로 풀어서 검사).
//  - 파일을 "기본 프로그램으로 열기"는 하지 않는다 — .bat/.js/.exe 같은 파일은 열면 실행될 수 있기 때문이다. 탐색기(Finder)에서 위치를 보여 주거나, VS Code로만 연다.
//  - VS Code는 셸을 거치지 않고 실행 파일을 직접 실행한다(경로에 특수문자가 있어도 명령이 끼어들 수 없다).

use crate::session_registry::{load_leads, LeadRecord};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

/// Windows의 canonicalize가 붙이는 \\?\ 접두사를 떼어 탐색기·편집기에 넘길 수 있는 보통 경로로 만든다.
fn display_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
}

/// `git worktree list --porcelain` 출력에서 워크트리 폴더들을 뽑는다.
pub(crate) fn parse_worktree_roots(porcelain: &str) -> Vec<PathBuf> {
    porcelain.lines().filter_map(|l| l.strip_prefix("worktree ")).map(PathBuf::from).collect()
}

fn git_worktree_roots(dir: &Path) -> Vec<PathBuf> {
    let mut cmd = Command::new("git");
    cmd.args(["worktree", "list", "--porcelain"]).current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(mut child) = cmd.spawn() else { return Vec::new() };
    let Some(mut out) = child.stdout.take() else { return Vec::new() };
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut out, &mut s);
        s
    });
    match child.wait_timeout(Duration::from_secs(3)) {
        Ok(Some(_)) => parse_worktree_roots(&reader.join().unwrap_or_default()),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            Vec::new()
        }
    }
}

/// 열 수 있는 폴더들(정규화한 것).
pub(crate) fn allowed_roots(lead: &LeadRecord) -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from(&lead.target_dir)];
    roots.extend(lead.approved_members.iter().map(PathBuf::from));
    roots.extend(git_worktree_roots(Path::new(&lead.target_dir)));
    roots.into_iter().filter_map(|p| std::fs::canonicalize(p).ok()).collect()
}

/// 경로가 허용 폴더 안인지 확인하고 정규화한 경로를 돌려준다.
pub(crate) fn resolve_inside(path: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if path.trim().is_empty() || path.contains('\0') || path.chars().count() > 1024 {
        return Err("경로가 올바르지 않습니다.".to_string());
    }
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("절대 경로만 열 수 있습니다.".to_string());
    }
    let canon = std::fs::canonicalize(p).map_err(|_| "그 경로가 없습니다(이 작업 폴더에는 없는 파일일 수 있습니다).".to_string())?;
    if roots.iter().any(|r| canon.starts_with(r)) {
        Ok(canon)
    } else {
        Err("선택한 팀장의 작업 폴더·허용한 팀원 폴더·워크트리 밖의 경로는 열 수 없습니다.".to_string())
    }
}

fn lead_roots_and_path(path: &str, lead_id: Option<&str>) -> Result<PathBuf, String> {
    let leads = load_leads();
    let lead = crate::panel_script::lead_by_id(&leads, lead_id).ok_or_else(|| "팀장을 선택하지 않아 열 수 없습니다.".to_string())?;
    resolve_inside(path, &allowed_roots(&lead))
}

// ---- OS별 실행 명령: "무엇을 실행할지"를 정하는 부분(plan_*)은 순수 함수로 두어 어느 OS에서 빌드하든 컴파일되고, Windows·macOS·Linux 모두 시험으로 확인한다 ----

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Os {
    Windows,
    Mac,
    Linux,
}

pub(crate) fn current_os() -> Os {
    if cfg!(windows) {
        Os::Windows
    } else if cfg!(target_os = "macos") {
        Os::Mac
    } else {
        Os::Linux
    }
}

/// 실행할 프로그램과 인자. raw_arg는 Windows에서만 쓰는 "따옴표를 그대로 넘기는" 인자(탐색기의 /select,"경로" 형식 때문에 필요하다).
#[derive(Debug, PartialEq)]
pub(crate) struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub raw_arg: Option<String>,
}

/// 파일/폴더 위치 보기 명령. shown은 실행할 수 있는 보통 경로, parent는 그 파일의 폴더.
pub(crate) fn plan_reveal(os: Os, shown: &str, is_dir: bool, parent: &str) -> Launch {
    match os {
        Os::Windows if is_dir => Launch { program: "explorer.exe".into(), args: vec![shown.into()], raw_arg: None },
        Os::Windows => Launch { program: "explorer.exe".into(), args: vec![], raw_arg: Some(format!("/select,\"{shown}\"")) },
        Os::Mac if is_dir => Launch { program: "open".into(), args: vec![shown.into()], raw_arg: None },
        Os::Mac => Launch { program: "open".into(), args: vec!["-R".into(), shown.into()], raw_arg: None },
        Os::Linux => Launch { program: "xdg-open".into(), args: vec![if is_dir { shown } else { parent }.into()], raw_arg: None },
    }
}

/// VS Code 실행 파일이 있을 만한 자리들(env는 환경 변수를 읽는 함수 — 시험에서 바꿔 끼운다).
pub(crate) fn vscode_candidates(os: Os, env: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    match os {
        Os::Windows => {
            for (var, rel) in [("LOCALAPPDATA", r"Programs\Microsoft VS Code\Code.exe"), ("ProgramFiles", r"Microsoft VS Code\Code.exe"), ("ProgramFiles(x86)", r"Microsoft VS Code\Code.exe")] {
                if let Some(base) = env(var) {
                    v.push(PathBuf::from(format!("{base}\\{rel}")));
                }
            }
        }
        Os::Mac => {
            v.push(PathBuf::from("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"));
            if let Some(home) = env("HOME") {
                v.push(PathBuf::from(format!("{home}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")));
            }
        }
        Os::Linux => {
            if let Some(path) = env("PATH") {
                v.extend(path.split(':').filter(|d| !d.is_empty()).map(|d| PathBuf::from(format!("{d}/code"))));
            }
            v.push(PathBuf::from("/usr/bin/code"));
            v.push(PathBuf::from("/snap/bin/code"));
        }
    }
    v
}

/// VS Code로 여는 명령. 파일이면 `-g 경로:줄`, 폴더면 경로만. 경로는 호출 전에 절대 경로로 정규화돼 있어 `-`로 시작할 수 없다(인자 끼워 넣기 방지).
pub(crate) fn plan_editor(exe: &Path, shown: &str, is_file: bool, line: Option<u32>) -> Launch {
    let args = if is_file { vec!["-g".to_string(), format!("{shown}:{}", line.unwrap_or(1).max(1))] } else { vec![shown.to_string()] };
    Launch { program: exe.to_string_lossy().to_string(), args, raw_arg: None }
}

fn run_launch(plan: &Launch, quiet: bool) -> Result<(), String> {
    let mut cmd = Command::new(&plan.program);
    cmd.args(&plan.args);
    if quiet {
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if let Some(raw) = &plan.raw_arg {
            cmd.raw_arg(raw);
        }
        cmd.creation_flags(if quiet { 0x0800_0000 } else { 0 });
    }
    cmd.spawn().map(|_| ()).map_err(|e| format!("{}을(를) 실행하지 못했습니다: {e}", plan.program))
}

fn reveal(canon: &Path) -> Result<(), String> {
    let shown = display_path(canon);
    let parent = shown.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| shown.to_string_lossy().to_string());
    run_launch(&plan_reveal(current_os(), &shown.to_string_lossy(), canon.is_dir(), &parent), false)
}

fn vscode_executable() -> Option<PathBuf> {
    vscode_candidates(current_os(), &|k| std::env::var(k).ok()).into_iter().find(|p| p.is_file())
}

fn open_in_editor(canon: &Path, line: Option<u32>) -> Result<(), String> {
    let exe = vscode_executable().ok_or_else(|| "VS Code를 찾지 못했습니다. 설치돼 있지 않다면 '탐색기에서 보기'를 쓰세요.".to_string())?;
    run_launch(&plan_editor(&exe, &display_path(canon).to_string_lossy(), canon.is_file(), line), true)
}

#[tauri::command]
pub async fn reveal_panel_path_command(path: String, lead_id: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || reveal(&lead_roots_and_path(&path, lead_id.as_deref())?)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_panel_path_in_editor_command(path: String, line: Option<u32>, lead_id: Option<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || open_in_editor(&lead_roots_and_path(&path, lead_id.as_deref())?, line)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ctm_actions_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reveal_commands_are_right_for_every_os() {
        let w = plan_reveal(Os::Windows, r"C:\p\a b\f.md", false, r"C:\p\a b");
        assert_eq!((w.program.as_str(), w.args.is_empty(), w.raw_arg.as_deref()), ("explorer.exe", true, Some(r#"/select,"C:\p\a b\f.md""#)), "파일: 탐색기에서 선택");
        assert_eq!(plan_reveal(Os::Windows, r"C:\p", true, r"C:\"), Launch { program: "explorer.exe".into(), args: vec![r"C:\p".into()], raw_arg: None });
        assert_eq!(plan_reveal(Os::Mac, "/p/f.md", false, "/p"), Launch { program: "open".into(), args: vec!["-R".into(), "/p/f.md".into()], raw_arg: None });
        assert_eq!(plan_reveal(Os::Mac, "/p", true, "/"), Launch { program: "open".into(), args: vec!["/p".into()], raw_arg: None });
        assert_eq!(plan_reveal(Os::Linux, "/p/f.md", false, "/p"), Launch { program: "xdg-open".into(), args: vec!["/p".into()], raw_arg: None }, "리눅스는 파일 선택이 없어 그 폴더를 연다");
        assert_eq!(plan_reveal(Os::Linux, "/p", true, "/"), Launch { program: "xdg-open".into(), args: vec!["/p".into()], raw_arg: None });
    }

    #[test]
    fn editor_commands_never_go_through_a_shell_and_put_the_path_in_one_argument() {
        let exe = Path::new("/x/code");
        let f = plan_editor(exe, "/p/a b;rm -rf.md", true, Some(12));
        assert_eq!((f.program.as_str(), f.args.clone()), ("/x/code", vec!["-g".to_string(), "/p/a b;rm -rf.md:12".to_string()]), "경로는 인자 하나로만 간다");
        assert_eq!(plan_editor(exe, "/p/f.md", true, None).args[1], "/p/f.md:1");
        assert_eq!(plan_editor(exe, "/p/f.md", true, Some(0)).args[1], "/p/f.md:1", "0줄은 1줄로");
        assert_eq!(plan_editor(exe, "/p/dir", false, Some(5)).args, vec!["/p/dir".to_string()], "폴더는 줄 번호 없이");
        assert!(f.raw_arg.is_none(), "셸 해석을 거치는 raw 인자를 쓰지 않는다");
    }

    #[test]
    fn vscode_is_looked_up_in_the_usual_places_per_os() {
        let env = |k: &str| match k {
            "LOCALAPPDATA" => Some(r"C:\Users\u\AppData\Local".to_string()),
            "ProgramFiles" => Some(r"C:\Program Files".to_string()),
            "HOME" => Some("/home/u".to_string()),
            "PATH" => Some("/usr/local/bin::/home/u/bin".to_string()),
            _ => None,
        };
        let w: Vec<String> = vscode_candidates(Os::Windows, &env).iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert_eq!(w, vec![r"C:\Users\u\AppData\Local\Programs\Microsoft VS Code\Code.exe", r"C:\Program Files\Microsoft VS Code\Code.exe"]);
        let m: Vec<String> = vscode_candidates(Os::Mac, &env).iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert!(m[0].ends_with("Visual Studio Code.app/Contents/Resources/app/bin/code") && m[1].starts_with("/home/u/Applications"));
        let l: Vec<String> = vscode_candidates(Os::Linux, &env).iter().map(|p| p.to_string_lossy().to_string()).collect();
        assert_eq!(l[..2], ["/usr/local/bin/code".to_string(), "/home/u/bin/code".to_string()], "PATH의 빈 항목은 건너뛴다");
        assert!(l.contains(&"/usr/bin/code".to_string()) && l.contains(&"/snap/bin/code".to_string()));
    }

    #[test]
    fn worktree_roots_are_parsed_from_porcelain() {
        let text = "worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo-wt\nHEAD def\ndetached\n";
        assert_eq!(parse_worktree_roots(text), vec![PathBuf::from("C:/repo"), PathBuf::from("C:/repo-wt")]);
    }

    #[test]
    fn only_existing_absolute_paths_inside_allowed_roots_resolve() {
        let base = scratch();
        let inside = base.join("proj");
        let outside = base.join("other");
        std::fs::create_dir_all(inside.join("src")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(inside.join("src/a.txt"), "x").unwrap();
        std::fs::write(outside.join("secret.txt"), "x").unwrap();
        let roots = vec![std::fs::canonicalize(&inside).unwrap()];

        assert!(resolve_inside(inside.join("src/a.txt").to_str().unwrap(), &roots).is_ok());
        assert!(resolve_inside(inside.to_str().unwrap(), &roots).is_ok(), "폴더 자체도 열 수 있다");
        assert!(resolve_inside(outside.join("secret.txt").to_str().unwrap(), &roots).unwrap_err().contains("밖"));
        // 위로 거슬러 올라가는 경로(..)도 실제 위치로 풀어서 검사한다
        let sneaky = format!("{}/src/../../other/secret.txt", inside.to_string_lossy());
        assert!(resolve_inside(&sneaky, &roots).unwrap_err().contains("밖"), "{sneaky}");
        assert!(resolve_inside("relative/a.txt", &roots).unwrap_err().contains("절대"));
        assert!(resolve_inside(inside.join("nope.txt").to_str().unwrap(), &roots).unwrap_err().contains("없습니다"));
        assert!(resolve_inside("", &roots).is_err());
        assert!(resolve_inside("C:/a\0b", &roots).is_err());
        // 이름만 비슷한 형제 폴더(proj-evil)는 proj 안이 아니다
        let sibling = base.join("proj-evil");
        std::fs::create_dir_all(&sibling).unwrap();
        assert!(resolve_inside(sibling.to_str().unwrap(), &roots).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn allowed_roots_contain_lead_dir_and_approved_members() {
        let a = scratch();
        let b = scratch();
        let lead = LeadRecord {
            id: "L".into(),
            session_id: String::new(),
            target_dir: a.to_string_lossy().to_string(),
            launched_at: 0,
            approved_members: vec![b.to_string_lossy().to_string(), "Z:/not/existing".into()],
            label: None,
            ai_title: None,
            internal_id: None,
            auto_stall_nudge: None,
            secret: None,
            startup_warning: None,
        };
        let roots = allowed_roots(&lead);
        assert!(roots.contains(&std::fs::canonicalize(&a).unwrap()) && roots.contains(&std::fs::canonicalize(&b).unwrap()));
        assert_eq!(roots.len(), 2, "없는 폴더는 빠진다(git 저장소가 아니라 워크트리도 없다)");
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
