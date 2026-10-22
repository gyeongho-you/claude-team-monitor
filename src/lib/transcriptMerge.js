// src-tauri/src/transcript.rs의 queued_command_prompt / merge_injected_prompts와 같은 규칙 — 팀장이 일하는 도중에
// 데몬 reply(또는 팀원의 SendMessage)로 들어온 메시지를 대화 기록에 반영한다.
//
// 그런 메시지는 일반 user 기록이 아니라 attachment(type=queued_command, prompt=원문)로 남고(실측 2026-10-22), 일지
// (daily-journal)에도 안 남는다. 터미널에서 일하는 중간에 입력한 것과 같은 메시지라 새 턴의 시작으로 취급한다.

/** 원본 기록 한 줄이 끼어든 메시지면 그 원문, 아니면 null. 완료 알림(<task-notification>)은 지금까지처럼 대화창에 안 넣는다. */
function queuedCommandPrompt(rec) {
  const att = rec && rec.attachment;
  if (!att || att.type !== 'queued_command' || typeof att.prompt !== 'string') return null;
  if (!att.prompt.trim() || att.prompt.includes('<task-notification>')) return null;
  return att.prompt;
}

// "YYYY-MM-DD HH:MM"(일지와 같은 포맷) → 로컬 시각 epoch ms, 형식이 다르면 null
function parseLoose(time) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(time || '');
  if (!m) return null;
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  return Number.isNaN(ts) ? null : ts;
}

const SAME_SLACK_MS = 10 * 60 * 1000;

/**
 * 일지 기준으로 만든 목록에 없는 끼어든 메시지를 시간순 위치에 끼워 넣는다. 그렇지 않으면 뒤이어 보낸 일반 메시지가 일지에
 * 쌓이는 순간 끼어든 메시지가 대화창에서 사라진다(뒷부분만 보충하는 규칙 때문). 같은 문구가 시간 차 10분 이내로 이미 있으면
 * 중복으로 넣지 않는다(반복되는 문구를 오인하지 않기 위한 제한).
 * @template {{time: string, prompt: string}} T
 * @param {T[]} entries
 * @param {T[]} injected
 * @returns {T[]}
 */
function mergeInjectedPrompts(entries, injected) {
  const out = entries.slice();
  for (const inj of injected) {
    const injMs = parseLoose(inj.time);
    const already = out.some(e => {
      if (e.prompt !== inj.prompt) return false;
      const a = parseLoose(e.time);
      return a === null || injMs === null ? true : Math.abs(a - injMs) <= SAME_SLACK_MS;
    });
    if (already) continue;
    let pos = out.length;
    if (injMs !== null) {
      const idx = out.findIndex(e => { const t = parseLoose(e.time); return t !== null && t > injMs; });
      if (idx !== -1) pos = idx;
    }
    out.splice(pos, 0, inj);
  }
  return out;
}

module.exports = { queuedCommandPrompt, mergeInjectedPrompts };
