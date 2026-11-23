// background 도구의 Claude 길 (ticket slcode-background-run-tool) — 모든 Claude 세션에 mcp__slcode__BackgroundRun 이 실리고, 승인 요청 모드에서는 Bash 처럼 승인을 묻는다.
// 허용하면 CLI 가 띄우고, 끝나면 idle 리더가 kind=exited 메일로 턴을 연다. 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음). dist 를 빌드한 뒤에 돈다 (도구가 dist/cli.js 를 부른다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Messages API 흉내 — "BG" 면 BackgroundRun 을 부르고, 도구 결과 뒤엔 "started", 메일(task 끝)엔 "notified". 받은 도구 이름을 모은다 */
async function fakeApi() {
  let m = 0;
  const tools = new Set<string>();
  const results: string[] = [];
  const sse = (block: any, stop: string) => {
    const start = block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} };
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
      for (const t of j.tools) tools.add(t.name);
      const parts = j.messages.slice(j.messages.map((x: any) => x.role).lastIndexOf('assistant') + 1)
        .flatMap((x: any) => (typeof x.content === 'string' ? [{ type: 'text', text: x.content }] : x.content));
      const text = parts.map((c: any) => c.text ?? '').join('\n');
      const result = parts.find((c: any) => c.type === 'tool_result');
      if (result) results.push(JSON.stringify(result.content));
      const out = result ? sse({ type: 'text', text: 'started' }, 'end_turn')
        : /\bBG\b/.test(text) ? sse({ type: 'tool_use', id: 'toolu_bg', name: 'mcp__slcode__BackgroundRun', input: { command: 'sleep 1; exit 6', description: 'wait a bit' } }, 'tool_use')
        : sse({ type: 'text', text: 'notified' }, 'end_turn');
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(out);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, tools, results, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('claude: BackgroundRun 은 승인 요청 모드에서 승인을 묻고, 허용하면 띄워 id 를 돌려주며, 끝나면 idle 세션이 kind=exited 메일로 턴을 연다', { timeout: 120000 }, async () => {
  const api = await fakeApi();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  const dir = tmp('slcode-bgc-');
  Object.assign(process.env, { HOME: tmp('slcode-bgc-home-'), SLCODE_DIR: dir, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1', SLCODE_CLAUDE_PEER: '0' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  // 팀원을 만들지 못하는 세션에도 실린다
  const h = await runCore({ dir, cwd: tmp('slcode-bgc-work-'), permissionMode: 'default', noTeam: true } as any);
  const c = await connectSession(h.sock);
  const id = h.session.id;
  const evs: any[] = [];
  c.onEvent((m: any) => { if (m.event === 'session.event') evs.push(m.params.ev); });
  const until = async (ok: () => boolean, what: string) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > 60000) throw new Error(`timeout ${what} ${JSON.stringify(evs.slice(-8).map((e) => [e.kind, e.state ?? e.name ?? '']))}`); await new Promise((r) => setTimeout(r, 100)); } };
  try {
    await c.request('session.attach', { id });
    await c.request('session.send', { id, text: 'BG go' });
    await until(() => evs.some((e) => e.kind === 'approval.requested'), 'approval');
    const ask = evs.find((e) => e.kind === 'approval.requested');
    assert.equal(ask.name, 'mcp__slcode__BackgroundRun');
    assert.deepEqual(ask.input, { command: 'sleep 1; exit 6', description: 'wait a bit' });
    assert.ok(api.tools.has('mcp__slcode__BackgroundRun') && api.tools.has('mcp__slcode__BackgroundStop'));
    assert.ok(!api.tools.has('mcp__slcode__Subagent'), '팀원 도구는 팀원을 만들 수 있는 세션에만');
    await c.request('session.approve', { id, requestId: ask.requestId, decision: 'allow' });
    await until(() => evs.filter((e) => e.kind === 'turn.end').length === 1, 'first turn');
    const tid = /Background task ([0-9a-f]{8}) started\. Output: (\S+)/.exec(api.results[0] ?? '');
    assert.ok(tid, api.results[0]);
    await until(() => evs.filter((e) => e.kind === 'turn.end').length === 2 && evs.filter((e) => e.kind === 'session.state').at(-1)?.state === 'idle', 'exited mail turn');
    const mail = evs.filter((e) => e.kind === 'turn.start').at(-1);
    assert.equal(mail.origin, 'mail');
    assert.match(mail.text, new RegExp(`from="bg:${tid[1]}"[^>]*kind="exited"[^>]*>\\nBackground task ${tid[1]} \\("wait a bit"\\) exited with code 6\\.`));
    assert.ok(evs.some((e) => e.kind === 'text.delta' && e.text === 'notified'));
  } finally {
    c.close(); await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
