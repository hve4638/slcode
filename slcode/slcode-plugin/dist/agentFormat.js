// 에이전트 플러그인의 원본 형식 (ticket slcode-agent-plugin, 설계 ws docs/report/slcode-agent-plugin-survey.md).
// manifest slcode-plugin.json 과 part 폴더를 읽고, 원본 해시·호환 등급·설정 값·빌드 식별자를 만든다. 파일을 쓰지 않는다.
// 형식이 모르는 폴더·파일은 오류가 아니다 — manifest 가 없거나 깨진 경우만 parseManifest 가 던진다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const MANIFEST = 'slcode-plugin.json';
/** 빌드기 판 — 빌드 결과가 달라지는 변경이면 올린다. 빌드 식별자에 들어가 옛 빌드를 다시 쓰지 않게 한다 */
export const BUILDER = 5; // 2: slcode 형식 hooks.json·js/ts 훅 묶기 (slcode-agent-plugin-hooks). 3: command 의 ${slcode.vars.harness}, Codex 빌드의 codex-mcp.json·codex-hooks.json (slcode-agent-plugin-export). 4: slcode/api 묶기·하네스별 등록 목록, export 판의 js/ts 훅 (slcode-agent-plugin-script-portable). 5: export 훅 명령은 상태 폴더의 고정 런처 (slcode-plugin-split)
/** 호환 등급을 매기는 하네스 — gpt 는 GPT 하네스(장기적으로 Codex 자리, 아직 slcode 가 띄우지 않는다) */
export const HARNESSES = ['claude', 'gpt', 'codex'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 세션 인자 이름 — SLCODE_PARAM_<이름> env 가 된다 */
export const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const ZERO = { boolean: false, string: '', number: 0 };
/** manifest 를 읽는다 — 이름·part 구성을 알 수 없으면 던진다 (slcode plugin add 가 거부하는 유일한 경우) */
export function parseManifest(text) {
    let j;
    try {
        j = JSON.parse(text);
    }
    catch (e) {
        throw new Error(`${MANIFEST} is not JSON: ${e.message}`);
    }
    if (!isObj(j))
        throw new Error(`${MANIFEST} must be an object`);
    if (typeof j.name !== 'string' || !NAME.test(j.name) || j.name.includes('..'))
        throw new Error(`${MANIFEST}: name must match ${NAME}`);
    if (j.version !== undefined && typeof j.version !== 'string')
        throw new Error(`${MANIFEST}: version must be a string`);
    for (const k of ['options', 'parts', 'env'])
        if (j[k] !== undefined && !isObj(j[k]))
            throw new Error(`${MANIFEST}: ${k} must be an object`);
    const options = {};
    for (const [k, v] of Object.entries((j.options ?? {}))) {
        if (!NAME.test(k) || !isObj(v))
            throw new Error(`${MANIFEST}: bad option ${k}`);
        const type = (v.type ?? 'boolean');
        if (!(type in ZERO))
            throw new Error(`${MANIFEST}: option ${k} type must be boolean|string|number`);
        if (v.default !== undefined && typeof v.default !== type)
            throw new Error(`${MANIFEST}: option ${k} default must be a ${type}`);
        options[k] = { type, default: v.default ?? ZERO[type], ...(typeof v.label === 'string' ? { label: v.label } : {}) };
    }
    const parts = {};
    for (const [k, v] of Object.entries((j.parts ?? {}))) {
        if (!NAME.test(k) || k.includes('..') || !isObj(v))
            throw new Error(`${MANIFEST}: bad part ${k}`);
        if (k in options)
            throw new Error(`${MANIFEST}: ${k} is both a part and an option`);
        parts[k] = { required: v.required === true, default: v.required === true || v.default !== false, ...(v.when !== undefined ? { when: parseWhen(k, v.when) } : {}) };
    }
    const env = {};
    for (const [k, v] of Object.entries((j.env ?? {}))) {
        if (typeof v !== 'string')
            throw new Error(`${MANIFEST}: env ${k} must be a string`);
        env[k] = v;
    }
    return { name: j.name, version: j.version ?? '0.0.0', options, parts, env };
}
/** part 의 when — {param: {NAME: true | "값" | ["값", …]}} 꼴이 아니면 던진다 (꼴을 모르면 part 를 켤지 알 수 없다) */
function parseWhen(part, w) {
    const bad = (why) => new Error(`${MANIFEST}: part ${part} when ${why}`);
    if (!isObj(w) || Object.keys(w).some((k) => k !== 'param') || !isObj(w.param) || !Object.keys(w.param).length)
        throw bad('must be {"param": {NAME: true | "value" | ["value", ...]}}');
    const param = {};
    for (const [k, v] of Object.entries(w.param)) {
        if (!PARAM_NAME.test(k))
            throw bad(`param name ${k} must match ${PARAM_NAME}`);
        if (v === true || typeof v === 'string')
            param[k] = v;
        else if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string'))
            param[k] = [...v];
        else
            throw bad(`param ${k} must be true, a string or a non-empty list of strings`);
    }
    return { param };
}
/** when 조건 — 이름마다 true 는 값이 있고 비어 있지 않음, 문자열은 같음, 목록은 그중 하나. 모두 참이어야 참 */
export function whenHolds(w, params) {
    return Object.entries(w.param).every(([k, want]) => {
        const v = Object.hasOwn(params, k) ? params[k] : undefined;
        return want === true ? !!v : typeof want === 'string' ? v === want : v !== undefined && want.includes(v);
    });
}
/** 조건 글 — 목록·export excluded·화면에 보인다 */
export function whenText(w) {
    return Object.entries(w.param).map(([k, v]) => `param ${k}${v === true ? '' : `=${typeof v === 'string' ? v : v.join('|')}`}`).join(' ');
}
export function readManifest(dir) {
    let text;
    try {
        text = fs.readFileSync(path.join(dir, MANIFEST), 'utf8');
    }
    catch {
        throw new Error(`no ${MANIFEST} in ${dir}`);
    }
    return parseManifest(text);
}
/** 폴더 안 일반 파일의 상대 경로(/ 구분, 정렬). 링크는 따라간다. .git 은 뺀다 */
export function walk(dir, rel = '') {
    let names;
    try {
        names = fs.readdirSync(path.join(dir, rel)).sort();
    }
    catch {
        return [];
    }
    return names.flatMap((n) => {
        if (n === '.git')
            return [];
        const r = rel ? `${rel}/${n}` : n;
        let st;
        try {
            st = fs.statSync(path.join(dir, r));
        }
        catch {
            return [];
        }
        return st.isDirectory() ? walk(dir, r) : st.isFile() ? [r] : [];
    });
}
/** 원본에서 설치·빌드에 쓰는 파일 — manifest 와 part 폴더들. 그 밖은 복사하지 않는다 */
export function sourceFiles(dir, m) {
    return [MANIFEST, ...Object.keys(m.parts).flatMap((p) => walk(dir, p))];
}
/** 원본 내용 해시 — 경로·실행 비트·내용 */
export function sourceHash(dir, m) {
    const h = createHash('sha256');
    for (const r of sourceFiles(dir, m)) {
        const f = path.join(dir, r);
        h.update(`${r}\0${fs.statSync(f).mode & 0o111 ? 'x' : '-'}\0`).update(fs.readFileSync(f)).update('\0');
    }
    return h.digest('hex');
}
/** markdown 머리의 --- 블록에서 맨 앞 칸의 키와 값 — 블록 스칼라(| >)와 들여 쓴 이어지는 줄은 값에 잇는다(| 는 줄바꿈, 그 밖은 공백). 중첩 맵은 키만 쓴다 */
export function frontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    if (!m)
        return { fields: {}, body: text };
    const fields = {};
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
        if (!kv)
            continue;
        const more = [];
        while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim()))
            more.push(lines[++i].trim());
        while (more.length && !more[more.length - 1])
            more.pop();
        const v = kv[2].trim();
        fields[kv[1]] = /^[|>][+-]?$/.test(v) ? more.join(v[0] === '|' ? '\n' : ' ') : more.length ? [v, ...more].join(' ').trim() : v.replace(/^(['"])(.*)\1$/, '$2');
    }
    return { fields, body: text.slice(m[0].length) };
}
/** 모든 하네스가 받는(빌드가 맞춰 주는) skill 필드 — 그 밖은 Claude 전용 */
const SKILL_COMMON = new Set(['name', 'description', 'when_to_use', 'disable-model-invocation']);
/** GPT 하네스가 받는 훅 이벤트 (설계 "GPT 하네스가 갖춰야 할 것" 2) */
const GPT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd']);
const exists = (p) => fs.existsSync(p);
const parseJson = (f) => { try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
}
catch {
    return undefined;
} };
/** .mcp.json 서버 하나의 연결 방식 — Claude 는 type 이 없으면 stdio. Codex 는 stdio·http 만 받는다 */
export function mcpTransport(def) {
    if (!isObj(def))
        return 'not an object';
    const t = typeof def.type === 'string' ? def.type : 'stdio';
    if (t === 'stdio')
        return typeof def.command === 'string' ? t : 'stdio without command';
    if (t === 'http')
        return typeof def.url === 'string' ? t : 'http without url';
    return `type ${t}`;
}
/** part 하나에서 하네스마다 빠지는 것 — 호환 등급과 report.json 이 같은 규칙을 쓴다. 항목은 "<part>/<경로>[: 사유]" */
export function partLost(dir, part) {
    const lost = { claude: [], gpt: [], codex: [] };
    const p = path.join(dir, part);
    const add = (hs, item) => { for (const h of hs)
        lost[h].push(`${part}/${item}`); };
    for (const base of ['', 'raw/claude/']) {
        const users = base ? ['claude'] : ['claude', 'gpt', 'codex']; // raw/claude 는 Claude 만 받는다
        const hooks = path.join(p, base, 'hooks/hooks.json');
        if (exists(hooks)) {
            const j = parseJson(hooks);
            // 바깥 것은 slcode 형식(항목 목록, agentHooks.ts), raw/claude 는 Claude 형식(이벤트별 객체) — 형식이 맞지 않으면 깨진 파일
            if (!isObj(j) || !(base ? isObj(j.hooks) : Array.isArray(j.hooks)))
                add(users, `${base}hooks/hooks.json: broken JSON`);
            else if (!base) {
                add(['codex'], 'hooks/hooks.json');
                const other = [...new Set(j.hooks.filter((e) => isObj(e) && e.type === 'command').map((e) => e.event).filter((e) => typeof e === 'string' && !GPT_EVENTS.has(e)))];
                if (other.length)
                    add(['gpt'], `hooks/hooks.json: ${other.join(', ')}`);
            }
        }
        for (const f of ['.mcp.json', ...(base ? ['session.json'] : [])])
            if (exists(path.join(p, base, f)) && !isObj(parseJson(path.join(p, base, f))))
                add(users, `${base}${f}: broken JSON`);
    }
    const mcp = parseJson(path.join(p, '.mcp.json'));
    if (isObj(mcp))
        for (const [name, def] of Object.entries(isObj(mcp.mcpServers) ? mcp.mcpServers : mcp)) {
            const t = mcpTransport(def);
            if (t !== 'stdio' && t !== 'http')
                add(['codex'], `.mcp.json ${name}: ${t}`);
        }
    if (exists(path.join(p, 'raw/claude')))
        add(['gpt', 'codex'], 'raw/claude');
    if (exists(path.join(p, 'raw/pi')))
        add(['claude', 'codex'], 'raw/pi');
    for (const r of walk(p, 'skills')) {
        const s = /^skills\/([^/]+)\/SKILL\.md$/.exec(r);
        if (!s)
            continue;
        const only = Object.keys(frontmatter(fs.readFileSync(path.join(p, r), 'utf8')).fields).filter((k) => !SKILL_COMMON.has(k));
        if (only.length)
            add(['gpt', 'codex'], `skills/${s[1]}: ${only.join(', ')}`);
    }
    return lost;
}
/** 호환 등급 — 모든 part(켜지 않은 것도)를 본다. full 은 어느 하네스에서도 빠지는 것이 없다 */
export function compat(dir, m) {
    const lost = { claude: [], gpt: [], codex: [] };
    for (const part of Object.keys(m.parts)) {
        const l = partLost(dir, part);
        for (const h of HARNESSES)
            lost[h].push(...l[h]);
    }
    return { grade: HARNESSES.some((h) => lost[h].length) ? 'partial' : 'full', lost };
}
/** 기본값(manifest) 위에 층을 차례로 덮는다 — 뒤의 것이 이긴다. 모르는 키·꼴이 틀린 값은 건너뛴다(옛 판의 설정이 남아 있을 수 있다). 필수 part 는 늘 켠다.
 *  part 조건 when 은 보지 않는다 — 사용자 설정 그대로(목록·관리 화면의 스위치) */
export function userValues(m, layers) {
    const parts = Object.fromEntries(Object.entries(m.parts).map(([k, p]) => [k, p.default]));
    const options = Object.fromEntries(Object.entries(m.options).map(([k, o]) => [k, o.default]));
    for (const l of layers) {
        for (const [k, v] of Object.entries(l?.parts ?? {}))
            if (k in m.parts && typeof v === 'boolean' && !m.parts[k].required)
                parts[k] = v;
        for (const [k, v] of Object.entries(l?.options ?? {}))
            if (k in m.options && typeof v === m.options[k].type)
                options[k] = v;
    }
    return { parts, options };
}
/** 빌드에 쓰는 값 — userValues 다음, when 이 있는 켠 part 는 세션 인자 params 로 조건이 참일 때만 남긴다. 사용자가 끈 part 는 켜지 않고,
 *  필수 part 도 조건이 거짓이면 꺼진다(사용자 결정 2026-11-02). params 가 없으면(기본 빌드·export 판) 인자가 없는 것으로 본다.
 *  인자 값은 빌드 식별자에 들어가지 않는다 — 켜진 part 만 설정 문자열에 남는다 */
export function resolveValues(m, layers, params = {}) {
    const r = userValues(m, layers);
    for (const [k, p] of Object.entries(m.parts))
        if (p.when && r.parts[k])
            r.parts[k] = whenHolds(p.when, params);
    return r;
}
/** 정렬한 설정 문자열 — part.x=0|1, opt.y=<JSON> */
export function valuesString(r) {
    return [...Object.entries(r.parts).map(([k, v]) => `part.${k}=${v ? 1 : 0}`), ...Object.entries(r.options).map(([k, v]) => `opt.${k}=${JSON.stringify(v)}`)].sort().join(',');
}
/** 빌드 식별자 — 설정 문자열·원본 해시·하네스·빌드기 판의 해시 */
export function buildId(values, hash, harness) {
    return createHash('sha256').update(`${values}\n${hash}\n${harness}\n${BUILDER}`).digest('hex').slice(0, 16);
}
/** `slcode plugin set` 의 `<키>=<값>` 하나를 그 층의 값으로 — part 는 on|off, 옵션은 꼴대로. 맞지 않으면 던진다 */
export function parseAssignment(m, s) {
    const i = s.indexOf('=');
    if (i <= 0)
        throw new Error(`expected <part>=on|off or <option>=<value>: ${s}`);
    const key = s.slice(0, i), raw = s.slice(i + 1);
    if (key in m.parts) {
        if (raw !== 'on' && raw !== 'off')
            throw new Error(`part ${key} takes on|off`);
        if (raw === 'off' && m.parts[key].required)
            throw new Error(`part ${key} is required and cannot be turned off`);
        return { kind: 'parts', key, value: raw === 'on' };
    }
    const o = m.options[key];
    if (!o)
        throw new Error(`${m.name} has no part or option named ${key} (parts: ${Object.keys(m.parts).join(', ') || '-'}; options: ${Object.keys(m.options).join(', ') || '-'})`);
    if (o.type === 'boolean') {
        if (!['true', 'false', 'on', 'off'].includes(raw))
            throw new Error(`option ${key} takes true|false`);
        return { kind: 'options', key, value: raw === 'true' || raw === 'on' };
    }
    if (o.type === 'number') {
        const n = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(n))
            throw new Error(`option ${key} takes a number`);
        return { kind: 'options', key, value: n };
    }
    return { kind: 'options', key, value: raw };
}
