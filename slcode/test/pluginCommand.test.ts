// 에이전트 플러그인 명령 (ticket slcode-agent-plugin-command) — core 가 `/<명령>` 을 가로채 턴 없이 돌리고, 보관한 컨텍스트가 다음 턴 요청 본문에서 사용자 글보다 앞에 들어간다.
// Claude 내장 명령과 겹치는 명령은 add 가 정적 목록으로 거르고, 세션을 열 때 SDK 목록으로 다시 본다. 판정 규칙(pluginCommands)은 단위로, 나머지는 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { addPlugin } from 'slcode-plugin/agentPlugins';
import { CLAUDE_BUILTIN_COMMANDS } from 'slcode-plugin/agentFormat';
import { commandTable, completeInput, resolveCommand } from '../src/pluginCommands.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const cmd = (plugin: string, name: string) => ({ plugin, name, description: '', argumentHint: '', complete: false });

test('판정: 전체 이름은 그대로, 짧은 이름은 하나뿐일 때만 — 내장 명령(이름·별칭)과 겹치면 쓸 수 없다', () => {
  const vendor = [{ name: 'compact', description: '', argumentHint: '', builtin: true }, { name: 'clear', description: '', argumentHint: '', builtin: true, aliases: ['reset', 'new'] }, { name: 'core:roleas', description: '', argumentHint: '' }, { name: 'deploy', description: '', argumentHint: '' }];
  const t = commandTable([cmd('orch', 'roleas'), cmd('orch', 'compact'), cmd('orch', 'reset'), cmd('orch', 'hier'), cmd('other', 'hier'), cmd('orch', 'deploy'), cmd('orch', 'solo')], vendor);
  assert.deepEqual(t.blocked.map((b) => b.cmd.name), ['compact', 'reset']);
  const r = (text: string) => { const x = resolveCommand(text, t.usable, vendor); return x && `${x.cmd.plugin}:${x.cmd.name}|${x.args}`; };
  assert.equal(r('/solo  a b '), 'orch:solo|a b');
  assert.equal(r('/SOLO'), 'orch:solo|', '대소문자를 가리지 않는다');
  assert.equal(r('/roleas x'), null, '다른 플러그인 skill core:roleas 와 짧은 이름이 겹친다');
  assert.equal(r('/orch:roleas x'), 'orch:roleas|x');
  assert.equal(r('/hier'), null, '두 플러그인의 명령');
  assert.equal(r('/other:hier'), 'other:hier|');
  assert.equal(r('/deploy'), null, '사용자 skill deploy');
  assert.equal(r('/orch:deploy'), 'orch:deploy|');
  assert.equal(r('/compact'), null, '내장 명령은 Claude 로');
  assert.equal(r('solo'), null);
  // complete 입력 — 커서가 있는 낱말, 낱말 사이 빈자리는 새 낱말
  assert.deepEqual(completeInput('/roleas wor', 11, 8), { args: ['wor'], index: 0, value: 'wor', raw: 'wor', start: 8, end: 11 });
  assert.deepEqual(completeInput('/roleas a b', 9, 8), { args: ['a', 'b'], index: 0, value: 'a', raw: 'a b', start: 8, end: 9 });
  assert.deepEqual(completeInput('/roleas a ', 10, 8), { args: ['a', ''], index: 1, value: '', raw: 'a ', start: 10, end: 10 });
  assert.deepEqual(completeInput('/roleas ', 8, 8), { args: [''], index: 0, value: '', raw: '', start: 8, end: 8 });
});

/** Messages API 흉내 — 본 대화 요청의 마지막 user 메시지를 모으고 "hi" 로 답한다. 마지막 user 메시지에 SLOW 가 있으면 1.5초 늦게(턴 중을 만든다) */
async function fakeApi() {
  const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
  const sse = [
    ['message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  const turns: string[][] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j: any = null; try { j = JSON.parse(body); } catch {}
      if (req.url?.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
        // 본 대화 요청(도구가 있는 것)만 — 제목 짓기 등은 뺀다
        // 요청의 user·system 글을 순서대로 — 훅 컨텍스트는 Claude 4.x 는 user 메시지 안 사용자 글 앞, 5 계열은 사용자 메시지 바로 뒤 system 메시지다 (CLI 실측, 사용자 결정 2026-11-02 훅 경로 그대로)
        if (j?.stream && j.tools?.length) turns.push(j.messages.filter((m: any) => m.role !== 'assistant').flatMap((m: any) => (typeof m.content === 'string' ? [m.content] : m.content.map((c: any) => c.text ?? `[${c.type}]`))));
        const slow = j?.stream && j.tools?.length && JSON.stringify(j.messages.at(-1)).includes('SLOW');
        if (j?.stream) setTimeout(() => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse), slow ? 1500 : 0);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(msg));
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.includes('count_tokens') ? '{"input_tokens":5}' : '{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, turns, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('core: /roleas 는 턴 없이 돌아 state 를 바꾸고, 보관한 컨텍스트는 다음 턴 요청에 훅 컨텍스트로 한 번 — 내장 명령 이름은 add 가 거르고 /compact 는 Claude 로, 턴 중에 친 명령은 idle 뒤에', { timeout: 180000 }, async () => {
  const api = await fakeApi();
  const saved = { ...process.env };
  const home = tmp('slcode-pc-home-'), dir = tmp('slcode-pc-'), work = tmp('slcode-pc-work-'), src = tmp('slcode-pc-src-');
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const files: Record<string, string> = {
    'slcode-plugin.json': JSON.stringify({ name: 'orch', version: '1.0.0', parts: { main: {} } }),
    'main/commands/roleas/COMMAND.ts': `import { slcode } from 'slcode/api';
      slcode.command({ description: '역할을 정한다', argumentHint: '<역할>',
        complete: (c) => ['orchestrator', 'worker'].filter((r) => r.startsWith(c.value)),
        run: (cmd) => { cmd.state.role = cmd.args; cmd.context(\`ROLE-CONTEXT \${cmd.args}\`); cmd.message(\`역할: \${cmd.args}\`); } });`,
    'main/commands/compact/COMMAND.ts': `import { slcode } from 'slcode/api'; slcode.command({ description: 'x', run: (cmd) => { cmd.state.compacted = true; } });`,
  };
  for (const [rel, body] of Object.entries(files)) { const f = path.join(src, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
  await assert.rejects(addPlugin(src, dir), /command compact has the same name as the Claude built-in command \/compact/, 'add 가 내장 명령 이름을 거른다');
  fs.rmSync(path.join(src, 'main/commands/compact'), { recursive: true });
  await addPlugin(src, dir);
  const h = await runCore({ dir, cwd: work, permissionMode: 'bypassPermissions' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  const evs: any[] = [];
  let wake: (() => void) | null = null;
  const queues: any[][] = [];
  c.onEvent((m: any) => { if (m.event === 'session.queue') queues.push(m.params.items); if (m.event === 'session.event') { evs.push(m.params.ev); wake?.(); } });
  const until = async (ok: () => boolean) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > 60000) throw new Error('timeout'); await new Promise<void>((r) => { wake = r; setTimeout(r, 200); }); } };
  try {
    await c.request('session.attach', { id });
    const list: any[] = await c.request('session.commands', { id });
    assert.deepEqual(list.filter((x) => x.kind === 'command').map((x) => `${x.name} ${x.argumentHint}`), ['orch:roleas <역할>']);
    assert.ok(list.some((x) => x.name === 'compact' && x.builtin), 'SDK 가 내장 명령을 표시한다');
    // SDK 판이 바뀌어 내장 명령이 늘면 여기서 걸린다 — agentFormat.CLAUDE_BUILTIN_COMMANDS 를 그 판의 목록으로 고친다
    const missing = list.filter((x) => x.builtin).flatMap((x) => [x.name, ...(x.aliases ?? [])]).filter((n) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(n) && !CLAUDE_BUILTIN_COMMANDS.has(n));
    assert.deepEqual(missing, [], '정적 목록이 SDK 의 내장 명령을 다 담는다');

    const comp = await c.request('session.completeCommand', { id, text: '/roleas wo' });
    assert.deepEqual(comp, { command: 'orch:roleas', hint: '<역할>', start: 8, end: 10, items: [{ value: 'worker' }], error: null });

    const r = await c.request('session.send', { id, text: '/roleas orchestrator' });
    assert.deepEqual(r.command, { plugin: 'orch', name: 'roleas', outcome: 'ok', error: null });
    await assert.rejects(c.request('session.send', { id, text: '/roleas x', attachments: [{ name: 'a.txt', mediaType: 'text/plain', data: 'eA==' }] }), /첨부와 함께/);
    const run = evs.find((e) => e.kind === 'agent.command' && e.phase === 'run');
    assert.deepEqual([run.name, run.args, run.context, run.messages.map((m: any) => m.text)], ['roleas', 'orchestrator', ['ROLE-CONTEXT orchestrator'], ['역할: orchestrator']]);
    assert.equal(evs.filter((e) => e.kind === 'turn.start').length, 0, '턴이 아니다');
    assert.equal(api.turns.length, 0, '모델을 부르지 않았다');

    const ends = () => evs.filter((e) => e.kind === 'turn.end').length;
    await c.request('session.send', { id, text: 'USER-ONE' });
    await until(() => ends() === 1);
    const first = api.turns.at(-1)!;
    assert.ok(first.some((t) => /UserPromptSubmit hook additional context: ROLE-CONTEXT orchestrator/.test(t)) && first.includes('USER-ONE'), `보관분이 첫 턴 요청에 훅 컨텍스트로: ${JSON.stringify(first).slice(0, 400)}`);
    assert.ok(evs.some((e) => e.kind === 'agent.command' && e.phase === 'attached'));
    await c.request('session.send', { id, text: 'USER-TWO' });
    await until(() => ends() === 2);
    const second = api.turns.at(-1)!;
    assert.ok(second.includes('USER-TWO'));
    assert.ok(second.filter((t) => /ROLE-CONTEXT/.test(t)).length <= 1, '두 번째 턴에 새로 붙지 않는다 — 첫 턴 것이 대화 기록에 남을 뿐');

    // /compact 는 Claude 의 /compact 로 간다(턴)
    await c.request('session.send', { id, text: '/compact' });
    await until(() => ends() === 3);
    assert.ok(!evs.some((e) => e.kind === 'agent.command' && e.phase === 'run' && e.name === 'compact'));

    // 턴 중에 친 명령은 idle 로 돌아온 뒤에 돈다 — 그 뒤에 친 메시지도 명령 뒤에 서서 바뀐 역할로 돈다 (사용자 결정 2026-11-02)
    await c.request('session.send', { id, text: 'SLOW-ONE' });
    await until(() => evs.some((e) => e.kind === 'turn.start' && e.text === 'SLOW-ONE'));
    const q = await c.request('session.send', { id, text: '/roleas worker' });
    assert.deepEqual(q.command, { plugin: 'orch', name: 'roleas', queued: true });
    await c.request('session.send', { id, text: 'USER-AFTER' });
    assert.deepEqual(queues.at(-1).map(({ id, ...x }: any) => (assert.ok(id), x)), [{ kind: 'command', text: '/roleas worker' }, { kind: 'message', text: 'USER-AFTER' }], '큐 전체를 순서대로 알린다');
    assert.deepEqual((await c.request('session.attach', { id })).queue, queues.at(-1), '다시 붙어도 큐를 받는다');
    assert.ok(!evs.some((e) => e.kind === 'turn.start' && e.text === 'USER-AFTER'), '기다리는 명령 뒤에 선 메시지는 아직 넣지 않는다');
    await until(() => ends() === 5);
    const at = (f: (e: any) => boolean) => evs.findIndex(f);
    const slowEnd = at((e) => e.kind === 'turn.end' && evs.indexOf(e) > at((x) => x.kind === 'turn.start' && x.text === 'SLOW-ONE'));
    const ran = at((e) => e.kind === 'agent.command' && e.phase === 'run' && e.args === 'worker');
    const after = at((e) => e.kind === 'turn.start' && e.text === 'USER-AFTER');
    assert.ok(slowEnd < ran && ran < after, `순서: 턴 끝 ${slowEnd} < 명령 ${ran} < 다음 메시지 ${after}`);
    assert.ok(api.turns.at(-1)!.some((t) => /ROLE-CONTEXT worker/.test(t)), '뒤에 선 메시지 턴에 바뀐 역할의 보관분이 붙는다');
    assert.deepEqual(queues.at(-1), [], '처리되면 큐가 빈다');
  } finally {
    c.close(); await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const sessions = path.join(dir, 'sessions');
  const stateFile = fs.readdirSync(sessions).flatMap((s) => fs.readdirSync(path.join(sessions, s)).map((i) => path.join(sessions, s, i, 'agent-state', 'orch.json'))).find((f) => fs.existsSync(f))!;
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { role: 'worker' });
});
