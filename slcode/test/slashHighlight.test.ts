// 슬래시 명령 강조 (ticket slcode-slash-command-highlight) — 입력창 맨 앞의 아는 명령만 칠하고, 보낸 말풍선도 같게, 다시 연 화면(명령 목록이 기록보다 늦게 온다)에서도 같게.
// 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음). headless Chrome 이 있을 때만 본다. 도우미는 rewindInput.test.ts 와 같은 꼴.
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

test('웹: 입력창·말풍선 맨 앞의 아는 슬래시 명령만 강조한다 — 짧은 이름 포함, 다시 연 화면에서도', { skip: !chrome && 'chrome 없음', timeout: 180000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const api = await fakeApi();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-slash-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const cwd = tmp('slcode-slash-work-');
  fs.mkdirSync(path.join(cwd, '.claude/skills/hl-demo'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude/skills/hl-demo/SKILL.md'), '---\nname: hl-demo\ndescription: test skill\n---\nhi\n');
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await serveSession({ dir: tmp('slcode-slash-'), cwd, web: true, permissionMode: 'default' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  let ends = 0;
  await c.request('session.attach', { id });
  c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') ends++; });
  const typed = (text: string) => b.ev(`(() => { const i = document.querySelector('textarea'); i.value = ${JSON.stringify(text)}; i.oninput(); return document.querySelector('.input-hl .slash')?.textContent ?? null; })()`);
  const bubbles = `[...document.querySelectorAll('.feed .user .bubble')].map((x) => x.querySelector('.slash')?.textContent ?? null)`;
  try {
    await b.send('Page.navigate', { url: h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');
    await b.until(`(() => { const i = document.querySelector('textarea'); i.value = '/hl-demo x'; i.oninput(); return !!document.querySelector('.input-hl .slash'); })()`, '명령 목록');
    assert.equal(await typed('/hl-demo 글'), '/hl-demo');
    assert.equal(await typed('/HL-DEMO'), '/HL-DEMO', '대소문자는 가리지 않는다');
    assert.equal(await typed('/hl-dem 글'), null, '이름 일부는 칠하지 않는다');
    assert.equal(await typed('/tmp/a.txt 보기'), null, '목록에 없는 / 낱말');
    assert.equal(await typed('글 /hl-demo'), null, '맨 앞이 아니면');
    assert.equal(await b.ev(`(() => { const i = document.querySelector('textarea'), m = document.querySelector('.input-hl'); i.value = '/hl-demo 첫 줄\\n둘째 줄\\n'; i.oninput(); return m.textContent === i.value + '\\n'; })()`), true, '층은 textarea 글 + 끝 줄');
    await typed('');

    for (const text of ['/hl-demo 해 줘', '그냥 /hl-demo 글']) {
      const want = ends + 1, t0 = Date.now();
      await c.request('session.send', { id, text });
      while (ends < want) { if (Date.now() - t0 > 30000) assert.fail(`timed out: ${text}`); await sleep(30); }
    }
    await b.until(`document.querySelectorAll('.feed .user .bubble').length === 2`, '말풍선 둘');
    assert.deepEqual(await b.ev(bubbles), ['/hl-demo', null]);
    await b.send('Page.reload');
    await b.until(`document.querySelectorAll('.feed .user .bubble').length === 2 && !!document.querySelector('.feed .user .bubble .slash')`, '다시 연 화면의 말풍선');
    assert.deepEqual(await b.ev(bubbles), ['/hl-demo', null]);
  } finally {
    await b.close().catch(() => {});
    c.close();
    await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// 입력창 휠·Tab (ticket slcode-input-wheel-tab, 사용자 2026-11-24) — 같은 입력창이라 이 파일의 도우미를 쓴다.
// 넘치지 않는 입력창 위의 휠은 대화를 스크롤하고, 넘치면 입력창만(끝에 닿아도 대화로 넘기지 않는다). Tab·Shift+Tab 은 포커스를 옮기지 않는다
test('웹: 입력창 위 휠은 넘치지 않을 때만 대화를 스크롤하고, Tab·Shift+Tab 은 포커스를 입력창에 둔다', { skip: !chrome && 'chrome 없음', timeout: 120000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const api = await fakeApi();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-wheel-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { serveSession } = await import('../src/serve.ts');
  const h = await serveSession({ dir: tmp('slcode-wheel-'), cwd: tmp('slcode-wheel-work-'), web: true, permissionMode: 'default' });
  const st = `(() => { const f = document.querySelector('.feed'), i = document.querySelector('textarea'); return { feed: Math.round(f.scrollTop), input: Math.round(i.scrollTop), focused: document.activeElement === i, caret: i.selectionStart, value: i.value }; })()`;
  const wheel = async (deltaY: number) => {
    const c = await b.ev(`(() => { const r = document.querySelector('textarea').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY });
    await b.ev(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`); // 휠은 다음 프레임에 처리된다
  };
  const tab = async (shift: boolean) => {
    for (const type of ['rawKeyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 });
  };
  try {
    await b.send('Page.navigate', { url: h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');
    // 대화를 넘치게 하고 중간에 둔다 — 바닥에서 위로 올려야 맨 아래 따라가기가 풀린다
    const frame = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;
    await b.ev(`(() => { const f = document.querySelector('.feed'); f.append(Object.assign(document.createElement('div'), { style: 'height: 3000px' })); f.scrollTo({ top: f.scrollHeight, behavior: 'instant' }); })()`);
    await b.ev(frame);
    await b.ev(`document.querySelector('.feed').scrollTo({ top: 1000, behavior: 'instant' })`);
    await b.ev(frame);
    assert.equal((await b.ev(st)).feed, 1000);
    await wheel(-300);
    assert.equal((await b.ev(st)).feed, 700, '넘치지 않는 입력창 위의 휠은 대화를 올린다');
    await wheel(200);
    assert.equal((await b.ev(st)).feed, 900);

    await b.ev(`(() => { const i = document.querySelector('textarea'); i.value = Array.from({ length: 40 }, (_, k) => 'line ' + k).join('\\n'); i.oninput(); i.scrollTop = i.scrollHeight; })()`);
    const full = await b.ev(st);
    assert.ok(full.input > 0, '입력창이 넘친다');
    await wheel(-100);
    assert.deepEqual([(await b.ev(st)).feed, (await b.ev(st)).input], [full.feed, full.input - 100], '넘친 입력창은 자기만 스크롤한다');
    await wheel(-100000);
    await wheel(-300);
    assert.deepEqual([(await b.ev(st)).feed, (await b.ev(st)).input], [full.feed, 0], '맨 위에 닿아도 대화로 넘기지 않는다');

    await b.ev(`(() => { const i = document.querySelector('textarea'); i.focus(); i.setSelectionRange(3, 3); })()`);
    const before = await b.ev(st);
    await tab(false);
    assert.deepEqual(await b.ev(st), before, 'Tab 은 포커스·글·커서를 그대로 둔다');
    await tab(true);
    assert.deepEqual(await b.ev(st), before, 'Shift+Tab 도');
    assert.equal(await b.ev(`document.querySelector('.input-hl').tabIndex`), -1, '보이지 않는 강조 층은 Tab 자리가 아니다');
  } finally {
    await b.close().catch(() => {});
    await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
