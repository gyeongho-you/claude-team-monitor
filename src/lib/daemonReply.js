// src-tauri/src/daemon_reply.rs와 같은 규칙 — 실행 중인 팀장 세션에 정지 없이 메시지를 전달한다.
//
// 배경(실측 2026-10-22, 디자인 팀장): 팀장이 개발 서버 같은 백그라운드 명령을 띄워두고 쉬면 데몬은 agents status를
// 계속 busy로 보고하고, 앱은 "작업 중이니 끝나면 전달"로 사용자 메시지를 대기열에 쌓는다 — 그런데 그 서버는 끝나지
// 않으니 메시지가 영영 안 간다(36분째 대기 확인). 대안인 stop→resume은 백그라운드 프로세스를 죽이진 않지만(실측: 정지 후 56초 넘게 ping이 계속 살아 있었다) 다시 깨어난 세션은 그 작업을 추적하지 못하고 방치된 채로 남기며, 정지·재기동 자체의 위험(세션 포크 등)도 있다.
// 그래서 데몬 제어 소켓의 `reply` 명령(에이전트 뷰의 "답장"이 쓰는 경로)으로 직접 전달한다 — 시험 세션에서 백그라운드
// ping이 계속 도는 채로 메시지가 전달돼 답이 오는 것을 확인했다. 기록에도 일반 사용자 메시지(같은 문구, promptId 포함)로
// 남아서 앱의 전달 판정이 그대로 동작한다.
//
// 주의: 이건 CLI 내부 프로토콜이라 버전이 바뀌면 깨질 수 있다(데몬이 EAUTH/ESKEW/ENOREPLY 등으로 거절). 그래서 호출하는 쪽은
// 실패하면 반드시 기존 동작(대기열)으로 되돌아가야 한다. 프로토콜: 줄바꿈으로 끝나는 JSON 한 줄을 보내면 JSON 한 줄이 돌아오고,
// proto=1, 인증은 ~/.claude/daemon/control.key 내용(auth), 소켓은 \\.\pipe\cc-daemon-<해시>-control — 해시는
// ~/.claude/daemon/roster.json의 워커 소켓 경로에서 얻는다.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { CLAUDE_HOME } = require('./teamMemberPaths');

const PROTO = 1;
const IO_TIMEOUT_MS = 5000;

/** roster.json의 워커 소켓 경로(…\cc-daemon-<해시>-rv-<id> 또는 …-pty-<id>)에서 제어 소켓 경로를 만든다. */
function controlPathFromRoster(rosterJson) {
  let v;
  try { v = JSON.parse(rosterJson); } catch { return null; }
  const workers = v && v.workers && typeof v.workers === 'object' ? Object.values(v.workers) : [];
  for (const w of workers) {
    for (const field of ['rendezvousSock', 'ptySock']) {
      const sock = w && w[field];
      if (typeof sock !== 'string') continue;
      for (const marker of ['-rv-', '-pty-']) {
        const idx = sock.lastIndexOf(marker);
        if (idx !== -1) return `${sock.slice(0, idx)}-control`;
      }
    }
  }
  return null;
}

function buildReplyLine(shortId, text, key) {
  return `${JSON.stringify({ proto: PROTO, op: 'reply', short: shortId, text, auth: key })}\n`;
}

/** 데몬 응답 한 줄을 해석한다. ok면 true, 아니면 코드와 사유를 담은 Error를 던진다. */
function parseReplyResponse(line) {
  let v;
  try { v = JSON.parse(String(line).trim()); } catch (e) { throw new Error(`응답을 해석하지 못했습니다: ${e.message}`); }
  if (v && v.ok === true) return true;
  throw new Error(`${(v && v.code) || '?'}: ${(v && v.error) || ''}`);
}

function exchange(socketPath, line) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let data = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('데몬 응답 시간 초과')); }, IO_TIMEOUT_MS);
    const finish = (fn, arg) => { clearTimeout(timer); sock.destroy(); fn(arg); };
    sock.on('connect', () => sock.write(line));
    sock.on('data', d => { data += d.toString('utf8'); if (data.includes('\n')) finish(resolve, data); });
    sock.on('error', e => finish(reject, new Error(`제어 소켓 오류: ${e.message}`)));
    sock.on('close', () => { if (!data.includes('\n')) finish(reject, new Error('데몬이 응답 없이 연결을 닫았습니다')); });
  });
}

/** 실행 중인 세션(짧은 id)에 메시지를 다음 사용자 턴으로 전달한다. 세션을 멈추지 않는다. 실패하면 Error를 던진다. */
async function replyToSession(shortId, text, daemonDir = path.join(CLAUDE_HOME, 'daemon')) {
  let key;
  try { key = fs.readFileSync(path.join(daemonDir, 'control.key'), 'utf-8').trim(); } catch { key = ''; }
  if (!key) throw new Error('데몬 제어 키(control.key)를 읽지 못했습니다');
  let roster;
  try { roster = fs.readFileSync(path.join(daemonDir, 'roster.json'), 'utf-8'); } catch (e) { throw new Error(`roster.json을 읽지 못했습니다: ${e.message}`); }
  const socketPath = controlPathFromRoster(roster);
  if (!socketPath) throw new Error('roster.json에서 제어 소켓 경로를 찾지 못했습니다');
  return parseReplyResponse(await exchange(socketPath, buildReplyLine(shortId, text, key)));
}

module.exports = { controlPathFromRoster, buildReplyLine, parseReplyResponse, replyToSession };
