// 세션 시작 프로필 (ticket slcode-session-profile, 사용자 결정 2026-10-28 — ws docs/ticket/slcode-session-profile/TICKET.md).
// 새 세션을 띄울 때 고른다(`slcode new --profile <이름>`, 생략하면 default). 세션 meta 에는 이름만 남기고, 띄울 때마다(resume 포함) 그 프로필의 지금 값을 읽는다.
// 프로필은 두 가지를 정한다: 실을 slcode 에이전트 플러그인과 그 설정 값(기본 설정 < 프로필 < 세션), Claude 가 사용자·프로젝트 설정을 읽을지.
// 기본 제공 default·bare 는 config.json 에 없고 고칠 수 없다. 사용자 프로필은 config.json 의 profiles 에 둔다.
// Codex 는 실을 플러그인과 그 값만 따르고 Claude 쪽 로드 설정(claude.*)에 해당하는 것은 없다 — 사용자 설정을 막을 옵션이 없고, pi 계열로 가기 전의
// 중간 단계라 우회책을 두지 않는다 (사용자 2026-10-28).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAssignment, readManifest, type Values } from './agentFormat.js';
import { agentPaths, locked, readConfig, writeConfig, type AgentConfig } from './agentPlugins.js';

/** Claude 가 읽을 것 — 끄면 그 출처의 CLAUDE.md·skill·플러그인·MCP·훅·권한이 함께 빠진다 (SDK settingSources). Md 는 CLAUDE.md 만 따로 끈다 */
export type ClaudeLoadSpec = { user: boolean; project: boolean; userMd: boolean; projectMd: boolean; builtinSkills: boolean };
export type Profile = {
  /** 플러그인별 싣기(on)와 part·옵션 값. on 이 없으면 rest 를 따른다 */
  plugins: Record<string, Values & { on?: boolean }>;
  /** plugins 에서 on 을 정하지 않은 플러그인(나중에 설치한 것 포함)을 실을지 */
  rest: boolean;
  claude: ClaudeLoadSpec;
};
export const DEFAULT_PROFILE = 'default';
const ALL: ClaudeLoadSpec = { user: true, project: true, userMd: true, projectMd: true, builtinSkills: true };
// CLAUDE.md 끄기는 출처가 켜져 있을 때만 뜻이 있다 — bare 에서 만든 프로필이 출처를 켜면 그 CLAUDE.md 도 실린다
const NONE: ClaudeLoadSpec = { user: false, project: false, userMd: true, projectMd: true, builtinSkills: false };
export const BUILTIN_PROFILES: Record<string, Profile> = {
  default: { plugins: {}, rest: true, claude: ALL },
  bare: { plugins: {}, rest: false, claude: NONE },
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** profile set 의 Claude 키 — claude.<키>=on|off */
const CLAUDE_KEYS: Record<string, keyof ClaudeLoadSpec> = { user: 'user', project: 'project', 'user-md': 'userMd', 'project-md': 'projectMd', 'builtin-skills': 'builtinSkills' };

const clone = (p: Profile): Profile => JSON.parse(JSON.stringify(p));
const userProfiles = (stateDir?: string): Record<string, Profile> => readConfig(agentPaths(stateDir)).profiles ?? {};

/** 이름으로 — 없으면 null */
export function getProfile(name: string, stateDir?: string): Profile | null {
  const p = BUILTIN_PROFILES[name] ?? userProfiles(stateDir)[name];
  return p ? clone(p) : null;
}
/** 세션을 띄울 때 — meta 의 이름(없으면 default)으로. 지운 프로필이면 default 와 사유 */
export function sessionProfile(name: string | undefined, stateDir?: string): { name: string; profile: Profile; missing: string | null } {
  const n = name ?? DEFAULT_PROFILE;
  const p = getProfile(n, stateDir);
  return p ? { name: n, profile: p, missing: null } : { name: DEFAULT_PROFILE, profile: getProfile(DEFAULT_PROFILE)!, missing: n };
}

/** 그 플러그인을 이 프로필로 싣는가 */
export const loadsPlugin = (p: Profile, name: string): boolean => p.plugins[name]?.on ?? p.rest;
/** 그 플러그인의 프로필 층 값 (on 은 뺀다) */
export function profileValues(p: Profile, name: string): Values | undefined {
  const v = p.plugins[name];
  return v ? { parts: v.parts, options: v.options } : undefined;
}

function editable(name: string) {
  if (BUILTIN_PROFILES[name]) throw new Error(`${name} is a built-in profile and cannot be changed`);
  if (!NAME.test(name)) throw new Error(`profile name must match ${NAME}`);
}

/** 사용자 프로필을 만든다 — from(기본 default)의 값을 복사해 시작하고 assignments(setProfile 과 같은 꼴)를 얹는다. 이미 있거나 값이 하나라도 틀리면 아무것도 만들지 않는다 */
export async function addProfile(name: string, from = DEFAULT_PROFILE, stateDir?: string, assignments: string[] = []): Promise<{ name: string; from: string }> {
  editable(name);
  const ap = agentPaths(stateDir);
  return locked(ap, () => {
    const c = readConfig(ap);
    if (c.profiles?.[name]) throw new Error(`profile ${name} already exists`);
    const base = BUILTIN_PROFILES[from] ?? c.profiles?.[from];
    if (!base) throw new Error(`no profile ${from} (slcode profile list)`);
    c.profiles = { ...c.profiles, [name]: assign(clone(base), assignments, c, ap) };
    writeConfig(ap, c);
    return { name, from };
  });
}

/** 사용자 프로필을 지운다. 없으면 removed false. 그 프로필로 띄운 세션은 다음 기동부터 default 로 뜬다 */
export async function removeProfile(name: string, stateDir?: string): Promise<{ name: string; removed: boolean }> {
  editable(name);
  const ap = agentPaths(stateDir);
  return locked(ap, () => {
    const c = readConfig(ap);
    if (!c.profiles?.[name]) return { name, removed: false };
    delete c.profiles[name];
    writeConfig(ap, c);
    return { name, removed: true };
  });
}

/** `<플러그인>=on|off`, `<플러그인>.<part>=on|off`, `<플러그인>.<옵션>=<값>`, `other-plugins=on|off`, `claude.<키>=on|off`. 하나라도 틀리면 아무것도 바꾸지 않는다 */
export async function setProfile(name: string, assignments: string[], stateDir?: string): Promise<{ name: string; profile: Profile }> {
  editable(name);
  const ap = agentPaths(stateDir);
  return locked(ap, () => {
    const c = readConfig(ap);
    const cur = c.profiles?.[name];
    if (!cur) throw new Error(`no profile ${name} (slcode profile add ${name})`);
    const p = assign(clone(cur), assignments, c, ap);
    c.profiles = { ...c.profiles, [name]: p };
    writeConfig(ap, c);
    return { name, profile: p };
  });
}
/** assignments 를 p 에 얹는다 (p 를 바꾼다). 틀린 값은 던진다 */
function assign(p: Profile, assignments: string[], c: AgentConfig, ap: ReturnType<typeof agentPaths>): Profile {
  const onOff = (key: string, raw: string) => { if (raw !== 'on' && raw !== 'off') throw new Error(`${key} takes on|off`); return raw === 'on'; };
  for (const a of assignments) {
    const i = a.indexOf('=');
    if (i <= 0) throw new Error(`expected <key>=<value>: ${a}`);
    const key = a.slice(0, i), raw = a.slice(i + 1);
    if (key === 'other-plugins') { p.rest = onOff(key, raw); continue; }
    if (key.startsWith('claude.') && CLAUDE_KEYS[key.slice(7)]) { p.claude[CLAUDE_KEYS[key.slice(7)]] = onOff(key, raw); continue; }
    const dot = key.indexOf('.');
    const plugin = dot < 0 ? key : key.slice(0, dot);
    if (!c.plugins[plugin]) throw new Error(`no agent plugin ${plugin} (slcode plugin list; claude keys: ${Object.keys(CLAUDE_KEYS).map((k) => `claude.${k}`).join(', ')})`);
    const v = (p.plugins[plugin] ??= {});
    if (dot < 0) { v.on = onOff(key, raw); continue; }
    const r = parseAssignment(readManifest(path.join(ap.installed, plugin)), `${key.slice(dot + 1)}=${raw}`);
    ((v[r.kind] ??= {}) as Record<string, unknown>)[r.key] = r.value;
  }
  return p;
}

/** 화면(시작 화면·채팅창의 프로필 고르기)에 보이는 한 줄 */
export function profileSummary(p: Profile): string {
  const named = Object.entries(p.plugins);
  const on = named.filter(([, v]) => v.on === true).map(([n]) => n), off = named.filter(([, v]) => v.on === false).map(([n]) => n);
  const which = p.rest ? (off.length ? `플러그인 전부 (${off.join(', ')} 빼고)` : '플러그인 전부') : on.length ? `플러그인 ${on.join(', ')}` : '플러그인 없음';
  const c = p.claude;
  const src = (k: string, set: boolean, md: boolean) => (set ? (md ? k : `${k} (CLAUDE.md 끔)`) : null);
  const claude = [src('사용자 설정', c.user, c.userMd), src('프로젝트 설정', c.project, c.projectMd)].filter(Boolean);
  return [which, claude.length ? `Claude ${claude.join(' · ')}` : 'Claude 설정 끔', c.builtinSkills ? null : '내장 skill 숨김'].filter(Boolean).join(' · ');
}

export type ProfileRow = { name: string; builtin: boolean; profile: Profile };
/** 기본 제공 먼저, 그 뒤 만든 순서 */
export function listProfiles(stateDir?: string): ProfileRow[] {
  return [
    ...Object.entries(BUILTIN_PROFILES).map(([name, profile]) => ({ name, builtin: true, profile: clone(profile) })),
    ...Object.entries(userProfiles(stateDir)).map(([name, profile]) => ({ name, builtin: false, profile })),
  ];
}

/** Claude SDK 에 넘길 로드 설정 — settingSources·claudeMdExcludes(플래그 settings)·skills 허용 목록(null 이면 거르지 않는다)·벤더 env */
export type ClaudeLoad = { settingSources: ('user' | 'project' | 'local')[]; claudeMdExcludes: string[]; skills: string[] | null; env: Record<string, string> };

const subdirs = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } };

/** 프로필의 Claude 쪽을 SDK 옵션으로. plugins 는 실은 slcode 플러그인(이름·폴더) — 내장 skill 을 숨길 때 허용 목록에 그 skill 을 넣는다.
 *  SDK 0.3.282 실측(2026-10-28): settingSources 에서 user 를 빼면 ~/.claude 의 CLAUDE.md·skill·~/.claude.json MCP 가, project 를 빼면 프로젝트
 *  CLAUDE.md·.claude/skills·.mcp.json 이 빠지고 inline 플러그인은 남는다. claudeMdExcludes 는 CLAUDE.md 만 뺀다. skills 허용 목록은 그 밖의 skill 을
 *  모델 요청에서 뺀다 — 이름은 디렉터리 이름, 플러그인 것은 <플러그인>:<skill>. 사용자가 ~/.claude 에 설치한 Claude 플러그인의 skill 은 미리 알 수 없어
 *  내장 skill 을 숨기면 함께 빠진다. claude.ai 계정의 MCP 커넥터(Gmail·Drive 등)는 settingSources 와 상관없이 실려(실측) 사용자 설정을 끌 때
 *  ENABLE_CLAUDEAI_MCP_SERVERS=false 로 함께 끈다 */
export function claudeLoad(c: ClaudeLoadSpec, cwd: string, env: NodeJS.ProcessEnv, plugins: { name: string; path: string }[]): ClaudeLoad {
  const config = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude'));
  const settingSources: ClaudeLoad['settingSources'] = [...(c.user ? ['user' as const] : []), ...(c.project ? ['project' as const, 'local' as const] : [])];
  const claudeMdExcludes: string[] = [];
  if (c.user && !c.userMd) claudeMdExcludes.push(path.join(config, 'CLAUDE.md'), path.join(config, 'rules/**'));
  if (c.project && !c.projectMd) {
    // 프로젝트 쪽 기억 파일 — cwd 아래 전부와 cwd 에서 / 까지의 조상. 조상의 .claude 가 사용자 설정 폴더면 그 안은 사용자 것이라 남긴다
    claudeMdExcludes.push(path.join(cwd, '**/CLAUDE.md'), path.join(cwd, '**/CLAUDE.local.md'));
    for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
      claudeMdExcludes.push(path.join(d, 'CLAUDE.md'), path.join(d, 'CLAUDE.local.md'));
      if (path.join(d, '.claude') !== config) claudeMdExcludes.push(path.join(d, '.claude/CLAUDE.md'), path.join(d, '.claude/rules/**'));
      if (path.dirname(d) === d) break;
    }
  }
  const skills = c.builtinSkills ? null : [
    ...plugins.flatMap((p) => subdirs(path.join(p.path, 'skills')).map((s) => `${p.name}:${s}`)),
    ...(c.user ? subdirs(path.join(config, 'skills')) : []),
    ...(c.project ? subdirs(path.join(cwd, '.claude/skills')) : []),
  ];
  return { settingSources, claudeMdExcludes, skills, env: c.user ? {} : { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } };
}
