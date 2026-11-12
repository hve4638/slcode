// 대화 되돌리기는 벤더 재기동을 기다리지 않는다 (ticket slcode-rewind-latency) — 옛 claude 가 내려가는 0.5초쯤을 뒤에서 기다리고,
// 그사이 보낸 턴·이어 부른 되돌리기는 새 프로세스가 받는다. 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Messages API 흉내 — 마지막 user 글에 WRITE <파일> 이 있으면 Write 도구로 그 파일을 만들고, 도구 결과 뒤엔 "done", 그 밖은 "hi". 요청마다 모델에 간 user 글 전체를 모은다 */
async function fakeApi(work: string) {
  let m = 0, n = 0;
  const sse = (content: any[], stop: string) => {
    const ev: [string, unknown][] = [['message_start', { type: 'message_start', message: { id: `msg_${++m}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }]];
    content.forEach((c, i) => {
      if (c.type === 'text') ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } }], ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: c.text } }]);
      else ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: c.id, name: 'Write', input: {} } }], ['content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }]);
      ev.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
    });
    ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]);
    return ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  };
  const seen: string[][] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j: any = null; try { j = JSON.parse(body); } catch {}
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":5}'); return; }
      if (!j?.stream || !j.tools?.length) { res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse([{ type: 'text', text: 'title' }], 'end_turn')); return; }
      const user = j.messages.filter((x: any) => x.role === 'user').flatMap((x: any) => (typeof x.content === 'string' ? [{ type: 'text', text: x.content }] : x.content));
      seen.push(user.filter((c: any) => c.type === 'text').map((c: any) => c.text));
      const last = j.messages.findLast((x: any) => x.role === 'user'), parts = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
      const w = parts.map((p: any) => p.text ?? '').join('\n').match(/WRITE (\S+)/);
      const out = parts.some((p: any) => p.type === 'tool_result') ? sse([{ type: 'text', text: 'done' }], 'end_turn')
        : w ? sse([{ type: 'tool_use', id: `toolu_${++n}`, input: { file_path: path.join(work, w[1]), content: 'x\n' } }], 'tool_use')
        : sse([{ type: 'text', text: 'hi' }], 'end_turn');
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(out);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, seen, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('claude: 대화 되돌리기는 재기동을 기다리지 않고 돌아오며, 바로 보낸 턴과 이어 부른 되돌리기는 새 프로세스가 받는다', { timeout: 180000 }, async () => {
  const work = tmp('slcode-rw-work-');
  const api = await fakeApi(work);
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-rw-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await runCore({ dir: tmp('slcode-rw-'), cwd: work, permissionMode: 'bypassPermissions' } as any);
  const c = await connectSession(h.sock);
  const id = h.session.id;
  const evs: any[] = [];
  let wake: (() => void) | null = null;
  c.onEvent((x: any) => { if (x.event === 'session.event') evs.push(x.params); wake?.(); });
  const until = async (ok: () => boolean, what: string) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > 60000) throw new Error(`timeout ${what}`); await new Promise<void>((r) => { wake = r; setTimeout(r, 100).unref(); }); } };
  const ends = () => evs.filter((e) => e.ev.kind === 'turn.end').length;
  const turn = async (text: string) => { const want = ends() + 1; await c.request('session.send', { id, text }); await until(() => ends() >= want, text); };
  try {
    await c.request('session.attach', { id });
    await turn('WRITE a.txt one');
    await turn('talk two');
    await turn('talk three');
    const seqOf = (text: string) => evs.find((e) => e.ev.kind === 'turn.start' && e.ev.text === text).seq;
    assert.ok(fs.existsSync(path.join(work, 'a.txt')), JSON.stringify(evs.map((e) => [e.ev.kind, e.ev.text ?? e.ev.message ?? e.ev.error ?? e.ev.name ?? ''])));

    // 1. 대화만 — 옛 프로세스가 내려가길(0.5초쯤) 기다리지 않는다
    const t0 = performance.now();
    await c.request('session.rewind', { id, seq: seqOf('talk three'), conversation: true, files: false });
    const ms = performance.now() - t0;
    assert.ok(ms < 300, `rewind took ${ms.toFixed(0)}ms`);
    assert.ok(evs.some((e) => e.ev.kind === 'turn.rewound'));

    // 2. 바로 보낸 턴은 새 프로세스가 되돌린 대화에서 받는다
    await turn('talk four');
    assert.equal(evs.filter((e) => e.ev.kind === 'turn.end').at(-1).ev.ok, true);
    const sent = api.seen.at(-1)!.join('\n');
    assert.ok(sent.includes('talk two') && sent.includes('talk four') && !sent.includes('talk three'), sent);

    // 3. 대화 되돌리기 바로 뒤의 미리 보기·코드 되돌리기 — 재기동이 끝나길 기다려 새 프로세스에 묻는다
    await c.request('session.rewind', { id, seq: seqOf('talk four'), conversation: true, files: false });
    const p = await c.request('session.rewindPreview', { id, seq: seqOf('WRITE a.txt one') });
    assert.deepEqual(p.files?.changed.map((f: string) => path.basename(f)), ['a.txt']);
    await c.request('session.rewind', { id, seq: seqOf('WRITE a.txt one'), conversation: false, files: true });
    assert.ok(!fs.existsSync(path.join(work, 'a.txt')), '코드 되돌리기로 a.txt 가 사라진다');
  } finally {
    c.close();
    await h.close();
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
