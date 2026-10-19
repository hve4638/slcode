// 옛 inspect.db(6e5145a 까지 — calls 한 표에 raw/compacted·dropped, Codex 의 req_full)를 새 꼴(파싱된 정보·raw 나눔)로 바꿔도 화면이 같은가 (ticket slcode-inspect-storage)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Old from './fixtures/inspectDbOld.ts';
import { InspectStore, sqlite, type InspectCapture } from '../src/inspectDb.ts';
import type { InspectRecord } from '../src/protocol.ts';

const parse = (t: string) => { try { return JSON.parse(t); } catch { return null; } };
const ev = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;

/** 옛 web/inspect.js(6e5145a) 가 그리던 값 — select 의 요청·응답, 요약·oaSummary 의 보낸 메시지, raw 탭(compact 된 호출은 'raw 삭제됨'), 헤더 */
const oldScreen = (r: any) => JSON.stringify({ req: parse(r.reqFull ?? r.reqBody), sent: r.reqFull ? parse(r.reqBody) : null, res: Old.oldResponseOf(r),
  raw: r.compacted ? null : { req: r.reqBody, res: r.resBody }, headers: [r.reqHeaders, r.resHeaders] });
/** 새 web/inspect.js 가 그리는 값 — 같은 자리 */
const newScreen = (r: InspectRecord) => JSON.stringify({ req: parse(r.requestFull ?? r.request), sent: r.requestFull ? parse(r.request) : null, res: parse(r.response),
  raw: r.raw ? { req: r.raw.req, res: r.raw.res } : null, headers: [r.reqHeaders, r.resHeaders] });

/** 캐시 표시를 마지막 메시지로 옮기며 앞 대화를 다시 보내는 Claude 호출들 — 캐시 표시가 블록 가운데 키에 있다 (키 순서가 화면에 보인다) */
function claudeCalls(k: number, at: number): InspectCapture[] {
  const sys = [{ type: 'text', text: 'billing' }, { type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' }, text: 'S'.repeat(500) }];
  const msgs: any[] = [];
  const out: InspectCapture[] = [];
  for (let i = 1; i <= k; i++) {
    msgs.push({ role: 'user', content: [{ type: 'text', text: `q${i}` }] });
    const body = { model: 'claude-x', max_tokens: 32000, stream: true, system: sys, tools: [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }],
      messages: msgs.map((m, j) => (j === msgs.length - 1 ? { ...m, content: m.content.map((b: any) => ({ cache_control: { type: 'ephemeral' }, ...b })) } : m)) };
    const sse = ev('message_start', { type: 'message_start', message: { id: `m${i}`, role: 'assistant', content: [], usage: { input_tokens: 5, cache_read_input_tokens: 100 } } })
      + ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } })
      + ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } })
      + ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } })
      + ev('content_block_stop', { type: 'content_block_stop', index: 1 })
      + ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
    out.push({ n: 0, at: at + i, ms: 3, method: 'POST', path: '/v1/messages?beta=true', model: 'claude-x', status: 200, reqBytes: 10, resBytes: 20,
      reqHeaders: { 'x-claude-code-request-class': 'main', authorization: 'Bearer sk-ant-oat01-…(redacted)' }, reqBody: JSON.stringify(body),
      resHeaders: { 'content-type': 'text/event-stream', 'request-id': `req_${i}` }, resBody: sse });
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'a b' }] });
  }
  return out;
}

/** Codex WebSocket 호출 둘 — 둘째는 증분 요청이라 core 가 다시 만든 전체 요청(reqFull)이 있다 */
function codexCalls(at: number): InspectCapture[] {
  const first = { type: 'response.create', model: 'gpt-x', instructions: 'be brief', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], tools: [] };
  const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] };
  const res = (id: string, out: unknown) => ev('response.created', { type: 'response.created', response: { id, status: 'in_progress', output: [] } })
    + ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: out })
    + ev('response.completed', { type: 'response.completed', response: { id, status: 'completed', output: [], usage: { input_tokens: 9, output_tokens: 2 } } })
    + ev('codex.rate_limits', { type: 'codex.rate_limits', plan_type: 'plus', rate_limits: { primary: { used_percent: 3 } } });
  const second = { type: 'response.create', model: 'gpt-x', previous_response_id: 'r1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'again' }] }] };
  const head = { reqHeaders: { authorization: 'Bearer …(redacted)' }, resHeaders: { upgrade: 'websocket' } };
  return [
    { n: 0, at: at + 1, ms: 5, method: 'WS', path: '/backend-api/codex/responses', model: 'gpt-x', status: 101, reqBytes: 1, resBytes: 1, ...head, reqBody: JSON.stringify(first), resBody: res('r1', item) },
    { n: 0, at: at + 2, ms: 5, method: 'WS', path: '/backend-api/codex/responses', model: 'gpt-x', status: 101, reqBytes: 1, resBytes: 1, ...head, reqBody: JSON.stringify(second),
      reqFull: JSON.stringify({ ...second, input: [...first.input, item, ...second.input] }), resBody: res('r2', { ...item, content: [{ type: 'output_text', text: 'again!' }] }) },
  ];
}

/** 메시지 호출이 아닌 것들 — JSON 응답, JSON 이 아닌 본문, 실패 */
const otherCalls = (at: number): InspectCapture[] => [
  { n: 0, at: at + 1, ms: 1, method: 'POST', path: '/v1/messages/count_tokens', model: 'claude-x', status: 200, reqBytes: 1, resBytes: 1, reqHeaders: {}, reqBody: '{"model":"claude-x","messages":[]}',
    resHeaders: { 'content-type': 'application/json' }, resBody: '{"input_tokens":12}' },
  { n: 0, at: at + 2, ms: 1, method: 'GET', path: '/api/oauth/profile', model: null, status: 404, reqBytes: 0, resBytes: 1, reqHeaders: {}, reqBody: '', resHeaders: { 'content-type': 'text/html' }, resBody: '<h1>no</h1>' },
  { n: 0, at: at + 3, ms: 1, method: 'POST', path: '/v1/messages', model: null, status: null, reqBytes: 1, resBytes: 0, error: 'client closed', reqHeaders: {}, reqBody: '(zstd decode failed: x)', resHeaders: {}, resBody: '' },
];

test('inspect 마이그레이션: 옛 DB(raw·compacted·지움·Codex req_full)를 새 꼴로 바꿔도 화면이 같다', { skip: !sqlite() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-inspect-migrate-'));
  const old = Old.InspectStore.open(dir);
  let n = 0;
  for (const c of [...claudeCalls(6, 1000), ...codexCalls(2000), ...otherCalls(3000), ...claudeCalls(2, 4000)]) old.add({ ...c, n: ++n } as any);
  old.dropOldest(1); // n 1 — 옛 10GB 상한의 '지움'
  old.compactOldest(3); // n 2·3·4 — 옛 compact
  (old as any).compactOne(8); // Codex 증분 요청 — 옛 compact 의 req_full
  const before = new Map<number, string>();
  const rows = (old as any).db.prepare('SELECT n, compacted, dropped FROM calls ORDER BY n').all() as { n: number; compacted: number; dropped: number }[];
  assert.deepEqual(rows.map((r) => r.dropped ? 'd' : r.compacted ? 'c' : 'r').join(''), 'dcccrrrcrrrrr', '옛 DB 에 raw·compact·지움이 섞였다');
  for (let i = 2; i <= n; i++) before.set(i, oldScreen(old.read(i)));
  const oldCalls = old.calls(-Infinity, Infinity).filter((c) => !c.dropped);
  old.close();

  const store = InspectStore.open(dir);
  const cols = ((store as any).db.prepare('PRAGMA table_info(calls)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!cols.includes('compacted') && cols.includes('raw_size'), '새 꼴');
  for (const [i, screen] of before) assert.equal(newScreen(store.read(i)!), screen, `호출 ${i} 의 화면 (키 순서까지)`);
  assert.equal(store.read(1), null, '지운 호출은 행째 없다');
  assert.deepEqual(store.calls(-Infinity, Infinity), oldCalls, '카드 목록은 지움만 빠진다');
  assert.equal(store.lastN(), n, '번호를 잇는다');
  assert.equal(store.rawSize(), [...before.keys()].filter((i) => rows[i - 1].compacted === 0)
    .reduce((t, i) => { const r = store.read(i)!.raw!; return t + Buffer.byteLength(r.req) + Buffer.byteLength(r.res); }, 0));
  const tables = ((store as any).db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name).sort();
  assert.deepEqual(tables, ['calls', 'parts', 'raw'], 'refs 와 옛 표는 지운다');

  // 새 꼴로 이어 쓰고, 옮긴 raw 도 지울 수 있다
  const [next] = claudeCalls(1, 5000);
  store.add({ ...next, n: n + 1 });
  assert.equal(store.compact(4500).calls, 8, '옮긴 raw 행(5·6·7·9·10·11·12·13)');
  assert.equal(newScreen(store.read(13)!), before.get(13)!.replace(/"raw":\{.*\},"headers"/, '"raw":null,"headers"'), 'raw 를 지워도 요약·request·response 는 같다');
  store.close();
  const again = InspectStore.open(dir);
  assert.ok(again.read(n + 1)!.raw, '다시 열어도 그대로');
  again.close();
});
