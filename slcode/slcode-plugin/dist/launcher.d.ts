export declare const PLUGIN_VERSION: string;
export declare const launcherPath: (agentDir: string) => string;
/** 런처를 맞추고 그 경로를 돌려준다. 다른 사본이 쓴 것이 살아 있고 그 판이 이 판보다 낮지 않으면 그대로 둔다 */
export declare function ensureLauncher(agentDir: string): string;
