// js/ts 훅의 core 쪽 (ticket slcode-agent-plugin-hooks) — SDK options.hooks 에 이벤트마다 디스패처 하나를 걸고, 실은 플러그인마다 worker(hookWorker.ts) 하나를 둔다.
// 디스패처: matcher 에 맞는 콜백을 모든 worker 에 동시에 보내고, 결과를 설치 순서·등록 순서로 합쳐 SDK 형식으로 돌려준다 — 거부 > 확인 > 허용, context·message 는 잇고,
// updateInput 은 나중 것이 이긴다(버린 것은 경고). 실패·timeout 은 결과 없이 통과(failClosed 면 막는다). timeout 이면 그 worker 를 종료하고 다음 호출 때 다시 띄운다.
// 상태: 주 에이전트의 것은 세션 폴더 agent-state/<플러그인>.json (resume·/clear 뒤에도 남는다), 서브에이전트의 것은 메모리에만 두고 SubagentStop 뒤에 버린다.
// worker 는 세션마다(core 가 세션 프로세스다) — 다시 싣기로 빌드가 바뀐 플러그인만 다시 띄운다.
// export 한 Claude·Codex 의 세션 중간 프로세스(hookBroker)도 이것을 쓴다 — stateFile·dirOf·aliases 를 주고 run() 으로 이벤트를 넣는다 (ticket slcode-agent-plugin-script-portable).
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { HOOK_EVENTS, MATCHER_EVENTS, METHODS } from './hookApi.js';
import { killGroup } from './hookWorker.js';
import { BUILD_FILES } from './agentBuild.js';
import { readScripts } from './agentHooks.js';
/** worker 가 스크립트를 싣고 등록을 마칠 때까지 */
const READY_MS = 10_000;
/** SDK 에 거는 디스패처의 timeout(초) — 콜백마다의 timeout 은 디스패처가 지킨다 */
const SDK_TIMEOUT = 3600;
/** 세션 폴더 안의 상태 폴더 */
export const STATE_DIR = 'agent-state';
// 테스트(tsx)는 .ts 를, 빌드(dist)는 .js 를 띄운다
const WORKER_URL = new URL(`./hookWorker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);
/** Claude 의 matcher 규칙 — 비거나 * 면 모두, 영문·숫자·_·| 만이면 이름 목록, 그 밖은 정규식 */
export function matches(matcher, value) {
    if (!matcher || matcher === '*')
        return true;
    if (value === undefined)
        return false;
    if (/^[A-Za-z0-9_|]+$/.test(matcher))
        return matcher.split('|').includes(value);
    try {
        return new RegExp(matcher).test(value);
    }
    catch {
        return false;
    }
}
/** matcher 가 보는 값 — 그 밖의 이벤트는 matcher 를 보지 않는다 */
function matchValue(event, input) {
    switch (event) {
        case 'PreToolUse':
        case 'PostToolUse': return input.tool_name;
        case 'SessionStart': return input.source;
        case 'PreCompact': return input.trigger;
        case 'SessionEnd': return input.reason;
        case 'SubagentStart':
        case 'SubagentStop': return input.agent_type;
        default: return null;
    }
}
function infoOf(event, input, sessionId) {
    const info = { event, session: { id: sessionId, cwd: input.cwd, permissionMode: input.permission_mode ?? null }, agent: input.agent_id ? { id: input.agent_id, type: input.agent_type ?? null } : null, raw: input };
    if (event === 'PreToolUse' || event === 'PostToolUse')
        info.tool = { name: input.tool_name, input: input.tool_input ?? {}, useId: input.tool_use_id, ...(event === 'PostToolUse' ? { response: input.tool_response } : {}) };
    if (event === 'UserPromptSubmit')
        info.prompt = input.prompt;
    if (event === 'SessionStart')
        info.source = input.source;
    if (event === 'PreCompact')
        info.trigger = input.trigger;
    if (event === 'SessionEnd')
        info.reason = input.reason;
    return info;
}
/** 대신 부른 SessionStart 의 결과를 그 프롬프트의 UserPromptSubmit 결과 앞에 합친다 — message·context 는 잇고, stop 은 어느 쪽이든 */
function joinOutputs(start, prompt) {
    const out = { ...prompt };
    const msg = [start.systemMessage, prompt.systemMessage].filter(Boolean).join('\n');
    if (msg)
        out.systemMessage = msg;
    if (start.continue === false && prompt.continue !== false) {
        out.continue = false;
        out.stopReason = start.stopReason;
    }
    const ctx = [start.hookSpecificOutput?.additionalContext, prompt.hookSpecificOutput?.additionalContext].filter(Boolean).join('\n\n');
    if (ctx)
        out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: ctx };
    return out;
}
export class HookRunner {
    opts;
    plugins = [];
    nextCall = 0;
    closed = false;
    /** 세션을 열거나 다시 열었는데 SDK 가 아직 SessionStart 를 부르지 않았다 — 첫 UserPromptSubmit 때 대신 부른다 */
    startSource = null;
    constructor(opts) {
        this.opts = opts;
    }
    /** SDK(0.3.282~0.3.312 실측)는 새 세션·resume 때 options.hooks 의 SessionStart 콜백을 부르지 않는다(/clear 때만) — 세션을 띄울 때 걸어 두면
     *  첫 프롬프트의 UserPromptSubmit 앞에서 SessionStart(source) 를 대신 돌리고 그 context·message 를 그 프롬프트의 것에 합친다.
     *  SDK 가 먼저 SessionStart 를 부르면(고쳐진 뒤) 건 것을 지운다 — 두 번 돌지 않는다 (사용자 결정 2026-10-30) */
    armSessionStart(source) { this.startSource = source; }
    /** 실은 플러그인 목록(설치 순서)으로 맞춘다 — 빠진 것은 내리고, 빌드가 바뀐 것은 다시 띄우고, 같은 것은 둔다. 스크립트가 없는 플러그인은 worker 를 두지 않는다 */
    load(loaded) {
        const next = [];
        for (const l of loaded) {
            const old = this.plugins.find((p) => p.name === l.name);
            if (old && old.build === l.build) {
                next.push(old);
                continue;
            }
            if (old)
                this.stop(old, 'reloaded');
            const dir = this.opts.dirOf ? this.opts.dirOf(l.build) : path.join(this.opts.buildDir, l.build);
            const scripts = readScripts(path.join(dir, BUILD_FILES.scripts));
            if (!scripts.length)
                continue;
            const p = { name: l.name, build: l.build, dir, scripts, worker: null, ready: null, pending: new Map(), pgids: new Set(), states: old?.states ?? new Map([['', this.readState(l.name)]]) };
            next.push(p);
            this.start(p);
        }
        for (const p of this.plugins)
            if (!next.includes(p))
                this.stop(p, 'removed');
        this.plugins = next;
    }
    /** SDK options.hooks — 받는 이벤트마다 디스패처 하나. 다시 싣기로 훅이 생겨도 받게 늘 모두 건다 */
    sdkHooks() {
        return Object.fromEntries(HOOK_EVENTS.map((ev) => [ev, [{ hooks: [(input) => this.dispatch(ev, input)], timeout: SDK_TIMEOUT }]]));
    }
    /** 이벤트 하나를 돌린다 — 하네스 훅 입력(Claude 꼴)을 받아 Claude 훅 JSON 출력을 돌려준다. notes 에 콜백의 실패·경고를 더한다 (hookBroker) */
    run(event, input, notes) { return this.dispatch(event, input, notes); }
    async close() {
        this.closed = true;
        for (const p of this.plugins)
            this.stop(p, 'session closed');
        this.plugins = [];
    }
    statePath(name) { return this.opts.stateFile ? this.opts.stateFile(name) : path.join(this.opts.sessionDir, STATE_DIR, `${name}.json`); }
    readState(name) {
        try {
            const j = JSON.parse(fs.readFileSync(this.statePath(name), 'utf8'));
            if (j && typeof j === 'object' && !Array.isArray(j))
                return new Map(Object.entries(j).map(([k, v]) => [k, JSON.stringify(v)]));
        }
        catch { }
        return new Map();
    }
    writeState(p) {
        const f = this.statePath(p.name);
        fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
        const tmp = `${f}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, `{${[...(p.states.get('') ?? new Map())].map(([k, j]) => `${JSON.stringify(k)}:${j}`).join(',')}}`);
        fs.renameSync(tmp, f);
    }
    start(p) {
        if (this.closed)
            return;
        const init = {
            slcodeHooks: true, methods: METHODS, matchers: MATCHER_EVENTS, vars: { harness: this.opts.harness ?? 'claude' },
            scripts: p.scripts.map((s) => ({ src: s.src, js: path.join(p.dir, s.js) })),
            states: Object.fromEntries([...p.states].map(([k, m]) => [k, Object.fromEntries([...m].map(([kk, j]) => [kk, JSON.parse(j)]))])),
        };
        const w = new Worker(WORKER_URL, { workerData: init, execArgv: [...process.execArgv, '--enable-source-maps'] });
        p.worker = w;
        let settle = () => { };
        p.ready = new Promise((r) => { settle = r; });
        const timer = setTimeout(() => { this.opts.emit({ kind: 'agent.hook', phase: 'warn', plugin: p.name, text: `스크립트를 ${READY_MS / 1000}초 안에 싣지 못해 이 플러그인의 훅을 끕니다` }); this.terminate(p, w); settle([]); }, READY_MS);
        w.on('message', (m) => {
            if (m.t === 'ready') {
                clearTimeout(timer);
                settle(m.regs);
                this.opts.emit({ kind: 'agent.hook', phase: 'ready', plugin: p.name, callbacks: m.regs.map((r) => ({ event: r.event, matcher: r.matcher, src: r.src })), errors: m.errors });
            }
            else if (m.t === 'done') {
                const st = p.states.get(m.agent) ?? new Map();
                for (const [k, j] of Object.entries(m.changes)) {
                    if (j === null)
                        st.delete(k);
                    else
                        st.set(k, j);
                }
                p.states.set(m.agent, st);
                if (m.agent === '' && Object.keys(m.changes).length) {
                    try {
                        this.writeState(p);
                    }
                    catch (e) {
                        this.opts.emit({ kind: 'agent.hook', phase: 'warn', plugin: p.name, text: `상태를 저장하지 못했습니다: ${e.message}` });
                    }
                }
                p.pending.get(m.id)?.({ ok: !m.error, timeout: false, error: m.error, result: m.result, ms: m.ms, warnings: m.warnings });
            }
            else if (m.t === 'pgid') {
                if (m.on)
                    p.pgids.add(m.pid);
                else
                    p.pgids.delete(m.pid);
            }
            else if (m.t === 'warn')
                this.opts.emit({ kind: 'agent.hook', phase: 'warn', plugin: p.name, text: m.text });
        });
        w.on('error', (e) => this.opts.emit({ kind: 'agent.hook', phase: 'warn', plugin: p.name, text: `worker 오류로 다시 띄웁니다: ${e.message}` }));
        w.on('exit', () => { clearTimeout(timer); settle([]); this.terminate(p, w); });
    }
    /** worker 를 내린다 — 그 worker 가 띄운 프로세스 그룹도 종료하고, 기다리던 콜백은 실패로 푼다. 다음 호출 때 다시 띄운다 */
    terminate(p, w, why = 'worker stopped') {
        if (p.worker !== w)
            return;
        p.worker = null;
        p.ready = null;
        void w.terminate();
        for (const pid of p.pgids)
            killGroup(pid);
        p.pgids.clear();
        for (const done of p.pending.values())
            done({ ok: false, timeout: false, error: why, result: null, ms: 0, warnings: [] });
        p.pending.clear();
    }
    stop(p, why) { if (p.worker)
        this.terminate(p, p.worker, why); }
    async regsOf(p) {
        if (!p.worker)
            this.start(p);
        return (await p.ready) ?? [];
    }
    call(p, reg, info) {
        return new Promise((resolve) => {
            const w = p.worker;
            if (!w) {
                resolve({ reg, plugin: p.name, ok: false, timeout: false, error: 'worker stopped', result: null, ms: 0, warnings: [] });
                return;
            }
            const id = this.nextCall++;
            const timer = setTimeout(() => {
                p.pending.delete(id);
                resolve({ reg, plugin: p.name, ok: false, timeout: true, error: `${reg.timeout}초 안에 끝나지 않았습니다`, result: null, ms: reg.timeout * 1000, warnings: [] });
                this.terminate(p, w, `${reg.src} timed out`); // 같은 worker 의 다른 콜백도 함께 실패한다
            }, reg.timeout * 1000);
            p.pending.set(id, (o) => { clearTimeout(timer); p.pending.delete(id); resolve({ reg, plugin: p.name, ...o }); });
            w.postMessage({ t: 'call', id, reg: reg.id, info });
        });
    }
    async dispatch(event, input, notes) {
        if (event === 'SessionStart')
            this.startSource = null;
        if (event === 'UserPromptSubmit' && this.startSource && !input.agent_id) {
            const { prompt: _p, ...base } = input;
            const source = this.startSource;
            this.startSource = null;
            const start = await this.dispatch('SessionStart', { ...base, hook_event_name: 'SessionStart', source });
            return joinOutputs(start, await this.dispatch(event, input));
        }
        const info = infoOf(event, input, this.opts.sessionId);
        const value = matchValue(event, input);
        const values = value ? [value, ...(this.opts.aliases?.[value] ?? [])] : [];
        const lists = await Promise.all(this.plugins.map(async (p) => {
            const regs = (await this.regsOf(p)).filter((r) => r.event === event && (value === null || (value === undefined ? matches(r.matcher, undefined) : values.some((v) => matches(r.matcher, v)))));
            return Promise.all(regs.map((r) => this.call(p, r, info)));
        }));
        const outs = lists.flat(); // 설치 순서, 같은 플러그인은 등록 순서
        if (event === 'SubagentStop' && info.agent)
            for (const p of this.plugins) {
                p.states.delete(info.agent.id);
                p.worker?.postMessage({ t: 'drop', agent: info.agent.id });
            }
        if (!outs.length)
            return {};
        return this.merge(event, outs, info.tool?.useId ?? null, notes);
    }
    /** 결과를 합치고 콜백마다 기록을 낸다 */
    merge(event, outs, toolUseId, notes) {
        const canBlock = METHODS[event].includes('block');
        const block = [], ask = [], allow = [], context = [], message = [], stop = [];
        let input = null;
        const lost = [];
        for (const o of outs) {
            const r = o.result;
            this.opts.emit({
                kind: 'agent.hook', phase: 'run', plugin: o.plugin, src: o.reg.src, event, ms: o.ms, outcome: o.timeout ? 'timeout' : o.ok ? 'ok' : 'error',
                effects: r && { block: r.block, ask: r.ask, allow: r.allow, stop: r.stop, context: r.context.filter(Boolean), updateInput: !!r.input }, toolUseId, error: o.error, message: r?.message.length ? r.message.join('\n') : null, warnings: o.warnings,
            });
            if (notes) {
                if (!o.ok)
                    notes.push(`${o.plugin} ${o.reg.src}: ${o.timeout ? 'timeout' : 'error'} — ${o.error ?? ''}`.trim());
                notes.push(...o.warnings.map((w) => `${o.plugin} ${o.reg.src}: ${w}`));
            }
            if (!o.ok && o.reg.failClosed && canBlock)
                block.push(`${o.reg.src} 훅이 실패해 막았습니다 (failClosed): ${o.error ?? ''}`.trim());
            if (!r)
                continue;
            block.push(...r.block);
            ask.push(...r.ask);
            allow.push(...r.allow);
            context.push(...r.context.filter(Boolean));
            message.push(...r.message.filter(Boolean));
            stop.push(...r.stop);
            if (r.input) {
                if (input)
                    lost.push(input.o);
                input = { v: r.input, o };
            }
        }
        if (input && lost.length)
            this.opts.emit({ kind: 'agent.hook', phase: 'warn', plugin: input.o.plugin, text: `여러 콜백이 도구 입력을 바꿔 나중 것(${input.o.plugin} ${input.o.reg.src})을 썼습니다 — 버린 것: ${lost.map((o) => `${o.plugin} ${o.reg.src}`).join(', ')}` });
        const out = {};
        if (message.length)
            out.systemMessage = message.join('\n');
        if (stop.length) {
            out.continue = false;
            out.stopReason = stop.filter(Boolean).join('\n') || 'stopped by a slcode hook';
        }
        const join = (xs) => xs.filter(Boolean).join('\n');
        if (event === 'PreToolUse') {
            const decision = block.length ? 'deny' : ask.length ? 'ask' : allow.length ? 'allow' : null;
            const reason = join(block.length ? block : ask.length ? ask : allow);
            if (decision || input || context.length)
                out.hookSpecificOutput = {
                    hookEventName: 'PreToolUse', ...(decision ? { permissionDecision: decision, ...(reason ? { permissionDecisionReason: reason } : {}) } : {}),
                    ...(input ? { updatedInput: input.v } : {}), ...(context.length ? { additionalContext: context.join('\n\n') } : {}),
                };
            return out;
        }
        if (block.length) {
            out.decision = 'block';
            out.reason = join(block) || 'blocked by a slcode hook';
        }
        if (context.length && (event === 'SessionStart' || event === 'UserPromptSubmit' || event === 'PostToolUse' || event === 'SubagentStart'))
            out.hookSpecificOutput = { hookEventName: event, additionalContext: context.join('\n\n') };
        return out;
    }
}
