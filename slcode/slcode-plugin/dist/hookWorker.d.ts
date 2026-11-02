import type { CommandDef, HookEvent, Method, Vars } from './hookApi.js';
/** 프로세스 그룹을 종료한다 — Windows 는 그룹이 없어 프로세스 트리로 */
export declare function killGroup(pid: number): void;
/** 등록 하나 — id 는 worker 안의 번호 */
export type Reg = {
    id: number;
    event: HookEvent;
    matcher: string | null;
    timeout: number;
    failClosed: boolean;
    src: string;
};
/** 콜백 하나가 낸 결과 */
export type Result = {
    block: string[];
    ask: string[];
    allow: string[];
    input: Record<string, unknown> | null;
    context: string[];
    message: {
        text: string;
        icon?: string;
        tone?: string;
    }[];
    stop: string[];
};
/** core 가 보내는 이벤트 정보 — hook 객체의 정보 칸 */
export type Info = {
    event: HookEvent;
    session: {
        id: string;
        cwd: string;
        permissionMode: string | null;
        params: Record<string, string>;
    };
    agent: {
        id: string;
        type: string | null;
    } | null;
    raw: unknown;
    tool?: {
        name: string;
        input: Record<string, unknown>;
        useId: string;
        response?: unknown;
    };
    prompt?: string;
    source?: string;
    trigger?: string;
    reason?: string;
};
/** 실을 명령 — name 은 폴더 이름, js 는 묶은 파일 */
export type CmdScript = {
    name: string;
    src: string;
    js: string;
};
/** run 에 넘길 정보 */
export type CmdInfo = {
    plugin: string;
    name: string;
    args: string;
    session: Info['session'];
};
/** complete 에 넘길 정보 — state 는 저장된 주 에이전트 상태 */
export type CompleteInfo = {
    plugin: string;
    name: string;
    args: string[];
    index: number;
    value: string;
    raw: string;
    session: Info['session'];
    state: Record<string, unknown>;
};
export type CmdResult = {
    context: string[];
    message: Result['message'];
};
export type Item = {
    value: string;
    label?: string;
    description?: string;
};
/** role 'complete' 는 complete 만 부르는 worker — 훅 스크립트는 싣지 않는다 */
export type WorkerInit = {
    slcodeHooks: true;
    role?: 'main' | 'complete';
    scripts: {
        src: string;
        js: string;
    }[];
    commands?: CmdScript[];
    states: Record<string, Record<string, unknown>>;
    methods: Record<HookEvent, readonly Method[]>;
    matchers: readonly HookEvent[];
    vars: Vars;
    completeMax?: number;
};
export type ToCore = {
    t: 'ready';
    regs: Reg[];
    errors: string[];
    commands?: string[];
} | {
    t: 'done';
    id: number;
    ms: number;
    error: string | null;
    result: Result;
    agent: string;
    changes: Record<string, string | null>;
    warnings: string[];
} | {
    t: 'cmdDone';
    id: number;
    ms: number;
    error: string | null;
    result: CmdResult;
    changes: Record<string, string | null>;
    warnings: string[];
} | {
    t: 'completeDone';
    id: number;
    items: Item[];
    error: string | null;
} | {
    t: 'pgid';
    pid: number;
    on: boolean;
} | {
    t: 'warn';
    text: string;
};
export type ToWorker = {
    t: 'call';
    id: number;
    reg: number;
    info: Info;
} | {
    t: 'drop';
    agent: string;
} | {
    t: 'cmd';
    id: number;
    info: CmdInfo;
} | {
    t: 'complete';
    id: number;
    info: CompleteInfo;
};
export declare const DEFAULT_TIMEOUT = 10;
/** JSON 으로 왕복하지 않는 값이면 그 꼴 이름 — 객체 안의 undefined 는 키가 없는 것과 같아 받는다 */
export declare function notJson(v: unknown, seen?: Set<object>): string | null;
/** slcode.on() 한 번 — 검사 전 */
export type RawReg = {
    event: string;
    opts: Record<string, unknown>;
    cb: unknown;
};
/** 스크립트 하나를 싣고 slcode.on()·slcode.command() 등록을 모은다 — 싣는 중에 던지거나 옛 꼴(default 함수)이면 error. 등록 끝(import 가 끝나거나 slcode.run())
 *  뒤의 on() 은 late 로 알린다. 수집기는 묶인 slcode/api 사본이 평가될 때 잡으므로 import 가 끝나면 치운다.
 *  kind 'command' 는 COMMAND 파일 — command() 를 모으고(검사는 checkCommand), slcode.run() 이 없어도 경고하지 않는다. 훅 스크립트의 command() 는 무시하고 경고한다 */
export declare function loadScript(js: string, vars: Vars, late: (event: string) => void, kind?: 'hooks' | 'command'): Promise<{
    regs: RawReg[];
    cmds: unknown[];
    error: string | null;
    warnings: string[];
}>;
/** COMMAND 파일의 등록 검사 — command() 정확히 한 번, description(비지 않은 글)·run(함수) 필수, complete 는 함수, argumentHint 는 글, timeout 은 양수.
 *  꼴이 틀리면 error(플러그인 적용 실패, 사용자 결정 2026-11-02), 모르는 칸은 warnings(새 판의 칸일 수 있다) */
export declare function checkCommand(cmds: unknown[], onCalls: number): {
    def: CommandDef | null;
    error: string | null;
    warnings: string[];
};
/** 등록을 검사해 Reg 꼴로 — 모르는 이벤트·함수가 아닌 콜백은 빼고 사유. id·src 는 부르는 쪽이 채운다 */
export declare function checkRegs(raw: RawReg[], methods: Record<HookEvent, readonly Method[]>, matchers: readonly HookEvent[]): {
    regs: (Omit<Reg, 'id' | 'src'> & {
        cb: (hook: unknown) => unknown;
    })[];
    errors: string[];
};
