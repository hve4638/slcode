export declare const REGISTRY = "https://registry.npmjs.org";
/** ustar 를 dest 에 푼다 — 일반 파일만 (npm 패키지 tarball). mode 의 실행 비트를 남긴다 */
export declare function untar(buf: Buffer, dest: string): void;
/** tarball 을 받아 무결성(sha512-…)을 대조한 뒤 푼 내용(tar) — 맞지 않으면 던진다 */
export declare function fetchTarball(url: string, integrity: string): Promise<Buffer>;
/** dir 을 fill 로 채운다 — 옆 임시 폴더에 만든 뒤 rename. 동시에 받았으면 먼저 놓인 것을 쓴다 */
export declare function placeDir(dir: string, fill: (tmp: string) => Promise<void>): Promise<void>;
