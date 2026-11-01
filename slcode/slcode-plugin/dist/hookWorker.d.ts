import type { HookEvent, Method, Vars } from './hookApi.js';
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
export type WorkerInit = {
    slcodeHooks: true;
    scripts: {
        src: string;
        js: string;
    }[];
    states: Record<string, Record<string, unknown>>;
    methods: Record<HookEvent, readonly Method[]>;
    matchers: readonly HookEvent[];
    vars: Vars;
};
export type ToCore = {
    t: 'ready';
    regs: Reg[];
    errors: string[];
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
/** 스크립트 하나를 싣고 slcode.on() 등록을 모은다 — 싣는 중에 던지거나 옛 꼴(default 함수)이면 error. 등록 끝(import 가 끝나거나 slcode.run())
 *  뒤의 on() 은 late 로 알린다. 수집기는 묶인 slcode/api 사본이 평가될 때 잡으므로 import 가 끝나면 치운다 */
export declare function loadScript(js: string, vars: Vars, late: (event: string) => void): Promise<{
    regs: RawReg[];
    error: string | null;
    warnings: string[];
}>;
/** 등록을 검사해 Reg 꼴로 — 모르는 이벤트·함수가 아닌 콜백은 빼고 사유. id·src 는 부르는 쪽이 채운다 */
export declare function checkRegs(raw: RawReg[], methods: Record<HookEvent, readonly Method[]>, matchers: readonly HookEvent[]): {
    regs: (Omit<Reg, 'id' | 'src'> & {
        cb: (hook: unknown) => unknown;
    })[];
    errors: string[];
};
