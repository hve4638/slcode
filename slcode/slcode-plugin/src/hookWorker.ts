// js/ts 훅 worker (ticket slcode-agent-plugin-hooks, 새 계약 slcode-agent-plugin-script-portable) — 플러그인 하나의 스크립트들을 이 worker_threads 안에서 싣고 콜백을 부른다.
// 띄우는 쪽은 hookRunner.ts — slcode core 안, 또는 export 한 Claude·Codex 의 세션 중간 프로세스(hookBroker.ts) 안.
// 기동: workerData 의 스크립트마다 import 하고, 스크립트가 `slcode/api` 의 slcode.on() 으로 등록한 콜백 목록을 ready 로 알린다(slcode.run() 뒤의 on() 은 무시·경고).
// 목록 모드(--list): 메인 스레드에서 스크립트 하나를 싣고 등록만 출력한다 — 빌드가 export 의 hooks.json 항목을 만들 때.
// 상태: 에이전트(주 에이전트 '' · 서브에이전트 id)마다 객체 하나를 같은 플러그인의 콜백들이 함께 본다(사용자 결정 2026-10-29 A). 콜백이 끝나면 저장한 값과 비교해 바뀐 키만
// core 에 보낸다 — JSON 으로 왕복하지 않는 값의 키는 보내지 않고 경고, 합쳐 1MB 를 넘으면 그 변경을 보내지 않고 경고.
// hook.exec: 새 프로세스 그룹으로 띄우고(pgid 를 core 에 알린다 — core 가 worker 를 종료할 때 그 그룹도 종료) 명령이 끝나면 그룹에 남은 것을 종료한다.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
// 형만 가져온다 — worker 는 로컬 모듈을 런타임에 싣지 않는다(이벤트·메서드 표는 core 가 workerData 로 준다). 테스트(tsx)에서 worker 에는 tsx 가 붙지 않는다
import type { ExecOptions, ExecResult, HookEvent, Method, Vars } from './hookApi.js';

/** 프로세스 그룹을 종료한다 — Windows 는 그룹이 없어 프로세스 트리로 */
export function killGroup(pid: number) {
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* 그룹이 이미 비었다 */ }
}

/** 등록 하나 — id 는 worker 안의 번호 */
export type Reg = { id: number; event: HookEvent; matcher: string | null; timeout: number; failClosed: boolean; src: string };
/** 콜백 하나가 낸 결과 */
export type Result = { block: string[]; ask: string[]; allow: string[]; input: Record<string, unknown> | null; context: string[]; message: { text: string; icon?: string; tone?: string }[]; stop: string[] };
/** core 가 보내는 이벤트 정보 — hook 객체의 정보 칸 */
export type Info = {
  event: HookEvent; session: { id: string; cwd: string; permissionMode: string | null }; agent: { id: string; type: string | null } | null; raw: unknown;
  tool?: { name: string; input: Record<string, unknown>; useId: string; response?: unknown }; prompt?: string; source?: string; trigger?: string; reason?: string;
};
export type WorkerInit = { slcodeHooks: true; scripts: { src: string; js: string }[]; states: Record<string, Record<string, unknown>>; methods: Record<HookEvent, readonly Method[]>; matchers: readonly HookEvent[]; vars: Vars };
export type ToCore =
  | { t: 'ready'; regs: Reg[]; errors: string[] }
  | { t: 'done'; id: number; ms: number; error: string | null; result: Result; agent: string; changes: Record<string, string | null>; warnings: string[] }
  | { t: 'pgid'; pid: number; on: boolean }
  | { t: 'warn'; text: string };
export type ToWorker = { t: 'call'; id: number; reg: number; info: Info } | { t: 'drop'; agent: string };

const STATE_LIMIT = 1024 * 1024;
export const DEFAULT_TIMEOUT = 10;

/** JSON 으로 왕복하지 않는 값이면 그 꼴 이름 — 객체 안의 undefined 는 키가 없는 것과 같아 받는다 */
export function notJson(v: unknown, seen = new Set<object>()): string | null {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : String(v);
  if (typeof v !== 'object') return typeof v; // undefined(배열 안)·function·bigint·symbol
  if (seen.has(v)) return 'circular reference';
  seen.add(v);
  try {
    if (Array.isArray(v)) { for (const x of v) { const w = x === undefined ? 'undefined' : notJson(x, seen); if (w) return w; } return null; }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return (v as object).constructor?.name || 'object';
    for (const x of Object.values(v)) { if (x === undefined) continue; const w = notJson(x, seen); if (w) return w; }
    return null;
  } finally { seen.delete(v); }
}

function main(init: WorkerInit, port: NonNullable<typeof parentPort>) {
  const METHODS = init.methods;
  const post = (m: ToCore) => port.postMessage(m);
  const regs: (Reg & { cb: (hook: unknown) => unknown })[] = [];
  /** 에이전트별 상태 — live 는 콜백이 보는 객체, saved 는 core 에 저장한 키별 JSON */
  const states = new Map<string, { live: Record<string, unknown>; saved: Map<string, string>; warned: Set<string> }>();
  const stateOf = (key: string) => {
    let s = states.get(key);
    if (!s) { s = { live: {}, saved: new Map(), warned: new Set() }; states.set(key, s); }
    return s;
  };
  for (const [key, obj] of Object.entries(init.states)) {
    const s = stateOf(key);
    s.live = { ...obj };
    for (const [k, v] of Object.entries(obj)) s.saved.set(k, JSON.stringify(v));
  }

  /** 콜백이 끝날 때 — 바뀐 키(JSON, 지운 키는 null)와 경고 */
  function diff(key: string): { changes: Record<string, string | null>; warnings: string[] } {
    const s = stateOf(key);
    const changes: Record<string, string | null> = {}, warnings: string[] = [];
    for (const k of new Set([...Object.keys(s.live), ...s.saved.keys()])) {
      const v = s.live[k];
      if (v === undefined) { if (s.saved.has(k)) changes[k] = null; continue; }
      const why = notJson(v);
      if (why) { if (!s.warned.has(k)) warnings.push(`state.${k} 는 ${why} 라 JSON 으로 저장할 수 없어 저장하지 않았습니다`); s.warned.add(k); continue; }
      s.warned.delete(k);
      const j = JSON.stringify(v);
      if (s.saved.get(k) !== j) changes[k] = j;
    }
    if (!Object.keys(changes).length) return { changes, warnings };
    let size = 0;
    for (const k of new Set([...s.saved.keys(), ...Object.keys(changes)])) { const j = k in changes ? changes[k] : s.saved.get(k)!; if (j !== null) size += k.length + j.length; }
    if (size > STATE_LIMIT) return { changes: {}, warnings: [...warnings, `상태가 ${Math.round(size / 1024)}KB 로 1MB 를 넘어 이번 변경을 저장하지 않았습니다`] };
    for (const [k, j] of Object.entries(changes)) { if (j === null) s.saved.delete(k); else s.saved.set(k, j); }
    return { changes, warnings };
  }

  function exec(cwd: string, cmd: string, args: string[] = [], o: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const out: Buffer[] = [], err: Buffer[] = [];
      let child;
      try {
        child = spawn(cmd, args, { cwd: o.cwd ?? cwd, env: o.env ? { ...process.env, ...o.env } : process.env, detached: process.platform !== 'win32', stdio: 'pipe', windowsHide: true });
      } catch (e) { resolve({ code: null, signal: null, stdout: '', stderr: (e as Error).message, timedOut: false }); return; }
      const pid = child.pid;
      if (pid) post({ t: 'pgid', pid, on: true });
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.stdin.on('error', () => {});
      child.stdin.end(o.input ?? undefined);
      let timedOut = false, finished = false;
      const timer = o.timeout ? setTimeout(() => { timedOut = true; if (pid) killGroup(pid); }, o.timeout * 1000) : null;
      const settle = (code: number | null, signal: string | null) => {
        resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
      };
      const finish = (code: number | null, signal: string | null) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (pid) { killGroup(pid); post({ t: 'pgid', pid, on: false }); }
        // 출력 끝이 아니라 프로세스 종료 기준 — 그룹을 종료한 뒤 남은 출력만 잠깐 받는다. 그룹 밖(setsid)의 자식이 파이프를 쥐어도 기다리지 않는다
        const cap = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); settle(code, signal); }, 50);
        child.once('close', () => { clearTimeout(cap); settle(code, signal); });
      };
      child.on('exit', finish);
      child.on('error', (e: Error) => { err.push(Buffer.from(e.message)); finish(null, null); });
    });
  }

  function makeHook(info: Info, reg: Reg, result: Result, ctl: { done: boolean }, warnings: string[]) {
    const allowed = new Set<Method>(METHODS[info.event]);
    const key = info.agent?.id ?? '';
    const hook: Record<string, unknown> = { event: info.event, session: info.session, agent: info.agent, raw: info.raw, exec: (cmd: string, args?: string[], o?: ExecOptions) => exec(info.session.cwd, cmd, args, o) };
    for (const k of ['tool', 'prompt', 'source', 'trigger', 'reason'] as const) if (info[k] !== undefined) hook[k] = info[k];
    Object.defineProperty(hook, 'state', {
      enumerable: true,
      get: () => stateOf(key).live,
      set: (v: unknown) => {
        if (v && typeof v === 'object' && !Array.isArray(v)) stateOf(key).live = v as Record<string, unknown>;
        else warnings.push('hook.state 에는 객체만 넣을 수 있어 무시했습니다');
      },
    });
    const method = (m: Method, apply: (arg: unknown, arg2?: unknown) => void) => (arg: unknown, arg2?: unknown) => {
      if (ctl.done) post({ t: 'warn', text: `${reg.src}: ${info.event} 콜백이 끝난 뒤 hook.${m}() 을 불러 무시했습니다` });
      else if (!allowed.has(m)) warnings.push(`hook.${m}() 은 ${info.event} 에서 쓸 수 없어 무시했습니다`);
      else apply(arg, arg2);
      return hook;
    };
    const text = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    hook.block = method('block', (r) => result.block.push(text(r)));
    hook.ask = method('ask', (r) => result.ask.push(text(r)));
    hook.allow = method('allow', (r) => result.allow.push(text(r)));
    hook.context = method('context', (t) => result.context.push(text(t)));
    // look 의 icon·tone 은 문자열만 넘긴다 — 목록 검사는 core(hookRunner.merge)가 한다
    hook.message = method('message', (t, look) => {
      const l = (look && typeof look === 'object' ? look : {}) as Record<string, unknown>;
      result.message.push({ text: text(t), ...(typeof l.icon === 'string' ? { icon: l.icon } : {}), ...(typeof l.tone === 'string' ? { tone: l.tone } : {}) });
    });
    hook.stop = method('stop', (r) => result.stop.push(text(r)));
    hook.updateInput = method('updateInput', (i) => {
      if (i && typeof i === 'object' && !Array.isArray(i)) result.input = i as Record<string, unknown>;
      else warnings.push('hook.updateInput() 에는 객체를 넘겨야 해 무시했습니다');
    });
    return hook;
  }

  async function call(id: number, reg: (typeof regs)[number], info: Info) {
    const result: Result = { block: [], ask: [], allow: [], input: null, context: [], message: [], stop: [] };
    const ctl = { done: false }, warnings: string[] = [];
    const t0 = performance.now();
    let error: string | null = null;
    try { await reg.cb(makeHook(info, reg, result, ctl, warnings)); }
    catch (e) { error = e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 4).join('\n') : String(e); }
    ctl.done = true;
    const key = info.agent?.id ?? '';
    const d = diff(key);
    post({ t: 'done', id, ms: Math.round((performance.now() - t0) * 10) / 10, error, result, agent: key, changes: d.changes, warnings: [...warnings, ...d.warnings] });
  }

  port.on('message', (m: ToWorker) => {
    if (m.t === 'drop') { states.delete(m.agent); return; }
    const reg = regs[m.reg];
    if (reg) void call(m.id, reg, m.info);
  });

  void (async () => {
    const errors: string[] = [];
    for (const s of init.scripts) {
      const l = await loadScript(s.js, init.vars, (ev) => post({ t: 'warn', text: `${s.src}: 등록이 끝난 뒤(slcode.run() 뒤)의 slcode.on(${ev}) 은 무시했습니다` }));
      if (l.error) { errors.push(`${s.src}: ${l.error}`); continue; } // 실패한 스크립트의 등록은 버린다
      const c = checkRegs(l.regs, METHODS, init.matchers);
      errors.push(...[...l.warnings, ...c.errors].map((e) => `${s.src}: ${e}`));
      for (const r of c.regs) regs.push({ ...r, id: regs.length, src: s.src });
    }
    post({ t: 'ready', regs: regs.map(({ cb: _c, ...r }) => r), errors });
  })();
}

/** hookScript.ts 의 COLLECT 와 같은 이름 — worker 는 로컬 모듈을 런타임에 싣지 않는다 */
const COLLECT = Symbol.for('slcode.hooks.collect');
/** slcode.on() 한 번 — 검사 전 */
export type RawReg = { event: string; opts: Record<string, unknown>; cb: unknown };

/** 스크립트 하나를 싣고 slcode.on() 등록을 모은다 — 싣는 중에 던지거나 옛 꼴(default 함수)이면 error. 등록 끝(import 가 끝나거나 slcode.run())
 *  뒤의 on() 은 late 로 알린다. 수집기는 묶인 slcode/api 사본이 평가될 때 잡으므로 import 가 끝나면 치운다 */
export async function loadScript(js: string, vars: Vars, late: (event: string) => void): Promise<{ regs: RawReg[]; error: string | null; warnings: string[] }> {
  const regs: RawReg[] = [];
  let open = true, ran = false;
  (globalThis as Record<symbol, unknown>)[COLLECT] = {
    on(event: unknown, a: unknown, b?: unknown) {
      if (!open) { late(String(event)); return; }
      const [opts, cb] = (typeof a === 'function' ? [{}, a] : [a ?? {}, b]) as [Record<string, unknown>, unknown];
      regs.push({ event: String(event), opts: opts && typeof opts === 'object' ? opts : {}, cb });
    },
    run() { ran = true; open = false; },
    vars,
  };
  let mod: Record<string, unknown>;
  try { mod = await import(pathToFileURL(js).href); }
  catch (e) { return { regs: [], error: (e as Error)?.message ?? String(e), warnings: [] }; }
  finally { open = false; delete (globalThis as Record<symbol, unknown>)[COLLECT]; }
  if (!regs.length && typeof mod.default === 'function') return { regs: [], error: "default export 함수 꼴은 더 받지 않습니다 — import { slcode } from 'slcode/api' 로 slcode.on() 을 등록하고 slcode.run() 을 부르세요", warnings: [] };
  return { regs, error: null, warnings: ran ? [] : ['slcode.run() 을 부르지 않았습니다 — 등록은 받았습니다'] };
}

/** 등록을 검사해 Reg 꼴로 — 모르는 이벤트·함수가 아닌 콜백은 빼고 사유. id·src 는 부르는 쪽이 채운다 */
export function checkRegs(raw: RawReg[], methods: Record<HookEvent, readonly Method[]>, matchers: readonly HookEvent[]): { regs: (Omit<Reg, 'id' | 'src'> & { cb: (hook: unknown) => unknown })[]; errors: string[] } {
  const events = Object.keys(methods) as HookEvent[];
  const regs: (Omit<Reg, 'id' | 'src'> & { cb: (hook: unknown) => unknown })[] = [], errors: string[] = [];
  for (const { event, opts, cb } of raw) {
    if (!events.includes(event as HookEvent)) { errors.push(`on(${event}) — 모르는 이벤트 (${events.join(', ')})`); continue; }
    if (typeof cb !== 'function') { errors.push(`on(${event}) — 콜백이 함수가 아닙니다`); continue; }
    const ev = event as HookEvent;
    const timeout = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : DEFAULT_TIMEOUT;
    const failClosed = opts.failClosed === true;
    if (failClosed && !methods[ev].includes('block')) errors.push(`on(${ev}) — failClosed 는 block 이 있는 이벤트에서만 뜻이 있습니다`);
    let matcher = typeof opts.matcher === 'string' && opts.matcher ? opts.matcher : null;
    if (matcher && !matchers.includes(ev)) { errors.push(`on(${ev}) — ${ev} 는 matcher 를 보지 않습니다 (matcher 를 무시합니다)`); matcher = null; }
    regs.push({ event: ev, matcher, timeout, failClosed, cb: cb as (h: unknown) => unknown });
  }
  return { regs, errors };
}

/** 목록 모드 — `node hookWorker.js --list <묶은 스크립트> <harness>` 가 그 하네스의 slcode.vars 로 실어 등록(event·matcher·timeout·failClosed, 검사 전)을 JSON 한 줄로 낸다. 빌드가 export 의 hooks.json 을 만들 때 */
async function list(js: string, harness: Vars['harness']) {
  const l = await loadScript(js, { harness }, () => {});
  const regs = l.regs.map(({ event, opts, cb }) => ({ event, opts: { matcher: opts.matcher, timeout: opts.timeout, failClosed: opts.failClosed }, cb: typeof cb === 'function' ? 'function' : typeof cb }));
  process.stdout.write(`${JSON.stringify({ regs, error: l.error, warnings: l.warnings })}\n`);
  process.exit(0); // 스크립트가 띄운 타이머 등을 기다리지 않는다
}
if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--list' && process.argv[3] && (process.argv[4] === 'claude' || process.argv[4] === 'codex')) void list(process.argv[3], process.argv[4]);

if (!isMainThread && parentPort && (workerData as WorkerInit | undefined)?.slcodeHooks) main(workerData as WorkerInit, parentPort);
