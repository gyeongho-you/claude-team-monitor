// 오른쪽 사용자 패널 — 사용자가 슬롯을 만들어 원하는 내용을 띄운다(정적 마크다운만 표시한다).
//
// 슬롯마다 "채우는 방법"을 고른다:
//  - auto   : 앱이 팀장 대화 기록에서 규칙(프리셋)에 맞는 것을 모은다(Artifact 보고서 링크, GitHub PR 링크). 팀장 협조 필요 없음, 정확함.
//  - lead   : 슬롯에 적은 지침을 모든 팀장의 항상 적용되는 지침으로 넣는다(새 팀장은 첫 지시문, 떠 있는 팀장은 알림, 히스토리 팀장은 다시 이어질 때 — 스킬·팀원
//             템플릿 안내와 같은 방식). 팀장이 지정된 파일을 마크다운으로 갱신한다. AI가 따르는 방식이라 빠뜨릴 수 있다.
//  - ai     : 팀장이 일을 마칠 때마다(또는 새로고침 버튼으로) 앱이 모델(슬롯마다 선택)에게 팀장의 최근 대화를 읽혀 사용자가 적어 둔 요청대로 내용을 갱신한다.
//             호출은 도구·설정·스킬을 읽지 않는 최소 맥락으로 한다(실측: 호출당 Haiku 약 0.0006달러, Sonnet 0.008, Opus 0.017, Fable 0.2).
//  - script : 사용자가 쓰거나 AI가 써 준 작은 스크립트를 이 PC에서 돌려 그 출력(마크다운)을 보여 준다 — 브랜치·워크트리처럼 프리셋으로 못 하는 것용(panel_script.rs).
//  - manual : 사용자가 직접 쓴다.
// 내용 파일은 ~/.claude/claude-team-monitor/panel/<슬롯id>.md (auto는 파일 없이 그때그때 만든다).

use crate::json_file::write_json_file_atomic;
use crate::live_rows::SessionRow;
use crate::paths::{claude_home, is_safe_id, side_panel_path};
use crate::session_registry::{load_leads, LeadRecord};
use crate::timing::now_ms;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;
use wait_timeout::ChildExt;

pub(crate) const PANEL_NOTICE_MARKER: &str = "[알림:패널 지침]";
const MODES: [&str; 5] = ["auto", "lead", "ai", "manual", "script"];
const PRESETS: [&str; 2] = ["artifact-reports", "github-pr"];
const AI_MODELS: [&str; 4] = ["haiku", "sonnet", "opus", "fable"];
const MAX_CONTENT_CHARS: usize = 8000;
const MAX_AUTO_ITEMS: usize = 100;
const AI_TIMEOUT: Duration = Duration::from_secs(120);
const AI_MIN_INTERVAL_MS: i64 = 30_000;
const AI_SETTLE_MS: u128 = 8_000;

fn default_true() -> bool {
    true
}
fn default_mode() -> String {
    "manual".to_string()
}
fn default_scope() -> String {
    "all".to_string()
}
fn default_preset() -> String {
    "artifact-reports".to_string()
}
fn default_ai_model() -> String {
    "sonnet".to_string()
}
fn default_ai_include() -> String {
    "none".to_string()
}
fn default_interpreter() -> String {
    "node".to_string()
}
fn default_timeout_ms() -> u64 {
    crate::panel_script::DEFAULT_TIMEOUT_MS
}
fn default_output_format() -> String {
    "markdown".to_string()
}
fn default_false() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PanelSlot {
    pub id: String,
    pub name: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    /// auto 전용: "selected"(선택한 팀장만) | "all"
    #[serde(default = "default_scope")]
    pub scope: String,
    /// auto 전용 프리셋
    #[serde(default = "default_preset")]
    pub preset: String,
    /// lead/ai: 지침(요청) 글
    #[serde(default)]
    pub instruction: String,
    /// ai 전용: 팀장이 일을 마칠 때마다 자동 갱신
    #[serde(default)]
    pub auto_update: bool,
    #[serde(default = "default_ai_model")]
    pub ai_model: String,
    /// ai 전용: 모델에게 최근 대화 말고도 자동 수집한 목록 전체를 재료로 같이 준다 — "none" | "artifact-reports" | "github-pr".
    /// (사용자 의도: "보고서 리스트를 전부 정리해서" — 대화 몇 턴만 보고는 전체를 정리할 수 없다.)
    #[serde(default = "default_ai_include")]
    pub ai_include: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: i64,
    /// script 전용: 실행 환경("node" | "python" | "shell"), 스크립트 본문, 제한 시간(ms — 슬롯마다 사용자가 정한다)
    #[serde(default = "default_interpreter")]
    pub interpreter: String,
    #[serde(default)]
    pub script: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    /// script 전용: 출력 형식 "markdown"(글·표·링크·data: 이미지) | "html"(SVG·CSS 그래픽, 화면에서 스크립트 실행이 막힌 프레임에 그린다)
    #[serde(default = "default_output_format")]
    pub output_format: String,
    /// script + html 전용: 출력 HTML 안의 JavaScript 실행을 허용(앱과 분리된 프레임에서, 네트워크 차단 — panel_frames.rs). 기본은 꺼짐.
    #[serde(default = "default_false")]
    pub allow_js: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PanelConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub slots: Vec<PanelSlot>,
    /// 스크립트 슬롯 사용을 사용자가 명시적으로 켰는지(true)/껐는지(false). 없으면(이 항목이 생기기 전의 설정) 이미 스크립트 슬롯이 있는 사용자는 켜 둔 것으로 본다.
    #[serde(default)]
    pub scripts_enabled: Option<bool>,
    /// 위 값과 기존 슬롯으로 계산한 실제 허용 여부. 저장된 값은 무시하고 읽을 때마다 다시 계산한다(화면과 실행 차단이 이 값을 쓴다).
    #[serde(default, skip_deserializing)]
    pub scripts_allowed: bool,
}

impl PanelConfig {
    /// 스크립트 슬롯은 임의 코드를 이 PC에서 실행하므로 처음 쓰는 사용자에게는 꺼져 있다. 이미 스크립트 슬롯을 쓰던 사용자는 그대로 이어서 쓸 수 있고,
    /// 사용자가 한 번이라도 직접 켜거나 끄면 그 선택이 항상 우선한다.
    pub(crate) fn compute_scripts_allowed(&self) -> bool {
        self.scripts_enabled.unwrap_or_else(|| self.slots.iter().any(|s| s.mode == "script"))
    }
}

const SCRIPTS_OFF_MESSAGE: &str = "스크립트 슬롯이 꺼져 있습니다 — 앱 설정 → 오른쪽 패널에서 \"스크립트 슬롯 사용 허용\"을 켠 뒤 사용하세요.";

/// 스크립트를 실행하거나 스크립트 슬롯을 저장하기 전에 거치는 관문.
pub(crate) fn require_scripts_allowed(config: &PanelConfig) -> Result<(), String> {
    if config.compute_scripts_allowed() { Ok(()) } else { Err(SCRIPTS_OFF_MESSAGE.to_string()) }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSlotInput {
    pub id: Option<String>,
    pub name: String,
    pub mode: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default = "default_preset")]
    pub preset: String,
    #[serde(default)]
    pub instruction: String,
    #[serde(default)]
    pub auto_update: bool,
    #[serde(default = "default_ai_model")]
    pub ai_model: String,
    #[serde(default = "default_ai_include")]
    pub ai_include: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_interpreter")]
    pub interpreter: String,
    #[serde(default)]
    pub script: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_output_format")]
    pub output_format: String,
    #[serde(default = "default_false")]
    pub allow_js: bool,
}

// ---------------------------------------------------------------------------------------------
// 설정 검증 · 저장
// ---------------------------------------------------------------------------------------------

/// 입력을 검증해서 슬롯으로 만든다(id/created_at은 호출부가 채운다).
pub(crate) fn slot_from_input(input: &PanelSlotInput, id: String, created_at: i64) -> Result<PanelSlot, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 30 {
        return Err("슬롯 이름은 1~30자로 입력하세요.".to_string());
    }
    if !MODES.contains(&input.mode.as_str()) {
        return Err("채우는 방법이 올바르지 않습니다.".to_string());
    }
    if input.mode == "auto" && !PRESETS.contains(&input.preset.as_str()) {
        return Err("자동 수집 종류가 올바르지 않습니다.".to_string());
    }
    if !["selected", "all"].contains(&input.scope.as_str()) {
        return Err("보기 범위가 올바르지 않습니다.".to_string());
    }
    if !AI_MODELS.contains(&input.ai_model.as_str()) {
        return Err("모델이 올바르지 않습니다.".to_string());
    }
    if input.ai_include != "none" && !PRESETS.contains(&input.ai_include.as_str()) {
        return Err("재료에 포함할 목록 종류가 올바르지 않습니다.".to_string());
    }
    let instruction = input.instruction.trim().to_string();
    if (input.mode == "lead" || input.mode == "ai") && instruction.is_empty() {
        return Err(if input.mode == "lead" { "팀장에게 줄 지침을 입력하세요." } else { "AI에게 줄 요청을 입력하세요." }.to_string());
    }
    if instruction.chars().count() > 2000 {
        return Err("지침은 2000자 이하로 입력하세요.".to_string());
    }
    let is_script = input.mode == "script";
    if is_script {
        if !crate::panel_script::INTERPRETERS.contains(&input.interpreter.as_str()) {
            return Err("스크립트 실행 환경이 올바르지 않습니다.".to_string());
        }
        if input.script.trim().is_empty() {
            return Err("스크립트를 입력하세요.".to_string());
        }
        if input.script.chars().count() > crate::panel_script::MAX_SCRIPT_CHARS {
            return Err(format!("스크립트는 {}자 이하로 입력하세요.", crate::panel_script::MAX_SCRIPT_CHARS));
        }
        if !(crate::panel_script::MIN_TIMEOUT_MS..=crate::panel_script::MAX_TIMEOUT_MS).contains(&input.timeout_ms) {
            return Err(format!("제한 시간은 {}~{}ms 사이로 입력하세요.", crate::panel_script::MIN_TIMEOUT_MS, crate::panel_script::MAX_TIMEOUT_MS));
        }
        if !crate::panel_script::OUTPUT_FORMATS.contains(&input.output_format.as_str()) {
            return Err("출력 형식이 올바르지 않습니다.".to_string());
        }
    }
    Ok(PanelSlot {
        id,
        name,
        mode: input.mode.clone(),
        scope: input.scope.clone(),
        preset: input.preset.clone(),
        instruction,
        auto_update: input.mode == "ai" && input.auto_update,
        ai_model: input.ai_model.clone(),
        ai_include: if input.mode == "ai" { input.ai_include.clone() } else { "none".to_string() },
        enabled: input.enabled,
        created_at,
        interpreter: if is_script { input.interpreter.clone() } else { default_interpreter() },
        script: if is_script { input.script.clone() } else { String::new() },
        timeout_ms: if is_script { input.timeout_ms } else { default_timeout_ms() },
        output_format: if is_script { input.output_format.clone() } else { default_output_format() },
        allow_js: is_script && input.output_format == "html" && input.allow_js,
    })
}

fn load_config_from(path: &Path) -> PanelConfig {
    // 읽기 실패 시 덮어쓰지 않게 표시되고, 해석 못 하는 내용은 지우기 전에 백업된다(슬롯과 스크립트가 사라지지 않게).
    let mut config: PanelConfig = match crate::json_file::read_json_text_guarded(path) {
        None => PanelConfig::default(),
        Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| {
            crate::json_file::backup_corrupt_json(path, &raw);
            PanelConfig::default()
        }),
    };
    config.scripts_allowed = config.compute_scripts_allowed();
    config
}

/// 설정 파일에 스크립트 허용 여부가 아직 없으면(예전 설정) 지금의 판단을 명시값으로 굳혀 저장한다 — 안 그러면 파일에 스크립트 슬롯 한 줄만 써 넣어도(다른 프로그램이나 모델이)
/// "이미 쓰던 사용자"로 간주돼 허용이 켜진다. 시작할 때 한 번 호출한다. 파일이 없거나 이미 값이 있으면 아무것도 하지 않는다.
pub fn pin_scripts_flag_at_startup() {
    pin_scripts_flag_at(&side_panel_path());
}

fn pin_scripts_flag_at(path: &Path) {
    if !path.exists() {
        return;
    }
    let cfg = load_config_from(path);
    if cfg.scripts_enabled.is_some() {
        return;
    }
    let _ = commit_core(path, |c| {
        c.scripts_enabled = Some(c.compute_scripts_allowed());
        Ok(())
    });
}

pub fn load_panel_config() -> PanelConfig {
    load_config_from(&side_panel_path())
}

/// Node.js 실행 환경을 고른(켜져 있는) 스크립트 슬롯의 이름들 — 환경 점검이 "node가 필요한가"를 판단하는 데 쓴다(env_check.rs).
pub(crate) fn script_slot_names_using_node() -> Vec<String> {
    load_panel_config().slots.into_iter().filter(|s| s.enabled && s.mode == "script" && s.interpreter == "node").map(|s| s.name).collect()
}

fn config_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

fn panel_dir() -> PathBuf {
    claude_home().join("claude-team-monitor").join("panel")
}

fn content_path(dir: &Path, slot_id: &str) -> PathBuf {
    dir.join(format!("{slot_id}.md"))
}

/// 설정을 바꾸고 저장한다 → (바꾸기 전, 바꾼 후). mutate가 실패하면 저장하지 않는다.
fn commit_core<F>(path: &Path, mutate: F) -> Result<(PanelConfig, PanelConfig), String>
where
    F: FnOnce(&mut PanelConfig) -> Result<(), String>,
{
    let old = load_config_from(path);
    let mut new = old.clone();
    mutate(&mut new)?;
    new.scripts_allowed = new.compute_scripts_allowed();
    write_json_file_atomic(path, &new).map_err(|e| format!("패널 설정을 저장하지 못했습니다: {e}"))?;
    Ok((old, new))
}

async fn commit<F>(mutate: F) -> Result<PanelConfig, String>
where
    F: FnOnce(&mut PanelConfig) -> Result<(), String>,
{
    let guard = config_lock().lock().await;
    let (old, new) = commit_core(&side_panel_path(), mutate)?;
    drop(guard);
    let _ = std::fs::create_dir_all(panel_dir());
    notify_leads(&old, &new).await;
    Ok(new)
}

// ---------------------------------------------------------------------------------------------
// lead 방식: 팀장에게 줄 지침과 알림
// ---------------------------------------------------------------------------------------------

/// 팀장에게 줄 패널 지침(켜져 있는 lead 슬롯만). 없으면 빈 문자열.
pub(crate) fn build_panel_briefing(config: &PanelConfig, dir: &Path) -> String {
    if !config.enabled {
        return String::new();
    }
    let lines: Vec<String> = config
        .slots
        .iter()
        .filter(|s| s.enabled && s.mode == "lead")
        .map(|s| format!("- 패널 \"{}\" — 파일: {}\n  지침: {}", s.name, content_path(dir, &s.id).display(), s.instruction.replace('\n', " ")))
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "사용자 패널(앱 오른쪽 화면)에 표시되는 내용을 아래 지침대로 관리하라 — 해당하는 일이 끝날 때마다 그 파일을 마크다운으로 갱신해라. 파일은 모든 팀장이 공유하니, 먼저 읽어서 다른 팀장이 쓴 내용은 지우지 말고 합쳐서 써라(파일이 없으면 새로 만들어라).\n{}",
        lines.join("\n")
    )
}

pub(crate) fn plan_panel_notice(old_text: &str, new_text: &str, leads: &[LeadRecord]) -> Vec<(String, String)> {
    if old_text == new_text {
        return Vec::new();
    }
    let body = if new_text.is_empty() { "지금 관리하라고 한 패널이 없습니다(이전 지침은 더 이상 따르지 않아도 됩니다).".to_string() } else { new_text.to_string() };
    let message = format!("{PANEL_NOTICE_MARKER} 사용자 패널 지침이 바뀌었습니다. 지금 적용되는 지침은 아래와 같습니다(이전에 받은 안내를 대체합니다):\n\n{body}");
    leads.iter().filter_map(|l| l.internal_id.clone()).map(|id| (id, message.clone())).collect()
}

async fn notify_leads(old: &PanelConfig, new: &PanelConfig) {
    let dir = panel_dir();
    let plans = plan_panel_notice(&build_panel_briefing(old, &dir), &build_panel_briefing(new, &dir), &load_leads());
    for (internal_id, message) in plans {
        crate::notice_queue::queue_replacing_notice(&internal_id, PANEL_NOTICE_MARKER, &message, crate::notice_queue::NoticeOrigin::System).await;
    }
}

/// 새 팀장/재시작 팀장의 첫 지시문 뒤에 붙일 안내(없으면 빈 문자열, 있으면 앞에 빈 줄 포함).
pub fn prompt_section() -> String {
    let text = build_panel_briefing(&load_panel_config(), &panel_dir());
    if text.is_empty() {
        String::new()
    } else {
        format!("\n\n{text}")
    }
}

// ---------------------------------------------------------------------------------------------
// auto 방식: 대화 기록에서 링크 모으기
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawItem {
    pub title: String,
    pub version: u32,
    pub ts: String,
}

#[derive(Default)]
struct ScanState {
    offset: u64,
    items: HashMap<String, RawItem>,
    /// github-pr: PR 만들기 호출의 tool_use id(그 결과가 나중 줄에 오므로 파일을 이어 읽는 동안 기억해 둔다)
    pr_ids: HashSet<String>,
}

fn published_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^Published (.+?) at (https://claude\.ai/(?:code/)?artifact/[A-Za-z0-9_-]+)(?: \(Version (\d+))?").unwrap())
}

fn pr_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/(\d+)").unwrap())
}

/// "Published <경로> at <주소> (Version N, …)" 도구 결과 → (제목=파일 이름, 주소, 버전). 안내 결과(Quickstart 등)는 "Published"로 시작하지 않아 걸러진다.
pub(crate) fn parse_published_result(text: &str) -> Option<(String, String, u32)> {
    let c = published_re().captures(text.trim_start())?;
    let path = c.get(1)?.as_str();
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let title = file.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file).to_string();
    let version = c.get(3).and_then(|v| v.as_str().parse().ok()).unwrap_or(1);
    Some((title, c.get(2)?.as_str().to_string(), version))
}

/// 텍스트 안의 GitHub PR 주소 → (제목 owner/repo#N, 주소)
pub(crate) fn find_pr_links(text: &str) -> Vec<(String, String)> {
    pr_re().captures_iter(text).map(|c| (format!("{}/{}#{}", &c[1], &c[2], &c[3]), c[0].to_string())).collect()
}

fn block_texts(rec: &serde_json::Value) -> Vec<(String, String)> {
    // (종류, 텍스트): 답변 본문 / 도구 결과
    let mut out = Vec::new();
    let rtype = rec.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let content = rec.get("message").and_then(|m| m.get("content"));
    match content {
        Some(serde_json::Value::String(s)) if rtype == "assistant" => out.push(("assistant".to_string(), s.clone())),
        Some(serde_json::Value::Array(arr)) => {
            for b in arr {
                let btype = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if rtype == "assistant" && btype == "text" {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        out.push(("assistant".to_string(), t.to_string()));
                    }
                } else if rtype == "user" && btype == "tool_result" {
                    let text = match b.get("content") {
                        Some(serde_json::Value::String(s)) => s.clone(),
                        Some(serde_json::Value::Array(parts)) => parts.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
                        _ => String::new(),
                    };
                    out.push(("tool".to_string(), text));
                }
            }
        }
        _ => {}
    }
    out
}

/// 기록 한 줄에서 프리셋에 맞는 링크를 뽑아 items에 합친다(같은 주소는 최신 버전·시각으로 갱신).
fn pr_create_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\bgh\s+pr\s+create\b").unwrap())
}

/// 팀장이 PR을 만든 호출(gh pr create, 또는 GitHub 도구의 create_pull_request)의 tool_use id를 적어 둔다.
fn note_pr_create_calls(rec: &serde_json::Value, ids: &mut HashSet<String>) {
    let Some(arr) = rec.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else { return };
    for b in arr.iter().filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use")) {
        let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
        let cmd = b.get("input").and_then(|i| i.get("command")).and_then(|c| c.as_str()).unwrap_or("");
        if let Some(id) = b.get("id").and_then(|i| i.as_str()) {
            if pr_create_re().is_match(cmd) || name.contains("create_pull_request") {
                ids.insert(id.to_string());
            }
        }
    }
}

/// github-pr 프리셋: 팀장이 만든 PR만 모은다. 대화에 등장하는 아무 PR 주소(읽은 코드·목록 조회·남의 PR)는 팀장의 작업이 아니므로 모으지 않고,
/// PR 만들기 호출의 결과에 찍힌 주소만 쓴다.
fn process_pr_line(line: &str, items: &mut HashMap<String, RawItem>, pr_ids: &mut HashSet<String>) {
    if !line.contains("pr create") && !line.contains("create_pull_request") && !line.contains("/pull/") && !line.contains("pr  create") {
        return;
    }
    let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else { return };
    match rec.get("type").and_then(|t| t.as_str()) {
        Some("assistant") => note_pr_create_calls(&rec, pr_ids),
        Some("user") => {
            let ts = rec.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
            let Some(arr) = rec.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) else { return };
            for b in arr.iter().filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result")) {
                if !b.get("tool_use_id").and_then(|i| i.as_str()).map_or(false, |id| pr_ids.contains(id)) {
                    continue;
                }
                let text = match b.get("content") {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Array(parts)) => parts.iter().filter_map(|p| p.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
                    _ => String::new(),
                };
                for (title, url) in find_pr_links(&text) {
                    let e = items.entry(url).or_insert(RawItem { title: title.clone(), version: 1, ts: ts.clone() });
                    if ts > e.ts {
                        e.ts = ts.clone();
                    }
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn process_line(preset: &str, line: &str, items: &mut HashMap<String, RawItem>, pr_ids: &mut HashSet<String>) {
    if preset == "github-pr" {
        return process_pr_line(line, items, pr_ids);
    }
    if !line.contains("artifact") {
        return;
    }
    let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) else { return };
    let ts = rec.get("timestamp").and_then(|t| t.as_str()).unwrap_or("").to_string();
    for (kind, text) in block_texts(&rec) {
        let found: Vec<(String, String, u32)> = if kind == "tool" {
            parse_published_result(&text).into_iter().collect()
        } else {
            Vec::new()
        };
        for (title, url, version) in found {
            let e = items.entry(url).or_insert(RawItem { title: title.clone(), version, ts: ts.clone() });
            if version >= e.version {
                e.version = version;
                e.title = title;
            }
            if ts > e.ts {
                e.ts = ts.clone();
            }
        }
    }
}

fn scan_cache() -> &'static Mutex<HashMap<(String, PathBuf), ScanState>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, PathBuf), ScanState>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 파일을 마지막으로 읽은 위치부터 이어서만 읽는다(수십~백 MB 기록을 매번 다시 읽지 않는다). 프리셋에 안 맞는 줄은 JSON 해석 전에 걸러서 빠르다.
fn scan_file(preset: &str, path: &Path) -> HashMap<String, RawItem> {
    use std::io::{Seek, SeekFrom};
    let mut cache = scan_cache().lock().unwrap_or_else(|e| e.into_inner());
    let state = cache.entry((preset.to_string(), path.to_path_buf())).or_default();
    let Ok(mut f) = std::fs::File::open(path) else { return state.items.clone() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len < state.offset {
        *state = ScanState::default();
    }
    if len > state.offset && f.seek(SeekFrom::Start(state.offset)).is_ok() {
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_ok() {
            if let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') {
                for line in String::from_utf8_lossy(&buf[..last_nl]).lines() {
                    process_line(preset, line, &mut state.items, &mut state.pr_ids);
                }
                state.offset += (last_nl + 1) as u64;
            }
        }
    }
    state.items.clone()
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectedItem {
    pub lead_id: String,
    pub url: String,
    pub title: String,
    pub version: u32,
    pub ts: String,
    pub lead_label: String,
}

fn lead_label(l: &LeadRecord) -> String {
    l.label.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| Path::new(&l.target_dir).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| l.id.clone()))
}

fn collect_items(preset: &str, leads: &[LeadRecord], selected: Option<&str>) -> Vec<CollectedItem> {
    let mut out: Vec<CollectedItem> = Vec::new();
    for l in leads.iter().filter(|l| selected.map_or(true, |s| l.id == s)) {
        let file = crate::transcript::session_file_path(&l.target_dir, &l.session_id);
        for (url, raw) in scan_file(preset, &file) {
            out.push(CollectedItem { lead_id: l.id.clone(), url, title: raw.title, version: raw.version, ts: raw.ts, lead_label: lead_label(l) });
        }
    }
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out.truncate(MAX_AUTO_ITEMS);
    out
}

fn local_time(ts: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(ts).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()
}

fn md_escape_title(s: &str) -> String {
    s.replace('[', "(").replace(']', ")")
}

pub(crate) fn render_items_markdown(preset: &str, items: &[CollectedItem]) -> String {
    if items.is_empty() {
        return if preset == "github-pr" { "아직 모인 PR 링크가 없습니다." } else { "아직 모인 보고서 링크가 없습니다." }.to_string();
    }
    let mut out = format!("총 {}개 · 최신순\n\n", items.len());
    for it in items {
        let ver = if it.version > 1 { format!(" · v{}", it.version) } else { String::new() };
        let when = local_time(&it.ts);
        let when = if when.is_empty() { String::new() } else { format!(" · {when}") };
        out.push_str(&format!("- [{}]({}) — {}{when}{ver}\n", md_escape_title(&it.title), it.url, md_escape_title(&it.lead_label)));
    }
    out
}

// ---------------------------------------------------------------------------------------------
// ai 방식: 모델에게 정리를 맡긴다
// ---------------------------------------------------------------------------------------------

/// 모델 출력에서 감싼 코드펜스를 벗기고 길이를 제한한다. 비어 있으면 None(= 이전 내용을 그대로 둔다).
pub(crate) fn sanitize_ai_output(raw: &str) -> Option<String> {
    let mut t = raw.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let rest = rest.split_once('\n').map(|(_, r)| r).unwrap_or(rest);
        t = rest.strip_suffix("```").unwrap_or(rest).trim();
    }
    if t.is_empty() {
        return None;
    }
    Some(t.chars().take(MAX_CONTENT_CHARS).collect())
}

pub(crate) fn build_ai_prompt(instruction: &str, current: &str, material: &str) -> String {
    build_ai_prompt_with(instruction, current, material, "")
}

/// collected가 비어 있지 않으면 "앱이 대화 기록에서 모은 전체 목록"을 재료로 함께 준다(이 목록이 전체이므로 모델은 이것을 기준으로 정리하면 된다).
pub(crate) fn build_ai_prompt_with(instruction: &str, current: &str, material: &str, collected: &str) -> String {
    let collected_block = if collected.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n앱이 대화 기록에서 자동으로 모은 전체 목록(이것이 지금까지의 전부다 — 빠짐없이 반영해라):\n\"\"\"\n{collected}\n\"\"\"")
    };
    format!(
        "너는 데스크톱 앱 오른쪽 패널의 내용을 관리한다. 사용자가 적어 둔 요청:\n\"\"\"\n{instruction}\n\"\"\"\n\n현재 패널 내용(마크다운):\n\"\"\"\n{}\n\"\"\"{collected_block}\n\n새로 끝난 작업(팀장과 사용자의 최근 대화):\n\"\"\"\n{material}\n\"\"\"\n\n위 요청에 맞게 패널 전체 내용을 갱신해서 마크다운으로만 출력해라(설명·인사·코드펜스 없이 내용만). 요청과 관련 없는 대화면 현재 내용을 그대로 출력해라. 기존 항목은 요청이 없는 한 지우지 마라. {MAX_CONTENT_CHARS}자를 넘기지 마라.",
        if current.trim().is_empty() { "(비어 있음)" } else { current }
    )
}

/// 도구·설정·스킬·세션 저장 없이 최소 맥락으로 한 번만 묻는다(프롬프트는 stdin으로 — 길어도 명령줄 길이 제한에 안 걸린다).
/// 사용자가 "AI 작업 취소"를 눌렀음을 알리는 표시 — 실행 중인 한 번짜리 모델 호출이 이걸 보고 멈춘다.
static AI_CANCEL_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 모델 호출을 자식 프로세스까지 포함해 종료한다(claude가 만든 하위 프로세스가 파이프를 쥔 채 남는 것을 막는다).
fn kill_process_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).creation_flags(0x0800_0000).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 지금 진행 중인 AI 작업(스크립트 만들기·수정·고치기)을 멈춘다. 진행 중인 게 없으면 아무 일도 없다.
#[tauri::command]
pub fn cancel_ai_command() -> bool {
    if AI_BUSY.load(Ordering::SeqCst) {
        AI_CANCEL_GEN.fetch_add(1, Ordering::SeqCst);
        true
    } else {
        false
    }
}

/// limit이 None이면 시간 제한 없이 끝날 때까지(또는 사용자가 취소할 때까지) 기다린다 — 사용자가 화면에서 기다리는 작업용.
/// 백그라운드 자동 갱신은 멈춰 있어도 다른 작업을 영영 막지 않도록 제한을 준다.
fn run_claude_oneshot(model: &str, prompt: &str, limit: Option<Duration>) -> Result<String, String> {
    // 취소는 "세대 번호가 시작할 때와 달라졌는가"로 알아본다 — 표시를 지우는 방식이면 막 시작하는 순간에 누른 취소가 사라진다.
    let my_gen = AI_CANCEL_GEN.load(Ordering::SeqCst);
    let mut cmd = Command::new("claude");
    cmd.args(["-p", "--model", model, "--output-format", "json", "--tools", "", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]);
    cmd.current_dir(std::env::temp_dir());
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| format!("claude를 실행하지 못했습니다: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let data = prompt.as_bytes().to_vec();
        std::thread::spawn(move || {
            let _ = stdin.write_all(&data);
        });
    }
    let mut stdout = child.stdout.take().ok_or("출력을 열지 못했습니다")?;
    let mut stderr = child.stderr.take().ok_or("오류 출력을 열지 못했습니다")?;
    let out_reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stdout.read_to_end(&mut b);
        b
    });
    let err_reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stderr.read_to_end(&mut b);
        b
    });
    let started = std::time::Instant::now();
    let waited = loop {
        match child.wait_timeout(Duration::from_millis(250)) {
            Ok(Some(status)) => break Ok(Some(status)),
            Ok(None) => {
                if AI_CANCEL_GEN.load(Ordering::SeqCst) != my_gen {
                    kill_process_tree(&mut child);
                    return Err("사용자가 취소했습니다.".to_string());
                }
                if let Some(l) = limit {
                    if started.elapsed() >= l {
                        break Ok(None);
                    }
                }
            }
            Err(e) => break Err(e),
        }
    };
    match waited {
        Ok(Some(status)) => {
            let out = out_reader.join().unwrap_or_default();
            let err = err_reader.join().unwrap_or_default();
            if !status.success() {
                return Err(format!("모델 호출이 실패했습니다(종료 코드 {:?}): {}", status.code(), String::from_utf8_lossy(&err).lines().next().unwrap_or("")));
            }
            let envelope: serde_json::Value = serde_json::from_slice(&out).map_err(|e| format!("모델 응답을 해석하지 못했습니다: {e}"))?;
            envelope.get("result").and_then(|r| r.as_str()).map(str::to_string).ok_or_else(|| "모델 응답에 결과가 없습니다".to_string())
        }
        _ => {
            kill_process_tree(&mut child);
            Err("모델이 시간 안에 답하지 않아 중단했습니다".to_string())
        }
    }
}

fn read_content(dir: &Path, slot_id: &str) -> (String, Option<i64>) {
    let p = content_path(dir, slot_id);
    let text = std::fs::read_to_string(&p).unwrap_or_default();
    let mtime = std::fs::metadata(&p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
    (text, mtime)
}

fn write_content(dir: &Path, slot_id: &str, text: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("패널 폴더를 만들지 못했습니다: {e}"))?;
    let p = content_path(dir, slot_id);
    let tmp = p.with_extension("md.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("패널 내용을 쓰지 못했습니다: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("패널 내용을 저장하지 못했습니다: {e}"))
}

/// 팀장 한 명의 최근 대화(최대 2턴)를 모델에게 줄 글로 만든다.
fn lead_material(l: &LeadRecord, turns: usize) -> String {
    let project = crate::live_rows::resolve_project_name(&l.session_id, &l.target_dir);
    let all = crate::transcript::recent_turns(&project, &l.session_id, &l.target_dir);
    let start = all.len().saturating_sub(turns);
    let cut = |s: &str, n: usize| -> String { s.chars().take(n).collect() };
    all[start..].iter().map(|t| format!("[팀장 {}] 사용자: {}\n팀장 답변: {}", lead_label(l), cut(&t.prompt, 1500), cut(&t.answer, 4000))).collect::<Vec<_>>().join("\n\n")
}

static AI_BUSY: AtomicBool = AtomicBool::new(false);

fn ai_baselines() -> &'static Mutex<HashMap<String, (u128, u64)>> {
    static B: OnceLock<Mutex<HashMap<String, (u128, u64)>>> = OnceLock::new();
    B.get_or_init(|| Mutex::new(HashMap::new()))
}
fn ai_last_run() -> &'static Mutex<HashMap<String, i64>> {
    static L: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, PartialEq)]
pub(crate) enum AiDecision {
    /// 처음 본 팀장 — 지금 상태를 기준으로만 기억한다(앱을 켜자마자 예전 대화를 전부 처리하지 않도록).
    Baseline,
    Skip,
    Run,
}

/// 자동 갱신을 할지 정한다(순수 함수). state=(수정 시각 ms, 크기), age_ms=수정된 지 얼마나 지났는지.
pub(crate) fn ai_decide(baseline: Option<(u128, u64)>, state: (u128, u64), age_ms: u128, since_last_run_ms: i64) -> AiDecision {
    match baseline {
        None => AiDecision::Baseline,
        Some(b) if b == state => AiDecision::Skip,
        Some(_) if age_ms < AI_SETTLE_MS => AiDecision::Skip, // 아직 쓰는 중
        Some(_) if since_last_run_ms < AI_MIN_INTERVAL_MS => AiDecision::Skip,
        Some(_) => AiDecision::Run,
    }
}

fn file_state(path: &Path) -> Option<((u128, u64), u128)> {
    let m = std::fs::metadata(path).ok()?;
    let mt = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    Some(((mt, m.len()), now.saturating_sub(mt)))
}

/// 폴링마다 불린다 — 일을 마친(쉬는) 팀장의 기록이 바뀌었고 자동 갱신이 켜진 ai 슬롯이 있으면 한 번에 하나씩 갱신한다.
pub fn on_rows_tick(rows: &[SessionRow]) {
    let config = load_panel_config();
    if !config.enabled {
        return;
    }
    let slots: Vec<&PanelSlot> = config.slots.iter().filter(|s| s.enabled && s.mode == "ai" && s.auto_update).collect();
    if slots.is_empty() || AI_BUSY.load(Ordering::Relaxed) {
        return;
    }
    let now = now_ms();
    for row in rows.iter().filter(|r| r.is_lead && !r.offline) {
        let status = crate::agents_json::get_status(row.agent.status.as_deref(), row.agent.state.as_deref());
        if status != "idle" && status != "done" {
            continue;
        }
        let Some(lead_id) = row.agent.id.clone() else { continue };
        let Some(lead) = load_leads().into_iter().find(|l| l.id == lead_id) else { continue };
        let file = crate::transcript::session_file_path(&lead.target_dir, &lead.session_id);
        let Some((state, age)) = file_state(&file) else { continue };
        for slot in &slots {
            let key = format!("{}|{}", slot.id, lead.id);
            let baseline = ai_baselines().lock().unwrap_or_else(|e| e.into_inner()).get(&key).copied();
            let since = now - ai_last_run().lock().unwrap_or_else(|e| e.into_inner()).get(&slot.id).copied().unwrap_or(0);
            match ai_decide(baseline, state, age, since) {
                AiDecision::Baseline => {
                    ai_baselines().lock().unwrap_or_else(|e| e.into_inner()).insert(key, state);
                }
                AiDecision::Skip => {}
                AiDecision::Run => {
                    if AI_BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
                        return;
                    }
                    ai_baselines().lock().unwrap_or_else(|e| e.into_inner()).insert(key, state);
                    ai_last_run().lock().unwrap_or_else(|e| e.into_inner()).insert(slot.id.clone(), now);
                    let slot = (*slot).clone();
                    std::thread::spawn(move || {
                        let result = update_ai_slot(&slot, &lead_material(&lead, 2));
                        if let Err(e) = result {
                            crate::logging::log_critical(&format!("[panel] AI 슬롯 \"{}\" 갱신 실패 — {e}", slot.name));
                        }
                        AI_BUSY.store(false, Ordering::SeqCst);
                    });
                    return; // 한 번에 하나만
                }
            }
        }
    }
}

/// 슬롯 내용을 모델로 갱신해서 저장한다.
fn update_ai_slot(slot: &PanelSlot, material: &str) -> Result<String, String> {
    let dir = panel_dir();
    let (current, _) = read_content(&dir, &slot.id);
    let collected = if slot.ai_include == "none" { String::new() } else { render_items_markdown(&slot.ai_include, &collect_items(&slot.ai_include, &load_leads(), None)) };
    let raw = run_claude_oneshot(&slot.ai_model, &build_ai_prompt_with(&slot.instruction, &current, material, &collected), Some(AI_TIMEOUT))?;
    let Some(text) = sanitize_ai_output(&raw) else { return Ok(current) };
    write_content(&dir, &slot.id, &text)?;
    Ok(text)
}

// ---------------------------------------------------------------------------------------------
// Tauri 커맨드
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelContent {
    pub markdown: String,
    pub updated_at: Option<i64>,
    pub mode: String,
    pub note: String,
    /// 자동 수집 슬롯일 때만 채운다 — 화면의 리더·기간 필터가 이걸 거른다(모델에 넘기는 재료는 거르지 않는다).
    pub items: Vec<CollectedItem>,
    /// markdown이면 마크다운 렌더러로, html이면 스크립트가 막힌 격리 프레임에 그린다(스크립트 슬롯의 정상 출력만 html일 수 있다).
    pub format: String,
}

#[tauri::command]
pub fn get_panel_config_command() -> PanelConfig {
    load_panel_config()
}

#[tauri::command]
pub async fn set_panel_enabled_command(enabled: bool) -> Result<PanelConfig, String> {
    commit(move |c| {
        c.enabled = enabled;
        Ok(())
    })
    .await
}

/// 스크립트 슬롯 사용 허용을 켜거나 끈다. 끄면 이미 만든 스크립트 슬롯도 실행되지 않는다(내용은 지워지지 않는다).
#[tauri::command]
pub async fn set_scripts_enabled_command(enabled: bool) -> Result<PanelConfig, String> {
    commit(move |c| {
        c.scripts_enabled = Some(enabled);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn save_panel_slot_command(input: PanelSlotInput) -> Result<PanelConfig, String> {
    commit(move |c| {
        if input.mode == "script" {
            require_scripts_allowed(c)?;
        }
        match input.id.as_deref() {
            Some(id) => {
                let Some(pos) = c.slots.iter().position(|s| s.id == id) else { return Err("그 슬롯을 찾지 못했습니다.".to_string()) };
                let created = c.slots[pos].created_at;
                c.slots[pos] = slot_from_input(&input, id.to_string(), created)?;
            }
            None => {
                if c.slots.len() >= 12 {
                    return Err("슬롯은 12개까지 만들 수 있습니다.".to_string());
                }
                let slot = slot_from_input(&input, format!("slot-{}", now_ms()), now_ms())?;
                c.slots.push(slot);
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn delete_panel_slot_command(id: String) -> Result<PanelConfig, String> {
    let removed = id.clone();
    let cfg = commit(move |c| {
        c.slots.retain(|s| s.id != id);
        Ok(())
    })
    .await?;
    if is_safe_id(&removed) {
        let _ = std::fs::remove_file(content_path(&panel_dir(), &removed));
        // 스크립트 슬롯이 실행하려고 쓴 파일도 같이 지운다(실행 환경별 확장자)
        for ext in ["js", "py", "ps1", "sh"] {
            let _ = std::fs::remove_file(panel_dir().join("scripts").join(format!("{removed}.{ext}")));
        }
    }
    Ok(cfg)
}

/// 스크립트 슬롯의 마지막 실행 결과(패널이 3초마다 조회해도 스크립트를 그때마다 돌리지 않게 잠깐 보관한다).
struct ScriptCacheEntry {
    key: String,
    at: std::time::Instant,
    updated_at: i64,
    output: String,
    format: String,
}
const SCRIPT_CACHE_TTL: Duration = Duration::from_secs(5);

fn script_cache() -> &'static Mutex<HashMap<String, ScriptCacheEntry>> {
    static C: OnceLock<Mutex<HashMap<String, ScriptCacheEntry>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}
fn script_running() -> &'static Mutex<HashSet<String>> {
    static R: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashSet::new()))
}

async fn script_content(slot: PanelSlot, lead_id: Option<String>, force: bool) -> Result<PanelContent, String> {
    let leads = load_leads();
    let lead = crate::panel_script::lead_by_id(&leads, lead_id.as_deref());
    // 스크립트·실행 환경·제한 시간·출력 형식·선택한 팀장이 바뀌면 다른 결과다.
    let key = format!("{}|{}|{}|{}|{}|{}|{}", slot.interpreter, slot.timeout_ms, slot.output_format, slot.allow_js, lead.as_ref().map(|l| l.id.as_str()).unwrap_or(""), slot.script.len(), slot.script);
    let note = "스크립트를 이 PC에서 실행한 결과입니다".to_string();
    let cached = |c: &HashMap<String, ScriptCacheEntry>| c.get(&slot.id).filter(|e| e.key == key).map(|e| (e.output.clone(), e.format.clone(), e.updated_at, e.at.elapsed()));
    let content = |output: String, format: String, at: Option<i64>, slot: &PanelSlot, note: String| PanelContent { markdown: output, updated_at: at, mode: slot.mode.clone(), note, items: Vec::new(), format };
    if let Some((out, fmt, at, age)) = cached(&script_cache().lock().unwrap_or_else(|e| e.into_inner())) {
        if !force && age < SCRIPT_CACHE_TTL {
            return Ok(content(out, fmt, Some(at), &slot, note));
        }
    }
    // 같은 슬롯이 이미 돌고 있으면 또 시작하지 않고 가진 결과(없으면 안내)를 보여 준다.
    if !script_running().lock().unwrap_or_else(|e| e.into_inner()).insert(slot.id.clone()) {
        let (out, fmt, at) = cached(&script_cache().lock().unwrap_or_else(|e| e.into_inner())).map(|(o, f, a, _)| (o, f, Some(a))).unwrap_or(("스크립트를 실행하는 중입니다...".to_string(), "markdown".to_string(), None));
        return Ok(content(out, fmt, at, &slot, note));
    }
    let (id, interpreter, script, timeout_ms, format, allow_js) = (slot.id.clone(), slot.interpreter.clone(), slot.script.clone(), slot.timeout_ms, slot.output_format.clone(), slot.allow_js);
    let outcome = tokio::task::spawn_blocking(move || crate::panel_script::run_script_outcome(&panel_dir().join("scripts"), &id, &interpreter, &script, timeout_ms, lead.as_ref(), &format, allow_js))
        .await
        .map_err(|e| e.to_string());
    script_running().lock().unwrap_or_else(|e| e.into_inner()).remove(&slot.id);
    let outcome = outcome?;
    if let Some(problem) = &outcome.problem {
        crate::panel_script::record_error_at(&script_errors_path(), &slot.id, &slot.name, "panel", problem, now_ms());
    }
    let at = now_ms();
    script_cache().lock().unwrap_or_else(|e| e.into_inner()).insert(slot.id.clone(), ScriptCacheEntry { key, at: std::time::Instant::now(), updated_at: at, output: outcome.output.clone(), format: outcome.format.to_string() });
    Ok(content(outcome.output, outcome.format.to_string(), Some(at), &slot, note))
}

/// 시험 실행 결과: 출력(정상이면 스크립트가 낸 것, 문제가 있으면 마크다운 오류 문구)과 그 형식, 그리고 정상 종료 때의 표준 오류 출력.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTestResult {
    pub output: String,
    pub format: String,
    pub stderr: String,
}

/// 설정 화면의 "시험 실행": 저장하지 않은 스크립트를 지금 돌려 결과를 보여 준다.
#[tauri::command]
pub async fn test_panel_script_command(interpreter: String, script: String, timeout_ms: u64, lead_id: Option<String>, output_format: Option<String>, allow_js: Option<bool>) -> Result<ScriptTestResult, String> {
    require_scripts_allowed(&load_panel_config())?;
    if !crate::panel_script::INTERPRETERS.contains(&interpreter.as_str()) {
        return Err("스크립트 실행 환경이 올바르지 않습니다.".to_string());
    }
    if script.trim().is_empty() || script.chars().count() > crate::panel_script::MAX_SCRIPT_CHARS {
        return Err("스크립트가 비었거나 너무 깁니다.".to_string());
    }
    if !(crate::panel_script::MIN_TIMEOUT_MS..=crate::panel_script::MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(format!("제한 시간은 {}~{}ms 사이로 입력하세요.", crate::panel_script::MIN_TIMEOUT_MS, crate::panel_script::MAX_TIMEOUT_MS));
    }
    let format = output_format.unwrap_or_else(default_output_format);
    if !crate::panel_script::OUTPUT_FORMATS.contains(&format.as_str()) {
        return Err("출력 형식이 올바르지 않습니다.".to_string());
    }
    let lead = crate::panel_script::lead_by_id(&load_leads(), lead_id.as_deref());
    let allow_js = allow_js.unwrap_or(false) && format == "html";
    let outcome = tokio::task::spawn_blocking(move || crate::panel_script::run_script_outcome(&panel_dir().join("scripts"), "_test", &interpreter, &script, timeout_ms, lead.as_ref(), &format, allow_js)).await.map_err(|e| e.to_string())?;
    if let Some(problem) = &outcome.problem {
        crate::panel_script::record_error_at(&script_errors_path(), "_test", "(시험 실행)", "test", problem, now_ms());
    }
    Ok(ScriptTestResult { output: outcome.output, format: outcome.format.to_string(), stderr: outcome.stderr })
}

fn script_errors_path() -> PathBuf {
    panel_dir().join("script-errors.json")
}

/// 최근 스크립트 에러(최신순) — 설정 화면의 "최근 에러 보기".
#[tauri::command]
pub fn get_panel_script_errors_command() -> Vec<crate::panel_script::ScriptErrorEntry> {
    crate::panel_script::load_errors_from(&script_errors_path())
}

#[tauri::command]
pub fn clear_panel_script_errors_command() {
    crate::panel_script::clear_errors_at(&script_errors_path());
}

/// 스크립트 작성 안내(앱이 주는 정보·출력 형식·제한) — 설정 화면에 보여 주고, AI 요청문에도 같은 글이 들어간다.
/// "AI로 고치기": 시험 실행에서 나온 결과(오류 포함)를 보고 모델이 스크립트를 고쳐 온다. 마찬가지로 저장은 사용자가 코드를 보고 직접 한다.
#[tauri::command]
pub async fn fix_panel_script_command(script: String, problem: String, note: String, interpreter: String, model: String, output_format: Option<String>, allow_js: Option<bool>) -> Result<String, String> {
    let allow_js = allow_js.unwrap_or(false);
    let output_format = output_format.unwrap_or_else(default_output_format);
    if !crate::panel_script::OUTPUT_FORMATS.contains(&output_format.as_str()) {
        return Err("출력 형식이 올바르지 않습니다.".to_string());
    }
    if script.trim().is_empty() || script.chars().count() > crate::panel_script::MAX_SCRIPT_CHARS {
        return Err("고칠 스크립트가 비었거나 너무 깁니다.".to_string());
    }
    if problem.trim().is_empty() {
        return Err("먼저 \"시험 실행\"으로 문제가 나오는 결과를 만든 뒤 눌러 주세요.".to_string());
    }
    if !crate::panel_script::INTERPRETERS.contains(&interpreter.as_str()) || !AI_MODELS.contains(&model.as_str()) {
        return Err("실행 환경 또는 모델이 올바르지 않습니다.".to_string());
    }
    let problem: String = problem.chars().take(4000).collect();
    let note: String = note.chars().take(1000).collect();
    if AI_BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("다른 AI 작업이 진행 중입니다. 잠시 후 다시 누르세요.".to_string());
    }
    let result = tokio::task::spawn_blocking(move || run_claude_oneshot(&model, &crate::panel_script::build_fix_prompt(&script, &problem, &note, &interpreter, &output_format, allow_js), None)).await;
    AI_BUSY.store(false, Ordering::SeqCst);
    let code = crate::panel_script::extract_code_block(&result.map_err(|e| e.to_string())??);
    if code.trim().is_empty() {
        return Err("모델이 고친 스크립트를 내놓지 못했습니다. 다시 시도하세요.".to_string());
    }
    Ok(code)
}

/// "AI로 수정": 지금 스크립트와 사용자의 변경 요청을 모델에게 주고 수정본을 받아 온다. 저장은 사용자가 코드를 보고 직접 한다.
#[tauri::command]
pub async fn modify_panel_script_command(script: String, change: String, history: Option<Vec<String>>, last_run: Option<String>, interpreter: String, model: String, output_format: Option<String>, allow_js: Option<bool>) -> Result<String, String> {
    let allow_js = allow_js.unwrap_or(false);
    let output_format = output_format.unwrap_or_else(default_output_format);
    if !crate::panel_script::OUTPUT_FORMATS.contains(&output_format.as_str()) {
        return Err("출력 형식이 올바르지 않습니다.".to_string());
    }
    if script.trim().is_empty() || script.chars().count() > crate::panel_script::MAX_SCRIPT_CHARS {
        return Err("수정할 스크립트가 비었거나 너무 깁니다. 비어 있으면 \"AI로 만들기\"를 쓰세요.".to_string());
    }
    let change = change.trim().to_string();
    if change.is_empty() || change.chars().count() > 1000 {
        return Err("바꾸고 싶은 내용을 1000자 이하로 적어 주세요.".to_string());
    }
    if !crate::panel_script::INTERPRETERS.contains(&interpreter.as_str()) || !AI_MODELS.contains(&model.as_str()) {
        return Err("실행 환경 또는 모델이 올바르지 않습니다.".to_string());
    }
    // 이전 요청 이력은 최근 20개·각 1000자까지만, 시험 실행 결과는 4000자까지만 받는다(요청문이 끝없이 커지지 않게).
    let history: Vec<String> = history.unwrap_or_default().into_iter().rev().take(20).collect::<Vec<_>>().into_iter().rev()
        .map(|h| h.chars().take(1000).collect()).collect();
    let last_run: String = last_run.unwrap_or_default().chars().take(4000).collect();
    if AI_BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("다른 AI 작업이 진행 중입니다. 잠시 후 다시 누르세요.".to_string());
    }
    let result = tokio::task::spawn_blocking(move || run_claude_oneshot(&model, &crate::panel_script::build_modify_prompt(&script, &change, &history, &last_run, &interpreter, &output_format, allow_js), None)).await;
    AI_BUSY.store(false, Ordering::SeqCst);
    let code = crate::panel_script::extract_code_block(&result.map_err(|e| e.to_string())??);
    if code.trim().is_empty() {
        return Err("모델이 수정한 스크립트를 내놓지 못했습니다. 요청을 바꿔 다시 시도하세요.".to_string());
    }
    Ok(code)
}

#[tauri::command]
pub fn get_panel_script_reference_command() -> String {
    crate::panel_script::reference_markdown()
}

/// "AI로 스크립트 만들기": 요청을 모델에게 주고 스크립트 초안을 받아 온다(저장은 사용자가 코드를 보고 직접 한다). 모델 호출이라 추가 토큰이 든다.
#[tauri::command]
pub async fn generate_panel_script_command(request: String, interpreter: String, model: String, output_format: Option<String>, allow_js: Option<bool>) -> Result<String, String> {
    let allow_js = allow_js.unwrap_or(false);
    let output_format = output_format.unwrap_or_else(default_output_format);
    if !crate::panel_script::OUTPUT_FORMATS.contains(&output_format.as_str()) {
        return Err("출력 형식이 올바르지 않습니다.".to_string());
    }
    let request = request.trim().to_string();
    if request.is_empty() || request.chars().count() > 1000 {
        return Err("만들고 싶은 내용을 1000자 이하로 적어 주세요.".to_string());
    }
    if !crate::panel_script::INTERPRETERS.contains(&interpreter.as_str()) || !AI_MODELS.contains(&model.as_str()) {
        return Err("실행 환경 또는 모델이 올바르지 않습니다.".to_string());
    }
    if AI_BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("다른 AI 작업이 진행 중입니다. 잠시 후 다시 누르세요.".to_string());
    }
    let result = tokio::task::spawn_blocking(move || run_claude_oneshot(&model, &crate::panel_script::build_generate_prompt(&request, &interpreter, &output_format, allow_js), None)).await;
    AI_BUSY.store(false, Ordering::SeqCst);
    let text = result.map_err(|e| e.to_string())??;
    let code = crate::panel_script::extract_code_block(&text);
    if code.trim().is_empty() {
        return Err("모델이 스크립트를 만들지 못했습니다. 요청을 바꿔 다시 시도하세요.".to_string());
    }
    Ok(code)
}

#[tauri::command]
pub async fn get_panel_content_command(slot_id: String, lead_id: Option<String>, force: Option<bool>) -> Result<PanelContent, String> {
    let config = load_panel_config();
    let Some(slot) = config.slots.into_iter().find(|s| s.id == slot_id) else { return Err("그 슬롯을 찾지 못했습니다.".to_string()) };
    if !is_safe_id(&slot.id) {
        return Err("슬롯 id가 올바르지 않습니다.".to_string());
    }
    if slot.mode == "auto" {
        let selected = if slot.scope == "selected" { lead_id } else { None };
        let preset = slot.preset.clone();
        let (md, items) = tokio::task::spawn_blocking(move || {
            let items = collect_items(&preset, &load_leads(), selected.as_deref());
            (render_items_markdown(&preset, &items), items)
        })
        .await
        .map_err(|e| e.to_string())?;
        return Ok(PanelContent { markdown: md, updated_at: None, mode: slot.mode, note: "대화 기록에서 자동으로 모았습니다".to_string(), items, format: "markdown".to_string() });
    }
    if slot.mode == "script" {
        if !load_panel_config().scripts_allowed {
            return Ok(PanelContent { markdown: format!("⚠ {SCRIPTS_OFF_MESSAGE}"), updated_at: None, mode: slot.mode, note: "스크립트 슬롯이 꺼져 있어 실행하지 않았습니다".to_string(), items: Vec::new(), format: "markdown".to_string() });
        }
        return script_content(slot, lead_id, force.unwrap_or(false)).await;
    }
    let (text, mtime) = read_content(&panel_dir(), &slot.id);
    let note = match slot.mode.as_str() {
        "lead" => "팀장이 지침대로 갱신하는 내용입니다",
        "ai" => "AI가 정리한 내용입니다(틀릴 수 있습니다)",
        _ => "직접 쓴 내용입니다",
    };
    Ok(PanelContent { markdown: text, updated_at: mtime, mode: slot.mode, note: note.to_string(), items: Vec::new(), format: "markdown".to_string() })
}

/// 직접 쓰는 슬롯(manual)과 ai/lead 슬롯의 내용을 사용자가 고쳐 저장한다.
#[tauri::command]
pub fn save_panel_content_command(slot_id: String, markdown: String) -> Result<(), String> {
    if !is_safe_id(&slot_id) || !load_panel_config().slots.iter().any(|s| s.id == slot_id && s.mode != "auto") {
        return Err("내용을 저장할 수 없는 슬롯입니다.".to_string());
    }
    write_content(&panel_dir(), &slot_id, &markdown.chars().take(MAX_CONTENT_CHARS * 2).collect::<String>())
}

/// ai 슬롯을 지금 갱신한다 — 가장 최근에 움직인 팀장 몇 명의 마지막 대화를 읽혀서 요청대로 정리한다.
#[tauri::command]
pub async fn refresh_panel_slot_command(slot_id: String) -> Result<PanelContent, String> {
    let config = load_panel_config();
    let Some(slot) = config.slots.into_iter().find(|s| s.id == slot_id && s.mode == "ai") else { return Err("AI 슬롯이 아닙니다.".to_string()) };
    if AI_BUSY.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("다른 AI 갱신이 진행 중입니다. 잠시 후 다시 누르세요.".to_string());
    }
    let slot2 = slot.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut leads = load_leads();
        leads.sort_by_key(|l| std::cmp::Reverse(file_state(&crate::transcript::session_file_path(&l.target_dir, &l.session_id)).map(|(s, _)| s.0).unwrap_or(0)));
        let material = leads.iter().take(5).map(|l| lead_material(l, 1)).filter(|m| !m.is_empty()).collect::<Vec<_>>().join("\n\n");
        update_ai_slot(&slot2, &material)
    })
    .await;
    AI_BUSY.store(false, Ordering::SeqCst);
    let text = result.map_err(|e| e.to_string())??;
    let (_, mtime) = read_content(&panel_dir(), &slot.id);
    Ok(PanelContent { markdown: text, updated_at: mtime, mode: slot.mode, note: "AI가 정리한 내용입니다(틀릴 수 있습니다)".to_string(), items: Vec::new(), format: "markdown".to_string() })
}

pub(crate) fn is_safe_external_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://")) && url.len() < 2000 && !url.chars().any(|c| c.is_whitespace() || c.is_control() || "\"'<>`^|\\".contains(c))
}

/// 패널 안의 링크를 기본 브라우저로 연다(http/https만).
#[tauri::command]
pub fn open_external_url_command(url: String) -> bool {
    if !is_safe_external_url(&url) {
        return false;
    }
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(mode: &str) -> PanelSlotInput {
        PanelSlotInput { id: None, name: "보고서".into(), mode: mode.into(), scope: "all".into(), preset: "artifact-reports".into(), instruction: "".into(), auto_update: false, ai_model: "sonnet".into(), ai_include: "none".into(), enabled: true, interpreter: "node".into(), script: "".into(), timeout_ms: 10_000, output_format: "markdown".into(), allow_js: false }
    }

    #[test]
    fn script_slot_needs_a_script_and_a_time_limit_in_range_and_other_modes_ignore_script_fields() {
        let mut i = input("script");
        assert!(slot_from_input(&i, "s1".into(), 0).unwrap_err().contains("스크립트를 입력"));
        i.script = "console.log(1)".into();
        let ok = slot_from_input(&i, "s1".into(), 0).unwrap();
        assert_eq!((ok.interpreter.as_str(), ok.timeout_ms), ("node", 10_000));
        i.timeout_ms = 100;
        assert!(slot_from_input(&i, "s1".into(), 0).unwrap_err().contains("제한 시간"));
        i.timeout_ms = 700_000;
        assert!(slot_from_input(&i, "s1".into(), 0).is_err());
        i.timeout_ms = 3000;
        i.output_format = "pdf".into();
        assert!(slot_from_input(&i, "s1".into(), 0).unwrap_err().contains("출력 형식"));
        i.output_format = "html".into();
        assert_eq!(slot_from_input(&i, "s1".into(), 0).unwrap().output_format, "html");
        // JavaScript 허용은 html 출력일 때만 켜진다
        i.allow_js = true;
        assert!(slot_from_input(&i, "s1".into(), 0).unwrap().allow_js);
        i.output_format = "markdown".into();
        assert!(!slot_from_input(&i, "s1".into(), 0).unwrap().allow_js, "마크다운 출력이면 JavaScript 허용은 무시된다");
        i.allow_js = false;
        i.output_format = "html".into();
        i.interpreter = "ruby".into();
        assert!(slot_from_input(&i, "s1".into(), 0).unwrap_err().contains("실행 환경"));
        // 스크립트가 아닌 슬롯은 스크립트 칸 값이 와도 저장하지 않는다
        let mut m = input("manual");
        m.script = "x".into();
        m.timeout_ms = 1;
        let slot = slot_from_input(&m, "s2".into(), 0).unwrap();
        assert!(slot.script.is_empty() && slot.timeout_ms == 10_000);
    }

    #[test]
    fn old_config_files_without_script_fields_still_load_with_defaults() {
        let cfg: PanelConfig = serde_json::from_str(r#"{"enabled":true,"slots":[{"id":"a","name":"보고서","mode":"auto"}]}"#).unwrap();
        assert_eq!((cfg.slots[0].interpreter.as_str(), cfg.slots[0].timeout_ms, cfg.slots[0].script.as_str(), cfg.slots[0].output_format.as_str()), ("node", 10_000, "", "markdown"));
    }

    fn lead(id: &str, internal: Option<&str>) -> LeadRecord {
        LeadRecord {
            id: id.into(),
            session_id: String::new(),
            target_dir: "C:/proj/web".into(),
            launched_at: 0,
            approved_members: vec![],
            label: Some("웹 팀장".into()),
            ai_title: None,
            internal_id: internal.map(str::to_string),
            auto_stall_nudge: None,
            secret: None,
            startup_warning: None,
        }
    }

    fn tool_result_line(ts: &str, text: &str) -> String {
        serde_json::json!({"type":"user","timestamp":ts,"message":{"content":[{"type":"tool_result","tool_use_id":"t","content":text}]}}).to_string()
    }

    #[test]
    fn published_results_give_title_url_and_version_but_quickstart_text_is_ignored() {
        let (title, url, v) = parse_published_result("Published C:\\Users\\x\\tmp\\bo-gap-report.html at https://claude.ai/artifact/6bso7H4ZDUUyx1xNnQC4hq (Version 3, version id 1-ab)").unwrap();
        assert_eq!((title.as_str(), url.as_str(), v), ("bo-gap-report", "https://claude.ai/artifact/6bso7H4ZDUUyx1xNnQC4hq", 3));
        let (t2, _, v2) = parse_published_result("Published /tmp/a/b.report.v2.html at https://claude.ai/code/artifact/abc_DEF-1").unwrap();
        assert_eq!((t2.as_str(), v2), ("b.report.v2", 1));
        assert!(parse_published_result("Quickstart. This one result stands in ... \"https://claude.ai/artifact/GZLZthZ2sQjn7T16skfdeF\"").is_none());
    }

    #[test]
    fn report_lines_are_deduped_by_url_keeping_the_latest_version_and_time() {
        let mut items = HashMap::new();
        process_line("artifact-reports", &tool_result_line("2026-11-01T01:00:00Z", "Published /a/first.html at https://claude.ai/artifact/AAA (Version 1)"), &mut items, &mut HashSet::new());
        process_line("artifact-reports", &tool_result_line("2026-11-02T01:00:00Z", "Published /a/second-name.html at https://claude.ai/artifact/AAA (Version 2)"), &mut items, &mut HashSet::new());
        process_line("artifact-reports", &tool_result_line("2026-11-01T05:00:00Z", "Published /a/other.html at https://claude.ai/artifact/BBB"), &mut items, &mut HashSet::new());
        process_line("artifact-reports", &tool_result_line("2026-11-03T00:00:00Z", "Quickstart ... https://claude.ai/artifact/CCC"), &mut items, &mut HashSet::new());
        assert_eq!(items.len(), 2);
        let a = &items["https://claude.ai/artifact/AAA"];
        assert_eq!((a.title.as_str(), a.version, a.ts.as_str()), ("second-name", 2, "2026-11-02T01:00:00Z"));
        // 답변 본문에 적힌 링크는 보고서 프리셋에서 모으지 않는다(게시 결과만)
        let say = serde_json::json!({"type":"assistant","timestamp":"2026-11-04T00:00:00Z","message":{"content":[{"type":"text","text":"https://claude.ai/artifact/ZZZ 참고"}]}}).to_string();
        process_line("artifact-reports", &say, &mut items, &mut HashSet::new());
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn github_pr_preset_collects_only_prs_the_lead_created() {
        let call = |id: &str, name: &str, cmd: &str| serde_json::json!({"type":"assistant","timestamp":"2026-11-04T00:00:00Z","message":{"content":[{"type":"tool_use","id":id,"name":name,"input":{"command":cmd}}]}}).to_string();
        let result = |ts: &str, id: &str, text: &str| serde_json::json!({"type":"user","timestamp":ts,"message":{"content":[{"type":"tool_result","tool_use_id":id,"content":text}]}}).to_string();
        let (mut items, mut ids) = (HashMap::new(), HashSet::new());
        // 팀장이 만든 PR: gh pr create 호출의 결과
        process_line("github-pr", &call("c1", "Bash", "cd repo && gh  pr create --title x --body y"), &mut items, &mut ids);
        process_line("github-pr", &result("2026-11-04T01:00:00Z", "c1", "Creating pull request...\nhttps://github.com/acme/api/pull/7"), &mut items, &mut ids);
        // 남의 PR을 조회하거나 읽은 것, 답변에 적힌 주소는 모으지 않는다
        process_line("github-pr", &call("c2", "Bash", "gh pr list --repo other/repo"), &mut items, &mut ids);
        process_line("github-pr", &result("2026-11-04T02:00:00Z", "c2", "https://github.com/other/repo/pull/99"), &mut items, &mut ids);
        let say = serde_json::json!({"type":"assistant","timestamp":"2026-11-04T03:00:00Z","message":{"content":[{"type":"text","text":"참고: https://github.com/acme/web-app/pull/42"}]}}).to_string();
        process_line("github-pr", &say, &mut items, &mut ids);
        process_line("github-pr", &result("2026-11-04T04:00:00Z", "unknown", "https://github.com/acme/web-app/pull/43"), &mut items, &mut ids);
        // GitHub 도구로 만든 PR
        process_line("github-pr", &call("c3", "mcp__github__create_pull_request", ""), &mut items, &mut ids);
        process_line("github-pr", &result("2026-11-04T05:00:00Z", "c3", "{\"html_url\":\"https://github.com/acme/web/pull/5\"}"), &mut items, &mut ids);
        let mut titles: Vec<&str> = items.values().map(|i| i.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, vec!["acme/api#7", "acme/web#5"]);
    }

    #[test]
    fn scan_reads_incrementally_and_only_complete_lines() {
        let dir = std::env::temp_dir().join(format!("ctm_panel_scan_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        std::fs::write(&f, tool_result_line("2026-11-01T01:00:00Z", "Published /a/one.html at https://claude.ai/artifact/ONE (Version 1)") + "\n").unwrap();
        assert_eq!(scan_file("artifact-reports", &f).len(), 1);
        let second = tool_result_line("2026-11-02T01:00:00Z", "Published /a/two.html at https://claude.ai/artifact/TWO (Version 1)");
        let mut c = std::fs::OpenOptions::new().append(true).open(&f).unwrap();
        c.write_all(&second.as_bytes()[..30]).unwrap();
        assert_eq!(scan_file("artifact-reports", &f).len(), 1, "덜 써진 줄은 다음에");
        c.write_all(&second.as_bytes()[30..]).unwrap();
        c.write_all(b"\n").unwrap();
        assert_eq!(scan_file("artifact-reports", &f).len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn items_render_as_newest_first_markdown_links() {
        let items = vec![
            CollectedItem { lead_id: "L1".into(), url: "https://claude.ai/artifact/B".into(), title: "새 [보고서]".into(), version: 2, ts: "2026-11-02T01:00:00Z".into(), lead_label: "웹 팀장".into() },
            CollectedItem { lead_id: "L1".into(), url: "https://claude.ai/artifact/A".into(), title: "옛 보고서".into(), version: 1, ts: "2026-11-01T01:00:00Z".into(), lead_label: "웹 팀장".into() },
        ];
        let md = render_items_markdown("artifact-reports", &items);
        assert!(md.starts_with("총 2개 · 최신순"));
        assert!(md.contains("- [새 (보고서)](https://claude.ai/artifact/B) — 웹 팀장") && md.contains(" · v2"), "{md}");
        assert!(!md.contains("v1"), "버전 1은 표시하지 않는다");
        assert_eq!(render_items_markdown("github-pr", &[]), "아직 모인 PR 링크가 없습니다.");
    }

    #[test]
    fn slot_input_is_validated_per_mode() {
        let ok = slot_from_input(&input("manual"), "slot-1".into(), 1).unwrap();
        assert!(ok.enabled && !ok.auto_update);
        assert!(slot_from_input(&PanelSlotInput { name: "  ".into(), ..input("manual") }, "s".into(), 1).is_err(), "이름 필수");
        assert!(slot_from_input(&input("bogus"), "s".into(), 1).is_err());
        assert!(slot_from_input(&input("lead"), "s".into(), 1).is_err(), "lead는 지침 필수");
        assert!(slot_from_input(&input("ai"), "s".into(), 1).is_err(), "ai는 요청 필수");
        let ai = slot_from_input(&PanelSlotInput { instruction: "표로 정리".into(), auto_update: true, ..input("ai") }, "s".into(), 1).unwrap();
        assert!(ai.auto_update && ai.ai_model == "sonnet");
        assert!(!slot_from_input(&PanelSlotInput { auto_update: true, ..input("manual") }, "s".into(), 1).unwrap().auto_update, "자동 갱신은 ai만");
        assert!(slot_from_input(&PanelSlotInput { ai_model: "gpt".into(), ..input("manual") }, "s".into(), 1).is_err());
        assert!(slot_from_input(&PanelSlotInput { preset: "x".into(), ..input("auto") }, "s".into(), 1).is_err());
        assert!(slot_from_input(&PanelSlotInput { instruction: "정리".into(), ai_include: "bogus".into(), ..input("ai") }, "s".into(), 1).is_err());
        let with_list = slot_from_input(&PanelSlotInput { instruction: "정리".into(), ai_include: "artifact-reports".into(), ..input("ai") }, "s".into(), 1).unwrap();
        assert_eq!(with_list.ai_include, "artifact-reports");
        assert_eq!(slot_from_input(&PanelSlotInput { ai_include: "artifact-reports".into(), ..input("manual") }, "s".into(), 1).unwrap().ai_include, "none", "재료 포함은 ai 슬롯에서만 의미 있다");
        assert!(slot_from_input(&PanelSlotInput { instruction: "가".repeat(2001), ..input("lead") }, "s".into(), 1).is_err());
    }

    #[test]
    fn config_commit_saves_and_rolls_back_nothing_on_failure() {
        let path = std::env::temp_dir().join(format!("ctm_panel_cfg_{}.json", uuid::Uuid::new_v4()));
        let (old, new) = commit_core(&path, |c| {
            c.enabled = true;
            c.slots.push(slot_from_input(&input("manual"), "slot-1".into(), 1).unwrap());
            Ok(())
        })
        .unwrap();
        assert!(!old.enabled && new.enabled && load_config_from(&path) == new);
        assert!(commit_core(&path, |_| Err("싫어".into())).is_err());
        assert_eq!(load_config_from(&path), new, "실패하면 저장하지 않는다");
        let _ = std::fs::remove_file(&path);
        // 옛 저장 파일(필드 일부 없음)도 읽힌다
        let cfg: PanelConfig = serde_json::from_str(r#"{"slots":[{"id":"s","name":"n"}]}"#).unwrap();
        assert!(!cfg.enabled && cfg.slots[0].mode == "manual" && cfg.slots[0].enabled && cfg.slots[0].ai_model == "sonnet" && cfg.slots[0].ai_include == "none");
    }

    #[test]
    fn scripts_are_off_for_a_fresh_config_but_stay_on_for_users_who_already_have_a_script_slot() {
        let dir = std::env::temp_dir().join(format!("ctm-panel-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sidePanel.json");
        // 설정 파일이 아직 없는 새 사용자
        let fresh = load_config_from(&path);
        assert!(!fresh.scripts_allowed, "처음 쓰는 사용자는 꺼져 있다");
        assert!(require_scripts_allowed(&fresh).is_err());
        // 이 항목이 생기기 전 설정(scriptsEnabled 없음) + 스크립트 슬롯 있음 → 기존 사용자는 그대로 켜짐
        let script = slot_from_input(&PanelSlotInput { script: "console.log(1)".into(), ..input("script") }, "slot-1".into(), 1).unwrap();
        let legacy = PanelConfig { enabled: true, slots: vec![script.clone()], ..Default::default() };
        std::fs::write(&path, serde_json::to_string(&legacy).unwrap()).unwrap();
        assert!(load_config_from(&path).scripts_allowed, "이미 스크립트 슬롯을 쓰던 사용자는 이어서 쓴다");
        // 사용자가 명시적으로 끄면 슬롯이 있어도 꺼진다 (저장된 scriptsAllowed 값이 있어도 무시하고 다시 계산)
        let off = PanelConfig { scripts_enabled: Some(false), scripts_allowed: true, ..legacy.clone() };
        std::fs::write(&path, serde_json::to_string(&off).unwrap()).unwrap();
        assert!(!load_config_from(&path).scripts_allowed);
        // 명시적으로 켜면 슬롯이 없어도 켜진다
        let on = PanelConfig { scripts_enabled: Some(true), ..Default::default() };
        std::fs::write(&path, serde_json::to_string(&on).unwrap()).unwrap();
        assert!(load_config_from(&path).scripts_allowed && require_scripts_allowed(&load_config_from(&path)).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn saving_through_commit_core_recomputes_the_allowed_flag_and_keeps_the_choice() {
        let dir = std::env::temp_dir().join(format!("ctm-panel-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sidePanel.json");
        let (_, after_on) = commit_core(&path, |c| {
            c.scripts_enabled = Some(true);
            Ok(())
        })
        .unwrap();
        assert!(after_on.scripts_allowed);
        let (_, after_off) = commit_core(&path, |c| {
            c.scripts_enabled = Some(false);
            Ok(())
        })
        .unwrap();
        assert!(!after_off.scripts_allowed);
        assert_eq!(load_config_from(&path).scripts_enabled, Some(false), "선택이 파일에 남는다");
        // 끈 상태에서 스크립트 슬롯 저장은 관문에서 막힌다
        assert!(require_scripts_allowed(&load_config_from(&path)).unwrap_err().contains("꺼져 있습니다"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lead_briefing_lists_only_enabled_lead_slots_and_only_when_the_panel_is_on() {
        let dir = std::env::temp_dir();
        let lead_slot = slot_from_input(&PanelSlotInput { instruction: "보고서를 만들면 날짜·제목·링크를 한 줄로 추가".into(), ..input("lead") }, "slot-9".into(), 1).unwrap();
        let manual = slot_from_input(&input("manual"), "slot-8".into(), 1).unwrap();
        let mut cfg = PanelConfig { enabled: true, slots: vec![lead_slot.clone(), manual], ..Default::default() };
        let text = build_panel_briefing(&cfg, &dir);
        assert!(text.contains("slot-9.md") && text.contains("날짜·제목·링크") && !text.contains("slot-8"), "{text}");
        cfg.slots[0].enabled = false;
        assert_eq!(build_panel_briefing(&cfg, &dir), "");
        cfg.slots[0].enabled = true;
        cfg.enabled = false;
        assert_eq!(build_panel_briefing(&cfg, &dir), "", "패널을 끄면 팀장에게도 안내하지 않는다");
    }

    #[test]
    fn panel_notice_goes_to_every_lead_with_an_id_only_when_the_briefing_changed() {
        let leads = vec![lead("a", Some("i-a")), lead("b", None), lead("c", Some("i-c"))];
        assert!(plan_panel_notice("같음", "같음", &leads).is_empty());
        let plans = plan_panel_notice("", "- 패널 x", &leads);
        assert_eq!(plans.iter().map(|p| p.0.as_str()).collect::<Vec<_>>(), vec!["i-a", "i-c"]);
        assert!(plans[0].1.starts_with(PANEL_NOTICE_MARKER));
        assert!(plan_panel_notice("- 패널 x", "", &leads)[0].1.contains("더 이상 따르지 않아도"));
    }

    #[test]
    fn ai_output_is_unfenced_trimmed_and_capped() {
        assert_eq!(sanitize_ai_output("```markdown\n# 제목\n- a\n```").as_deref(), Some("# 제목\n- a"));
        assert_eq!(sanitize_ai_output("  그냥 글  ").as_deref(), Some("그냥 글"));
        assert_eq!(sanitize_ai_output("   \n  "), None);
        assert_eq!(sanitize_ai_output(&"가".repeat(MAX_CONTENT_CHARS + 50)).unwrap().chars().count(), MAX_CONTENT_CHARS);
        let p = build_ai_prompt("표로 정리", "", "[팀장 웹] 사용자: 안녕");
        assert!(p.contains("표로 정리") && p.contains("(비어 있음)") && p.contains("안녕") && !p.contains("자동으로 모은 전체 목록"));
        let p2 = build_ai_prompt_with("표로 정리", "", "대화", "- [a](https://claude.ai/artifact/A) — 웹 팀장");
        assert!(p2.contains("자동으로 모은 전체 목록") && p2.contains("artifact/A"));
    }

    #[test]
    fn auto_update_waits_for_settled_changed_files_and_never_replays_old_history() {
        assert_eq!(ai_decide(None, (1, 10), 99_999, 99_999), AiDecision::Baseline, "처음 본 팀장은 기준만 기억");
        assert_eq!(ai_decide(Some((1, 10)), (1, 10), 99_999, 99_999), AiDecision::Skip, "안 바뀜");
        assert_eq!(ai_decide(Some((1, 10)), (2, 20), 1_000, 99_999), AiDecision::Skip, "아직 쓰는 중");
        assert_eq!(ai_decide(Some((1, 10)), (2, 20), 20_000, 5_000), AiDecision::Skip, "슬롯의 최소 간격");
        assert_eq!(ai_decide(Some((1, 10)), (2, 20), 20_000, 60_000), AiDecision::Run);
    }

    #[test]
    fn only_http_links_without_dangerous_characters_may_be_opened() {
        assert!(is_safe_external_url("https://claude.ai/artifact/abc?x=1&y=2#top"));
        assert!(is_safe_external_url("http://localhost:3000/a"));
        for bad in ["file:///c:/windows/calc.exe", "javascript:alert(1)", "https://a.com/x y", "https://a.com/\"x", "https://a.com/x|calc", "ftp://a.com"] {
            assert!(!is_safe_external_url(bad), "{bad}");
        }
    }
}
