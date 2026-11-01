// Claude 의 system prompt snapshot 끄기 (ticket slcode-agent-plugin-instructions-resume, 사용자 결정 2026-11-02) — resume 해도 기록된 옛 시스템 프롬프트가 아니라
// 지금의 slcode 고정 지시·플러그인 지시문이 나간다. 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { addPlugin } from 'slcode-plugin/agentPlugins';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Messages API 흉내 — 스트림 요청의 system 을 모으고 "hi" 한 마디로 답한다 */
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
  const systems: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j: any = null; try { j = JSON.parse(body); } catch {}
      if (req.url?.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
        if (j?.stream && (j.messages?.length ?? 0) > 1) systems.push(JSON.stringify(j.system)); // 본 대화 요청만 (제목 짓기 등 한 줄짜리는 뺀다)
        if (j?.stream) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(msg));
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.includes('count_tokens') ? '{"input_tokens":5}' : '{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, systems, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('claude: 지시문을 고친 뒤 resume 하면 새 판이 시스템 프롬프트로 나가고, 같은 기동 안에서는 턴마다 같다', { timeout: 180000 }, async () => {
  const api = await fakeApi();
  const saved = { ...process.env };
  const home = tmp('slcode-snap-home-'), dir = tmp('slcode-snap-'), work = tmp('slcode-snap-work-'), src = tmp('slcode-snap-src-');
  // core 는 모듈을 읽을 때 env 를 잡는다 — 그 전에 격리 env 를 깐다 (로그인 없는 HOME + 가짜 키 + 가짜 게이트웨이)
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const { SLCODE_PROMPT } = await import('../src/prompt.ts');
  const plugin = async (text: string) => {
    fs.mkdirSync(path.join(src, 'main', 'instructions'), { recursive: true });
    fs.writeFileSync(path.join(src, 'slcode-plugin.json'), JSON.stringify({ name: 'snap', version: '1.0.0', parts: { main: {} } }));
    fs.writeFileSync(path.join(src, 'main', 'instructions', 'a.md'), text);
    await addPlugin(src, dir);
  };
  /** core 를 띄워 턴들을 돌리고 내린다 */
  const run = async (resume: string | undefined, texts: string[]) => {
    const h = await runCore({ dir, cwd: work, permissionMode: 'bypassPermissions', ...(resume ? { resume } : {}) });
    const c = await connectSession(h.sock);
    const id = h.session.id;
    let ends = 0, wake: (() => void) | null = null;
    c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') { ends++; wake?.(); } });
    try {
      await c.request('session.attach', { id });
      for (const text of texts) { const n = ends; await c.request('session.send', { id, text }); while (ends === n) await new Promise<void>((r) => (wake = r)); }
    } finally { c.close(); await h.close('test'); }
    return id;
  };
  try {
    await plugin('SNAP-MARKER-V1');
    const id = await run(undefined, ['one']);
    assert.match(api.systems.at(-1)!, /SNAP-MARKER-V1/);
    await plugin('SNAP-MARKER-V2');
    const before = api.systems.length;
    await run(id, ['two', 'three']);
    const now = api.systems.slice(before);
    assert.ok(now.length >= 2, `resume 한 기동의 요청 ${now.length}`);
    for (const s of now) {
      assert.match(s, /SNAP-MARKER-V2/, 'resume 에 지금 지시문');
      assert.doesNotMatch(s, /SNAP-MARKER-V1/, '기록된 옛 지시문은 나가지 않는다');
      assert.ok(s.includes(JSON.stringify(SLCODE_PROMPT).slice(1, 40)), 'slcode 고정 지시도');
    }
    assert.equal(new Set(now).size, 1, '같은 기동 안에서는 시스템 프롬프트가 턴마다 같다 (캐시)');
  } finally {
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
