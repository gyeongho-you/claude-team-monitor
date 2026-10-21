const test = require('node:test');
const assert = require('node:assert');
const { mergeAttachmentPaths, attachmentLabel, buildMessageWithAttachments, ATTACHMENT_HEADER, ATTACHMENT_ONLY_TEXT } = require('../renderer/lib/chatAttachments');

test('첨부가 없으면 글 그대로(앞뒤 공백만 정리)', () => {
  assert.strictEqual(buildMessageWithAttachments('  안녕  ', []), '안녕');
  assert.strictEqual(buildMessageWithAttachments('안녕', undefined), '안녕');
});

test('첨부가 있으면 메시지 끝에 전체 경로 목록이 붙는다', () => {
  const msg = buildMessageWithAttachments('이 로그 봐줘', ['C:\\Users\\me\\로그 파일.txt', 'D:\\a\\b.png']);
  assert.strictEqual(msg, `이 로그 봐줘\n\n${ATTACHMENT_HEADER}\n- C:\\Users\\me\\로그 파일.txt\n- D:\\a\\b.png`);
});

test('글 없이 첨부만 있어도 보낼 수 있게 기본 문구를 붙인다', () => {
  const msg = buildMessageWithAttachments('   ', ['C:\\x.txt']);
  assert.ok(msg.startsWith(ATTACHMENT_ONLY_TEXT));
  assert.ok(msg.includes('- C:\\x.txt'));
});

test('경로 병합은 중복(대소문자·구분자 차이 포함)과 빈 값을 걸러낸다', () => {
  assert.deepStrictEqual(mergeAttachmentPaths(['C:\\A\\b.txt'], ['c:/a/B.TXT', '', null, 'C:\\A\\c.txt']), ['C:\\A\\b.txt', 'C:\\A\\c.txt']);
  assert.deepStrictEqual(mergeAttachmentPaths(undefined, ['x']), ['x']);
});

test('칩에 보여줄 이름은 경로 끝 이름', () => {
  assert.strictEqual(attachmentLabel('C:\\Users\\me\\로그 파일.txt'), '로그 파일.txt');
  assert.strictEqual(attachmentLabel('/home/me/a.png'), 'a.png');
  assert.strictEqual(attachmentLabel('C:\\folder\\'), 'folder');
});
