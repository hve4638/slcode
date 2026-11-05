// 에이전트 플러그인의 원본 형식 (ticket slcode-agent-plugin, 설계 ws docs/report/slcode-agent-plugin-survey.md).
// manifest slcode-plugin.json 과 part 폴더를 읽고, 원본 해시·호환 등급·설정 값·빌드 식별자를 만든다. 파일을 쓰지 않는다.
// 형식이 모르는 폴더·파일은 오류가 아니다 — manifest 가 없거나 깨진 경우만 parseManifest 가 던진다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { COMMAND_NAME } from './hookApi.js';

export const MANIFEST = 'slcode-plugin.json';
/** 애드온의 manifest (ticket slcode-plugin-addon) — 파일 이름이 다르므로 옛 사본은 add 를 "no slcode-plugin.json" 으로 거절한다. slcode-plugin.json 에 addon 칸만 더하면 옛 사본이 독립 플러그인으로 설치한다(0.3.0·0.4.0 실측) */
export const ADDON_MANIFEST = 'slcode-addon.json';
/** 빌드기 판 — 빌드 결과가 달라지는 변경이면 올린다. 빌드 식별자에 들어가 옛 빌드를 다시 쓰지 않게 한다 */
export const BUILDER = 7; // 2: slcode 형식 hooks.json·js/ts 훅 묶기 (slcode-agent-plugin-hooks). 3: command 의 ${slcode.vars.harness}, Codex 빌드의 codex-mcp.json·codex-hooks.json (slcode-agent-plugin-export). 4: slcode/api 묶기·하네스별 등록 목록, export 판의 js/ts 훅 (slcode-agent-plugin-script-portable). 5: export 훅 명령은 상태 폴더의 고정 런처 (slcode-plugin-split). 6: commands/ 는 플러그인 폴더에서 빼고 commands.json·묶은 명령 (slcode-agent-plugin-command). 7: skill 별칭 폴더 (slcode-plugin-skill-alias)
/** 호환 등급을 매기는 하네스 — gpt 는 GPT 하네스(장기적으로 Codex 자리, 아직 slcode 가 띄우지 않는다) */
export const HARNESSES = ['claude', 'gpt', 'codex'] as const;
export type Harness = (typeof HARNESSES)[number];

export type OptionType = 'boolean' | 'string' | 'number';
export type OptionSpec = { type: OptionType; default: boolean | string | number; label?: string };
type WhenValues = Record<string, true | string | string[]>;
/** part 를 켜는 조건 (ticket slcode-agent-plugin-part-when, -part-when-part) — part 는 같은 플러그인 part 가 최종적으로 켜졌는가(true 만), param(slcode new --param)·env(세션 에이전트가 받는 env)는
 *  이름마다 true(있고 비어 있지 않음)·"값"(같음)·["값", …](그중 하나). 칸과 이름 모두 참이어야 참 */
export type When = { part?: Record<string, true>; param?: WhenValues; env?: WhenValues };
export type PartSpec = { required: boolean; default: boolean; when?: When };
/** 애드온 선언 — base 는 플러그인이나 다른 애드온의 이름, version 은 그 판의 조건(versionHolds) */
export type AddonSpec = { base: string; version: string };
/** roots 는 합친 manifest(agentAddons.assemble)에서 part 가 있는 폴더 — 없으면 빌드에 넘긴 폴더 하나다 */
export type Manifest = { name: string; version: string; options: Record<string, OptionSpec>; parts: Record<string, PartSpec>; env: Record<string, string>; addon?: AddonSpec; roots?: Record<string, string> };
/** 한 층의 설정 값 — 기본 설정(config.json)·프로필·세션이 같은 꼴이다. 없는 키는 아래 층의 값 */
export type Values = { parts?: Record<string, boolean>; options?: Record<string, boolean | string | number> };
export type Resolved = { parts: Record<string, boolean>; options: Record<string, boolean | string | number> };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 세션 인자 이름 — SLCODE_PARAM_<이름> env 가 된다 */
export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ZERO: Record<OptionType, boolean | string | number> = { boolean: false, string: '', number: 0 };

/** manifest 를 읽는다 — 이름·part 구성을 알 수 없으면 던진다 (slcode plugin add 가 거부하는 유일한 경우) */
export function parseManifest(text: string): Manifest {
  let j: unknown;
  try { j = JSON.parse(text); } catch (e) { throw new Error(`${MANIFEST} is not JSON: ${(e as Error).message}`); }
  if (!isObj(j)) throw new Error(`${MANIFEST} must be an object`);
  if (typeof j.name !== 'string' || !NAME.test(j.name) || j.name.includes('..')) throw new Error(`${MANIFEST}: name must match ${NAME}`);
  if (j.version !== undefined && typeof j.version !== 'string') throw new Error(`${MANIFEST}: version must be a string`);
  for (const k of ['options', 'parts', 'env'] as const) if (j[k] !== undefined && !isObj(j[k])) throw new Error(`${MANIFEST}: ${k} must be an object`);
  const options: Record<string, OptionSpec> = {};
  for (const [k, v] of Object.entries((j.options ?? {}) as Record<string, unknown>)) {
    if (!NAME.test(k) || !isObj(v)) throw new Error(`${MANIFEST}: bad option ${k}`);
    const type = (v.type ?? 'boolean') as OptionType;
    if (!(type in ZERO)) throw new Error(`${MANIFEST}: option ${k} type must be boolean|string|number`);
    if (v.default !== undefined && typeof v.default !== type) throw new Error(`${MANIFEST}: option ${k} default must be a ${type}`);
    options[k] = { type, default: (v.default as OptionSpec['default']) ?? ZERO[type], ...(typeof v.label === 'string' ? { label: v.label } : {}) };
  }
  const parts: Record<string, PartSpec> = {};
  for (const [k, v] of Object.entries((j.parts ?? {}) as Record<string, unknown>)) {
    if (!NAME.test(k) || k.includes('..') || !isObj(v)) throw new Error(`${MANIFEST}: bad part ${k}`);
    if (k in options) throw new Error(`${MANIFEST}: ${k} is both a part and an option`);
    parts[k] = { required: v.required === true, default: v.required === true || v.default !== false, ...(v.when !== undefined ? { when: parseWhen(k, v.when) } : {}) };
  }
  const addon = j.addon === undefined ? undefined : parseAddon(j.addon);
  checkWhenParts(parts, !!addon);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries((j.env ?? {}) as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`${MANIFEST}: env ${k} must be a string`);
    env[k] = v;
  }
  return { name: j.name, version: (j.version as string | undefined) ?? '0.0.0', options, parts, env, ...(addon ? { addon } : {}) };
}

function parseAddon(a: unknown): AddonSpec {
  if (!isObj(a) || typeof a.base !== 'string' || !NAME.test(a.base) || typeof a.version !== 'string') throw new Error(`${MANIFEST}: addon must be {"base": NAME, "version": RANGE}`);
  if (!parseRange(a.version)) throw new Error(`${MANIFEST}: addon version ${a.version} must be space-separated 1.2.3, ^1.2.3, ~1.2.3, >=1.2.3, >1.2.3, <=1.2.3, <1.2.3, or *`);
  return { base: a.base, version: a.version };
}

// ---- 판 조건 (ticket slcode-plugin-addon) — 쓰는 범위만. 의존성이 없는 패키지라 semver 를 넣지 않는다. 프리릴리스는 같은 x.y.z 의 정식 판보다 낮은 것으로만 본다
type Semver = [number, number, number, string];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const semver = (v: string): Semver | null => { const x = SEMVER.exec(v); return x ? [Number(x[1]), Number(x[2]), Number(x[3]), x[4] ?? ''] : null; };
function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a[3] === b[3] ? 0 : !a[3] ? 1 : !b[3] ? -1 : a[3] < b[3] ? -1 : 1;
}
type Check = (v: Semver) => boolean;
/** 조건을 판단 함수로 — 문법이 틀리면 null. ^ 는 왼쪽 첫 0 이 아닌 자리까지, ~ 는 minor 까지 고정 */
function parseRange(range: string): Check | null {
  const words = range.trim().split(/\s+/);
  const checks: Check[] = [];
  for (const w of words) {
    if (w === '*') continue;
    const x = /^(\^|~|>=|>|<=|<|=)?(.+)$/.exec(w);
    const v = x && semver(x[2]);
    if (!x || !v) return null;
    const [ma, mi, pa] = v;
    const upper: Semver | null = x[1] === '^' ? (ma ? [ma + 1, 0, 0, ''] : mi ? [0, mi + 1, 0, ''] : [0, 0, pa + 1, '']) : x[1] === '~' ? [ma, mi + 1, 0, ''] : null;
    const op = x[1] ?? '=';
    checks.push((c) => {
      const d = compareSemver(c, v);
      if (upper) return d >= 0 && compareSemver(c, upper) < 0;
      return op === '=' ? d === 0 : op === '>=' ? d >= 0 : op === '>' ? d > 0 : op === '<=' ? d <= 0 : d < 0;
    });
  }
  return (c) => checks.every((f) => f(c));
}
/** 판이 조건에 맞는가 — 판이나 조건을 읽지 못하면 맞지 않는 것으로 본다 */
export function versionHolds(version: string, range: string): boolean {
  const v = semver(version), r = parseRange(range);
  return !!v && !!r && r(v);
}

/** part 의 when — part·param·env 중 하나 이상을 쓴 꼴이 아니면 던진다 (꼴을 모르면 part 를 켤지 알 수 없다). part 이름이 실제로 있는지는 checkWhenParts 가 본다 */
function parseWhen(part: string, w: unknown): When {
  const bad = (why: string) => new Error(`${MANIFEST}: part ${part} when ${why}`);
  const shape = 'must be {"part": {NAME: true}, "param": {NAME: VALUE}, "env": {NAME: VALUE}} with at least one of them, VALUE is true | "value" | ["value", ...]';
  if (!isObj(w) || !Object.keys(w).length || Object.keys(w).some((k) => k !== 'part' && k !== 'param' && k !== 'env')) throw bad(shape);
  for (const k of Object.keys(w)) if (!isObj(w[k]) || !Object.keys(w[k]).length) throw bad(shape);
  const out: When = {};
  if (w.part) {
    out.part = {};
    for (const [k, v] of Object.entries(w.part)) {
      if (v !== true) throw bad(`part ${k} must be true`);
      out.part[k] = true;
    }
  }
  for (const kind of ['param', 'env'] as const) {
    if (!w[kind]) continue;
    const values: WhenValues = {};
    for (const [k, v] of Object.entries(w[kind] as Record<string, unknown>)) {
      if (!PARAM_NAME.test(k)) throw bad(`${kind} name ${k} must match ${PARAM_NAME}`);
      if (v === true || typeof v === 'string') values[k] = v;
      else if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) values[k] = [...v];
      else throw bad(`${kind} ${k} must be true, a string or a non-empty list of strings`);
    }
    out[kind] = values;
  }
  return out;
}

/** when 의 part 참조를 add 때 거절한다 — 없는 part 이름, 자기 참조, 순환. 순환이 없어야 resolveValues 가 대상 part 부터 판단할 수 있다.
 *  애드온은 베이스 쪽 part 를 볼 수 있어 자기 밖 이름을 여기서 거절하지 않는다 — agentAddons.assemble 이 합칠 때 본다 */
function checkWhenParts(parts: Record<string, PartSpec>, addon = false) {
  const done = new Set<string>();
  const visit = (k: string, trail: string[]) => {
    if (done.has(k)) return;
    for (const t of Object.keys(parts[k].when?.part ?? {})) {
      const bad = (why: string) => new Error(`${MANIFEST}: part ${k} when part ${t} ${why}`);
      if (!Object.hasOwn(parts, t)) { if (addon) continue; throw bad('is not a part of this plugin'); }
      if (t === k) throw bad('refers to itself');
      if (trail.includes(t)) throw bad(`makes a cycle: ${[...trail.slice(trail.indexOf(t)), k, t].join(' -> ')}`);
      visit(t, [...trail, k]);
    }
    done.add(k);
  };
  for (const k of Object.keys(parts)) visit(k, []);
}

const valuesHold = (want: WhenValues, have: Record<string, string | undefined>) => Object.entries(want).every(([k, w]) => {
  const v = Object.hasOwn(have, k) ? have[k] : undefined;
  return w === true ? !!v : typeof w === 'string' ? v === w : v !== undefined && w.includes(v);
});

/** when 조건 — part 는 partOn 이 참인가. param·env 는 이름마다 true 는 값이 있고 비어 있지 않음, 문자열은 같음, 목록은 그중 하나. 모두 참이어야 참 */
export function whenHolds(w: When, params: Record<string, string> = {}, env: Record<string, string | undefined> = {}, partOn: (part: string) => boolean = () => false): boolean {
  return Object.keys(w.part ?? {}).every(partOn) && valuesHold(w.param ?? {}, params) && valuesHold(w.env ?? {}, env);
}

/** 조건 글 — 목록·export excluded·화면에 보인다 */
export function whenText(w: When): string {
  const values = (kind: string, v: WhenValues = {}) => Object.entries(v).map(([k, x]) => `${kind} ${k}${x === true ? '' : `=${typeof x === 'string' ? x : x.join('|')}`}`);
  return [...Object.keys(w.part ?? {}).map((k) => `part ${k}`), ...values('param', w.param), ...values('env', w.env)].join(' ');
}

export function readManifest(dir: string): Manifest {
  const read = (f: string) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
  const plugin = read(MANIFEST), addon = read(ADDON_MANIFEST);
  if (plugin !== null && addon !== null) throw new Error(`both ${MANIFEST} and ${ADDON_MANIFEST} in ${dir} — keep one`);
  if (plugin !== null) {
    const m = parseManifest(plugin);
    if (m.addon) throw new Error(`${MANIFEST}: an addon goes in ${ADDON_MANIFEST}, older slcode-plugin copies would install it as a plugin`);
    return m;
  }
  if (addon === null) throw new Error(`no ${MANIFEST} in ${dir}`);
  let m: Manifest;
  try { m = parseManifest(addon); } catch (e) { throw new Error((e as Error).message.replaceAll(MANIFEST, ADDON_MANIFEST)); }
  if (!m.addon) throw new Error(`${ADDON_MANIFEST}: addon must be {"base": NAME, "version": RANGE}`);
  return m;
}

/** 폴더 안 일반 파일의 상대 경로(/ 구분, 정렬). 링크는 따라간다. .git 은 뺀다 */
export function walk(dir: string, rel = ''): string[] {
  let names: string[];
  try { names = fs.readdirSync(path.join(dir, rel)).sort(); } catch { return []; }
  return names.flatMap((n) => {
    if (n === '.git') return [];
    const r = rel ? `${rel}/${n}` : n;
    let st: fs.Stats;
    try { st = fs.statSync(path.join(dir, r)); } catch { return []; }
    return st.isDirectory() ? walk(dir, r) : st.isFile() ? [r] : [];
  });
}

/** 원본에서 설치·빌드에 쓰는 파일 — manifest 와 part 폴더들. 그 밖은 복사하지 않는다 */
export function sourceFiles(dir: string, m: Manifest): string[] {
  return [m.addon ? ADDON_MANIFEST : MANIFEST, ...Object.keys(m.parts).flatMap((p) => walk(dir, p))];
}

/** 원본 내용 해시 — 경로·실행 비트·내용 */
export function sourceHash(dir: string, m: Manifest): string {
  const h = createHash('sha256');
  for (const r of sourceFiles(dir, m)) {
    const f = path.join(dir, r);
    h.update(`${r}\0${fs.statSync(f).mode & 0o111 ? 'x' : '-'}\0`).update(fs.readFileSync(f)).update('\0');
  }
  return h.digest('hex');
}

/** markdown 머리의 --- 블록에서 맨 앞 칸의 키와 값 — 블록 스칼라(| >)와 들여 쓴 이어지는 줄은 값에 잇는다(| 는 줄바꿈, 그 밖은 공백). 중첩 맵은 키만 쓴다 */
export function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const more: string[] = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) more.push(lines[++i].trim());
    while (more.length && !more[more.length - 1]) more.pop();
    const v = kv[2].trim();
    fields[kv[1]] = /^[|>][+-]?$/.test(v) ? more.join(v[0] === '|' ? '\n' : ' ') : more.length ? [v, ...more].join(' ').trim() : v.replace(/^(['"])(.*)\1$/, '$2');
  }
  return { fields, body: text.slice(m[0].length) };
}

/** 모든 하네스가 받는(빌드가 맞춰 주는) skill 필드 — 그 밖은 Claude 전용 */
const SKILL_COMMON = new Set(['name', 'description', 'when_to_use', 'disable-model-invocation', 'aliases']);
/** GPT 하네스가 받는 훅 이벤트 (설계 "GPT 하네스가 갖춰야 할 것" 2) */
const GPT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd']);
const exists = (p: string) => fs.existsSync(p);
const parseJson = (f: string): unknown => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

/** .mcp.json 서버 하나의 연결 방식 — Claude 는 type 이 없으면 stdio. Codex 는 stdio·http 만 받는다 */
export function mcpTransport(def: unknown): string {
  if (!isObj(def)) return 'not an object';
  const t = typeof def.type === 'string' ? def.type : 'stdio';
  if (t === 'stdio') return typeof def.command === 'string' ? t : 'stdio without command';
  if (t === 'http') return typeof def.url === 'string' ? t : 'http without url';
  return `type ${t}`;
}

/** part 하나에서 하네스마다 빠지는 것 — 호환 등급과 report.json 이 같은 규칙을 쓴다. 항목은 "<part>/<경로>[: 사유]" */
export function partLost(dir: string, part: string): Record<Harness, string[]> {
  const lost: Record<Harness, string[]> = { claude: [], gpt: [], codex: [] };
  const p = path.join(dir, part);
  const add = (hs: Harness[], item: string) => { for (const h of hs) lost[h].push(`${part}/${item}`); };
  for (const base of ['', 'raw/claude/']) {
    const users: Harness[] = base ? ['claude'] : ['claude', 'gpt', 'codex']; // raw/claude 는 Claude 만 받는다
    const hooks = path.join(p, base, 'hooks/hooks.json');
    if (exists(hooks)) {
      const j = parseJson(hooks);
      // 바깥 것은 slcode 형식(항목 목록, agentHooks.ts), raw/claude 는 Claude 형식(이벤트별 객체) — 형식이 맞지 않으면 깨진 파일
      if (!isObj(j) || !(base ? isObj(j.hooks) : Array.isArray(j.hooks))) add(users, `${base}hooks/hooks.json: broken JSON`);
      else if (!base) {
        add(['codex'], 'hooks/hooks.json');
        const other = [...new Set((j.hooks as unknown[]).filter((e) => isObj(e) && e.type === 'command').map((e) => (e as { event: unknown }).event).filter((e) => typeof e === 'string' && !GPT_EVENTS.has(e)))];
        if (other.length) add(['gpt'], `hooks/hooks.json: ${other.join(', ')}`);
      }
    }
    for (const f of ['.mcp.json', ...(base ? ['session.json'] : [])]) if (exists(path.join(p, base, f)) && !isObj(parseJson(path.join(p, base, f)))) add(users, `${base}${f}: broken JSON`);
  }
  const mcp = parseJson(path.join(p, '.mcp.json'));
  if (isObj(mcp)) for (const [name, def] of Object.entries(isObj(mcp.mcpServers) ? mcp.mcpServers : mcp)) { const t = mcpTransport(def); if (t !== 'stdio' && t !== 'http') add(['codex'], `.mcp.json ${name}: ${t}`); }
  for (const c of commandFiles(dir, part).commands) add(['gpt', 'codex'], `commands/${c.name}: slcode command (slcode Claude sessions only)`);
  if (exists(path.join(p, 'raw/claude'))) add(['gpt', 'codex'], 'raw/claude');
  if (exists(path.join(p, 'raw/pi'))) add(['claude', 'codex'], 'raw/pi');
  for (const r of walk(p, 'skills')) {
    const s = /^skills\/([^/]+)\/SKILL\.md$/.exec(r);
    if (!s) continue;
    const only = Object.keys(frontmatter(fs.readFileSync(path.join(p, r), 'utf8')).fields).filter((k) => !SKILL_COMMON.has(k));
    if (only.length) add(['gpt', 'codex'], `skills/${s[1]}: ${only.join(', ')}`);
  }
  return lost;
}

// ---- 명령 (ticket slcode-agent-plugin-command) — part 의 commands/<이름>/COMMAND.ts|js. 이름은 폴더 이름(COMMAND_NAME)
export const COMMANDS_DIR = 'commands';

/** part 하나의 명령 파일 — file 은 part 기준 경로. COMMAND 파일이 없는 commands/ 아래 폴더(공용 코드 등)는 명령이 아니다.
 *  errors: 이름이 규칙 밖, COMMAND.ts·COMMAND.js 가 함께 있음 */
export function commandFiles(dir: string, part: string): { commands: { name: string; file: string }[]; errors: string[] } {
  const found = new Map<string, string[]>();
  for (const r of walk(path.join(dir, part), COMMANDS_DIR)) {
    const m = /^commands\/([^/]+)\/COMMAND\.(ts|js)$/.exec(r);
    if (m) found.set(m[1], [...(found.get(m[1]) ?? []), r]);
  }
  const out: { name: string; file: string }[] = [], errors: string[] = [];
  for (const [name, files] of [...found].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!COMMAND_NAME.test(name)) { errors.push(`${part}/commands/${name}: command name must match ${COMMAND_NAME} (lowercase letters, digits, -)`); continue; }
    if (files.length > 1) { errors.push(`${part}/commands/${name}: both COMMAND.ts and COMMAND.js — keep one`); continue; }
    out.push({ name, file: files[0] });
  }
  return { commands: out, errors };
}

/** part 가 있는 폴더 — 합친 manifest 는 part 마다 다르다 */
export const partRoot = (dir: string, m: Manifest, part: string) => m.roots?.[part] ?? dir;

/** SKILL.md frontmatter 의 aliases — `[b, ut]`, `b`, 블록 목록. frontmatter() 는 목록을 잇기만 하므로 머리 줄을 따로 읽는다. 이름 규칙은 aliasErrors 와 빌드가 본다 */
export function parseAliases(text: string): string[] {
  const head = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[1].split(/\r?\n/) ?? [];
  const i = head.findIndex((l) => /^aliases:/.test(l));
  if (i < 0) return [];
  const unquote = (v: string) => v.trim().replace(/^(['"])(.*)\1$/, '$2');
  const v = head[i].slice('aliases:'.length).trim();
  if (v) return (/^\[.*\]$/.test(v) ? v.slice(1, -1).split(',') : [v]).map(unquote).filter(Boolean);
  const out: string[] = [];
  for (let j = i + 1; j < head.length; j++) {
    const item = /^\s*-\s+(.*)$/.exec(head[j]);
    if (!item) break;
    out.push(unquote(item[1]));
  }
  return out.filter(Boolean);
}

/** part 하나의 skill 별칭 — skill 은 원본 폴더 이름, raw/claude/skills/ 도 본다 */
export function skillAliases(dir: string, part: string): { alias: string; skill: string }[] {
  const out: { alias: string; skill: string }[] = [];
  for (const base of ['skills', 'raw/claude/skills']) for (const r of walk(path.join(dir, part), base)) {
    const s = /^([^/]+)\/SKILL\.md$/.exec(r.slice(base.length + 1));
    if (s) for (const alias of parseAliases(fs.readFileSync(path.join(dir, part, r), 'utf8'))) out.push({ alias, skill: s[1] });
  }
  return out;
}

/** skill 의 실제 이름 — 폴더 이름과 frontmatter name (Claude 는 name 이 있으면 그것을 쓴다) */
function realSkillNames(dir: string, part: string): string[] {
  const out: string[] = [];
  for (const r of walk(path.join(dir, part), 'skills')) {
    const s = /^skills\/([^/]+)\/SKILL\.md$/.exec(r);
    if (!s) continue;
    out.push(s[1].toLowerCase());
    const n = frontmatter(fs.readFileSync(path.join(dir, part, r), 'utf8')).fields.name;
    if (n) out.push(n.toLowerCase());
  }
  for (const r of walk(path.join(dir, part), 'raw/claude/skills')) { const s = /^raw\/claude\/skills\/([^/]+)\/SKILL\.md$/.exec(r); if (s) out.push(s[1].toLowerCase()); }
  return out;
}

/** 같은 플러그인에서 부를 수 있는 skill 이름 — 실제 이름과 별칭 */
export function skillNames(dir: string, part: string): string[] {
  return [...realSkillNames(dir, part), ...skillAliases(dir, part).map((a) => a.alias.toLowerCase())];
}

/** 별칭의 정적 검사 — 모든 part(켜지 않은 것도)를 본다. 하나라도 있으면 add 가 거부한다. 같은 폴더의 skill 을 뒤 part 가 덮으며 같은 별칭을 적는 것은 겹침이 아니다. 명령과의 겹침은 commandErrors 가 본다 */
export function aliasErrors(dir: string, m: Manifest): string[] {
  const errors: string[] = [];
  const parts = Object.keys(m.parts);
  const real = new Map<string, string>();
  for (const part of parts) for (const s of realSkillNames(partRoot(dir, m, part), part)) if (!real.has(s)) real.set(s, part);
  const seen = new Map<string, string>();
  for (const part of parts) for (const { alias, skill } of skillAliases(partRoot(dir, m, part), part)) {
    const where = `${part}/skills/${skill}: alias ${alias}`;
    if (!COMMAND_NAME.test(alias)) { errors.push(`${where} must match ${COMMAND_NAME} (lowercase letters, digits, -)`); continue; }
    if (alias === skill.toLowerCase()) errors.push(`${where} refers to the skill itself`);
    else if (real.has(alias)) errors.push(`${where} has the same name as skill ${alias} (part ${real.get(alias)}) of this plugin`);
    if (CLAUDE_BUILTIN_COMMANDS.has(alias)) errors.push(`${where} has the same name as the Claude built-in command /${alias}`);
    const other = seen.get(alias);
    if (other && other !== skill) errors.push(`${where} is also an alias of skill ${other}`);
    else seen.set(alias, skill);
  }
  return errors;
}

/** 명령의 정적 검사 — 모든 part(켜지 않은 것도)를 본다. 이름 규칙·COMMAND 파일 둘·part 끼리 같은 이름·같은 플러그인 skill 과 같은 이름.
 *  하나라도 있으면 add 가 거부한다(플러그인 적용 실패, 사용자 결정 2026-11-02) */
/** Claude 내장 명령의 이름·별칭 — add 때 미리 거른다(사용자 결정 2026-11-02). Claude Agent SDK 0.3.282 의 supportedCommands 중 builtin 인 것(API 키 계정, 2026-11-02 실측).
 *  계정·기능 플래그나 새 판에서 늘어난 것은 slcode 가 세션을 열 때 SDK 목록으로 다시 본다 — 이 목록은 그 판정을 대신하지 않는다 */
export const CLAUDE_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  'deep-research', 'design', 'design-sync', 'dataviz', 'update-config', 'verify', 'debug', 'code-review', 'review', 'simplify', 'batch',
  'fewer-permission-prompts', 'doctor', 'checkup', 'loop', 'proactive', 'claude-api', 'workflow-authoring', 'run', 'run-skill-generator',
  'advisor', 'agents', 'auto-mode-setup', 'autocompact', 'clear', 'reset', 'new', 'color', 'compact', 'config', 'settings', 'output-style',
  'context', 'effort', 'fast', 'focus', 'heapdump', 'init', 'mcp', 'import', 'model', 'workflow-launch-exec', 'reload-plugins',
  'reload-skills', 'rename', 'name', 'security-review', 'usage', 'cost', 'stats', 'insights', 'recap', 'skill-doctor', 'goal',
  'design-consent', 'design-revoke', 'list-agents', 'peers', 'team-onboarding',
]);

export function commandErrors(dir: string, m: Manifest): string[] {
  const errors: string[] = [];
  const seen = new Map<string, string>();
  const skills = new Map<string, string>();
  for (const part of Object.keys(m.parts)) for (const s of skillNames(partRoot(dir, m, part), part)) if (!skills.has(s)) skills.set(s, part);
  for (const part of Object.keys(m.parts)) {
    const c = commandFiles(partRoot(dir, m, part), part);
    errors.push(...c.errors);
    for (const { name } of c.commands) {
      if (seen.has(name)) errors.push(`${part}/commands/${name}: command ${name} is also in part ${seen.get(name)}`);
      else seen.set(name, part);
      if (skills.has(name)) errors.push(`${part}/commands/${name}: command ${name} has the same name as skill ${name} (part ${skills.get(name)}) of this plugin`);
      if (CLAUDE_BUILTIN_COMMANDS.has(name)) errors.push(`${part}/commands/${name}: command ${name} has the same name as the Claude built-in command /${name}`);
    }
  }
  return errors;
}

/** 호환 등급 — 모든 part(켜지 않은 것도)를 본다. full 은 어느 하네스에서도 빠지는 것이 없다 */
export function compat(dir: string, m: Manifest): { grade: 'full' | 'partial'; lost: Record<Harness, string[]> } {
  const lost: Record<Harness, string[]> = { claude: [], gpt: [], codex: [] };
  for (const part of Object.keys(m.parts)) { const l = partLost(partRoot(dir, m, part), part); for (const h of HARNESSES) lost[h].push(...l[h]); }
  return { grade: HARNESSES.some((h) => lost[h].length) ? 'partial' : 'full', lost };
}

/** 기본값(manifest) 위에 층을 차례로 덮는다 — 뒤의 것이 이긴다. 모르는 키·꼴이 틀린 값은 건너뛴다(옛 판의 설정이 남아 있을 수 있다). 필수 part 는 늘 켠다.
 *  part 조건 when 은 보지 않는다 — 사용자 설정 그대로(목록·관리 화면의 스위치) */
export function userValues(m: Manifest, layers: (Values | null | undefined)[]): Resolved {
  const parts = Object.fromEntries(Object.entries(m.parts).map(([k, p]) => [k, p.default]));
  const options = Object.fromEntries(Object.entries(m.options).map(([k, o]) => [k, o.default]));
  for (const l of layers) {
    for (const [k, v] of Object.entries(l?.parts ?? {})) if (k in m.parts && typeof v === 'boolean' && !m.parts[k].required) parts[k] = v;
    for (const [k, v] of Object.entries(l?.options ?? {})) if (k in m.options && typeof v === m.options[k].type) options[k] = v;
  }
  return { parts, options };
}

/** 빌드에 쓰는 값 — userValues 다음, when 이 있는 켠 part 는 세션 인자 params·env·다른 part 의 최종 상태로 조건이 참일 때만 남긴다. 사용자가 끈 part 는 켜지 않고,
 *  필수 part 도 조건이 거짓이면 꺼진다(사용자 결정 2026-11-02). params·env 가 없으면(기본 빌드·export 판) 없는 것으로 본다.
 *  값은 빌드 식별자에 들어가지 않는다 — 켜진 part 만 설정 문자열에 남는다. 순환은 parseManifest 가 거절했으므로 on 은 끝난다 */
export function resolveValues(m: Manifest, layers: (Values | null | undefined)[], params: Record<string, string> = {}, env: Record<string, string | undefined> = {}): Resolved {
  const r = userValues(m, layers);
  const decided = new Set<string>();
  const on = (k: string): boolean => {
    if (!decided.has(k)) {
      decided.add(k);
      const w = m.parts[k].when;
      if (w && r.parts[k]) r.parts[k] = whenHolds(w, params, env, on);
    }
    return r.parts[k];
  };
  Object.keys(m.parts).forEach(on);
  return r;
}

/** 정렬한 설정 문자열 — part.x=0|1, opt.y=<JSON> */
export function valuesString(r: Resolved): string {
  return [...Object.entries(r.parts).map(([k, v]) => `part.${k}=${v ? 1 : 0}`), ...Object.entries(r.options).map(([k, v]) => `opt.${k}=${JSON.stringify(v)}`)].sort().join(',');
}

/** 빌드 식별자 — 설정 문자열·원본 해시·하네스·빌드기 판의 해시 */
export function buildId(values: string, hash: string, harness: Harness): string {
  return createHash('sha256').update(`${values}\n${hash}\n${harness}\n${BUILDER}`).digest('hex').slice(0, 16);
}

/** `slcode plugin set` 의 `<키>=<값>` 하나를 그 층의 값으로 — part 는 on|off, 옵션은 꼴대로. 맞지 않으면 던진다 */
export function parseAssignment(m: Manifest, s: string): { kind: 'parts' | 'options'; key: string; value: boolean | string | number } {
  const i = s.indexOf('=');
  if (i <= 0) throw new Error(`expected <part>=on|off or <option>=<value>: ${s}`);
  const key = s.slice(0, i), raw = s.slice(i + 1);
  if (key in m.parts) {
    if (raw !== 'on' && raw !== 'off') throw new Error(`part ${key} takes on|off`);
    if (raw === 'off' && m.parts[key].required) throw new Error(`part ${key} is required and cannot be turned off`);
    return { kind: 'parts', key, value: raw === 'on' };
  }
  const o = m.options[key];
  if (!o) throw new Error(`${m.name} has no part or option named ${key} (parts: ${Object.keys(m.parts).join(', ') || '-'}; options: ${Object.keys(m.options).join(', ') || '-'})`);
  if (o.type === 'boolean') {
    if (!['true', 'false', 'on', 'off'].includes(raw)) throw new Error(`option ${key} takes true|false`);
    return { kind: 'options', key, value: raw === 'true' || raw === 'on' };
  }
  if (o.type === 'number') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) throw new Error(`option ${key} takes a number`);
    return { kind: 'options', key, value: n };
  }
  return { kind: 'options', key, value: raw };
}
