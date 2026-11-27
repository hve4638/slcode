export type GithubSource = {
    repo: string;
    ref: string | null;
    subdir: string | null;
};
/** https://github.com/<owner>/<repo>[.git][/tree/<ref>[/<하위 폴더>]] — 아니면 null(폴더 경로). ref 는 /tree/ 뒤 첫 마디뿐이라 / 가 든 브랜치 이름은 받지 못한다 */
export declare function githubSource(s: string): GithubSource | null;
/** into 에 clone 하고 플러그인 폴더를 돌려준다 — 실패면 git 의 fatal 줄로 던진다. into 는 부른 쪽이 지운다 */
export declare function fetchGithub(src: GithubSource, into: string, env?: NodeJS.ProcessEnv): Promise<string>;
