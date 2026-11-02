/** 받는 이벤트 — Claude 이름 */
export declare const HOOK_EVENTS: readonly ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "SessionEnd"];
export type HookEvent = (typeof HOOK_EVENTS)[number];
/** matcher 를 보는 이벤트 — 나머지(UserPromptSubmit·Stop)에 준 matcher 는 빌드가 경고하고 무시한다 (Claude 는 조용히 무시한다, 사용자 결정 2026-10-31) */
export declare const MATCHER_EVENTS: readonly ["PreToolUse", "PostToolUse", "SessionStart", "PreCompact", "SessionEnd", "SubagentStart", "SubagentStop"];
export type MatcherEvent = (typeof MATCHER_EVENTS)[number];
/** hook.message() 알림 줄의 아이콘·색 — 정해진 목록 안에서만 고른다(ticket slcode-session-open-notice, 사용자 결정 2026-11-02). 생략하면 기본 모양(회색 종).
 *  slcode 웹 화면만 쓴다 — export 한 Claude·Codex 화면에는 글자만 간다. 색은 웹 테마의 강조·ok·warn·err 색을 따른다 */
export declare const MESSAGE_ICONS: readonly ["bell", "flag", "info", "alert", "check", "star", "zap", "shield"];
export declare const MESSAGE_TONES: readonly ["info", "ok", "warn", "err"];
export type MessageLook = {
    icon?: (typeof MESSAGE_ICONS)[number];
    tone?: (typeof MESSAGE_TONES)[number];
};
export type Method = 'block' | 'ask' | 'allow' | 'updateInput' | 'context' | 'message' | 'stop';
/** 이벤트별 결과 메서드 (SDK 0.3.282 의 hook 출력 타입으로 확인). Stop·SubagentStop 의 context 는 SDK 가 받지만 막는다 — 그러면 Claude 가 멈추지 않는다(사용자 결정 2026-10-29).
 *  Stop·SubagentStop 의 block 은 "멈추지 말고 계속하라" */
export declare const METHODS: Record<HookEvent, readonly Method[]>;
/** Codex(export) 에서 쓸 수 있는 메서드 — Codex 는 PreToolUse 의 ask·continue 를, SubagentStart 의 continue 를 받지 않는다(Codex hooks 문서, 0.165).
 *  빌드의 tsc 검사가 이 표로 Codex 용 타입을 만든다(scriptCheck.ts). 실행 중에는 hookBroker.toCodex 가 빼고 알린다 */
export declare const CODEX_METHODS: Record<HookEvent, readonly Method[]>;
/** 세션×플러그인 상태 — JSON 으로 왕복하는 값만 저장한다(아니면 그 키는 저장하지 않고 경고). 플러그인 하나에 1MB 까지 */
export type HookState = Record<string, any>;
/** 세션 인자 (slcode new --param, ticket slcode-agent-plugin-part-when) — 읽기 전용. slcode 세션에서만 차고, export 한 Claude·Codex 에서는 {} */
export type SessionParams = Readonly<Record<string, string>>;
export type ExecOptions = {
    timeout?: number;
    cwd?: string;
    input?: string;
    env?: Record<string, string>;
};
export type ExecResult = {
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
};
type Base<E extends HookEvent> = {
    event: E;
    /** id 는 slcode 세션 id (resume·rewind 해도 같다). params 는 세션 인자 — 쓰면 TypeError */
    session: {
        id: string;
        cwd: string;
        permissionMode: string | null;
        params: SessionParams;
    };
    /** 서브에이전트 안에서 불렸으면 그 id·종류 — 주 에이전트면 null */
    agent: {
        id: string;
        type: string | null;
    } | null;
    /** 이 세션에서 이 플러그인이 쓰는 상태. 서브에이전트는 빈 상태로 시작한다. 콜백이 끝나면 바뀐 키만 저장한다 */
    state: HookState;
    /** 명령을 새 프로세스 그룹으로 띄우고, 명령이 끝나면 그 그룹에 남은 프로세스도 종료한다. setsid 로 그룹을 빠져나간 프로세스는 남는다.
     *  child_process 를 직접 쓰면 이 정리를 보장하지 않는다 */
    exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecResult>;
    /** 하네스가 준 원본 입력 */
    raw: any;
    /** 사용자에게만 보이는 문구 — look 으로 알림 줄의 아이콘·색을 고른다(MESSAGE_ICONS·MESSAGE_TONES, slcode 화면만) */
    message(text: string, look?: MessageLook): Hook<E>;
    /** 세션 진행을 멈춘다 */
    stop(reason?: string): Hook<E>;
};
type Block<E extends HookEvent> = {
    block(reason: string): Hook<E>;
};
type Context<E extends HookEvent> = {
    context(text: string): Hook<E>;
};
type Tool = {
    name: string;
    input: Record<string, any>;
    useId: string;
};
export type SessionStartHook = Base<'SessionStart'> & Context<'SessionStart'> & {
    source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
};
export type UserPromptSubmitHook = Base<'UserPromptSubmit'> & Block<'UserPromptSubmit'> & Context<'UserPromptSubmit'> & {
    prompt: string;
};
export type PreToolUseHook = Base<'PreToolUse'> & Block<'PreToolUse'> & Context<'PreToolUse'> & {
    tool: Tool;
    /** 사용자에게 승인을 묻는다 */
    ask(reason?: string): PreToolUseHook;
    /** 승인 없이 허용한다 */
    allow(reason?: string): PreToolUseHook;
    /** 도구 입력을 바꾼다 — 여러 콜백이 내면 나중 것(설치 순서, 같은 플러그인은 등록 순서)이 이긴다 */
    updateInput(input: Record<string, any>): PreToolUseHook;
};
export type PostToolUseHook = Base<'PostToolUse'> & Block<'PostToolUse'> & Context<'PostToolUse'> & {
    tool: Tool & {
        response: any;
    };
};
export type StopHook = Base<'Stop'> & Block<'Stop'>;
export type SubagentStartHook = Base<'SubagentStart'> & Context<'SubagentStart'> & {
    agent: {
        id: string;
        type: string | null;
    };
};
export type SubagentStopHook = Base<'SubagentStop'> & Block<'SubagentStop'> & {
    agent: {
        id: string;
        type: string | null;
    };
};
export type PreCompactHook = Base<'PreCompact'> & {
    trigger: 'manual' | 'auto';
};
export type SessionEndHook = Base<'SessionEnd'> & {
    reason: string;
};
export type HookOf = {
    SessionStart: SessionStartHook;
    UserPromptSubmit: UserPromptSubmitHook;
    PreToolUse: PreToolUseHook;
    PostToolUse: PostToolUseHook;
    Stop: StopHook;
    SubagentStart: SubagentStartHook;
    SubagentStop: SubagentStopHook;
    PreCompact: PreCompactHook;
    SessionEnd: SessionEndHook;
};
export type Hook<E extends HookEvent = HookEvent> = HookOf[E];
/** matcher 는 Claude 와 같은 규칙 — 비거나 * 면 모두, 영문·숫자·_·| 만이면 | 로 나눈 이름과 정확히 같을 때, 그 밖은 정규식.
 *  맞추는 값: 도구 이벤트는 도구 이름, SessionStart 는 source, PreCompact 는 trigger, SessionEnd 는 reason, Subagent* 는 agent 종류. 나머지 이벤트는 matcher 를 보지 않는다.
 *  timeout 은 초(기본 10), failClosed 면 실패·timeout 때 막는다(block 이 있는 이벤트만) */
export type OnOptions<E extends HookEvent = HookEvent> = {
    timeout?: number;
    failClosed?: boolean;
} & (E extends MatcherEvent ? {
    matcher?: string;
} : {});
/** 빌드·싣는 쪽이 정하는 상수 — slcode.vars. harness 는 그 콜백을 돌리는 하네스(slcode 세션의 Claude 도 'claude'). 개발자가 정하는 상수는 나중에 같은 객체에 더한다 */
export type Vars = {
    harness: 'claude' | 'codex';
};
export type Callback<E extends HookEvent> = (hook: HookOf[E]) => unknown;
/** 명령 이름 — 폴더 이름. 소문자·숫자·- (대소문자를 가리지 않고 견준다) */
export declare const COMMAND_NAME: RegExp;
/** complete 가 돌려주는 후보의 상한 — 넘는 것은 버린다 */
export declare const COMPLETE_MAX = 50;
/** 명령·complete 가 보는 세션 — 읽기 전용 */
export type CommandSession = {
    id: string;
    cwd: string;
    params: SessionParams;
};
/** run 이 받는 것. state 는 그 플러그인의 주 에이전트 상태(훅과 같은 객체) — run 이 성공했을 때만 저장한다(던지면 바꾼 것을 버린다) */
export type CommandCall = {
    plugin: string;
    name: string;
    /** 명령 이름 뒤의 글 그대로(앞뒤 공백은 뺀다) */
    args: string;
    session: CommandSession;
    state: HookState;
    exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecResult>;
    /** 보관했다가 다음 턴에 UserPromptSubmit 훅 컨텍스트로 한 번 붙는다(사용자 글 앞인지 뒤인지는 모델에 따라 다르다). 같은 명령을 다시 성공시키면 앞의 보관분을 바꾼다(context 없이 성공하면 지운다) */
    context(text: string): CommandCall;
    /** 사용자에게만 보이는 줄 — look 은 훅의 message 와 같다 */
    message(text: string, look?: MessageLook): CommandCall;
};
/** complete 가 받는 것 — 인자는 공백으로 나눈 낱말. index 는 커서가 있는 낱말, value 는 그 낱말의 커서 앞부분. state 는 저장된 상태의 읽기 전용 사본 */
export type CompleteInput = {
    plugin: string;
    name: string;
    args: readonly string[];
    index: number;
    value: string;
    /** 명령 이름 뒤의 글 그대로 — 따옴표 등 공백으로 나누지 않는 인자를 직접 해석할 때 */
    raw: string;
    session: CommandSession;
    state: Readonly<HookState>;
};
/** 후보 — 문자열이면 value. 고르면 커서가 있는 낱말을 value 로 바꾼다 */
export type CompleteItem = string | {
    value: string;
    label?: string;
    description?: string;
};
/** slcode.command() 에 넘기는 것. complete 는 칠 때마다 불린다 — 가볍게(100ms 안), 따로 도는 worker 에서 돈다(run·훅과 모듈 변수를 나누지 않는다). timeout 은 run 의 초(기본 10) */
export type CommandDef = {
    description: string;
    /** `/` 자동 완성에 이름 옆에 보이는 인자 힌트 — complete 가 없거나 늦을 때도 보인다 */
    argumentHint?: string;
    timeout?: number;
    complete?(input: CompleteInput): readonly CompleteItem[] | Promise<readonly CompleteItem[]>;
    run(cmd: CommandCall): unknown;
};
/** `slcode/api` 의 api — run() 뒤(또는 스크립트를 다 실은 뒤)의 on() 은 무시하고 경고한다 */
export type Api = {
    readonly vars: Readonly<Vars>;
    on<E extends HookEvent>(event: E, callback: Callback<E>): void;
    on<E extends HookEvent>(event: E, opts: OnOptions<E>, callback: Callback<E>): void;
    /** 등록이 끝났다는 신호 — 맨 위 코드의 끝에서 부른다. COMMAND 파일에는 필요 없다 */
    run(): void;
    /** 명령 하나 — commands/<이름>/COMMAND.ts 에서 정확히 한 번 부른다(훅 스크립트에서는 쓸 수 없다) */
    command(def: CommandDef): void;
};
export {};
