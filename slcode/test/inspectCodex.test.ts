// inspect 의 Codex 쪽 (ticket slcode-inspect-codex) — 가짜 OpenAI 업스트림(HTTP·WebSocket)과 가짜 app-server 로. 실제 API·codex 는 쓰지 않는다.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { CODEX_ROUTE, codexArgs, codexUpstream, frames, startInspect, unrecorded } from '../src/inspect.ts';
import { InspectStore, sseMessage } from '../src/inspectDb.ts';
import { userBaseUrl } from '../src/codex.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import { sqlite } from '../src/inspectDb.ts';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-inspect-codex-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 3000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(10); } }
/** 턴의 호출 목록 — proxy 는 응답을 codex 에 먼저 넘기고 기록하므로, turn.end 직후에는 마지막 호출이 아직 없을 수 있다. n 개가 될 때까지 잠깐 기다린다 */
async function turnCalls(c: { request: (m: any, p: any) => Promise<any> }, id: string, end: number, n: number) {
  const t = Date.now();
  for (;;) { const calls = (await c.request('session.inspectTurn', { id, end })).calls as any[]; if (calls.length >= n || Date.now() - t > 3000) return calls; await sleep(20); }
}

/** 가짜 OpenAI Responses — WebSocket 은 response.create 마다 created → output_item.done → completed (id r1, r2, …), HTTP POST 는 SSE 한 번 */
async function fakeOpenAI() {
  const seen: { path?: string; headers: http.IncomingHttpHeaders; body?: string }[] = [];
  const msgs: any[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('base64') });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '12' });
      res.end('event: response.created\ndata: {"type":"response.created","response":{"id":"h1","model":"fake-model","output":[]}}\n\n'
        + 'event: response.completed\ndata: {"type":"response.completed","response":{"id":"h1","status":"completed","output":[],"usage":{"input_tokens":5,"output_tokens":1}}}\n\n');
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  let k = 0;
  srv.on('upgrade', (req, sock, head) => {
    seen.push({ path: req.url, headers: req.headers });
    wss.handleUpgrade(req, sock, head, (ws) => ws.on('message', (data) => {
      msgs.push(JSON.parse(String(data)));
      const id = `r${++k}`;
      ws.send(JSON.stringify({ type: 'response.created', response: { id, model: 'fake-model', status: 'in_progress', output: [] } }));
      ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }));
      ws.send(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply ${id}` }] } }));
      ws.send(JSON.stringify({ type: 'response.completed', response: { id, model: 'fake-model', status: 'completed', output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 7 } } }));
    }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, wss, seen, msgs, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('inspect codex: WebSocket 을 그대로 잇고 response.create 하나를 호출 하나로, 증분 요청은 전체 요청으로 다시 만든다', async () => {
  const up = await fakeOpenAI();
  const store = InspectStore.open(tmp());
  const proxy = await startInspect(store, up.url + '/up', { prefix: CODEX_ROUTE });
  try {
    const ws = new WebSocket(`${proxy.url.replace('http', 'ws')}${CODEX_ROUTE}/responses`, { headers: { authorization: 'Bearer SECRETTOKEN', 'chatgpt-account-id': 'acct-1' } });
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    const got: any[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    const first = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }];
    ws.send(JSON.stringify({ type: 'response.create', model: 'fake-model', input: first }));
    await until(() => got.length === 4);
    ws.send(JSON.stringify({ type: 'response.create', model: 'fake-model', previous_response_id: 'r1', input: [{ type: 'function_call_output', call_id: 'c1', output: 'ok' }] }));
    await until(() => got.length === 8);
    assert.equal(got[3].type, 'response.completed', '이벤트를 그대로 받는다');
    assert.equal(up.seen[0].path, '/up/responses', '앞부분(CODEX_ROUTE)을 떼고 업스트림 경로에 잇는다');
    assert.equal(up.seen[0].headers.authorization, 'Bearer SECRETTOKEN');
    assert.equal(up.seen[0].headers['sec-websocket-extensions'], undefined, 'permessage-deflate 제안은 빼고 넘긴다');
    assert.equal(up.msgs.length, 2);

    await until(() => store.read(2) !== null);
    const [a, b] = [store.read(1)!, store.read(2)!];
    assert.equal(a.method, 'WS');
    assert.equal(a.path, `${CODEX_ROUTE}/responses`);
    assert.equal(a.model, 'fake-model');
    assert.equal(a.error, undefined);
    assert.equal(a.requestFull, undefined, '첫 요청은 그대로가 전체');
    assert.equal(a.reqHeaders.authorization, 'Bearer …(redacted)');
    assert.equal(a.reqHeaders['chatgpt-account-id'], '…(redacted)');
    assert.match(a.raw!.res, /^event: response.created\ndata: /);
    assert.deepEqual(JSON.parse(b.raw!.req).input, [{ type: 'function_call_output', call_id: 'c1', output: 'ok' }], 'raw 는 보낸 그대로');
    assert.deepEqual(JSON.parse(b.request), JSON.parse(b.raw!.req), 'request 도 보낸 메시지');
    const full = JSON.parse(b.requestFull!);
    assert.deepEqual(full.input.map((x: any) => x.type), ['message', 'message', 'function_call_output'], '앞 input + 서버가 낸 항목 + 증분');
    assert.equal(full.input[1].content[0].text, 'reply r1');
    const res = JSON.parse(b.response);
    assert.deepEqual(res, sseMessage(b.raw!.res), '파싱된 응답은 이벤트를 메시지 하나로');
    assert.equal(res.id, 'r2');
    assert.equal(res.output[0].content[0].text, 'reply r2', '끝 이벤트의 output 이 비면 모은 항목');
    assert.equal(res.usage.input_tokens_details.cached_tokens, 80);
    assert.ok(proxy.seen.has(`${CODEX_ROUTE}/responses`));

    // raw 를 지운 뒤에도 전체 요청과 응답 메시지가 남는다
    store.compact(Date.now() + 1);
    const c = store.read(2)!;
    assert.equal(c.raw, undefined);
    assert.deepEqual(JSON.parse(c.requestFull!), full);
    assert.equal(JSON.parse(c.response).output[0].content[0].text, 'reply r2');

    // 끊으면 열린 호출은 오류로 닫힌다
    ws.send(JSON.stringify({ type: 'response.create', model: 'x', input: [] }));
    await until(() => got.length === 12);
    ws.close();
  } finally {
    await proxy.close();
    up.wss.close(); up.srv.close();
  }
});

test('inspect codex: HTTP 요청 본문의 zstd 는 업스트림엔 그대로, 기록엔 풀어서', async () => {
  const up = await fakeOpenAI();
  const store = InspectStore.open(tmp());
  const proxy = await startInspect(store, async () => up.url + '/up', { prefix: CODEX_ROUTE });
  try {
    const body = JSON.stringify({ model: 'fake-model', input: [{ type: 'message', role: 'user', content: 'hi' }] });
    const z = (zlib as any).zstdCompressSync(Buffer.from(body)) as Buffer;
    await new Promise<void>((resolve, reject) => {
      const req = http.request(`${proxy.url}${CODEX_ROUTE}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' } }, (res) => { res.resume(); res.on('end', () => resolve()); });
      req.on('error', reject); req.end(z);
    });
    assert.equal(up.seen[0].path, '/up/responses');
    assert.deepEqual(Buffer.from(up.seen[0].body!, 'base64'), z, '압축된 바이트를 그대로');
    await until(() => store.read(1) !== null);
    const rec = store.read(1)!;
    assert.equal(rec.raw!.req, body);
    assert.equal(rec.model, 'fake-model');
    assert.equal(rec.reqBytes, z.length);
    assert.equal(JSON.parse(rec.response).usage.input_tokens, 5);
  } finally {
    await proxy.close();
    up.wss.close(); up.srv.close();
  }
});

test('inspect: 모델 목록·연결 확인은 넘기기만 하고 남기지 않으며 번호도 쓰지 않는다', async () => {
  assert.ok(unrecorded('GET', '/backend-api/codex/models?client_version=0.159.0'));
  assert.ok(unrecorded('HEAD', '/api/hello'));
  assert.ok(!unrecorded('POST', '/backend-api/codex/models'));
  assert.ok(!unrecorded('POST', '/v1/messages'));
  const up = await fakeOpenAI();
  const store = InspectStore.open(tmp());
  const proxy = await startInspect(store, async () => up.url + '/up', { prefix: CODEX_ROUTE });
  const call = (method: string, p: string) => new Promise<number>((resolve, reject) => {
    const req = http.request(`${proxy.url}${p}`, { method }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await call('GET', `${CODEX_ROUTE}/models?client_version=1`), 200);
    assert.equal(await call('HEAD', '/api/hello'), 200);
    assert.equal(await call('POST', `${CODEX_ROUTE}/responses`), 200);
    assert.deepEqual(up.seen.map((x) => x.path), ['/up/models?client_version=1', '/up/api/hello', '/up/responses'], '모두 업스트림으로 넘긴다');
    await until(() => store.read(1) !== null);
    await sleep(100);
    assert.deepEqual(store.calls(-Infinity, Infinity).map((c) => [c.n, c.method, c.path]), [[1, 'POST', `${CODEX_ROUTE}/responses`]]);
    assert.ok(proxy.seen.has(`${CODEX_ROUTE}/models`), '감시가 보는 경로에는 들어간다');
  } finally {
    await proxy.close();
    up.wss.close(); up.srv.close();
  }
});

test('inspect codex: 업스트림·인자·사용자 openai_base_url', () => {
  assert.equal(codexUpstream(null, { 'chatgpt-account-id': 'a' }), 'https://chatgpt.com/backend-api/codex');
  assert.equal(codexUpstream(null, {}), 'https://api.openai.com/v1');
  assert.equal(codexUpstream('https://gw.example/v1', { 'chatgpt-account-id': 'a' }), 'https://gw.example/v1');
  assert.deepEqual(codexArgs('http://127.0.0.1:5'), ['-c', 'openai_base_url="http://127.0.0.1:5/backend-api/codex"']);
  assert.equal(userBaseUrl([{ name: { type: 'sessionFlags' }, config: { openai_base_url: 'http://proxy' } }, { name: { type: 'user' }, config: { openai_base_url: 'https://gw' } }]), 'https://gw');
  assert.equal(userBaseUrl([{ name: { type: 'sessionFlags' }, config: { openai_base_url: 'http://proxy' } }, { name: { type: 'user' }, config: {} }]), null);
  assert.equal(userBaseUrl(undefined), null);
});

test('inspect codex: 프레임 읽기 — 마스크를 풀고, 청크에 걸치거나 조각난 메시지를 잇고, 제어 프레임은 버린다', () => {
  const frame = (op: number, fin: boolean, payload: Buffer, mask: boolean) => {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | len])
      : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | 126]), Buffer.from([len >> 8, len & 255])]);
    if (!mask) return Buffer.concat([head, payload]);
    const key = Buffer.from([1, 2, 3, 4]);
    return Buffer.concat([head, key, Buffer.from(payload.map((b, i) => b ^ key[i & 3]))]);
  };
  const got: string[] = [];
  const read = frames((t) => got.push(t));
  const big = 'x'.repeat(300);
  const all = Buffer.concat([frame(1, false, Buffer.from('he'), true), frame(9, true, Buffer.from('ping'), true), frame(0, true, Buffer.from('llo'), true), frame(1, true, Buffer.from(big), false), frame(2, true, Buffer.from('bin'), false)]);
  for (let i = 0; i < all.length; i += 7) read(all.subarray(i, i + 7));
  assert.deepEqual(got, ['hello', big]);
});

test('inspect codex: req_full 칸이 없던 옛 DB 도 열어 새 꼴로 쓴다', { skip: !sqlite() }, () => {
  const dir = tmp();
  const db = new (sqlite()!.DatabaseSync)(path.join(dir, 'inspect.db'));
  db.exec(`CREATE TABLE calls (n INTEGER PRIMARY KEY, at INTEGER NOT NULL, ms INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, model TEXT, status INTEGER,
    req_bytes INTEGER NOT NULL, res_bytes INTEGER NOT NULL, error TEXT, size INTEGER NOT NULL, compacted INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
    req_headers TEXT NOT NULL, res_headers TEXT NOT NULL, req_body TEXT NOT NULL, res_body TEXT NOT NULL)`);
  db.close();
  const store = InspectStore.open(dir);
  store.add({ n: 1, at: 1, ms: 1, method: 'WS', path: '/r', model: null, status: 101, reqBytes: 1, resBytes: 1, reqHeaders: {}, reqBody: '{}', reqFull: '{"input":[]}', resHeaders: {}, resBody: '' });
  assert.equal(store.read(1)!.requestFull, '{"input":[]}');
  store.close();
});

/** core 테스트들이 함께 쓰는 가짜 업스트림 — core.ts 는 처음 import 될 때 env 를 붙잡으므로 FAKE_CODEX_USER_BASE 가 파일 안에서 하나여야 한다 */
let shared: ReturnType<typeof fakeOpenAI> | null = null;
const sharedOpenAI = () => (shared ??= fakeOpenAI());
after(async () => { if (shared) { const up = await shared; up.wss.close(); up.srv.close(); } });

test('inspect codex: core 가 app-server 에 proxy 주소를 주고 WebSocket 호출을 턴에 묶으며, 끄고 켜면 app-server 를 다시 띄운다', { timeout: 60000 }, async () => {
  const up = await sharedOpenAI();
  const saved = { ...process.env };
  const dir = tmp(), work = tmp();
  Object.assign(process.env, { SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, FAKE_CODEX_USER_BASE: up.url + '/gw', SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await runCore({ dir, cwd: work, vendor: 'codex', inspect: true, permissionMode: 'bypassPermissions' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  try {
    const ends: number[] = [];
    let wake: (() => void) | null = null;
    c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') { ends.push(m.params.seq); wake?.(); } });
    await c.request('session.attach', { id });
    const turn = async (text: string) => { const n = ends.length; await c.request('session.send', { id, text }); while (ends.length === n) await new Promise<void>((r) => (wake = r)); return ends[ends.length - 1]; };
    const stored = () => EventLog.open(corePaths(dir).sessionsDir, id)!;

    const t1 = await turn('ws');
    const calls = await turnCalls(c, id, t1, 2);
    assert.deepEqual(calls.map((x) => x.method), ['WS', 'WS'], `WebSocket 호출 둘: ${JSON.stringify(calls)}`);
    assert.ok(up.seen.every((x) => x.path === '/gw/responses'), '사용자가 정한 openai_base_url 로 넘긴다');
    const rec = await c.request('session.inspectCall', { id, n: calls[1].n });
    assert.equal(JSON.parse(rec.requestFull!).input.length, 3);

    await c.request('session.setInspect', { id, on: false });
    assert.equal(stored().meta.inspect, false);
    const before = up.msgs.length;
    await turn('ws');
    assert.equal(up.msgs.length, before + 2, '꺼지면 app-server 가 업스트림으로 바로 간다');
    const upgrades = up.seen.filter((x) => x.headers.upgrade);
    assert.equal(upgrades[0].headers['sec-websocket-extensions'], undefined, '첫 연결은 proxy 를 거쳤다 (deflate 제안을 뺀다)');
    assert.ok(upgrades[1].headers['sec-websocket-extensions'], '두 번째 연결은 proxy 를 거치지 않았다');
    const t2 = ends[ends.length - 1];
    assert.equal((await c.request('session.inspectTurn', { id, end: t2 })).calls.length, 0);

    await c.request('session.setInspect', { id, on: true });
    const t3 = await turn('ws');
    assert.equal((await turnCalls(c, id, t3, 2)).length, 2, '다시 켜면 다시 기록');
    assert.ok(!stored().all.some((e) => e.ev.kind === 'error' && /inspect 를 끕니다/.test(e.ev.message)), '기록이 됐으니 감시가 끄지 않는다');
  } finally {
    c.close();
    await h.close('test');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('inspect codex: 켠 뒤 성공한 첫 턴까지 모델 호출이 proxy 로 오지 않으면 알리고 이 세션만 끈다', { timeout: 60000 }, async () => {
  const saved = { ...process.env };
  const dir = tmp(), work = tmp();
  Object.assign(process.env, { SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await runCore({ dir, cwd: work, vendor: 'codex', inspect: true, permissionMode: 'bypassPermissions' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  try {
    await c.request('session.attach', { id });
    await c.request('session.send', { id, text: 'no-call' });
    const stored = () => EventLog.open(corePaths(dir).sessionsDir, id)!;
    await until(() => stored().meta.inspect === false, 10000);
    assert.ok(stored().all.some((e) => e.ev.kind === 'error' && /proxy 를 거치지 않아/.test(e.ev.message)), '알림');
  } finally {
    c.close();
    await h.close('test');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('inspect codex: core 교체 뒤 새 core 가 proxy 를 다시 세워 같은 inspect.db 에 이어 기록한다', { timeout: 60000 }, async () => {
  const up = await sharedOpenAI();
  const saved = { ...process.env };
  const dir = tmp(), work = tmp();
  Object.assign(process.env, { SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, FAKE_CODEX_USER_BASE: up.url + '/gw', SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession, PKG } = await import('../src/client.ts');
  const h = await runCore({ dir, cwd: work, vendor: 'codex', inspect: true, permissionMode: 'bypassPermissions' });
  const id = h.session.id;
  let c = await connectSession(h.sock);
  try {
    const ends: number[] = [];
    let wake: (() => void) | null = null;
    const watch = (x: typeof c) => x.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') { ends.push(m.params.seq); wake?.(); } });
    const turn = async (text: string) => { const n = ends.length; await c.request('session.send', { id, text }); while (ends.length === n) await new Promise<void>((r) => (wake = r)); return ends[ends.length - 1]; };
    watch(c);
    await c.request('core.own', { pid: process.pid, follows: true });
    await c.request('session.attach', { id });
    const t1 = await turn('ws');
    assert.equal((await turnCalls(c, id, t1, 2)).length, 2);
    const oldPid = (await c.request('core.auth', {})).pid;

    await c.request('core.retire', { pkg: PKG });
    await h.done;
    c.close();
    c = await connectSession(h.sock);
    assert.notEqual((await c.request('core.auth', {})).pid, oldPid, '새 core 다');
    watch(c);
    await c.request('core.own', { pid: process.pid, follows: true });
    await c.request('session.attach', { id });
    const before = up.msgs.length;
    const t2 = await turn('ws');
    assert.equal(up.msgs.length, before + 2);
    const calls = await turnCalls(c, id, t2, 2);
    assert.deepEqual(calls.map((x) => x.method), ['WS', 'WS'], '새 core 의 proxy 로 기록한다');
    assert.ok(calls[0].n > 2, '같은 inspect.db 에 이어 쓴다');
    assert.equal((await c.request('session.inspectTurn', { id, end: t1 })).calls.length, 2, '옛 core 의 기록도 남아 있다');
    assert.ok(up.seen.every((x) => x.path === '/gw/responses'), '새 core 도 사용자가 정한 openai_base_url 로 넘긴다');
    assert.ok(!EventLog.open(corePaths(dir).sessionsDir, id)!.all.some((e) => e.ev.kind === 'error' && /inspect 를 끕니다/.test(e.ev.message)));
    await c.request('session.close', { id });
  } finally {
    c.close();
    await h.close('test');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
