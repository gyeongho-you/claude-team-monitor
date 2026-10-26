// src-tauri/src/activity.rs와 같은 규칙 — 서브에이전트·팀원의 대화(활동) 기록과 팀장의 백그라운드 셸 작업을 읽어 화면에 보여준다.
//
// 배경(실측 2026-10-26, 디자인 팀장): 팀장이 개발 서버 같은 명령을 백그라운드로 돌리면 데몬은 이를 local_bash로 세어 "백그라운드 N개"로만 알려
// 주고, 어떤 명령인지는 어디에도 안 보였다. 서브에이전트·팀원도 대화를 볼 방법이 없었다. 모두 원본 세션 기록(jsonl)에 남아 있다:
//  - 서브에이전트: <세션폴더>/subagents/agent-<id>.jsonl — 일반 대화 기록(user/assistant, 도구 호출 포함)
//  - 팀원: 팀원 자신의 세션 파일 — 같은 형식
//  - 백그라운드 셸: 팀장 기록의 Bash(run_in_background) 호출 + tool_result "Command running in background with ID: <id>. Output is being
//    written to: <경로>" + 완료 때의 <task-notification>(<task-id>, <status>) — 알림이 없으면 아직 안 끝난 것(또는 방치된 것)이다.
// 읽기 전용이며, 실패나 예상과 다른 형태는 전부 조용히 빈 목록으로 넘긴다.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_ITEMS = 300;
const MAX_TEXT_CHARS = 3000;
const TAIL_BYTES = 6 * 1024 * 1024;
const OUTPUT_TAIL_BYTES = 16 * 1024;

const clip = (s, max) => (Array.from(s).length <= max ? s : Array.from(s).slice(0, max).join('') + '…');
const oneLine = s => String(s).split(/\s+/).filter(Boolean).join(' ');

function formatTime(iso) {
  const d = new Date(iso || '');
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toolBrief(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'description', 'file_path', 'pattern', 'query', 'url', 'prompt', 'path']) {
    if (typeof input[key] === 'string') return clip(oneLine(input[key]), 160);
  }
  return '';
}

/**
 * 도구 호출처럼 기록되지만 실제로는 에이전트 사이의 "대화"인 것들 — 서브에이전트의 최종 보고(SubagentHandback), 에이전트 간 전달(SendMessage), 서브에이전트·팀원에게
 * 준 지시(Agent/Task, spawn_team_member). 도구 줄로 접어 두면 무슨 말이 오갔는지 알 수 없어서(사용자 지적 2026-10-26) 본문(kind 'message')으로 크게 보여준다.
 */
function communicationText(name, input) {
  if (!input || typeof input !== 'object') return null;
  const s = key => (typeof input[key] === 'string' && input[key].trim() ? input[key].trim() : null);
  if (name === 'SubagentHandback') return s('message') && `최종 보고: ${s('message')}`;
  if (name === 'SendMessage') return s('message') && `→ ${s('to') || '?'}: ${s('message')}`;
  if (name === 'Agent' || name === 'Task') return s('prompt') && `서브에이전트 지시(${s('description') || ''}): ${s('prompt')}`;
  if (String(name).endsWith('spawn_team_member')) return s('instruction') && `팀원 지시(${s('label') || ''}): ${s('instruction')}`;
  return null;
}

/** jsonl 내용을 활동 목록으로 바꾼다(순수 함수). 최근 MAX_ITEMS개만 남긴다. @returns {{kind: string, time: string, text: string}[]} */
function parseActivityLines(content) {
  const items = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const time = formatTime(rec.timestamp);
    if (rec.type === 'user') {
      const c = rec.message && rec.message.content;
      const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text) : [];
      for (const t of texts) {
        // 하네스가 끼워 넣는 안내문은 대화가 아니라 제외한다.
        if (!t.trim() || t.trimStart().startsWith('<system-reminder>')) continue;
        items.push({ kind: 'user', time, text: clip(t.trim(), MAX_TEXT_CHARS) });
      }
    } else if (rec.type === 'assistant') {
      const c = rec.message && rec.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) items.push({ kind: 'assistant', time, text: clip(b.text.trim(), MAX_TEXT_CHARS) });
        else if (b && b.type === 'tool_use' && communicationText(b.name, b.input)) items.push({ kind: 'message', time, text: clip(communicationText(b.name, b.input), MAX_TEXT_CHARS) });
        else if (b && b.type === 'tool_use') { const brief = toolBrief(b.input); items.push({ kind: 'tool', time, text: brief ? `${b.name || '?'}: ${brief}` : String(b.name || '?') }); }
      }
    } else if (rec.type === 'attachment') {
      // 일하는 도중 끼어든 메시지(queued_command) — 완료 알림은 제외한다.
      const a = rec.attachment;
      if (a && a.type === 'queued_command' && typeof a.prompt === 'string' && a.prompt.trim() && !a.prompt.includes('<task-notification>')) items.push({ kind: 'user', time, text: clip(a.prompt.trim(), MAX_TEXT_CHARS) });
    }
  }
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}

/** 파일 끝부분만 읽는다(수십 MB짜리 세션 파일 전체를 매번 읽지 않기 위해). 앞쪽이 잘렸으면 첫 줄은 버린다. */
function readTailString(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = fs.fstatSync(fd).size;
    const start = Math.max(0, len - maxBytes);
    const buf = Buffer.alloc(len - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let s = buf.toString('utf8');
    if (start > 0) { const i = s.indexOf('\n'); if (i !== -1) s = s.slice(i + 1); }
    return s;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function readActivity(file) {
  const s = readTailString(file, TAIL_BYTES);
  return s === null ? [] : parseActivityLines(s);
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** 팀장 세션 파일 경로에서 서브에이전트 대화 파일 경로를 만든다. 안전하지 않은 id면 null. */
function subagentFile(leadSessionFile, agentId) {
  if (!SAFE_ID.test(agentId || '')) return null;
  return path.join(leadSessionFile.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
}

// ---------------------------------------------------------------------------------------------
// 백그라운드 셸 작업
// ---------------------------------------------------------------------------------------------

const between = (s, start, end) => { const a = s.indexOf(start); if (a === -1) return null; const r = s.slice(a + start.length); const b = r.indexOf(end); return b === -1 ? null : r.slice(0, b); };

function newScan() { return { offset: 0, pending: new Map(), launches: [], done: new Map() }; }

function scanTaskLine(scan, line) {
  if (!(line.includes('run_in_background') || line.includes('running in background with ID') || line.includes('<task-notification>'))) return;
  let rec; try { rec = JSON.parse(line); } catch { return; }
  const time = formatTime(rec.timestamp);
  if (rec.type === 'assistant') {
    for (const b of (rec.message && rec.message.content) || []) {
      if (b && b.type === 'tool_use' && b.name === 'Bash' && b.input && b.input.run_in_background === true) {
        scan.pending.set(String(b.id || ''), { cmd: clip(oneLine(b.input.command || ''), 240), desc: clip(String(b.input.description || ''), 120), time });
      }
    }
  } else if (rec.type === 'user') {
    const c = rec.message && rec.message.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_result') continue;
      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
      const taskId = between(text, 'running in background with ID: ', '.');
      if (!taskId) continue;
      // 경로 뒤에 ". You will be notified when it completes …" 같은 안내 문장이 이어지므로 ".output"까지만 경로로 읽는다(실측).
      const outRaw = text.split('Output is being written to: ')[1] || '';
      const outIdx = outRaw.indexOf('.output');
      const out = outIdx !== -1 ? outRaw.slice(0, outIdx + '.output'.length) : outRaw.split('\n')[0].trim();
      const p = scan.pending.get(String(b.tool_use_id || '')) || { cmd: '', desc: '', time: '' };
      scan.pending.delete(String(b.tool_use_id || ''));
      scan.launches.push({ taskId: taskId.trim(), command: p.cmd, description: p.desc, started: p.time || time, outputPath: out.replace(/\\\\/g, '\\').trim() });
    }
  } else if (rec.type === 'queue-operation' && rec.operation === 'enqueue' && typeof rec.content === 'string') {
    const id = between(rec.content, '<task-id>', '</task-id>');
    const status = between(rec.content, '<status>', '</status>');
    if (id && status) scan.done.set(id.trim(), status.trim());
  } else if (rec.type === 'attachment' && rec.attachment && rec.attachment.type === 'queued_command' && typeof rec.attachment.prompt === 'string') {
    // 서브에이전트 기록에는 완료 알림이 queued_command 첨부로 남는다
    const id = between(rec.attachment.prompt, '<task-id>', '</task-id>');
    const status = between(rec.attachment.prompt, '<status>', '</status>');
    if (id && status) scan.done.set(id.trim(), status.trim());
  }
}

/** 파일을 마지막으로 읽은 위치부터 이어서만 읽는다(수십 MB 기록을 폴링마다 다시 읽지 않기 위해). 줄이 덜 써진 끝부분은 다음에 읽는다. */
function updateScan(file, scan) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const len = fs.fstatSync(fd).size;
    if (len < scan.offset) { const fresh = newScan(); scan.offset = 0; scan.pending = fresh.pending; scan.launches = fresh.launches; scan.done = fresh.done; }
    if (len === scan.offset) return;
    const buf = Buffer.alloc(len - scan.offset);
    fs.readSync(fd, buf, 0, buf.length, scan.offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl === -1) return;
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) scanTaskLine(scan, line);
    scan.offset += lastNl + 1;
  } catch { /* ignore */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// 알림이 없는 작업이 지금도 떠 있는지는 프로세스로 확인한다(실측 2026-10-26, 디자인 팀장): 백그라운드 명령은 `bash.exe -c "… eval '<원래 명령>' …"`
// 래퍼 안에서 돌아서, 그 bash 프로세스의 명령줄에 원래 명령 문구가 그대로 들어 있다. 끝난 작업은 래퍼도 사라진다. "알림 없음 = 실행 중"이라고
// 가정하면 오래전에 끝난·방치된 작업까지 실행 중으로 보였다(알림 없는 6개 중 실제로 살아 있는 건 3개였다).
// 따옴표·역슬래시는 래퍼가 이스케이프를 바꾸므로, 공백·따옴표·역슬래시를 뺀 문자열로 비교한다.
const squash = s => s.replace(/[\s'"\\]/g, '');

/** 명령에서 프로세스 명령줄과 대조할 대표 조각을 뽑는다(짧으면 전체, 길면 가운데 60자 — 앞의 cd와 뒤의 잘림 표시를 피한다). */
function commandNeedle(command) {
  const q = Array.from(squash(command));
  if (q.length <= 80) return q.join('');
  const start = Math.floor((q.length - 60) / 2);
  return q.slice(start, start + 60).join('');
}

function taskAlive(command, squashedProcessCmds) {
  const needle = commandNeedle(command);
  return needle.length > 0 && squashedProcessCmds.some(p => p.includes(needle));
}

let procCache = null; // { at, value }
/** 지금 떠 있는 bash.exe들의 명령줄(공백·따옴표 정리 후). 10초 캐시 — PowerShell 호출이라 폴링마다 부르면 무겁다. 목록을 못 얻으면 null. */
function liveBashCommandLines() {
  if (procCache && Date.now() - procCache.at < 10000) return procCache.value;
  let value = null;
  if (process.platform === 'win32') {
    try {
      const script = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter "Name=\'bash.exe\'" | ForEach-Object { $_.CommandLine }';
      const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      value = out.split('\n').map(squash).filter(Boolean);
    } catch { value = null; }
  }
  procCache = { at: Date.now(), value };
  return value;
}

/** 스캔 결과를 화면용 목록으로 만든다. procs가 있으면 알림 없는 작업마다 alive를 채우고, 없으면 알림 없는 것 중 최신 runningCount개에 runningGuess를 켠다. 최신이 위. */
function buildTasks(scan, runningCount, procs) {
  const tasks = scan.launches.map(l => {
    let st = null; try { st = fs.statSync(l.outputPath); } catch { /* 없을 수 있다 */ }
    return { taskId: l.taskId, command: l.command, description: l.description, started: l.started, status: scan.done.get(l.taskId) || 'unfinished', runningGuess: false, outputBytes: st ? st.size : 0, ...(st ? { outputModifiedMs: Math.round(st.mtimeMs) } : {}), outputPath: l.outputPath };
  });
  if (procs) {
    const commands = new Map(scan.launches.map(l => [l.taskId, l.command]));
    for (const t of tasks) if (t.status === 'unfinished') t.alive = taskAlive(commands.get(t.taskId) || '', procs);
  } else {
    let flagged = 0;
    for (let i = tasks.length - 1; i >= 0; i--) if (tasks[i].status === 'unfinished' && flagged < runningCount) { tasks[i].runningGuess = true; flagged++; }
  }
  return tasks.reverse();
}

const scanCache = new Map();
function scanOf(file) {
  let scan = scanCache.get(file);
  if (!scan) { scan = newScan(); scanCache.set(file, scan); }
  updateScan(file, scan);
  return scan;
}

function backgroundTasksFor(sessionFile, runningCount) {
  const parent = scanOf(sessionFile);
  // 서브에이전트가 띄운 백그라운드 명령은 시작·출력 경로가 그 서브에이전트 기록(subagents/agent-*.jsonl)에만 남고(실측 2026-10-26),
  // 완료 알림은 팀장 기록과 서브에이전트 기록 양쪽에 남는다 — 같이 스캔해서 합친다.
  const subDir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  let subFiles = [];
  try { subFiles = fs.readdirSync(subDir).filter(n => n.endsWith('.jsonl')).sort().map(n => path.join(subDir, n)); } catch { /* 서브에이전트 없음 */ }
  const merged = { launches: parent.launches.slice(), done: new Map(parent.done) };
  for (const f of subFiles) {
    const sub = scanOf(f);
    merged.launches.push(...sub.launches);
    for (const [id, st] of sub.done) if (!merged.done.has(id)) merged.done.set(id, st);
  }
  merged.launches.sort((a, b) => (a.started < b.started ? -1 : a.started > b.started ? 1 : 0));
  return buildTasks(merged, runningCount, liveBashCommandLines());
}

/** 백그라운드 작업의 출력 끝부분. 출력 경로는 기록에 적힌 값이라 임의 파일을 읽지 않도록 임시 폴더의 claude 작업 폴더 안의 .output만 허용한다. */
function readTaskOutput(task) {
  if (!task) return '';
  const root = path.join(os.tmpdir(), 'claude') + path.sep;
  const resolved = path.resolve(task.outputPath || '');
  if (!resolved.toLowerCase().startsWith(root.toLowerCase()) || path.extname(resolved) !== '.output') return '';
  return readTailString(resolved, OUTPUT_TAIL_BYTES) || '';
}

module.exports = { parseActivityLines, readActivity, subagentFile, scanTaskLine, newScan, buildTasks, backgroundTasksFor, readTaskOutput, commandNeedle, taskAlive, squash, MAX_ITEMS };
