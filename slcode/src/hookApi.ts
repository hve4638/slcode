// slcode 에이전트 플러그인 js/ts 훅의 공개 계약 (ticket slcode-agent-plugin-hooks, 설계 ws docs/report/slcode-agent-plugin-hooks.html, 착수 결정 TICKET.md).
// 훅 스크립트는 default export 함수 하나 — slcode 가 worker 에서 한 번 부르고, 그 함수가 slcode.on() 으로 이벤트별 콜백을 등록한다.
// 콜백은 hook 객체 하나를 받고 결과는 메서드로 낸다(호출만 해도, return hook.block() 해도 같다). 이벤트마다 쓸 수 있는 메서드는 METHODS — 타입도 같은 표를 따른다.
// 이 파일은 타입과 표만 둔다(런타임 의존 없음) — 플러그인 개발자가 `import type { ... } from 'slcode/hook'` 로 쓰는 자리.

/** 받는 이벤트 — Claude 이름 */
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionEnd'] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export type Method = 'block' | 'ask' | 'allow' | 'updateInput' | 'context' | 'message' | 'stop';
/** 이벤트별 결과 메서드 (SDK 0.3.282 의 hook 출력 타입으로 확인). Stop·SubagentStop 의 context 는 SDK 가 받지만 막는다 — 그러면 Claude 가 멈추지 않는다(사용자 결정 2026-10-29).
 *  Stop·SubagentStop 의 block 은 "멈추지 말고 계속하라" */
export const METHODS: Record<HookEvent, readonly Method[]> = {
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

/** 세션×플러그인 상태 — JSON 으로 왕복하는 값만 저장한다(아니면 그 키는 저장하지 않고 경고). 플러그인 하나에 1MB 까지 */
export type HookState = Record<string, any>;

export type ExecOptions = { timeout?: number; cwd?: string; input?: string; env?: Record<string, string> };
export type ExecResult = { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean };

type Base<E extends HookEvent> = {
  event: E;
  /** id 는 slcode 세션 id (resume·rewind 해도 같다) */
  session: { id: string; cwd: string; permissionMode: string | null };
  /** 서브에이전트 안에서 불렸으면 그 id·종류 — 주 에이전트면 null */
  agent: { id: string; type: string | null } | null;
  /** 이 세션에서 이 플러그인이 쓰는 상태. 서브에이전트는 빈 상태로 시작한다. 콜백이 끝나면 바뀐 키만 저장한다 */
  state: HookState;
  /** 명령을 새 프로세스 그룹으로 띄우고, 명령이 끝나면 그 그룹에 남은 프로세스도 종료한다. setsid 로 그룹을 빠져나간 프로세스는 남는다.
   *  child_process 를 직접 쓰면 이 정리를 보장하지 않는다 */
  exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecResult>;
  /** 하네스가 준 원본 입력 */
  raw: any;
  /** 사용자에게만 보이는 문구 */
  message(text: string): Hook<E>;
  /** 세션 진행을 멈춘다 */
  stop(reason?: string): Hook<E>;
};
type Block<E extends HookEvent> = { /** 막는다 — 이유는 Claude 에게 간다 */ block(reason: string): Hook<E> };
type Context<E extends HookEvent> = { /** Claude 의 맥락에 글을 넣는다 */ context(text: string): Hook<E> };
type Tool = { name: string; input: Record<string, any>; useId: string };

export type SessionStartHook = Base<'SessionStart'> & Context<'SessionStart'> & { source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' };
export type UserPromptSubmitHook = Base<'UserPromptSubmit'> & Block<'UserPromptSubmit'> & Context<'UserPromptSubmit'> & { prompt: string };
export type PreToolUseHook = Base<'PreToolUse'> & Block<'PreToolUse'> & Context<'PreToolUse'> & {
  tool: Tool;
  /** 사용자에게 승인을 묻는다 */
  ask(reason?: string): PreToolUseHook;
  /** 승인 없이 허용한다 */
  allow(reason?: string): PreToolUseHook;
  /** 도구 입력을 바꾼다 — 여러 콜백이 내면 나중 것(설치 순서, 같은 플러그인은 등록 순서)이 이긴다 */
  updateInput(input: Record<string, any>): PreToolUseHook;
};
export type PostToolUseHook = Base<'PostToolUse'> & Block<'PostToolUse'> & Context<'PostToolUse'> & { tool: Tool & { response: any } };
export type StopHook = Base<'Stop'> & Block<'Stop'>;
export type SubagentStartHook = Base<'SubagentStart'> & Context<'SubagentStart'> & { agent: { id: string; type: string | null } };
export type SubagentStopHook = Base<'SubagentStop'> & Block<'SubagentStop'> & { agent: { id: string; type: string | null } };
export type PreCompactHook = Base<'PreCompact'> & { trigger: 'manual' | 'auto' };
export type SessionEndHook = Base<'SessionEnd'> & { reason: string };

export type HookOf = {
  SessionStart: SessionStartHook; UserPromptSubmit: UserPromptSubmitHook; PreToolUse: PreToolUseHook; PostToolUse: PostToolUseHook; Stop: StopHook;
  SubagentStart: SubagentStartHook; SubagentStop: SubagentStopHook; PreCompact: PreCompactHook; SessionEnd: SessionEndHook;
};
export type Hook<E extends HookEvent = HookEvent> = HookOf[E];

/** matcher 는 Claude 와 같은 규칙 — 비거나 * 면 모두, 영문·숫자·_·| 만이면 | 로 나눈 이름과 정확히 같을 때, 그 밖은 정규식.
 *  맞추는 값: 도구 이벤트는 도구 이름, SessionStart 는 source, PreCompact 는 trigger, SessionEnd 는 reason, Subagent* 는 agent 종류. 나머지 이벤트는 matcher 를 보지 않는다.
 *  timeout 은 초(기본 10), failClosed 면 실패·timeout 때 막는다(block 이 있는 이벤트만) */
export type OnOptions = { matcher?: string; timeout?: number; failClosed?: boolean };
export type Callback<E extends HookEvent> = (hook: HookOf[E]) => unknown;

/** default export 함수가 받는 등록기 — 그 함수가 끝난 뒤의 on() 은 무시하고 경고한다 */
export type Slcode = {
  on<E extends HookEvent>(event: E, callback: Callback<E>): void;
  on<E extends HookEvent>(event: E, opts: OnOptions, callback: Callback<E>): void;
};
export type HookScript = (slcode: Slcode) => unknown;
