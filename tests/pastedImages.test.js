const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { savePastedImage, purgeOld, extensionForMime, RETENTION_MS } = require('../src/lib/pastedImages');

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctm-paste-')), 'attachments');

test('이미지를 mime에 맞는 확장자로 저장하고 전체 경로를 돌려준다', () => {
  const dir = tmp();
  const p = savePastedImage(dir, PNG_1X1, 'image/png');
  assert.ok(p.startsWith(dir));
  assert.match(path.basename(p), /^paste-\d{8}-\d{6}-[0-9a-f]{8}\.png$/);
  assert.deepStrictEqual([...fs.readFileSync(p).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(savePastedImage(dir, PNG_1X1, 'image/jpeg').endsWith('.jpg'));
  assert.strictEqual(extensionForMime('image/unknown'), 'png');
});

test('빈 데이터는 거부한다', () => {
  assert.throws(() => savePastedImage(tmp(), '', 'image/png'), /비어/);
});

test('3일이 지난 paste- 파일만 지우고 다른 파일은 건드리지 않는다', () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'paste-old.png'), 'x');
  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'x');
  const future = Date.now() + RETENTION_MS + 3600 * 1000;
  assert.strictEqual(purgeOld(dir, future), 1);
  assert.strictEqual(fs.existsSync(path.join(dir, 'paste-old.png')), false);
  assert.strictEqual(fs.existsSync(path.join(dir, 'keep-me.txt')), true);
  fs.writeFileSync(path.join(dir, 'paste-new.png'), 'x');
  assert.strictEqual(purgeOld(dir), 0);
});
