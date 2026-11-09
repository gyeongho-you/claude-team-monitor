// 팀원 생성 MCP 서버(mcp_server.rs)는 claude 세션이 띄운 자식 프로세스라 이 프로세스의 표준 입력이 "MCP 프로토콜 파이프"다.
// 거기서 `claude --bg`로 팀원을 띄울 때 표준 입력을 비우지 않으면(Stdio::null) 자식이 그 파이프를 물려받아 읽거나 기다린다 —
// 실제 claude 팀장 세션으로 시험하다가 팀원 시작이 항상 실패하는 것을 발견한 문제(tests/e2e/real-lead.js)라서, 소스 수준에서도 지킨다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('run_claude_bg_blocking은 자식 claude의 표준 입력을 비운다(Stdio::null)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'resume.rs'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('fn run_claude_bg_blocking');
  assert.ok(start >= 0, 'run_claude_bg_blocking을 찾지 못했습니다');
  const body = src.slice(start, src.indexOf('cmd.spawn()', start));
  assert.ok(/cmd\.stdin\(Stdio::null\(\)\)/.test(body), 'spawn 전에 cmd.stdin(Stdio::null())이 있어야 합니다');
});

test('MCP 서버의 팀원 시작은 그 함수를 거친다', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'src', 'mcp_server.rs'), 'utf8');
  assert.ok(src.includes('crate::resume::run_claude_bg_blocking('), 'mcp_server.rs가 run_claude_bg_blocking을 쓰지 않습니다');
});
