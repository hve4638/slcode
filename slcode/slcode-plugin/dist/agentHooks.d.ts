/** 스크립트의 등록 하나 — 목록 모드가 본 것(콜백은 빼고) */
export type ListedReg = {
    event: string;
    matcher: string | null;
    timeout: number;
    failClosed: boolean;
};
/** 빌드 폴더의 스크립트 목록 — src 는 "<part>/<file>", js 는 빌드 폴더 기준 경로, regs 는 하네스별 등록 목록(스크립트가 slcode.vars.harness 로 등록을 바꿀 수 있다) */
export type ListHarness = 'claude' | 'codex';
export type ScriptEntry = {
    src: string;
    js: string;
    regs?: Partial<Record<ListHarness, ListedReg[]>>;
};
/** missing 은 esbuild 를 받지 못해 스크립트를 묶지 못한 사유 — 빌드는 그것만 빼고 만들고, 다음 빌드 때 다시 받아 본다 */
export type PartHooks = {
    claude: Record<string, unknown[]>;
    dropped: string[];
    failed: string[];
    warnings: string[];
    missing: string | null;
};
/** 빌드가 command 문자열에 넣는 하네스 — `${slcode.vars.harness}` 의 값 (js/ts 는 slcode.vars.harness) */
export type HookHarness = 'claude' | 'codex';
/** Codex 0.165 가 받는 훅 이벤트 (Codex 문서 hooks.md) — 그 밖의 command 항목은 Codex export 에서 뺀다 */
export declare const CODEX_EVENTS: Set<string>;
/** command 항목 하나 → { event, Claude 형식 묶음 }. 틀리면 사유. 문자열 칸의 ${slcode.vars.harness} 는 그 하네스 이름으로 바꾼다 */
export declare function commandGroup(e: Record<string, any>, harness: HookHarness): {
    event: string;
    group: Record<string, unknown>;
} | string;
/** part 하나의 hooks.json 에서 command 항목만 그 하네스의 Claude 형식으로 — events 에 없는 이벤트와 script 항목은 excluded 에. 목록이 아니면 null */
export declare function partCommandHooks(j: unknown, part: string, harness: HookHarness, events: Set<string>): {
    hooks: Record<string, unknown[]>;
    excluded: string[];
} | null;
/** part 하나의 hooks.json 내용 j — 목록이 아니면 null(파일째 뺀다). script 는 out 아래에 묶어 scripts 에 더한다. tools 는 esbuild 캐시 폴더 */
export declare function buildPartHooks(pdir: string, part: string, j: unknown, out: string, scripts: ScriptEntry[], harness?: HookHarness, tools?: string): PartHooks | null;
/** 묶은 스크립트를 따로 띄운 node 에서 한 번 실어 등록 목록을 받는다 — 싣다가 던지거나 옛 꼴이면 error, 잘못된 등록·slcode.run() 이 없는 것은 warnings */
export declare function listScript(file: string, harness: ListHarness): {
    regs: ListedReg[];
    error: string | null;
    warnings: string[];
};
/** 빌드 폴더의 scripts.json — 없거나 깨졌으면 [] */
export declare function readScripts(file: string): ScriptEntry[];
/** 등록들의 matcher 를 하나로 — 하나라도 전부면 null. 이름 목록끼리는 잇고, 정규식이 섞이면 정규식 하나로. 넓게 맞춰도 중간 프로세스가 등록마다 다시 거른다 */
export declare function unionMatcher(matchers: (string | null)[]): string | null;
/** 이 사본의 node·hookMain.js 절대 경로 — 고정 런처(launcher.ts)가 가리키는 곳. PATH 의 `slcode` 는 쓰지 않는다: 터미널의 .bashrc 가
 *  ~/.local/bin 을 앞에 붙이면 옛 slcode 로 가 훅이 실패했다(ticket slcode-session-path-rc-override, 사용자 2026-10-31) */
export declare function hookLaunch(): string[];
/** export 한 플러그인의 hooks.json 내용(Claude 객체 꼴 — Codex 도 같은 꼴). 이벤트마다 command 하나(플러그인의 스크립트를 모두 중간 프로세스가 돌린다).
 *  launch 는 훅 명령 앞부분(상태 폴더의 고정 런처 — launcher.ts). 플러그인 폴더는 변수로 둔다 — 빌드가 바뀌어도 명령 문자열은 같다. Codex 는 그래도 플러그인 내용이 바뀌면 신뢰를 다시 묻는다(사용자가 훅 검토 화면에서 신뢰, 사용자 결정 2026-10-31).
 *  SessionEnd 는 등록이 없어도 넣는다 — 중간 프로세스를 끝낸다. timeout 은 그 이벤트 콜백 timeout 의 최대 + 중간 프로세스를 띄우는 시간 */
export declare function exportHookEntries(scripts: ScriptEntry[], harness: 'claude' | 'codex', launch: string[]): Record<string, unknown[]>;
/** Codex export 의 report.json 에 적을 메울 수 없는 차이 — 스크립트의 등록을 본다 */
export declare function codexGaps(scripts: ScriptEntry[]): string[];
