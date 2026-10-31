import type { SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { type HookEvent } from './hookApi.js';
export type Harness = 'claude' | 'codex';
export declare const HARNESSES: readonly Harness[];
/** export 한 플러그인 폴더 안에서 묶은 스크립트가 있는 곳 — scripts.json·scripts/<n>.mjs (세션 빌드 폴더의 것을 그대로 옮긴다) */
export declare const EXPORT_SCRIPTS_DIR = "slcode-hooks";
/** 데이터 폴더 안에서 slcode 가 쓰는 곳 — 플러그인 개발자의 다른 코드와 겹치지 않게 */
export declare const DATA_SUBDIR = ".slcode";
/** Codex 는 apply_patch 를 Edit·Write 로, spawn_agent 를 Agent 로도 맞춘다 (Codex hooks 문서) */
export declare const CODEX_ALIASES: Record<string, readonly string[]>;
/** 훅 명령 하나가 중간 프로세스에 보내는 요청 */
export type BrokerRequest = {
    v: 1;
    harness: Harness;
    root: string;
    data: string;
    event: HookEvent;
    input: Record<string, unknown>;
};
export type BrokerReply = {
    stdout: string;
};
/** 그 세션의 중간 프로세스 소켓 — 같은 세션이라도 slcode 설치가 다르면 따로 */
export declare function brokerSocket(harness: Harness, sessionId: string, install: string): string;
/** Claude 훅 JSON → Codex 훅 JSON. Codex 가 받지 않는 칸은 빼고 그 사유를 warnings 에 */
export declare function toCodex(event: HookEvent, out: SyncHookJSONOutput): {
    out: SyncHookJSONOutput;
    warnings: string[];
};
/** 중간 프로세스 — sock 에서 요청을 받는다. 이미 다른 것이 그 소켓을 쥐고 있으면 곧바로 끝난다 */
export declare function serveBroker(sock: string, opts?: {
    log?: (t: string) => void;
    idleMs?: number;
}): Promise<void>;
/** 훅 명령 한 번 — stdout 에 쓸 문자열을 돌려준다. spawnBroker 는 중간 프로세스를 띄운다(cli 가 자기 자신을 detached 로) */
export declare function hookCommand(harness: Harness, root: string, event: HookEvent, stdin: string, env: NodeJS.ProcessEnv, opts: {
    install: string;
    spawnBroker: (sock: string, cwd: string) => void;
}): Promise<string>;
export declare function isHookEvent(e: string): e is HookEvent;
