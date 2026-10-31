// 에이전트 플러그인 export (ticket slcode-agent-plugin-export, 설계 ws docs/report/slcode-agent-plugin-survey.md "export", 착수 결정 TICKET.md).
// 기본 설정의 빌드를 하네스의 사용자 설정에 등록해 터미널에서 직접 띄운 claude·codex 에도 싣는다. 사용자 상태(~/.claude·~/.codex)에 쓰는 것은 여기뿐이고, 하네스 CLI 로만 쓴다.
//   export/claude/  Claude 디렉터리 마켓플레이스 slcode — <이름> 링크 → build/<Claude 식별자>/export/claude/<이름>. Claude 는 링크 경로에서 바로 읽으므로 리빌드는 링크만 바꾼다.
//   export/codex/   Codex 마켓플레이스 slcode — <이름> 링크 → build/<Codex 식별자>/export/codex/<이름>. Codex 는 `codex plugin add` 때 캐시에 복사본을 두므로 리빌드 때 다시 add 해 복사본을 다시 쓴다.
// export 판은 세션 빌드에 한 단계를 더한다: 지시문은 SessionStart 훅의 additionalContext 로(세션은 systemPrompt·developerInstructions 로 넘기던 것), 옮길 수 없는 것은 report.json 의 excluded 에.
// Codex 판은 경로 변수를 export 링크 경로로 바꿔 다시 빌드한다. Codex 훅 신뢰는 훅 정의 해시와 플러그인 내용 해시 둘이라(config.toml hooks.state 의 trusted_hash·
// trusted_content_hash, 0.165 실측) 내용이 바뀌는 리빌드마다 다시 묻는다 — slcode 는 신뢰 기록을 쓰지 않고, 사용자가 codex 시작 때의 훅 검토에서 Trust all 을 고른다(사용자 2026-10-31).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readManifest, resolveValues } from './agentFormat.js';
import { BUILD_FILES, buildCodex, type Report } from './agentBuild.js';
import { codexGaps, exportHookEntries, readScripts, type ScriptEntry } from './agentHooks.js';
import { ensureLauncher } from './launcher.js';
import { EXPORT_SCRIPTS_DIR } from './hookBroker.js';
import type { AgentPaths, PluginEntry } from './agentPlugins.js';

export const EXPORT_HARNESSES = ['claude', 'codex'] as const;
export type ExportHarness = (typeof EXPORT_HARNESSES)[number];
/** 두 하네스에 등록하는 마켓플레이스 이름 — 플러그인은 <이름>@slcode */
export const MARKETPLACE = 'slcode';
/** 지시문을 넣는 SessionStart 훅. Codex 는 additionalContext 한도(기본 약 2500 토큰)를 푼다 */
const INSTRUCTIONS = 'hooks/slcode-instructions.json';
const instructionsHook = (h: ExportHarness) => ({ type: 'command', command: `cat "\${CLAUDE_PLUGIN_ROOT}/${INSTRUCTIONS}"`, timeout: 5, ...(h === 'codex' ? { additionalContextLimit: 0 } : {}) });

/** export 판의 report.json — excluded 는 이 하네스 단독 실행에서 빠지거나 다르게 도는 것 */
export type ExportReport = { harness: ExportHarness; name: string; version: string; build: string; values: string; excluded: string[] };
export type ExportResult = { name: string; harness: ExportHarness; removed: boolean; build: string | null; link: string | null; excluded: string[]; notes: string[] };

export const exportLink = (ap: AgentPaths, h: ExportHarness, name: string) => path.join(ap.export, h, name);
const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };

/** js/ts 훅 (ticket slcode-agent-plugin-script-portable) — Claude 빌드의 묶은 스크립트를 export 판의 slcode-hooks/ 에 두고, 그것을 돌리는 command 항목(플러그인·이벤트마다 하나)을 hooks 에 더한다.
 *  묶은 파일은 하네스들이 같이 쓴다(Codex 판도 Claude 빌드의 것). root 가 있으면 명령의 플러그인 폴더 자리를 그 경로로 — Codex 판은 다른 경로 변수처럼 export 링크로 */
function addScriptHooks(ap: AgentPaths, cbuild: string, plugin: string, h: ExportHarness, hooks: Record<string, unknown[]>, root?: string): ScriptEntry[] {
  const scripts = readScripts(path.join(cbuild, BUILD_FILES.scripts));
  if (!scripts.length) return scripts;
  fs.cpSync(path.join(cbuild, 'scripts'), path.join(plugin, EXPORT_SCRIPTS_DIR, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(cbuild, BUILD_FILES.scripts), path.join(plugin, EXPORT_SCRIPTS_DIR, 'scripts.json'));
  const mine = exportHookEntries(scripts, h, [ensureLauncher(ap.dir)]) as Record<string, { hooks: { command: string }[] }[]>;
  if (root) for (const g of Object.values(mine).flat()) for (const c of g.hooks) c.command = c.command.replaceAll('${CLAUDE_PLUGIN_ROOT}', root.replace(/["\\$`]/g, '\\$&')); // 명령 안에서 "…" 로 감싼 자리
  for (const [ev, groups] of Object.entries(mine)) hooks[ev] = [...(hooks[ev] ?? []), ...groups];
  return scripts;
}

/** Claude 가 export 한 플러그인에 주는 데이터 폴더 — <설정 폴더>/plugins/data/<이름>-slcode (agentPlugins.claudeDataDir 의 출처만 slcode) */
function claudeExportData(name: string, env: NodeJS.ProcessEnv) {
  const config = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(config, 'plugins', 'data', `${name}-${MARKETPLACE}`.replace(/[^A-Za-z0-9_-]/g, '-'));
}

/** 그 하네스의 export 판 — build/<식별자>/export/<하네스>/{<이름>/, report.json}. 있으면 다시 쓰고, 없으면 옆에 만든 뒤 rename */
export function exportBuild(ap: AgentPaths, name: string, e: PluginEntry, h: ExportHarness, env: NodeJS.ProcessEnv): { id: string; plugin: string; report: ExportReport } {
  const id = e.builds[h];
  if (!id) throw new Error(`${name} has no ${h} build (slcode plugin add again)`);
  const bdir = path.join(ap.build, id);
  const out = path.join(bdir, 'export', h);
  const have = readJson(path.join(out, BUILD_FILES.report));
  if (have?.harness === h) return { id, plugin: path.join(out, name), report: have };
  const base: Report = readJson(path.join(bdir, BUILD_FILES.report));
  if (!base) throw new Error(`build ${id} of ${name} is missing`);
  const inst = path.join(ap.installed, name);
  const m = readManifest(inst);
  const tmp = path.join(bdir, 'export', `.tmp-${randomUUID().slice(0, 8)}`);
  const plugin = path.join(tmp, name);
  const excluded = [...base.lost, ...base.dropped];
  let instructions: string;
  let hooks: Record<string, unknown[]>;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (h === 'claude') {
      fs.cpSync(path.join(bdir, 'claude', name), plugin, { recursive: true });
      instructions = (fs.readFileSync(path.join(bdir, BUILD_FILES.instructions), 'utf8'))
        .replaceAll('${CLAUDE_PLUGIN_ROOT}', exportLink(ap, h, name)).replaceAll('${CLAUDE_PLUGIN_DATA}', claudeExportData(name, env));
      hooks = readJson(path.join(plugin, 'hooks/hooks.json'))?.hooks ?? {};
      if (fs.existsSync(path.join(bdir, BUILD_FILES.settings))) excluded.push('raw/claude/session.json: Claude settings cannot travel with a plugin');
      addScriptHooks(ap, bdir, plugin, h, hooks);
    } else {
      // 경로 변수를 export 링크·data/<이름> 으로 바꿔 다시 빌드한다 — 세션 빌드의 것은 빌드 폴더를 가리킨다
      buildCodex(inst, m, resolveValues(m, [e.values]), id, tmp, exportLink(ap, h, name), path.join(ap.data, name));
      fs.mkdirSync(path.join(ap.data, name), { recursive: true, mode: 0o700 });
      fs.renameSync(path.join(tmp, 'codex'), plugin);
      instructions = fs.readFileSync(path.join(tmp, BUILD_FILES.instructions), 'utf8');
      const ch = readJson(path.join(tmp, BUILD_FILES.codexHooks)) ?? { hooks: {}, excluded: [] };
      hooks = ch.hooks;
      // slcode 의 Codex 세션이 빼는 hooks.json 통째 대신, export 는 command 훅을 싣고 못 싣는 항목만 적는다
      excluded.splice(0, excluded.length, ...excluded.filter((x) => !x.endsWith('/hooks/hooks.json')), ...ch.excluded.filter((x: string) => !/: js\/ts hook /.test(x)));
      const cbuild = e.builds.claude ? path.join(ap.build, e.builds.claude) : null; // 묶은 스크립트는 Claude 빌드에만 있다
      const scripts = cbuild ? addScriptHooks(ap, cbuild, plugin, h, hooks, exportLink(ap, h, name)) : [];
      if (scripts.length) excluded.push(...codexGaps(scripts));
      if (fs.existsSync(path.join(plugin, 'bin'))) excluded.push('bin/: Codex does not put plugin bin/ on PATH');
      const servers = readJson(path.join(tmp, BUILD_FILES.codexMcp))?.mcpServers ?? {};
      if (Object.keys(servers).length) fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
      fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(path.join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name, version: m.version, description: `${name} (slcode agent plugin export)` }, null, 2));
    }
    if (Object.keys(m.env).length) excluded.push(`env: ${Object.keys(m.env).join(', ')} (set them in the shell that starts ${h})`);
    if (instructions.trim()) {
      fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(plugin, INSTRUCTIONS), JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: instructions.trim() } }));
      hooks = { ...hooks, SessionStart: [{ hooks: [instructionsHook(h)] }, ...(hooks.SessionStart ?? [])] };
    }
    if (Object.keys(hooks).length) { fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true }); fs.writeFileSync(path.join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks }, null, 2)); }
    const report: ExportReport = { harness: h, name, version: m.version, build: id, values: base.values, excluded };
    fs.writeFileSync(path.join(tmp, BUILD_FILES.report), JSON.stringify(report, null, 2));
    try { fs.renameSync(tmp, out); } catch { fs.rmSync(tmp, { recursive: true, force: true }); } // 동시에 둘이 만들면 먼저 놓인 것
    return { id, plugin: path.join(out, name), report: readJson(path.join(out, BUILD_FILES.report)) ?? report };
  } catch (err) { fs.rmSync(tmp, { recursive: true, force: true }); throw err; }
}

/** 마켓플레이스 파일 — names 는 그 하네스에 export 한 플러그인 (설치 순서) */
function writeMarketplace(ap: AgentPaths, h: ExportHarness, names: string[]) {
  const dir = path.join(ap.export, h);
  const [rel, body] = h === 'claude'
    ? ['.claude-plugin/marketplace.json', { name: MARKETPLACE, owner: { name: 'slcode' }, plugins: names.map((n) => ({ name: n, source: `./${n}` })) }]
    : ['.agents/plugins/marketplace.json', { name: MARKETPLACE, plugins: names.map((n) => ({ name: n, source: { source: 'local', path: `./${n}` } })) }];
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(body, null, 2));
  fs.renameSync(`${f}.tmp`, f);
}

/** 링크를 새 대상으로 — 옆에 만든 뒤 rename (Windows 는 junction) */
function relink(link: string, target: string) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const tmp = `${link}.tmp-${randomUUID().slice(0, 8)}`;
  fs.symlinkSync(target, tmp, 'junction');
  fs.renameSync(tmp, link);
}

/** 하네스 CLI — PATH 는 env 의 것. 실패면 그 출력으로 던진다 */
function cli(h: ExportHarness, args: string[], env: NodeJS.ProcessEnv): string {
  try { return execFileSync(h, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }); }
  catch (e: any) {
    if (e?.code === 'ENOENT') throw new Error(`${h} CLI not found on PATH`);
    throw new Error(`${h} ${args.join(' ')}: ${String(e?.stderr || e?.stdout || e?.message).trim().split('\n').filter((l) => !l.startsWith('WARNING:')).join(' ')}`);
  }
}

/** 등록 — 마켓플레이스 추가와 설치. 둘 다 이미 있으면 하네스가 아무것도 하지 않는다. Codex 의 add 는 캐시 복사본을 다시 쓴다 */
function register(ap: AgentPaths, h: ExportHarness, name: string, env: NodeJS.ProcessEnv) {
  const dir = path.join(ap.export, h);
  if (h === 'claude') { cli(h, ['plugin', 'marketplace', 'add', dir], env); cli(h, ['plugin', 'install', `${name}@${MARKETPLACE}`], env); }
  else { cli(h, ['plugin', 'marketplace', 'add', dir], env); cli(h, ['plugin', 'add', `${name}@${MARKETPLACE}`], env); }
}

/** export 하거나 다시 쓴다 — 판을 만들고, 링크를 걸고, 마켓플레이스에 넣고, 하네스에 등록한다. names 는 이 하네스에 export 한 플러그인(이 플러그인 포함).
 *  등록에 실패하면 링크·마켓플레이스를 되돌리고 던진다 */
export function exportTo(ap: AgentPaths, name: string, e: PluginEntry, h: ExportHarness, names: string[], env: NodeJS.ProcessEnv): ExportResult {
  const b = exportBuild(ap, name, e, h, env);
  const link = exportLink(ap, h, name);
  let prev: string | null = null;
  try { prev = fs.readlinkSync(link); } catch {}
  relink(link, b.plugin);
  writeMarketplace(ap, h, names);
  try { register(ap, h, name, env); }
  catch (err) {
    if (prev) relink(link, prev);
    else { fs.rmSync(link, { force: true }); writeMarketplace(ap, h, names.filter((n) => n !== name)); }
    throw err;
  }
  return { name, harness: h, removed: false, build: b.id, link, excluded: b.report.excluded, notes: [] };
}

/** 리빌드 뒤 — 링크를 새 판으로 바꾼다. Claude 는 그것으로 끝(열린 세션은 /reload-plugins), Codex 는 캐시 복사본을 다시 쓴다. 실패는 notes 로 (리빌드를 막지 않는다) */
export function refreshExport(ap: AgentPaths, name: string, e: PluginEntry, h: ExportHarness, env: NodeJS.ProcessEnv): ExportResult {
  const r: ExportResult = { name, harness: h, removed: false, build: null, link: exportLink(ap, h, name), excluded: [], notes: [] };
  try {
    const b = exportBuild(ap, name, e, h, env);
    relink(r.link!, b.plugin);
    Object.assign(r, { build: b.id, excluded: b.report.excluded });
    if (h === 'codex') cli(h, ['plugin', 'add', `${name}@${MARKETPLACE}`], env);
  } catch (err) { r.notes.push(`${h}: ${(err as Error).message}`); }
  return r;
}

/** 해제 — 하네스에서 지우고, 링크를 떼고, 마켓플레이스에서 뺀다. 남은 플러그인이 없으면 마켓플레이스도 지운다. names 는 해제 뒤 남는 플러그인.
 *  하네스 쪽 실패(이미 지웠음·CLI 없음)는 notes 로 — slcode 쪽은 늘 지운다 */
export function unexport(ap: AgentPaths, name: string, h: ExportHarness, names: string[], env: NodeJS.ProcessEnv): ExportResult {
  const notes: string[] = [];
  const tryCli = (args: string[]) => { try { cli(h, args, env); } catch (err) { notes.push((err as Error).message); } };
  tryCli(h === 'claude' ? ['plugin', 'uninstall', `${name}@${MARKETPLACE}`] : ['plugin', 'remove', `${name}@${MARKETPLACE}`]);
  fs.rmSync(exportLink(ap, h, name), { force: true });
  if (names.length) writeMarketplace(ap, h, names);
  else { tryCli(['plugin', 'marketplace', 'remove', MARKETPLACE]); fs.rmSync(path.join(ap.export, h), { recursive: true, force: true }); }
  return { name, harness: h, removed: true, build: null, link: null, excluded: [], notes };
}
