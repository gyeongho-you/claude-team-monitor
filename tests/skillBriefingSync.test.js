const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TEAM_MEMBER_BRIEFING, TEAM_MEMBER_STANDBY_NOTE } = require('../src/lib/teamMemberBriefing');

const SKILL_PATH = path.join(__dirname, '..', 'resources', 'skills', 'team-lead', 'SKILL.md');
const skillText = fs.readFileSync(SKILL_PATH, 'utf-8');

test('SKILL.md에 TEAM_MEMBER_BRIEFING 문구가 문자 그대로 포함돼있다', () => {
  // TEAM_MEMBER_BRIEFING은 이 앱(launchMember)뿐 아니라 SKILL.md 안내를 따라 팀장이 직접
  // `claude --bg`로 띄우는 팀원에게도 똑같이 전달돼야 한다 — 둘 중 하나만 고치고 나머지를 깜빡하면
  // 이 테스트가 실패해서 알려준다. 문장 단위로 쪼개서 검사해야, SKILL.md 쪽 코드블록 안에서 줄바꿈
  // 개수가 달라져도(마크다운 렌더링용 빈 줄 등) 실제 문구 자체의 누락/변경은 놓치지 않는다.
  const sentences = TEAM_MEMBER_BRIEFING.split('\n\n');
  assert.equal(sentences.length, 5, 'TEAM_MEMBER_BRIEFING이 5개 문장으로 구성돼있다는 전제가 깨졌다 — 이 테스트도 같이 갱신해야 한다');
  for (const sentence of sentences) {
    assert.ok(
      skillText.includes(sentence),
      `SKILL.md에 TEAM_MEMBER_BRIEFING 문장이 없거나 달라졌습니다: "${sentence.slice(0, 50)}..."`,
    );
  }
});

test('TEAM_MEMBER_STANDBY_NOTE는 의도적으로 SKILL.md에 없다(다른 흐름 전용)', () => {
  // TEAM_MEMBER_STANDBY_NOTE는 이 앱이 UI로 직접 팀원을 등록할 때만 붙는, "역할·지시를 미리
  // 등록해두고 나중에 시작 신호를 보낸다"는 2단계 흐름 전용 문구다. SKILL.md가 안내하는, 팀장이
  // 직접 Bash로 띄우는 흐름은 한 번의 명령에 실제 작업 지시를 통째로 담아 보내는 구조라 이 대기
  // 단계 자체가 없다 — 그래서 SKILL.md엔 없는 게 맞다. 이 테스트는 "없어야 정상"임을 명시적으로
  // 남겨서, 나중에 누군가 실수로 넣어도(=SKILL.md 흐름을 착각해 2단계 대기를 추가해도) 바로 보이게
  // 하기 위한 것이다 — TEAM_MEMBER_BRIEFING과 달리 "일치해야 한다"는 뜻이 아니다.
  assert.equal(skillText.includes(TEAM_MEMBER_STANDBY_NOTE), false);
});
