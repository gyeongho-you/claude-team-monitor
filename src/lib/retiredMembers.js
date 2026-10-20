// src-tauri/src/retired_members.rs와 같은 규칙 — 팀원 등록 파일을 "삭제" 대신 보관(members-retired/)했다가
// 같은 팀원이 다시 살아나면 자동 복원한다.
//
// 배경(실측 2026-10-20, g1cl-mgt-leader의 팀원 3명이 "유기"된 사고): 팀원이 유휴 60분이면 데몬이 종료
// 처리(`bg retire … settled, idle 61m`)해서 claude agents 목록에서 사라진다. 앱은 목록에서 MEMBER_MISS_
// GRACE_MS(244초) 넘게 안 보이면 "끝난 팀원"으로 보고 등록 파일을 영구 삭제했는데, 팀장이 그 팀원에게
// SendMessage로 후속 지시를 보내면 같은 id로 다시 깨어난다 — 그러면 살아있는 팀원인데 등록이 없어 어느
// 팀장 소속인지 모르는 상태가 된다. 그래서 지울 때는 보관 폴더로 옮기고, 목록에 같은 id가 다시 나타나면
// 되살린다. 보관본은 14일 뒤 정리한다.

const fs = require('fs');
const path = require('path');

const RETIRED_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function retiredDirFor(membersDir) {
  return path.join(path.dirname(membersDir), 'members-retired');
}

/**
 * 등록 파일을 보관 폴더로 옮긴다(복사 후 원본 삭제). 옮기지 못하면 원본을 지우지 않고 false — 보관 실패가
 * 곧 영구 손실이 되면 안 된다.
 * @returns {boolean}
 */
function archiveMemberFile(membersDir, memberId) {
  if (!SAFE_ID.test(memberId || '')) return false;
  const from = path.join(membersDir, `${memberId}.json`);
  if (!fs.existsSync(from)) return true;
  const retired = retiredDirFor(membersDir);
  try {
    fs.mkdirSync(retired, { recursive: true });
    fs.copyFileSync(from, path.join(retired, `${memberId}.json`));
  } catch { return false; }
  try { fs.unlinkSync(from); } catch { /* ignore */ }
  purgeOldRetired(retired);
  return true;
}

function purgeOldRetired(retired) {
  let names;
  try { names = fs.readdirSync(retired); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    try {
      const p = path.join(retired, n);
      if (now - fs.statSync(p).mtimeMs > RETIRED_MAX_AGE_MS) fs.unlinkSync(p);
    } catch { /* ignore */ }
  }
}

/**
 * 보관된 팀원 중 지금 목록에 같은 id로 다시 살아있는 것을 등록 폴더로 되살리고, 되살린 레코드를 members에 더해 돌려준다.
 * 조건: 이미 등록돼 있지 않고, 팀장 자신이 아니고, 소속 팀장이 아직 등록돼 있고, 보관본과 살아있는 세션의 sessionId가 같을 때
 * (둘 다 있는데 다르면 id만 같은 다른 세션이라 복원하지 않는다).
 * @template {{memberId: string, leadId: string, sessionId?: string}} T
 * @param {string} membersDir
 * @param {{id?: string, sessionId?: string}[]} agents
 * @param {{id: string}[]} leads
 * @param {T[]} members
 * @param {(msg: string) => void} [log]
 * @returns {T[]}
 */
function restoreRetiredMembers(membersDir, agents, leads, members, log) {
  const retired = retiredDirFor(membersDir);
  if (!fs.existsSync(retired)) return members;
  const leadIds = new Set(leads.map(l => l.id));
  const known = new Set(members.map(m => m.memberId));
  const out = members.slice();
  for (const a of agents) {
    const id = a.id;
    if (!id || !SAFE_ID.test(id) || known.has(id) || leadIds.has(id)) continue;
    const file = path.join(retired, `${id}.json`);
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { continue; }
    if (!rec || rec.memberId !== id || !leadIds.has(rec.leadId)) continue;
    if (rec.sessionId && a.sessionId && rec.sessionId !== a.sessionId) continue;
    try { fs.mkdirSync(membersDir, { recursive: true }); fs.writeFileSync(path.join(membersDir, `${id}.json`), JSON.stringify(rec, null, 2)); } catch { continue; }
    try { fs.unlinkSync(file); } catch { /* ignore */ }
    if (log) log(`[restoreRetiredMembers] 보관돼 있던 팀원 ${id}(팀장 ${rec.leadId})가 다시 살아나 등록을 복원했습니다.`);
    out.push(rec);
  }
  return out;
}

module.exports = { retiredDirFor, archiveMemberFile, restoreRetiredMembers };
