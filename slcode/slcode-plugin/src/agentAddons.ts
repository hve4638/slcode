// 에이전트 플러그인 애드온 (ticket slcode-plugin-addon, 사용자 결정 2026-11-03) — 베이스 플러그인에 합쳐 빌드해 베이스의 part 를 조건으로 쓰고 베이스의 이름을 그대로 쓴다.
// 상태 폴더: config.json 의 addons 칸과 agent-plugins/addons/<이름>/. plugins 칸에 넣지 않으므로 옛 사본은 애드온을 보지 못하고 베이스만 싣는다(칸은 지우지 않는다, 0.3.0·0.4.0 실측).
// 합치기는 저장하지 않고 쓸 때마다 만든다 — 옛 사본이 베이스를 바꿔도 다음 세션이 지금 상태로 판단한다. 애드온이 없으면 베이스 그대로라 빌드 식별자가 애드온 전과 같다.
// 판 조건·이름 겹침으로 뺄 애드온은 여기서 정한다: add 는 새 애드온이 빠지면 거절하고, 베이스 갱신은 맞지 않는 애드온만 빼고 사유(why)를 목록·세션 알림에 보인다.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { commandFiles, readManifest, skillNames, versionHolds, type Manifest, type Values } from './agentFormat.js';
import type { AgentConfig, AgentPaths, PluginEntry } from './agentPlugins.js';

export type AddonEntry = {
  version: string;
  /** 설치한 원본의 내용 해시 */
  hash: string;
  source: string;
  installedAt: number;
  base: string;
  /** 베이스 판의 조건 */
  range: string;
  /** 이 애드온의 part·옵션 값 (plugin set <베이스>) — 베이스 칸이 아니라 여기에 둔다: 제거하면 함께 사라지고, 잠시 빠져도, 옛 사본이 베이스 값을 정리해도 남는다 */
  values: Values;
};
export type Addons = Record<string, AddonEntry>;
/** on 이 거짓이면 빌드에서 뺀 것이고 why 가 사유다 */
export type AddonState = { name: string; version: string; base: string; range: string; on: boolean; why: string | null; source: string };
export type Assembled = {
  /** 합친 manifest — 이름·판은 베이스의 것, part·옵션은 베이스 다음 실린 애드온 순서 */
  m: Manifest;
  /** 빌드 식별자에 넣는 해시 — 실린 애드온이 없으면 베이스 해시 그대로 */
  hash: string;
  /** 플러그인 기본 설정 층 */
  values: Values;
  addons: AddonState[];
  /** 실린 애드온의 part·옵션 이름 → 애드온 이름 */
  owners: Record<string, string>;
};

export const addonDir = (ap: AgentPaths, name: string) => path.join(ap.addons, name);
export function readAddons(ap: AgentPaths): Addons {
  try { const j = JSON.parse(fs.readFileSync(ap.config, 'utf8')); return j && typeof j.addons === 'object' && !Array.isArray(j.addons) && j.addons ? j.addons : {}; } catch { return {}; }
}

/** 애드온 사슬의 맨 아래 플러그인 이름 — 사슬이 끊겼거나 순환이면 null */
export function rootOf(name: string, c: Pick<AgentConfig, 'plugins'>, addons: Addons): string | null {
  const seen = new Set<string>();
  for (let n = name; ; n = addons[n].base) {
    if (Object.hasOwn(c.plugins, n)) return n;
    if (!Object.hasOwn(addons, n) || seen.has(n)) return null;
    seen.add(n);
  }
}
/** 그 이름에 직접·간접으로 의존하는 애드온 (설치 순서) */
export function dependentsOf(name: string, addons: Addons): string[] {
  const hit = new Set<string>([name]);
  for (let grew = true; grew;) { grew = false; for (const [n, a] of Object.entries(addons)) if (!hit.has(n) && hit.has(a.base)) { hit.add(n); grew = true; } }
  hit.delete(name);
  return Object.keys(addons).filter((n) => hit.has(n));
}

/** 합칠 때 겹침을 보는 skill·명령 이름 — 한 플러그인 안에서 skill 과 명령도 같은 이름을 못 쓴다 */
function callNames(dir: string, m: Manifest): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of Object.keys(m.parts)) {
    const root = m.roots?.[part] ?? dir;
    for (const s of skillNames(root, part)) if (!out.has(s)) out.set(s, `skill ${s}`);
    for (const { name } of commandFiles(root, part).commands) if (!out.has(name)) out.set(name, `command ${name}`);
  }
  return out;
}

/** 베이스 name 과 거기 이어진 애드온을 합친다. dirOf 는 애드온 폴더 — add 가 아직 설치하지 않은 원본으로 미리 볼 때 바꾼다 */
export function assemble(ap: AgentPaths, name: string, e: PluginEntry, addons: Addons = readAddons(ap), dirOf: (addon: string) => string = (n) => addonDir(ap, n)): Assembled {
  const inst = path.join(ap.installed, name);
  const base = readManifest(inst);
  const mine = Object.entries(addons).filter(([n]) => rootOf(n, { plugins: { [name]: e } }, addons) === name);
  if (!mine.length) return { m: base, hash: e.hash, values: e.values, addons: [], owners: {} };
  const m: Manifest = { ...base, options: { ...base.options }, parts: { ...base.parts }, env: { ...base.env }, roots: Object.fromEntries(Object.keys(base.parts).map((p) => [p, inst])) };
  const values = { parts: { ...e.values.parts }, options: { ...e.values.options } };
  const owners: Record<string, string> = {};
  const hash = createHash('sha256').update(e.hash);
  const states = new Map<string, AddonState>();
  const on = new Map<string, { version: string; own: Set<string>; base: string | null }>([[name, { version: base.version, own: new Set(Object.keys(base.parts)), base: null }]]);
  const names = new Map([...callNames(inst, base)].map(([k, v]) => [k, `${v} of ${name}`]));
  // 베이스가 먼저 정해진 것부터 — 설치 순서를 지키되 애드온의 애드온은 그 베이스 뒤로
  const waiting = new Map(mine);
  while (waiting.size) {
    const [n, a] = [...waiting].find(([, x]) => on.has(x.base) || states.has(x.base))!;
    waiting.delete(n);
    const left = (why: string) => states.set(n, { name: n, version: a.version, base: a.base, range: a.range, on: false, why, source: a.source });
    const b = on.get(a.base);
    if (!b) { left(`base addon ${a.base} is left out`); continue; }
    if (!versionHolds(b.version, a.range)) { left(`needs ${a.base} ${a.range}, installed ${b.version}`); continue; }
    let am: Manifest;
    try { am = readManifest(dirOf(n)); } catch (err) { left((err as Error).message); continue; }
    const taken = [...Object.keys(am.parts), ...Object.keys(am.options)].find((k) => k in m.parts || k in m.options);
    if (taken) { left(`${taken} is already a part or option of ${name}`); continue; }
    // when.part 는 자기 part 와 베이스 쪽 사슬만 본다 — 형제 애드온은 없을 수 있다
    const visible = new Set(Object.keys(am.parts));
    for (let x: string | null = a.base; x; x = on.get(x)!.base) for (const p of on.get(x)!.own) visible.add(p);
    const missing = Object.entries(am.parts).flatMap(([p, s]) => Object.keys(s.when?.part ?? {}).filter((t) => !visible.has(t)).map((t) => `part ${p} when part ${t} is not a part of this addon or its base`));
    if (missing.length) { left(missing[0]); continue; }
    const mineNames = callNames(dirOf(n), am);
    const clash = [...mineNames].find(([k]) => names.has(k));
    if (clash) { left(`${clash[1]} has the same name as ${names.get(clash[0])}`); continue; }
    for (const [k, v] of mineNames) names.set(k, `${v} of ${n}`);
    for (const p of Object.keys(am.parts)) { m.parts[p] = am.parts[p]; m.roots![p] = dirOf(n); owners[p] = n; }
    for (const o of Object.keys(am.options)) { m.options[o] = am.options[o]; owners[o] = n; }
    Object.assign(m.env, am.env);
    Object.assign(values.parts, a.values.parts);
    Object.assign(values.options, a.values.options);
    hash.update(`\0${n}\0${a.hash}`);
    on.set(n, { version: am.version, own: new Set(Object.keys(am.parts)), base: a.base });
    states.set(n, { name: n, version: a.version, base: a.base, range: a.range, on: true, why: null, source: a.source });
  }
  const list = mine.map(([n]) => states.get(n)!);
  return { m, hash: list.some((a) => a.on) ? hash.digest('hex') : e.hash, values, addons: list, owners };
}
