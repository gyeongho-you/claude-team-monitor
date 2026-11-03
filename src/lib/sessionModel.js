// 실행 중인 팀장/팀원 세션의 모델 읽기/쓰기 — Rust(session_model.rs)와 같은 규칙이다. 설명은 그쪽 파일 맨 위 참고:
// 정지한 세션의 ~/.claude/jobs/<id>/state.json respawnFlags의 --model을 고쳐 두고 플래그 없이 --resume하면 같은 세션이 새 모델로 이어진다
// (플래그를 주면 복사본이 생긴다 — 실측 2026-11-03, claude 2.1.310).
const fs = require('fs');
const path = require('path');

const MODEL_CHOICES = ['default', 'haiku', 'sonnet', 'opus', 'fable'];
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const isKnownModel = model => MODEL_CHOICES.includes(model);

function statePath(jobsDir, id) { return path.join(jobsDir, id, 'state.json'); }

/** respawnFlags에 저장된 --model 값(없으면 null = 기본 모델). 예: "haiku", "sonnet[1m]". */
function readSessionModel(jobsDir, id) {
  if (!SAFE_ID.test(id || '')) return null;
  try {
    const flags = JSON.parse(fs.readFileSync(statePath(jobsDir, id), 'utf-8')).respawnFlags;
    if (!Array.isArray(flags)) return null;
    const pos = flags.indexOf('--model');
    return pos !== -1 && typeof flags[pos + 1] === 'string' ? flags[pos + 1] : null;
  } catch { return null; }
}

/** respawnFlags의 --model을 바꾼다("default"면 --model을 뺀다). 다른 필드는 그대로, 임시 파일에 쓴 뒤 바꿔치기한다. 실패하면 Error를 던진다. */
function writeSessionModel(jobsDir, id, model) {
  if (!SAFE_ID.test(id || '') || !isKnownModel(model)) throw new Error('모델 또는 세션 id가 올바르지 않습니다');
  const file = statePath(jobsDir, id);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { throw new Error(`세션 상태 파일을 읽지 못했습니다: ${e.message}`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('세션 상태 파일 형식이 예상과 다릅니다');
  const flags = Array.isArray(data.respawnFlags) ? data.respawnFlags.slice() : [];
  const pos = flags.indexOf('--model');
  if (pos !== -1) flags.splice(pos, 2);
  if (model !== 'default') flags.push('--model', model);
  data.respawnFlags = flags;
  const tmp = path.join(path.dirname(file), 'state.json.ctm-tmp');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw new Error(`세션 상태 파일을 바꾸지 못했습니다: ${e.message}`); }
  // 쓴 값이 실제로 읽히는지 확인한다(데몬이 곧바로 덮어쓴 경우를 잡는다).
  const expected = model === 'default' ? null : model;
  if (readSessionModel(jobsDir, id) !== expected) throw new Error('모델 설정을 쓴 직후 다시 읽어 보니 반영되지 않았습니다(데몬이 덮어썼을 수 있음)');
}

const MODEL_LABELS = { default: '기본 모델', haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

function modelChangeNotice(model) {
  return `[알림] 사용자가 이 세션의 모델을 ${MODEL_LABELS[model] || model}(으)로 바꿨습니다(세션을 잠시 멈췄다 같은 대화로 이어서 재개했습니다). 하던 작업이 있었다면 이어서 진행하고, 없었다면 "모델 변경 확인"이라고만 한 줄로 답하세요.`;
}

module.exports = { MODEL_CHOICES, isKnownModel, readSessionModel, writeSessionModel, modelChangeNotice };
