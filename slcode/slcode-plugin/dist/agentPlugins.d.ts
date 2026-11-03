import { type Harness, type Manifest, type Values } from './agentFormat.js';
import { type Report } from './agentBuild.js';
import { type ExportHarness, type ExportReport, type ExportResult } from './agentExport.js';
import { type Addons, type AddonState } from './agentAddons.js';
export declare const AGENT_DIR = "agent-plugins";
/** 세션 폴더 안의 링크 폴더 — agent-plugins/<이름> → build/<식별자>/claude/<이름> (Codex 는 build/<식별자>/codex, 다시 실은 skill 의 빌드는 <이름>@skills) */
export declare const SESSION_LINKS = "agent-plugins";
export type AgentPaths = {
    dir: string;
    installed: string;
    addons: string;
    config: string;
    lock: string;
    build: string;
    export: string;
    data: string;
    sessionsDir: string;
};
export declare function agentPaths(stateDir?: string): AgentPaths;
export type PluginEntry = {
    version: string;
    /** 설치한 원본의 내용 해시 — 같으면 add 가 아무것도 하지 않는다 */
    hash: string;
    /** add 에 준 폴더 (기록만) */
    source: string;
    installedAt: number;
    grade: 'full' | 'partial';
    /** 하네스마다 빠지는 것 — 모든 part 기준 */
    lost: Record<Harness, string[]>;
    /** 플러그인 기본 설정 (slcode plugin set) — manifest 기본값 위, 프로필·세션 아래 */
    values: Values;
    /** 하네스별 마지막 빌드 — 기본 설정으로 만든 것 */
    builds: Partial<Record<Harness, string>>;
    /** export 한 하네스 (slcode plugin export) — 리빌드 때 다시 쓰고, remove 때 해제한다 */
    exports?: ExportHarness[];
};
/** plugins 의 키 순서가 설치 순서 — 지시문을 이 순서로 잇는다. profiles 는 slcode 의 사용자 프로필(slcode profiles.ts) — 여기서는 그대로 둔다 */
export type AgentConfig = {
    format?: number;
    plugins: Record<string, PluginEntry>;
    addons?: Addons;
    profiles?: Record<string, unknown>;
};
/** 세션을 띄울 때 고른 층 — 실을 플러그인과 그 값. slcode 의 시작 프로필이 이 꼴을 품는다 (ticket slcode-session-profile) */
export type PluginLayer = {
    plugins: Record<string, Values & {
        on?: boolean;
    }>;
    rest: boolean;
};
/** 그 플러그인을 이 층으로 싣는가 */
export declare const loadsPlugin: (p: PluginLayer, name: string) => boolean;
/** 그 플러그인의 이 층 값 (on 은 뺀다) */
export declare function profileValues(p: PluginLayer, name: string): Values | undefined;
/** 상태 폴더 형식 판 (ticket slcode-plugin-split) — 한 머신의 여러 slcode-plugin 사본(slcode·superlite-for-agents 가 넣어 간 것)이 같은 상태 폴더를 쓴다.
 *  형식은 하위호환으로만 바꾸고(칸 더하기), 옛 사본이 읽지 못하게 바꿀 때만 올린다. 이 판보다 높은 상태 폴더에는 쓰지 않는다 */
export declare const STATE_FORMAT = 1;
export declare function readConfig(ap: AgentPaths): AgentConfig;
export declare function writeConfig(ap: AgentPaths, c: AgentConfig): void;
export declare function locked<T>(ap: AgentPaths, fn: () => T): Promise<T>;
/** 세션을 띄우는 하네스 — slcode 는 Claude·Codex 를 띄운다 */
export type SessionHarness = 'claude' | 'codex';
/** base 는 애드온을 add 했을 때 합쳐진 플러그인 이름 — build·grade·lost 는 그 플러그인의 것. leftOut 은 판이 맞지 않거나 이름이 겹쳐 빌드에서 뺀 애드온과 사유 */
export type AddResult = {
    name: string;
    version: string;
    changed: boolean;
    grade: 'full' | 'partial';
    lost: Record<Harness, string[]>;
    build: string | null;
    base?: string;
    leftOut?: string[];
    exports?: ExportResult[];
};
/** export 한 플러그인이 있으면 훅 명령의 고정 런처를 이 사본 기준으로 맞춘다 (launcher.ts) — CLI 명령과 세션 시작 때. 사본의 node 가 바뀌어도 다음 실행에 고쳐진다 */
export declare function refreshLauncher(ap: AgentPaths, c?: AgentConfig): void;
/** 원본을 installed/<이름>/ 에 복사한다(애드온은 addons/<이름>/). 내용 해시가 같으면 아무것도 하지 않는다. 새 판이면 기본 설정(맞는 값만 남긴다)으로 다시 빌드한다.
 *  manifest 가 없거나 깨졌으면 던진다. 베이스를 새 판으로 바꾸면 조건이 맞지 않는 애드온만 빌드에서 빠지고 leftOut 에 사유가 남는다 */
export declare function addPlugin(src: string, stateDir?: string, env?: NodeJS.ProcessEnv): Promise<AddResult>;
/** 원본·설정 항목·export 를 지운다. 없으면 성공 (removed false). export 를 먼저 해제한다 — 링크가 사라진 빌드를 가리키면 하네스가 오류를 낸다.
 *  이름이 애드온이면 그 애드온만 지우고 베이스를 다시 빌드한다. 의존하는 애드온이 있으면 cascade 없이는 던지고, cascade 면 함께 지운다 */
export declare function removePlugin(name: string, stateDir?: string, env?: NodeJS.ProcessEnv, cascade?: boolean): Promise<{
    name: string;
    removed: boolean;
    addons?: string[];
    exports?: ExportResult[];
}>;
/** export 하거나(--to) 해제한다(--remove). 설정 값은 플러그인 기본 설정 — 프로필 고르기는 미정. 하네스 CLI(claude·codex)를 env 의 PATH 에서 부른다 */
export declare function exportPlugin(name: string, harnesses: string[], remove: boolean, stateDir?: string, env?: NodeJS.ProcessEnv): Promise<ExportResult[]>;
/** 플러그인 기본 설정에서 part 를 켜고 끄거나 옵션 값을 바꾼다 — `<part>=on|off`, `<옵션>=<값>` 여럿. 하나라도 틀리면 아무것도 바꾸지 않는다 */
export declare function setPlugin(name: string, assignments: string[], stateDir?: string, env?: NodeJS.ProcessEnv): Promise<{
    name: string;
    values: string;
    build: string;
    exports?: ExportResult[];
}>;
export type PluginRow = {
    name: string;
    version: string;
    grade: 'full' | 'partial';
    lost: Record<Harness, string[]>;
    source: string;
    installedAt: number;
    /** on 은 사용자 설정(기본 설정 기준) — when 은 조건 글(whenText)이고 세션마다 따로 본다. 기본 빌드·export 판은 param·env 가 없는 것으로 판단한다. needs 는 조건 when part 의 대상 — 관리 화면이 대상이 꺼진 part 를 비활성으로 보인다 */
    parts: {
        name: string;
        on: boolean;
        required: boolean;
        default: boolean;
        when: string | null;
        needs: string[];
        addon: string | null;
    }[];
    options: {
        name: string;
        type: string;
        value: unknown;
        default: unknown;
        label: string | null;
    }[];
    /** 하네스별 마지막 빌드의 report.json — 빌드가 없으면 null */
    reports: Partial<Record<Harness, Report | null>>;
    /** 이 플러그인에 이어진 애드온 — on 이 거짓이면 빌드에서 뺀 것이고 why 가 사유. 판은 row.version(베이스)과 따로 적는다 */
    addons: AddonState[];
    /** export 한 하네스 */
    exports: ExportHarness[];
    /** export 한 하네스별 export 판의 report.json — 아직 만들지 않았거나 읽지 못하면 null */
    exported: Partial<Record<ExportHarness, ExportReport | null>>;
};
/** 설치 목록 — 기본 설정 기준의 part·옵션 값과 마지막 빌드 보고 */
export declare function listPlugins(stateDir?: string): PluginRow[];
/** 베이스가 없어 어디에도 실리지 않는 애드온 — 옛 사본이 베이스를 지웠을 때 남는다. 베이스를 다시 add 하면 돌아온다 */
export declare function orphanAddons(stateDir?: string): {
    name: string;
    version: string;
    base: string;
}[];
/** 합친 manifest — slcode 프로필이 애드온의 part·옵션 값을 받을 때 쓴다 */
export declare function pluginManifest(ap: AgentPaths, c: AgentConfig, name: string): Manifest;
/** 빌드한 js/ts 훅의 보고 줄 — 빼거나 고칠 것과 하네스별 tsc 검사 경고 (ticket slcode-agent-plugin-script-portable). build 는 Claude 빌드(스크립트는 거기서 묶는다).
 *  CLI 의 add·set 이 stderr 에, 웹 관리 화면이 플러그인 칸에 보인다. 경고일 뿐 빌드는 그대로 */
export declare function scriptWarnings(name: string, build: string, stateDir?: string): Promise<string[]>;
/** Codex 빌드에서 세션에 넘기는 것 — root 는 빌드의 플러그인 폴더(경로 변수를 바꾼 값), skills 는 extra root, bin 은 PATH 앞에 둘 폴더, args 는 app-server 인자 */
export type CodexLoad = {
    root: string;
    skills: string | null;
    bin: string | null;
    binSum: string;
    args: string[];
};
/** 세션에 실은 플러그인 하나. instructions·env·settings(·codex 의 bin·args) 는 세션을 띄울 때 넘긴 값이다 — 다시 싣기로 바뀌지 않는다 */
export type Loaded = {
    name: string;
    version: string;
    build: string;
    values: string;
    instructions: string;
    env: Record<string, string>;
    settings: Record<string, unknown> | null;
    codex?: CodexLoad;
};
export type SessionPlugins = {
    /** SDK query options.plugins */
    plugins: {
        type: 'local';
        path: string;
    }[];
    /** 모든 플러그인의 지시문 (설치 순서) — SLCODE_PROMPT 뒤에 붙는다 */
    append: string;
    /** session.json 을 합친 것 (뒤의 플러그인이 이긴다) — SDK options.settings. 없으면 null */
    settings: Record<string, unknown> | null;
    /** manifest env 를 합친 것 */
    env: Record<string, string>;
    loaded: Loaded[];
    /** 싣지 못한 플러그인과 사유 — 세션은 오류 없이 뜬다 */
    notes: string[];
    /** Codex 세션 — skill extra root 들, PATH 앞에 둘 bin/ 들, app-server 인자 (설치 순서) */
    codex: {
        roots: string[];
        bin: string[];
        args: string[];
    };
};
/** 세션 단위 설정 값 — 플러그인 이름별 (slcode-session-profile 이 meta 에 채운다) */
export type SessionValues = Record<string, Values | undefined>;
/** 세션 인자 (slcode new --param, ticket slcode-agent-plugin-part-when) — part 조건 when 이 본다. 플러그인 모두에 같다 */
export type SessionParams = Record<string, string>;
/** Claude 가 플러그인 데이터 폴더로 쓰는 곳 — <설정 폴더>/plugins/data/<이름>-inline (SDK 로 실은 플러그인의 출처는 inline) */
export declare function claudeDataDir(name: string, env: NodeJS.ProcessEnv): string;
/** 세션을 띄울 때 — 설치한 플러그인마다 그 하네스의 빌드를 만들고(있으면 다시 쓰고) 세션 폴더에 링크를 건다. 싣지 못한 것은 notes 에.
 *  Codex 는 링크로 빌드를 정리에서 지킬 뿐, 넘기는 경로는 빌드 폴더 그대로다 (빌드 안의 경로 변수를 이미 그 경로로 바꿨다).
 *  프로필이 있으면 그 프로필이 싣는 플러그인만, 설정 값은 기본 설정 < 프로필 < 세션 (ticket slcode-session-profile). params 는 세션 인자 — 켠 part 의 조건 when 이 본다. env 도 그대로 조건이 보고, manifest env 는 보지 않는다(part 가 자기 조건을 스스로 켤 수 있다, ticket slcode-agent-plugin-part-when-part) */
export declare function loadSessionPlugins(sessionDir: string, env: NodeJS.ProcessEnv, session?: SessionValues, stateDir?: string, harness?: SessionHarness, profile?: PluginLayer, params?: SessionParams): SessionPlugins;
/** 다시 싣기 — 실은 플러그인의 링크를 지금 설정의 빌드로 바꾼다. 지운 플러그인은 링크를 뗀다. SDK reloadPlugins()·Codex skills/extraRoots/set 은 부른 쪽이 한다.
 *  later 는 이 세션에 반영되지 않아 새 세션부터인 것 (지시문·env·session.json·Codex 의 MCP·bin 이 바뀐 플러그인, 세션 뒤에 설치한 플러그인).
 *  Codex 는 skill 만 다시 싣는다 — 기동 때의 빌드는 <이름> 링크로 남기고(MCP·bin 이 아직 그것을 쓴다) 새 빌드는 <이름>@skills 링크로 지킨다. roots 는 새 extra root 들 */
export type Later = {
    name: string;
    what: ('instructions' | 'env' | 'session.json' | 'mcp' | 'bin' | 'installed')[];
};
export declare function reloadSessionPlugins(sessionDir: string, loaded: Loaded[], env: NodeJS.ProcessEnv, session?: SessionValues, stateDir?: string, harness?: SessionHarness, profile?: PluginLayer, params?: SessionParams): {
    loaded: Loaded[];
    later: Later[];
    removed: string[];
    roots: string[];
    notes: string[];
};
/** 지금 설정으로 빌드하면 나올 식별자 — 세션이 실은 것과 다르면 다시 실을 것이 있다. 빌드하지 않는다 */
export declare function currentBuilds(session?: SessionValues, stateDir?: string, harness?: SessionHarness, profile?: PluginLayer, params?: SessionParams, env?: NodeJS.ProcessEnv): Record<string, string | null>;
/** 세션이 닫힐 때 — 링크를 떼어 그 빌드를 정리 대상으로 */
export declare function unlinkSessionPlugins(sessionDir: string): void;
/** 아무도 가리키지 않는 오래된 빌드를 지운다 — config 의 마지막 빌드, 세션 폴더의 링크, export/ 아래 링크가 가리키는 것은 남긴다.
 *  removed 는 방금 지운 플러그인 이름 — 그 플러그인의 빌드는 유예 없이 지운다 */
export declare function gcBuilds(stateDir?: string, graceMs?: number, removed?: string): string[];
