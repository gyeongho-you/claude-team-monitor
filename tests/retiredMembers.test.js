const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { retiredDirFor, archiveMemberFile, restoreRetiredMembers } = require('../src/lib/retiredMembers');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-retired-'));
  const dir = path.join(base, 'members');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const put = (dir, rec) => fs.writeFileSync(path.join(dir, `${rec.memberId}.json`), JSON.stringify(rec));
const rec = (id, leadId, sessionId) => ({ memberId: id, leadId, createdAt: 1, role: 'implementer', label: '라벨', ...(sessionId ? { sessionId } : {}) });

test('보관은 파일을 지우지 않고 옮기고, 같은 id가 다시 살아나면 복원한다', () => {
  const dir = setup();
  put(dir, rec('548fd6ef', 'c728206b', '548fd6ef-aaaa'));
  assert.strictEqual(archiveMemberFile(dir, '548fd6ef'), true);
  assert.strictEqual(fs.existsSync(path.join(dir, '548fd6ef.json')), false);
  assert.strictEqual(fs.existsSync(path.join(retiredDirFor(dir), '548fd6ef.json')), true);

  const restored = restoreRetiredMembers(dir, [{ id: '548fd6ef', sessionId: '548fd6ef-aaaa' }], [{ id: 'c728206b' }], []);
  assert.strictEqual(restored.length, 1);
  assert.strictEqual(restored[0].leadId, 'c728206b');
  assert.strictEqual(fs.existsSync(path.join(dir, '548fd6ef.json')), true);
  assert.strictEqual(fs.existsSync(path.join(retiredDir(dir), '548fd6ef.json')), false);
});
function retiredDir(dir) { return retiredDirFor(dir); }

test('소속 팀장이 사라졌거나 sessionId가 다르면 복원하지 않는다', () => {
  const dir = setup();
  put(dir, rec('aaaa1111', 'gone-lead'));
  put(dir, rec('bbbb2222', 'c728206b', 'bbbb2222-old'));
  archiveMemberFile(dir, 'aaaa1111'); archiveMemberFile(dir, 'bbbb2222');
  const out = restoreRetiredMembers(dir, [{ id: 'aaaa1111', sessionId: 'x' }, { id: 'bbbb2222', sessionId: 'bbbb2222-NEW' }], [{ id: 'c728206b' }], []);
  assert.strictEqual(out.length, 0);
});

test('이미 등록된 팀원은 중복 복원하지 않고, 팀장은 절대 팀원으로 복원하지 않는다', () => {
  const dir = setup();
  put(dir, rec('aaaa1111', 'c728206b')); put(dir, rec('c728206b', 'c728206b'));
  archiveMemberFile(dir, 'aaaa1111'); archiveMemberFile(dir, 'c728206b');
  const existing = [rec('aaaa1111', 'c728206b')];
  assert.strictEqual(restoreRetiredMembers(dir, [{ id: 'aaaa1111' }], [{ id: 'c728206b' }], existing).length, 1);
  assert.strictEqual(restoreRetiredMembers(dir, [{ id: 'c728206b' }], [{ id: 'c728206b' }], []).length, 0);
});

test('안전하지 않은 id는 거부하고, 없는 파일은 그냥 성공으로 본다', () => {
  const dir = setup();
  assert.strictEqual(archiveMemberFile(dir, '../escape'), false);
  assert.strictEqual(archiveMemberFile(dir, 'nothere1'), true);
});
