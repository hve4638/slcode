// 턴 중 메시지 대기 말풍선 (ticket slcode-queued-message-bubble, 사용자 결정 2026-11-08) — 벤더와 상관없이 core 가 idle 까지 쥐고 하나씩 한 턴으로 보낸다,
// 그때까지 session.queue 에 보인다. 누르면(session.unqueue) 빠지고, 중단·턴을 끝내는 거절이면 거둬 session.restored 로, 닫으면 입력 초안으로.
// Claude 는 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const FAKE_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs');

/** Messages API 흉내 — 마지막 assistant 뒤의 user 글에 TOOL 이 있으면 Bash(sleep 2) 도구를 부르고, 도구 결과 뒤엔 "done", SLOW 면 2초 늦게 "hi", 그 밖은 바로 "hi". 요청마다 그 user 글을 모은다 */
async function fakeApi() {
  let m = 0; // 응답마다 다른 id — 같으면 CLI 가 한 assistant 메시지로 합친다
  const sse = (content: any[], stop: string) => {
    const ev: [string, unknown][] = [['message_start', { type: 'message_start', message: { id: `msg_${++m}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }]];
    content.forEach((c, i) => {
      if (c.type === 'text') ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text } }]);
      else ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: 'Bash', input: {} } }], ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }]);
      ev.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
    });
    ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]);
    return ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  };
  const turns: string[][] = [];
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j: any = null; try { j = JSON.parse(body); } catch {}
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":5}'); return; }
      if (!j?.stream || !j.tools?.length) { res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse([{ type: 'text', text: 'title' }], 'end_turn')); return; }
      const tail = j.messages.slice(j.messages.map((m: any) => m.role).lastIndexOf('assistant') + 1)
        .flatMap((m: any) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content));
      const texts = tail.map((c: any) => c.text ?? `[${c.type}]`);
      turns.push(texts);
      const all = texts.join('\n');
      let out: string, delay = 0;
      const lastTool = texts.findLastIndex((x: string) => /\bTOOL\b/.test(x)), lastResult = texts.lastIndexOf('[tool_result]');
      if (lastResult > lastTool) out = sse([{ type: 'text', text: 'done' }], 'end_turn');
      else if (lastTool >= 0) out = sse([{ type: 'tool_use', id: `toolu_${++n}`, input: { command: 'sleep 2; echo ok', description: 'wait' } }], 'tool_use');
      else { out = sse([{ type: 'text', text: 'hi' }], 'end_turn'); if (/\bSLOW\b/.test(all)) delay = 2000; }
      setTimeout(() => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(out), delay);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, turns, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

async function open(opts: Record<string, unknown>) {
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await runCore(opts as any);
  const c = await connectSession(h.sock);
  const id = h.session.id;
  const evs: any[] = [], queues: any[][] = [], restored: any[] = [];
  let wake: (() => void) | null = null;
  c.onEvent((m: any) => {
    if (m.event === 'session.queue') queues.push(m.params.items.map((q: any) => q.text));
    if (m.event === 'session.restored') restored.push(m.params);
    if (m.event === 'session.event') evs.push(m.params.ev);
    wake?.();
  });
  const until = async (ok: () => boolean, what = '') => { const t = Date.now(); while (!ok()) { if (Date.now() - t > 60000) throw new Error(`timeout ${what} ${JSON.stringify(evs.slice(-12).map((e) => [e.kind, e.text ?? e.state ?? e.name ?? e.error ?? ""]))}`); await new Promise<void>((r) => { wake = r; setTimeout(r, 100); }); } };
  const att = await c.request('session.attach', { id });
  return { h, c, id, evs, queues, restored, until, att };
}

const env = (url: string, home: string) => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: url, SLCODE_GRACE_SECS: '1' });
  return () => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); };
};

test('claude: 턴 중 메시지는 도구 결과에 끼지 않고 대기에 보였다가 idle 에서 하나씩 한 턴 — 누르면 빠지고, 중단하면 입력창으로, 닫으면 초안으로', { timeout: 240000 }, async () => {
  const api = await fakeApi();
  const restore = env(api.url, tmp('slcode-qm-home-'));
  const dir = tmp('slcode-qm-'), work = tmp('slcode-qm-work-');
  let s = await open({ dir, cwd: work, permissionMode: 'bypassPermissions' });
  const { id } = s;
  try {
    const starts = () => s.evs.filter((e) => e.kind === 'turn.start').map((e) => e.text);
    const ends = () => s.evs.filter((e) => e.kind === 'turn.end').length;
    const idle = () => s.evs.filter((e) => e.kind === 'session.state').at(-1)?.state === 'idle';

    // 1. 도구를 쓰는 턴 — 도구가 도는 사이 보낸 두 메시지는 도구 결과에 끼지 않고, 턴이 끝난 뒤 하나씩 따로 한 턴
    await s.c.request('session.send', { id, text: 'TOOL one' });
    await s.until(() => s.evs.some((e) => e.kind === 'tool.start'), 'tool.start');
    await s.c.request('session.send', { id, text: 'MID-A' });
    await s.c.request('session.send', { id, text: 'MID-B' });
    assert.deepEqual(s.queues.at(-1), ['MID-A', 'MID-B']);
    assert.deepEqual((await s.c.request('session.attach', { id })).queue.map((q: any) => q.text), ['MID-A', 'MID-B'], '다시 붙어도 대기를 받는다');
    await s.until(() => ends() === 3 && idle(), 'turn 3 end');
    assert.deepEqual(starts(), ['TOOL one', 'MID-A', 'MID-B']);
    const at = (f: (e: any) => boolean) => s.evs.findIndex(f);
    assert.ok(at((e) => e.kind === 'turn.end') < at((e) => e.kind === 'turn.start' && e.text === 'MID-A'), '첫 턴이 끝난 뒤에 들어간다');
    const said = api.turns.map((t) => t.filter((x) => x.startsWith('MID-')).join('|'));
    assert.ok(!said[api.turns.findIndex((t) => t.includes('[tool_result]'))], '도구 결과와 함께 가지 않았다');
    assert.equal(said.find((x) => x.includes('MID-A')), 'MID-A', '한 턴에 하나씩');
    assert.deepEqual(s.queues.at(-1), [], '보내면 대기가 빈다');

    // 2. 글만 쓰는 턴 — 둘 보내고 하나를 빼면 남은 하나만 그 턴 뒤 새 턴으로
    const sent = api.turns.length;
    await s.c.request('session.send', { id, text: 'SLOW two' });
    await s.until(() => starts().includes('SLOW two'));
    await s.c.request('session.send', { id, text: 'KEEP-A' });
    await s.c.request('session.send', { id, text: 'DROP-B' });
    await s.until(() => s.queues.at(-1)?.length === 2, 'queue 2');
    const q = (await s.c.request('session.attach', { id })).queue;
    assert.deepEqual(await s.c.request('session.unqueue', { id, item: q[1].id }), { text: 'DROP-B', attachments: [] });
    assert.deepEqual(s.queues.at(-1), ['KEEP-A']);
    await assert.rejects(s.c.request('session.unqueue', { id, item: q[1].id }), /already being processed/, '없는 항목');
    await s.until(() => ends() === 5 && idle(), 'turn 5 end');
    assert.deepEqual(starts().slice(3), ['SLOW two', 'KEEP-A']);
    assert.ok(!api.turns.slice(sent).flat().some((x) => x.includes('DROP-B')), '뺀 메시지는 모델에 가지 않았다');

    // 3. 중단 — 대기 메시지는 거둬 session.restored 로, 모델에 가지 않는다
    await s.c.request('session.send', { id, text: 'TOOL three' });
    await s.until(() => s.evs.filter((e) => e.kind === 'tool.start').length === 2);
    await s.c.request('session.send', { id, text: 'BACK-C' });
    await s.until(() => s.queues.at(-1)?.[0] === 'BACK-C');
    await s.c.request('session.interrupt', { id });
    await s.until(() => s.restored.length === 1 && ends() === 6 && idle(), 'interrupt');
    assert.deepEqual(s.restored[0], { id, text: 'BACK-C', attachments: [] });
    assert.deepEqual(s.queues.at(-1), []);
    assert.ok(!starts().includes('BACK-C'));
    assert.equal((await s.c.request('session.attach', { id })).draft, 'BACK-C', '입력 초안에도 붙는다');
    await s.c.request('session.setDraft', { id, text: 'typing' });

    // 4. 닫기 — 남은 대기 메시지는 초안 앞으로, 다시 열면 입력창에(보내지 않는다)
    await s.c.request('session.send', { id, text: 'TOOL four' });
    await s.until(() => s.evs.filter((e) => e.kind === 'tool.start').length === 3);
    await s.c.request('session.send', { id, text: 'LEFT-D' });
    await s.until(() => s.queues.at(-1)?.[0] === 'LEFT-D');
    s.c.close(); await s.h.close('test');
    s = await open({ dir, cwd: work, resume: id });
    assert.equal(s.att.draft, 'LEFT-D\ntyping');
    assert.deepEqual(s.att.queue, []);
  } finally {
    s.c.close(); await s.h.close('test');
    api.srv.close();
    restore();
  }
});

test('codex: 턴 중 메시지는 core 가 쥐고 있다가 idle 에서 보낸다 — 중단·턴을 끝내는 거절이면 입력창으로', { timeout: 90000 }, async () => {
  const restore = env('http://127.0.0.1:9', tmp('slcode-qmc-home-'));
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE_CODEX}`;
  const s = await open({ dir: tmp('slcode-qmc-'), cwd: tmp('slcode-qmc-work-'), vendor: 'codex' });
  const { id } = s;
  try {
    const starts = () => s.evs.filter((e) => e.kind === 'turn.start').map((e) => e.text);
    const asked = () => s.evs.filter((e) => e.kind === 'approval.requested');
    await s.c.request('session.send', { id, text: 'one' });
    await s.until(() => asked().length === 1, 'ask1');
    await s.c.request('session.send', { id, text: 'MID' });
    assert.deepEqual(s.queues.at(-1), ['MID']);
    assert.deepEqual(starts(), ['one'], '턴 중에는 넣지 않는다');
    await s.c.request('session.approve', { id, requestId: asked()[0].requestId, decision: 'allow' });
    await s.until(() => asked().length === 2, 'second turn');
    assert.deepEqual(starts(), ['one', 'MID']);
    assert.deepEqual(s.queues.at(-1), []);
    await s.c.request('session.send', { id, text: 'BACK' });
    await s.c.request('session.interrupt', { id });
    await s.until(() => s.restored.length === 1, `restored ${JSON.stringify(starts())} ${JSON.stringify(s.queues)}`);
    assert.deepEqual(s.restored[0], { id, text: 'BACK', attachments: [] });
    assert.deepEqual(s.queues.at(-1), []);
    const idleAfter = (n: number) => s.until(() => s.evs.filter((e) => e.kind === 'turn.end').length >= n && s.evs.filter((e) => e.kind === 'session.state').at(-1)?.state === 'idle', `idle ${n}`);
    await idleAfter(2);
    assert.deepEqual(starts(), ['one', 'MID']);
    // 승인 카드의 Esc·거절(deny+interrupt)도 Stop 과 같다 (ticket slcode-question-esc-chat)
    await s.c.request('session.send', { id, text: 'three' });
    await s.until(() => asked().length === 3, 'ask3');
    await s.c.request('session.send', { id, text: 'BACK2' });
    await s.c.request('session.approve', { id, requestId: asked()[2].requestId, decision: 'deny', interrupt: true });
    assert.deepEqual(s.restored[1], { id, text: 'BACK2', attachments: [] });
    assert.deepEqual(s.queues.at(-1), []);
    await idleAfter(3);
    assert.deepEqual(starts(), ['one', 'MID', 'three'], '거둔 메시지는 보내지 않는다');
  } finally {
    delete process.env.SLCODE_CODEX_BIN;
    s.c.close(); await s.h.close('test');
    restore();
  }
});
