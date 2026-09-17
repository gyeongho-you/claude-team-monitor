// 모든 팀원 프롬프트 맨 앞에 붙는 공통 브리핑. 이 앱(Claude Team Monitor)이 직접 등록하는
// 팀원(launchMember, main.ts)뿐 아니라, 팀장이 mcp__team-monitor__spawn_team_member 툴로
// 만드는 팀원(src/mcp/teamMemberServer.ts)에도 반드시 똑같은 문구가 전달돼야 한다(안 그러면
// 팀원이 개인 인터랙티브 세션처럼 굴다가 되묻고 멈춘다). 두 곳 다 이 모듈을 그대로 import해서
// 쓰므로 자동으로 동기화된다 — tests/skillBriefingSync.test.js가 그 import 관계를 검증한다.
const TEAM_MEMBER_BRIEFING = [
  '너는 지금 "팀장" 세션이 배정한 "팀원" 세션이다. 사람이 실시간으로 지켜보며 답해주는 세션이 아니니, 중간에 사용자에게 되묻지 말고 스스로 판단해서 진행해라.',
  '정보가 부족하면 저장소 안에서 직접 조사해서 합리적으로 판단하고, 정말로 진행이 불가능할 때만 왜 막혔는지를 최종 답변에 명확히 남기고 멈춰라(질문만 던지고 끝내지 마라).',
  'AskUserQuestion 같은 화살표 선택형 인터랙티브 도구는 절대 쓰지 마라 — 백그라운드 세션이라 실제 터미널이 안 붙어있어서 그 메뉴에 아무도 응답할 수 없고, 세션이 그대로 영구히 멈춘다(텍스트로 되묻는 것보다 훨씬 심각하게 막힘).',
  '같은 이유로 EnterWorktree/ExitWorktree 도구도 쓰지 마라 — 사전 승인 안 된 경로로 permission root를 옮기려 하면 "진행할까요? Yes/No" 확인 프롬프트가 뜨는데 이것도 아무도 응답 못 해서 똑같이 멈춘다(실측 확인). 워크트리가 필요하면 `git worktree add <경로> <브랜치>`를 Bash로 직접 실행하고, 그 경로를 Edit/Write/Bash의 대상 경로로 그냥 지정해서 작업해라 — permission root 자체를 옮기는 도구만 피하면 된다.',
  '작업을 마치면 무엇을 확인했고 결과가 무엇인지 최종 답변에 구조적으로 정리해라 — 그 답변이 팀장에게 전달되는 유일한 보고 내용이다.',
].join('\n\n');

// launchMember(main.ts)로 이 앱이 직접 팀원을 띄울 때만 붙는 문구 — "역할·지시를 먼저 등록해두고
// 나중에 시작 신호를 보낸다"는 앱 UI의 2단계 흐름 때문에 필요하다. 팀장이 spawn_team_member
// 툴로 띄우는 흐름은 한 번의 호출에 실제 작업 지시를 통째로 담아 보내는 구조라 이 대기 단계
// 자체가 없다 — teamMemberServer.ts는 이 문구를 쓰지 않는다(tests/skillBriefingSync.test.js가
// 검증).
const TEAM_MEMBER_STANDBY_NOTE = '아래는 앞으로 맡을 작업에 대한 참고용 사전 지시다 — 이번 턴에서 곧바로 실행하지 마라. 내용을 확인했다는 짧은 준비 완료 응답만 남기고(예: "확인했습니다. 아래 작업을 맡을 준비가 됐습니다."), 실제로 작업을 시작하라는 팀장의 다음 메시지가 올 때까지 기다려라. 팀장이 다시 메시지를 보내기 전까지는 어떤 파일도 고치거나 만들지 마라.';

module.exports = { TEAM_MEMBER_BRIEFING, TEAM_MEMBER_STANDBY_NOTE };
