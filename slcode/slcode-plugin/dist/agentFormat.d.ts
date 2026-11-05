export declare const MANIFEST = "slcode-plugin.json";
/** 애드온의 manifest (ticket slcode-plugin-addon) — 파일 이름이 다르므로 옛 사본은 add 를 "no slcode-plugin.json" 으로 거절한다. slcode-plugin.json 에 addon 칸만 더하면 옛 사본이 독립 플러그인으로 설치한다(0.3.0·0.4.0 실측) */
export declare const ADDON_MANIFEST = "slcode-addon.json";
/** 빌드기 판 — 빌드 결과가 달라지는 변경이면 올린다. 빌드 식별자에 들어가 옛 빌드를 다시 쓰지 않게 한다 */
export declare const BUILDER = 7;
/** 호환 등급을 매기는 하네스 — gpt 는 GPT 하네스(장기적으로 Codex 자리, 아직 slcode 가 띄우지 않는다) */
export declare const HARNESSES: readonly ["claude", "gpt", "codex"];
export type Harness = (typeof HARNESSES)[number];
export type OptionType = 'boolean' | 'string' | 'number';
export type OptionSpec = {
    type: OptionType;
    default: boolean | string | number;
    label?: string;
};
type WhenValues = Record<string, true | string | string[]>;
/** part 를 켜는 조건 (ticket slcode-agent-plugin-part-when, -part-when-part) — part 는 같은 플러그인 part 가 최종적으로 켜졌는가(true 만), param(slcode new --param)·env(세션 에이전트가 받는 env)는
 *  이름마다 true(있고 비어 있지 않음)·"값"(같음)·["값", …](그중 하나). 칸과 이름 모두 참이어야 참 */
export type When = {
    part?: Record<string, true>;
    param?: WhenValues;
    env?: WhenValues;
};
export type PartSpec = {
    required: boolean;
    default: boolean;
    when?: When;
};
/** 애드온 선언 — base 는 플러그인이나 다른 애드온의 이름, version 은 그 판의 조건(versionHolds) */
export type AddonSpec = {
    base: string;
    version: string;
};
/** roots 는 합친 manifest(agentAddons.assemble)에서 part 가 있는 폴더 — 없으면 빌드에 넘긴 폴더 하나다 */
export type Manifest = {
    name: string;
    version: string;
    options: Record<string, OptionSpec>;
    parts: Record<string, PartSpec>;
    env: Record<string, string>;
    addon?: AddonSpec;
    roots?: Record<string, string>;
};
/** 한 층의 설정 값 — 기본 설정(config.json)·프로필·세션이 같은 꼴이다. 없는 키는 아래 층의 값 */
export type Values = {
    parts?: Record<string, boolean>;
    options?: Record<string, boolean | string | number>;
};
export type Resolved = {
    parts: Record<string, boolean>;
    options: Record<string, boolean | string | number>;
};
/** 세션 인자 이름 — SLCODE_PARAM_<이름> env 가 된다 */
export declare const PARAM_NAME: RegExp;
/** manifest 를 읽는다 — 이름·part 구성을 알 수 없으면 던진다 (slcode plugin add 가 거부하는 유일한 경우) */
export declare function parseManifest(text: string): Manifest;
/** 판이 조건에 맞는가 — 판이나 조건을 읽지 못하면 맞지 않는 것으로 본다 */
export declare function versionHolds(version: string, range: string): boolean;
/** when 조건 — part 는 partOn 이 참인가. param·env 는 이름마다 true 는 값이 있고 비어 있지 않음, 문자열은 같음, 목록은 그중 하나. 모두 참이어야 참 */
export declare function whenHolds(w: When, params?: Record<string, string>, env?: Record<string, string | undefined>, partOn?: (part: string) => boolean): boolean;
/** 조건 글 — 목록·export excluded·화면에 보인다 */
export declare function whenText(w: When): string;
export declare function readManifest(dir: string): Manifest;
/** 폴더 안 일반 파일의 상대 경로(/ 구분, 정렬). 링크는 따라간다. .git 은 뺀다 */
export declare function walk(dir: string, rel?: string): string[];
/** 원본에서 설치·빌드에 쓰는 파일 — manifest 와 part 폴더들. 그 밖은 복사하지 않는다 */
export declare function sourceFiles(dir: string, m: Manifest): string[];
/** 원본 내용 해시 — 경로·실행 비트·내용 */
export declare function sourceHash(dir: string, m: Manifest): string;
/** markdown 머리의 --- 블록에서 맨 앞 칸의 키와 값 — 블록 스칼라(| >)와 들여 쓴 이어지는 줄은 값에 잇는다(| 는 줄바꿈, 그 밖은 공백). 중첩 맵은 키만 쓴다 */
export declare function frontmatter(text: string): {
    fields: Record<string, string>;
    body: string;
};
/** .mcp.json 서버 하나의 연결 방식 — Claude 는 type 이 없으면 stdio. Codex 는 stdio·http 만 받는다 */
export declare function mcpTransport(def: unknown): string;
/** part 하나에서 하네스마다 빠지는 것 — 호환 등급과 report.json 이 같은 규칙을 쓴다. 항목은 "<part>/<경로>[: 사유]" */
export declare function partLost(dir: string, part: string): Record<Harness, string[]>;
export declare const COMMANDS_DIR = "commands";
/** part 하나의 명령 파일 — file 은 part 기준 경로. COMMAND 파일이 없는 commands/ 아래 폴더(공용 코드 등)는 명령이 아니다.
 *  errors: 이름이 규칙 밖, COMMAND.ts·COMMAND.js 가 함께 있음 */
export declare function commandFiles(dir: string, part: string): {
    commands: {
        name: string;
        file: string;
    }[];
    errors: string[];
};
/** part 가 있는 폴더 — 합친 manifest 는 part 마다 다르다 */
export declare const partRoot: (dir: string, m: Manifest, part: string) => string;
/** SKILL.md frontmatter 의 aliases — `[b, ut]`, `b`, 블록 목록. frontmatter() 는 목록을 잇기만 하므로 머리 줄을 따로 읽는다. 이름 규칙은 aliasErrors 와 빌드가 본다 */
export declare function parseAliases(text: string): string[];
/** part 하나의 skill 별칭 — skill 은 원본 폴더 이름, raw/claude/skills/ 도 본다 */
export declare function skillAliases(dir: string, part: string): {
    alias: string;
    skill: string;
}[];
/** 같은 플러그인에서 부를 수 있는 skill 이름 — 실제 이름과 별칭 */
export declare function skillNames(dir: string, part: string): string[];
/** 별칭의 정적 검사 — 모든 part(켜지 않은 것도)를 본다. 하나라도 있으면 add 가 거부한다. 같은 폴더의 skill 을 뒤 part 가 덮으며 같은 별칭을 적는 것은 겹침이 아니다. 명령과의 겹침은 commandErrors 가 본다 */
export declare function aliasErrors(dir: string, m: Manifest): string[];
/** 명령의 정적 검사 — 모든 part(켜지 않은 것도)를 본다. 이름 규칙·COMMAND 파일 둘·part 끼리 같은 이름·같은 플러그인 skill 과 같은 이름.
 *  하나라도 있으면 add 가 거부한다(플러그인 적용 실패, 사용자 결정 2026-11-02) */
/** Claude 내장 명령의 이름·별칭 — add 때 미리 거른다(사용자 결정 2026-11-02). Claude Agent SDK 0.3.282 의 supportedCommands 중 builtin 인 것(API 키 계정, 2026-11-02 실측).
 *  계정·기능 플래그나 새 판에서 늘어난 것은 slcode 가 세션을 열 때 SDK 목록으로 다시 본다 — 이 목록은 그 판정을 대신하지 않는다 */
export declare const CLAUDE_BUILTIN_COMMANDS: ReadonlySet<string>;
export declare function commandErrors(dir: string, m: Manifest): string[];
/** 호환 등급 — 모든 part(켜지 않은 것도)를 본다. full 은 어느 하네스에서도 빠지는 것이 없다 */
export declare function compat(dir: string, m: Manifest): {
    grade: 'full' | 'partial';
    lost: Record<Harness, string[]>;
};
/** 기본값(manifest) 위에 층을 차례로 덮는다 — 뒤의 것이 이긴다. 모르는 키·꼴이 틀린 값은 건너뛴다(옛 판의 설정이 남아 있을 수 있다). 필수 part 는 늘 켠다.
 *  part 조건 when 은 보지 않는다 — 사용자 설정 그대로(목록·관리 화면의 스위치) */
export declare function userValues(m: Manifest, layers: (Values | null | undefined)[]): Resolved;
/** 빌드에 쓰는 값 — userValues 다음, when 이 있는 켠 part 는 세션 인자 params·env·다른 part 의 최종 상태로 조건이 참일 때만 남긴다. 사용자가 끈 part 는 켜지 않고,
 *  필수 part 도 조건이 거짓이면 꺼진다(사용자 결정 2026-11-02). params·env 가 없으면(기본 빌드·export 판) 없는 것으로 본다.
 *  값은 빌드 식별자에 들어가지 않는다 — 켜진 part 만 설정 문자열에 남는다. 순환은 parseManifest 가 거절했으므로 on 은 끝난다 */
export declare function resolveValues(m: Manifest, layers: (Values | null | undefined)[], params?: Record<string, string>, env?: Record<string, string | undefined>): Resolved;
/** 정렬한 설정 문자열 — part.x=0|1, opt.y=<JSON> */
export declare function valuesString(r: Resolved): string;
/** 빌드 식별자 — 설정 문자열·원본 해시·하네스·빌드기 판의 해시 */
export declare function buildId(values: string, hash: string, harness: Harness): string;
/** `slcode plugin set` 의 `<키>=<값>` 하나를 그 층의 값으로 — part 는 on|off, 옵션은 꼴대로. 맞지 않으면 던진다 */
export declare function parseAssignment(m: Manifest, s: string): {
    kind: 'parts' | 'options';
    key: string;
    value: boolean | string | number;
};
export {};
