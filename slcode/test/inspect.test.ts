// inspect proxy (ticket slcode-inspect-proxy) — 가짜 업스트림으로. 실제 API·Claude 세션은 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { inspectEnv, readCall, startInspect, turnCalls, upstreamOf } from '../src/inspect.ts';
import type { LoggedEvent } from '../src/protocol.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-inspect-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** gzip SSE 를 청크 셋으로 나눠 사이에 쉬면서 보내는 업스트림 */
async function fakeUpstream(seen: { path?: string; auth?: string; body?: string }[]) {
  const sse = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"안녕"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const gz = zlib.gzipSync(sse);
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      seen.push({ path: req.url, auth: req.headers.authorization, body });
      if (req.url?.includes('json')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'anthropic-ratelimit-unified-5h-utilization': '0.09' });
      const third = Math.ceil(gz.length / 3);
      for (let i = 0; i < 3; i++) { res.write(gz.subarray(i * third, (i + 1) * third)); await sleep(150); }
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, sse, gz };
}

test('inspect: 응답을 도착하는 대로 그대로 넘기고, 기록은 풀어서·인증은 가려서', async () => {
  const seen: { path?: string; auth?: string; body?: string }[] = [];
  const up = await fakeUpstream(seen);
  const dir = tmp();
  const proxy = await startInspect(dir, up.url + '/prefix');
  const body = JSON.stringify({ model: 'claude-haiku-4-5', stream: true, messages: [{ role: 'user', content: 'hi' }] });
  const t0 = Date.now();
  const got = await new Promise<{ firstMs: number; bytes: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(`${proxy.url}/v1/messages?beta=true`, { method: 'POST', headers: { authorization: 'Bearer sk-ant-oat01-SECRETSECRET', 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = []; let firstMs = -1;
      res.on('data', (c: Buffer) => { if (firstMs < 0) firstMs = Date.now() - t0; chunks.push(c); });
      res.on('end', () => resolve({ firstMs, bytes: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const totalMs = Date.now() - t0;
  // 업스트림은 청크 사이에 150ms 씩 쉰다 — 첫 청크가 끝보다 한참 먼저 와야 버퍼링하지 않은 것
  assert.ok(got.firstMs < totalMs - 200, `first chunk ${got.firstMs}ms vs end ${totalMs}ms`);
  assert.deepEqual(got.bytes, up.gz, '압축된 바이트를 그대로 넘긴다');
  assert.equal(got.headers['content-encoding'], 'gzip');
  assert.equal(seen[0].path, '/prefix/v1/messages?beta=true', '업스트림 경로 앞부분을 잇는다');
  assert.equal(seen[0].auth, 'Bearer sk-ant-oat01-SECRETSECRET', '업스트림에는 인증을 그대로');
  assert.equal(seen[0].body, body);

  await sleep(50);
  const rec = readCall(dir, 1)!;
  assert.equal(rec.resBody, up.sse, '기록은 압축을 푼 SSE 원문');
  assert.equal(rec.reqBody, body);
  assert.equal(rec.model, 'claude-haiku-4-5');
  assert.equal(rec.status, 200);
  assert.equal(rec.reqHeaders.authorization, 'Bearer sk-ant-oat01-…(redacted)');
  assert.ok(!fs.readFileSync(path.join(dir, '1.json'), 'utf8').includes('SECRET'), '파일에 비밀이 남지 않는다');
  assert.equal(rec.resHeaders['anthropic-ratelimit-unified-5h-utilization'], '0.09');
  const idx = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(idx.length, 1);
  assert.equal(idx[0].n, 1);
  assert.equal(idx[0].reqBody, undefined, 'index 에는 요약만');
  await proxy.close();
  up.srv.close();
});

test('inspect: 상한을 넘으면 오래된 호출부터 지우고, 재기동해도 번호를 잇는다', async () => {
  const up = await fakeUpstream([]);
  const dir = tmp();
  const call = (url: string) => new Promise<void>((resolve) => http.request(`${url}/json`, { method: 'POST' }, (res) => { res.resume(); res.on('end', () => resolve()); }).end('x'.repeat(5000)));
  let proxy = await startInspect(dir, up.url, 11500); // 한 건이 5KB 남짓 — 둘까지만 남는다
  for (let i = 0; i < 3; i++) { await call(proxy.url); await sleep(20); }
  await proxy.close();
  proxy = await startInspect(dir, up.url, 11500);
  await call(proxy.url); await sleep(20);
  await proxy.close();
  up.srv.close();
  const files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).sort();
  assert.deepEqual(files, ['3.json', '4.json']);
  assert.equal(readCall(dir, 1), null);
  const ends: LoggedEvent[] = [{ seq: 9, at: Date.now() + 1000, ev: { kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: null, durationMs: null, usage: null, userUuid: null, uuid: null } }];
  const calls = turnCalls(dir, ends, 9);
  assert.deepEqual(calls.map((c) => [c.n, !!c.dropped]), [[1, true], [2, true], [3, false], [4, false]]);
});

test('inspect: 턴 귀속은 앞 turn.end 뒤부터 그 turn.end 까지', () => {
  const dir = tmp();
  const line = (n: number, at: number) => JSON.stringify({ n, at, ms: 1, method: 'POST', path: '/v1/messages', model: null, status: 200, reqBytes: 1, resBytes: 1 });
  fs.writeFileSync(path.join(dir, 'index.jsonl'), [line(1, 5), line(2, 15), line(3, 20), line(4, 25), line(5, 40)].join('\n') + '\n');
  for (const n of [1, 2, 3, 4, 5]) fs.writeFileSync(path.join(dir, `${n}.json`), '{}');
  const end = (seq: number, at: number): LoggedEvent => ({ seq, at, ev: { kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: null, durationMs: null, usage: null, userUuid: null, uuid: null } });
  const evs: LoggedEvent[] = [{ seq: 1, at: 10, ev: { kind: 'turn.start', text: 'a', origin: null } }, end(2, 20), end(3, 30)];
  assert.deepEqual(turnCalls(dir, evs, 2).map((c) => c.n), [1, 2, 3], '첫 턴은 기동 호출까지');
  assert.deepEqual(turnCalls(dir, evs, 3).map((c) => c.n), [4]);
  assert.deepEqual(turnCalls(dir, evs, 99), []);
});

test('inspect: 1st party 판정을 지키는 env', () => {
  assert.deepEqual(inspectEnv({ HOME: '/h' }, 'http://127.0.0.1:1'), { HOME: '/h', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1', ENABLE_TOOL_SEARCH: 'true' });
  assert.equal(inspectEnv({ ENABLE_TOOL_SEARCH: 'auto:5' }, 'http://p').ENABLE_TOOL_SEARCH, 'auto:5', '사용자가 정한 값은 그대로');
  assert.equal(inspectEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, 'http://p')._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '1');
  const gw = inspectEnv({ ANTHROPIC_BASE_URL: 'https://gw.example/anthropic' }, 'http://p');
  assert.equal(gw.ANTHROPIC_BASE_URL, 'http://p');
  assert.equal(gw._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, undefined, '다른 게이트웨이를 쓰던 사용자는 원래대로 3rd party');
  assert.equal(gw.ENABLE_TOOL_SEARCH, undefined);
  assert.equal(upstreamOf({ ANTHROPIC_BASE_URL: 'https://gw.example/anthropic' }), 'https://gw.example/anthropic');
  assert.equal(upstreamOf({}), 'https://api.anthropic.com');
});

/** Messages API 흉내 — 스트림이면 SSE 로 "hi" 한 마디, 아니면 JSON. 실제 claude CLI 가 이리로 온다 (가짜 키, API 비용 없음) */
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
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push(`${req.method} ${req.url}`);
      let stream = false; try { stream = !!JSON.parse(body).stream; } catch {}
      if (req.url?.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
        if (stream) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(msg));
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.includes('count_tokens') ? '{"input_tokens":5}' : '{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, hits, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('inspect: core 가 claude 의 API 호출을 턴에 묶어 남기고, 끄고 켜면 claude 를 다시 띄운다', { timeout: 120000 }, async () => {
  const api = await fakeApi();
  const saved = { ...process.env };
  const home = tmp(), dir = tmp(), work = tmp();
  // core 는 모듈을 읽을 때 env 를 잡는다 — 그 전에 격리 env 를 깐다 (로그인 없는 HOME + 가짜 키 + 가짜 게이트웨이)
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await runCore({ dir, cwd: work, inspect: true, permissionMode: 'bypassPermissions' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  try {
    const ends: number[] = [];
    let wake: (() => void) | null = null;
    c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') { ends.push(m.params.seq); wake?.(); } });
    await c.request('session.attach', { id });
    const turn = async (text: string) => { const n = ends.length; await c.request('session.send', { id, text }); while (ends.length === n) await new Promise<void>((r) => (wake = r)); return ends[ends.length - 1]; };
    const stored = () => EventLog.open(corePaths(dir).sessionsDir, id)!;
    const idx = () => { try { return fs.readFileSync(path.join(stored().dir, 'inspect', 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };

    const t1 = await turn('hello');
    const calls = (await c.request('session.inspectTurn', { id, end: t1 })).calls;
    const msg = calls.find((x) => x.path.startsWith('/v1/messages') && x.status === 200 && x.reqBytes > 1000);
    assert.ok(msg, `messages 호출이 그 턴에 묶인다: ${calls.map((x) => x.path).join(', ')}`);
    const rec = await c.request('session.inspectCall', { id, n: msg!.n });
    assert.match(rec.resBody, /event: message_stop/);
    assert.equal(rec.reqHeaders['x-api-key'], 'sk-ant-api03-…(redacted)');
    assert.ok(!JSON.stringify(rec).includes('FAKEKEY'), '키가 기록에 남지 않는다');
    assert.match(JSON.parse(rec.reqBody).messages.map((m: any) => JSON.stringify(m.content)).join(''), /hello/);
    assert.ok(api.hits.some((x) => x.startsWith('POST /v1/messages')), '업스트림은 원래 ANTHROPIC_BASE_URL');

    // 끄면 claude 가 게이트웨이로 바로 간다 — 기록이 늘지 않는다
    await c.request('session.setInspect', { id, on: false });
    assert.equal(stored().meta.inspect, false);
    const before = idx(), hitsBefore = api.hits.length;
    await turn('second');
    assert.equal(idx(), before, '꺼진 동안은 기록하지 않는다');
    assert.ok(api.hits.length > hitsBefore, '꺼져도 턴은 돈다');
    // 다시 켜면 번호를 이어 매긴다
    await c.request('session.setInspect', { id, on: true });
    const t3 = await turn('third');
    const again = (await c.request('session.inspectTurn', { id, end: t3 })).calls;
    assert.ok(again.length > 0 && again.every((x) => x.n > before), '다시 켠 뒤의 호출');
    await assert.rejects(c.request('session.inspectCall', { id, n: 9999 }), /no inspect call/);
  } finally {
    c.close();
    await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
