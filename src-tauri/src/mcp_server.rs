// 팀원 생성 전용 MCP 서버(stdio) — 앱 실행 파일 자신이 `<앱 exe> --mcp-server`로 이 서버가 된다.
//
// 예전에는 이 서버가 Node.js 스크립트(src/mcp/teamMemberServer.ts → dist/teamMemberServer.js)라서 앱을 쓰는
// PC에 Node.js가 있어야 했다(일반 사용자에게 큰 진입 장벽). 같은 동작을 Rust로 옮겨 앱 exe 하나로 끝나게 했다 —
// claude CLI가 팀장 세션을 시작할 때 `--mcp-config`의 command로 이 exe를 직접 실행하고, 세션이 끝나면 같이 정리된다.
//
// 동작은 TS 서버와 같다:
//  - spawn_team_member : 사전 승인된 디렉토리에 팀원(claude --bg)을 띄우고 앱에 등록(스폰+등록을 한 번에)
//  - register_as_lead  : 터미널에서 직접 시작한 세션을 팀장으로 등록
//  - list_leads        : 등록된 팀장 목록과 SendMessage 주소 조회
// "이 프로세스가 어느 팀장인지"는 부모 프로세스(이 서버를 띄운 claude 세션 자신)의 pid로 `claude agents --json`에서
// 자기 자신을 찾아 알아낸다(실측 확인된 방식 — MCP stdio 서버는 claude 세션의 직계 자식으로 뜬다).
//
// 프로토콜: MCP stdio는 줄바꿈으로 구분된 JSON-RPC 2.0이다. 이 서버가 처리하는 것은 initialize, ping, tools/list,
// tools/call과 initialized 알림뿐이다(리소스·프롬프트는 제공하지 않는다). stdout에는 프로토콜 메시지만 쓰고, 로그는 stderr로 보낸다.

use crate::agents_json::AgentEntry;
use crate::json_file::write_json_file_atomic;
use crate::lead_lifecycle::{SECRET_MODE_CLI_ARGS, TEAM_MEMBER_BRIEFING};
use crate::paths::is_safe_id;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// 앱 exe를 MCP 서버로 실행할 때 붙이는 인자.
pub const MCP_SERVER_FLAG: &str = "--mcp-server";

const SERVER_NAME: &str = "claude-team-monitor";
const SUPPORTED_PROTOCOLS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MEMBER_MODELS: [&str; 5] = ["default", "haiku", "sonnet", "opus", "fable"];

// ---------------------------------------------------------------------------------------------
// 바깥 세계(claude CLI, 파일, 프로세스) — 시험에서 가짜로 바꿔 끼울 수 있게 trait으로 분리한다.
// ---------------------------------------------------------------------------------------------

pub trait Backend {
    /// `claude agents --json` 결과(실패하면 에러)
    fn agents(&self) -> Result<Vec<AgentEntry>, String>;
    /// 이 서버를 띄운 부모(claude 세션)의 pid
    fn parent_pid(&self) -> Option<i64>;
    fn leads_path(&self) -> PathBuf;
    fn members_dir(&self) -> PathBuf;
    /// `claude --bg …`를 실행해 백그라운드 세션의 짧은 id를 돌려준다(실패하면 None)
    fn spawn_bg(&self, flags: &[String], prompt: &str, cwd: &str) -> Option<String>;
    /// 그 디렉토리가 claude 최초 실행 승인이 안 돼 있으면 이유를 돌려준다(준비됐으면 None)
    fn dir_not_ready_reason(&self, dir: &str) -> Option<String>;
    fn now_ms(&self) -> i64;
    fn random_hex8(&self) -> String;
    fn new_uuid(&self) -> String;
    fn cwd(&self) -> String;
}

// ---------------------------------------------------------------------------------------------
// 도구 정의
// ---------------------------------------------------------------------------------------------

fn tool_definitions() -> Value {
    json!([
        {
            "name": "spawn_team_member",
            "title": "팀원 생성",
            "description": "새 팀원(claude --bg 백그라운드 세션)을 사전 승인된 디렉토리에 띄우고, Claude Team Monitor 앱에 자동으로 등록한다. 팀원을 만들 때는 Bash로 claude --bg를 직접 실행하지 말고 항상 이 툴을 써라 — 이 툴은 스폰과 등록을 한 번에 처리해서, 등록을 깜빡해 모니터링 화면에 팀원이 안 잡히는 사고를 원천적으로 막는다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "targetDir": {"type": "string", "description": "이 팀원이 작업할 저장소의 절대 경로. 사전 승인된 디렉토리여야 한다."},
                    "instruction": {"type": "string", "description": "이 팀원에게 줄 구체적인 작업 지시."},
                    "label": {"type": "string", "description": "이 팀원을 구분할, 사람이 읽을 수 있는 이름."},
                    "role": {"type": "string", "description": "선택: 이 팀원의 역할(예: reviewer, implementer). 화면 표시 및 팀원 자신에게도 전달된다."},
                    "model": {"type": "string", "enum": MEMBER_MODELS, "description": "선택: 이 팀원에 쓸 모델. 생략하면 기본값."}
                },
                "required": ["targetDir", "instruction", "label"],
                "additionalProperties": false,
                "$schema": "http://json-schema.org/draft-07/schema#"
            }
        },
        {
            "name": "register_as_lead",
            "title": "이 세션을 팀장으로 등록",
            "description": "지금 이 claude 세션 자신을 Claude Team Monitor의 팀장으로 등록한다. 이 앱을 거치지 않고 터미널에서 곧바로 /team-lead 스킬로 시작한 세션은 처음엔 등록이 안 되어 있어서 spawn_team_member가 \"아직 등록되지 않았다\"는 에러를 돌려준다 — 그때 이 툴을 먼저 한 번 호출해 스스로를 등록해라. 이미 등록되어 있으면(이 앱을 통해 시작됐거나, 이전에 이미 이 툴을 호출한 경우) 아무것도 바꾸지 않고 그대로 성공을 반환한다.",
            "inputSchema": {
                "type": "object",
                "properties": {
                },
                "additionalProperties": false,
                "$schema": "http://json-schema.org/draft-07/schema#"
            }
        },
        {
            "name": "list_leads",
            "title": "다른 팀장 목록 조회",
            "description": "Claude Team Monitor에 등록된 팀장들의 목록을 돌려준다 — 사용자가 앱에서 붙인 이름표(label), 디렉토리, 지금 실행 중인지, 그리고 SendMessage로 그 팀장에게 메시지를 보낼 때 쓸 \"주소\"를 담는다. 다른 팀장과 소통해야 할 때(사용자가 \"OO 팀장한테 전해줘\"라고 했을 때 등) ListAgents의 자동 생성 제목(이름표와 다르다)으로 찾지 말고 이 툴로 이름표를 보고 찾아라. 주소는 호출한 그 순간의 값이다(팀장이 재시작되거나 제목이 바뀌면 달라진다) — 보내기 직전에 다시 조회해라.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "includeOffline": {"type": "boolean", "description": "오프라인(지금 안 떠있는) 팀장도 목록에 포함할지. 기본 false."}
                },
                "additionalProperties": false,
                "$schema": "http://json-schema.org/draft-07/schema#"
            }
        }
    ])
}

fn text_result(text: impl Into<String>) -> Value {
    json!({"content": [{"type": "text", "text": text.into()}]})
}

fn error_result(text: impl Into<String>) -> Value {
    json!({"content": [{"type": "text", "text": text.into()}], "isError": true})
}

// ---------------------------------------------------------------------------------------------
// 공용 보조
// ---------------------------------------------------------------------------------------------

/// path.resolve와 같은 효과 — 상대 경로면 cwd 기준으로 절대화하고, `.`/`..`를 글자 수준에서 정리한다(디스크를 보지 않는다).
fn resolve_path(raw: &str, cwd: &str) -> PathBuf {
    let p = Path::new(raw);
    let joined = if p.is_absolute() { p.to_path_buf() } else { Path::new(cwd).join(p) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn same_dir(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

fn read_leads(be: &dyn Backend) -> Vec<Value> {
    // leads.json을 Value 그대로 다룬다 — 이 서버가 모르는 필드가 있어도 다시 쓸 때 잃어버리지 않게(앱이 쓰는 필드 집합과 어긋나도 안전).
    std::fs::read_to_string(be.leads_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default()
}

fn write_leads(be: &dyn Backend, leads: &[Value]) -> Result<(), String> {
    write_json_file_atomic(&be.leads_path(), &leads).map_err(|e| e.to_string())
}

fn lead_session_id(lead: &Value) -> &str {
    lead.get("sessionId").and_then(Value::as_str).unwrap_or("")
}

/// 이 서버를 띄운 claude 세션을 `claude agents --json`에서 찾는다.
fn find_calling_agent(be: &dyn Backend) -> Option<AgentEntry> {
    let ppid = be.parent_pid()?;
    be.agents().ok()?.into_iter().find(|a| a.pid == Some(ppid))
}

const AGENT_NOT_FOUND_FOR_SPAWN: &str = "이 MCP 서버를 실행 중인 claude 세션을 claude agents --json 목록에서 찾지 못했습니다 — --bg로 뜬 세션이 아니거나, 방금 시작돼서 아직 목록에 반영되지 않았을 수 있습니다(몇 초 후 다시 시도해보세요).";

// ---------------------------------------------------------------------------------------------
// 도구 구현
// ---------------------------------------------------------------------------------------------

fn spawn_team_member(be: &dyn Backend, args: &Value) -> Value {
    let get = |k: &str| args.get(k).and_then(Value::as_str);
    let (Some(target_dir), Some(instruction), Some(label)) = (get("targetDir"), get("instruction"), get("label")) else {
        return error_result("targetDir, instruction, label은 모두 문자열로 필요합니다.");
    };
    let role = get("role").filter(|r| !r.is_empty());
    let model = get("model");

    let Some(agent) = find_calling_agent(be).filter(|a| !a.session_id.is_empty()) else {
        return error_result(AGENT_NOT_FOUND_FOR_SPAWN);
    };
    let leads = read_leads(be);
    let Some(lead) = leads.iter().find(|l| lead_session_id(l) == agent.session_id) else {
        return error_result("이 세션은 아직 팀장으로 등록되지 않았습니다 — 먼저 mcp__team-monitor__register_as_lead 툴을 호출해 스스로를 등록한 뒤 다시 시도하세요.");
    };

    if instruction.trim().is_empty() {
        return error_result("instruction이 비어있습니다.");
    }
    if label.trim().is_empty() {
        return error_result("이 팀원을 구분할 label을 입력하세요.");
    }

    let cwd = be.cwd();
    let resolved = resolve_path(target_dir, &cwd);
    let approved = lead
        .get("approvedMembers")
        .and_then(Value::as_array)
        .map(|dirs| dirs.iter().filter_map(Value::as_str).any(|d| same_dir(&resolve_path(d, &cwd), &resolved)))
        .unwrap_or(false);
    if !approved {
        return error_result(format!(
            "\"{target_dir}\"는 사전 승인된 디렉토리 목록에 없습니다. 바로 띄우지 말고, SKILL.md의 \"새 팀원 승인 요청\" 절차(~/.claude/claude-team-monitor/requests/에 dir-approval 요청 작성 후 턴 종료)를 먼저 거치세요."
        ));
    }

    // 이 툴은 팀장이 지금 당장 실행할 실제 지시를 그대로 넘기는 구조라 "대기하지 말고 바로 시작하라"가 맞다 —
    // 앱 UI의 2단계 흐름(launch_member)에서만 쓰는 TEAM_MEMBER_STANDBY_NOTE는 붙이지 않는다.
    let role_line = role.map(|r| format!("역할: {r}\n\n")).unwrap_or_default();
    let prompt = format!("{TEAM_MEMBER_BRIEFING}\n\n{role_line}\"\"\"\n{instruction}\n\"\"\"");
    let normalized_model = MEMBER_MODELS.iter().copied().find(|m| Some(*m) == model).unwrap_or("default");

    let resolved_str = resolved.to_string_lossy().to_string();
    let not_ready = be.dir_not_ready_reason(&resolved_str);
    if let Some(reason) = &not_ready {
        eprintln!("[mcp-server] \"{resolved_str}\"는 {reason} (경고만 하고 spawn은 계속 시도합니다)");
    }

    // --name으로 고유한 이름을 주면 스폰 몇 초 뒤부터 그 이름으로 바로 SendMessage가 된다.
    let send_name = format!("tm-{}", be.random_hex8());
    let mut flags = vec!["--bg".to_string(), "--name".to_string(), send_name.clone()];
    if normalized_model != "default" {
        flags.push("--model".to_string());
        flags.push(normalized_model.to_string());
    }
    let secret = lead.get("secret").and_then(Value::as_bool).unwrap_or(false);
    if secret {
        flags.extend(SECRET_MODE_CLI_ARGS.iter().map(|s| s.to_string()));
    }
    let Some(member_id) = be.spawn_bg(&flags, &prompt, &resolved_str) else {
        return error_result(match not_ready {
            Some(reason) => format!(
                "팀원 세션 시작에 실패했습니다 — \"{resolved_str}\"에서 {reason} 이게 원인일 수 있습니다. 그 디렉토리에서 터미널로 claude를 한 번 실행해 승인창을 눌러준 뒤 다시 시도해보세요."
            ),
            None => "claude --bg 실행에 실패했습니다 — claude CLI 설치/로그인 상태 또는 대상 디렉토리를 확인하세요.".to_string(),
        });
    };

    // 목록에 반영되기 전이면 sessionId는 비어 있을 수 있다(등록은 sessionId 없이도 된다).
    let session_id = be.agents().ok().and_then(|list| list.into_iter().find(|a| a.id.as_deref() == Some(member_id.as_str()))).map(|a| a.session_id).filter(|s| !s.is_empty());

    if !is_safe_id(&member_id) {
        return error_result(format!("팀원({member_id})은 떴지만 memberId 형식이 안전하지 않아 등록하지 않았습니다. 직접 ~/.claude/claude-team-monitor/members/ 에 등록을 완료하세요."));
    }
    let lead_id = lead.get("id").and_then(Value::as_str).unwrap_or("");
    let mut record = serde_json::Map::new();
    record.insert("memberId".into(), json!(member_id));
    record.insert("leadId".into(), json!(lead_id));
    record.insert("createdAt".into(), json!(be.now_ms()));
    if let Some(r) = role {
        record.insert("role".into(), json!(r));
    }
    record.insert("label".into(), json!(label.trim()));
    if let Some(s) = &session_id {
        record.insert("sessionId".into(), json!(s));
    }
    if secret {
        record.insert("secret".into(), json!(true));
    }
    if let Err(e) = write_json_file_atomic(&be.members_dir().join(format!("{member_id}.json")), &Value::Object(record)) {
        return error_result(format!(
            "팀원({member_id})은 떴지만 등록에 실패했습니다: {e}. 직접 ~/.claude/claude-team-monitor/members/{member_id}.json을 만들어 등록을 완료하세요."
        ));
    }

    text_result(format!(
        "팀원을 생성하고 등록했습니다. memberId: {member_id}, 이름: {label}, 역할: {}, 디렉토리: {resolved_str}, SendMessage 이름: {send_name} (스폰 직후 몇 초는 ListAgents에 아직 안 보일 수 있다)",
        role.unwrap_or("(없음)")
    ))
}

fn register_as_lead(be: &dyn Backend, args: &Value) -> Value {
    let Some(agent) = find_calling_agent(be).filter(|a| !a.session_id.is_empty() && a.id.is_some()) else {
        return error_result("이 세션을 claude agents --json 목록에서 찾지 못했습니다 — --bg로 뜬 세션이 아니거나, 방금 시작돼서 아직 목록에 반영되지 않았을 수 있습니다(몇 초 후 다시 시도해보세요).");
    };
    if agent.kind != "background" {
        return error_result("interactive(사람이 직접 타이핑하는) 세션은 팀장으로 등록할 수 없습니다 — claude --bg로 띄운 세션만 지원합니다.");
    }
    let agent_id = agent.id.clone().unwrap_or_default();
    if let Some(existing) = read_leads(be).iter().find(|l| lead_session_id(l) == agent.session_id) {
        let id = existing.get("id").and_then(Value::as_str).unwrap_or("");
        return text_result(format!("이미 팀장으로 등록되어 있습니다(id: {id})."));
    }
    // 승인된 디렉토리 목록은 사용자만 정한다 — 모델이 인자로 넘긴 approvedMembers는 무시한다(스스로 승인하면 승인 절차가 무의미해진다).
    // 팀원 디렉토리는 앱 화면의 승인 요청 흐름으로만 채워진다.
    let ignored_approved = args.get("approvedMembers").is_some();
    let approved: Vec<Value> = Vec::new();
    let target_dir = if agent.cwd.is_empty() { be.cwd() } else { agent.cwd.clone() };
    let new_lead = json!({
        "id": agent_id,
        "sessionId": agent.session_id,
        "targetDir": target_dir,
        "launchedAt": agent.started_at.unwrap_or_else(|| be.now_ms()),
        "approvedMembers": approved,
        "internalId": be.new_uuid(),
    });
    // 위에서 읽은 뒤 다른 팀장의 등록/변경이 먼저 반영됐을 수 있다 — 쓰기 직전에 다시 읽어 최신 상태 위에 얹는다.
    let mut latest = read_leads(be);
    if latest.iter().any(|l| lead_session_id(l) == agent.session_id) {
        return text_result(format!("이미 팀장으로 등록되어 있습니다(id: {agent_id})."));
    }
    latest.push(new_lead);
    if let Err(e) = write_leads(be, &latest) {
        return error_result(format!("등록에 실패했습니다: {e}"));
    }
    let note = if ignored_approved { " approvedMembers 인자는 무시했습니다 — 팀원 디렉토리는 SKILL.md의 \"새 팀원 승인 요청\" 절차로 사용자 승인을 받아야 합니다." } else { "" };
    text_result(format!("팀장으로 등록했습니다(id: {agent_id}, 디렉토리: {target_dir}).{note}"))
}

fn list_leads(be: &dyn Backend, args: &Value) -> Value {
    let include_offline = args.get("includeOffline").and_then(Value::as_bool).unwrap_or(false);
    let me = find_calling_agent(be);
    let agents = match be.agents() {
        Ok(a) => a,
        Err(_) => return error_result("claude agents --json을 읽지 못했습니다 — 잠시 후 다시 시도하세요."),
    };
    let mut name_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for a in &agents {
        if let Some(n) = a.name.as_deref().filter(|n| !n.is_empty()) {
            *name_counts.entry(n).or_insert(0) += 1;
        }
    }
    let mut lines: Vec<String> = Vec::new();
    for lead in read_leads(be) {
        let sid = lead_session_id(&lead).to_string();
        let live = agents.iter().find(|a| !sid.is_empty() && a.session_id == sid);
        if live.is_none() && !include_offline {
            continue;
        }
        let is_me = matches!((&me, live), (Some(m), Some(l)) if m.session_id == l.session_id);
        let target_dir = lead.get("targetDir").and_then(Value::as_str).unwrap_or("");
        let dir_name = Path::new(target_dir).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let label = lead.get("label").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        let ai_title = lead.get("aiTitle").and_then(Value::as_str).filter(|s| !s.is_empty());
        let title = label.or(ai_title).unwrap_or("(이름표 없음)");
        let address = match live {
            None => "오프라인 — SendMessage 불가".to_string(),
            Some(_) if is_me => "바로 너 자신 — 자기 자신에게 보내지 마라".to_string(),
            Some(l) => match l.name.as_deref().filter(|n| !n.is_empty()) {
                None => "이름 없음 — 지금은 주소를 못 잡는다".to_string(),
                Some(n) if name_counts.get(n).copied().unwrap_or(0) > 1 => format!("\"{n}\" (이름이 중복돼서 정확히 지목 불가 — 사용자에게 확인해라)"),
                Some(n) => format!("to: \"{n}\""),
            },
        };
        let status = match live {
            Some(l) => l.status.clone().filter(|s| !s.is_empty()).or_else(|| l.state.clone().filter(|s| !s.is_empty())).unwrap_or_else(|| "?".to_string()),
            None => "-".to_string(),
        };
        let secret = if lead.get("secret").and_then(Value::as_bool).unwrap_or(false) { " | 시크릿 모드" } else { "" };
        lines.push(format!("- {title} | 디렉토리: {dir_name} ({target_dir}) | 상태: {status}{secret} | 주소: {address}"));
    }
    if lines.is_empty() {
        return text_result("조회된 팀장이 없습니다.");
    }
    text_result(format!("등록된 팀장 {}명:\n{}", lines.len(), lines.join("\n")))
}

pub fn call_tool(be: &dyn Backend, name: &str, args: &Value) -> Value {
    let empty = json!({});
    let args = if args.is_object() { args } else { &empty };
    match name {
        "spawn_team_member" => spawn_team_member(be, args),
        "register_as_lead" => register_as_lead(be, args),
        "list_leads" => list_leads(be, args),
        other => error_result(format!("알 수 없는 도구입니다: {other}")),
    }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC 처리
// ---------------------------------------------------------------------------------------------

/// 요청 하나를 처리한다. 알림(id 없음)이면 None, 요청이면 응답 메시지를 돌려준다.
pub fn handle_message(be: &dyn Backend, msg: &Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str)?;
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let id = match id {
        Some(i) if !i.is_null() => i,
        _ => return None, // 알림(notifications/initialized 등)에는 응답하지 않는다
    };
    let result: Result<Value, (i64, String)> = match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = SUPPORTED_PROTOCOLS.iter().copied().find(|v| *v == requested).unwrap_or(SUPPORTED_PROTOCOLS[0]);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")}
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tool_definitions()})),
        "tools/call" => match params.get("name").and_then(Value::as_str) {
            Some(name) => Ok(call_tool(be, name, params.get("arguments").unwrap_or(&Value::Null))),
            None => Err((-32602, "도구 이름(name)이 필요합니다.".to_string())),
        },
        other => Err((-32601, format!("지원하지 않는 메서드입니다: {other}"))),
    };
    Some(match result {
        Ok(r) => json!({"jsonrpc": "2.0", "id": id, "result": r}),
        Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
    })
}

// ---------------------------------------------------------------------------------------------
// 실제 환경 + stdio 루프
// ---------------------------------------------------------------------------------------------

struct RealBackend;

impl Backend for RealBackend {
    fn agents(&self) -> Result<Vec<AgentEntry>, String> {
        let v = crate::agents_json::get_agents_json()?;
        serde_json::from_value::<Vec<AgentEntry>>(v).map_err(|e| format!("JSON 파싱 실패: {e}"))
    }
    fn parent_pid(&self) -> Option<i64> {
        parent_pid()
    }
    fn leads_path(&self) -> PathBuf {
        crate::paths::leads_path()
    }
    fn members_dir(&self) -> PathBuf {
        crate::paths::members_dir()
    }
    fn spawn_bg(&self, flags: &[String], prompt: &str, cwd: &str) -> Option<String> {
        crate::resume::run_claude_bg_blocking(flags, &crate::long_prompt_guard::resolve_long_prompt(prompt), cwd)
    }
    fn dir_not_ready_reason(&self, dir: &str) -> Option<String> {
        let r = crate::claude_readiness::check_directory_claude_ready(dir);
        if r.ready { None } else { Some(r.reason.unwrap_or_default()) }
    }
    fn now_ms(&self) -> i64 {
        crate::timing::now_ms()
    }
    fn random_hex8(&self) -> String {
        uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
    }
    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn cwd(&self) -> String {
        std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    }
}

/// 이 프로세스를 띄운 부모(claude 세션)의 pid.
#[cfg(windows)]
fn parent_pid() -> Option<i64> {
    use std::ffi::c_void;
    #[repr(C)]
    struct ProcessBasicInformation {
        exit_status: i32,
        peb_base_address: *mut c_void,
        affinity_mask: usize,
        base_priority: i32,
        unique_process_id: usize,
        inherited_from_unique_process_id: usize,
    }
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryInformationProcess(process: *mut c_void, class: u32, info: *mut c_void, len: u32, ret_len: *mut u32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
    }
    // SAFETY: 현재 프로세스 핸들(가짜 핸들)로 자기 정보를 조회할 뿐이며, 버퍼 크기와 레이아웃은 PROCESS_BASIC_INFORMATION과 같다.
    unsafe {
        let mut info: ProcessBasicInformation = std::mem::zeroed();
        let status = NtQueryInformationProcess(GetCurrentProcess(), 0, &mut info as *mut _ as *mut c_void, std::mem::size_of::<ProcessBasicInformation>() as u32, std::ptr::null_mut());
        if status == 0 { Some(info.inherited_from_unique_process_id as i64) } else { None }
    }
}

#[cfg(unix)]
fn parent_pid() -> Option<i64> {
    Some(std::os::unix::process::parent_id() as i64)
}

/// `<앱 exe> --mcp-server`의 본체 — stdin에서 줄 단위 JSON-RPC를 읽어 처리하고, stdin이 닫히면(claude 세션 종료) 끝난다.
pub fn run_stdio() {
    crate::logging::install_panic_hook();
    static OUT: Mutex<()> = Mutex::new(());
    let stdin = std::io::stdin();
    let mut handles = Vec::new();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[mcp-server] JSON을 읽지 못했습니다: {e}");
                continue;
            }
        };
        // 도구 호출은 claude 실행을 기다리느라 오래 걸릴 수 있어(최대 45초) 스레드로 처리한다 — 그동안 ping 등 다른 요청이 막히지 않게.
        handles.push(std::thread::spawn(move || {
            if let Some(resp) = handle_message(&RealBackend, &msg) {
                let _guard = OUT.lock().unwrap_or_else(|e| e.into_inner());
                let mut out = std::io::stdout().lock();
                let _ = writeln!(out, "{resp}");
                let _ = out.flush();
            }
        }));
        handles.retain(|h| !h.is_finished());
    }
    // stdin이 닫혀도 진행 중이던 응답은 마저 쓰고 끝낸다.
    for h in handles {
        let _ = h.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Fake {
        dir: PathBuf,
        agents: Result<Vec<AgentEntry>, String>,
        ppid: Option<i64>,
        spawn_result: Option<String>,
        not_ready: Option<String>,
        spawned: RefCell<Vec<(Vec<String>, String, String)>>,
        counter: RefCell<u32>,
    }

    fn agent(id: &str, session: &str, pid: i64, kind: &str, name: Option<&str>) -> AgentEntry {
        AgentEntry {
            id: Some(id.to_string()),
            pid: Some(pid),
            cwd: "C:\\work".to_string(),
            kind: kind.to_string(),
            started_at: Some(1_700_000_000_000),
            session_id: session.to_string(),
            name: name.map(str::to_string),
            status: Some("idle".to_string()),
            state: None,
            waiting_for: None,
        }
    }

    impl Fake {
        fn new(agents: Vec<AgentEntry>) -> Fake {
            let dir = std::env::temp_dir().join(format!("ctm-mcp-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Fake { dir, agents: Ok(agents), ppid: Some(100), spawn_result: Some("abcd1234".to_string()), not_ready: None, spawned: RefCell::new(vec![]), counter: RefCell::new(0) }
        }
        fn put_leads(&self, leads: Value) {
            std::fs::write(self.leads_path(), serde_json::to_string(&leads).unwrap()).unwrap();
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Backend for Fake {
        fn agents(&self) -> Result<Vec<AgentEntry>, String> {
            self.agents.clone()
        }
        fn parent_pid(&self) -> Option<i64> {
            self.ppid
        }
        fn leads_path(&self) -> PathBuf {
            self.dir.join("leads.json")
        }
        fn members_dir(&self) -> PathBuf {
            self.dir.join("members")
        }
        fn spawn_bg(&self, flags: &[String], prompt: &str, cwd: &str) -> Option<String> {
            self.spawned.borrow_mut().push((flags.to_vec(), prompt.to_string(), cwd.to_string()));
            self.spawn_result.clone()
        }
        fn dir_not_ready_reason(&self, _dir: &str) -> Option<String> {
            self.not_ready.clone()
        }
        fn now_ms(&self) -> i64 {
            1_800_000_000_000
        }
        fn random_hex8(&self) -> String {
            "deadbeef".to_string()
        }
        fn new_uuid(&self) -> String {
            *self.counter.borrow_mut() += 1;
            format!("uuid-{}", self.counter.borrow())
        }
        fn cwd(&self) -> String {
            if cfg!(windows) { "C:\\work".to_string() } else { "/work".to_string() }
        }
    }

    fn text_of(v: &Value) -> String {
        v["content"][0]["text"].as_str().unwrap_or("").to_string()
    }
    fn is_error(v: &Value) -> bool {
        v.get("isError").and_then(Value::as_bool).unwrap_or(false)
    }
    fn abs(p: &str) -> String {
        if cfg!(windows) { format!("C:\\{}", p.replace('/', "\\")) } else { format!("/{p}") }
    }

    #[test]
    fn initialize_echoes_a_supported_protocol_version_and_falls_back_to_the_latest() {
        let be = Fake::new(vec![]);
        let r = handle_message(&be, &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}})).unwrap();
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(r["result"]["serverInfo"]["name"], SERVER_NAME);
        assert!(r["result"]["capabilities"]["tools"].is_object());
        let r = handle_message(&be, &json!({"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"1999-01-01"}})).unwrap();
        assert_eq!(r["result"]["protocolVersion"], SUPPORTED_PROTOCOLS[0]);
    }

    #[test]
    fn notifications_get_no_response_and_unknown_methods_get_a_jsonrpc_error() {
        let be = Fake::new(vec![]);
        assert!(handle_message(&be, &json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        let r = handle_message(&be, &json!({"jsonrpc":"2.0","id":7,"method":"resources/list"})).unwrap();
        assert_eq!(r["error"]["code"], -32601);
        assert_eq!(r["id"], 7);
        let r = handle_message(&be, &json!({"jsonrpc":"2.0","id":8,"method":"ping"})).unwrap();
        assert_eq!(r["result"], json!({}));
    }

    #[test]
    fn tools_list_exposes_the_three_tools_with_the_same_names_and_required_fields_as_before() {
        let be = Fake::new(vec![]);
        let r = handle_message(&be, &json!({"jsonrpc":"2.0","id":3,"method":"tools/list"})).unwrap();
        let tools = r["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["spawn_team_member", "register_as_lead", "list_leads"]);
        let spawn = &tools[0]["inputSchema"];
        assert_eq!(spawn["required"], json!(["targetDir", "instruction", "label"]));
        assert_eq!(spawn["properties"]["model"]["enum"], json!(["default", "haiku", "sonnet", "opus", "fable"]));
        // lead_lifecycle.rs가 --allowedTools로 허용하는 이름과 서버 이름이 어긋나면 팀장이 도구를 못 쓴다
        assert!(tools.iter().all(|t| t["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn spawn_requires_the_calling_session_to_be_found_and_registered() {
        let be = Fake::new(vec![agent("lead1", "sess-lead", 999, "background", None)]); // ppid(100)와 안 맞음
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": abs("repo"), "instruction": "x", "label": "a"}));
        assert!(is_error(&r) && text_of(&r).contains("찾지 못했습니다"));
        let be = Fake::new(vec![agent("lead1", "sess-lead", 100, "background", None)]); // 찾았지만 leads.json에 없음
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": abs("repo"), "instruction": "x", "label": "a"}));
        assert!(is_error(&r) && text_of(&r).contains("register_as_lead"));
    }

    #[test]
    fn spawn_refuses_unapproved_directories_and_empty_fields() {
        let be = Fake::new(vec![agent("lead1", "sess-lead", 100, "background", None)]);
        be.put_leads(json!([{"id":"lead1","sessionId":"sess-lead","targetDir":abs("main"),"approvedMembers":[abs("ok")]}]));
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": abs("other"), "instruction": "x", "label": "a"}));
        assert!(is_error(&r) && text_of(&r).contains("사전 승인된 디렉토리"));
        assert!(be.spawned.borrow().is_empty(), "승인 안 된 곳에는 절대 띄우지 않는다");
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": abs("ok"), "instruction": "   ", "label": "a"}));
        assert!(text_of(&r).contains("instruction이 비어"));
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": abs("ok"), "instruction": "x", "label": " "}));
        assert!(text_of(&r).contains("label"));
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": abs("ok")}));
        assert!(is_error(&r), "필수 필드가 빠지면 에러");
        assert!(be.spawned.borrow().is_empty());
    }

    #[test]
    fn approved_directory_matching_normalizes_dot_segments_and_trailing_separators() {
        let be = Fake::new(vec![agent("lead1", "sess-lead", 100, "background", None)]);
        be.put_leads(json!([{"id":"lead1","sessionId":"sess-lead","targetDir":abs("main"),"approvedMembers":[abs("ok/")]}]));
        let sneaky = format!("{}{}", abs("ok/sub"), if cfg!(windows) { "\\.." } else { "/.." });
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": sneaky, "instruction": "x", "label": "a"}));
        assert!(!is_error(&r), "정리하면 승인된 디렉토리와 같은 곳: {}", text_of(&r));
        let escape = format!("{}{}", abs("ok"), if cfg!(windows) { "\\..\\other" } else { "/../other" });
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": escape, "instruction": "x", "label": "a"}));
        assert!(is_error(&r), "..로 빠져나가 승인 밖으로 가는 경로는 막힌다");
    }

    #[test]
    fn spawn_launches_with_briefing_role_model_and_registers_the_member() {
        let mut be = Fake::new(vec![agent("lead1", "sess-lead", 100, "background", None), agent("abcd1234", "sess-member", 555, "background", Some("tm-deadbeef"))]);
        be.ppid = Some(100);
        be.put_leads(json!([{"id":"lead1","sessionId":"sess-lead","targetDir":abs("main"),"approvedMembers":[abs("repo")],"secret":true,"extraField":"keep"}]));
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": abs("repo"), "instruction": "리뷰해줘", "label": " 리뷰어 ", "role": "reviewer", "model": "opus"}));
        assert!(!is_error(&r), "{}", text_of(&r));
        assert!(text_of(&r).contains("abcd1234") && text_of(&r).contains("tm-deadbeef"));
        let spawned = be.spawned.borrow();
        let (flags, prompt, cwd) = &spawned[0];
        assert_eq!(&flags[..3], ["--bg", "--name", "tm-deadbeef"]);
        assert!(flags.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(flags.windows(2).any(|w| w == ["--setting-sources", "project,local"]), "시크릿 팀장의 팀원은 시크릿 설정을 이어받는다");
        assert!(prompt.starts_with(TEAM_MEMBER_BRIEFING) && prompt.contains("역할: reviewer") && prompt.contains("\"\"\"\n리뷰해줘\n\"\"\""));
        assert!(!prompt.contains("준비 완료 응답만"), "대기 지시문은 붙이지 않는다");
        assert_eq!(cwd, &abs("repo"));
        let member: Value = serde_json::from_str(&std::fs::read_to_string(be.members_dir().join("abcd1234.json")).unwrap()).unwrap();
        assert_eq!(member["leadId"], "lead1");
        assert_eq!(member["label"], "리뷰어");
        assert_eq!(member["role"], "reviewer");
        assert_eq!(member["sessionId"], "sess-member");
        assert_eq!(member["secret"], true);
    }

    #[test]
    fn spawn_failure_reports_readiness_when_that_is_the_likely_cause_and_leaves_no_member_file() {
        let mut be = Fake::new(vec![agent("lead1", "sess-lead", 100, "background", None)]);
        be.spawn_result = None;
        be.not_ready = Some("신뢰 승인이 안 됨.".to_string());
        be.put_leads(json!([{"id":"lead1","sessionId":"sess-lead","targetDir":abs("main"),"approvedMembers":[abs("repo")]}]));
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": abs("repo"), "instruction": "x", "label": "a"}));
        assert!(is_error(&r) && text_of(&r).contains("신뢰 승인이 안 됨."));
        assert!(!be.members_dir().exists() || std::fs::read_dir(be.members_dir()).unwrap().next().is_none());
        be.not_ready = None;
        let r = call_tool(&be, "spawn_team_member", &json!({"targetDir": abs("repo"), "instruction": "x", "label": "a"}));
        assert!(text_of(&r).contains("claude --bg 실행에 실패"));
    }

    #[test]
    fn register_as_lead_writes_a_new_record_once_and_keeps_unknown_fields_of_other_leads() {
        let be = Fake::new(vec![agent("newlead", "sess-new", 100, "background", None)]);
        be.put_leads(json!([{"id":"old","sessionId":"sess-old","targetDir":abs("a"),"approvedMembers":[],"futureField":{"x":1}}]));
        let r = call_tool(&be, "register_as_lead", &json!({"approvedMembers": [abs("repo"), 5]}));
        assert!(!is_error(&r) && text_of(&r).contains("팀장으로 등록했습니다"), "{}", text_of(&r));
        let leads: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(be.leads_path()).unwrap()).unwrap();
        assert_eq!(leads.len(), 2);
        assert_eq!(leads[0]["futureField"], json!({"x": 1}), "다른 팀장 레코드의 모르는 필드를 잃지 않는다");
        assert_eq!(leads[1]["id"], "newlead");
        assert_eq!(leads[1]["approvedMembers"], json!([]), "모델이 넘긴 승인 목록은 무시한다");
        assert!(text_of(&r).contains("무시"));
        assert_eq!(leads[1]["internalId"], "uuid-1");
        let again = call_tool(&be, "register_as_lead", &json!({}));
        assert!(text_of(&again).contains("이미 팀장으로 등록"));
        let leads: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(be.leads_path()).unwrap()).unwrap();
        assert_eq!(leads.len(), 2, "두 번째 호출은 아무것도 바꾸지 않는다");
    }

    #[test]
    fn register_as_lead_rejects_interactive_sessions_and_unknown_callers() {
        let be = Fake::new(vec![agent("human", "sess-h", 100, "interactive", None)]);
        let r = call_tool(&be, "register_as_lead", &json!({}));
        assert!(is_error(&r) && text_of(&r).contains("interactive"));
        assert!(!be.leads_path().exists());
        let mut be = Fake::new(vec![]);
        be.ppid = None;
        assert!(is_error(&call_tool(&be, "register_as_lead", &json!({}))));
    }

    #[test]
    fn list_leads_hides_offline_by_default_marks_self_and_flags_duplicate_names() {
        let be = Fake::new(vec![
            agent("l1", "s1", 100, "background", Some("alpha")),
            agent("l2", "s2", 200, "background", Some("dup")),
            agent("l3", "s3", 300, "background", Some("dup")),
        ]);
        be.put_leads(json!([
            {"id":"l1","sessionId":"s1","targetDir":abs("one"),"label":"나"},
            {"id":"l2","sessionId":"s2","targetDir":abs("two"),"label":"둘"},
            {"id":"l3","sessionId":"s3","targetDir":abs("three"),"aiTitle":"제목"},
            {"id":"l4","sessionId":"s4","targetDir":abs("four"),"label":"꺼짐","secret":true}
        ]));
        let t = text_of(&call_tool(&be, "list_leads", &json!({})));
        assert!(t.starts_with("등록된 팀장 3명:"), "{t}");
        assert!(t.contains("바로 너 자신") && t.contains("중복돼서") && t.contains("- 제목 |"));
        assert!(!t.contains("꺼짐"));
        let t = text_of(&call_tool(&be, "list_leads", &json!({"includeOffline": true})));
        assert!(t.starts_with("등록된 팀장 4명:") && t.contains("오프라인") && t.contains("시크릿 모드"));
        let be = Fake::new(vec![]);
        assert_eq!(text_of(&call_tool(&be, "list_leads", &json!({}))), "조회된 팀장이 없습니다.");
    }

    #[test]
    fn list_leads_reports_a_failed_agents_call_and_unknown_tools_are_errors() {
        let mut be = Fake::new(vec![]);
        be.agents = Err("boom".to_string());
        assert!(is_error(&call_tool(&be, "list_leads", &json!({}))));
        assert!(is_error(&call_tool(&be, "nope", &json!({}))));
        let r = handle_message(&be, &json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{}})).unwrap();
        assert_eq!(r["error"]["code"], -32602);
    }

    #[test]
    fn the_real_backend_knows_its_parent_process() {
        let pid = parent_pid().expect("부모 pid를 알아야 한다");
        assert!(pid > 0 && pid != std::process::id() as i64, "부모 pid는 자기 자신이 아니다: {pid}");
    }
}
