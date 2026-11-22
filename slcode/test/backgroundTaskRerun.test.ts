// background task 가 끝나 Claude Code 가 스스로 연 턴도 running 을 거친다 (ticket slcode-background-task-rerun-state).
// 그 턴은 send() 를 거치지 않고, SDK 는 CLI 의 session_state_changed 를 자기만 읽고 넘기지 않는다 (SDK 0.3.322 실측 2026-11-22).
// Claude 는 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Messages API 흉내 — BG 면 Bash(sleep 1) 를 background 로 부르고, 도구 결과 뒤엔 "started", 그 밖(task 알림)은 "notified" */
async function fakeApi() {
  let m = 0;
  const sse = (block: any, stop: string) => {
    const start = block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: 'Bash', input: {} };
    const delta = block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) };
    const ev: [string, unknown][] = [
      ['message_start', { type: 'message_start', message: { id: `msg_${++m}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: start }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j: any = null; try { j = JSON.parse(body); } catch {}
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":5}'); return; }
      if (!j?.stream || !j.tools?.length) { res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse({ type: 'text', text: 'title' }, 'end_turn')); return; }
      // 마지막 assistant 뒤의 user 글 전부 — CLI 는 사용자 글과 환경 안내를 따로 싣는다
      const parts = j.messages.slice(j.messages.map((m: any) => m.role).lastIndexOf('assistant') + 1)
        .flatMap((m: any) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content));
      const text = parts.map((c: any) => c.text ?? '').join('\n');
      const out = parts.some((c: any) => c.type === 'tool_result') ? sse({ type: 'text', text: 'started' }, 'end_turn')
        : /\bBG\b/.test(text) ? sse({ type: 'tool_use', id: 'toolu_bg', input: { command: 'sleep 1; echo ok', description: 'wait', run_in_background: true } }, 'tool_use')
        : sse({ type: 'text', text: 'notified' }, 'end_turn');
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(out);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('claude: background task 가 끝나 스스로 열린 턴도 running 을 거쳐 idle 로 끝난다', { timeout: 120000 }, async () => {
  const api = await fakeApi();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-bg-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await runCore({ dir: tmp('slcode-bg-'), cwd: tmp('slcode-bg-work-'), permissionMode: 'bypassPermissions' } as any);
  const c = await connectSession(h.sock);
  const id = h.session.id;
  const evs: any[] = [];
  let wake: (() => void) | null = null;
  c.onEvent((m: any) => { if (m.event === 'session.event') evs.push(m.params.ev); wake?.(); });
  const until = async (ok: () => boolean, what: string) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > 60000) throw new Error(`timeout ${what} ${JSON.stringify(evs.slice(-12).map((e) => [e.kind, e.state ?? e.phase ?? e.reason ?? e.message ?? '']))}`); await new Promise<void>((r) => { wake = r; setTimeout(r, 100); }); } };
  try {
    await c.request('session.attach', { id });
    await c.request('session.send', { id, text: 'BG go' });
    const ends = () => evs.filter((e) => e.kind === 'turn.end');
    await until(() => ends().length === 2 && evs.filter((e) => e.kind === 'session.state').at(-1)?.state === 'idle', 'second turn end');
    const at = (f: (e: any) => boolean, from = 0) => evs.findIndex((e, i) => i >= from && f(e));
    const taskEnded = at((e) => e.kind === 'task' && e.phase === 'ended');
    const firstEnd = at((e) => e.kind === 'turn.end');
    assert.ok(firstEnd >= 0 && taskEnded > firstEnd, '첫 턴이 끝난 뒤 task 가 끝났다');
    assert.equal(evs.filter((e) => e.kind === 'turn.start').length, 1, '두 번째 턴은 보낸 것이 아니다');
    const states = (from: number, to: number) => evs.slice(from, to).filter((e) => e.kind === 'session.state').map((e) => e.state);
    const secondEnd = at((e) => e.kind === 'turn.end', firstEnd + 1);
    assert.deepEqual(states(firstEnd, secondEnd + 1), ['idle', 'running'], '첫 턴 끝에 idle, 스스로 열린 턴이 running');
    assert.equal(states(secondEnd, evs.length).at(-1), 'idle');
    assert.ok(at((e) => e.kind === 'session.state' && e.state === 'running', taskEnded) < at((e) => e.kind === 'text.delta', taskEnded), '답이 흐르기 전에 running');
  } finally {
    c.close(); await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
