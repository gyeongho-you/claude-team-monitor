// src-tauri/src/pasted_images.rs와 같은 규칙 — 채팅에 붙여넣은 이미지를 파일로 저장한다.
//
// 팀장 세션은 이미지를 "파일 경로"로만 읽을 수 있어서(Read 도구), 클립보드 이미지를 실제 파일로 만들어 그 경로를
// 첨부로 넘긴다. 저장 위치는 OS 임시 폴더가 아니라 ~/.claude/claude-team-monitor/attachments/ 다 — 임시 폴더는
// OS가 임의로 정리할 수 있어서 팀장이 나중에 다시 읽으려 할 때 파일이 없어질 수 있다. 대신 3일이 지난
// 붙여넣기 이미지는 저장할 때와 앱을 켤 때 자동으로 지운다(paste- 로 시작하는 우리가 만든 파일만).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CLAUDE_HOME } = require('./teamMemberPaths');

const ATTACHMENTS_DIR = path.join(CLAUDE_HOME, 'claude-team-monitor', 'attachments');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const RETENTION_MS = 3 * 24 * 3600 * 1000;
const FILE_PREFIX = 'paste-';

function extensionForMime(mime) {
  switch (String(mime || '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/bmp': return 'bmp';
    default: return 'png';
  }
}

/** 3일이 지난 붙여넣기 이미지를 지우고 삭제한 개수를 돌려준다. */
function purgeOld(dir, now) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const n of names) {
    if (!n.startsWith(FILE_PREFIX)) continue;
    try {
      const p = path.join(dir, n);
      if ((now === undefined ? Date.now() : now) - fs.statSync(p).mtimeMs > RETENTION_MS) { fs.unlinkSync(p); removed++; }
    } catch { /* ignore */ }
  }
  return removed;
}

/** base64 이미지 데이터를 파일로 저장하고 전체 경로를 돌려준다. 실패하면 Error를 던진다. */
function savePastedImage(dir, dataBase64, mime) {
  const bytes = Buffer.from(String(dataBase64 || '').trim(), 'base64');
  if (!bytes.length) throw new Error('이미지 데이터가 비어 있습니다.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('이미지가 너무 큽니다(최대 20MB).');
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const file = path.join(dir, `${FILE_PREFIX}${stamp}-${crypto.randomBytes(4).toString('hex')}.${extensionForMime(mime)}`);
  fs.writeFileSync(file, bytes);
  purgeOld(dir);
  return file;
}

module.exports = { ATTACHMENTS_DIR, savePastedImage, purgeOld, extensionForMime, RETENTION_MS };
