// 오른쪽 패널의 "스크립트" 슬롯 실행기 — 사용자가 쓰거나(또는 AI가 써 준) 작은 스크립트를 이 PC에서 돌리고, 표준 출력을 패널에 보여 준다.
// 출력 형식은 슬롯마다 고른다: "markdown"(글·표·링크·data: 이미지) 또는 "html"(SVG·CSS 그래픽 — 화면 쪽에서 스크립트 실행이 막힌 격리 프레임에 그린다).
//
// 안전에 대한 판단: 이 앱은 서버와 연결돼 있지 않고 스크립트는 사용자 본인의 PC 권한으로 본인이 저장한 것만 돌기 때문에 샌드박스는 두지 않았다
// (잘못되거나 나쁜 스크립트의 피해는 그 사용자에게만 간다). 대신 앱이 같이 멈추지 않게 (1) 슬롯마다 정한 제한 시간(ms), (2) 출력 길이 제한을 둔다.
// 앱을 지키는 장치: 제한 시간(ms) 초과 시 종료, 표준 출력이 MAX_CAPTURE_BYTES를 넘으면 종료(메모리 보호), 스크립트가 끝난 뒤 출력 통로를 물고 남은 자식이 있어도 READER_GRACE만 기다림.
// 알려진 한계: 제한 시간이 지나면 스크립트 프로세스만 종료한다 — 스크립트가 일부러 분리해(detached) 띄운 자식 프로세스는 그대로 끝날 때까지 남는다.
//
// 스크립트는 슬롯 id로 정한 파일(~/.claude/claude-team-monitor/panel/scripts/<id>.<확장자>)에 써서 실행한다(명령줄 인용·길이 문제를 피한다).
// 팀장 정보 등은 환경 변수로 넘긴다(아래 ENV_VAR_DOCS 표가 유일한 기준).

use crate::session_registry::LeadRecord;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wait_timeout::ChildExt;

/// 스크립트 출력(표준 출력)을 메모리에 담는 최대 크기. 넘으면 스크립트를 중단한다 — 출력 폭탄이 앱 메모리를 먹지 못하게(시험에서 3초 만에 3.4GB까지 늘어난 것을 막는 장치).
const MAX_CAPTURE_BYTES: usize = 6 * 1024 * 1024;
/// 표준 오류는 앞부분만 담는다(넘치는 건 버리되 계속 비워서 스크립트가 막히지 않게 한다).
const MAX_STDERR_BYTES: usize = 256 * 1024;
/// 스크립트가 끝난 뒤, 출력 통로를 물고 있는 자식 프로세스가 남아 있어도 통로가 닫히길 기다리는 최대 시간.
const READER_GRACE: Duration = Duration::from_millis(400);

pub(crate) const INTERPRETERS: [&str; 3] = ["node", "python", "shell"];
pub(crate) const OUTPUT_FORMATS: [&str; 2] = ["markdown", "html"];
pub(crate) const DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub(crate) const MIN_TIMEOUT_MS: u64 = 500;
pub(crate) const MAX_TIMEOUT_MS: u64 = 600_000;
pub(crate) const MAX_SCRIPT_CHARS: usize = 20_000;
/// 출력 길이 제한(글자 수). 그래픽은 data: 이미지(base64)나 SVG가 길어지므로 넉넉하게 둔다.
pub(crate) const MAX_OUTPUT_CHARS: usize = 200_000;

// ---------------------------------------------------------------------------------------------
// 스크립트에 앱이 주는 정보 — 이 표가 유일한 기준이다: 실제로 넘기는 환경 변수(script_env), 설정 화면의 안내, AI에게 주는 요청문이 모두 여기서 나온다.
// 새 정보를 주려면 여기에 한 줄을 더하고 script_env에서 값을 채우면 안내와 AI 요청문에 자동으로 반영된다(둘이 어긋나면 시험이 실패한다).
// ---------------------------------------------------------------------------------------------

pub(crate) struct EnvVarDoc {
    pub name: &'static str,
    /// 무엇인지(값의 모양 포함)
    pub what: &'static str,
    /// 비어 있는 경우
    pub when_empty: &'static str,
}

pub(crate) const ENV_VAR_DOCS: [EnvVarDoc; 11] = [
    EnvVarDoc { name: "CTM_OUTPUT_FORMAT", what: "이 슬롯이 기대하는 출력 형식: `markdown` 또는 `html`. 아래 '출력 형식'을 보고 그 형식으로 낸다", when_empty: "항상 채워진다" },
    EnvVarDoc { name: "CTM_ALLOW_JS", what: "이 슬롯이 `html` 출력에서 JavaScript 실행을 허용했는지: `true` 또는 `false`. `true`일 때만 출력 HTML 안의 `<script>`가 돈다(아래 '출력 형식'의 JavaScript 허용 부분)", when_empty: "항상 채워진다" },
    EnvVarDoc { name: "CTM_LEAD_ID", what: "선택한 팀장의 앱 내부 id (예: `ed09bf70`)", when_empty: "팀장을 고르지 않았을 때" },
    EnvVarDoc { name: "CTM_LEAD_LABEL", what: "사용자가 팀장에게 붙인 이름 (예: `g1cl-front-leader`)", when_empty: "팀장을 고르지 않았거나 이름을 안 붙였을 때" },
    EnvVarDoc { name: "CTM_LEAD_TITLE", what: "claude가 세션에 자동으로 붙인 주제 (예: `team lead launch setup`)", when_empty: "팀장을 고르지 않았거나 아직 주제가 없을 때" },
    EnvVarDoc { name: "CTM_LEAD_DIR", what: "선택한 팀장의 작업 폴더 절대 경로. 스크립트의 현재 작업 디렉터리(cwd)이기도 하다", when_empty: "팀장을 고르지 않았을 때(이때 cwd는 임시 폴더)" },
    EnvVarDoc { name: "CTM_SESSION_ID", what: "선택한 팀장의 claude 세션 id (UUID)", when_empty: "팀장을 고르지 않았을 때" },
    EnvVarDoc { name: "CTM_SESSION_FILE", what: "선택한 팀장의 대화 기록 파일 경로(JSONL: 한 줄이 JSON 하나. 사용자·답변·도구 호출·도구 결과가 시간순으로 들어 있고 각 줄에 `timestamp`가 있다). 팀장이 한 일을 직접 분석할 때 읽는다", when_empty: "팀장을 고르지 않았을 때(파일이 아직 없으면 경로만 있고 파일은 없을 수 있다)" },
    EnvVarDoc { name: "CTM_LEADS_FILE", what: "이 앱에 등록된 **모든** 팀장 목록 파일 경로(JSON 배열). 항목: `id`, `label`(선택), `aiTitle`(선택), `targetDir`, `sessionId`, `launchedAt`(시작 시각, epoch ms), `internalId`, `approvedMembers`(허용한 팀원 폴더 배열). 종료된(히스토리) 팀장도 들어 있다. 읽기 전용으로만 쓸 것(고치면 앱이 망가진다)", when_empty: "항상 채워진다(팀장 선택과 무관)" },
    EnvVarDoc { name: "CTM_CLAUDE_HOME", what: "claude 홈 폴더 절대 경로(보통 사용자 홈의 `.claude`). 아래에 `projects/`(대화 기록), `jobs/`(백그라운드 세션 상태) 등이 있다", when_empty: "항상 채워진다" },
    EnvVarDoc { name: "CTM_APP_VERSION", what: "이 앱의 버전 문자열 (예: `0.1.1`)", when_empty: "항상 채워진다" },
];

/// 스크립트에 넘길 환경 변수 전부(팀장이 없으면 팀장 관련 값은 빈 문자열). 이름은 ENV_VAR_DOCS와 같아야 한다.
pub(crate) fn script_env(lead: Option<&LeadRecord>, output_format: &str, allow_js: bool) -> Vec<(&'static str, String)> {
    let (id, label, title, dir, session_id, session_file) = match lead {
        Some(l) => (
            l.id.clone(),
            l.label.clone().unwrap_or_default(),
            l.ai_title.clone().unwrap_or_default(),
            l.target_dir.clone(),
            l.session_id.clone(),
            crate::transcript::session_file_path(&l.target_dir, &l.session_id).to_string_lossy().to_string(),
        ),
        None => Default::default(),
    };
    vec![
        ("CTM_OUTPUT_FORMAT", output_format.to_string()),
        ("CTM_ALLOW_JS", if allow_js && output_format == "html" { "true" } else { "false" }.to_string()),
        ("CTM_LEAD_ID", id),
        ("CTM_LEAD_LABEL", label),
        ("CTM_LEAD_TITLE", title),
        ("CTM_LEAD_DIR", dir),
        ("CTM_SESSION_ID", session_id),
        ("CTM_SESSION_FILE", session_file),
        ("CTM_LEADS_FILE", crate::paths::leads_path().to_string_lossy().to_string()),
        ("CTM_CLAUDE_HOME", crate::paths::claude_home().to_string_lossy().to_string()),
        ("CTM_APP_VERSION", env!("CARGO_PKG_VERSION").to_string()),
    ]
}

/// 스크립트 작성 안내(마크다운) — 설정 화면에 그대로 보여 주고, AI에게도 그대로 준다. 사실이 바뀌면 여기만 고친다.
pub(crate) fn reference_markdown() -> String {
    let table: String = ENV_VAR_DOCS.iter().map(|d| format!("| `{}` | {} | {} |\n", d.name, d.what, d.when_empty)).collect();
    format!(
        "## 스크립트가 받는 정보 (환경 변수)\n\n\
        앱이 스크립트를 실행할 때 아래 환경 변수를 넣어 준다. 이 표에 없는 것은 앱이 주지 않는다.\n\n\
        | 이름 | 내용 | 비어 있을 때 |\n|---|---|---|\n{table}\n\
        ## 실행 방식\n\n\
        - 스크립트는 **실행할 때마다 새 프로세스**로 돈다(이전 실행의 변수·상태가 남지 않는다). 패널을 보는 동안 몇 초마다, 새로고침 버튼을 누를 때, 팀장을 바꿀 때 실행된다.\n\
        - 실행 환경: Node.js(`node`), Python(`python`; macOS·Linux는 `python3`), 셸(Windows는 PowerShell, 그 외는 `sh`). 외부 패키지 설치는 전제하지 않는다 — 내장 모듈만 쓴다.\n\
        - 표준 입력은 비어 있다(대화형 입력 불가). 이 앱을 띄운 사용자 계정의 환경변수·PATH를 그대로 물려받으므로 `git`, `gh` 같은 명령도 그 사용자 PC에 설치돼 있으면 쓸 수 있다.\n\
        - 종료 코드가 0이 아니면 실패로 보고, 표준 오류의 앞부분이 패널에 오류로 표시된다. 정상일 때 표준 오류는 패널에 표시되지 않지만 '최근 에러'에 기록된다.\n\
        - 슬롯마다 정한 제한 시간(ms)을 넘으면 중단된다(기본 10000ms). 출력은 {max}자까지만 보이고, 표준 출력이 약 6MB를 넘게 쏟아지면 스크립트를 중단한다.\n\n\
        ## 출력 형식 — 슬롯마다 둘 중 하나(`CTM_OUTPUT_FORMAT`)\n\n\
        **표준 출력**에 낸 내용이 패널에 그대로 표시된다. 그 슬롯의 형식에 맞춰 낸다.\n\n\
        ### `markdown` (글 중심)\n\n\
        - 지원: 제목(`#`은 한 단계 낮춰 보임), **굵게**, *기울임*, `인라인 코드`, 코드 블록, 목록(`-`, `1.`), 표, 인용(`>`), 구분선(`---`), 링크 `[글](https://주소)`와 맨 주소(**http/https만** 링크가 되며 누르면 기본 브라우저로 열린다).\n\
        - 이미지: `![설명](data:image/png;base64,....)` 처럼 **`data:` 주소(png, jpeg, gif, webp, svg+xml)만** 보인다. 파일 경로나 http 주소 이미지는 보이지 않는다(스크립트가 파일을 읽어 base64로 바꿔 넣어야 한다).\n\
        - 지원하지 않음: HTML, 색·글꼴 지정, 버튼·입력 같은 상호작용.\n\n\
        ### `html` (그래픽 중심 — 차트·카드·색 배치)\n\n\
        - **HTML 조각**을 낸다(`<html>`·`<head>`·`<body>` 태그 없이, 본문에 들어갈 요소만). 패널 안의 격리된 프레임에 그려진다.\n\
        - 되는 것: 모든 HTML 요소와 `<style>`·인라인 `style`(flex·grid·그라디언트·border-radius 등 CSS), **인라인 `<svg>`**(막대·선·원 그래프, 다이어그램), 표, `data:` 이미지, 링크 `<a href=\"https://...\">`(누르면 기본 브라우저로 열린다).\n\
        - 안 되는 것: **JavaScript 전부**(`<script>`, `onclick` 같은 이벤트 속성, `javascript:` 주소 — 실행되지 않는다), 외부 파일 불러오기(http 이미지·CSS·글꼴·`<iframe>`·폼 전송), 마우스에 반응하는 동작(CSS `:hover` 정도만 가능). 그래서 차트 라이브러리는 못 쓰고 SVG·CSS로 직접 그린다.\n\
        - 앱 테마(다크/라이트)에 맞는 색 변수를 쓴다: `var(--text)`, `var(--text-soft)`, `var(--text-bright)`, `var(--bg)`, `var(--surface)`, `var(--surface-2)`, `var(--border)`, `var(--border-2)`, `var(--accent)`. 고정 색(`#fff`, `black`)은 다크/라이트 한쪽에서 안 보일 수 있으니 피하고, 의미 색(성공 `#3fb950`, 경고 `#d29922`, 오류 `#f85149`)만 직접 쓴다.\n\
        - **JavaScript는 기본적으로 실행되지 않는다.** 단 `CTM_ALLOW_JS=true`인 슬롯은 아래 '`html` + JavaScript 허용'을 따른다. `false`일 때는 `<script>`를 쓰지 마라.\n\
        - 패널 너비는 약 300~600px로 좁다. 고정 `px` 너비 대신 `width:100%`·`max-width:100%`·flex-wrap을 쓰고, SVG는 `viewBox`를 주고 `width=\"100%\"`로 둔다. 높이는 내용에 맞춰 자동으로 늘어난다. 기본 글자 크기는 12px.\n\n\
        ### `html` + JavaScript 허용 (`CTM_ALLOW_JS=true`일 때만)\n\n\
        - 출력 HTML 안에 **인라인 `<script>`**를 써서 정렬(표 머리 클릭), 접기·펼치기, 탭 전환, 필터, 마우스를 올렸을 때 값 보여 주기 같은 **화면 안 상호작용**을 만들 수 있다. 데이터는 스크립트가 HTML에 미리 넣어 두고(예: `<script type=\"application/json\">`나 JS 배열), 화면 안의 JavaScript가 그걸 다룬다.\n\
        - 막혀 있는 것: 네트워크 접속(`fetch`·`XMLHttpRequest`·WebSocket), 외부 스크립트·이미지·CSS 불러오기(`<script src>` 포함), 폼 전송, 팝업, `localStorage`·쿠키, 앱 화면의 변수·함수 접근, 프레임 자신의 주소를 바꾸는 것. 보안 규칙(CSP)이 막으므로 시도하지 마라. 필요한 데이터는 전부 스크립트(Node 등)가 모아서 HTML에 넣는다.\n\
        - 앱에 요청할 수 있는 동작(전역 객체 `window.ctm`): `ctm.open(url)`(http/https 주소를 기본 브라우저로), `ctm.reveal(경로)`(탐색기·Finder에서 그 파일/폴더 위치 보여 주기), `ctm.editor(경로, 줄번호)`(VS Code로 열기, 줄번호는 선택). 경로는 **절대 경로**여야 하고 선택한 팀장의 작업 폴더·허용한 팀원 폴더·그 저장소의 git 워크트리 폴더 **안**의 존재하는 것만 된다. 반환값은 없고 실패하면 앱이 패널 위쪽에 오류를 잠깐 보여 준다. `<a href=\"https://...\">` 링크는 자동으로 `ctm.open`처럼 동작한다.\n\
        - **상태를 바꾸는 동작(파일 수정·삭제, git 커밋·체크아웃 등)을 요청하는 방법은 없다.** `ctm`에는 위 세 가지뿐이다.\n\
        - **무한 루프(`while(true)`)나 몇 초씩 걸리는 동기 계산을 쓰지 마라.** 프레임이 멈추면 앱이 6초 뒤에 감지해 상호작용 없는 화면으로 바꾸지만, 멈춘 프로세스는 앱을 다시 시작해야 정리된다. 반복은 `setInterval`/`setTimeout`으로 쪼개고, 데이터를 많이 다루는 일은 스크립트(Node 등) 쪽에서 미리 끝내서 HTML에 넣는다.\n\
        - 높이는 내용에 맞춰 자동으로 늘어난다. `<button>`·`<input>`·`<select>`는 쓸 수 있지만 `<form>` 전송은 안 된다(`onclick` 등 JavaScript로 처리).\n\
        ## 앱이 주지 않는 것\n\n\
        - 팀장의 실시간 상태(작업 중/대기), 팀원 목록, 토큰·비용 사용량, 다른 패널 슬롯의 내용은 환경 변수로 주지 않는다. 필요하면 `CTM_SESSION_FILE`(대화 기록)이나 `CTM_LEADS_FILE`을 직접 읽어서 계산하거나, 이 PC의 명령(`git`, `gh` 등)을 실행해서 알아낸다.\n\
        - 앱이나 팀장 세션을 조작하는 기능(메시지 보내기, 종료 등)과 PC의 상태를 바꾸는 요청은 없다. 스크립트는 **보여 주기 전용**이고, 요청할 수 있는 건 링크 열기·파일 위치 보기·VS Code로 열기뿐이다.\n\n\
        ## 쓸 때 권장\n\n\
        - 읽기만 하는 명령을 쓴다(상태를 바꾸는 `git commit`·`checkout`, 파일 삭제·수정은 하지 않는다).\n\
        - 팀장을 고르지 않아 `CTM_LEAD_DIR`이 비어 있는 경우를 먼저 처리해 안내 문구를 출력하고 끝낸다.\n\
        - 외부 명령은 실패할 수 있으니 예외로 죽지 말고 읽을 수 있는 문구를 출력한다.\n\
        - `html`에서 사용자 데이터(폴더 이름, 커밋 메시지 등)를 넣을 때는 `&`, `<`, `>`를 이스케이프한다(그대로 넣으면 모양이 깨진다).\n",
        max = MAX_OUTPUT_CHARS
    )
}

/// (실행 파일, 파일 확장자, 앞에 붙일 인자들 — 파일 경로는 그 뒤에 붙는다)
pub(crate) fn interpreter_spec(interpreter: &str) -> Option<(&'static str, &'static str, Vec<&'static str>)> {
    match interpreter {
        "node" => Some(("node", "js", vec![])),
        #[cfg(windows)]
        "python" => Some(("python", "py", vec![])),
        #[cfg(not(windows))]
        "python" => Some(("python3", "py", vec![])),
        #[cfg(windows)]
        "shell" => Some(("powershell", "ps1", vec!["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])),
        #[cfg(not(windows))]
        "shell" => Some(("sh", "sh", vec![])),
        _ => None,
    }
}

/// 스크립트 파일 내용(셸이 윈도우 PowerShell이면 한글이 깨지지 않게 출력 인코딩을 UTF-8로 맞추는 줄을 앞에 붙인다).
fn script_file_text(interpreter: &str, script: &str) -> String {
    if cfg!(windows) && interpreter == "shell" {
        format!("\u{feff}[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n{script}\r\n")
    } else {
        script.to_string()
    }
}

fn truncate_chars(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        (s.to_string(), false)
    } else {
        (s.chars().take(max).collect(), true)
    }
}

fn find_lead<'a>(leads: &'a [LeadRecord], id: &str) -> Option<&'a LeadRecord> {
    leads.iter().find(|l| l.id == id || l.internal_id.as_deref() == Some(id))
}

/// 읽은 만큼을 cap까지만 공유 버퍼에 담는 읽기 스레드. cap을 넘는 분은 버리되 계속 비운다(스크립트가 쓰다가 막히지 않게). 넘치면 overflow가 켜진다.
/// 돌려주는 것: (지금까지 모인 내용, 통로가 닫혀 읽기가 끝났는지).
fn capture<R: Read + Send + 'static>(mut r: R, cap: usize, overflow: Arc<AtomicBool>) -> (Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>) {
    let buf = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(AtomicBool::new(false));
    let (b2, d2) = (buf.clone(), done.clone());
    std::thread::spawn(move || {
        let mut chunk = [0u8; 65536];
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut g = b2.lock().unwrap_or_else(|e| e.into_inner());
                    if g.len() < cap {
                        let take = n.min(cap - g.len());
                        g.extend_from_slice(&chunk[..take]);
                        if take < n {
                            overflow.store(true, Ordering::SeqCst);
                        }
                    } else {
                        overflow.store(true, Ordering::SeqCst);
                    }
                }
            }
        }
        d2.store(true, Ordering::SeqCst);
    });
    (buf, done)
}

fn too_big_message() -> String {
    format!("**출력이 너무 커서({}MB 넘음) 중단했습니다.**\n\n스크립트가 끝없이 출력하고 있지 않은지 확인하세요. 패널에는 그 일부(최대 {MAX_OUTPUT_CHARS}자)만 보여 줄 수 있습니다.", MAX_CAPTURE_BYTES / 1024 / 1024)
}

fn too_big_detail() -> String {
    format!("출력이 {}MB를 넘어 중단했습니다", MAX_CAPTURE_BYTES / 1024 / 1024)
}

/// 실행에서 생긴 문제(최근 에러 보기에 기록된다). kind: "spawn"(실행 못 함) | "timeout"(시간 초과) | "overflow"(출력이 너무 커서 중단) | "exit"(비정상 종료) | "stderr"(정상 종료했지만 오류 출력이 있었음)
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ScriptProblem {
    pub kind: &'static str,
    pub detail: String,
}

pub(crate) struct Outcome {
    /// 패널에 보일 내용. 문제가 있어서 못 돌았거나 실패했으면 읽을 수 있는 **마크다운** 오류 문구, 정상이면 스크립트가 낸 출력 그대로.
    pub output: String,
    /// output이 스크립트의 정상 출력이면 슬롯의 출력 형식("markdown"|"html"), 오류 문구면 항상 "markdown".
    pub format: &'static str,
    /// 정상 종료 때의 표준 오류 출력(앞 1500자). 패널에서는 숨기고 시험 실행에서만 보여 준다.
    pub stderr: String,
    pub problem: Option<ScriptProblem>,
}

fn fail(markdown: String, kind: &'static str, detail: String) -> Outcome {
    Outcome { output: markdown, format: "markdown", stderr: String::new(), problem: Some(ScriptProblem { kind, detail }) }
}

pub(crate) fn run_script_outcome(scripts_dir: &Path, file_stem: &str, interpreter: &str, script: &str, timeout_ms: u64, lead: Option<&LeadRecord>, output_format: &str, allow_js: bool) -> Outcome {
    let format: &'static str = if output_format == "html" { "html" } else { "markdown" };
    let Some((program, ext, pre_args)) = interpreter_spec(interpreter) else { return fail("**알 수 없는 실행 환경입니다.**".to_string(), "spawn", format!("알 수 없는 실행 환경: {interpreter}")) };
    if let Err(e) = std::fs::create_dir_all(scripts_dir) {
        return fail(format!("**스크립트 폴더를 만들지 못했습니다:** {e}"), "spawn", format!("스크립트 폴더를 만들지 못했습니다: {e}"));
    }
    let file: PathBuf = scripts_dir.join(format!("{file_stem}.{ext}"));
    if let Err(e) = std::fs::write(&file, script_file_text(interpreter, script)) {
        return fail(format!("**스크립트 파일을 쓰지 못했습니다:** {e}"), "spawn", format!("스크립트 파일을 쓰지 못했습니다: {e}"));
    }
    let mut cmd = Command::new(program);
    cmd.args(&pre_args).arg(&file);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    let work_dir = lead.map(|l| PathBuf::from(&l.target_dir)).filter(|p| p.is_dir()).unwrap_or_else(std::env::temp_dir);
    cmd.current_dir(&work_dir);
    for (name, value) in script_env(lead, format, allow_js) {
        cmd.env(name, value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("**{program}을(를) 실행하지 못했습니다:** {e}\n\n이 PC에 {program}이(가) 설치돼 있고 PATH에 있어야 합니다."), "spawn", format!("{program}을(를) 실행하지 못했습니다: {e}")),
    };
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else { return fail("**출력을 열지 못했습니다.**".to_string(), "spawn", "출력을 열지 못했습니다".to_string()) };
    let out_over = Arc::new(AtomicBool::new(false));
    let (out_buf, out_done) = capture(stdout, MAX_CAPTURE_BYTES, out_over.clone());
    let (err_buf, err_done) = capture(stderr, MAX_STDERR_BYTES, Arc::new(AtomicBool::new(false)));
    // 제한 시간과 출력 크기를 짧은 간격으로 확인하면서 기다린다.
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let status = loop {
        match child.wait_timeout(Duration::from_millis(40)) {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if out_over.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return fail(too_big_message(), "overflow", too_big_detail());
                }
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return fail(
                        format!("**제한 시간({timeout_ms}ms)을 넘어 중단했습니다.**\n\n이 슬롯의 설정에서 제한 시간(ms)을 늘릴 수 있습니다."),
                        "timeout",
                        format!("제한 시간({timeout_ms}ms)을 넘어 중단했습니다"),
                    );
                }
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return fail(format!("**프로세스 상태를 확인하지 못했습니다:** {e}"), "spawn", format!("프로세스 상태를 확인하지 못했습니다: {e}"));
            }
        }
    };
    // 스크립트가 끝난 뒤 출력 통로를 물고 남은 자식 프로세스가 있어도 오래 기다리지 않는다(지금까지 모인 것만 쓴다).
    let grace_end = Instant::now() + READER_GRACE;
    while !(out_done.load(Ordering::SeqCst) && err_done.load(Ordering::SeqCst)) && Instant::now() < grace_end {
        std::thread::sleep(Duration::from_millis(10));
    }
    if out_over.load(Ordering::SeqCst) {
        return fail(too_big_message(), "overflow", too_big_detail());
    }
    let take = |b: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&b.lock().unwrap_or_else(|e| e.into_inner())).to_string();
    let out = take(&out_buf);
    let err = take(&err_buf);
    if !status.success() {
        let (e, _) = truncate_chars(err.trim(), 1500);
        let shown = if e.is_empty() { "(오류 출력 없음)".to_string() } else { e };
        let code = status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".to_string());
        let md = format!("**스크립트가 실패했습니다**(종료 코드 {code})\n\n```\n{shown}\n```");
        return fail(md, "exit", format!("종료 코드 {code}\n{shown}"));
    }
    let (text, cut) = truncate_chars(out.trim(), MAX_OUTPUT_CHARS);
    let (err_text, _) = truncate_chars(err.trim(), 1500);
    let hint = format!("출력이 길어서 {MAX_OUTPUT_CHARS}자까지만 보여 줍니다");
    let output = if text.is_empty() {
        // 빈 출력 안내는 형식과 상관없이 읽을 수 있게 마크다운으로 둔다
        return Outcome {
            output: "(스크립트가 아무것도 출력하지 않았습니다 — 표준 출력으로 내보내야 패널에 보입니다)".to_string(),
            format: "markdown",
            stderr: err_text.clone(),
            problem: if err_text.is_empty() { None } else { Some(ScriptProblem { kind: "stderr", detail: err_text }) },
        };
    } else if cut {
        if format == "html" { format!("{text}<p>…({hint})</p>") } else { format!("{text}\n\n…({hint})") }
    } else {
        text
    };
    // 정상 종료했어도 오류 출력이 있었으면 "최근 에러"에 남긴다(패널에서는 숨기므로 나중에 다시 볼 수 있어야 한다).
    Outcome { output, format, stderr: err_text.clone(), problem: if err_text.is_empty() { None } else { Some(ScriptProblem { kind: "stderr", detail: err_text }) } }
}

// ---------------------------------------------------------------------------------------------
// 최근 에러 기록 — 스크립트 문제가 화면에서 사라진 뒤에도 다시 볼 수 있게 파일에 남긴다(최신순, 같은 문제가 반복되면 횟수만 올린다).
// ---------------------------------------------------------------------------------------------

pub(crate) const MAX_ERROR_ENTRIES: usize = 30;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScriptErrorEntry {
    /// 처음 생긴 시각(ms)
    pub at: i64,
    /// 마지막으로 또 생긴 시각(ms)
    pub last_at: i64,
    pub count: u32,
    pub slot_id: String,
    pub slot_name: String,
    /// "panel"(패널이 돌린 것) | "test"(설정 화면 시험 실행)
    pub source: String,
    pub kind: String,
    pub detail: String,
}

fn errors_lock() -> &'static std::sync::Mutex<()> {
    static L: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    L.get_or_init(|| std::sync::Mutex::new(()))
}

pub(crate) fn load_errors_from(path: &Path) -> Vec<ScriptErrorEntry> {
    std::fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

/// 문제 하나를 기록한다. 맨 앞(가장 최근) 항목과 슬롯·종류·내용·출처가 같으면 새 줄을 만들지 않고 횟수와 마지막 시각만 올린다.
pub(crate) fn record_error_at(path: &Path, slot_id: &str, slot_name: &str, source: &str, problem: &ScriptProblem, now: i64) {
    let _g = errors_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut list = load_errors_from(path);
    let (detail, _) = truncate_chars(&problem.detail, 4000);
    if let Some(top) = list.first_mut().filter(|t| t.slot_id == slot_id && t.kind == problem.kind && t.detail == detail && t.source == source) {
        top.count = top.count.saturating_add(1);
        top.last_at = now;
    } else {
        list.insert(0, ScriptErrorEntry { at: now, last_at: now, count: 1, slot_id: slot_id.to_string(), slot_name: slot_name.to_string(), source: source.to_string(), kind: problem.kind.to_string(), detail });
        list.truncate(MAX_ERROR_ENTRIES);
    }
    let _ = crate::json_file::write_json_file_atomic(path, &list);
}

pub(crate) fn clear_errors_at(path: &Path) {
    let _g = errors_lock().lock().unwrap_or_else(|e| e.into_inner());
    let _ = std::fs::remove_file(path);
}

/// 선택한 팀장 id(앱이 쓰는 id 또는 내부 id)로 팀장을 찾는다.
pub(crate) fn lead_by_id(leads: &[LeadRecord], id: Option<&str>) -> Option<LeadRecord> {
    id.filter(|s| !s.is_empty()).and_then(|id| find_lead(leads, id)).cloned()
}

fn lang_label(interpreter: &str) -> &'static str {
    match interpreter {
        "node" => "Node.js(CommonJS, 외부 패키지 없이 내장 모듈만)",
        "python" => "Python 3(표준 라이브러리만)",
        _ => {
            if cfg!(windows) {
                "Windows PowerShell"
            } else {
                "POSIX sh"
            }
        }
    }
}

fn format_rule(output_format: &str, allow_js: bool) -> &'static str {
    if output_format == "html" && allow_js {
        "- 출력 형식은 **html**이고 JavaScript가 허용돼 있다(CTM_OUTPUT_FORMAT=html, CTM_ALLOW_JS=true). 표준 출력에 HTML 조각만 낸다(<html>·<head>·<body> 없이). 상호작용(정렬·접기·탭·필터 등)은 인라인 <script>로 만들고, 필요한 데이터는 스크립트가 모아 HTML에 미리 넣는다. 네트워크·외부 파일은 막혀 있다. 파일/링크를 열려면 앱 안내의 window.ctm.open/reveal/editor만 쓴다(상태를 바꾸는 동작은 없다). 색은 앱 안내의 CSS 변수를 쓴다.\n"
    } else if output_format == "html" {
        "- 출력 형식은 **html**이다(CTM_OUTPUT_FORMAT=html, CTM_ALLOW_JS=false). 표준 출력에 HTML 조각만 낸다(<html>·<head>·<body>·<script> 없이). 그래프는 인라인 SVG나 CSS로 직접 그리고, 색은 앱 안내의 CSS 변수(var(--text), var(--accent) 등)를 쓴다. JavaScript·외부 파일은 동작하지 않는다.\n"
    } else {
        "- 출력 형식은 **markdown**이다(CTM_OUTPUT_FORMAT=markdown). 결과는 마크다운으로 표준 출력에 낸다(제목은 ## 부터, 목록·표·굵게·`코드`·[글](https://주소) 링크 사용 가능. HTML은 표시되지 않는다).\n"
    }
}

/// AI에게 스크립트를 쓰게 할 때 줄 요청문.
pub(crate) fn build_generate_prompt(request: &str, interpreter: &str, output_format: &str, allow_js: bool) -> String {
    let lang = lang_label(interpreter);
    format!(
        "너는 데스크톱 앱의 '오른쪽 패널' 슬롯에서 주기적으로 실행될 작은 스크립트를 쓴다. 아래 요구를 만족하는 {lang} 스크립트 하나만 써라.\n\
        규칙:\n\
        {rule}\
        - 아래 '앱 안내'에 적힌 것만 앱이 주는 정보다. 거기 없는 환경 변수·기능을 지어내서 쓰지 마라.\n\
        - 설명 없이 코드 블록(```) 하나만 답한다.\n\n\
        ===== 앱 안내 =====\n{reference}\n===== 앱 안내 끝 =====\n\n\
        요구: {request}",
        rule = format_rule(output_format, allow_js),
        reference = reference_markdown()
    )
}

/// 시험 실행에서 나온 문제(오류·이상한 출력)를 보고 스크립트를 고치게 할 때 줄 요청문.
pub(crate) fn build_fix_prompt(script: &str, problem: &str, note: &str, interpreter: &str, output_format: &str, allow_js: bool) -> String {
    let base = build_generate_prompt("(아래 스크립트를 고치는 일이다 — 새로 쓰지 말고 문제만 고쳐라)", interpreter, output_format, allow_js);
    let note_line = if note.trim().is_empty() { String::new() } else { format!("\n사용자가 덧붙인 말: {}\n", note.trim()) };
    format!(
        "{base}\n\n===== 지금 스크립트 =====\n{script}\n===== 지금 스크립트 끝 =====\n\n===== 시험 실행에서 나온 결과(오류 포함) =====\n{problem}\n===== 결과 끝 =====\n{note_line}\n위 결과에서 보이는 문제의 원인을 찾아 고친 **전체 스크립트**를 코드 블록 하나로만 답해라. 원래 하려던 일은 바꾸지 마라."
    )
}

/// 모델 답에서 코드 블록 안쪽만 꺼낸다(블록이 없으면 답 전체).
pub(crate) fn extract_code_block(text: &str) -> String {
    let t = text.trim();
    if let Some(start) = t.find("```") {
        let after = &t[start + 3..];
        let body_start = after.find('\n').map(|i| i + 1).unwrap_or(0);
        let body = &after[body_start..];
        let end = body.find("```").unwrap_or(body.len());
        return body[..end].trim_end().to_string();
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        std::env::temp_dir().join(format!("ctm_script_{}", uuid::Uuid::new_v4()))
    }

    fn run(dir: &Path, stem: &str, script: &str, timeout_ms: u64) -> Outcome {
        run_script_outcome(dir, stem, "node", script, timeout_ms, None, "markdown", false)
    }

    #[test]
    fn documented_variables_are_exactly_the_ones_passed_and_ai_prompt_carries_the_reference() {
        let passed: Vec<&str> = script_env(None, "markdown", false).iter().map(|(n, _)| *n).collect();
        let documented: Vec<&str> = ENV_VAR_DOCS.iter().map(|d| d.name).collect();
        assert_eq!(passed, documented, "안내 표와 실제로 넘기는 환경 변수가 어긋났다");
        let reference = reference_markdown();
        assert!(documented.iter().all(|n| reference.contains(n)), "안내 문서에 모든 변수가 있어야 한다");
        for fmt in OUTPUT_FORMATS {
            let prompt = build_generate_prompt("브랜치 보여줘", "node", fmt, false);
            assert!(prompt.contains(&reference) && prompt.contains("브랜치 보여줘") && prompt.contains(&format!("CTM_OUTPUT_FORMAT={fmt}")), "AI 요청문에 안내·요구·형식이 들어가야 한다({fmt})");
        }
    }

    #[test]
    fn script_really_receives_every_documented_variable() {
        let dir = scratch();
        let names: Vec<String> = ENV_VAR_DOCS.iter().map(|d| format!("'{}'", d.name)).collect();
        let script = format!("const n=[{}]; console.log(n.map(k=>k+'='+(process.env[k]===undefined?'UNDEFINED':(process.env[k]===''?'EMPTY':'SET'))).join('\\n'))", names.join(","));
        let out = run(&dir, "t6", &script, 8000).output;
        for d in ENV_VAR_DOCS.iter() {
            assert!(!out.contains(&format!("{}=UNDEFINED", d.name)), "{} 가 스크립트에 전달되지 않았다:\n{out}", d.name);
        }
        for always in ["CTM_OUTPUT_FORMAT", "CTM_ALLOW_JS", "CTM_LEADS_FILE", "CTM_CLAUDE_HOME", "CTM_APP_VERSION"] {
            assert!(out.contains(&format!("{always}=SET")), "{always}는 항상 채워져야 한다:\n{out}");
        }
        assert!(out.contains("CTM_LEAD_DIR=EMPTY"), "{out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_format_is_passed_and_reported_but_errors_are_always_markdown() {
        let dir = scratch();
        let ok = run_script_outcome(&dir, "f1", "node", "console.log('<b style=\"color:red\">' + process.env.CTM_OUTPUT_FORMAT + '</b>')", 8000, None, "html", false);
        assert_eq!((ok.format, ok.output.as_str()), ("html", "<b style=\"color:red\">html</b>"));
        let md = run_script_outcome(&dir, "f2", "node", "console.log(process.env.CTM_OUTPUT_FORMAT)", 8000, None, "markdown", false);
        assert_eq!((md.format, md.output.as_str()), ("markdown", "markdown"));
        let bad = run_script_outcome(&dir, "f3", "node", "process.exit(2)", 8000, None, "html", false);
        assert_eq!(bad.format, "markdown", "오류 문구는 html로 그리면 안 된다");
        let empty = run_script_outcome(&dir, "f4", "node", "", 8000, None, "html", false);
        assert_eq!(empty.format, "markdown");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn allow_js_is_passed_only_for_html_and_documented_with_the_ctm_api() {
        let get = |fmt: &str, js: bool| script_env(None, fmt, js).into_iter().find(|(n, _)| *n == "CTM_ALLOW_JS").unwrap().1;
        assert_eq!((get("html", true).as_str(), get("html", false).as_str(), get("markdown", true).as_str()), ("true", "false", "false"));
        let r = reference_markdown();
        for must in ["window.ctm", "ctm.open", "ctm.reveal", "ctm.editor", "상태를 바꾸는 동작", "CTM_ALLOW_JS"] {
            assert!(r.contains(must), "안내 문서에 {must}가 있어야 한다");
        }
        let js_prompt = build_generate_prompt("표 정렬", "node", "html", true);
        let no_js_prompt = build_generate_prompt("표 정렬", "node", "html", false);
        assert!(js_prompt.contains("JavaScript가 허용돼 있다") && !no_js_prompt.contains("JavaScript가 허용돼 있다"), "JS 허용 여부에 맞는 규칙이 요청문에 들어가야 한다");
        assert!(no_js_prompt.contains("CTM_ALLOW_JS=false") && js_prompt.contains("window.ctm.open/reveal/editor"));
    }

    #[test]
    fn code_block_is_extracted_with_or_without_fences() {
        assert_eq!(extract_code_block("설명\n```js\nconsole.log(1)\n```\n끝"), "console.log(1)");
        assert_eq!(extract_code_block("```\na\nb\n```"), "a\nb");
        assert_eq!(extract_code_block("console.log(2)"), "console.log(2)");
    }

    #[test]
    fn output_flood_is_stopped_quickly_instead_of_eating_memory() {
        let dir = scratch();
        // 끝이 있는 폭탄(약 40MB 쓰고 종료)
        let t = Instant::now();
        let o = run(&dir, "fl1", "const b=Buffer.alloc(1<<20,65);for(let i=0;i<40;i++)process.stdout.write(b);", 20000);
        assert_eq!(o.problem.as_ref().map(|p| p.kind), Some("overflow"), "{}", o.output);
        assert!(o.output.contains("너무 커서") && o.output.chars().count() < 600, "큰 출력은 오류 문구로 바뀌어야 한다");
        assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
        // 끝없는 폭탄은 제한 시간(20초)이 아니라 크기 제한으로 곧 멈춘다
        let t = Instant::now();
        let o = run(&dir, "fl2", "const b=Buffer.alloc(1<<20,66);function w(){while(process.stdout.write(b)){}process.stdout.once('drain',w)}w();", 20000);
        assert_eq!(o.problem.as_ref().map(|p| p.kind), Some("overflow"));
        assert!(t.elapsed() < Duration::from_secs(8), "끝없는 출력도 곧 멈춰야 한다: {:?}", t.elapsed());
        // 크기 제한 안쪽의 큰 출력은 정상(앞 MAX_OUTPUT_CHARS자만 보임)
        let o = run(&dir, "fl3", "console.log('x'.repeat(3*1024*1024))", 20000);
        assert!(o.problem.is_none() && o.output.contains("까지만 보여 줍니다"), "{}", &o.output[..80.min(o.output.len())]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_child_holding_the_output_pipe_does_not_make_the_run_wait() {
        let dir = scratch();
        // 부모는 곧바로 끝나지만, 출력 통로를 물려받은 자식이 20초 동안 산다 → 20초를 기다리면 안 된다
        let script = "const {spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:['ignore','inherit','inherit'],detached:true}).unref();console.log('## 부모는 바로 끝남');";
        let t = Instant::now();
        let o = run(&dir, "hp1", script, 5000);
        assert!(t.elapsed() < Duration::from_secs(3), "자식을 기다리면 안 된다: {:?}", t.elapsed());
        assert_eq!(o.output, "## 부모는 바로 끝남");
        assert!(o.problem.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_is_returned_and_lead_env_is_passed() {
        let dir = scratch();
        let out = run(&dir, "t1", "console.log('## 안녕\\n' + (process.env.CTM_LEAD_ID === '' ? '비어있음' : 'x'))", 8000).output;
        assert!(out.contains("## 안녕") && out.contains("비어있음"), "{out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failures_and_empty_output_are_readable_markdown() {
        let dir = scratch();
        let fail = run(&dir, "t2", "console.error('boom'); process.exit(3)", 8000).output;
        assert!(fail.contains("실패") && fail.contains("종료 코드 3") && fail.contains("boom"), "{fail}");
        let empty = run(&dir, "t3", "", 8000).output;
        assert!(empty.contains("아무것도 출력하지 않았습니다"), "{empty}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stderr_is_kept_separately_and_never_mixed_into_the_output() {
        let dir = scratch();
        let o = run(&dir, "t7", "console.log('## 제목'); console.error('경고: 일부 실패');", 8000);
        assert_eq!((o.output.as_str(), o.stderr.as_str()), ("## 제목", "경고: 일부 실패"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn slow_scripts_are_stopped_at_the_per_script_time_limit() {
        let dir = scratch();
        let t = std::time::Instant::now();
        let out = run(&dir, "t4", "setTimeout(() => console.log('late'), 5000)", 700).output;
        assert!(out.contains("제한 시간(700ms)"), "{out}");
        assert!(t.elapsed() < Duration::from_secs(4), "제한 시간이 지나면 바로 끝나야 한다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_output_is_cut_with_a_format_appropriate_note() {
        let dir = scratch();
        let script = "console.log('가'.repeat(210000))";
        let md = run_script_outcome(&dir, "t5", "node", script, 15000, None, "markdown", false);
        assert!(md.output.contains("까지만 보여 줍니다") && md.output.chars().count() < MAX_OUTPUT_CHARS + 200, "len {}", md.output.chars().count());
        let html = run_script_outcome(&dir, "t5h", "node", script, 15000, None, "html", false);
        assert!(html.output.ends_with(")</p>"), "html에서는 안내도 html이어야 한다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn problems_are_classified_and_recorded_with_dedupe_and_cap() {
        let dir = scratch();
        let fail_o = run(&dir, "e1", "console.error('boom'); process.exit(2)", 8000);
        assert_eq!(fail_o.problem.as_ref().map(|p| p.kind), Some("exit"));
        let slow = run(&dir, "e2", "setTimeout(()=>{},5000)", 600);
        assert_eq!(slow.problem.as_ref().map(|p| p.kind), Some("timeout"));
        let warn = run(&dir, "e3", "console.log('x'); console.error('w')", 8000);
        assert_eq!((warn.problem.as_ref().map(|p| p.kind), warn.output.as_str()), (Some("stderr"), "x"));
        let clean = run(&dir, "e4", "console.log('x')", 8000);
        assert!(clean.problem.is_none());

        let log = dir.join("errors.json");
        let p = ScriptProblem { kind: "exit", detail: "종료 코드 1\nboom".into() };
        record_error_at(&log, "s1", "브랜치", "panel", &p, 1000);
        record_error_at(&log, "s1", "브랜치", "panel", &p, 2000); // 같은 문제 반복 → 횟수만 증가
        let list = load_errors_from(&log);
        assert_eq!((list.len(), list[0].count, list[0].at, list[0].last_at), (1, 2, 1000, 2000));
        record_error_at(&log, "s1", "브랜치", "test", &p, 3000); // 출처가 다르면 새 항목, 최신순
        let list = load_errors_from(&log);
        assert_eq!((list.len(), list[0].source.as_str()), (2, "test"));
        for i in 0..40 {
            record_error_at(&log, "s2", "x", "panel", &ScriptProblem { kind: "exit", detail: format!("e{i}") }, 5000 + i);
        }
        assert_eq!(load_errors_from(&log).len(), MAX_ERROR_ENTRIES);
        clear_errors_at(&log);
        assert!(load_errors_from(&log).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fix_prompt_carries_script_error_note_and_reference() {
        let p = build_fix_prompt("const a = 1; a = 2;", "TypeError: Assignment to constant variable.", "표로 보여줘", "node", "markdown", false);
        assert!(p.contains("const a = 1; a = 2;") && p.contains("Assignment to constant variable") && p.contains("표로 보여줘") && p.contains(&reference_markdown()));
    }
}
