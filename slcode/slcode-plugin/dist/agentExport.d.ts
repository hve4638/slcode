import { type Manifest } from './agentFormat.js';
import type { AgentPaths, PluginEntry } from './agentPlugins.js';
export declare const EXPORT_HARNESSES: readonly ["claude", "codex"];
export type ExportHarness = (typeof EXPORT_HARNESSES)[number];
/** 두 하네스에 등록하는 마켓플레이스 이름 — 플러그인은 <이름>@slcode */
export declare const MARKETPLACE = "slcode";
/** export 판의 report.json — excluded 는 이 하네스 단독 실행에서 빠지거나 다르게 도는 것 */
export type ExportReport = {
    harness: ExportHarness;
    name: string;
    version: string;
    build: string;
    values: string;
    excluded: string[];
};
export type ExportResult = {
    name: string;
    harness: ExportHarness;
    removed: boolean;
    build: string | null;
    link: string | null;
    excluded: string[];
    notes: string[];
};
export declare const exportLink: (ap: AgentPaths, h: ExportHarness, name: string) => string;
/** 그 하네스의 export 판 — build/<식별자>/export/<하네스>/{<이름>/, report.json}. 있으면 다시 쓰고, 없으면 옆에 만든 뒤 rename */
/** 켜 둔 조건 part — 세션 인자가 없어 기본 빌드에서 이미 빠졌다 (ticket slcode-agent-plugin-part-when, 사용자 결정 2026-11-02).
 *  조건으로 꺼진 빌드와 사용자가 끈 빌드는 식별자가 같아 export 판의 report.json 을 함께 쓴다 — 그래서 저장하지 않고 읽을 때마다 붙인다 */
export declare function withPartConditions(report: ExportReport, m: Manifest, e: PluginEntry): ExportReport;
export declare function exportBuild(ap: AgentPaths, name: string, e: PluginEntry, h: ExportHarness, env: NodeJS.ProcessEnv): {
    id: string;
    plugin: string;
    report: ExportReport;
};
/** export 하거나 다시 쓴다 — 판을 만들고, 링크를 걸고, 마켓플레이스에 넣고, 하네스에 등록한다. names 는 이 하네스에 export 한 플러그인(이 플러그인 포함).
 *  등록에 실패하면 링크·마켓플레이스를 되돌리고 던진다 */
export declare function exportTo(ap: AgentPaths, name: string, e: PluginEntry, h: ExportHarness, names: string[], env: NodeJS.ProcessEnv): ExportResult;
/** 리빌드 뒤 — 링크를 새 판으로 바꾼다. Claude 는 그것으로 끝(열린 세션은 /reload-plugins), Codex 는 캐시 복사본을 다시 쓴다. 실패는 notes 로 (리빌드를 막지 않는다) */
export declare function refreshExport(ap: AgentPaths, name: string, e: PluginEntry, h: ExportHarness, env: NodeJS.ProcessEnv): ExportResult;
/** 해제 — 하네스에서 지우고, 링크를 떼고, 마켓플레이스에서 뺀다. 남은 플러그인이 없으면 마켓플레이스도 지운다. names 는 해제 뒤 남는 플러그인.
 *  하네스 쪽 실패(이미 지웠음·CLI 없음)는 notes 로 — slcode 쪽은 늘 지운다 */
export declare function unexport(ap: AgentPaths, name: string, h: ExportHarness, names: string[], env: NodeJS.ProcessEnv): ExportResult;
