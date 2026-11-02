// js/ts 훅 worker (ticket slcode-agent-plugin-hooks, 새 계약 slcode-agent-plugin-script-portable) — 플러그인 하나의 스크립트들을 이 worker_threads 안에서 싣고 콜백을 부른다.
// 띄우는 쪽은 hookRunner.ts — slcode core 안, 또는 export 한 Claude·Codex 의 세션 중간 프로세스(hookBroker.ts) 안.
// 기동: workerData 의 스크립트마다 import 하고, 스크립트가 `slcode/api` 의 slcode.on() 으로 등록한 콜백 목록을 ready 로 알린다(slcode.run() 뒤의 on() 은 무시·경고).
// 목록 모드(--list): 메인 스레드에서 스크립트 하나를 싣고 등록만 출력한다 — 빌드가 export 의 hooks.json 항목을 만들 때.
// 상태: 에이전트(주 에이전트 '' · 서브에이전트 id)마다 객체 하나를 같은 플러그인의 콜백들이 함께 본다(사용자 결정 2026-10-29 A). 콜백이 끝나면 저장한 값과 비교해 바뀐 키만
// core 에 보낸다 — JSON 으로 왕복하지 않는 값의 키는 보내지 않고 경고, 합쳐 1MB 를 넘으면 그 변경을 보내지 않고 경고.
// hook.exec: 새 프로세스 그룹으로 띄우고(pgid 를 core 에 알린다 — core 가 worker 를 종료할 때 그 그룹도 종료) 명령이 끝나면 그룹에 남은 것을 종료한다.
// 명령(ticket slcode-agent-plugin-command): 같은 worker 가 COMMAND 파일도 싣고 run 을 부른다 — 상태는 주 에이전트의 것을 훅과 함께 보고, run 이 성공했을 때만 바뀐 키를 보낸다(던지면 되돌린다).
// complete 는 role 'complete' 로 따로 띄운 worker 가 COMMAND 파일만 싣고 부른다 — core 가 준 저장된 상태의 얼린 사본을 본다. 오래 걸리면 core 가 그 worker 만 내린다.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
/** 프로세스 그룹을 종료한다 — Windows 는 그룹이 없어 프로세스 트리로 */
export function killGroup(pid) {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
    }
    try {
        process.kill(-pid, 'SIGKILL');
    }
    catch { /* 그룹이 이미 비었다 */ }
}
const STATE_LIMIT = 1024 * 1024;
export const DEFAULT_TIMEOUT = 10;
/** JSON 으로 왕복하지 않는 값이면 그 꼴 이름 — 객체 안의 undefined 는 키가 없는 것과 같아 받는다 */
export function notJson(v, seen = new Set()) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean')
        return null;
    if (typeof v === 'number')
        return Number.isFinite(v) ? null : String(v);
    if (typeof v !== 'object')
        return typeof v; // undefined(배열 안)·function·bigint·symbol
    if (seen.has(v))
        return 'circular reference';
    seen.add(v);
    try {
        if (Array.isArray(v)) {
            for (const x of v) {
                const w = x === undefined ? 'undefined' : notJson(x, seen);
                if (w)
                    return w;
            }
            return null;
        }
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null)
            return v.constructor?.name || 'object';
        for (const x of Object.values(v)) {
            if (x === undefined)
                continue;
            const w = notJson(x, seen);
            if (w)
                return w;
        }
        return null;
    }
    finally {
        seen.delete(v);
    }
}
function main(init, port) {
    const METHODS = init.methods;
    const post = (m) => port.postMessage(m);
    const regs = [];
    /** 에이전트별 상태 — live 는 콜백이 보는 객체, saved 는 core 에 저장한 키별 JSON */
    const states = new Map();
    const stateOf = (key) => {
        let s = states.get(key);
        if (!s) {
            s = { live: {}, saved: new Map(), warned: new Set() };
            states.set(key, s);
        }
        return s;
    };
    for (const [key, obj] of Object.entries(init.states)) {
        const s = stateOf(key);
        s.live = { ...obj };
        for (const [k, v] of Object.entries(obj))
            s.saved.set(k, JSON.stringify(v));
    }
    /** 콜백이 끝날 때 — 바뀐 키(JSON, 지운 키는 null)와 경고 */
    function diff(key) {
        const s = stateOf(key);
        const changes = {}, warnings = [];
        for (const k of new Set([...Object.keys(s.live), ...s.saved.keys()])) {
            const v = s.live[k];
            if (v === undefined) {
                if (s.saved.has(k))
                    changes[k] = null;
                continue;
            }
            const why = notJson(v);
            if (why) {
                if (!s.warned.has(k))
                    warnings.push(`state.${k} 는 ${why} 라 JSON 으로 저장할 수 없어 저장하지 않았습니다`);
                s.warned.add(k);
                continue;
            }
            s.warned.delete(k);
            const j = JSON.stringify(v);
            if (s.saved.get(k) !== j)
                changes[k] = j;
        }
        if (!Object.keys(changes).length)
            return { changes, warnings };
        let size = 0;
        for (const k of new Set([...s.saved.keys(), ...Object.keys(changes)])) {
            const j = k in changes ? changes[k] : s.saved.get(k);
            if (j !== null)
                size += k.length + j.length;
        }
        if (size > STATE_LIMIT)
            return { changes: {}, warnings: [...warnings, `상태가 ${Math.round(size / 1024)}KB 로 1MB 를 넘어 이번 변경을 저장하지 않았습니다`] };
        for (const [k, j] of Object.entries(changes)) {
            if (j === null)
                s.saved.delete(k);
            else
                s.saved.set(k, j);
        }
        return { changes, warnings };
    }
    function exec(cwd, cmd, args = [], o = {}) {
        return new Promise((resolve) => {
            const out = [], err = [];
            let child;
            try {
                child = spawn(cmd, args, { cwd: o.cwd ?? cwd, env: o.env ? { ...process.env, ...o.env } : process.env, detached: process.platform !== 'win32', stdio: 'pipe', windowsHide: true });
            }
            catch (e) {
                resolve({ code: null, signal: null, stdout: '', stderr: e.message, timedOut: false });
                return;
            }
            const pid = child.pid;
            if (pid)
                post({ t: 'pgid', pid, on: true });
            child.stdout.on('data', (d) => out.push(d));
            child.stderr.on('data', (d) => err.push(d));
            child.stdin.on('error', () => { });
            child.stdin.end(o.input ?? undefined);
            let timedOut = false, finished = false;
            const timer = o.timeout ? setTimeout(() => { timedOut = true; if (pid)
                killGroup(pid); }, o.timeout * 1000) : null;
            const settle = (code, signal) => {
                resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
            };
            const finish = (code, signal) => {
                if (finished)
                    return;
                finished = true;
                if (timer)
                    clearTimeout(timer);
                if (pid) {
                    killGroup(pid);
                    post({ t: 'pgid', pid, on: false });
                }
                // 출력 끝이 아니라 프로세스 종료 기준 — 그룹을 종료한 뒤 남은 출력만 잠깐 받는다. 그룹 밖(setsid)의 자식이 파이프를 쥐어도 기다리지 않는다
                const cap = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); settle(code, signal); }, 50);
                child.once('close', () => { clearTimeout(cap); settle(code, signal); });
            };
            child.on('exit', finish);
            child.on('error', (e) => { err.push(Buffer.from(e.message)); finish(null, null); });
        });
    }
    function makeHook(info, reg, result, ctl, warnings) {
        const allowed = new Set(METHODS[info.event]);
        const key = info.agent?.id ?? '';
        // 세션 인자는 읽기 전용 — 콜백이 바꿔도 다음 콜백에 남지 않게 콜백마다 얼린 사본 (ticket slcode-agent-plugin-part-when)
        const session = Object.freeze({ ...info.session, params: Object.freeze({ ...(info.session.params ?? {}) }) });
        const hook = { event: info.event, session, agent: info.agent, raw: info.raw, exec: (cmd, args, o) => exec(info.session.cwd, cmd, args, o) };
        for (const k of ['tool', 'prompt', 'source', 'trigger', 'reason'])
            if (info[k] !== undefined)
                hook[k] = info[k];
        Object.defineProperty(hook, 'state', {
            enumerable: true,
            get: () => stateOf(key).live,
            set: (v) => {
                if (v && typeof v === 'object' && !Array.isArray(v))
                    stateOf(key).live = v;
                else
                    warnings.push('hook.state 에는 객체만 넣을 수 있어 무시했습니다');
            },
        });
        const method = (m, apply) => (arg, arg2) => {
            if (ctl.done)
                post({ t: 'warn', text: `${reg.src}: ${info.event} 콜백이 끝난 뒤 hook.${m}() 을 불러 무시했습니다` });
            else if (!allowed.has(m))
                warnings.push(`hook.${m}() 은 ${info.event} 에서 쓸 수 없어 무시했습니다`);
            else
                apply(arg, arg2);
            return hook;
        };
        const text = (v) => (v === undefined || v === null ? '' : String(v));
        hook.block = method('block', (r) => result.block.push(text(r)));
        hook.ask = method('ask', (r) => result.ask.push(text(r)));
        hook.allow = method('allow', (r) => result.allow.push(text(r)));
        hook.context = method('context', (t) => result.context.push(text(t)));
        // look 의 icon·tone 은 문자열만 넘긴다 — 목록 검사는 core(hookRunner.merge)가 한다
        hook.message = method('message', (t, look) => {
            const l = (look && typeof look === 'object' ? look : {});
            result.message.push({ text: text(t), ...(typeof l.icon === 'string' ? { icon: l.icon } : {}), ...(typeof l.tone === 'string' ? { tone: l.tone } : {}) });
        });
        hook.stop = method('stop', (r) => result.stop.push(text(r)));
        hook.updateInput = method('updateInput', (i) => {
            if (i && typeof i === 'object' && !Array.isArray(i))
                result.input = i;
            else
                warnings.push('hook.updateInput() 에는 객체를 넘겨야 해 무시했습니다');
        });
        return hook;
    }
    /** run 이 받는 객체 — 상태는 주 에이전트의 것(훅과 같은 객체) */
    function makeCmd(info, result, ctl, warnings) {
        const session = Object.freeze({ ...info.session, params: Object.freeze({ ...(info.session.params ?? {}) }) });
        const cmd = { plugin: info.plugin, name: info.name, args: info.args, session, exec: (c, a, o) => exec(info.session.cwd, c, a, o) };
        Object.defineProperty(cmd, 'state', {
            enumerable: true,
            get: () => stateOf('').live,
            set: (v) => { if (v && typeof v === 'object' && !Array.isArray(v))
                stateOf('').live = v;
            else
                warnings.push('cmd.state 에는 객체만 넣을 수 있어 무시했습니다'); },
        });
        const late = (m) => post({ t: 'warn', text: `/${info.name}: run 이 끝난 뒤 cmd.${m}() 을 불러 무시했습니다` });
        const text = (v) => (v === undefined || v === null ? '' : String(v));
        cmd.context = (t) => { if (ctl.done)
            late('context');
        else
            result.context.push(text(t)); return cmd; };
        cmd.message = (t, look) => {
            if (ctl.done) {
                late('message');
                return cmd;
            }
            const l = (look && typeof look === 'object' ? look : {});
            result.message.push({ text: text(t), ...(typeof l.icon === 'string' ? { icon: l.icon } : {}), ...(typeof l.tone === 'string' ? { tone: l.tone } : {}) });
            return cmd;
        };
        return cmd;
    }
    /** 명령 하나 — 성공이면 바뀐 키를 보내고, 던지면 저장한 값으로 되돌린다 */
    async function runCmd(id, info) {
        const def = defs.get(info.name);
        const result = { context: [], message: [] };
        const ctl = { done: false }, warnings = [];
        const t0 = performance.now();
        let error = def ? null : `no command ${info.name}`;
        if (def) {
            try {
                await def.run(makeCmd(info, result, ctl, warnings));
            }
            catch (e) {
                error = e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 4).join('\n') : String(e);
            }
        }
        ctl.done = true;
        let changes = {};
        if (error) {
            const s = stateOf('');
            s.live = Object.fromEntries([...s.saved].map(([k, j]) => [k, JSON.parse(j)]));
        }
        else {
            const d = diff('');
            changes = d.changes;
            warnings.push(...d.warnings);
        }
        post({ t: 'cmdDone', id, ms: Math.round((performance.now() - t0) * 10) / 10, error, result, changes, warnings });
    }
    /** complete 하나 — 받은 상태는 얼린 사본. 후보는 {value, label?, description?} 꼴로 맞추고 상한까지 */
    async function complete(id, info) {
        const def = defs.get(info.name);
        if (!def?.complete) {
            post({ t: 'completeDone', id, items: [], error: def ? null : `no command ${info.name}` });
            return;
        }
        try {
            const input = Object.freeze({ ...info, args: Object.freeze([...info.args]), session: Object.freeze({ ...info.session, params: Object.freeze({ ...info.session.params }) }), state: deepFreeze(info.state) });
            const r = await def.complete(input);
            if (!Array.isArray(r))
                throw new Error('complete must return a list');
            const items = [];
            for (const x of r) {
                if (typeof x === 'string')
                    items.push({ value: x });
                else if (x && typeof x === 'object' && typeof x.value === 'string')
                    items.push({ value: x.value, ...(typeof x.label === 'string' ? { label: x.label } : {}), ...(typeof x.description === 'string' ? { description: x.description } : {}) });
                if (items.length >= (init.completeMax ?? 50))
                    break;
            }
            post({ t: 'completeDone', id, items, error: null });
        }
        catch (e) {
            post({ t: 'completeDone', id, items: [], error: e instanceof Error ? e.message : String(e) });
        }
    }
    async function call(id, reg, info) {
        const result = { block: [], ask: [], allow: [], input: null, context: [], message: [], stop: [] };
        const ctl = { done: false }, warnings = [];
        const t0 = performance.now();
        let error = null;
        try {
            await reg.cb(makeHook(info, reg, result, ctl, warnings));
        }
        catch (e) {
            error = e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 4).join('\n') : String(e);
        }
        ctl.done = true;
        const key = info.agent?.id ?? '';
        const d = diff(key);
        post({ t: 'done', id, ms: Math.round((performance.now() - t0) * 10) / 10, error, result, agent: key, changes: d.changes, warnings: [...warnings, ...d.warnings] });
    }
    const defs = new Map();
    port.on('message', (m) => {
        if (m.t === 'drop') {
            states.delete(m.agent);
            return;
        }
        if (m.t === 'cmd') {
            void runCmd(m.id, m.info);
            return;
        }
        if (m.t === 'complete') {
            void complete(m.id, m.info);
            return;
        }
        const reg = regs[m.reg];
        if (reg)
            void call(m.id, reg, m.info);
    });
    void (async () => {
        const errors = [];
        for (const c of init.commands ?? []) {
            const l = await loadScript(c.js, init.vars, () => { }, 'command');
            const k = l.error ? { def: null, error: l.error } : checkCommand(l.cmds, l.regs.length);
            if (!k.def) {
                errors.push(`${c.src}: ${k.error}`);
                continue;
            }
            defs.set(c.name, k.def);
        }
        for (const s of init.role === 'complete' ? [] : init.scripts) {
            const l = await loadScript(s.js, init.vars, (ev) => post({ t: 'warn', text: `${s.src}: 등록이 끝난 뒤(slcode.run() 뒤)의 slcode.on(${ev}) 은 무시했습니다` }));
            if (l.error) {
                errors.push(`${s.src}: ${l.error}`);
                continue;
            } // 실패한 스크립트의 등록은 버린다
            const c = checkRegs(l.regs, METHODS, init.matchers);
            errors.push(...[...l.warnings, ...c.errors].map((e) => `${s.src}: ${e}`));
            for (const r of c.regs)
                regs.push({ ...r, id: regs.length, src: s.src });
        }
        post({ t: 'ready', regs: regs.map(({ cb: _c, ...r }) => r), errors, commands: [...defs.keys()] });
    })();
}
/** hookScript.ts 의 COLLECT 와 같은 이름 — worker 는 로컬 모듈을 런타임에 싣지 않는다 */
const COLLECT = Symbol.for('slcode.hooks.collect');
/** 스크립트 하나를 싣고 slcode.on()·slcode.command() 등록을 모은다 — 싣는 중에 던지거나 옛 꼴(default 함수)이면 error. 등록 끝(import 가 끝나거나 slcode.run())
 *  뒤의 on() 은 late 로 알린다. 수집기는 묶인 slcode/api 사본이 평가될 때 잡으므로 import 가 끝나면 치운다.
 *  kind 'command' 는 COMMAND 파일 — command() 를 모으고(검사는 checkCommand), slcode.run() 이 없어도 경고하지 않는다. 훅 스크립트의 command() 는 무시하고 경고한다 */
export async function loadScript(js, vars, late, kind = 'hooks') {
    const regs = [], cmds = [];
    let open = true, ran = false;
    globalThis[COLLECT] = {
        on(event, a, b) {
            if (!open) {
                late(String(event));
                return;
            }
            const [opts, cb] = (typeof a === 'function' ? [{}, a] : [a ?? {}, b]);
            regs.push({ event: String(event), opts: opts && typeof opts === 'object' ? opts : {}, cb });
        },
        run() { ran = true; open = false; },
        command(def) { if (open || kind === 'command')
            cmds.push(def); },
        vars,
    };
    let mod;
    try {
        mod = await import(pathToFileURL(js).href);
    }
    catch (e) {
        return { regs: [], cmds: [], error: e?.message ?? String(e), warnings: [] };
    }
    finally {
        open = false;
        delete globalThis[COLLECT];
    }
    if (kind === 'command')
        return { regs, cmds, error: null, warnings: [] };
    const warnings = [...(ran ? [] : ['slcode.run() 을 부르지 않았습니다 — 등록은 받았습니다']), ...(cmds.length ? ['slcode.command() 는 commands/<이름>/COMMAND.ts 에서만 쓸 수 있어 무시했습니다'] : [])];
    if (!regs.length && typeof mod.default === 'function')
        return { regs: [], cmds: [], error: "default export 함수 꼴은 더 받지 않습니다 — import { slcode } from 'slcode/api' 로 slcode.on() 을 등록하고 slcode.run() 을 부르세요", warnings: [] };
    return { regs, cmds, error: null, warnings };
}
/** COMMAND 파일의 등록 검사 — command() 정확히 한 번, description(비지 않은 글)·run(함수) 필수, complete 는 함수, argumentHint 는 글, timeout 은 양수.
 *  꼴이 틀리면 error(플러그인 적용 실패, 사용자 결정 2026-11-02), 모르는 칸은 warnings(새 판의 칸일 수 있다) */
export function checkCommand(cmds, onCalls) {
    const bad = (error) => ({ def: null, error, warnings: [] });
    if (onCalls)
        return bad('COMMAND 파일에서는 slcode.on() 을 쓸 수 없습니다 — 훅은 hooks/hooks.json 의 script 로 둡니다');
    if (cmds.length !== 1)
        return bad(`slcode.command() 를 정확히 한 번 불러야 합니다 (${cmds.length}번)`);
    const d = cmds[0];
    if (!d || typeof d !== 'object' || Array.isArray(d))
        return bad('slcode.command() 에는 { description, run } 객체를 넘깁니다');
    if (typeof d.description !== 'string' || !d.description.trim())
        return bad('description 이 비었습니다');
    if (typeof d.run !== 'function')
        return bad('run 이 함수가 아닙니다');
    if (d.complete !== undefined && typeof d.complete !== 'function')
        return bad('complete 가 함수가 아닙니다');
    if (d.argumentHint !== undefined && typeof d.argumentHint !== 'string')
        return bad('argumentHint 가 글이 아닙니다');
    if (d.timeout !== undefined && !(typeof d.timeout === 'number' && d.timeout > 0))
        return bad('timeout 은 양수(초)입니다');
    const known = new Set(['description', 'argumentHint', 'timeout', 'complete', 'run']);
    return { def: d, error: null, warnings: Object.keys(d).filter((k) => !known.has(k)).map((k) => `slcode.command() 의 모르는 칸 ${k} 는 무시합니다`) };
}
/** 얼린 깊은 사본 — complete 가 상태를 바꾸지 못하게 */
function deepFreeze(v) {
    if (v && typeof v === 'object') {
        for (const x of Object.values(v))
            deepFreeze(x);
        Object.freeze(v);
    }
    return v;
}
/** 등록을 검사해 Reg 꼴로 — 모르는 이벤트·함수가 아닌 콜백은 빼고 사유. id·src 는 부르는 쪽이 채운다 */
export function checkRegs(raw, methods, matchers) {
    const events = Object.keys(methods);
    const regs = [], errors = [];
    for (const { event, opts, cb } of raw) {
        if (!events.includes(event)) {
            errors.push(`on(${event}) — 모르는 이벤트 (${events.join(', ')})`);
            continue;
        }
        if (typeof cb !== 'function') {
            errors.push(`on(${event}) — 콜백이 함수가 아닙니다`);
            continue;
        }
        const ev = event;
        const timeout = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : DEFAULT_TIMEOUT;
        const failClosed = opts.failClosed === true;
        if (failClosed && !methods[ev].includes('block'))
            errors.push(`on(${ev}) — failClosed 는 block 이 있는 이벤트에서만 뜻이 있습니다`);
        let matcher = typeof opts.matcher === 'string' && opts.matcher ? opts.matcher : null;
        if (matcher && !matchers.includes(ev)) {
            errors.push(`on(${ev}) — ${ev} 는 matcher 를 보지 않습니다 (matcher 를 무시합니다)`);
            matcher = null;
        }
        regs.push({ event: ev, matcher, timeout, failClosed, cb: cb });
    }
    return { regs, errors };
}
/** 목록 모드 — `node hookWorker.js --list <묶은 스크립트> <harness>` 가 그 하네스의 slcode.vars 로 실어 등록(event·matcher·timeout·failClosed, 검사 전)을 JSON 한 줄로 낸다. 빌드가 export 의 hooks.json 을 만들 때 */
/** 명령 목록 모드 — `node hookWorker.js --list-command <묶은 COMMAND 파일>` 이 실어 검사한 결과(description·argumentHint·timeout·complete 유무)를 JSON 한 줄로 낸다 */
async function listCommand(js) {
    const l = await loadScript(js, { harness: 'claude' }, () => { }, 'command');
    const k = l.error ? { def: null, error: l.error, warnings: [] } : checkCommand(l.cmds, l.regs.length);
    const d = k.def;
    process.stdout.write(`${JSON.stringify({ error: k.error, warnings: k.warnings, def: d && { description: d.description, argumentHint: d.argumentHint ?? '', timeout: d.timeout ?? null, complete: typeof d.complete === 'function' } })}\n`);
    process.exit(0);
}
if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--list-command' && process.argv[3])
    void listCommand(process.argv[3]);
async function list(js, harness) {
    const l = await loadScript(js, { harness }, () => { });
    const regs = l.regs.map(({ event, opts, cb }) => ({ event, opts: { matcher: opts.matcher, timeout: opts.timeout, failClosed: opts.failClosed }, cb: typeof cb === 'function' ? 'function' : typeof cb }));
    process.stdout.write(`${JSON.stringify({ regs, error: l.error, warnings: l.warnings })}\n`);
    process.exit(0); // 스크립트가 띄운 타이머 등을 기다리지 않는다
}
if (isMainThread && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--list' && process.argv[3] && (process.argv[4] === 'claude' || process.argv[4] === 'codex'))
    void list(process.argv[3], process.argv[4]);
if (!isMainThread && parentPort && workerData?.slcodeHooks)
    main(workerData, parentPort);
