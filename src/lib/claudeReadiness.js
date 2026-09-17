const fs = require('fs');
const path = require('path');
const os = require('os');

// claude CLI는 새 디렉토리에서 처음 실행될 때 "이 폴더를 신뢰합니까"(워크스페이스 신뢰) 다이얼로그를
//띄운다 — 이건 -p(비대화 모드)에서는 건너뛰지만 --bg는 그렇지 않다(claude --help 자체에 명시됨:
// "workspace trust dialog is skipped ... via -p, or when stdout is not a TTY"). headless(--bg)
// 세션은 이 다이얼로그에 아무도 답할 수 없어서 daemon이 "stuck on a startup dialog" 상태로 영구히
// 멈춘다(실사용 재현: 2026-09-17). 이 승인 자체는 사람이 한 번은 직접 눌러야 하는 의도된 안전장치라
// 앱이 우회해선 안 되지만(실제로 이 설정 파일을 직접 고치려는 시도는 Claude Code 자신의
// "Self-Modification" 분류기가 차단한다), 최소한 spawn을 시도하기 전에 "이 디렉토리는 아직 이 승인이
// 없다"는 걸 먼저 확인해서, 영원히 조용히 멈추는 대신 즉시 명확한 실패로 알릴 수는 있다.
// main.ts와 teamMemberServer.ts 둘 다 새 디렉토리에 claude --bg를 스폰하므로 공용으로 뽑았다
// (agentsJson.js와 같은 이유 — 각자 구현하면 드리프트가 생긴다).
//
// hasClaudeMdExternalIncludesApproved는 처음엔 같이 검사했었다 — 그런데 CLAUDE.md에 실제로 외부
// include가 없는 흔한(대부분의) 저장소에서는 다이얼로그 자체가 안 뜨니 이 플래그가 영원히
// false로 남는다는 게 실측으로 드러났다(워크스페이스 신뢰만 새로 승인했는데 그걸로 문제가 완전히
// 풀렸고, 이 플래그는 그 뒤로도 계속 false였다). 즉 이 필드는 "막혀있다"는 신호가 아니라 그냥
// "이 기능을 아직 안 써봤다"는 뜻일 수 있어서, 이걸 막는 조건으로 쓰면 실제로는 멀쩡한 디렉토리를
// 영구 오탐(false positive)으로 계속 잡아낸다 — 그래서 뺐다.
/**
 * @param {string} targetDir
 * @returns {{ ready: boolean, reason?: string }}
 */
function checkDirectoryClaudeReady(targetDir) {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8');
    const data = JSON.parse(raw);
    // ~/.claude.json은 이 키를 항상 슬래시(/)로 정규화해서 저장한다 — 우리 쪽 targetDir은
    // Windows 백슬래시(\)라 정규화 없이 그대로 조회하면 실제로 존재하는 프로젝트도 못 찾아서
    // 항상 "실행해본 적 없음"으로 오판한다(실측 확인).
    const normalizedTarget = targetDir.replace(/\\/g, '/');
    const proj = data && data.projects && data.projects[normalizedTarget];
    if (!proj) {
      return { ready: false, reason: '이 디렉토리에서 claude를 인터랙티브로 실행해본 적이 없습니다' };
    }
    if (!proj.hasTrustDialogAccepted) {
      return { ready: false, reason: '워크스페이스 신뢰(trust) 승인이 안 돼 있습니다' };
    }
    return { ready: true };
  } catch {
    // ~/.claude.json을 못 읽으면 판단할 근거가 없다 — 이 경우 막지 않고 통과시킨다(이 사전 검사가
    // 없었던 예전과 동일한 상태로 fail-open — 검사 실패가 정상적인 스폰까지 막으면 안 된다).
    return { ready: true };
  }
}

/** @param {string} targetDir @param {string} reason @returns {string} */
function claudeNotReadyMessage(targetDir, reason) {
  return `"${targetDir}" 디렉토리가 아직 claude 최초 실행 승인이 안 돼 있어(${reason}) headless 세션이 시작 단계에서 영원히 멈출 수 있습니다 — 그 디렉토리에서 터미널로 'claude'를 한 번 실행해 뜨는 승인창을 눌러준 뒤 다시 시도하세요.`;
}

module.exports = { checkDirectoryClaudeReady, claudeNotReadyMessage };
