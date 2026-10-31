export type CheckHarness = 'claude' | 'codex';
export declare const TS_VERSION = "5.9.3";
/** 하네스별 `slcode/api` 선언 — 이벤트별 칸과 메서드는 hookApi 와 같다. 메서드는 그 하네스 표에 있는 것만 */
export declare function apiDts(harness: CheckHarness): string;
/** typescript 모듈 — 없으면 받는다. 실패면 사유를 던진다 */
export declare function ensureTypescript(stateDir: string): Promise<any>;
/** 검사 결과 — 하네스별 경고 줄("<파일>:<줄>: <진단>"), 검사를 못 했으면 skipped 에 사유 */
export type CheckResult = {
    warnings: Partial<Record<CheckHarness, string[]>>;
    skipped: string | null;
};
/** files(절대 경로, part 의 스크립트 원본)를 하네스마다 검사한다. base 는 경고에 쓸 상대 경로의 기준 */
export declare function checkScripts(files: string[], harnesses: CheckHarness[], stateDir: string, base: string): Promise<CheckResult>;
