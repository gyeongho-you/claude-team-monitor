const fs = require('fs');
const path = require('path');

// 쓰는 도중 죽어도(정전, 강제 종료, 예외) 원본 파일이 잘린 채로 남지 않도록, 임시 파일에 먼저 쓰고
// 같은 폴더 안에서 rename으로 교체한다(rename은 원자적이다). 실패하면 예외를 그대로 던진다 — 호출부에서
// try/catch로 로깅/처리한다.
function writeJsonFileAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

module.exports = { writeJsonFileAtomic };
