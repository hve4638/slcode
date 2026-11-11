// 메시지 없는 Claude 세션을 다시 띄우기 (ticket slcode-resume-empty-claude, 사용자 결정 2026-11-08) — 실제 claude CLI 를 가짜 Messages API 로 (가짜 키, API 비용 없음).
// SessionStart 훅의 알림에도 session_id 가 실려 오지만 claude 는 첫 프롬프트 전에는 대화 기록을 쓰지 않는다. 그 id 를 남기면 resume·inspect 토글·교체가 "No conversation found" 로 닫혔다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-resume-empty-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Messages API 흉내 — 스트림이면 SSE 로 "hi" 한 마디. 받은 본문을 모은다 */
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
  const bodies: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let stream = false; try { stream = !!JSON.parse(body).stream; } catch {}
      if (req.url?.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
        bodies.push(body);
        if (stream) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(msg));
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.includes('count_tokens') ? '{"input_tokens":5}' : '{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, bodies, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('claude: 첫 프롬프트 전의 id 는 남기지 않는다, 기록이 없는 id 는 resume 하지 않고 새 대화로 — 지난 턴이 있던 세션만 알린다', { timeout: 240000 }, async () => {
  const api = await fakeApi();
  const saved = { ...process.env };
  const home = tmp(), dir = tmp(), work = tmp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hook' }] }] } }));
  // core 는 모듈을 읽을 때 env 를 잡는다 — 그 전에 격리 env 를 깐다 (로그인 없는 HOME + 가짜 키 + 가짜 게이트웨이)
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession, PKG } = await import('../src/client.ts');
  const stored = (id: string) => EventLog.open(corePaths(dir).sessionsDir, id)!;
  const since = (id: string, seq: number) => stored(id).since(seq).map((e) => e.ev);
  /** SessionStart 훅이 돌고 그 응답까지 기록됐다 — 첫 프롬프트 전의 id 가 남을 수 있는 때가 지났다 */
  const hooked = async (id: string) => { for (const t0 = Date.now(); !since(id, 0).some((e) => e.kind === 'hook' && e.phase === 'response'); await sleep(50)) if (Date.now() - t0 > 15000) throw new Error(`no SessionStart hook in ${id}`); };
  const failed = (id: string, seq: number) => since(id, seq).filter((e) => e.kind === 'error' || e.kind === 'session.exit');
  const turn = async (h: { sock: string }, id: string, text: string) => {
    const c = await connectSession(h.sock);
    try {
      await c.request('session.attach', { id });
      const end = new Promise<any>((r) => c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') r(m.params.ev); }));
      await c.request('session.send', { id, text });
      return await end;
    } finally { c.close(); }
  };
  const handles: { close: (r?: string) => Promise<void> }[] = [];
  const open = async (o: { resume?: string } = {}) => { const h = await runCore({ dir, cwd: work, permissionMode: 'bypassPermissions', ...o }); handles.push(h); return h; };
  try {
    // 빈 세션 — 훅이 돌아도 남기지 않고, 다시 띄우면 닫히지 않고 첫 턴이 돈다
    let h = await open();
    const a = h.session.id;
    await hooked(a);
    assert.ok(since(a, 0).some((e) => e.kind === 'hook'), '훅이 돌았다');
    assert.equal(stored(a).meta.vendorSessionId, null);
    await h.close('test');
    let seq = stored(a).lastSeq;
    h = await open({ resume: a });
    assert.equal((await turn(h, a, 'zqfirstzq')).ok, true);
    assert.deepEqual(failed(a, seq), []);
    const vs = stored(a).meta.vendorSessionId;
    assert.ok(vs, '첫 턴 뒤에는 남긴다');
    await h.close('test');

    // 대화가 있으면 그대로 resume — 다음 요청에 앞 턴이 실린다
    h = await open({ resume: a });
    assert.equal((await turn(h, a, 'second')).ok, true);
    assert.equal(stored(a).meta.vendorSessionId, vs);
    assert.ok(api.bodies.at(-1)!.includes('zqfirstzq'));
    await h.close('test');

    // 빈 세션의 inspect 토글 — 같은 대화로 다시 띄우는 길(reopen)
    h = await open();
    const b = h.session.id;
    await hooked(b);
    { const c = await connectSession(h.sock); await c.request('session.attach', { id: b }); await c.request('session.setInspect', { id: b, on: true }); c.close(); }
    assert.equal((await turn(h, b, 'after-inspect')).ok, true);
    assert.deepEqual(failed(b, 0), []);
    await h.close('test');

    // 업데이트 handoff(core 교체) — 새 core(dist/coreMain.js, 이 격리 env 를 물려받는다)가 같은 세션을 이어 띄운다
    h = await open();
    const d = h.session.id;
    await hooked(d);
    {
      const c = await connectSession(h.sock);
      await c.request('core.own', { pid: process.pid, follows: true });
      const replaced = new Promise<void>((r) => c.onEvent((m: any) => { if (m.event === 'core.replaced') r(); }));
      await c.request('core.retire', { pkg: PKG });
      await replaced;
      c.close();
    }
    await h.done;
    {
      const c = await connectSession(h.sock);
      try { assert.notEqual((await c.request('core.auth', {})).pid, process.pid, '새 core'); } finally { c.close(); }
    }
    assert.equal((await turn(h, d, 'after-swap')).ok, true);
    assert.deepEqual(failed(d, 0), []);
    { const c = await connectSession(h.sock); await c.request('session.close', { id: d }).catch(() => {}); c.close(); }

    // 0.5.8 까지 만든 빈 세션 — 기록 없는 id 가 남아 있다. 조용히 새로 시작하고 id 를 지운다
    h = await open();
    const c = h.session.id;
    await h.close('test');
    stored(c).updateMeta({ vendorSessionId: '11111111-2222-3333-4444-555555555555' });
    seq = stored(c).lastSeq;
    h = await open({ resume: c });
    assert.equal(stored(c).meta.vendorSessionId, null);
    assert.equal((await turn(h, c, 'hello')).ok, true);
    assert.deepEqual(failed(c, seq), []);
    await h.close('test');

    // 대화가 있던 세션의 기록이 지워졌다 (claude 의 오래된 기록 정리) — 알리고 새 대화로
    for (const d of fs.readdirSync(path.join(home, '.claude', 'projects'))) fs.rmSync(path.join(home, '.claude', 'projects', d, `${vs}.jsonl`), { force: true });
    seq = stored(a).lastSeq;
    h = await open({ resume: a });
    const notes = failed(a, seq);
    assert.equal(notes.length, 1);
    assert.match((notes[0] as any).message, new RegExp(`이전 Claude 대화\\(${vs}\\)를 찾지 못해 새 대화로 시작합니다`));
    assert.equal((await turn(h, a, 'third')).ok, true);
    assert.ok(!api.bodies.at(-1)!.includes('zqfirstzq'), '새 대화');
    assert.notEqual(stored(a).meta.vendorSessionId, vs);
  } finally {
    for (const h of handles) await h.close('test').catch(() => {});
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
