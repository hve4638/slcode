// 에이전트 플러그인의 상태 폴더와 명령 (ticket slcode-agent-plugin, 설계 ws docs/report/slcode-agent-plugin-survey.md).
// $SLCODE_DIR/agent-plugins/{installed/<이름>, config.json, build/<식별자>, export, data}. config.json 은 slcode 내부 파일이다 — 임시 파일 + rename,
// 쓰는 명령은 config.lock 을 쥔다. 설치는 원하는 상태를 적는 것이라 같은 원본을 몇 번 add 해도 결과가 같다.
// 세션에 싣기: 세션 폴더의 agent-plugins/<이름> 링크가 그 세션이 쓰는 빌드를 가리킨다. SDK 에는 링크 경로를 넘기므로, 다시 싣기는 링크를 새 빌드로
// 바꾸고 SDK reloadPlugins() 를 부르는 것이다. 정리(gc)는 config 의 마지막 빌드와 세션·export 링크가 가리키지 않는 빌드를 지운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildId, compat, HARNESSES, MANIFEST, parseAssignment, readManifest, resolveValues, sourceFiles, sourceHash, valuesString, walk, type Harness, type Manifest, type Values } from './agentFormat.js';
import { BUILD_FILES, ensureBuild, type Report } from './agentBuild.js';
import { acquireLock, releaseLock } from './lock.js';
import { corePaths } from './paths.js';

export const AGENT_DIR = 'agent-plugins';
/** 세션 폴더 안의 링크 폴더 — agent-plugins/<이름> → build/<식별자>/claude/<이름> (Codex 는 build/<식별자>/codex, 다시 실은 skill 의 빌드는 <이름>@skills) */
export const SESSION_LINKS = 'agent-plugins';
/** 아무도 가리키지 않아도 이만큼은 남긴다 — 세션이 막 빌드하고 아직 링크를 걸지 않은 틈 */
const GC_GRACE_MS = 10 * 60_000;

export type AgentPaths = { dir: string; installed: string; config: string; lock: string; build: string; export: string; data: string; sessionsDir: string };
export function agentPaths(stateDir?: string): AgentPaths {
  const P = corePaths(stateDir);
  const dir = path.join(P.dir, AGENT_DIR);
  return { dir, installed: path.join(dir, 'installed'), config: path.join(dir, 'config.json'), lock: path.join(dir, 'config.lock'), build: path.join(dir, 'build'), export: path.join(dir, 'export'), data: path.join(dir, 'data'), sessionsDir: P.sessionsDir };
}

export type PluginEntry = {
  version: string;
  /** 설치한 원본의 내용 해시 — 같으면 add 가 아무것도 하지 않는다 */
  hash: string;
  /** add 에 준 폴더 (기록만) */
  source: string;
  installedAt: number;
  grade: 'full' | 'partial';
  /** 하네스마다 빠지는 것 — 모든 part 기준 */
  lost: Record<Harness, string[]>;
  /** 플러그인 기본 설정 (slcode plugin set) — manifest 기본값 위, 프로필·세션 아래 */
  values: Values;
  /** 하네스별 마지막 빌드 — 기본 설정으로 만든 것 */
  builds: Partial<Record<Harness, string>>;
};
/** plugins 의 키 순서가 설치 순서 — 지시문을 이 순서로 잇는다 */
export type AgentConfig = { plugins: Record<string, PluginEntry> };

export function readConfig(ap: AgentPaths): AgentConfig {
  try {
    const j = JSON.parse(fs.readFileSync(ap.config, 'utf8'));
    if (j && typeof j.plugins === 'object' && !Array.isArray(j.plugins)) return j;
  } catch {}
  return { plugins: {} };
}
function writeConfig(ap: AgentPaths, c: AgentConfig) {
  fs.mkdirSync(ap.dir, { recursive: true, mode: 0o700 });
  const tmp = `${ap.config}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, ap.config);
}
async function locked<T>(ap: AgentPaths, fn: () => T): Promise<T> {
  fs.mkdirSync(ap.dir, { recursive: true, mode: 0o700 });
  const l = await acquireLock(ap.lock, process.pid, 10_000);
  if (!l.ok) throw new Error(`agent plugin config is locked by pid ${l.holder}`);
  try { return fn(); } finally { releaseLock(ap.lock); }
}

/** 옛 판의 설정에서 이 판에 맞는 값만 */
function prune(v: Values | undefined, m: Manifest): Values {
  const parts = Object.fromEntries(Object.entries(v?.parts ?? {}).filter(([k, x]) => k in m.parts && !m.parts[k].required && typeof x === 'boolean'));
  const options = Object.fromEntries(Object.entries(v?.options ?? {}).filter(([k, x]) => k in m.options && typeof x === m.options[k].type));
  return { parts, options };
}

/** 폴더를 통째로 바꾼다 — 새 것을 옆에 만든 뒤 옛 것을 치우고 옮긴다 */
function replaceDir(target: string, fill: (tmp: string) => void) {
  const tmp = `${target}.tmp-${randomUUID().slice(0, 8)}`, old = `${target}.old-${randomUUID().slice(0, 8)}`;
  fs.mkdirSync(tmp, { recursive: true });
  try { fill(tmp); } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  if (fs.existsSync(target)) fs.renameSync(target, old);
  fs.renameSync(tmp, target);
  fs.rmSync(old, { recursive: true, force: true });
}

/** 세션을 띄우는 하네스 — slcode 는 Claude·Codex 를 띄운다 */
export type SessionHarness = 'claude' | 'codex';
const SESSION_HARNESSES: SessionHarness[] = ['claude', 'codex'];

/** 기본 설정으로 하네스마다 빌드해 e.builds 에 적는다 — 결과는 Claude 빌드 */
function defaultBuild(ap: AgentPaths, name: string, e: PluginEntry) {
  const inst = path.join(ap.installed, name);
  const m = readManifest(inst);
  const r = resolveValues(m, [e.values]);
  for (const h of SESSION_HARNESSES) e.builds[h] = ensureBuild(ap.build, inst, m, r, e.hash, h).id;
  return ensureBuild(ap.build, inst, m, r, e.hash, 'claude');
}

export type AddResult = { name: string; version: string; changed: boolean; grade: 'full' | 'partial'; lost: Record<Harness, string[]>; build: string | null };

/** 원본을 installed/<이름>/ 에 복사한다. 내용 해시가 같으면 아무것도 하지 않는다. 새 판이면 기본 설정(맞는 값만 남긴다)으로 다시 빌드한다.
 *  manifest 가 없거나 깨졌으면 던진다 — 설치를 거부하는 유일한 경우 */
export async function addPlugin(src: string, stateDir?: string): Promise<AddResult> {
  const abs = path.resolve(src);
  const m = readManifest(abs);
  const hash = sourceHash(abs, m);
  const ap = agentPaths(stateDir);
  const r = await locked(ap, () => {
    const c = readConfig(ap);
    const prev = c.plugins[m.name];
    const inst = path.join(ap.installed, m.name);
    if (prev && prev.hash === hash && fs.existsSync(path.join(inst, MANIFEST))) return { name: m.name, version: prev.version, changed: false, grade: prev.grade, lost: prev.lost, build: prev.builds.claude ?? null };
    fs.mkdirSync(ap.installed, { recursive: true });
    replaceDir(inst, (tmp) => {
      for (const rel of sourceFiles(abs, m)) {
        const to = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(abs, rel), to);
        fs.chmodSync(to, fs.statSync(path.join(abs, rel)).mode & 0o777);
      }
    });
    const { grade, lost } = compat(inst, m);
    const e: PluginEntry = { version: m.version, hash, source: abs, installedAt: Date.now(), grade, lost, values: prune(prev?.values, m), builds: {} };
    defaultBuild(ap, m.name, e);
    c.plugins[m.name] = e;
    writeConfig(ap, c);
    return { name: m.name, version: m.version, changed: true, grade, lost, build: e.builds.claude ?? null };
  });
  gcBuilds(stateDir);
  return r;
}

/** 원본·설정 항목을 지운다. 없으면 성공 (removed false). export 해제는 slcode-agent-plugin-export 가 여기에 붙인다 */
export async function removePlugin(name: string, stateDir?: string): Promise<{ name: string; removed: boolean }> {
  const ap = agentPaths(stateDir);
  const removed = await locked(ap, () => {
    const c = readConfig(ap);
    const inst = path.join(ap.installed, name);
    const had = !!c.plugins[name] || fs.existsSync(inst);
    if (c.plugins[name]) { delete c.plugins[name]; writeConfig(ap, c); }
    fs.rmSync(inst, { recursive: true, force: true });
    return had;
  });
  gcBuilds(stateDir, GC_GRACE_MS, name); // 지운 플러그인의 빌드는 유예 없이 — 새 세션이 더는 그것을 빌드하지 않는다
  return { name, removed };
}

/** 플러그인 기본 설정에서 part 를 켜고 끄거나 옵션 값을 바꾼다 — `<part>=on|off`, `<옵션>=<값>` 여럿. 하나라도 틀리면 아무것도 바꾸지 않는다 */
export async function setPlugin(name: string, assignments: string[], stateDir?: string): Promise<{ name: string; values: string; build: string }> {
  const ap = agentPaths(stateDir);
  const r = await locked(ap, () => {
    const c = readConfig(ap);
    const e = c.plugins[name];
    if (!e) throw new Error(`no agent plugin ${name} (slcode plugin list)`);
    const m = readManifest(path.join(ap.installed, name));
    const values: Values = { parts: { ...e.values.parts }, options: { ...e.values.options } };
    for (const a of assignments) { const { kind, key, value } = parseAssignment(m, a); (values[kind] as Record<string, unknown>)[key] = value; }
    e.values = prune(values, m);
    const b = defaultBuild(ap, name, e);
    writeConfig(ap, c);
    return { name, values: b.report.values, build: b.id };
  });
  gcBuilds(stateDir);
  return r;
}

export type PluginRow = {
  name: string; version: string; grade: 'full' | 'partial'; lost: Record<Harness, string[]>; source: string; installedAt: number;
  parts: { name: string; on: boolean; required: boolean; default: boolean }[];
  options: { name: string; type: string; value: unknown; default: unknown; label: string | null }[];
  /** 하네스별 마지막 빌드의 report.json — 빌드가 없으면 null */
  reports: Partial<Record<Harness, Report | null>>;
};

/** 설치 목록 — 기본 설정 기준의 part·옵션 값과 마지막 빌드 보고 */
export function listPlugins(stateDir?: string): PluginRow[] {
  const ap = agentPaths(stateDir);
  return Object.entries(readConfig(ap).plugins).map(([name, e]) => {
    let m: Manifest | null = null;
    try { m = readManifest(path.join(ap.installed, name)); } catch {}
    const r = m ? resolveValues(m, [e.values]) : { parts: {}, options: {} };
    const reports: PluginRow['reports'] = {};
    for (const h of HARNESSES) if (e.builds[h]) { try { reports[h] = JSON.parse(fs.readFileSync(path.join(ap.build, e.builds[h]!, BUILD_FILES.report), 'utf8')); } catch { reports[h] = null; } }
    return {
      name, version: e.version, grade: e.grade, lost: e.lost, source: e.source, installedAt: e.installedAt,
      parts: m ? Object.entries(m.parts).map(([k, p]) => ({ name: k, on: r.parts[k], required: p.required, default: p.default })) : [],
      options: m ? Object.entries(m.options).map(([k, o]) => ({ name: k, type: o.type, value: r.options[k], default: o.default, label: o.label ?? null })) : [],
      reports,
    };
  });
}

// ---- 세션에 싣기 (Claude·Codex)

/** Codex 빌드에서 세션에 넘기는 것 — root 는 빌드의 플러그인 폴더(경로 변수를 바꾼 값), skills 는 extra root, bin 은 PATH 앞에 둘 폴더, args 는 app-server 인자 */
export type CodexLoad = { root: string; skills: string | null; bin: string | null; binSum: string; args: string[] };
/** 세션에 실은 플러그인 하나. instructions·env·settings(·codex 의 bin·args) 는 세션을 띄울 때 넘긴 값이다 — 다시 싣기로 바뀌지 않는다 */
export type Loaded = { name: string; version: string; build: string; values: string; instructions: string; env: Record<string, string>; settings: Record<string, unknown> | null; codex?: CodexLoad };
export type SessionPlugins = {
  /** SDK query options.plugins */
  plugins: { type: 'local'; path: string }[];
  /** 모든 플러그인의 지시문 (설치 순서) — SLCODE_PROMPT 뒤에 붙는다 */
  append: string;
  /** session.json 을 합친 것 (뒤의 플러그인이 이긴다) — SDK options.settings. 없으면 null */
  settings: Record<string, unknown> | null;
  /** manifest env 를 합친 것 */
  env: Record<string, string>;
  loaded: Loaded[];
  /** 싣지 못한 플러그인과 사유 — 세션은 오류 없이 뜬다 */
  notes: string[];
  /** Codex 세션 — skill extra root 들, PATH 앞에 둘 bin/ 들, app-server 인자 (설치 순서) */
  codex: { roots: string[]; bin: string[]; args: string[] };
};
/** 세션 단위 설정 값 — 플러그인 이름별 (slcode-session-profile 이 meta 에 채운다) */
export type SessionValues = Record<string, Values | undefined>;

/** Claude 가 플러그인 데이터 폴더로 쓰는 곳 — <설정 폴더>/plugins/data/<이름>-inline (SDK 로 실은 플러그인의 출처는 inline) */
export function claudeDataDir(name: string, env: NodeJS.ProcessEnv): string {
  const config = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(config, 'plugins', 'data', `${name}-inline`.replace(/[^A-Za-z0-9_-]/g, '-'));
}

type Plan = Loaded & { target: string };
/** 플러그인 하나의 지금 빌드 — 기본 설정 < 세션 값. Claude 는 지시문의 경로 변수를 세션 링크 경로로 바꾼다 (Claude 는 지시문을 치환하지 않는다).
 *  Codex 빌드는 이미 바꿨다 — 데이터 폴더만 만든다 */
function plan(ap: AgentPaths, name: string, e: PluginEntry, link: string, layers: (Values | undefined)[], env: NodeJS.ProcessEnv, harness: SessionHarness = 'claude'): Plan {
  const inst = path.join(ap.installed, name);
  const m = readManifest(inst);
  const b = ensureBuild(ap.build, inst, m, resolveValues(m, [e.values, ...layers]), e.hash, harness);
  const read = (f: string) => { try { return fs.readFileSync(path.join(b.dir, f), 'utf8'); } catch { return null; } };
  const base = { name, version: m.version, build: b.id, values: b.report.values, env: m.env };
  if (harness === 'codex') {
    const root = path.join(b.dir, 'codex');
    fs.mkdirSync(path.join(ap.data, name), { recursive: true, mode: 0o700 });
    const has = (d: string) => (fs.existsSync(path.join(root, d)) ? path.join(root, d) : null);
    const bin = has('bin');
    const h = createHash('sha256');
    if (bin) for (const r of walk(bin)) h.update(`${r}\0`).update(fs.readFileSync(path.join(bin, r))).update('\0');
    return { ...base, instructions: read(BUILD_FILES.instructions) ?? '', settings: null, target: root, codex: { root, skills: has('skills'), bin, binSum: h.digest('hex'), args: JSON.parse(read(BUILD_FILES.codexArgs) ?? '[]') } };
  }
  const instructions = (read(BUILD_FILES.instructions) ?? '').replaceAll('${CLAUDE_PLUGIN_ROOT}', link).replaceAll('${CLAUDE_PLUGIN_DATA}', claudeDataDir(name, env));
  const s = read(BUILD_FILES.settings);
  return { ...base, instructions, settings: s ? JSON.parse(s) : null, target: path.join(b.dir, 'claude', name) };
}

/** 링크를 새 대상으로 — 옆에 만든 뒤 rename 으로 바꾼다 (Windows 는 junction) */
function relink(link: string, target: string) {
  const tmp = `${link}.tmp-${randomUUID().slice(0, 8)}`;
  fs.symlinkSync(target, tmp, 'junction');
  fs.renameSync(tmp, link);
}

/** 세션을 띄울 때 — 설치한 플러그인마다 그 하네스의 빌드를 만들고(있으면 다시 쓰고) 세션 폴더에 링크를 건다. 싣지 못한 것은 notes 에.
 *  Codex 는 링크로 빌드를 정리에서 지킬 뿐, 넘기는 경로는 빌드 폴더 그대로다 (빌드 안의 경로 변수를 이미 그 경로로 바꿨다) */
export function loadSessionPlugins(sessionDir: string, env: NodeJS.ProcessEnv, session: SessionValues = {}, stateDir?: string, harness: SessionHarness = 'claude'): SessionPlugins {
  const ap = agentPaths(stateDir);
  const links = path.join(sessionDir, SESSION_LINKS);
  fs.rmSync(links, { recursive: true, force: true }); // 지난 기동의 링크 — 지운 플러그인이 남지 않게
  const out: SessionPlugins = { plugins: [], append: '', settings: null, env: {}, loaded: [], notes: [], codex: { roots: [], bin: [], args: [] } };
  const entries = Object.entries(readConfig(ap).plugins);
  if (!entries.length) return out;
  fs.mkdirSync(links, { recursive: true, mode: 0o700 });
  const texts: string[] = [];
  for (const [name, e] of entries) {
    const link = path.join(links, name);
    try {
      const { target, ...p } = plan(ap, name, e, link, [session[name]], env, harness);
      relink(link, target);
      if (p.codex) {
        if (p.codex.skills) out.codex.roots.push(p.codex.skills);
        if (p.codex.bin) out.codex.bin.push(p.codex.bin);
        out.codex.args.push(...p.codex.args);
      } else out.plugins.push({ type: 'local', path: link });
      out.loaded.push(p);
      if (p.instructions.trim()) texts.push(p.instructions.trim());
      Object.assign(out.env, p.env);
      if (p.settings) out.settings = { ...out.settings, ...p.settings };
    } catch (err) { out.notes.push(`${name}: ${(err as Error).message}`); }
  }
  out.append = texts.join('\n\n');
  return out;
}

/** 다시 싣기 — 실은 플러그인의 링크를 지금 설정의 빌드로 바꾼다. 지운 플러그인은 링크를 뗀다. SDK reloadPlugins()·Codex skills/extraRoots/set 은 부른 쪽이 한다.
 *  later 는 이 세션에 반영되지 않아 새 세션부터인 것 (지시문·env·session.json·Codex 의 MCP·bin 이 바뀐 플러그인, 세션 뒤에 설치한 플러그인).
 *  Codex 는 skill 만 다시 싣는다 — 기동 때의 빌드는 <이름> 링크로 남기고(MCP·bin 이 아직 그것을 쓴다) 새 빌드는 <이름>@skills 링크로 지킨다. roots 는 새 extra root 들 */
export type Later = { name: string; what: ('instructions' | 'env' | 'session.json' | 'mcp' | 'bin' | 'installed')[] };
export function reloadSessionPlugins(sessionDir: string, loaded: Loaded[], env: NodeJS.ProcessEnv, session: SessionValues = {}, stateDir?: string, harness: SessionHarness = 'claude'): { loaded: Loaded[]; later: Later[]; removed: string[]; roots: string[] } {
  const ap = agentPaths(stateDir);
  const plugins = readConfig(ap).plugins;
  const links = path.join(sessionDir, SESSION_LINKS);
  const later: Later[] = [], removed: string[] = [], next: Loaded[] = [], roots: string[] = [];
  // Codex 빌드의 값엔 빌드 폴더 경로가 박혀 있다 — 견줄 때는 다시 변수로
  const norm = (t: string, l: Loaded) => (l.codex ? t.replaceAll(l.codex.root, '${CLAUDE_PLUGIN_ROOT}') : t);
  for (const old of loaded) {
    const link = path.join(links, old.name);
    const e = plugins[old.name];
    if (!e) { fs.rmSync(link, { force: true }); fs.rmSync(`${link}@skills`, { force: true }); removed.push(old.name); continue; }
    const { target, ...p } = plan(ap, old.name, e, link, [session[old.name]], env, harness);
    if (p.codex) {
      let start = '';
      try { start = fs.readlinkSync(link); } catch {}
      if (path.resolve(path.dirname(link), start) === target) fs.rmSync(`${link}@skills`, { force: true }); else relink(`${link}@skills`, target);
    }
    else relink(link, target);
    const what: Later['what'] = [];
    if (norm(p.instructions, p) !== norm(old.instructions, old)) what.push('instructions');
    if (JSON.stringify(p.env) !== JSON.stringify(old.env)) what.push('env');
    if (JSON.stringify(p.settings) !== JSON.stringify(old.settings)) what.push('session.json');
    if (p.codex && old.codex) {
      if (norm(JSON.stringify(p.codex.args), p) !== norm(JSON.stringify(old.codex.args), old)) what.push('mcp');
      if (p.codex.binSum !== old.codex.binSum) what.push('bin');
    }
    if (p.codex?.skills) roots.push(p.codex.skills);
    if (what.length) later.push({ name: old.name, what });
    next.push({ ...p, instructions: old.instructions, env: old.env, settings: old.settings, ...(old.codex ? { codex: { ...old.codex, skills: p.codex?.skills ?? null } } : {}) });
  }
  for (const name of Object.keys(plugins)) if (!loaded.some((l) => l.name === name)) later.push({ name, what: ['installed'] });
  return { loaded: next, later, removed, roots };
}

/** 지금 설정으로 빌드하면 나올 식별자 — 세션이 실은 것과 다르면 다시 실을 것이 있다. 빌드하지 않는다 */
export function currentBuilds(session: SessionValues = {}, stateDir?: string, harness: SessionHarness = 'claude'): Record<string, string | null> {
  const ap = agentPaths(stateDir);
  const out: Record<string, string | null> = {};
  for (const [name, e] of Object.entries(readConfig(ap).plugins)) {
    try {
      const m = readManifest(path.join(ap.installed, name));
      out[name] = buildId(valuesString(resolveValues(m, [e.values, session[name]])), e.hash, harness);
    } catch { out[name] = null; }
  }
  return out;
}

/** 세션이 닫힐 때 — 링크를 떼어 그 빌드를 정리 대상으로 */
export function unlinkSessionPlugins(sessionDir: string) { fs.rmSync(path.join(sessionDir, SESSION_LINKS), { recursive: true, force: true }); }

/** 아무도 가리키지 않는 오래된 빌드를 지운다 — config 의 마지막 빌드, 세션 폴더의 링크, export/ 아래 링크가 가리키는 것은 남긴다.
 *  removed 는 방금 지운 플러그인 이름 — 그 플러그인의 빌드는 유예 없이 지운다 */
export function gcBuilds(stateDir?: string, graceMs = GC_GRACE_MS, removed?: string): string[] {
  const ap = agentPaths(stateDir);
  let ids: string[];
  try { ids = fs.readdirSync(ap.build); } catch { return []; }
  const keep = new Set<string>();
  for (const e of Object.values(readConfig(ap).plugins)) for (const id of Object.values(e.builds)) if (id) keep.add(id);
  const mark = (link: string) => {
    try { const rel = path.relative(ap.build, path.resolve(path.dirname(link), fs.readlinkSync(link))); if (!rel.startsWith('..')) keep.add(rel.split(path.sep)[0]); } catch {}
  };
  const sub = (d: string) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const slug of sub(ap.sessionsDir)) for (const id of sub(path.join(ap.sessionsDir, slug))) {
    const d = path.join(ap.sessionsDir, slug, id, SESSION_LINKS);
    for (const n of sub(d)) mark(path.join(d, n));
  }
  const walkLinks = (d: string) => { for (const n of sub(d)) { const p = path.join(d, n); try { if (fs.lstatSync(p).isSymbolicLink()) mark(p); else if (fs.statSync(p).isDirectory()) walkLinks(p); } catch {} } };
  walkLinks(ap.export);
  const gone: string[] = [];
  const now = Date.now();
  for (const id of ids) {
    if (keep.has(id)) continue;
    const d = path.join(ap.build, id);
    let ofRemoved = false;
    if (removed) try { ofRemoved = JSON.parse(fs.readFileSync(path.join(d, BUILD_FILES.report), 'utf8')).name === removed; } catch {}
    try { if (!ofRemoved && now - fs.statSync(d).mtimeMs < graceMs) continue; } catch { continue; }
    fs.rmSync(d, { recursive: true, force: true });
    gone.push(id);
  }
  return gone;
}
