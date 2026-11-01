import type { HookCallbackMatcher, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { type HookEvent, type MessageLook } from './hookApi.js';
/** js/ts 훅의 기록 — slcode 는 세션 이벤트로 낸다 (slcode protocol.ts CoreEventBody 가 이 꼴을 그대로 품는다). ready 는 worker 가 스크립트를 싣고 등록한 콜백(errors 는 싣지 못한 스크립트·잘못된 on()),
 *  run 은 콜백 한 번(result 는 부른 메서드 요약, outcome 이 error·timeout 이면 error 에 사유, message 는 hook.message() 문구를 이은 것,
 *  messages 는 부른 것마다 글과 아이콘·색 — 목록 밖 값은 뺐다; 이 필드가 없는 옛 기록은 message 한 줄로 그린다), warn 은 그 밖의 경고 */
export type AgentHookEvent = {
    kind: 'agent.hook';
    phase: 'ready';
    plugin: string;
    callbacks: {
        event: string;
        matcher: string | null;
        src: string;
    }[];
    errors: string[];
}
/** effects 는 콜백이 낸 결과 원문(잘리지 않음) — 화면은 한 일이 있을 때만 그린다. toolUseId 는 도구 이벤트(PreToolUse·PostToolUse)의 대상 도구 */
 | {
    kind: 'agent.hook';
    phase: 'run';
    plugin: string;
    src: string;
    event: string;
    ms: number;
    outcome: 'ok' | 'error' | 'timeout';
    effects: AgentHookEffects | null;
    toolUseId: string | null;
    error: string | null;
    message: string | null;
    messages?: AgentHookMessage[] | null;
    warnings: string[];
} | {
    kind: 'agent.hook';
    phase: 'warn';
    plugin: string;
    text: string;
};
export type AgentHookMessage = {
    text: string;
} & MessageLook;
export type AgentHookEffects = {
    block: string[];
    ask: string[];
    allow: string[];
    stop: string[];
    context: string[];
    updateInput: boolean;
};
/** 세션 폴더 안의 상태 폴더 */
export declare const STATE_DIR = "agent-state";
/** slcode core 는 sessionDir·buildDir 를, export 의 중간 프로세스(hookBroker)는 stateFile·dirOf·aliases 를 준다 */
export type RunnerOpts = {
    sessionDir?: string;
    buildDir?: string;
    sessionId: string;
    emit: (ev: AgentHookEvent) => void;
    /** 주 에이전트 상태 파일 — 기본은 sessionDir/agent-state/<플러그인>.json */
    stateFile?: (plugin: string) => string;
    /** 빌드 식별자 → scripts.json 이 있는 폴더 — 기본은 buildDir/<식별자> */
    dirOf?: (build: string) => string;
    /** 도구 이름 → matcher 가 함께 보는 별칭 (Codex: apply_patch 는 Edit·Write 로도 맞는다) */
    aliases?: Record<string, readonly string[]>;
    /** 콜백을 돌리는 하네스 — 스크립트의 slcode.vars.harness. 기본 claude(slcode 세션) */
    harness?: 'claude' | 'codex';
    /** 세션 인자 — hook.session.params (ticket slcode-agent-plugin-part-when). slcode core 가 주고, export 의 중간 프로세스는 주지 않는다({}) */
    params?: Record<string, string>;
};
/** 콜백의 실패·경고 한 줄씩 — export 쪽은 이것을 하네스 화면(systemMessage)에 보인다 */
export type Notes = string[];
/** Claude 의 matcher 규칙 — 비거나 * 면 모두, 영문·숫자·_·| 만이면 이름 목록, 그 밖은 정규식 */
export declare function matches(matcher: string | null, value: string | undefined): boolean;
export declare class HookRunner {
    private opts;
    private plugins;
    private nextCall;
    private closed;
    /** 열 때 돈 SessionStart 의 결과 중 첫 프롬프트에 넣을 것(context·stop) — 아직 넣지 않았으면 있다 */
    private opening;
    /** openSession 을 불렀다 — 그 뒤 SDK 가 startup·resume 으로 부르는 SessionStart 는 다시 돌리지 않는다 */
    private opened;
    constructor(opts: RunnerOpts);
    /** 세션을 열 때(core 기동마다) SessionStart(source) 를 돌린다 — message 는 바로 기록(emit)으로 화면에 나가고, context·stop 은 들고 있다가
     *  첫 주 에이전트 UserPromptSubmit 결과 앞에 합친다. 터미널 Claude 가 열 때 SessionStart 를 돌려 message 를 바로 보이는 것과 맞춘다 (ticket slcode-session-open-notice, 사용자 2026-11-01).
     *  SDK(0.3.282~0.3.312 실측)는 새 세션·resume 때 options.hooks 의 SessionStart 를 부르지 않는다(/clear 때만). 고쳐져 SDK 가 startup·resume 으로 부르면
     *  다시 돌리지 않고 들고 있던 것을 그 답으로 준다 — 두 번 돌지 않는다 */
    openSession(source: 'startup' | 'resume', at: {
        cwd: string;
        permissionMode?: string | null;
        vendorSessionId?: string | null;
    }): void;
    /** 들고 있던 것을 꺼낸다(한 번만) */
    private takeOpening;
    /** 실은 플러그인 목록(설치 순서)으로 맞춘다 — 빠진 것은 내리고, 빌드가 바뀐 것은 다시 띄우고, 같은 것은 둔다. 스크립트가 없는 플러그인은 worker 를 두지 않는다 */
    load(loaded: {
        name: string;
        build: string;
    }[]): void;
    /** SDK options.hooks — 받는 이벤트마다 디스패처 하나. 다시 싣기로 훅이 생겨도 받게 늘 모두 건다 */
    sdkHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>>;
    /** 이벤트 하나를 돌린다 — 하네스 훅 입력(Claude 꼴)을 받아 Claude 훅 JSON 출력을 돌려준다. notes 에 콜백의 실패·경고를 더한다 (hookBroker) */
    run(event: HookEvent, input: unknown, notes?: Notes): Promise<SyncHookJSONOutput>;
    close(): Promise<void>;
    private statePath;
    private readState;
    private writeState;
    private start;
    /** worker 를 내린다 — 그 worker 가 띄운 프로세스 그룹도 종료하고, 기다리던 콜백은 실패로 푼다. 다음 호출 때 다시 띄운다 */
    private terminate;
    private stop;
    private regsOf;
    private call;
    private dispatch;
    /** 콜백을 돌린다 — 열 때 들고 있던 것은 보지 않는다 */
    private fire;
    /** 결과를 합치고 콜백마다 기록을 낸다 */
    private merge;
}
