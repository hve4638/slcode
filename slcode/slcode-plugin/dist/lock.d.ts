export declare function pidAlive(pid: number): boolean;
export type LockResult = {
    ok: true;
} | {
    ok: false;
    holder: number;
};
/**
 * 잠금을 쥔다. 살아 있는 소유자가 있으면 waitMs 동안 100ms 간격으로 다시 본다 (종료 중 틈).
 * 죽은 소유자의 잠금은 스테일로 보고 지운다.
 */
export declare function acquireLock(lockPath: string, pid?: number, waitMs?: number): Promise<LockResult>;
export declare function readPid(p: string): number;
/** 소유자만 지운다 — 다른 core 가 이미 새 잠금을 만들었을 수 있다 */
export declare function releaseLock(lockPath: string, pid?: number): void;
