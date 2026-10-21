// 채팅 첨부 파일 경로를 다루는 순수 로직. DOM을 다루지 않으므로 renderer.js(브라우저)와 테스트(node:test)
// 양쪽에서 그대로 재사용한다 — lib/status.js와 같은 dual-export 패턴.
//
// 팀장 세션은 파일을 "경로"로만 받을 수 있어서(Read 도구), 첨부한 파일은 내용을 싣는 게 아니라 메시지 끝에
// 전체 경로 목록을 붙여 보낸다 — 사용자가 경로를 일일이 찾아 붙여넣지 않아도 되게 하는 것이 목적이다.

const ATTACHMENT_HEADER = '[첨부 파일]';
const ATTACHMENT_ONLY_TEXT = '첨부한 파일을 확인해주세요.';

/** 이미 있는 경로는 빼고(대소문자 무시, 구분자 통일) 새 경로만 뒤에 더한다. */
function mergeAttachmentPaths(existing, added) {
  const norm = p => String(p).replace(/\\/g, '/').toLowerCase();
  const seen = new Set((existing || []).map(norm));
  const out = (existing || []).slice();
  for (const raw of added || []) {
    const p = String(raw || '').trim();
    if (!p || seen.has(norm(p))) continue;
    seen.add(norm(p));
    out.push(p);
  }
  return out;
}

/** 경로 끝의 파일(폴더) 이름 — 칩에 보여줄 짧은 이름. */
function attachmentLabel(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

/**
 * 글과 첨부 경로로 실제 전송할 메시지를 만든다. 첨부가 없으면 글 그대로(앞뒤 공백만 정리),
 * 글 없이 첨부만 있으면 기본 문구를 앞에 붙인다.
 */
function buildMessageWithAttachments(text, paths) {
  const body = String(text || '').trim();
  const list = (paths || []).filter(Boolean);
  if (!list.length) return body;
  const lead = body || ATTACHMENT_ONLY_TEXT;
  return `${lead}\n\n${ATTACHMENT_HEADER}\n${list.map(p => `- ${p}`).join('\n')}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { mergeAttachmentPaths, attachmentLabel, buildMessageWithAttachments, ATTACHMENT_HEADER, ATTACHMENT_ONLY_TEXT };
} else {
  Object.assign(typeof window !== 'undefined' ? window : globalThis, { mergeAttachmentPaths, attachmentLabel, buildMessageWithAttachments });
}
