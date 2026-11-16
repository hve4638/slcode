// 되돌리기로 입력창에 돌아온 요청의 높이 (ticket slcode-rewind-input-height) — Esc 두 번 창과 턴 옆 버튼 두 경로에서 입력창 높이가 글에 맞는지.
// 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음). headless Chrome 이 있을 때만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const chrome = ['google-chrome', 'chromium', 'chromium-browser'].find((c) => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true; } catch { return false; } });

/** Messages API 흉내 — 무엇을 받든 "hi" */
async function fakeApi() {
  let n = 0;
  const sse = (text: string) => ([
    ['message_start', { type: 'message_start', message: { id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as [string, unknown][]).map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":5}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse('hi'));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

/** headless Chrome 과 CDP 탭 하나 (webSwitch.test.ts 와 같은 꼴) */
async function openChrome(bin: string) {
  const profile = tmp('slcode-chrome-');
  const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], detached: true });
  let err = '';
  proc.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
  let ws: WebSocket | undefined;
  const close = async () => {
    ws?.close();
    if (proc.exitCode === null && proc.signalCode === null) { const out = new Promise((r) => proc.once('exit', r)); try { process.kill(-proc.pid!, 'SIGKILL'); } catch { proc.kill('SIGKILL'); } await out; }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 임시 폴더 */ }
  };
  try {
    const t0 = Date.now();
    let browserWs = '';
    while (!browserWs && proc.exitCode === null && Date.now() - t0 < 15000) { browserWs = /DevTools listening on (ws:\S+)/.exec(err)?.[1] ?? ''; await sleep(50); }
    if (!browserWs) throw new Error(`chrome did not start (exit ${proc.exitCode}): ${err.trim().slice(-400)}`);
    const base = new URL(browserWs); base.protocol = 'http:'; base.pathname = '';
    const target = await (await fetch(`${base.origin}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(15000) })).json() as { webSocketDebuggerUrl: string };
    const sock = new WebSocket(target.webSocketDebuggerUrl);
    ws = sock;
    await new Promise((r, j) => { sock.onopen = r; sock.onerror = () => j(new Error('cdp socket did not open')); });
    let n = 0;
    const wait = new Map<number, (m: any) => void>();
    sock.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && wait.has(m.id)) { wait.get(m.id)!(m); wait.delete(m.id); } };
    const send = (method: string, params: unknown = {}) => new Promise<any>((r, j) => {
      const id = ++n;
      const timer = setTimeout(() => { wait.delete(id); j(new Error(`cdp ${method} timed out`)); }, 15000);
      wait.set(id, (m) => { clearTimeout(timer); r(m); });
      sock.send(JSON.stringify({ id, method, params }));
    });
    const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result?.value;
    const until = async (expression: string, what: string) => { const t = Date.now(); while (Date.now() - t < 20000) { if (await ev(expression)) return; await sleep(30); } assert.fail(`timed out: ${what}`); };
    const key = async (k: string) => {
      const code = { Enter: 13, Escape: 27, ArrowUp: 38 }[k]!;
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code });
    };
    await send('Page.enable'); await send('Runtime.enable');
    return { send, ev, until, key, close };
  } catch (e) {
    await close();
    throw e;
  }
}

test('웹: 되돌리기로 돌아온 요청에 입력창 높이가 맞는다 — Esc 두 번 창과 턴 옆 버튼, 한 줄·여러 줄·220px 넘는 글', { skip: !chrome && 'chrome 없음', timeout: 180000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const api = await fakeApi();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-rwin-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await serveSession({ dir: tmp('slcode-rwin-'), cwd: tmp('slcode-rwin-work-'), web: true, permissionMode: 'default' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  let ends = 0;
  await c.request('session.attach', { id });
  c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') ends++; });
  const turn = async (text: string) => { const want = ends + 1, t0 = Date.now(); await c.request('session.send', { id, text }); while (ends < want) { if (Date.now() - t0 > 30000) assert.fail(`timed out: ${text}`); await sleep(30); } };
  const ONE = 'one line', MULTI = 'first\nsecond\nthird\nfourth', LONG = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const ta = `document.querySelector('textarea')`;
  /** 입력창의 지금 높이와, 같은 글로 다시 쟀을 때의 높이·한 줄 높이 */
  const heights = () => b.ev(`(() => { const i = ${ta}, now = i.offsetHeight, keep = i.style.height, text = i.value;
    i.style.height = ''; const want = Math.min(i.scrollHeight, 220) + i.offsetHeight - i.clientHeight;
    i.value = ''; const one = i.offsetHeight; i.value = text; i.style.height = keep;
    return { now, want, one }; })()`);
  const check = async (text: string, what: string) => {
    await b.until(`${ta}.value === ${JSON.stringify(text)} && !document.querySelector('.composer').hidden`, `${what}: 입력창에 요청이 돌아온다`);
    const hh = await heights();
    assert.equal(hh.now, hh.want, `${what}: 높이 ${JSON.stringify(hh)}`);
    if (text === ONE) assert.equal(hh.now, hh.one, `${what}: 한 줄 높이`); else assert.ok(hh.now > hh.one, `${what}: 한 줄보다 높다 ${JSON.stringify(hh)}`);
    await b.ev(`(() => { const i = ${ta}; i.value = ''; i.oninput(); })()`);
  };
  try {
    await b.send('Page.navigate', { url: h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');

    // Esc 두 번 창 — 맨 아래 '지금' 에서 ↑ 한 번이 마지막 요청, Enter 로 확인 단계, 첫 동작(대화만 되돌리기)을 Enter 로
    for (const text of [ONE, MULTI, LONG]) await turn(text);
    for (const text of [LONG, MULTI, ONE]) {
      await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '대기');
      await b.ev(`${ta}.focus()`);
      await b.key('Escape'); await b.key('Escape');
      await b.until(`!!document.querySelector('.rewind .rows')`, '되돌리기 창');
      await b.key('ArrowUp'); await b.key('Enter');
      await b.until(`!!document.querySelector('.rewind .opts')`, '확인 단계');
      await b.key('Enter');
      await check(text, `Esc 창 (${text.split('\n').length}줄)`);
    }

    // 턴 옆 버튼 — 이 턴부터 되돌리기 → 답변만
    for (const text of [ONE, MULTI, LONG]) await turn(text);
    for (const text of [LONG, MULTI, ONE]) {
      await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '대기');
      await b.ev(`[...document.querySelectorAll('button[aria-label="이 턴부터 되돌리기"]')].at(-1).click()`);
      await b.ev(`[...document.querySelectorAll('.acts button')].findLast((x) => x.textContent === '답변만').click()`);
      await check(text, `턴 버튼 (${text.split('\n').length}줄)`);
    }
  } finally {
    await b.close().catch(() => {});
    c.close();
    await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
