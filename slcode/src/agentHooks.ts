// 에이전트 플러그인 part 의 hooks/hooks.json (slcode 형식) 빌드 (ticket slcode-agent-plugin-hooks, 착수 결정 TICKET.md).
// 형식: { "hooks": [ 항목… ] } — 줄 하나가 항목 하나. Claude 형식(객체)은 깨진 파일로 본다(그대로 넘기려면 raw/claude/hooks/hooks.json).
//   { "type": "script", "file": "<part 기준 경로>" }  — js/ts. esbuild 로 js 하나로 묶어 build/<식별자>/scripts/ 에 두고 scripts.json 에 적는다. 이벤트는 스크립트가 on() 으로 등록한다
//   { "type": "command", "event": "...", "matcher"?, "command": "...", "compat": "claude", ...Claude 의 command 칸 }  — Claude 형식으로 바꿔 Claude 가 실행한다.
//     문자열 칸의 ${slcode.vars.harness} 는 빌드하는 하네스 이름(claude|codex)으로 바꾼다 — 훅이 하네스를 가려야 할 때 쓴다 (ticket slcode-agent-plugin-export)
// 묶기: 전체 TS 문법·타입 검사 없음·source map(inline). import 는 node 내장·상대 경로만 — 그 밖은 그 스크립트만 빼고 사유를 남긴다(빌드 에러로 플러그인을 막지 않는다).
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { buildSync } from 'esbuild';

/** 빌드 폴더의 스크립트 목록 — src 는 "<part>/<file>", js 는 빌드 폴더 기준 경로 */
export type ScriptEntry = { src: string; js: string };
export type PartHooks = { claude: Record<string, unknown[]>; dropped: string[]; failed: string[] };

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

/** part 하나의 hooks.json 내용 j — 목록이 아니면 null(파일째 뺀다). script 는 out 아래에 묶어 scripts 에 더한다 */
export function buildPartHooks(pdir: string, part: string, j: unknown, out: string, scripts: ScriptEntry[], harness: HookHarness = 'claude'): PartHooks | null {
  if (!isObj(j) || !Array.isArray(j.hooks)) return null;
  const r: PartHooks = { claude: {}, dropped: [], failed: [] };
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
    const err = bundle(pdir, abs, path.join(out, js));
    if (err) { r.failed.push(`${src}: ${err}`); return; }
    scripts.push({ src, js });
  });
  return r;
}

/** 스크립트 하나를 묶는다 — 실패면 사유 */
function bundle(pdir: string, entry: string, outfile: string): string | null {
  try {
    const res = buildSync({
      entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
      packages: 'external', sourcemap: 'inline', metafile: true, logLevel: 'silent', absWorkingDir: pdir,
    });
    const bad = [...new Set(Object.values(res.metafile.outputs).flatMap((o) => o.imports).filter((i) => i.external && !isBuiltin(i.path)).map((i) => i.path))];
    if (bad.length) { fs.rmSync(outfile, { force: true }); return `only node built-ins and relative imports: ${bad.join(', ')}`; }
    return null;
  } catch (e: any) {
    fs.rmSync(outfile, { force: true });
    return Array.isArray(e?.errors) && e.errors.length ? e.errors.map((x: any) => `${x.text}${x.location ? ` (${x.location.file}:${x.location.line})` : ''}`).join('; ') : String(e?.message ?? e);
  }
}

/** 빌드 폴더의 scripts.json — 없거나 깨졌으면 [] */
export function readScripts(file: string): ScriptEntry[] {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j.filter((s) => typeof s?.src === 'string' && typeof s?.js === 'string') : []; } catch { return []; }
}
