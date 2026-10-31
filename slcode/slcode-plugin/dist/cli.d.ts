#!/usr/bin/env node
export type PluginFlags = {
    to?: string[];
    remove?: boolean;
    json?: boolean;
};
/** plugin 하위 명령 하나. usage 는 인자가 틀렸을 때 부른다(돌아오지 않는다). tag 는 stderr 경고 줄의 머리 */
export declare function pluginCommand(sub: string | undefined, args: string[], flags: PluginFlags, dir: string, usage: (msg: string) => never, tag?: string): Promise<void>;
/** 단독 진입 — argv 는 node·스크립트 뒤 */
export declare function main(argv: string[]): Promise<number>;
