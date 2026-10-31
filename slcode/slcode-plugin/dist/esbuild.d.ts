export declare const ESBUILD_VERSION = "0.28.2";
/** agentHooks 가 쓰는 만큼의 esbuild API */
export type Esbuild = {
    buildSync(opts: Record<string, unknown>): {
        metafile: {
            outputs: Record<string, {
                imports: {
                    path: string;
                    external?: boolean;
                }[];
            }>;
        };
    };
};
/** esbuild — tools 는 캐시 폴더. 받지 못하면 사유를 던진다 (실패 뒤 RETRY_MS 동안은 받지 않고 같은 사유) */
export declare function loadEsbuild(tools: string): Esbuild;
