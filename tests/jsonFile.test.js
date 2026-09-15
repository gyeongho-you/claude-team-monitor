const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonFileAtomic } = require('../src/lib/jsonFile');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-team-monitor-test-'));
}

test('writeJsonFileAtomic: 파일이 없어도 새로 만들고, 내용을 JSON으로 정확히 읽을 수 있다', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'data.json');
    writeJsonFileAtomic(file, { a: 1, b: ['x', 'y'] });
    const read = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepEqual(read, { a: 1, b: ['x', 'y'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonFileAtomic: 상위 디렉토리가 없으면 만들어서 쓴다', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'nested', 'deeper', 'data.json');
    writeJsonFileAtomic(file, { ok: true });
    assert.equal(fs.existsSync(file), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { ok: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonFileAtomic: 기존 파일을 덮어쓴 뒤에도 임시 파일(.tmp)이 남지 않는다', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'data.json');
    writeJsonFileAtomic(file, { v: 1 });
    writeJsonFileAtomic(file, { v: 2 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { v: 2 });
    const leftoverTmp = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftoverTmp, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
