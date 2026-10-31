import { type Harness, type Manifest, type Resolved } from './agentFormat.js';
export type Report = {
    harness: Harness;
    name: string;
    version: string;
    build: string;
    values: string;
    /** 켠 part (parts 순서) */
    parts: string[];
    /** 지시문 — used 는 합친 순서, skipped 는 if 가 거짓이거나 판단할 수 없는 것 */
    instructions: {
        used: string[];
        skipped: string[];
    };
    /** 뒤의 part 가 덮어쓴 경로·MCP 서버 */
    overridden: string[];
    /** 문법이 깨져 뺀 파일 */
    dropped: string[];
    /** 이 하네스가 받지 못해 뺀 것 (agentFormat.partLost 와 같은 규칙) */
    lost: string[];
    /** js/ts 훅 (Claude, ticket slcode-agent-plugin-hooks) — built 는 묶은 스크립트("<part>/<file>"), failed 는 묶지 못해 뺀 것과 사유, warnings 는 넣었지만 고칠 것(잘못된 등록 등) */
    scripts?: {
        built: string[];
        failed: string[];
        warnings: string[];
    };
    /** esbuild 를 받지 못해 js/ts 훅을 뺀 사유 (ticket slcode-plugin-split) — 이 빌드는 다음 ensureBuild 때 다시 만든다 */
    toolMissing?: string;
};
/** 빌드 폴더 안의 이름들 — build/<식별자>/ 아래. codexArgs 는 Codex 빌드의 app-server 인자(-c mcp_servers…).
 *  codexMcp·codexHooks 는 Codex export 가 플러그인의 .mcp.json·hooks/hooks.json 으로 쓴다 — slcode 의 Codex 세션은 쓰지 않는다 */
export declare const BUILD_FILES: {
    readonly report: "report.json";
    readonly instructions: "instructions.md";
    readonly settings: "session.json";
    readonly codexArgs: "codex-args.json";
    readonly codexMcp: "codex-mcp.json";
    readonly codexHooks: "codex-hooks.json";
    readonly scripts: "scripts.json";
};
/** src(설치한 원본)의 켠 part 를 out 에 Claude 빌드로 쓴다 — out/claude/<이름>/ (플러그인 폴더), instructions.md, session.json(있으면), report.json. tools 는 esbuild 캐시 폴더 */
export declare function buildClaude(src: string, m: Manifest, r: Resolved, id: string, out: string, tools?: string): Report;
/** src 의 켠 part 를 out 에 Codex 빌드로 쓴다 — out/codex/(플러그인 폴더: skills/·bin/·그 밖의 part 파일), instructions.md, codex-args.json, report.json.
 *  훅·raw/ 는 slcode 의 Codex 세션에 싣지 않는다(report.lost). Codex 는 경로 변수를 모르므로 모든 텍스트 파일·지시문·MCP 정의에서 ${CLAUDE_PLUGIN_ROOT} 는 root,
 *  ${CLAUDE_PLUGIN_DATA} 는 data 로 바꾼다 — root 는 그 플러그인 폴더가 놓일 경로다(세션 빌드는 rename 뒤의 빌드 폴더/codex, export 는 export 링크).
 *  Codex export 용으로 codex-mcp.json(이름을 바꾼 서버)과 codex-hooks.json(command 훅 중 Codex 가 받는 이벤트, ${slcode.vars.harness} 는 codex)도 쓴다 */
export declare function buildCodex(src: string, m: Manifest, r: Resolved, id: string, out: string, root: string, data: string): Report;
/** Claude skill → Codex skill. Codex 는 frontmatter 가 없으면 싣지 않으므로 name·description 만으로 다시 쓴다(그 밖의 필드는 Codex 가 무시한다 — partLost 가 적었다).
 *  description 이 없으면 본문 첫 줄, when_to_use 는 그 뒤에 잇는다. disable-model-invocation 은 agents/openai.yaml 의 allow_implicit_invocation: false 로 */
export declare function codexSkill(text: string, folder: string): {
    md: string;
    yaml: string | null;
};
/** 그 식별자의 빌드가 있으면 다시 쓰고, 없으면 임시 폴더에 빌드한 뒤 rename. 동시에 둘이 빌드하면 먼저 놓인 것을 쓴다.
 *  retry 면 esbuild 를 받지 못해 js/ts 훅을 뺀 빌드(toolMissing)를 다시 만들어 본다(add·set — 부른 쪽이 export 도 다시 쓴다). 그래도 못 받으면 있던 것을 쓴다 */
export declare function ensureBuild(buildDir: string, src: string, m: Manifest, r: Resolved, hash: string, harness?: Harness, retry?: boolean): {
    id: string;
    dir: string;
    report: Report;
};
