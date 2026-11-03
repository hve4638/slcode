// 에이전트 플러그인의 상태 폴더와 명령 (ticket slcode-agent-plugin, 설계 ws docs/report/slcode-agent-plugin-survey.md).
// $SLCODE_DIR/agent-plugins/{installed/<이름>, config.json, build/<식별자>, export, data}. config.json 은 slcode 내부 파일이다 — 임시 파일 + rename,
// 쓰는 명령은 config.lock 을 쥔다. 설치는 원하는 상태를 적는 것이라 같은 원본을 몇 번 add 해도 결과가 같다.
// 세션에 싣기: 세션 폴더의 agent-plugins/<이름> 링크가 그 세션이 쓰는 빌드를 가리킨다. SDK 에는 링크 경로를 넘기므로, 다시 싣기는 링크를 새 빌드로
// 바꾸고 SDK reloadPlugins() 를 부르는 것이다. 정리(gc)는 config 의 마지막 빌드와 세션·export 링크가 가리키지 않는 빌드를 지운다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildId, commandErrors, commandFiles, compat, HARNESSES, MANIFEST, parseAssignment, partRoot, readManifest, resolveValues, sourceFiles, sourceHash, valuesString, userValues, walk, whenText, type Harness, type Manifest, type Values } from './agentFormat.js';
import { BUILD_FILES, ensureBuild, type Report } from './agentBuild.js';
import { buildPartCommands } from './agentHooks.js';
import { acquireLock, releaseLock } from './lock.js';
import { defaultStateDir } from './paths.js';
import { exportTo, refreshExport, unexport, withPartConditions, EXPORT_HARNESSES, type ExportHarness, type ExportReport, type ExportResult } from './agentExport.js';
import { checkScripts } from './scriptCheck.js';
import { addonDir, assemble, dependentsOf, rootOf, type AddonEntry, type Addons, type AddonState, type Assembled } from './agentAddons.js';
import { ensureLauncher, PLUGIN_VERSION } from './launcher.js';

export const AGENT_DIR = 'agent-plugins';
/** 세션 폴더 안의 링크 폴더 — agent-plugins/<이름> → build/<식별자>/claude/<이름> (Codex 는 build/<식별자>/codex, 다시 실은 skill 의 빌드는 <이름>@skills) */
export const SESSION_LINKS = 'agent-plugins';
/** 아무도 가리키지 않아도 이만큼은 남긴다 — 세션이 막 빌드하고 아직 링크를 걸지 않은 틈 */
const GC_GRACE_MS = 10 * 60_000;

export type AgentPaths = { dir: string; installed: string; addons: string; config: string; lock: string; build: string; export: string; data: string; sessionsDir: string };
export function agentPaths(stateDir = defaultStateDir()): AgentPaths {
  const dir = path.join(stateDir, AGENT_DIR);
  return { dir, installed: path.join(dir, 'installed'), addons: path.join(dir, 'addons'), config: path.join(dir, 'config.json'), lock: path.join(dir, 'config.lock'), build: path.join(dir, 'build'), export: path.join(dir, 'export'), data: path.join(dir, 'data'), sessionsDir: path.join(stateDir, 'sessions') };
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
  /** export 한 하네스 (slcode plugin export) — 리빌드 때 다시 쓰고, remove 때 해제한다 */
  exports?: ExportHarness[];
};
/** plugins 의 키 순서가 설치 순서 — 지시문을 이 순서로 잇는다. profiles 는 slcode 의 사용자 프로필(slcode profiles.ts) — 여기서는 그대로 둔다 */
export type AgentConfig = { format?: number; plugins: Record<string, PluginEntry>; addons?: Addons; profiles?: Record<string, unknown> };

/** 세션을 띄울 때 고른 층 — 실을 플러그인과 그 값. slcode 의 시작 프로필이 이 꼴을 품는다 (ticket slcode-session-profile) */
export type PluginLayer = { plugins: Record<string, Values & { on?: boolean }>; rest: boolean };
/** 그 플러그인을 이 층으로 싣는가 */
export const loadsPlugin = (p: PluginLayer, name: string): boolean => p.plugins[name]?.on ?? p.rest;
/** 그 플러그인의 이 층 값 (on 은 뺀다) */
export function profileValues(p: PluginLayer, name: string): Values | undefined {
  const v = p.plugins[name];
  return v ? { parts: v.parts, options: v.options } : undefined;
}

/** 상태 폴더 형식 판 (ticket slcode-plugin-split) — 한 머신의 여러 slcode-plugin 사본(slcode·superlite-for-agents 가 넣어 간 것)이 같은 상태 폴더를 쓴다.
 *  형식은 하위호환으로만 바꾸고(칸 더하기), 옛 사본이 읽지 못하게 바꿀 때만 올린다. 이 판보다 높은 상태 폴더에는 쓰지 않는다 */
export const STATE_FORMAT = 1;
export function readConfig(ap: AgentPaths): AgentConfig {
  try {
    const j = JSON.parse(fs.readFileSync(ap.config, 'utf8'));
    if (j && typeof j.plugins === 'object' && !Array.isArray(j.plugins)) return j;
  } catch {}
  return { plugins: {} };
}
export function writeConfig(ap: AgentPaths, c: AgentConfig) {
  const f = c.format;
  if (typeof f === 'number' && f > STATE_FORMAT) throw new Error(`agent plugin state ${ap.dir} is format ${f} — this slcode-plugin ${PLUGIN_VERSION} knows up to ${STATE_FORMAT}; update slcode or superlite`);
  c.format = STATE_FORMAT;
  fs.mkdirSync(ap.dir, { recursive: true, mode: 0o700 });
  const tmp = `${ap.config}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, ap.config);
}
export async function locked<T>(ap: AgentPaths, fn: () => T): Promise<T> {
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
function defaultBuild(ap: AgentPaths, name: string, e: PluginEntry, addons: Addons = {}) {
  const inst = path.join(ap.installed, name);
  const s = assemble(ap, name, e, addons);
  const { grade, lost } = compat(inst, s.m); // 애드온의 part 까지 — 빌드와 같은 범위
  Object.assign(e, { grade, lost });
  const r = resolveValues(s.m, [s.values]);
  for (const h of SESSION_HARNESSES) e.builds[h] = ensureBuild(ap.build, inst, s.m, r, s.hash, h, true).id;
  return ensureBuild(ap.build, inst, s.m, r, s.hash, 'claude');
}
const leftOutNotes = (name: string, s: Assembled) => s.addons.filter((a) => !a.on).map((a) => `${name}: addon ${a.name} left out: ${a.why}`);

/** base 는 애드온을 add 했을 때 합쳐진 플러그인 이름 — build·grade·lost 는 그 플러그인의 것. leftOut 은 판이 맞지 않거나 이름이 겹쳐 빌드에서 뺀 애드온과 사유 */
export type AddResult = { name: string; version: string; changed: boolean; grade: 'full' | 'partial'; lost: Record<Harness, string[]>; build: string | null; base?: string; leftOut?: string[]; exports?: ExportResult[] };

/** 리빌드 뒤 export 를 새 빌드로 — 실패는 결과의 notes 로 (리빌드를 막지 않는다) */
function refreshExports(ap: AgentPaths, name: string, e: PluginEntry, env: NodeJS.ProcessEnv): ExportResult[] | undefined {
  if (!e.exports?.length) return undefined;
  return e.exports.map((h) => refreshExport(ap, name, e, h, env));
}
const exportedNames = (c: AgentConfig, h: ExportHarness) => Object.entries(c.plugins).filter(([, e]) => e.exports?.includes(h)).map(([n]) => n);

/** export 한 플러그인이 있으면 훅 명령의 고정 런처를 이 사본 기준으로 맞춘다 (launcher.ts) — CLI 명령과 세션 시작 때. 사본의 node 가 바뀌어도 다음 실행에 고쳐진다 */
export function refreshLauncher(ap: AgentPaths, c = readConfig(ap)) {
  if (Object.values(c.plugins).some((e) => e.exports?.length)) ensureLauncher(ap.dir);
}

/** 마지막 Claude 빌드가 esbuild 를 받지 못해 js/ts 훅을 뺀 것인가 — 같은 원본을 다시 add 하면 받아 본다 */
const toolMissing = (ap: AgentPaths, e: PluginEntry) => { try { return !!JSON.parse(fs.readFileSync(path.join(ap.build, e.builds.claude ?? '-', BUILD_FILES.report), 'utf8')).toolMissing; } catch { return false; } };

/** 명령 검사 (ticket slcode-agent-plugin-command) — 이름(commandErrors)과 COMMAND 파일의 꼴(묶어 한 번 싣는다)을 모든 part 에서 본다. 틀리면 던진다(플러그인 적용 실패, 사용자 결정 2026-11-02).
 *  esbuild 를 받지 못하면 꼴 검사는 건너뛴다 — 빌드가 그 명령을 빼고 다음 add 때 다시 받아 본다 */
function checkCommands(src: string, m: Manifest, tools: string) { // 합친 manifest 면 part 마다 폴더가 다르다
  const errors = commandErrors(src, m);
  if (!errors.length) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-cmd-check-'));
    try {
      for (const part of Object.keys(m.parts)) {
        const root = partRoot(src, m, part);
        const r = buildPartCommands(path.join(root, part), part, commandFiles(root, part).commands, tmp, [], tools);
        if (!r.missing) errors.push(...r.failed);
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  if (errors.length) throw new Error(`${m.name}: agent plugin commands are invalid —\n  ${errors.join('\n  ')}`);
}

/** 원본 파일을 폴더로 복사한다 — sourceFiles 만 */
function installTo(target: string, abs: string, m: Manifest) {
  replaceDir(target, (tmp) => {
    for (const rel of sourceFiles(abs, m)) {
      const to = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(abs, rel), to);
      fs.chmodSync(to, fs.statSync(path.join(abs, rel)).mode & 0o777);
    }
  });
}

/** 원본을 installed/<이름>/ 에 복사한다(애드온은 addons/<이름>/). 내용 해시가 같으면 아무것도 하지 않는다. 새 판이면 기본 설정(맞는 값만 남긴다)으로 다시 빌드한다.
 *  manifest 가 없거나 깨졌으면 던진다. 베이스를 새 판으로 바꾸면 조건이 맞지 않는 애드온만 빌드에서 빠지고 leftOut 에 사유가 남는다 */
export async function addPlugin(src: string, stateDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<AddResult> {
  const abs = path.resolve(src);
  const m = readManifest(abs);
  const hash = sourceHash(abs, m);
  const ap = agentPaths(stateDir);
  const r = await locked(ap, () => {
    const c = readConfig(ap);
    if (m.addon) return addAddon(ap, c, abs, m, hash, env);
    if (c.addons?.[m.name]) throw new Error(`${m.name} is installed as an addon of ${c.addons[m.name].base} (slcode plugin remove ${m.name} first)`);
    const prev = c.plugins[m.name];
    const inst = path.join(ap.installed, m.name);
    if (prev && prev.hash === hash && fs.existsSync(path.join(inst, MANIFEST)) && !toolMissing(ap, prev)) return { name: m.name, version: prev.version, changed: false, grade: prev.grade, lost: prev.lost, build: prev.builds.claude ?? null };
    checkCommands(abs, m, path.join(ap.dir, 'tools'));
    fs.mkdirSync(ap.installed, { recursive: true });
    installTo(inst, abs, m);
    const { grade, lost } = compat(inst, m);
    const e: PluginEntry = { ...prev, version: m.version, hash, source: abs, installedAt: Date.now(), grade, lost, values: prune(prev?.values, m), builds: {}, ...(prev?.exports?.length ? { exports: prev.exports } : {}) };
    defaultBuild(ap, m.name, e, c.addons);
    c.plugins[m.name] = e;
    writeConfig(ap, c);
    const exports = refreshExports(ap, m.name, e, env);
    const leftOut = leftOutNotes(m.name, assemble(ap, m.name, e, c.addons));
    return { name: m.name, version: m.version, changed: true, grade: e.grade, lost: e.lost, build: e.builds.claude ?? null, ...(leftOut.length ? { leftOut } : {}), ...(exports ? { exports } : {}) };
  });
  gcBuilds(stateDir);
  return r;
}

/** 애드온 add — 베이스가 없거나, 판 조건이 맞지 않거나, 이름이 겹치면 던진다. 합쳐질 플러그인을 다시 빌드한다 */
function addAddon(ap: AgentPaths, c: AgentConfig, abs: string, m: Manifest, hash: string, env: NodeJS.ProcessEnv): AddResult {
  const spec = m.addon!;
  const addons = c.addons ?? {};
  if (c.plugins[m.name]) throw new Error(`${m.name} is installed as a plugin (slcode plugin remove ${m.name} first)`);
  const prev = addons[m.name];
  const entry: AddonEntry = { version: m.version, hash, source: abs, installedAt: Date.now(), base: spec.base, range: spec.version, values: prune(prev?.values, m) };
  // 새 것을 맨 뒤에 두고 미리 합친다 — 이미 있는 애드온과 겹치면 새 것이 빠져 거절된다
  const { [m.name]: _old, ...others } = addons;
  const trial: Addons = { ...others, [m.name]: entry };
  const root = rootOf(m.name, c, trial);
  if (!root) throw new Error(`${m.name} needs base ${spec.base}, which is not installed (or the addons make a cycle)`);
  const e = c.plugins[root];
  if (prev && prev.hash === hash && prev.base === spec.base && fs.existsSync(addonDir(ap, m.name)) && !toolMissing(ap, e)) return { name: m.name, version: prev.version, changed: false, grade: e.grade, lost: e.lost, build: e.builds.claude ?? null, base: root };
  const seen = assemble(ap, root, e, trial, (n) => (n === m.name ? abs : addonDir(ap, n)));
  const me = seen.addons.find((a) => a.name === m.name)!;
  if (!me.on) throw new Error(`cannot add ${m.name}: ${me.why}`);
  checkCommands(abs, seen.m, path.join(ap.dir, 'tools'));
  fs.mkdirSync(ap.addons, { recursive: true });
  installTo(addonDir(ap, m.name), abs, m);
  c.addons = { ...addons, [m.name]: entry }; // 갱신이면 설치 순서를 그대로 둔다
  defaultBuild(ap, root, e, c.addons);
  writeConfig(ap, c);
  const exports = refreshExports(ap, root, e, env);
  const leftOut = leftOutNotes(root, assemble(ap, root, e, c.addons));
  return { name: m.name, version: m.version, changed: true, grade: e.grade, lost: e.lost, build: e.builds.claude ?? null, base: root, ...(leftOut.length ? { leftOut } : {}), ...(exports ? { exports } : {}) };
}

/** 프로필에 남은 그 플러그인의 part·옵션 값을 지운다 — 애드온을 제거할 때. 다시 설치하면 옛 값이 되살아나지 않게 */
function forgetInProfiles(c: AgentConfig, plugin: string, keys: string[]) {
  for (const p of Object.values((c.profiles ?? {}) as Record<string, PluginLayer>)) {
    const v = p.plugins?.[plugin];
    if (v) for (const k of keys) { if (v.parts) delete v.parts[k]; if (v.options) delete v.options[k]; }
  }
}

/** 원본·설정 항목·export 를 지운다. 없으면 성공 (removed false). export 를 먼저 해제한다 — 링크가 사라진 빌드를 가리키면 하네스가 오류를 낸다.
 *  이름이 애드온이면 그 애드온만 지우고 베이스를 다시 빌드한다. 의존하는 애드온이 있으면 cascade 없이는 던지고, cascade 면 함께 지운다 */
export async function removePlugin(name: string, stateDir?: string, env: NodeJS.ProcessEnv = process.env, cascade = false): Promise<{ name: string; removed: boolean; addons?: string[]; exports?: ExportResult[] }> {
  const ap = agentPaths(stateDir);
  const r = await locked(ap, () => {
    const c = readConfig(ap);
    const addons = c.addons ?? {};
    const deps = dependentsOf(name, addons);
    if (deps.length && !cascade) throw new Error(`${deps.join(', ')} depend on ${name}: remove them first or use --cascade`);
    const isAddon = Object.hasOwn(addons, name);
    const gone = isAddon ? [name, ...deps] : deps;
    const root = rootOf(name, c, addons);
    for (const n of gone) {
      try { const m = readManifest(addonDir(ap, n)); if (root) forgetInProfiles(c, root, [...Object.keys(m.parts), ...Object.keys(m.options)]); } catch {}
      delete addons[n];
    }
    if (isAddon) {
      c.addons = addons;
      if (root) defaultBuild(ap, root, c.plugins[root], addons);
      writeConfig(ap, c);
      for (const n of gone) fs.rmSync(addonDir(ap, n), { recursive: true, force: true });
      const exports = root ? refreshExports(ap, root, c.plugins[root], env) : undefined;
      return { name, removed: true, ...(deps.length ? { addons: deps } : {}), ...(exports ? { exports } : {}) };
    }
    const inst = path.join(ap.installed, name);
    const had = !!c.plugins[name] || fs.existsSync(inst);
    const hs = c.plugins[name]?.exports ?? [];
    if (c.plugins[name] || deps.length) { delete c.plugins[name]; writeConfig(ap, c); }
    const exports = hs.map((h) => unexport(ap, name, h, exportedNames(c, h), env));
    fs.rmSync(inst, { recursive: true, force: true });
    for (const n of gone) fs.rmSync(addonDir(ap, n), { recursive: true, force: true });
    return { name, removed: had, ...(deps.length ? { addons: deps } : {}), ...(exports.length ? { exports } : {}) };
  });
  gcBuilds(stateDir, GC_GRACE_MS, name); // 지운 플러그인의 빌드는 유예 없이 — 새 세션이 더는 그것을 빌드하지 않는다
  return r;
}

/** export 하거나(--to) 해제한다(--remove). 설정 값은 플러그인 기본 설정 — 프로필 고르기는 미정. 하네스 CLI(claude·codex)를 env 의 PATH 에서 부른다 */
export async function exportPlugin(name: string, harnesses: string[], remove: boolean, stateDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<ExportResult[]> {
  for (const h of harnesses) if (!(EXPORT_HARNESSES as readonly string[]).includes(h)) throw new Error(`export target must be ${EXPORT_HARNESSES.join(' or ')}: ${h}`);
  const hs = [...new Set(harnesses)] as ExportHarness[];
  const ap = agentPaths(stateDir);
  const r = await locked(ap, () => {
    const c = readConfig(ap);
    const e = pluginEntry(c, name, 'export');
    const out: ExportResult[] = [];
    const save = (list: ExportHarness[]) => { if (list.length) e.exports = list; else delete e.exports; writeConfig(ap, c); };
    for (const h of hs) {
      const had = e.exports?.includes(h) ?? false;
      const others = (e.exports ?? []).filter((x) => x !== h);
      if (remove) {
        if (!had) { out.push({ name, harness: h, removed: false, build: null, link: null, excluded: [], notes: ['not exported'] }); continue; }
        save(others);
        out.push(unexport(ap, name, h, exportedNames(c, h), env));
        continue;
      }
      e.exports = [...others, h];
      out.push(exportTo(ap, name, e, h, exportedNames(c, h), env)); // 실패면 던진다 — 이 하네스는 config 에 적지 않는다
      save(e.exports);
    }
    return out;
  });
  return r;
}

/** 플러그인 항목 — 애드온 이름이면 베이스 이름으로 하라고 알린다. 애드온은 켜고 끄는 단위가 아니다 */
function pluginEntry(c: AgentConfig, name: string, verb: string): PluginEntry {
  const e = c.plugins[name];
  if (e) return e;
  const root = c.addons?.[name] ? rootOf(name, c, c.addons) : null;
  throw new Error(root ? `${name} is an addon of ${root}: slcode plugin ${verb} ${root} ...` : `no agent plugin ${name} (slcode plugin list)`);
}

/** 플러그인 기본 설정에서 part 를 켜고 끄거나 옵션 값을 바꾼다 — `<part>=on|off`, `<옵션>=<값>` 여럿. 하나라도 틀리면 아무것도 바꾸지 않는다 */
export async function setPlugin(name: string, assignments: string[], stateDir?: string, env: NodeJS.ProcessEnv = process.env): Promise<{ name: string; values: string; build: string; exports?: ExportResult[] }> {
  const ap = agentPaths(stateDir);
  const r = await locked(ap, () => {
    const c = readConfig(ap);
    const e = pluginEntry(c, name, 'set');
    const s = assemble(ap, name, e, c.addons);
    const owner = (key: string) => (s.owners[key] ? c.addons![s.owners[key]] : e); // 값은 그 part·옵션을 가진 쪽에 둔다 (AddonEntry.values)
    const next = new Map<PluginEntry | AddonEntry, Values>();
    for (const a of assignments) {
      const { kind, key, value } = parseAssignment(s.m, a);
      const o = owner(key);
      if (!next.has(o)) next.set(o, { parts: { ...o.values.parts }, options: { ...o.values.options } });
      (next.get(o)![kind] as Record<string, unknown>)[key] = value;
    }
    for (const [o, v] of next) o.values = prune(v, s.m);
    const b = defaultBuild(ap, name, e, c.addons);
    writeConfig(ap, c);
    const exports = refreshExports(ap, name, e, env);
    return { name, values: b.report.values, build: b.id, ...(exports ? { exports } : {}) };
  });
  gcBuilds(stateDir);
  return r;
}

export type PluginRow = {
  name: string; version: string; grade: 'full' | 'partial'; lost: Record<Harness, string[]>; source: string; installedAt: number;
  /** on 은 사용자 설정(기본 설정 기준) — when 은 조건 글(whenText)이고 세션마다 따로 본다. 기본 빌드·export 판은 param·env 가 없는 것으로 판단한다. needs 는 조건 when part 의 대상 — 관리 화면이 대상이 꺼진 part 를 비활성으로 보인다 */
  parts: { name: string; on: boolean; required: boolean; default: boolean; when: string | null; needs: string[]; addon: string | null }[];
  options: { name: string; type: string; value: unknown; default: unknown; label: string | null }[];
  /** 하네스별 마지막 빌드의 report.json — 빌드가 없으면 null */
  reports: Partial<Record<Harness, Report | null>>;
  /** 이 플러그인에 이어진 애드온 — on 이 거짓이면 빌드에서 뺀 것이고 why 가 사유. 판은 row.version(베이스)과 따로 적는다 */
  addons: AddonState[];
  /** export 한 하네스 */
  exports: ExportHarness[];
  /** export 한 하네스별 export 판의 report.json — 아직 만들지 않았거나 읽지 못하면 null */
  exported: Partial<Record<ExportHarness, ExportReport | null>>;
};

/** 설치 목록 — 기본 설정 기준의 part·옵션 값과 마지막 빌드 보고 */
export function listPlugins(stateDir?: string): PluginRow[] {
  const ap = agentPaths(stateDir);
  const config = readConfig(ap);
  return Object.entries(config.plugins).map(([name, e]) => {
    let s: Assembled | null = null;
    try { s = assemble(ap, name, e, config.addons); } catch {}
    const m = s?.m ?? null;
    const r = s ? userValues(s.m, [s.values]) : { parts: {}, options: {} };
    const reports: PluginRow['reports'] = {};
    for (const h of HARNESSES) if (e.builds[h]) { try { reports[h] = JSON.parse(fs.readFileSync(path.join(ap.build, e.builds[h]!, BUILD_FILES.report), 'utf8')); } catch { reports[h] = null; } }
    const exported: PluginRow['exported'] = {};
    for (const h of e.exports ?? []) { try { const x = JSON.parse(fs.readFileSync(path.join(ap.build, e.builds[h]!, 'export', h, BUILD_FILES.report), 'utf8')); exported[h] = s ? withPartConditions(x, s.m, s.values) : x; } catch { exported[h] = null; } }
    return {
      name, version: e.version, grade: e.grade, lost: e.lost, source: e.source, installedAt: e.installedAt,
      parts: m ? Object.entries(m.parts).map(([k, p]) => ({ name: k, on: r.parts[k], required: p.required, default: p.default, when: p.when ? whenText(p.when) : null, needs: Object.keys(p.when?.part ?? {}), addon: s?.owners[k] ?? null })) : [],
      options: m ? Object.entries(m.options).map(([k, o]) => ({ name: k, type: o.type, value: r.options[k], default: o.default, label: o.label ?? null })) : [],
      reports, addons: s?.addons ?? [], exports: e.exports ?? [], exported,
    };
  });
}

/** 베이스가 없어 어디에도 실리지 않는 애드온 — 옛 사본이 베이스를 지웠을 때 남는다. 베이스를 다시 add 하면 돌아온다 */
export function orphanAddons(stateDir?: string): { name: string; version: string; base: string }[] {
  const c = readConfig(agentPaths(stateDir));
  return Object.entries(c.addons ?? {}).filter(([n]) => !rootOf(n, c, c.addons!)).map(([name, a]) => ({ name, version: a.version, base: a.base }));
}

/** 합친 manifest — slcode 프로필이 애드온의 part·옵션 값을 받을 때 쓴다 */
export function pluginManifest(ap: AgentPaths, c: AgentConfig, name: string): Manifest {
  return assemble(ap, name, c.plugins[name], c.addons).m;
}

/** 빌드한 js/ts 훅의 보고 줄 — 빼거나 고칠 것과 하네스별 tsc 검사 경고 (ticket slcode-agent-plugin-script-portable). build 는 Claude 빌드(스크립트는 거기서 묶는다).
 *  CLI 의 add·set 이 stderr 에, 웹 관리 화면이 플러그인 칸에 보인다. 경고일 뿐 빌드는 그대로 */
export async function scriptWarnings(name: string, build: string, stateDir?: string): Promise<string[]> {
  const ap = agentPaths(stateDir);
  let rep: Report;
  try { rep = JSON.parse(fs.readFileSync(path.join(ap.build, build, BUILD_FILES.report), 'utf8')); } catch { return []; }
  const sc = rep.scripts ?? { built: [], failed: [], warnings: [] }, cm = rep.commands ?? { built: [], failed: [], warnings: [] };
  if (!(sc.built.length + sc.failed.length + cm.built.length + cm.failed.length)) return [];
  const lines = [...sc.failed, ...cm.failed].map((x) => `  failed: ${x}`).concat([...sc.warnings, ...cm.warnings].map((x) => `  warning: ${x}`));
  const inst = path.join(ap.installed, name);
  const config = readConfig(ap);
  const m = config.plugins[name] ? assemble(ap, name, config.plugins[name], config.addons).m : null;
  const file = (s: string) => path.join(m ? partRoot(inst, m, s.split('/')[0]) : inst, s); // "<part>/<경로>" — 애드온 part 는 애드온 폴더에 있다
  const c = await checkScripts(sc.built.map(file), ['claude', 'codex'], stateDir ?? defaultStateDir(), inst);
  // 명령은 slcode 의 Claude 세션에서만 돈다 — claude 표로만 본다
  const k = await checkScripts(cm.built.map(file), ['claude'], stateDir ?? defaultStateDir(), inst);
  const skipped = c.skipped ?? k.skipped;
  if (skipped) lines.push(`  type check skipped: ${skipped}`);
  for (const r of [c, k]) for (const [h, ws] of Object.entries(r.warnings)) lines.push(...ws.map((w) => `  ${h === 'codex' ? 'codex export' : h}: ${w}`));
  return lines;
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
/** 세션 인자 (slcode new --param, ticket slcode-agent-plugin-part-when) — part 조건 when 이 본다. 플러그인 모두에 같다 */
export type SessionParams = Record<string, string>;

/** Claude 가 플러그인 데이터 폴더로 쓰는 곳 — <설정 폴더>/plugins/data/<이름>-inline (SDK 로 실은 플러그인의 출처는 inline) */
export function claudeDataDir(name: string, env: NodeJS.ProcessEnv): string {
  const config = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(config, 'plugins', 'data', `${name}-inline`.replace(/[^A-Za-z0-9_-]/g, '-'));
}

type Plan = Loaded & { target: string; leftOut: string[] };
/** 플러그인 하나의 지금 빌드 — 기본 설정 < 프로필 < 세션 값. Claude 는 지시문의 경로 변수를 세션 링크 경로로 바꾼다 (Claude 는 지시문을 치환하지 않는다).
 *  Codex 빌드는 이미 바꿨다 — 데이터 폴더만 만든다 */
function plan(ap: AgentPaths, name: string, e: PluginEntry, link: string, layers: (Values | undefined)[], env: NodeJS.ProcessEnv, harness: SessionHarness = 'claude', params: SessionParams = {}): Plan {
  const inst = path.join(ap.installed, name);
  const s = assemble(ap, name, e);
  const m = s.m;
  const b = ensureBuild(ap.build, inst, m, resolveValues(m, [s.values, ...layers], params, env), s.hash, harness);
  const leftOut = leftOutNotes(name, s);
  const read = (f: string) => { try { return fs.readFileSync(path.join(b.dir, f), 'utf8'); } catch { return null; } };
  const base = { name, version: m.version, build: b.id, values: b.report.values, env: m.env };
  if (harness === 'codex') {
    const root = path.join(b.dir, 'codex');
    fs.mkdirSync(path.join(ap.data, name), { recursive: true, mode: 0o700 });
    const has = (d: string) => (fs.existsSync(path.join(root, d)) ? path.join(root, d) : null);
    const bin = has('bin');
    const h = createHash('sha256');
    if (bin) for (const r of walk(bin)) h.update(`${r}\0`).update(fs.readFileSync(path.join(bin, r))).update('\0');
    return { ...base, instructions: read(BUILD_FILES.instructions) ?? '', settings: null, target: root, leftOut, codex: { root, skills: has('skills'), bin, binSum: h.digest('hex'), args: JSON.parse(read(BUILD_FILES.codexArgs) ?? '[]') } };
  }
  const instructions = (read(BUILD_FILES.instructions) ?? '').replaceAll('${CLAUDE_PLUGIN_ROOT}', link).replaceAll('${CLAUDE_PLUGIN_DATA}', claudeDataDir(name, env));
  const st = read(BUILD_FILES.settings);
  return { ...base, instructions, settings: st ? JSON.parse(st) : null, target: path.join(b.dir, 'claude', name), leftOut };
}

/** 링크를 새 대상으로 — 옆에 만든 뒤 rename 으로 바꾼다 (Windows 는 junction) */
function relink(link: string, target: string) {
  const tmp = `${link}.tmp-${randomUUID().slice(0, 8)}`;
  fs.symlinkSync(target, tmp, 'junction');
  fs.renameSync(tmp, link);
}

/** 세션을 띄울 때 — 설치한 플러그인마다 그 하네스의 빌드를 만들고(있으면 다시 쓰고) 세션 폴더에 링크를 건다. 싣지 못한 것은 notes 에.
 *  Codex 는 링크로 빌드를 정리에서 지킬 뿐, 넘기는 경로는 빌드 폴더 그대로다 (빌드 안의 경로 변수를 이미 그 경로로 바꿨다).
 *  프로필이 있으면 그 프로필이 싣는 플러그인만, 설정 값은 기본 설정 < 프로필 < 세션 (ticket slcode-session-profile). params 는 세션 인자 — 켠 part 의 조건 when 이 본다. env 도 그대로 조건이 보고, manifest env 는 보지 않는다(part 가 자기 조건을 스스로 켤 수 있다, ticket slcode-agent-plugin-part-when-part) */
export function loadSessionPlugins(sessionDir: string, env: NodeJS.ProcessEnv, session: SessionValues = {}, stateDir?: string, harness: SessionHarness = 'claude', profile?: PluginLayer, params: SessionParams = {}): SessionPlugins {
  const ap = agentPaths(stateDir);
  const links = path.join(sessionDir, SESSION_LINKS);
  fs.rmSync(links, { recursive: true, force: true }); // 지난 기동의 링크 — 지운 플러그인이 남지 않게
  const out: SessionPlugins = { plugins: [], append: '', settings: null, env: {}, loaded: [], notes: [], codex: { roots: [], bin: [], args: [] } };
  const config = readConfig(ap);
  try { refreshLauncher(ap, config); } catch {} // 훅 명령의 런처 — 세션을 막지 않는다
  const entries = Object.entries(config.plugins).filter(([name]) => !profile || loadsPlugin(profile, name));
  if (!entries.length) return out;
  fs.mkdirSync(links, { recursive: true, mode: 0o700 });
  const texts: string[] = [];
  for (const [name, e] of entries) {
    const link = path.join(links, name);
    try {
      const { target, leftOut, ...p } = plan(ap, name, e, link, [profile && profileValues(profile, name), session[name]], env, harness, params);
      out.notes.push(...leftOut);
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
export function reloadSessionPlugins(sessionDir: string, loaded: Loaded[], env: NodeJS.ProcessEnv, session: SessionValues = {}, stateDir?: string, harness: SessionHarness = 'claude', profile?: PluginLayer, params: SessionParams = {}): { loaded: Loaded[]; later: Later[]; removed: string[]; roots: string[]; notes: string[] } {
  const ap = agentPaths(stateDir);
  const plugins = readConfig(ap).plugins;
  const links = path.join(sessionDir, SESSION_LINKS);
  const later: Later[] = [], removed: string[] = [], next: Loaded[] = [], roots: string[] = [], notes: string[] = [];
  // Codex 빌드의 값엔 빌드 폴더 경로가 박혀 있다 — 견줄 때는 다시 변수로
  const norm = (t: string, l: Loaded) => (l.codex ? t.replaceAll(l.codex.root, '${CLAUDE_PLUGIN_ROOT}') : t);
  for (const old of loaded) {
    const link = path.join(links, old.name);
    const e = plugins[old.name];
    if (!e || (profile && !loadsPlugin(profile, old.name))) { fs.rmSync(link, { force: true }); fs.rmSync(`${link}@skills`, { force: true }); removed.push(old.name); continue; }
    const { target, leftOut, ...p } = plan(ap, old.name, e, link, [profile && profileValues(profile, old.name), session[old.name]], env, harness, params);
    notes.push(...leftOut);
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
  for (const name of Object.keys(plugins)) if (!loaded.some((l) => l.name === name) && (!profile || loadsPlugin(profile, name))) later.push({ name, what: ['installed'] });
  return { loaded: next, later, removed, roots, notes };
}

/** 지금 설정으로 빌드하면 나올 식별자 — 세션이 실은 것과 다르면 다시 실을 것이 있다. 빌드하지 않는다 */
export function currentBuilds(session: SessionValues = {}, stateDir?: string, harness: SessionHarness = 'claude', profile?: PluginLayer, params: SessionParams = {}, env: NodeJS.ProcessEnv = {}): Record<string, string | null> {
  const ap = agentPaths(stateDir);
  const out: Record<string, string | null> = {};
  for (const [name, e] of Object.entries(readConfig(ap).plugins)) {
    if (profile && !loadsPlugin(profile, name)) continue;
    try {
      const s = assemble(ap, name, e);
      out[name] = buildId(valuesString(resolveValues(s.m, [s.values, profile && profileValues(profile, name), session[name]], params, env)), s.hash, harness);
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
