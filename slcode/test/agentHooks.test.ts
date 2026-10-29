// 에이전트 플러그인 js/ts 훅 (agentHooks·hookWorker·hookRunner, ticket slcode-agent-plugin-hooks) — slcode 형식 hooks.json 빌드, on() 등록, 결과 합치기,
// 세션×플러그인 상태(파일·공유·JSON·서브에이전트), timeout·failClosed, hook.exec 의 그룹 정리. SDK 는 띄우지 않고 디스패처를 직접 부른다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addPlugin, agentPaths } from '../src/agentPlugins.ts';
import { HookRunner, matches, STATE_DIR } from '../src/hookRunner.ts';
import { notJson } from '../src/hookWorker.ts';
import type { AgentHookEvent } from '../src/protocol.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-hk-${p}-`));
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}

const GUARD = `
import { label } from './lib';
export default (slcode: any) => {
  slcode.on('PreToolUse', { matcher: 'Bash' }, (hook: any) => {
    hook.state.n = (hook.state.n ?? 0) + 1;
    if (hook.tool.input.command.includes('rm -rf')) return hook.block(label('danger'));
    hook.context(\`n=\${hook.state.n}\`);
  });
  slcode.on('PreToolUse', { matcher: 'Write|Edit' }, (hook: any) => { hook.updateInput({ file: 'a' }); });
  slcode.on('Stop', (hook: any) => { hook.context('ignored'); hook.block('keep going'); });
  slcode.on('UserPromptSubmit', { timeout: 1, failClosed: true }, async (hook: any) => {
    if (hook.prompt === 'slow') await new Promise((r) => setTimeout(r, 5000));
    if (hook.prompt === 'map') hook.state.m = new Map([[1, 2]]);
    if (hook.prompt === 'late') setTimeout(() => hook.message('late'), 10);
    if (hook.prompt === 'throw') throw new Error('boom');
    if (hook.prompt.startsWith('hang:')) await hook.exec('sh', ['-c', \`echo $$ > \${hook.prompt.slice(5)}; exec sleep 30\`]);
    if (hook.prompt === 'exec') {
      const r = await hook.exec('sh', ['-c', 'sleep 30 & echo $!']);
      hook.state.bg = Number(r.stdout.trim());
      hook.message(\`code \${r.code}\`);
    }
  });
  slcode.on('SubagentStart', (hook: any) => { hook.context(\`sub n=\${hook.state.n ?? 'none'}\`); hook.state.sub = true; });
  setTimeout(() => slcode.on('SessionEnd', () => {}), 0);
};
`;

async function install(dir: string, name: string, files: Record<string, string>) {
  const src = tmp(name);
  write(src, { 'slcode-plugin.json': JSON.stringify({ name, version: '1.0.0', parts: { main: {} } }), ...files });
  return (await addPlugin(src, dir)).build!;
}

function runner(dir: string, sdir: string, loaded: { name: string; build: string }[]) {
  const events: AgentHookEvent[] = [];
  const r = new HookRunner({ sessionDir: sdir, buildDir: agentPaths(dir).build, sessionId: 's1', emit: (e) => events.push(e) });
  r.load(loaded);
  const hooks = r.sdkHooks() as Record<string, { hooks: ((i: unknown) => Promise<any>)[] }[]>;
  const fire = (event: string, input: Record<string, unknown>) => hooks[event][0].hooks[0]({ hook_event_name: event, session_id: 'v', cwd: sdir, transcript_path: '', ...input });
  return { r, events, fire };
}
// 종료됐지만 거두지 않은 프로세스(zombie)는 죽은 것 — worker 를 내리면 그 worker 가 띄운 자식은 core 가 끝날 때까지 zombie 로 남는다
const alive = (pid: number) => { try { process.kill(pid, 0); } catch { return false; } try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; } };

test('빌드: slcode 형식 hooks.json — script 는 묶고(상대 import 포함) command 는 Claude 형식으로, Claude 형식·npm import·잘못된 항목은 빼고 report 에', async () => {
  const dir = tmp('state');
  const id = await install(dir, 'guard', {
    'main/hooks/hooks.json': JSON.stringify({ hooks: [
      { type: 'script', file: 'hooks/guard.ts' },
      { type: 'script', file: 'hooks/npm.ts' },
      { type: 'command', event: 'Stop', command: 'notify-send done', compat: 'claude', timeout: 3 },
      { type: 'command', event: 'Stop', command: 'x' },
      { type: 'script', file: '../outside.ts' },
      { type: 'script', file: 'hooks/guard.ts' },
    ] }),
    'main/hooks/guard.ts': GUARD,
    'main/hooks/lib.ts': 'export const label = (s: string): string => `[guard] ${s}`;',
    'main/hooks/npm.ts': "import _ from 'lodash'; export default () => _;",
  });
  const out = path.join(agentPaths(dir).build, id);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(report.scripts.built, ['main/hooks/guard.ts']);
  assert.match(report.scripts.failed[0], /^main\/hooks\/npm\.ts: only node built-ins and relative imports: lodash/);
  assert.equal(report.dropped.length, 3, report.dropped.join('\n'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'claude/guard/hooks/hooks.json'), 'utf8')), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done', timeout: 3 }] }] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'scripts.json'), 'utf8')), [{ src: 'main/hooks/guard.ts', js: 'scripts/0.mjs' }]);
  assert.match(fs.readFileSync(path.join(out, 'scripts/0.mjs'), 'utf8'), /sourceMappingURL=data:/);

  const id2 = await install(dir, 'old', { 'main/hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }) });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agentPaths(dir).build, id2, 'report.json'), 'utf8')).dropped, ['main/hooks/hooks.json'], 'Claude 형식은 깨진 파일');
});

test('matcher 는 Claude 규칙 — 비거나 * 면 모두, 이름 목록, 그 밖은 정규식. JSON 검사', () => {
  assert.ok(matches(null, 'Bash') && matches('*', 'x') && matches('Write|Edit', 'Edit') && !matches('Write', 'WriteFile') && matches('mcp__.*', 'mcp__a__b') && !matches('Bash', undefined));
  assert.equal(notJson({ a: [1, 'x', null, { b: true }], c: undefined }), null);
  assert.equal(notJson(new Map()), 'Map');
  assert.equal(notJson({ d: new Date() }), 'Date');
  assert.equal(notJson([undefined]), 'undefined');
  const cyc: any = {}; cyc.self = cyc;
  assert.equal(notJson(cyc), 'circular reference');
});

test('실행: on() 등록·결과 합치기·상태 파일·나중이 이기는 updateInput·Stop 의 context 막기·서브에이전트 상태·끝난 뒤 호출 경고', async () => {
  const dir = tmp('state'), sdir = tmp('session');
  const files = { 'main/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'hooks/guard.ts' }] }), 'main/hooks/guard.ts': GUARD, 'main/hooks/lib.ts': 'export const label = (s: string) => `[guard] ${s}`;' };
  const a = await install(dir, 'guard', files);
  const b = await install(dir, 'second', { 'main/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'h.ts' }] }), 'main/h.ts': "export default (s: any) => s.on('PreToolUse', { matcher: 'Write' }, (h: any) => h.updateInput({ file: 'b' }));" });
  const { r, events, fire } = runner(dir, sdir, [{ name: 'guard', build: a }, { name: 'second', build: b }]);
  try {
    let o = await fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' });
    assert.deepEqual(o, { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'n=1' } });
    o = await fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, tool_use_id: 't2' });
    assert.deepEqual(o.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[guard] danger' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sdir, STATE_DIR, 'guard.json'), 'utf8')), { n: 2 });
    assert.deepEqual(await fire('PreToolUse', { tool_name: 'Read', tool_input: {}, tool_use_id: 't3' }), {}, '맞는 콜백이 없으면 빈 결과');

    o = await fire('PreToolUse', { tool_name: 'Write', tool_input: { file: 'x' }, tool_use_id: 't4' });
    assert.deepEqual(o.hookSpecificOutput.updatedInput, { file: 'b' }, '나중에 설치한 플러그인이 이긴다');
    assert.ok(events.some((e) => e.phase === 'warn' && /나중 것\(second/.test(e.text)));

    o = await fire('Stop', { stop_hook_active: false });
    assert.deepEqual(o, { decision: 'block', reason: 'keep going' });
    const stopRun = events.findLast((e) => e.phase === 'run' && e.event === 'Stop') as Extract<AgentHookEvent, { phase: 'run' }>;
    assert.ok(stopRun.warnings.some((w) => /context\(\) 은 Stop 에서 쓸 수 없어/.test(w)));

    o = await fire('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' });
    assert.equal(o.hookSpecificOutput.additionalContext, 'sub n=none', '서브에이전트는 빈 상태로 시작한다');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sdir, STATE_DIR, 'guard.json'), 'utf8')), { n: 2 }, '서브에이전트 상태는 주 상태 파일에 쓰지 않는다');

    await fire('UserPromptSubmit', { prompt: 'map' });
    const mapRun = events.findLast((e) => e.phase === 'run' && e.event === 'UserPromptSubmit') as Extract<AgentHookEvent, { phase: 'run' }>;
    assert.ok(mapRun.warnings.some((w) => /state\.m 는 Map/.test(w)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sdir, STATE_DIR, 'guard.json'), 'utf8')), { n: 2 });

    await fire('UserPromptSubmit', { prompt: 'late' });
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(events.some((e) => e.phase === 'warn' && /끝난 뒤 hook\.message\(\)/.test(e.text)));
    assert.ok(events.some((e) => e.phase === 'warn' && /끝난 뒤의 slcode\.on\(SessionEnd\)/.test(e.text)));
    const ready = events.find((e) => e.phase === 'ready' && e.plugin === 'guard') as Extract<AgentHookEvent, { phase: 'ready' }>;
    assert.deepEqual(ready.callbacks.map((c) => `${c.event} ${c.matcher}`), ['PreToolUse Bash', 'PreToolUse Write|Edit', 'Stop null', 'UserPromptSubmit null', 'SubagentStart null']);
  } finally { await r.close(); }

  // 같은 세션을 다시 띄우면(resume) 상태가 이어진다
  const again = runner(dir, sdir, [{ name: 'guard', build: a }]);
  try {
    const o = await again.fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't5' });
    assert.equal(o.hookSpecificOutput.additionalContext, 'n=3');
  } finally { await again.r.close(); }
});

test('실패: 던지면 통과(failClosed 면 막는다), timeout 이면 worker 를 내리고 다음 호출 때 다시 띄운다. hook.exec 는 명령이 끝나면 그 그룹을 종료한다', async () => {
  const dir = tmp('state'), sdir = tmp('session');
  const a = await install(dir, 'guard', { 'main/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'hooks/guard.ts' }] }), 'main/hooks/guard.ts': GUARD, 'main/hooks/lib.ts': 'export const label = (s: string) => s;' });
  const { r, events, fire } = runner(dir, sdir, [{ name: 'guard', build: a }]);
  try {
    let o = await fire('UserPromptSubmit', { prompt: 'throw' });
    assert.equal(o.decision, 'block', 'failClosed');
    const run = events.findLast((e) => e.phase === 'run') as Extract<AgentHookEvent, { phase: 'run' }>;
    assert.equal(run.outcome, 'error');
    assert.match(run.error!, /boom[\s\S]*guard\.ts/, 'source map 으로 원본 경로');

    const t0 = Date.now();
    o = await fire('UserPromptSubmit', { prompt: 'slow' });
    assert.ok(Date.now() - t0 < 3000, 'timeout 1초');
    assert.equal(o.decision, 'block');
    assert.equal((events.findLast((e) => e.phase === 'run') as any).outcome, 'timeout');

    o = await fire('UserPromptSubmit', { prompt: 'exec' });
    assert.equal(o.systemMessage, 'code 0', '다시 띄운 worker 가 받는다');
    const bg = JSON.parse(fs.readFileSync(path.join(sdir, STATE_DIR, 'guard.json'), 'utf8')).bg;
    assert.ok(bg > 0);
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(!alive(bg), '명령이 끝나면 그룹에 남은 sleep 도 종료한다');
    assert.equal(events.filter((e) => e.phase === 'ready').length, 2, 'timeout 뒤 한 번 다시 띄웠다');

    const pidFile = path.join(sdir, 'hang.pid');
    o = await fire('UserPromptSubmit', { prompt: `hang:${pidFile}` });
    assert.equal((events.findLast((e) => e.phase === 'run') as any).outcome, 'timeout');
    const hung = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(hung > 0 && !alive(hung), 'timeout 으로 worker 를 내릴 때 hook.exec 의 그룹도 종료한다');
  } finally { await r.close(); }
});

test('SessionStart: SDK 가 부르지 않으면 첫 프롬프트 앞에서 대신 부르고 그 context·message 를 합친다 — SDK 가 먼저 부르면(버그 수정 뒤) 두 번 돌지 않는다', async () => {
  const dir = tmp('state'), sdir = tmp('session');
  const id = await install(dir, 'start', {
    'main/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'hooks/start.ts' }] }),
    'main/hooks/start.ts': `export default (slcode: any) => {
      slcode.on('SessionStart', (hook: any) => { hook.state.starts = [...(hook.state.starts ?? []), hook.source]; hook.context(\`start \${hook.source}\`); hook.message('hello'); });
      slcode.on('UserPromptSubmit', (hook: any) => { hook.context(\`prompt \${hook.prompt}\`); });
    };`,
  });
  const starts = (events: AgentHookEvent[]) => events.filter((e) => e.phase === 'run' && e.event === 'SessionStart').length;

  // 지금의 SDK — 새 세션에서 SessionStart 가 오지 않는다: 첫 프롬프트에 합쳐서 한 번만
  const a = runner(dir, sdir, [{ name: 'start', build: id }]);
  try {
    a.r.armSessionStart('startup');
    let o = await a.fire('UserPromptSubmit', { prompt: 'one' });
    assert.deepEqual(o, { systemMessage: 'hello', hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'start startup\n\nprompt one' } });
    o = await a.fire('UserPromptSubmit', { prompt: 'two' });
    assert.equal(o.hookSpecificOutput.additionalContext, 'prompt two', '두 번째 프롬프트에는 붙이지 않는다');
    assert.equal(starts(a.events), 1);
    await a.fire('SessionStart', { source: 'clear' }); // /clear 는 SDK 가 부른다 — 그대로 돈다
    assert.equal(starts(a.events), 2);
  } finally { await a.r.close(); }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sdir, STATE_DIR, 'start.json'), 'utf8')).starts, ['startup', 'clear']);

  // SDK 가 고쳐져 resume 때 SessionStart 를 먼저 부르는 경우 — slcode 는 다시 부르지 않는다
  const b = runner(dir, sdir, [{ name: 'start', build: id }]);
  try {
    b.r.armSessionStart('resume');
    await b.fire('SessionStart', { source: 'resume' });
    const o = await b.fire('UserPromptSubmit', { prompt: 'three' });
    assert.equal(o.hookSpecificOutput.additionalContext, 'prompt three');
    assert.equal(starts(b.events), 1, 'SessionStart 는 한 번만');
  } finally { await b.r.close(); }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sdir, STATE_DIR, 'start.json'), 'utf8')).starts, ['startup', 'clear', 'resume']);
});
