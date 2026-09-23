# Claude Team Monitor

여러 저장소(repo)에 걸친 작업을 헤드리스 Claude Code 세션("팀장" 1개 + 필요한 만큼의 "팀원")으로 분담시키고, 진행 상황을 한 화면에서 모니터링·관리하는 도구입니다.

핵심은 **팀장 1명이 여러 repo에 팀원을 띄워 작업을 나누고, 결과를 종합해서 보고**하는 구조입니다. 이 저장소는 그 구조를 실제로 쓸 수 있게 해주는 두 가지를 담고 있습니다:

- **Claude Code 스킬**(`resources/skills/team-lead/SKILL.md`) — 팀장 세션이 따르는 행동 지침
- **MCP 서버**(`src/mcp/teamMemberServer.ts`) — 팀원 생성·자기등록을 위한 툴(`spawn_team_member`, `register_as_lead`)

데스크톱 앱(Tauri)은 이 위에 얹은 **부가 기능**입니다 — 여러 팀장/팀원을 화면 하나로 모아 보여주고, 승인 요청에 버튼으로 응답하고, 대화 히스토리를 관리하는 용도입니다. **앱 없이 스킬+MCP만으로도 완전히 동작**합니다.

---

## 어느 쪽으로 쓸지 먼저 정하세요

| | 데스크톱 앱 설치 | 스킬 + MCP만 사용 |
|---|---|---|
| 여러 팀장/팀원을 화면으로 모니터링 | ✅ | ❌ (터미널에서 각자 `claude attach`/`claude logs`로 확인) |
| 승인 요청(새 팀원 디렉토리, 팀원 종료)에 버튼으로 응답 | ✅ | ❌ (요청 파일을 직접 읽고 답해야 함) |
| 정체 감지, 재연결 재시도, 워크스페이스 신뢰 문제 자동 정리 | ✅ | ❌ |
| 설치/설정 부담 | 앱 빌드/실행 필요 | 스킬 파일 복사 + MCP 설정 JSON 하나 |
| 팀장을 어디서든(다른 컴퓨터, CI 등) 순수 터미널로 굴리기 | — | ✅ |

두 방식은 **같은 데이터**(`~/.claude/claude-team-monitor/`)를 보므로, 스킬+MCP만으로 시작했다가 나중에 앱을 설치해도 팀장·팀원 기록이 그대로 이어집니다.

---

## 방법 A — 데스크톱 앱 설치해서 쓰기

### 준비물
- Windows 10/11 (macOS/Linux는 Tauri 자체는 지원하지만 이 저장소에서 직접 검증하지는 않았습니다)
- [claude CLI](https://docs.claude.com/claude-code) 설치 + 로그인 완료 (`claude --version`으로 확인)
- 빌드하려면: [Node.js](https://nodejs.org) 18+, [Rust](https://www.rust-lang.org/tools/install) 툴체인(`rustup`)

### 빌드 & 실행
```bash
git clone https://github.com/gyeongho-you/claude-team-monitor.git
cd claude-team-monitor
npm install
npm run tauri:build
```
빌드가 끝나면 `src-tauri/target/release/app.exe`(약 13MB, 단일 실행 파일)가 만들어집니다. 이 파일 하나만 원하는 곳에 복사해서 실행하면 됩니다 — 옆에 다른 폴더나 리소스가 따로 필요 없습니다.

개발 중 바로 띄워보고 싶다면:
```bash
npm run tauri:dev
```

### 처음 실행할 때
- 팀장을 띄울 디렉토리에서 **한 번도 `claude`를 실행한 적이 없다면**, 그 디렉토리를 처음 쓸 때 워크스페이스 신뢰(trust) 승인이 필요할 수 있습니다. 앱이 이 상태를 감지하면 자동으로 정리하고 화면에 "터미널에서 먼저 승인하세요"라고 안내합니다 — 그 디렉토리에서 터미널로 `claude`를 한 번 실행해 승인창을 눌러준 뒤 다시 시도하세요.
- 팀장/팀원 등록 정보는 `~/.claude/claude-team-monitor/`(leads.json, members/) 밑에, 즐겨찾기·설정 등은 OS별 앱 데이터 폴더(Windows는 `%APPDATA%\claude-team-monitor\`) 밑에 저장됩니다.

---

## 방법 B — 앱 없이 스킬 + MCP만 쓰기

터미널에서 `claude` CLI만으로 팀장을 굴리고 싶을 때의 최소 설정입니다.

### 1. 스킬 설치
```bash
mkdir -p ~/.claude/skills/team-lead
cp resources/skills/team-lead/SKILL.md ~/.claude/skills/team-lead/SKILL.md
```

### 2. MCP 서버 빌드
```bash
npm install
npm run build
```
`dist/teamMemberServer.js`가 생성됩니다 — 이 한 파일이 팀원 생성용 MCP 서버 전체입니다(의존성까지 번들됨, `node_modules` 안 가져가도 됩니다).

### 3. MCP 설정 파일 만들기
어디든 편한 곳에 `mcp-config.json`을 만듭니다(경로는 절대경로로):
```json
{
  "mcpServers": {
    "team-monitor": {
      "command": "node",
      "args": ["/absolute/path/to/claude-team-monitor/dist/teamMemberServer.js"]
    }
  }
}
```

### 4. 팀장 세션 띄우기
```bash
claude --bg \
  --mcp-config "$(cat mcp-config.json)" \
  --allowedTools "mcp__team-monitor__spawn_team_member,mcp__team-monitor__register_as_lead" \
  -- "/team-lead g1cl-fo/g1cl-bo/g1cl-service 세 저장소에 나눠서 <작업 내용>을 진행해줘"
```
- `claude agents --json`으로 방금 뜬 세션의 짧은 id를 확인할 수 있습니다.
- `claude attach <id>`로 실시간 터미널을 열어 진행 상황을 직접 볼 수 있습니다.
- `claude logs <id>` / `claude stop <id>`로 로그 확인·종료도 가능합니다.

### 5. (처음 한 번만) 팀장 자기등록
앱을 거치지 않고 시작한 팀장은 아직 "팀장으로 등록"되어 있지 않습니다. 팀장이 팀원을 만들려고 `spawn_team_member`를 처음 호출하면 "아직 등록되지 않았다"는 에러가 돌아오는데, 이때 팀장 스스로 `mcp__team-monitor__register_as_lead` 툴을 한 번 호출하면 됩니다(스킬에 이미 이 안내가 포함되어 있어서, 팀장이 알아서 처리합니다). 이후로는 정상적으로 `spawn_team_member`를 쓸 수 있습니다.

앱으로 띄운 팀장은 시작 시점에 이미 등록된 채로 시작하므로 이 단계가 필요 없습니다.

---

## 개발

```bash
npm test                          # Node/TypeScript 쪽 테스트
cd src-tauri && cargo test        # Rust 쪽 테스트
npm run typecheck                 # TypeScript 타입만 검사
```

디렉토리 구조:
- `src/main.ts`, `src/preload.ts` — Electron 구현(참고용으로 남겨둠, 더 이상 기본 빌드 대상 아님)
- `src-tauri/` — Tauri(Rust) 구현, 현재 데스크톱 앱의 실제 백엔드
- `renderer/` — Electron/Tauri가 공유하는 UI(HTML/CSS/JS)
- `src/lib/`, `src/mcp/` — Node/TypeScript로 작성된 공유 로직 및 MCP 서버(두 백엔드가 함께 사용)
- `resources/skills/team-lead/` — 팀장 세션용 Claude Code 스킬
