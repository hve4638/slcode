// slcode 에이전트 플러그인 js/ts 훅의 공개 계약 (ticket slcode-agent-plugin-hooks, 새 계약 slcode-agent-plugin-script-portable — 착수 결정 각 TICKET.md).
// 훅 스크립트는 `import { slcode } from 'slcode/api'` 뒤 맨 위에서 slcode.on() 으로 이벤트별 콜백을 등록하고 slcode.run() 을 부른다. 위쪽 코드는 등록과 가벼운 선언만 둔다.
// 스크립트는 세션마다 한 번 실리고(slcode 세션은 core 안의 worker, export 한 Claude·Codex 는 세션 중간 프로세스 안의 worker) 모듈 변수는 세션 동안 남는다.
// 콜백은 hook 객체 하나를 받고 결과는 메서드로 낸다(호출만 해도, return hook.block() 해도 같다). 이벤트마다 쓸 수 있는 메서드는 METHODS — 타입도 같은 표를 따른다.
// 이 파일은 타입과 표만 둔다(런타임 의존 없음). 구현은 hookScript.ts(빌드가 alias 로 함께 묶는다).
/** 받는 이벤트 — Claude 이름 */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd'];
/** matcher 를 보는 이벤트 — 나머지(UserPromptSubmit·Stop)에 준 matcher 는 빌드가 경고하고 무시한다 (Claude 는 조용히 무시한다, 사용자 결정 2026-10-31) */
export const MATCHER_EVENTS = ['PreToolUse', 'PostToolUse', 'SessionStart', 'PreCompact', 'SessionEnd', 'SubagentStart', 'SubagentStop'];
/** hook.message() 알림 줄의 아이콘·색 — 정해진 목록 안에서만 고른다(ticket slcode-session-open-notice, 사용자 결정 2026-11-02). 생략하면 기본 모양(회색 종).
 *  slcode 웹 화면만 쓴다 — export 한 Claude·Codex 화면에는 글자만 간다. 색은 웹 테마의 강조·ok·warn·err 색을 따른다 */
export const MESSAGE_ICONS = ['bell', 'flag', 'info', 'alert', 'check', 'star', 'zap', 'shield'];
export const MESSAGE_TONES = ['info', 'ok', 'warn', 'err'];
/** 이벤트별 결과 메서드 (SDK 0.3.282 의 hook 출력 타입으로 확인). Stop·SubagentStop 의 context 는 SDK 가 받지만 막는다 — 그러면 Claude 가 멈추지 않는다(사용자 결정 2026-10-29).
 *  Stop·SubagentStop 의 block 은 "멈추지 말고 계속하라" */
export const METHODS = {
    SessionStart: ['context', 'message', 'stop'],
    UserPromptSubmit: ['block', 'context', 'message', 'stop'],
    PreToolUse: ['block', 'ask', 'allow', 'updateInput', 'context', 'message', 'stop'],
    PostToolUse: ['block', 'context', 'message', 'stop'],
    Stop: ['block', 'message', 'stop'],
    SubagentStart: ['context', 'message', 'stop'],
    SubagentStop: ['block', 'message', 'stop'],
    PreCompact: ['message', 'stop'],
    SessionEnd: ['message', 'stop'],
};
/** Codex(export) 에서 쓸 수 있는 메서드 — Codex 는 PreToolUse 의 ask·continue 를, SubagentStart 의 continue 를 받지 않는다(Codex hooks 문서, 0.165).
 *  빌드의 tsc 검사가 이 표로 Codex 용 타입을 만든다(scriptCheck.ts). 실행 중에는 hookBroker.toCodex 가 빼고 알린다 */
export const CODEX_METHODS = {
    ...METHODS,
    PreToolUse: METHODS.PreToolUse.filter((m) => m !== 'ask' && m !== 'stop'),
    SubagentStart: METHODS.SubagentStart.filter((m) => m !== 'stop'),
};
