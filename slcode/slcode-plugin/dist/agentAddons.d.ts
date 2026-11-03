import { type Manifest, type Values } from './agentFormat.js';
import type { AgentConfig, AgentPaths, PluginEntry } from './agentPlugins.js';
export type AddonEntry = {
    version: string;
    /** 설치한 원본의 내용 해시 */
    hash: string;
    source: string;
    installedAt: number;
    base: string;
    /** 베이스 판의 조건 */
    range: string;
    /** 이 애드온의 part·옵션 값 (plugin set <베이스>) — 베이스 칸이 아니라 여기에 둔다: 제거하면 함께 사라지고, 잠시 빠져도, 옛 사본이 베이스 값을 정리해도 남는다 */
    values: Values;
};
export type Addons = Record<string, AddonEntry>;
/** on 이 거짓이면 빌드에서 뺀 것이고 why 가 사유다 */
export type AddonState = {
    name: string;
    version: string;
    base: string;
    range: string;
    on: boolean;
    why: string | null;
    source: string;
};
export type Assembled = {
    /** 합친 manifest — 이름·판은 베이스의 것, part·옵션은 베이스 다음 실린 애드온 순서 */
    m: Manifest;
    /** 빌드 식별자에 넣는 해시 — 실린 애드온이 없으면 베이스 해시 그대로 */
    hash: string;
    /** 플러그인 기본 설정 층 */
    values: Values;
    addons: AddonState[];
    /** 실린 애드온의 part·옵션 이름 → 애드온 이름 */
    owners: Record<string, string>;
};
export declare const addonDir: (ap: AgentPaths, name: string) => string;
export declare function readAddons(ap: AgentPaths): Addons;
/** 애드온 사슬의 맨 아래 플러그인 이름 — 사슬이 끊겼거나 순환이면 null */
export declare function rootOf(name: string, c: Pick<AgentConfig, 'plugins'>, addons: Addons): string | null;
/** 그 이름에 직접·간접으로 의존하는 애드온 (설치 순서) */
export declare function dependentsOf(name: string, addons: Addons): string[];
/** 베이스 name 과 거기 이어진 애드온을 합친다. dirOf 는 애드온 폴더 — add 가 아직 설치하지 않은 원본으로 미리 볼 때 바꾼다 */
export declare function assemble(ap: AgentPaths, name: string, e: PluginEntry, addons?: Addons, dirOf?: (addon: string) => string): Assembled;
