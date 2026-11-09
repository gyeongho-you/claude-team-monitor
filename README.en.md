# Claude Team Monitor

A Windows desktop app (Tauri v2) that monitors and manages headless Claude Code sessions: one **team lead** plus any number of **team members**, each working in a different repository. The Korean [README.md](README.md) is the complete reference; this page is a short summary.

## What it is

- A Claude Code **skill** (`resources/skills/team-lead/SKILL.md`) that tells a lead session how to split work across repos.
- An **MCP server** (the app's own exe run as `<exe> --mcp-server`) exposing `spawn_team_member`, `register_as_lead`, `list_leads`. No Node.js needed.
- The **desktop app**: one screen for all leads/members, approval requests as buttons, conversation history, an optional side panel (reports, git status, user scripts).

The skill and MCP server work without the app.

## Status and limits (please read)

| | |
|---|---|
| Windows 10/11 | Developed and manually verified here. |
| Linux / macOS | Rust + JS unit tests pass in CI only. The GUI has never been run there; no installer is built. **Treat the app as Windows-only.** |
| Code signing / auto-update | None. SmartScreen may warn. Download installers only from GitHub Releases and compare checksums. |
| Dependence on `claude` CLI | The app relies on `claude --bg`, `claude agents --json`, `claude stop`, `claude attach` whose behaviour is not a documented contract. A startup check warns when a needed flag disappears; see `.github/workflows/cli-compat.yml`. |
| Language | UI and docs are Korean. |

## Requirements

- Windows 10/11, WebView2 runtime
- The `claude` CLI, installed and logged in (Node.js only if you pick the Node.js interpreter in a script slot)

## Security model in one paragraph

The app runs with your user rights. Script slots execute code on your PC without a sandbox and are **off by default** (explicit opt-in). Team members can only be spawned into directories the **user** approved in the app; a model cannot approve directories through MCP arguments, and approvals that appear in `leads.json` without the app having saved them are ignored. This is a safeguard against the common bypass, **not** a hard boundary against a process with your file permissions. Details and honest limits: [SECURITY.md](SECURITY.md) (Korean).

## Build and test

```
npm install
npm test                          # JS tests
cd src-tauri && cargo test --lib  # Rust tests
npm run tauri:build               # release exe
npm run test:e2e                  # local-only UI E2E against a separate app instance (Windows)
```

License: MIT.
