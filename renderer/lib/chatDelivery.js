// 보낸 채팅 메시지가 팀장 세션 기록(transcript)에 "전달돼 나타났는지" 판정하는 순수 로직.
// DOM을 다루지 않으므로 renderer.js(브라우저)와 테스트(node:test) 양쪽에서 그대로 재사용한다 —
// lib/status.js와 같은 dual-export 패턴.
//
// 4000자를 넘는 메시지는 claude argv 길이 한도 때문에 앱이 파일로 저장하고 "이 파일을 읽어라"는
// 안내문으로 바꿔 보낸다(src/lib/longPromptGuard.js, src-tauri/src/long_prompt_guard.rs). 그러면 세션
// 기록에는 사용자가 쓴 원문이 아니라 그 안내문이 prompt로 남아서, 원문 일치로만 보면 영원히 "전달 안 됨"
// → 먹통으로 오판해 재시도/삭제 버튼이 떴다. 그래서 안내문(고정 문구)이 새로 나타난 것도 전달로 본다.
// 두 구현의 MAX_INLINE_PROMPT_LENGTH와 안내문 문구를 바꾸면 여기도 같이 바꿔야 한다.
const LONG_PROMPT_MAX_INLINE_LENGTH = 4000;
const LONG_PROMPT_REDIRECT_MARKER = '대신 파일로 저장했다';

/**
 * @param {{message: string, matchBySubstring?: boolean}} item - 보낸(대기 중인) 메시지
 * @param {{prompt: string}[]} newEntries - 이 메시지를 보낸 시점 이후 새로 생긴 기록들
 * @returns {boolean}
 */
function isChatItemDelivered(item, newEntries) {
  const matched = item.matchBySubstring
    ? newEntries.some(t => t.prompt.includes(item.message))
    : newEntries.some(t => t.prompt === item.message);
  if (matched) return true;
  // 묶음 배달(matchBySubstring)은 합쳐진 길이가 한도를 넘어 파일로 갔을 수도 있어 길이와 무관하게 인정한다.
  const mayHaveBeenRedirected = item.matchBySubstring || item.message.length > LONG_PROMPT_MAX_INLINE_LENGTH;
  return mayHaveBeenRedirected && newEntries.some(t => t.prompt.includes(LONG_PROMPT_REDIRECT_MARKER));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isChatItemDelivered, LONG_PROMPT_MAX_INLINE_LENGTH, LONG_PROMPT_REDIRECT_MARKER };
} else {
  (typeof window !== 'undefined' ? window : globalThis).isChatItemDelivered = isChatItemDelivered;
}
