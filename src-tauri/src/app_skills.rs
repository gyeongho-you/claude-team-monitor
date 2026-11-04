// 앱 설정에서 등록하는 "공통 스킬" — 모든 팀장이 쓴다.
//
// 등록한 스킬은 (1) ~/.claude/skills/<이름>/SKILL.md에 설치돼서(앱이 만든 폴더에는 .ctm-managed 표식 파일을 둔다) claude의 Skill 도구로 바로 쓸 수 있고,
// (2) 팀장에게 "이런 스킬이 있다"고 안내된다 — 새로 띄우는 팀장은 첫 지시문에, 이미 있는 팀장은 알림으로(떠 있으면 바로, 히스토리 팀장은 다시 이어질 때,
// 팀원 템플릿 변경 알림과 같은 방식). 안내문에 SKILL.md의 전체 경로를 같이 적어서, 시크릿 모드처럼 사용자 스킬 폴더를 안 읽는 팀장도 파일을 직접 읽어 쓸 수 있다.
// 사용자가 직접 만든 같은 이름의 스킬 폴더는 덮어쓰지도 지우지도 않는다(표식 파일이 있는 폴더만 앱이 관리한다).

use crate::json_file::write_json_file_atomic;
use crate::paths::{app_skills_path, claude_home};
use crate::session_registry::{load_leads, LeadRecord};
use crate::timing::now_ms;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tokio::sync::Mutex as AsyncMutex;

pub(crate) const SKILLS_NOTICE_MARKER: &str = "[알림:사용자 스킬]";
const MANAGED_MARKER_FILE: &str = ".ctm-managed";
const MAX_CONTENT_CHARS: usize = 60_000;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppSkill {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub content: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(rename = "createdAt", default)]
    pub created_at: i64,
}

// ---------------------------------------------------------------------------------------------
// 순수 함수
// ---------------------------------------------------------------------------------------------

/// claude 스킬 이름 규칙: 영문 소문자·숫자·하이픈, 숫자/영문으로 시작, 48자 이하.
pub(crate) fn valid_skill_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty() && b.len() <= 48 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
        v[1..v.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        v.to_string()
    }
}

/// "---\nname: x\ndescription: y\n---\n본문" 형태면 (name, description, 본문)으로 나눈다. 앞머리(frontmatter)가 없으면 (None, None, 전체).
pub(crate) fn split_frontmatter(text: &str) -> (Option<String>, Option<String>, String) {
    let t = text.replace("\r\n", "\n");
    let Some(rest) = t.strip_prefix("---\n") else { return (None, None, t.trim().to_string()) };
    let Some(end) = rest.find("\n---") else { return (None, None, t.trim().to_string()) };
    let (head, tail) = (&rest[..end], &rest[end + 4..]);
    let (mut name, mut desc) = (None, None);
    for line in head.lines() {
        if let Some(v) = line.strip_prefix("name:") {
            name = Some(unquote(v)).filter(|s| !s.is_empty());
        } else if let Some(v) = line.strip_prefix("description:") {
            desc = Some(unquote(v)).filter(|s| !s.is_empty());
        }
    }
    (name, desc, tail.trim_start_matches('\n').trim().to_string())
}

fn render_skill_md(skill: &AppSkill) -> String {
    let desc = skill.description.replace(['\r', '\n'], " ").replace('\\', "\\\\").replace('"', "\\\"");
    format!("---\nname: {}\ndescription: \"{}\"\n---\n\n{}\n", skill.name, desc, skill.content.trim())
}

fn skill_dir(root: &Path, name: &str) -> PathBuf {
    root.join(name)
}

fn skill_file(root: &Path, name: &str) -> PathBuf {
    skill_dir(root, name).join("SKILL.md")
}

/// 팀장에게 줄 안내문(켜져 있는 스킬만). 스킬이 없으면 빈 문자열.
pub(crate) fn build_skills_briefing(skills: &[AppSkill], root: &Path) -> String {
    let lines: Vec<String> = skills
        .iter()
        .filter(|s| s.enabled)
        .map(|s| {
            let desc = if s.description.trim().is_empty() { String::new() } else { format!(" — {}", s.description.trim().replace('\n', " ")) };
            format!("- {}{desc} (파일: {})", s.name, skill_file(root, &s.name).display())
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!("사용자가 이 앱에 등록한 공통 스킬(작업이 설명에 해당하면 그 스킬을 Skill 도구로 먼저 호출해 그대로 따라라 — 호출이 안 되면 파일을 직접 읽어라):\n{}", lines.join("\n"))
}

/// 스킬 안내가 달라졌을 때 알림을 보낼 팀장과 문구를 계산한다(순수 함수).
pub(crate) fn plan_skills_notice(old_text: &str, new_text: &str, leads: &[LeadRecord]) -> Vec<(String, String)> {
    if old_text == new_text {
        return Vec::new();
    }
    let body = if new_text.is_empty() { "등록된 스킬이 없습니다.".to_string() } else { new_text.to_string() };
    let message = format!("{SKILLS_NOTICE_MARKER} 사용자가 등록한 스킬 목록이 바뀌었습니다. 지금 등록된 스킬은 아래와 같습니다(이전에 받은 안내를 대체합니다):\n\n{body}");
    leads.iter().filter_map(|l| l.internal_id.clone()).map(|id| (id, message.clone())).collect()
}

// ---------------------------------------------------------------------------------------------
// 설치 폴더 동기화(~/.claude/skills)
// ---------------------------------------------------------------------------------------------

fn is_managed_dir(root: &Path, name: &str) -> bool {
    skill_dir(root, name).join(MANAGED_MARKER_FILE).exists()
}

/// 앱이 만든 폴더가 아닌 같은 이름의 스킬이 이미 있으면 true.
fn foreign_skill_exists(root: &Path, name: &str) -> bool {
    skill_dir(root, name).exists() && !is_managed_dir(root, name)
}

fn install_skill(root: &Path, skill: &AppSkill) -> Result<(), String> {
    if foreign_skill_exists(root, &skill.name) {
        return Err(format!("\"{}\" 이름의 스킬이 이미 ~/.claude/skills에 있습니다(앱이 만든 것이 아니라 덮어쓰지 않습니다). 다른 이름을 쓰세요.", skill.name));
    }
    let dir = skill_dir(root, &skill.name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("스킬 폴더를 만들지 못했습니다: {e}"))?;
    std::fs::write(skill_file(root, &skill.name), render_skill_md(skill)).map_err(|e| format!("SKILL.md를 쓰지 못했습니다: {e}"))?;
    std::fs::write(dir.join(MANAGED_MARKER_FILE), "claude-team-monitor가 설치한 스킬입니다. 앱 설정에서 지우면 이 폴더도 지워집니다.\n").map_err(|e| format!("표식 파일을 쓰지 못했습니다: {e}"))?;
    Ok(())
}

fn uninstall_skill(root: &Path, name: &str) {
    if is_managed_dir(root, name) {
        let _ = std::fs::remove_dir_all(skill_dir(root, name));
    }
}

/// 등록 목록(old → new)에 맞춰 설치 폴더를 맞춘다: 켜진 것은 설치, 꺼졌거나 지워진 것은 앱이 만든 폴더만 지운다.
pub(crate) fn sync_installed(root: &Path, old: &[AppSkill], new: &[AppSkill]) -> Result<(), String> {
    for o in old {
        if !new.iter().any(|n| n.name == o.name) {
            uninstall_skill(root, &o.name);
        }
    }
    for n in new {
        if n.enabled {
            install_skill(root, n)?;
        } else {
            uninstall_skill(root, &n.name);
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// 저장소(appSkills.json) + 락
// ---------------------------------------------------------------------------------------------

fn load_skills_from(path: &Path) -> Vec<AppSkill> {
    std::fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

pub fn load_app_skills() -> Vec<AppSkill> {
    load_skills_from(&app_skills_path())
}

fn skills_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

fn install_root() -> PathBuf {
    claude_home().join("skills")
}

/// 새 팀장/재시작 팀장의 첫 지시문 뒤에 붙일 안내(없으면 빈 문자열, 있으면 앞에 빈 줄 포함).
pub fn prompt_section() -> String {
    let text = build_skills_briefing(&load_app_skills(), &install_root());
    if text.is_empty() {
        String::new()
    } else {
        format!("\n\n{text}")
    }
}

async fn notify_leads(old: &[AppSkill], new: &[AppSkill]) {
    let root = install_root();
    let plans = plan_skills_notice(&build_skills_briefing(old, &root), &build_skills_briefing(new, &root), &load_leads());
    for (internal_id, message) in plans {
        crate::notice_queue::queue_replacing_notice(&internal_id, SKILLS_NOTICE_MARKER, &message, crate::notice_queue::NoticeOrigin::System).await;
    }
}

/// 목록을 바꾸고(mutate), 설치 폴더를 맞추고, 저장한다 → (바꾸기 전, 바꾼 후). mutate나 설치가 실패하면 아무것도 저장하지 않는다(경로를 받아서 임시 폴더로 시험할 수 있다).
fn commit_core<F>(path: &Path, root: &Path, mutate: F) -> Result<(Vec<AppSkill>, Vec<AppSkill>), String>
where
    F: FnOnce(&mut Vec<AppSkill>) -> Result<(), String>,
{
    let old = load_skills_from(path);
    let mut new = old.clone();
    mutate(&mut new)?;
    sync_installed(root, &old, &new)?;
    write_json_file_atomic(path, &new).map_err(|e| format!("스킬 목록을 저장하지 못했습니다: {e}"))?;
    Ok((old, new))
}

/// commit_core 뒤에 팀장에게 알린다.
async fn commit<F>(mutate: F) -> Result<Vec<AppSkill>, String>
where
    F: FnOnce(&mut Vec<AppSkill>) -> Result<(), String>,
{
    let guard = skills_lock().lock().await;
    let (old, new) = commit_core(&app_skills_path(), &install_root(), mutate)?;
    drop(guard);
    notify_leads(&old, &new).await;
    Ok(new)
}

fn clean_fields(name: &str, description: &str, content: &str) -> Result<(String, String, String), String> {
    // SKILL.md 전체를 붙여넣었으면(앞머리 포함) 그 안의 이름·설명을 비어 있는 칸에 채운다.
    let (fm_name, fm_desc, body) = split_frontmatter(content);
    let name = if name.trim().is_empty() { fm_name.unwrap_or_default() } else { name.trim().to_string() };
    let description = if description.trim().is_empty() { fm_desc.unwrap_or_default() } else { description.trim().to_string() };
    if !valid_skill_name(&name) {
        return Err("스킬 이름은 영문 소문자·숫자·하이픈(-)만 쓸 수 있고 48자 이하여야 합니다(예: release-notes).".to_string());
    }
    if body.trim().is_empty() {
        return Err("스킬 내용을 입력하세요.".to_string());
    }
    if body.chars().count() > MAX_CONTENT_CHARS {
        return Err(format!("스킬 내용이 너무 깁니다({MAX_CONTENT_CHARS}자 이하)."));
    }
    Ok((name, description, body))
}

// ---------------------------------------------------------------------------------------------
// Tauri 커맨드
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub fn get_app_skills_command() -> Vec<AppSkill> {
    load_app_skills()
}

#[tauri::command]
pub async fn add_app_skill_command(name: String, description: String, content: String) -> Result<Vec<AppSkill>, String> {
    let (name, description, body) = clean_fields(&name, &description, &content)?;
    commit(move |skills| {
        if skills.iter().any(|s| s.name == name) {
            return Err(format!("\"{name}\" 스킬이 이미 등록돼 있습니다."));
        }
        skills.push(AppSkill { id: format!("skill-{}", now_ms()), name, description, content: body, enabled: true, created_at: now_ms() });
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn update_app_skill_command(id: String, description: String, content: String) -> Result<Vec<AppSkill>, String> {
    commit(move |skills| {
        let Some(s) = skills.iter_mut().find(|s| s.id == id) else { return Err("그 스킬을 찾지 못했습니다.".to_string()) };
        let (_, description, body) = clean_fields(&s.name.clone(), &description, &content)?;
        s.description = description;
        s.content = body;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn toggle_app_skill_command(id: String) -> Result<Vec<AppSkill>, String> {
    commit(move |skills| {
        let Some(s) = skills.iter_mut().find(|s| s.id == id) else { return Err("그 스킬을 찾지 못했습니다.".to_string()) };
        s.enabled = !s.enabled;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_app_skill_command(id: String) -> Result<Vec<AppSkill>, String> {
    commit(move |skills| {
        skills.retain(|s| s.id != id);
        Ok(())
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
pub struct UserSkillInfo {
    pub name: String,
    pub description: String,
}

/// ~/.claude/skills에 이미 있는(앱이 만든 것이 아닌) 스킬 목록 — "기존 스킬에서 불러오기"용.
#[tauri::command]
pub fn list_user_skills_command() -> Vec<UserSkillInfo> {
    let root = install_root();
    let mut out: Vec<UserSkillInfo> = std::fs::read_dir(&root)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().join("SKILL.md").exists() && !e.path().join(MANAGED_MARKER_FILE).exists())
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    let (_, desc, _) = split_frontmatter(&std::fs::read_to_string(e.path().join("SKILL.md")).unwrap_or_default());
                    Some(UserSkillInfo { name, description: desc.unwrap_or_default() })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct UserSkillContent {
    pub name: String,
    pub description: String,
    pub content: String,
}

/// 기존 스킬 하나의 이름·설명·본문을 읽는다(폼 채우기용 — 읽기만 하고 원본은 건드리지 않는다).
#[tauri::command]
pub fn read_user_skill_command(name: String) -> Option<UserSkillContent> {
    if name.is_empty() || name.contains(['/', '\\']) || name.contains("..") {
        return None;
    }
    let raw = std::fs::read_to_string(skill_file(&install_root(), &name)).ok()?;
    let (_, desc, body) = split_frontmatter(&raw);
    Some(UserSkillContent { name, description: desc.unwrap_or_default(), content: body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ctm_skills_{tag}_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn skill(name: &str, enabled: bool) -> AppSkill {
        AppSkill { id: format!("id-{name}"), name: name.into(), description: "설명: 한 줄 \"인용\"".into(), content: "# 본문\n단계 1".into(), enabled, created_at: 1 }
    }

    fn lead(internal: Option<&str>) -> LeadRecord {
        LeadRecord {
            id: "aaaa1111".into(),
            session_id: String::new(),
            target_dir: "C:/a".into(),
            launched_at: 0,
            approved_members: vec![],
            label: None,
            ai_title: None,
            internal_id: internal.map(str::to_string),
            auto_stall_nudge: None,
            secret: None,
            startup_warning: None,
        }
    }

    #[test]
    fn skill_names_follow_claude_rules() {
        for ok in ["release", "release-notes", "a1", "0abc"] {
            assert!(valid_skill_name(ok), "{ok}");
        }
        for bad in ["", "Release", "-x", "a b", "한글", "a/b", "..", &"a".repeat(49)] {
            assert!(!valid_skill_name(bad), "{bad}");
        }
    }

    #[test]
    fn frontmatter_is_split_and_quotes_are_removed() {
        let (n, d, body) = split_frontmatter("---\nname: my-skill\ndescription: \"쓰는 때: 릴리스\"\n---\n\n# 제목\n내용\n");
        assert_eq!((n.as_deref(), d.as_deref()), (Some("my-skill"), Some("쓰는 때: 릴리스")));
        assert_eq!(body, "# 제목\n내용");
        let (n2, d2, body2) = split_frontmatter("그냥 본문\n둘째 줄");
        assert!(n2.is_none() && d2.is_none());
        assert_eq!(body2, "그냥 본문\n둘째 줄");
        // 닫는 줄이 없으면 앞머리로 보지 않는다
        assert!(split_frontmatter("---\nname: x\n본문").0.is_none());
    }

    #[test]
    fn rendered_skill_md_round_trips_through_the_parser() {
        let s = skill("round", true);
        let (n, d, body) = split_frontmatter(&render_skill_md(&s));
        assert_eq!(n.as_deref(), Some("round"));
        assert_eq!(d.as_deref(), Some(s.description.as_str()));
        assert_eq!(body, s.content);
    }

    #[test]
    fn clean_fields_fills_blanks_from_a_pasted_skill_md_and_validates() {
        let pasted = "---\nname: from-front\ndescription: 앞머리 설명\n---\n본문";
        assert_eq!(clean_fields("", "", pasted).unwrap(), ("from-front".to_string(), "앞머리 설명".to_string(), "본문".to_string()));
        assert_eq!(clean_fields("mine", "내 설명", pasted).unwrap().0, "mine", "직접 입력한 값이 우선");
        assert!(clean_fields("Bad Name", "", "본문").is_err());
        assert!(clean_fields("ok", "", "   ").is_err());
    }

    #[test]
    fn briefing_lists_only_enabled_skills_with_paths() {
        let root = tmp("brief");
        assert_eq!(build_skills_briefing(&[], &root), "");
        assert_eq!(build_skills_briefing(&[skill("off", false)], &root), "");
        let text = build_skills_briefing(&[skill("on", true), skill("off", false)], &root);
        assert!(text.contains("- on — 설명: 한 줄") && text.contains("SKILL.md") && !text.contains("off"));
    }

    #[test]
    fn install_creates_files_and_never_overwrites_a_users_own_skill() {
        let root = tmp("install");
        let s = skill("mine", true);
        sync_installed(&root, &[], &[s.clone()]).unwrap();
        assert!(skill_file(&root, "mine").exists() && is_managed_dir(&root, "mine"));
        // 사용자가 직접 만든 같은 이름의 폴더는 덮어쓰지 않고 거부한다
        let own = root.join("theirs");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::write(own.join("SKILL.md"), "사용자 것").unwrap();
        assert!(sync_installed(&root, &[], &[skill("theirs", true)]).is_err());
        assert_eq!(std::fs::read_to_string(own.join("SKILL.md")).unwrap(), "사용자 것");
        // 지워도 사용자 폴더는 남는다
        sync_installed(&root, &[skill("theirs", true)], &[]).unwrap();
        assert!(own.join("SKILL.md").exists());
    }

    #[test]
    fn disabling_or_deleting_removes_only_managed_folders() {
        let root = tmp("remove");
        let on = skill("x", true);
        sync_installed(&root, &[], &[on.clone()]).unwrap();
        let off = AppSkill { enabled: false, ..on.clone() };
        sync_installed(&root, &[on.clone()], &[off.clone()]).unwrap();
        assert!(!skill_dir(&root, "x").exists(), "꺼지면 설치 폴더가 지워진다");
        sync_installed(&root, &[off.clone()], &[on.clone()]).unwrap();
        assert!(skill_file(&root, "x").exists(), "다시 켜면 다시 설치된다");
        sync_installed(&root, &[on], &[]).unwrap();
        assert!(!skill_dir(&root, "x").exists(), "삭제하면 폴더도 지워진다");
    }

    #[test]
    fn commit_core_saves_installs_and_rolls_back_nothing_on_failure() {
        let dir = tmp("commit");
        let (json, root) = (dir.join("appSkills.json"), dir.join("skills"));
        std::fs::create_dir_all(&root).unwrap();
        // 추가: 저장 + 설치
        let (old, new) = commit_core(&json, &root, |v| { v.push(skill("alpha", true)); Ok(()) }).unwrap();
        assert!(old.is_empty() && new.len() == 1);
        assert_eq!(load_skills_from(&json), new);
        assert!(skill_file(&root, "alpha").exists());
        // 사용자가 직접 만든 같은 이름이 있으면 실패하고 목록은 그대로(저장 안 됨)
        std::fs::create_dir_all(root.join("beta")).unwrap();
        std::fs::write(root.join("beta").join("SKILL.md"), "사용자 것").unwrap();
        assert!(commit_core(&json, &root, |v| { v.push(skill("beta", true)); Ok(()) }).is_err());
        assert_eq!(load_skills_from(&json).len(), 1, "실패하면 목록이 저장되지 않는다");
        assert_eq!(std::fs::read_to_string(root.join("beta").join("SKILL.md")).unwrap(), "사용자 것");
        // 끄기 → 설치 폴더 삭제, 목록에는 남음
        commit_core(&json, &root, |v| { v[0].enabled = false; Ok(()) }).unwrap();
        assert!(!skill_dir(&root, "alpha").exists() && load_skills_from(&json).len() == 1);
        // 켜기 → 다시 설치, 설명 수정 → SKILL.md에 반영
        commit_core(&json, &root, |v| { v[0].enabled = true; v[0].description = "바뀐 설명".into(); Ok(()) }).unwrap();
        assert!(std::fs::read_to_string(skill_file(&root, "alpha")).unwrap().contains("바뀐 설명"));
        // mutate 자체가 실패하면 그대로
        assert!(commit_core(&json, &root, |_| Err("싫어".into())).is_err());
        // 삭제 → 목록과 폴더 모두 사라짐(사용자 폴더 beta는 그대로)
        commit_core(&json, &root, |v| { v.clear(); Ok(()) }).unwrap();
        assert!(load_skills_from(&json).is_empty() && !skill_dir(&root, "alpha").exists() && root.join("beta").exists());
    }

    #[test]
    fn notice_goes_to_every_lead_with_an_id_only_when_the_briefing_changed() {
        let leads = vec![lead(Some("i-a")), lead(None), lead(Some("i-b"))];
        assert!(plan_skills_notice("같음", "같음", &leads).is_empty());
        let plans = plan_skills_notice("", "- x — 설명", &leads);
        assert_eq!(plans.iter().map(|p| p.0.as_str()).collect::<Vec<_>>(), vec!["i-a", "i-b"]);
        assert!(plans[0].1.starts_with(SKILLS_NOTICE_MARKER) && plans[0].1.contains("- x"));
        let removed = plan_skills_notice("- x", "", &leads);
        assert!(removed[0].1.contains("등록된 스킬이 없습니다"));
    }
}
