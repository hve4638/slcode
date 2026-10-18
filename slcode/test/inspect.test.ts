// inspect proxy·기록 (ticket slcode-inspect-proxy·slcode-inspect-default-on) — 가짜 업스트림으로. 실제 API 는 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { blockInspect, inspectBlocked, inspectEnv, keepsFirstParty, sdkVersion, startInspect, turnCalls, upstreamOf } from '../src/inspect.ts';
import { InspectStore, maybeSweep, sseMessage, sweepInspect } from '../src/inspectDb.ts';
import type { InspectRecord, LoggedEvent } from '../src/protocol.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-inspect-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 기록이 끝날 때까지 — 응답이 끝난 뒤 푸는 사본은 비동기 */
async function until(f: () => boolean, ms = 3000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await sleep(10); } }
const turnEnd = (seq: number, at: number): LoggedEvent => ({ seq, at, ev: { kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: null, durationMs: null, usage: null, userUuid: null, uuid: null } });

/** gzip SSE 를 청크 셋으로 나눠 사이에 쉬면서 보내는 업스트림 */
async function fakeUpstream(seen: { path?: string; auth?: string; body?: string }[]) {
  const sse = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","role":"assistant","content":[],"usage":{"input_tokens":3}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"안녕"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
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

const post = (url: string, body: string, headers: Record<string, string> = {}) => new Promise<void>((resolve, reject) => {
  const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve()); });
  req.on('error', reject);
  req.end(body);
});

test('inspect: 응답을 도착하는 대로 그대로 넘기고, 기록은 풀어서·인증은 가려서', async () => {
  const seen: { path?: string; auth?: string; body?: string }[] = [];
  const up = await fakeUpstream(seen);
  const dir = tmp();
  const store = InspectStore.open(dir);
  const proxy = await startInspect(store, up.url + '/prefix');
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

  await until(() => store.read(1) !== null);
  const rec = store.read(1)!;
  assert.equal(rec.resBody, up.sse, '기록은 압축을 푼 SSE 원문');
  assert.equal(rec.reqBody, body);
  assert.equal(rec.model, 'claude-haiku-4-5');
  assert.equal(rec.status, 200);
  assert.equal(rec.compacted, undefined);
  assert.equal(rec.reqHeaders.authorization, 'Bearer sk-ant-oat01-…(redacted)');
  assert.equal(rec.resHeaders['anthropic-ratelimit-unified-5h-utilization'], '0.09');
  await proxy.close();
  store.close();
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f)).includes('SECRET'), `${f} 에 비밀이 남지 않는다`);
  up.srv.close();
});

test('inspect: 재기동해도 번호를 잇고, 턴 귀속은 앞 turn.end 뒤부터 그 turn.end 까지', async () => {
  const up = await fakeUpstream([]);
  const dir = tmp();
  let store = InspectStore.open(dir);
  let proxy = await startInspect(store, up.url);
  await post(`${proxy.url}/json`, 'x'); await post(`${proxy.url}/json`, 'y');
  await until(() => store.lastN() === 2);
  await proxy.close(); store.close();
  store = InspectStore.open(dir);
  proxy = await startInspect(store, up.url);
  await post(`${proxy.url}/json`, 'z');
  await until(() => store.lastN() === 3);
  await proxy.close();
  up.srv.close();
  assert.equal(store.read(3)!.reqBody, 'z');
  assert.deepEqual(turnCalls(store, [turnEnd(9, Date.now() + 1000)], 9).map((c) => c.n), [1, 2, 3]);
  store.close();

  const t = tmp();
  const s2 = InspectStore.open(t);
  const rec = (n: number, at: number): InspectRecord => ({ n, at, ms: 1, method: 'POST', path: '/v1/messages', model: null, status: 200, reqBytes: 1, resBytes: 1, reqHeaders: {}, reqBody: '{}', resHeaders: {}, resBody: '{}' });
  for (const [n, at] of [[1, 5], [2, 15], [3, 20], [4, 25], [5, 40]]) s2.add(rec(n, at));
  const evs: LoggedEvent[] = [{ seq: 1, at: 10, ev: { kind: 'turn.start', text: 'a', origin: null } }, turnEnd(2, 20), turnEnd(3, 30)];
  assert.deepEqual(turnCalls(s2, evs, 2).map((c) => c.n), [1, 2, 3], '첫 턴은 기동 호출까지');
  assert.deepEqual(turnCalls(s2, evs, 3).map((c) => c.n), [4]);
  assert.deepEqual(turnCalls(s2, evs, 99), []);
  assert.deepEqual(turnCalls(null, evs, 2), [], '켠 적 없는 세션');
  s2.close();
});

/** 에이전트 루프처럼 앞 대화를 다시 보내고 캐시 표시를 마지막 메시지로 옮기는 요청들 */
function agentCalls(k: number, pad = 2000): InspectRecord[] {
  const sys = [{ type: 'text', text: 'billing' }, { type: 'text', text: 'S'.repeat(pad), cache_control: { type: 'ephemeral', ttl: '1h' } }];
  const tools = [{ name: 'Bash', input_schema: { type: 'object' }, description: 'T'.repeat(pad) }];
  const msgs: any[] = [];
  const out: InspectRecord[] = [];
  for (let i = 1; i <= k; i++) {
    msgs.push({ role: 'user', content: [{ type: 'text', text: `q${i} ${'u'.repeat(pad)}` }] });
    const body = { model: 'claude-x', stream: true, system: sys, tools, messages: msgs.map((m, j) => (j === msgs.length - 1 ? { ...m, content: m.content.map((b: any) => ({ ...b, cache_control: { type: 'ephemeral' } })) } : m)) };
    const sse = [['message_start', { type: 'message_start', message: { id: `m${i}`, role: 'assistant', content: [], usage: { input_tokens: 5 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ...Array.from({ length: 50 }, () => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ab' } }]),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } }]].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    out.push({ n: i, at: 1000 + i, ms: 1, method: 'POST', path: '/v1/messages?beta=true', model: 'claude-x', status: 200, reqBytes: 1, resBytes: 1,
      reqHeaders: { 'x-claude-code-request-class': 'main' }, reqBody: JSON.stringify(body), resHeaders: { 'content-type': 'text/event-stream' }, resBody: sse });
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'ab'.repeat(50) }] });
  }
  return out;
}

test('inspect compact: 원본만 지운다 — 요청은 조각으로 다시 조립해 같고, SSE 는 메시지 하나로, 반복은 한 번만 저장', () => {
  const dir = tmp();
  const store = InspectStore.open(dir);
  const calls = agentCalls(12);
  for (const c of calls) store.add(c);
  const raw = store.rawSize();
  store.tidy(1000 + 7 * 24 * 3600 * 1000 + 100); // 모두 7일이 지났다
  assert.equal(store.rawSize(), 0);
  for (const c of calls) {
    const r = store.read(c.n)!;
    assert.equal(r.compacted, true);
    assert.deepEqual(JSON.parse(r.reqBody), JSON.parse(c.reqBody), `요청 ${c.n} 은 원본과 같은 JSON (캐시 표시 자리까지)`);
    assert.deepEqual(JSON.parse(r.resBody), sseMessage(c.resBody));
    assert.equal(JSON.parse(r.resBody).content[0].text, 'ab'.repeat(50));
    assert.deepEqual(r.reqHeaders, c.reqHeaders, '헤더는 그대로');
  }
  const db = (sql: string) => (store as any).db.prepare(sql).get();
  const stored = Number(db('SELECT SUM(size) AS s FROM calls').s) + Number(db('SELECT SUM(LENGTH(body)) AS s FROM parts').s);
  assert.ok(stored * 4 < raw, `반복을 한 번만: raw ${raw}B → ${stored}B`);
  // 질문 12개(캐시 표시가 붙은 마지막 질문도 같은 조각) + 답 1개(11번 모두 같은 글) + system 2 + tools 1
  assert.equal(Number(db('SELECT COUNT(*) AS c FROM parts').c), 12 + 1 + 3);
  store.tidy(1e15); // 이미 된 것엔 할 일이 없다
  assert.deepEqual(JSON.parse(store.read(12)!.reqBody), JSON.parse(calls[11].reqBody));
  store.close();
});

test('inspect compact: 다시 쓰지 못하는 응답(이상한 SSE)도 compact 로 표시하고 다음으로 — 한 행이 정리를 막지 않는다, 한 번에 BATCH 개까지', () => {
  const store = InspectStore.open(tmp());
  const bad = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0}\n\n';
  assert.deepEqual(sseMessage(bad), { content: [{ type: 'text', text: '' }], error: { type: 'overloaded_error' } }, '던지지 않는다');
  const calls = agentCalls(30, 10);
  store.add({ ...calls[0], n: 99, at: 1, resBody: bad });
  for (const c of calls) store.add(c);
  assert.equal(store.tidy(1e15), 20, '한 번에 BATCH(20) 개까지 — 나머지는 다음 기록 때');
  assert.equal(store.read(99)!.compacted, true);
  assert.equal(store.tidy(1e15), 11);
  assert.equal(store.rawSize(), 0);
  store.close();
});

test('inspect compact: 세션 raw 합이 상한을 넘으면 오래된 것부터, JSON 이 아닌 본문은 그대로', () => {
  const store = InspectStore.open(tmp());
  const calls = agentCalls(6);
  for (const c of calls) store.add(c);
  store.add({ ...calls[0], n: 7, at: 999, reqBody: 'not json', resHeaders: {}, resBody: 'plain' });
  const total = store.rawSize();
  store.tidy(2000, total - 1); // 7일 전은 없다 — 상한만
  assert.equal(store.read(7)!.compacted, true, '가장 오래된 것(at 999)부터');
  assert.equal(store.read(7)!.reqBody, 'not json');
  assert.equal(store.read(7)!.resBody, 'plain');
  assert.equal(store.read(1)!.compacted, undefined, '상한 안으로 들어오면 멈춘다');
  store.close();
});

test('inspect 전체 정리: 세션을 가로질러 오래된 raw 부터 compact, 그래도 넘으면 오래된 호출부터 지우고 안 쓰는 조각도 지운다', async () => {
  const P = corePaths(tmp());
  const mk = (id: string, shift: number) => {
    const d = path.join(P.sessionsDir, '-w', id, 'inspect');
    const s = InspectStore.open(d);
    for (const c of agentCalls(5, 4000)) s.add({ ...c, at: c.at + shift });
    return s;
  };
  const a = mk('aaaa', 0), b = mk('bbbb', 100); // a 가 오래됐다
  fs.mkdirSync(path.join(P.sessionsDir, '-w', 'cccc'), { recursive: true }); // 기록 없는 세션
  const used = a.used() + b.used();
  await sweepInspect(P.sessionsDir, 2000, used - 1);
  assert.equal(a.read(1)!.compacted, true, '오래된 세션의 raw 부터');
  assert.equal(b.read(5)!.compacted, undefined, '상한 안이면 새 것은 둔다');
  assert.ok(!fs.existsSync(path.join(P.sessionsDir, '-w', 'cccc', 'inspect')), '기록 없는 세션엔 만들지 않는다');

  await sweepInspect(P.sessionsDir, 2000, 1); // 다 compact 해도 넘는다 → 지운다
  assert.equal(a.read(1), null);
  assert.deepEqual(turnCalls(a, [turnEnd(1, 1e12)], 1).map((c) => !!c.dropped), [true, true, true, true, true], '지운 호출은 카드로 남는다');
  const parts = (s: InspectStore) => Number((s as any).db.prepare('SELECT COUNT(*) AS c FROM parts').get().c);
  assert.equal(parts(a), 0, '아무도 안 쓰는 조각은 지운다');
  a.close(); b.close();
});

test('inspect 전체 정리: 3일이 지났을 때만, 잠금을 쥔 프로세스가 살아 있으면 건너뛴다', async () => {
  const d = tmp(), P = corePaths(d);
  fs.mkdirSync(P.sessionsDir, { recursive: true });
  const stamp = path.join(d, 'inspect-sweep.json'), lock = path.join(d, 'inspect-sweep.lock');
  const day = 24 * 3600 * 1000;
  assert.equal(await maybeSweep(stamp, lock, P.sessionsDir, { now: 10 * day }), true);
  assert.equal(JSON.parse(fs.readFileSync(stamp, 'utf8')).at, 10 * day);
  assert.ok(!fs.existsSync(lock), '끝나면 잠금을 푼다');
  assert.equal(await maybeSweep(stamp, lock, P.sessionsDir, { now: 12 * day }), false, '3일 안이면 하지 않는다');
  fs.writeFileSync(lock, String(process.pid));
  assert.equal(await maybeSweep(stamp, lock, P.sessionsDir, { now: 14 * day }), false, '살아 있는 정리가 있으면 건너뛴다');
  fs.writeFileSync(lock, '999999999');
  assert.equal(await maybeSweep(stamp, lock, P.sessionsDir, { now: 14 * day }), true, '죽은 pid 의 잠금은 치운다');
});

test('inspect 1st party 감시: tool 이 있는 첫 메시지 요청에 request-class 헤더가 없으면 한 번 알린다', async () => {
  const up = await fakeUpstream([]);
  const run = async (watch: boolean, sends: [string, Record<string, string>][]) => {
    const store = InspectStore.open(tmp());
    let lost = 0;
    const proxy = await startInspect(store, up.url, { watch, onLost: () => lost++ });
    for (const [body, headers] of sends) await post(`${proxy.url}/v1/messages?beta=true`, body, headers);
    await proxy.close(); store.close();
    return lost;
  };
  const tools = JSON.stringify({ tools: [{ name: 'Bash' }], messages: [] }), bare = JSON.stringify({ messages: [] });
  assert.equal(await run(true, [[bare, {}], [tools, {}], [tools, {}]]), 1, 'tool 없는 부수 요청은 보지 않고, 알림은 한 번');
  assert.equal(await run(true, [[tools, { 'x-claude-code-request-class': 'main' }], [tools, {}]]), 0, '첫 요청에 있으면 듣는 것');
  assert.equal(await run(false, [[tools, {}]]), 0, '내부 플래그를 넣지 않은 세션은 보지 않는다');
  up.srv.close();
});

test('inspect: 1st party 판정을 지키는 env, 막힌 SDK 기록', () => {
  assert.deepEqual(inspectEnv({ HOME: '/h' }, 'http://127.0.0.1:1'), { HOME: '/h', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1', ENABLE_TOOL_SEARCH: 'true' });
  assert.equal(inspectEnv({ ENABLE_TOOL_SEARCH: 'auto:5' }, 'http://p').ENABLE_TOOL_SEARCH, 'auto:5', '사용자가 정한 값은 그대로');
  assert.equal(inspectEnv({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }, 'http://p')._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '1');
  const gw = inspectEnv({ ANTHROPIC_BASE_URL: 'https://gw.example/anthropic' }, 'http://p');
  assert.equal(gw.ANTHROPIC_BASE_URL, 'http://p');
  assert.equal(gw._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, undefined, '다른 게이트웨이를 쓰던 사용자는 원래대로 3rd party');
  assert.equal(gw.ENABLE_TOOL_SEARCH, undefined);
  assert.equal(keepsFirstParty({ ANTHROPIC_BASE_URL: 'https://gw.example' }), false);
  assert.equal(keepsFirstParty({}), true);
  assert.equal(upstreamOf({ ANTHROPIC_BASE_URL: 'https://gw.example/anthropic' }), 'https://gw.example/anthropic');
  assert.equal(upstreamOf({}), 'https://api.anthropic.com');

  const f = path.join(tmp(), 'inspect-blocked.json');
  assert.equal(inspectBlocked(f), null);
  assert.match(sdkVersion(), /^\d+\.\d+\.\d+/);
  blockInspect(f);
  assert.equal(inspectBlocked(f), sdkVersion());
  fs.writeFileSync(f, JSON.stringify({ sdk: '0.0.1', at: 1 }));
  assert.equal(inspectBlocked(f), null, 'SDK 가 바뀌면 다시 검사한다');
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
    const idx = () => { const s = InspectStore.open(path.join(stored().dir, 'inspect')); try { return s.lastN(); } finally { s.close(); } };

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

test('inspect: 이 SDK 에서 막혔다고 기록돼 있으면 켜지 않고 기록에 사유를 남기며, 사이드바로 켜기도 거절한다', { timeout: 60000 }, async () => {
  const saved = { ...process.env };
  const home = tmp(), dir = tmp(), work = tmp();
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  fs.mkdirSync(dir, { recursive: true });
  blockInspect(path.join(dir, 'inspect-blocked.json'));
  const h = await runCore({ dir, cwd: work, inspect: true, permissionMode: 'bypassPermissions' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  try {
    const stored = EventLog.open(corePaths(dir).sessionsDir, id)!;
    assert.equal(stored.meta.inspect, false);
    assert.ok(stored.all.some((e) => e.ev.kind === 'error' && /inspect 를 켜지 않았습니다/.test(e.ev.message)), '기록에 사유');
    assert.ok(!fs.existsSync(path.join(stored.dir, 'inspect')), 'DB 를 만들지 않는다');
    await assert.rejects(c.request('session.setInspect', { id, on: true }), /blocked/);
  } finally {
    c.close();
    await h.close('test');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
