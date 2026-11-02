// 에이전트 플러그인 명령 (ticket slcode-agent-plugin-command) — commands/<이름>/COMMAND.ts 의 검사(add 거부)·빌드(commands.json, 플러그인 폴더에서 뺀다)·
// runCommand(상태는 훅과 함께, 성공했을 때만 저장)·보관 컨텍스트(다음 UserPromptSubmit 에 한 번, 같은 명령은 바꾼다, 파일로 남는다)·complete(따로 도는 worker, 얼린 상태, 늦으면 내린다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addPlugin, agentPaths, readConfig } from '../src/agentPlugins.ts';
import { HELD_FILE, HookRunner, STATE_DIR, type AgentCommandEvent, type AgentHookEvent } from '../src/hookRunner.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-cmd-${p}-`));
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}
async function install(dir: string, name: string, files: Record<string, string>, parts: Record<string, unknown> = { main: {} }) {
  const src = tmp(name);
  write(src, { 'slcode-plugin.json': JSON.stringify({ name, version: '1.0.0', parts }), ...files });
  return (await addPlugin(src, dir)).build!;
}

const ROLEAS = `import { slcode } from 'slcode/api';
slcode.command({
  description: '역할을 정한다', argumentHint: '<역할>',
  complete: (c) => (c.state.roles ?? []).filter((r: string) => r.startsWith(c.value)),
  run: (cmd) => {
    if (cmd.args === 'boom') { cmd.state.role = 'broken'; throw new Error('boom'); }
    if (cmd.args === 'slow') return new Promise((r) => setTimeout(r, 5000));
    cmd.state.role = cmd.args;
    if (cmd.args !== 'quiet') cmd.context(\`당신의 역할은 \${cmd.args}\`);
    cmd.message(\`역할: \${cmd.args}\`, { icon: 'flag', tone: 'ok' });
  },
  timeout: 1,
});`;
const ROLES = `import { slcode } from 'slcode/api';
slcode.command({
  description: '역할 목록을 정한다',
  complete: (c) => { if (c.value === 'mutate') { (c.state as any).roles.push('x'); } if (c.value === 'slow') { const t = Date.now(); while (Date.now() - t < 2000); } return [{ value: 'set', description: '목록을 바꾼다' }, 'more']; },
  run: (cmd) => { cmd.state.roles = cmd.args.split(/\\s+/); cmd.context('목록이 바뀜'); },
});`;
const HOOK = `import { slcode } from 'slcode/api';
slcode.on('SessionStart', (h: any) => { h.context('열 때'); });
slcode.on('UserPromptSubmit', (h: any) => { h.context(\`훅이 본 역할 \${h.state.role ?? '-'}\`); });
slcode.run();`;

test('검사: 같은 플러그인 skill·part 끼리 같은 이름·COMMAND 둘·이름 규칙·command() 꼴이 틀리면 add 가 거부한다', async () => {
  const dir = tmp('state');
  const bad = async (files: Record<string, string>, re: RegExp, parts?: Record<string, unknown>) => {
    await assert.rejects(install(dir, 'bad', files, parts), re);
    assert.equal(readConfig(agentPaths(dir)).plugins.bad, undefined, '설치하지 않는다');
  };
  await bad({ 'main/commands/roleas/COMMAND.ts': ROLEAS, 'main/skills/roleas/SKILL.md': '---\ndescription: x\n---\nx' }, /same name as skill roleas/);
  await bad({ 'main/commands/roleas/COMMAND.ts': ROLEAS, 'other/skills/x/SKILL.md': '---\nname: roleas\n---\nx' }, /same name as skill roleas \(part other\)/, { main: {}, other: { default: false } });
  await bad({ 'main/commands/roleas/COMMAND.ts': ROLEAS, 'other/commands/roleas/COMMAND.ts': ROLEAS }, /also in part main/, { main: {}, other: {} });
  await bad({ 'main/commands/clear/COMMAND.ts': ROLEAS }, /same name as the Claude built-in command \/clear/);
  await bad({ 'main/commands/reset/COMMAND.ts': ROLEAS }, /built-in command \/reset/); // 별칭도
  await bad({ 'main/commands/roleas/COMMAND.ts': ROLEAS, 'main/commands/roleas/COMMAND.js': 'x' }, /both COMMAND\.ts and COMMAND\.js/);
  await bad({ 'main/commands/Role_As/COMMAND.ts': ROLEAS }, /command name must match/);
  await bad({ 'main/commands/two/COMMAND.ts': `import { slcode } from 'slcode/api'; const d = { description: 'x', run() {} }; slcode.command(d); slcode.command(d);` }, /정확히 한 번 .*2번/);
  await bad({ 'main/commands/nodesc/COMMAND.ts': `import { slcode } from 'slcode/api'; slcode.command({ run() {} } as any);` }, /description 이 비었습니다/);
  await bad({ 'main/commands/hook/COMMAND.ts': `import { slcode } from 'slcode/api'; slcode.on('Stop', () => {}); slcode.command({ description: 'x', run() {} });` }, /slcode\.on\(\) 을 쓸 수 없습니다/);
  // 명령이 아닌 commands/ 아래 폴더(공용 코드)는 괜찮다
  await install(dir, 'ok', { 'main/commands/roleas/COMMAND.ts': `import { who } from '../lib/who'; import { slcode } from 'slcode/api'; slcode.command({ description: who(), run() {} });`, 'main/commands/lib/who.ts': 'export const who = () => "x";' });
});

test('빌드: commands.json 에 적고 묶은 명령을 둔다 — Claude·Codex 플러그인 폴더에는 commands/ 를 넣지 않고, Codex 는 잃는 것으로 적는다', async () => {
  const dir = tmp('state');
  const id = await install(dir, 'orch', { 'main/commands/roleas/COMMAND.ts': ROLEAS, 'main/skills/other/SKILL.md': '---\ndescription: y\n---\ny', 'main/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'h.ts' }] }), 'main/h.ts': `import { slcode } from 'slcode/api'; slcode.command({ description: 'x', run() {} }); slcode.on('Stop', () => {}); slcode.run();` });
  const out = path.join(agentPaths(dir).build, id);
  const cmds = JSON.parse(fs.readFileSync(path.join(out, 'commands.json'), 'utf8'));
  assert.deepEqual(cmds, [{ name: 'roleas', src: 'main/commands/roleas/COMMAND.ts', js: 'commands/roleas.mjs', description: '역할을 정한다', argumentHint: '<역할>', timeout: 1, complete: true }]);
  assert.ok(fs.existsSync(path.join(out, 'commands/roleas.mjs')));
  assert.ok(!fs.existsSync(path.join(out, 'claude/orch/commands')), 'Claude 플러그인 폴더에는 없다');
  assert.ok(fs.existsSync(path.join(out, 'claude/orch/skills/other/SKILL.md')));
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(report.commands.built, ['main/commands/roleas/COMMAND.ts']);
  assert.ok(report.scripts.warnings.some((w: string) => /commands\/<이름>\/COMMAND\.ts 에서만/.test(w)), '훅 스크립트의 command() 는 무시하고 경고');
  const e = readConfig(agentPaths(dir)).plugins.orch;
  assert.ok(!fs.existsSync(path.join(agentPaths(dir).build, e.builds.codex!, 'codex/commands')), 'Codex 빌드에도 없다');
  assert.ok(e.lost.codex.some((x) => x.startsWith('main/commands/roleas')), 'Codex 는 잃는다');
  assert.ok(!e.lost.claude.some((x) => x.includes('commands/')));
});

function runner(dir: string, sdir: string, loaded: { name: string; build: string }[]) {
  const events: (AgentHookEvent | AgentCommandEvent)[] = [];
  const r = new HookRunner({ sessionDir: sdir, buildDir: agentPaths(dir).build, sessionId: 's1', params: { ROLE: 'x' }, emit: (e) => events.push(e) });
  r.load(loaded);
  const hooks = r.sdkHooks() as Record<string, { hooks: ((i: unknown) => Promise<any>)[] }[]>;
  const fire = (event: string, input: Record<string, unknown>) => hooks[event][0].hooks[0]({ hook_event_name: event, session_id: 'v', cwd: sdir, transcript_path: '', ...input });
  const runs = () => events.filter((e) => e.kind === 'agent.command' && e.phase === 'run') as Extract<AgentCommandEvent, { phase: 'run' }>[];
  return { r, events, fire, runs };
}
const ctx = (o: any) => o.hookSpecificOutput?.additionalContext;

test('실행: 상태는 훅과 함께 보고 성공했을 때만 저장한다. 보관분은 다음 프롬프트에 한 번 — 열 때 것 → 명령(친 순서, 같은 명령은 바꾸고 뒤로) → 훅', async () => {
  const dir = tmp('state'), sdir = tmp('session');
  const id = await install(dir, 'orch', { 'main/commands/roleas/COMMAND.ts': ROLEAS, 'main/commands/roles/COMMAND.ts': ROLES, 'main/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'h.ts' }] }), 'main/h.ts': HOOK });
  const a = runner(dir, sdir, [{ name: 'orch', build: id }]);
  const state = () => JSON.parse(fs.readFileSync(path.join(sdir, STATE_DIR, 'orch.json'), 'utf8'));
  try {
    assert.deepEqual(a.r.commands().map((c) => `${c.plugin}:${c.name} ${c.argumentHint} ${c.complete}`), ['orch:roleas <역할> true', 'orch:roles  true']);
    a.r.openSession('startup', { cwd: sdir });
    assert.deepEqual(await a.r.runCommand('orch', 'roleas', 'orchestrator', { cwd: sdir }), { outcome: 'ok', error: null });
    assert.equal(state().role, 'orchestrator', '바로 저장한다 — 턴이 없어도');
    const run = a.runs()[0];
    assert.deepEqual(run.messages, [{ text: '역할: orchestrator', icon: 'flag', tone: 'ok' }]);
    assert.deepEqual(run.context, ['당신의 역할은 orchestrator']);
    await a.r.runCommand('orch', 'roles', 'orchestrator worker', { cwd: sdir });
    await a.r.runCommand('orch', 'roleas', 'worker', { cwd: sdir });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sdir, HELD_FILE), 'utf8')).map((x: any) => x.text), ['목록이 바뀜', '당신의 역할은 worker'], '같은 명령은 앞의 것을 바꾸고 뒤로');
    // 실패 — 상태(throw 전에 바꾼 것)와 보관분은 그대로
    assert.equal((await a.r.runCommand('orch', 'roleas', 'boom', { cwd: sdir })).outcome, 'error');
    assert.equal(state().role, 'worker');
    assert.match(a.runs().at(-1)!.error!, /boom/);
    let o = await a.fire('UserPromptSubmit', { prompt: 'hi' });
    assert.equal(ctx(o), '열 때\n\n목록이 바뀜\n\n당신의 역할은 worker\n\n훅이 본 역할 worker', '열 때 → 명령 → 훅, 훅은 명령이 바꾼 상태를 본다');
    assert.ok(!fs.existsSync(path.join(sdir, HELD_FILE)), '꺼내면 파일도 지운다');
    const att = a.events.find((e) => e.kind === 'agent.command' && e.phase === 'attached') as Extract<AgentCommandEvent, { phase: 'attached' }>;
    assert.deepEqual(att.items.map((x) => x.name), ['roles', 'roleas']);
    o = await a.fire('UserPromptSubmit', { prompt: 'again' });
    assert.equal(ctx(o), '훅이 본 역할 worker', '한 번만 붙는다');
    // context 없이 성공하면 앞의 보관분을 지운다
    await a.r.runCommand('orch', 'roleas', 'lead', { cwd: sdir });
    await a.r.runCommand('orch', 'roleas', 'quiet', { cwd: sdir });
    assert.equal(a.runs().at(-1)!.cleared, true);
    assert.ok(!fs.existsSync(path.join(sdir, HELD_FILE)));
    // 시간 초과 — worker 를 내리고 다음 호출 때 다시 띄운다
    assert.equal((await a.r.runCommand('orch', 'roleas', 'slow', { cwd: sdir })).outcome, 'timeout');
    assert.equal((await a.r.runCommand('orch', 'roleas', 'again', { cwd: sdir })).outcome, 'ok');
    assert.equal(state().role, 'again');
  } finally { await a.r.close(); }

  // 보관분은 세션 폴더에 남아 resume(새 runner)의 첫 프롬프트에 붙는다
  const b = runner(dir, sdir, [{ name: 'orch', build: id }]);
  try { assert.equal(ctx(await b.fire('UserPromptSubmit', { prompt: 'resumed' })), '당신의 역할은 again\n\n훅이 본 역할 again'); }
  finally { await b.r.close(); }
});

test('complete: 따로 도는 worker 가 저장된 상태의 얼린 사본으로 후보를 낸다 — 늦으면 그 worker 만 내리고, 밀린 요청은 stale', async () => {
  const dir = tmp('state'), sdir = tmp('session');
  const id = await install(dir, 'orch', { 'main/commands/roleas/COMMAND.ts': ROLEAS, 'main/commands/roles/COMMAND.ts': ROLES });
  const a = runner(dir, sdir, [{ name: 'orch', build: id }]);
  const input = (value: string) => ({ args: [value], index: 0, value, raw: value });
  try {
    await a.r.runCommand('orch', 'roles', 'orchestrator worker reviewer', { cwd: sdir });
    assert.deepEqual(await a.r.complete('orch', 'roleas', input('w'), { cwd: sdir }), { items: [{ value: 'worker' }], error: null });
    assert.deepEqual((await a.r.complete('orch', 'roles', input(''), { cwd: sdir })).items, [{ value: 'set', description: '목록을 바꾼다' }, { value: 'more' }]);
    const m = await a.r.complete('orch', 'roles', input('mutate'), { cwd: sdir });
    assert.match(m.error ?? '', /not extensible|read only|object is not extensible/i, '상태는 얼린 사본');
    const t0 = Date.now();
    const [slow, dropped, last] = await Promise.all([
      a.r.complete('orch', 'roles', input('slow'), { cwd: sdir }),
      a.r.complete('orch', 'roleas', input('o'), { cwd: sdir }),
      a.r.complete('orch', 'roleas', input('r'), { cwd: sdir }),
    ]);
    assert.match(slow.error ?? '', /500ms/);
    assert.ok(Date.now() - t0 < 1900, '동기로 붙잡는 complete 를 기다리지 않는다');
    assert.equal(dropped.stale, true, '기다리던 것은 최신 하나만');
    assert.deepEqual(last.items, [{ value: 'reviewer' }], '내린 뒤 다시 띄워 돈다');
    assert.equal((await a.r.runCommand('orch', 'roleas', 'still', { cwd: sdir })).outcome, 'ok', 'run·훅 worker 는 그대로');
  } finally { await a.r.close(); }
});
