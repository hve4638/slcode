// 에이전트 플러그인 part 의 hooks/hooks.json (slcode 형식) 빌드 (ticket slcode-agent-plugin-hooks, 착수 결정 TICKET.md).
// 형식: { "hooks": [ 항목… ] } — 줄 하나가 항목 하나. Claude 형식(객체)은 깨진 파일로 본다(그대로 넘기려면 raw/claude/hooks/hooks.json).
//   { "type": "script", "file": "<part 기준 경로>" }  — js/ts. esbuild 로 js 하나로 묶어 build/<식별자>/scripts/ 에 두고 scripts.json 에 적는다. 이벤트는 스크립트가 slcode.on() 으로 등록한다
//   { "type": "command", "event": "...", "matcher"?, "command": "...", "compat": "claude", ...Claude 의 command 칸 }  — Claude 형식으로 바꿔 Claude 가 실행한다.
//     문자열 칸의 ${slcode.vars.harness} 는 빌드하는 하네스 이름(claude|codex)으로 바꾼다 — 훅이 하네스를 가려야 할 때 쓴다 (ticket slcode-agent-plugin-export)
// 묶기(esbuild 는 처음 필요할 때 받는다 — esbuild.ts): 전체 TS 문법·타입 검사 없음·source map(inline). `slcode/api` 는 hookScript.ts 로 바꿔 함께 묶는다(alias — 묶은 파일 하나를 slcode 세션·export 한 Claude·Codex 가 같이 쓴다).
// 그 밖의 import 는 node 내장·상대 경로만 — 그 밖은 그 스크립트만 빼고 사유를 남긴다(빌드 에러로 플러그인을 막지 않는다).
// 등록 목록: 묶은 뒤 목록 모드(hookWorker --list, 따로 띄운 node)로 한 번 실어 slcode.on() 등록을 scripts.json 에 적는다 — export 가 hooks.json 항목을 만든다.
// 싣다가 던지거나 옛 꼴(default 함수)이면 그 스크립트도 뺀다.
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEsbuild, type Esbuild } from './esbuild.js';
import { MATCHER_EVENTS, METHODS } from './hookApi.js';
import { checkRegs, type RawReg } from './hookWorker.js';

/** 스크립트의 등록 하나 — 목록 모드가 본 것(콜백은 빼고) */
export type ListedReg = { event: string; matcher: string | null; timeout: number; failClosed: boolean };
/** 빌드 폴더의 스크립트 목록 — src 는 "<part>/<file>", js 는 빌드 폴더 기준 경로, regs 는 하네스별 등록 목록(스크립트가 slcode.vars.harness 로 등록을 바꿀 수 있다) */
export type ListHarness = 'claude' | 'codex';
export type ScriptEntry = { src: string; js: string; regs?: Partial<Record<ListHarness, ListedReg[]>> };

// 테스트(tsx)는 .ts 를, 빌드(dist)는 .js 를 — hookRunner 의 WORKER_URL 과 같은 규칙
const EXT = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const API_FILE = fileURLToPath(new URL(`./hookScript${EXT}`, import.meta.url));
const WORKER_FILE = fileURLToPath(new URL(`./hookWorker${EXT}`, import.meta.url));
/** 목록 모드가 스크립트를 싣고 등록을 마칠 때까지 */
const LIST_MS = 10_000;
/** missing 은 esbuild 를 받지 못해 스크립트를 묶지 못한 사유 — 빌드는 그것만 빼고 만들고, 다음 빌드 때 다시 받아 본다 */
export type PartHooks = { claude: Record<string, unknown[]>; dropped: string[]; failed: string[]; warnings: string[]; missing: string | null };

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 빌드가 command 문자열에 넣는 하네스 — `${slcode.vars.harness}` 의 값 (js/ts 는 slcode.vars.harness) */
export type HookHarness = 'claude' | 'codex';
/** Codex 0.165 가 받는 훅 이벤트 (Codex 문서 hooks.md) — 그 밖의 command 항목은 Codex export 에서 뺀다 */
export const CODEX_EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt']);

/** command 항목 하나 → { event, Claude 형식 묶음 }. 틀리면 사유. 문자열 칸의 ${slcode.vars.harness} 는 그 하네스 이름으로 바꾼다 */
export function commandGroup(e: Record<string, any>, harness: HookHarness): { event: string; group: Record<string, unknown> } | string {
  const { type: _t, event, matcher, compat, ...rest } = e;
  if (compat !== 'claude') return 'compat must be "claude"';
  if (typeof event !== 'string' || !event || typeof rest.command !== 'string') return 'command needs event and command';
  if (matcher !== undefined && typeof matcher !== 'string') return 'matcher must be a string';
  const vars = (v: unknown): unknown => typeof v === 'string' ? v.replaceAll('${slcode.vars.harness}', harness) : Array.isArray(v) ? v.map(vars) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, vars(x)])) : v;
  return { event, group: { ...(matcher !== undefined ? { matcher } : {}), hooks: [{ type: 'command', ...(vars(rest) as object) }] } };
}

/** part 하나의 hooks.json 에서 command 항목만 그 하네스의 Claude 형식으로 — events 에 없는 이벤트와 script 항목은 excluded 에. 목록이 아니면 null */
export function partCommandHooks(j: unknown, part: string, harness: HookHarness, events: Set<string>): { hooks: Record<string, unknown[]>; excluded: string[] } | null {
  if (!isObj(j) || !Array.isArray(j.hooks)) return null;
  const r = { hooks: {} as Record<string, unknown[]>, excluded: [] as string[] };
  j.hooks.forEach((e: unknown, i: number) => {
    const where = `${part}/hooks/hooks.json [${i}]`;
    if (!isObj(e)) { r.excluded.push(`${where}: not an object`); return; }
    if (e.type === 'script') { r.excluded.push(`${where}: js/ts hook ${e.file}`); return; }
    if (e.type !== 'command') { r.excluded.push(`${where}: type must be "script" or "command"`); return; }
    const c = commandGroup(e, harness);
    if (typeof c === 'string') { r.excluded.push(`${where}: ${c}`); return; }
    if (!events.has(c.event)) { r.excluded.push(`${where}: no ${c.event} event`); return; }
    (r.hooks[c.event] ??= []).push(c.group);
  });
  return r;
}

/** part 하나의 hooks.json 내용 j — 목록이 아니면 null(파일째 뺀다). script 는 out 아래에 묶어 scripts 에 더한다. tools 는 esbuild 캐시 폴더 */
export function buildPartHooks(pdir: string, part: string, j: unknown, out: string, scripts: ScriptEntry[], harness: HookHarness = 'claude', tools = ''): PartHooks | null {
  if (!isObj(j) || !Array.isArray(j.hooks)) return null;
  const r: PartHooks = { claude: {}, dropped: [], failed: [], warnings: [], missing: null };
  j.hooks.forEach((e: unknown, i: number) => {
    const where = `${part}/hooks/hooks.json [${i}]`;
    if (!isObj(e)) { r.dropped.push(`${where}: not an object`); return; }
    if (e.type === 'command') {
      const c = commandGroup(e, harness);
      if (typeof c === 'string') { r.dropped.push(`${where}: ${c}`); return; }
      (r.claude[c.event] ??= []).push(c.group);
      return;
    }
    if (e.type !== 'script') { r.dropped.push(`${where}: type must be "script" or "command"`); return; }
    if (typeof e.file !== 'string' || !e.file) { r.dropped.push(`${where}: script needs file`); return; }
    const abs = path.resolve(pdir, e.file);
    const src = `${part}/${path.relative(pdir, abs).split(path.sep).join('/')}`;
    if (path.relative(pdir, abs).startsWith('..') || path.isAbsolute(path.relative(pdir, abs))) { r.dropped.push(`${where}: file must be inside the part`); return; }
    if (scripts.some((s) => s.src === src)) { r.dropped.push(`${where}: ${src} is already listed`); return; } // 두 번 실으면 콜백이 두 번 등록된다
    const js = `scripts/${scripts.length}.mjs`;
    let esbuild;
    try { esbuild = loadEsbuild(tools); } catch (e) { r.missing = (e as Error).message; r.failed.push(`${src}: ${r.missing}`); return; }
    const err = bundle(esbuild, pdir, abs, path.join(out, js));
    if (err) { r.failed.push(`${src}: ${err}`); return; }
    const ls = { claude: listScript(path.join(out, js), 'claude'), codex: listScript(path.join(out, js), 'codex') };
    const error = ls.claude.error ?? ls.codex.error;
    if (error) { fs.rmSync(path.join(out, js), { force: true }); r.failed.push(`${src}: ${error}`); return; }
    r.warnings.push(...[...new Set([...ls.claude.warnings, ...ls.codex.warnings])].map((w) => `${src}: ${w}`));
    scripts.push({ src, js, regs: { claude: ls.claude.regs, codex: ls.codex.regs } });
  });
  return r;
}

/** 스크립트 하나를 묶는다 — 실패면 사유 */
function bundle(esbuild: Esbuild, pdir: string, entry: string, outfile: string): string | null {
  try {
    const res = esbuild.buildSync({
      entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      packages: 'external', sourcemap: 'inline', metafile: true, logLevel: 'silent', absWorkingDir: pdir, alias: { 'slcode/api': API_FILE },
    });
    const bad = [...new Set(Object.values(res.metafile.outputs).flatMap((o) => o.imports).filter((i) => i.external && !isBuiltin(i.path)).map((i) => i.path))];
    if (bad.length) { fs.rmSync(outfile, { force: true }); return `only node built-ins and relative imports: ${bad.join(', ')}`; }
    return null;
  } catch (e: any) {
    fs.rmSync(outfile, { force: true });
    return Array.isArray(e?.errors) && e.errors.length ? e.errors.map((x: any) => `${x.text}${x.location ? ` (${x.location.file}:${x.location.line})` : ''}`).join('; ') : String(e?.message ?? e);
  }
}

/** 묶은 스크립트를 따로 띄운 node 에서 한 번 실어 등록 목록을 받는다 — 싣다가 던지거나 옛 꼴이면 error, 잘못된 등록·slcode.run() 이 없는 것은 warnings */
export function listScript(file: string, harness: ListHarness): { regs: ListedReg[]; error: string | null; warnings: string[] } {
  const p = spawnSync(process.execPath, [WORKER_FILE, '--list', file, harness], { encoding: 'utf8', timeout: LIST_MS, cwd: path.dirname(file), windowsHide: true });
  let j: { regs: (RawReg & { cb: string })[]; error: string | null; warnings: string[] };
  try { j = JSON.parse(p.stdout.trim().split('\n').pop()!); }
  catch { return { regs: [], error: p.error ? `could not list registrations: ${p.error.message}` : `could not list registrations: ${(p.stderr || '').trim().split('\n').slice(-3).join(' ') || `exit ${p.status}`}`, warnings: [] }; }
  if (j.error) return { regs: [], error: j.error, warnings: [] };
  const c = checkRegs(j.regs.map((x) => ({ ...x, cb: x.cb === 'function' ? () => {} : x.cb })), METHODS, MATCHER_EVENTS);
  return { regs: c.regs.map(({ event, matcher, timeout, failClosed }) => ({ event, matcher, timeout, failClosed })), error: null, warnings: [...j.warnings, ...c.errors] }; // 잘못된 등록은 worker 처럼 그것만 뺀다
}

/** 빌드 폴더의 scripts.json — 없거나 깨졌으면 [] */
export function readScripts(file: string): ScriptEntry[] {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j.filter((s) => typeof s?.src === 'string' && typeof s?.js === 'string') : []; } catch { return []; }
}

const SIMPLE = /^[A-Za-z0-9_|]+$/;

/** 등록들의 matcher 를 하나로 — 하나라도 전부면 null. 이름 목록끼리는 잇고, 정규식이 섞이면 정규식 하나로. 넓게 맞춰도 중간 프로세스가 등록마다 다시 거른다 */
export function unionMatcher(matchers: (string | null)[]): string | null {
  if (matchers.some((m) => !m || m === '*')) return null;
  const ms = [...new Set(matchers as string[])];
  if (ms.every((m) => SIMPLE.test(m))) return [...new Set(ms.flatMap((m) => m.split('|')).filter(Boolean))].join('|');
  return ms.map((m) => (SIMPLE.test(m) ? `^(?:${m})$` : `(?:${m})`)).join('|');
}

/** 이 사본의 node·hookMain.js 절대 경로 — 고정 런처(launcher.ts)가 가리키는 곳. PATH 의 `slcode` 는 쓰지 않는다: 터미널의 .bashrc 가
 *  ~/.local/bin 을 앞에 붙이면 옛 slcode 로 가 훅이 실패했다(ticket slcode-session-path-rc-override, 사용자 2026-10-31) */
export function hookLaunch(): string[] {
  return [process.execPath, path.join(path.dirname(WORKER_FILE), `hookMain${EXT}`)];
}

/** export 한 플러그인의 hooks.json 내용(Claude 객체 꼴 — Codex 도 같은 꼴). 이벤트마다 command 하나(플러그인의 스크립트를 모두 중간 프로세스가 돌린다).
 *  launch 는 훅 명령 앞부분(상태 폴더의 고정 런처 — launcher.ts). 플러그인 폴더는 변수로 둔다 — 빌드가 바뀌어도 명령 문자열은 같다. Codex 는 그래도 플러그인 내용이 바뀌면 신뢰를 다시 묻는다(사용자가 훅 검토 화면에서 신뢰, 사용자 결정 2026-10-31).
 *  SessionEnd 는 등록이 없어도 넣는다 — 중간 프로세스를 끝낸다. timeout 은 그 이벤트 콜백 timeout 의 최대 + 중간 프로세스를 띄우는 시간 */
export function exportHookEntries(scripts: ScriptEntry[], harness: 'claude' | 'codex', launch: string[]): Record<string, unknown[]> {
  const q = (s: string) => (/^[A-Za-z0-9_./-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, '\\$1')}"`);
  const regs = scripts.flatMap((s) => s.regs?.[harness] ?? []);
  const events = [...new Set([...regs.map((r) => r.event), 'SessionEnd'])];
  const out: Record<string, unknown[]> = {};
  for (const ev of events) {
    const mine = regs.filter((r) => r.event === ev);
    const matcher = (MATCHER_EVENTS as readonly string[]).includes(ev) && mine.length ? unionMatcher(mine.map((r) => r.matcher)) : null;
    let timeout = Math.ceil(Math.max(0, ...mine.map((r) => r.timeout))) + 5;
    if (ev === 'SessionEnd' && harness === 'codex') timeout = 3; // Codex 는 SessionEnd 를 3초까지만
    const command = `${launch.map(q).join(' ')} ${harness} "\${CLAUDE_PLUGIN_ROOT}" ${ev}`; // Claude 는 그 자리에서 바꾸고, Codex 는 같은 이름의 env 를 셸이 편다
    out[ev] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout }] }];
  }
  return out;
}

/** Codex 에 없는 Claude 도구 — 이 이름만 맞추는 matcher 는 Codex 에서 돌지 않는다 (Codex hooks 문서·0.165) */
const CLAUDE_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'ExitPlanMode', 'BashOutput', 'KillShell', 'Task'];

/** Codex export 의 report.json 에 적을 메울 수 없는 차이 — 스크립트의 등록을 본다 */
export function codexGaps(scripts: ScriptEntry[]): string[] {
  const out: string[] = [];
  for (const s of scripts) for (const r of s.regs?.codex ?? []) {
    if (r.event !== 'PreToolUse' && r.event !== 'PostToolUse') continue;
    if (!r.matcher || !SIMPLE.test(r.matcher)) continue; // 정규식은 판단하지 않는다
    const names = r.matcher.split('|');
    const gone = names.filter((n) => CLAUDE_ONLY_TOOLS.includes(n));
    if (gone.length) out.push(`${s.src}: ${r.event} ${r.matcher} — Codex 에는 ${gone.join('·')} 도구가 없습니다${gone.length === names.length ? ' (이 콜백은 Codex 에서 돌지 않습니다)' : ''}`);
    if (names.some((n) => n === 'Edit' || n === 'Write')) out.push(`${s.src}: ${r.event} ${r.matcher} — Codex 의 파일 편집은 apply_patch 로 오고 tool.input 은 { command: 패치 텍스트 } 입니다`);
  }
  out.push('Codex: PreToolUse 의 ask()·stop(), SubagentStart 의 stop() 은 받지 않아 빼고 알립니다');
  return out;
}
