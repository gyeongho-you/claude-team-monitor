const test = require('node:test');
const assert = require('node:assert');
const { checkReadinessFromConfig, worktreeMainRepo } = require('../src/lib/claudeReadiness');

test('정확히 그 폴더가 신뢰돼 있으면 통과하고, 없으면 이유를 돌려준다', () => {
  const cfg = { projects: { 'C:/some/dir': { hasTrustDialogAccepted: true }, 'C:/untrusted': { hasTrustDialogAccepted: false } } };
  assert.ok(checkReadinessFromConfig(cfg, 'C:\\some\\dir').ready);
  assert.match(checkReadinessFromConfig(cfg, 'C:\\untrusted').reason, /워크스페이스 신뢰/);
  assert.match(checkReadinessFromConfig(cfg, 'C:\\nowhere').reason, /실행해본 적이 없습니다/);
});

test('신뢰는 상위 폴더에서 이어받는다(이름만 비슷한 폴더·미승인 상위는 제외)', () => {
  const cfg = { projects: { 'C:/repo': { hasTrustDialogAccepted: true }, 'C:/Users/me': { hasTrustDialogAccepted: false } } };
  assert.ok(checkReadinessFromConfig(cfg, 'C:\\repo\\sub\\deep').ready);
  assert.ok(checkReadinessFromConfig(cfg, 'C:\\repo\\').ready, '끝 구분자는 무시');
  assert.ok(!checkReadinessFromConfig(cfg, 'C:\\repo2\\x').ready);
  assert.ok(!checkReadinessFromConfig(cfg, 'C:\\Users\\me\\new').ready);
});

test('git worktree의 .git 파일에서 원본 저장소를 찾는다', () => {
  assert.strictEqual(worktreeMainRepo('gitdir: C:/Users/me/proj/.git/worktrees/feat-x\n'), 'C:/Users/me/proj');
  assert.strictEqual(worktreeMainRepo('gitdir: C:\\Users\\me\\proj\\.git\\worktrees\\x'), 'C:/Users/me/proj');
  assert.strictEqual(worktreeMainRepo('gitdir: C:/Users/me/proj/.git/modules/sub'), null, '서브모듈은 해당 없음');
  assert.strictEqual(worktreeMainRepo('이상한 내용'), null);
});
