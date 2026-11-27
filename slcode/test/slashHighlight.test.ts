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

test('웹: 실행 중 알약의 background 목록은 긴 명령이어도 입력창 폭 안에 머물고, 명령은 말줄임으로 잘리며 중지 버튼이 보인다 (ticket slcode-bg-row-overflow·slcode-sidebar-revamp)', { skip: !chrome && 'chrome 없음', timeout: 120000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const api = await fakeApi();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-bgrow-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await serveSession({ dir: tmp('slcode-bgrow-'), cwd: tmp('slcode-bgrow-work-'), web: true, permissionMode: 'default' });
  const c = await connectSession(h.sock);
  try {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await b.send('Page.navigate', { url: h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');
    const long = `sleep 30; ./scripts/run_batch.sh ${'experiments/full-sonnet5_5.py revision/sysprompt/all500_261124.txt '.repeat(4)}--resume`;
    const task = await c.request('session.bgRun', { id: h.session.id, command: long, description: 'full 조건 500건 풀이 (Sonnet 5.5, 워커 32개)' });
    await b.until(`!!document.querySelector('.wk .pl.busy')`, '실행 중 알약');
    await b.ev(`document.querySelector('.wk .pl.busy').click()`);
    await b.until(`!!document.querySelector('.wk .pop .bgstop')`, '펼친 목록');
    const m = await b.ev(`(() => { const r = (s) => document.querySelector(s).getBoundingClientRect(), box = r('.composer .box'), sub = document.querySelector('.wk .pop .bgit .s');
      return { box: [box.left, box.right], list: [r('.wk .pop').left, r('.wk .pop').right], stop: r('.wk .pop .bgstop').right, cut: sub.scrollWidth > sub.clientWidth, page: document.documentElement.scrollWidth - innerWidth }; })()`);
    assert.ok(m.list[0] >= m.box[0] && m.list[1] <= m.box[1], `목록은 입력창 폭 안에 (${m.list} / ${m.box})`);
    assert.ok(m.stop <= m.box[1], `중지 버튼이 입력창 폭 안에 (${m.stop} > ${m.box[1]})`);
    assert.ok(m.cut, '명령은 말줄임으로 잘린다');
    assert.equal(m.page, 0, '가로로 넘치지 않는다');
    await c.request('session.bgStop', { id: h.session.id, task: task.id });
  } finally {
    c.close();
    await b.close().catch(() => {});
    await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('웹: background 중지는 두 번 눌러야 끄고, 행을 누르면 출력 창에 색 코드를 뺀 출력이 보인다 (ticket slcode-sidebar-revamp, 사용자 2026-11-25)', { skip: !chrome && 'chrome 없음', timeout: 120000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const api = await fakeApi();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-bgterm-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await serveSession({ dir: tmp('slcode-bgterm-'), cwd: tmp('slcode-bgterm-work-'), web: true, permissionMode: 'default' });
  const c = await connectSession(h.sock);
  try {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await b.send('Page.navigate', { url: h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');
    const task = await c.request('session.bgRun', { id: h.session.id, command: `printf '\\033[32mready\\033[0m\\n'; printf 'step 1\\rstep 2\\n'; echo 한글; sleep 30`, description: '서버' }) as { id: string };
    const ended = async () => ((await c.request('session.bgList', { id: h.session.id })) as { tasks: { id: string; endedAt?: number; stoppedBy?: string }[] }).tasks.find((x) => x.id === task.id)!;
    await b.until(`!!document.querySelector('.wk .pl.busy')`, '실행 중 알약');
    await b.ev(`document.querySelector('.wk .pl.busy').click()`);
    await b.until(`!!document.querySelector('.wk .pop .bgstop')`, '펼친 목록');
    await b.ev(`document.querySelector('.wk .pop .bgstop').click()`);
    assert.equal(await b.ev(`document.querySelector('.wk .pop .bgstop').textContent`), '중지', '한 번 누르면 빨간 중지로 묻는다');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await ended()).endedAt, undefined, '아직 끄지 않는다');
    // 다른 곳을 누르면 곧바로 네모로
    await b.ev(`document.querySelector('.wk .pop .gh').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    assert.deepEqual(await b.ev(`[document.querySelector('.wk .pop .bgstop').className, !!document.querySelector('.wk .pop .bgstop svg')]`), ['bgstop', true], '다른 곳을 누르면 되돌아간다');
    await b.ev(`document.querySelector('.wk .pop .bgit').click()`);
    await b.until(`document.querySelector('.wk .tw:not([hidden]) pre')?.textContent.includes('한글')`, '출력 창');
    assert.equal(await b.ev(`document.querySelector('.wk .tw pre').textContent`), 'ready\nstep 2\n한글\n', '색 코드는 빼고 \\r 은 줄을 덮어쓴다');
    assert.ok(await b.ev(`!!document.querySelector('.wk .pop')`), '행을 눌러도 목록은 열린 채');
    assert.deepEqual(await b.ev(`[...document.querySelectorAll('.wk .tw button')].map((x) => x.className)`), ['fold', 'x'], '출력 창에는 접기·닫기만');
    assert.match(await b.ev(`document.querySelector('.wk .tw .st').textContent`) as string, /^실행 중 · \d+s$/, '지난 시간은 짧게 (16h 2m 꼴)');
    // 입력창에서 Esc — 목록만 닫고 친 글은 그대로 (사용자 2026-11-26)
    await b.ev(`(() => { const i = document.querySelector('textarea'); i.value = '쓰던 글'; i.oninput(); i.focus(); })()`);
    for (const type of ['rawKeyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.deepEqual(await b.ev(`[!!document.querySelector('.wk .pop'), document.querySelector('textarea').value, !document.querySelector('.wk .tw').hidden]`), [false, '쓰던 글', true], 'Esc 는 목록만 닫는다');
    await b.ev(`document.querySelector('.wk .pl.busy').click()`);
    await b.until(`!!document.querySelector('.wk .pop .bgstop')`, '다시 펼친 목록');
    // 알약 줄의 빈 곳도 바깥 (사용자 2026-11-26)
    await b.ev(`document.querySelector('.wk').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    assert.equal(await b.ev(`!!document.querySelector('.wk .pop')`), false, '알약 줄 빈 곳을 누르면 닫힌다');
    await b.ev(`document.querySelector('.wk .pl.busy').click()`);
    await b.until(`!!document.querySelector('.wk .pop .bgstop')`, '또 펼친 목록');
    await b.ev(`document.querySelector('.wk .pop .bgstop').click()`);
    await b.ev(`document.querySelector('.wk .pop .bgstop').click()`);
    await b.until(`document.querySelector('.wk .tw .st')?.textContent === '중지함'`, '출력 창에 끝남');
    assert.equal((await ended()).stoppedBy, 'user');
  } finally {
    c.close();
    await b.close().catch(() => {});
    await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('웹: 출력 창은 끝 조각만 받고 위로 올리면 앞부분을 더 받으며, 머리를 끌어 옮기고 오른쪽·아래 면과 모서리를 끌어 크기를 바꾸며, Ctrl+휠로 글자 크기를 바꾸고, − 로 접으며, 창을 누르면 목록이 닫힌다 (ticket slcode-sidebar-revamp, 사용자 2026-11-25)', { skip: !chrome && 'chrome 없음', timeout: 120000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const api = await fakeApi();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-bgterm2-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await serveSession({ dir: tmp('slcode-bgterm2-'), cwd: tmp('slcode-bgterm2-work-'), web: true, permissionMode: 'default' });
  const c = await connectSession(h.sock);
  try {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
    await b.send('Page.navigate', { url: h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');
    // 약 290KB — 한 번에 받는 128KB 보다 길다
    const task = await c.request('session.bgRun', { id: h.session.id, command: 'seq 1 50000; sleep 30', description: '긴 출력' }) as { id: string };
    await new Promise((r) => setTimeout(r, 500));
    await b.until(`!!document.querySelector('.wk .pl.busy')`, '실행 중 알약');
    await b.ev(`document.querySelector('.wk .pl.busy').click()`);
    await b.until(`!!document.querySelector('.wk .pop .bgit')`, '펼친 목록');
    await b.ev(`document.querySelector('.wk .pop .bgit').click()`);
    await b.until(`document.querySelector('.wk .tw pre')?.textContent.endsWith('50000\\n')`, '끝 조각');
    const lines = () => b.ev(`document.querySelector('.wk .tw pre').textContent.split('\\n').length`) as Promise<number>;
    const head = () => b.ev(`document.querySelector('.wk .tw pre').textContent.startsWith('1\\n2\\n')`) as Promise<boolean>;
    assert.ok((await lines()) < 50000, '앞부분은 아직 받지 않았다');
    assert.equal(await b.ev(`document.querySelector('.wk .tw .more').hidden`), false, '앞부분이 더 있다는 줄');
    assert.equal(await b.ev(`getComputedStyle(document.querySelector('.wk .tw .empty')).fontStyle`), 'italic');
    for (let i = 0; i < 10 && !(await head()); i++) {
      const n = await lines();
      await b.ev(`document.querySelector('.wk .tw .sc').scrollTop = 0`);
      await b.until(`document.querySelector('.wk .tw pre').textContent.split('\\n').length > ${n}`, '앞 조각');
      assert.ok(await b.ev(`document.querySelector('.wk .tw .sc').scrollTop > 0`), '보던 자리가 밀리지 않게 내린다');
    }
    assert.ok(await head(), '위로 올리면 파일 머리까지');
    assert.equal(await b.ev(`document.querySelector('.wk .tw pre').textContent`), Array.from({ length: 50000 }, (_, i) => `${i + 1}\n`).join(''), '빠지거나 겹친 줄이 없다');
    assert.equal(await b.ev(`document.querySelector('.wk .tw .more').hidden`), true);
    // 머리를 끌어 옮긴다
    const at = await b.ev(`(() => { const r = document.querySelector('.wk .tw .th .t').getBoundingClientRect(); return [r.left + 5, r.top + r.height / 2, document.querySelector('.wk .tw').getBoundingClientRect().top]; })()`) as number[];
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at[0], y: at[1], button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at[0] - 40, y: at[1] - 120, button: 'left' });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at[0] - 40, y: at[1] - 120, button: 'left', clickCount: 1 });
    assert.equal(Math.round((await b.ev(`document.querySelector('.wk .tw').getBoundingClientRect().top`)) as number), Math.round(at[2] - 120), '끈 만큼 옮겨졌다');
    // 목록을 연 채 출력 창을 누르면 목록이 닫힌다 — 머리를 끌 때 이미 닫혔다, 다시 연다
    assert.equal(await b.ev(`!!document.querySelector('.wk .pop')`), false, '머리를 누르면 목록이 닫힌다');
    await b.ev(`document.querySelector('.wk .pl.busy').click()`);
    assert.ok(await b.ev(`!!document.querySelector('.wk .pop')`));
    const p = await b.ev(`(() => { const r = document.querySelector('.wk .tw .sc').getBoundingClientRect(); return [r.right - 30, r.top + 20]; })()`) as number[];
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p[0], y: p[1], button: 'left', clickCount: 1 });
    assert.equal(await b.ev(`!!document.querySelector('.wk .pop')`), false, '출력 창을 누르면 목록이 닫힌다');
    // 오른쪽 아래 모서리를 끌어 크기를 바꾼다 — 왼쪽 위 모서리는 제자리, 최소 크기 아래로는 줄지 않는다 (사용자 2026-11-26)
    const box = `(() => { const r = document.querySelector('.wk .tw').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })()`;
    const resize = async (ddx: number, ddy: number, k = 'c') => {
      const g = await b.ev(`(() => { const r = document.querySelector('.wk .tw .rz.${k}').getBoundingClientRect(); return [r.left + Math.min(r.width / 2, 7), r.top + Math.min(r.height / 2, 7)]; })()`) as number[];
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g[0], y: g[1], button: 'left', clickCount: 1 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: g[0] + ddx, y: g[1] + ddy, button: 'left' });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g[0] + ddx, y: g[1] + ddy, button: 'left', clickCount: 1 });
      return await b.ev(box) as number[];
    };
    const b0 = await b.ev(box) as number[];
    assert.deepEqual(await resize(-100, 60), [b0[0], b0[1], b0[2] - 100, b0[3] + 60], '줄이고 늘린 만큼, 왼쪽 위는 그대로');
    assert.deepEqual((await resize(-2000, -2000)).slice(2), [320, 120], '최소 크기');
    // 오른쪽 면(머리 줄 높이에서 잡아도)은 너비만, 아래 면은 높이만
    assert.ok(await b.ev(`(() => { const r = document.querySelector('.wk .tw .rz.r').getBoundingClientRect(), t = document.querySelector('.wk .tw .th').getBoundingClientRect(); return r.top <= t.top + 1 && document.elementFromPoint(r.left + 2, t.top + t.height / 2)?.classList.contains('r'); })()`), '오른쪽 면 손잡이는 머리 줄까지');
    const b2 = await b.ev(box) as number[];
    assert.deepEqual(await resize(80, 50, 'r'), [b2[0], b2[1], b2[2] + 80, b2[3]], '오른쪽 면은 너비만');
    assert.deepEqual(await resize(80, 50, 'b'), [b2[0], b2[1], b2[2] + 80, b2[3] + 50], '아래 면은 높이만');
    // − 로 접으면 머리 줄만, 머리는 제자리 — 다시 누르면 같은 크기로 펼친다 (사용자 2026-11-26)
    const b1 = await b.ev(box) as number[];
    await b.ev(`document.querySelector('.wk .tw .fold').click()`);
    const hh = await b.ev(`document.querySelector('.wk .tw .th').offsetHeight + 2`) as number; // 위아래 테두리
    assert.deepEqual(await b.ev(box), [b1[0], b1[1], b1[2], hh], '접으면 머리 줄만');
    assert.equal(await b.ev(`document.querySelector('.wk .tw .sc').offsetParent`), null);
    await b.ev(`document.querySelector('.wk .tw .fold').click()`);
    assert.deepEqual(await b.ev(box), b1, '펼치면 그대로');
    // Ctrl+휠은 페이지 확대 대신 출력 글자 크기 (사용자 2026-11-26)
    const wheel = (deltaY: number, ctrlKey = true) => b.ev(`(() => { const s = document.querySelector('.wk .tw .sc'), e = new WheelEvent('wheel', { deltaY: ${deltaY}, ctrlKey: ${ctrlKey}, bubbles: true, cancelable: true }); s.dispatchEvent(e); return [e.defaultPrevented, getComputedStyle(s).fontSize]; })()`);
    assert.deepEqual(await wheel(-100), [true, '13px'], '위로 한 칸 — 1px 크게, 페이지 확대는 막는다');
    assert.deepEqual(await wheel(30), [true, '13px'], '핀치처럼 잘게 오는 값은 모은다');
    assert.deepEqual(await wheel(30), [true, '12px']);
    for (let i = 0; i < 10; i++) await wheel(100);
    assert.deepEqual(await wheel(100), [true, '9px'], '가장 작게 9px');
    assert.deepEqual(await wheel(100, false), [false, '9px'], 'Ctrl 없는 휠은 그대로 스크롤');
    await c.request('session.bgStop', { id: h.session.id, task: task.id });
  } finally {
    c.close();
    await b.close().catch(() => {});
    await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('웹: 사이드바는 고정 글 줄·활동 기록·"세션 구성" 한 줄이고, 그 창은 지시문|AGENTS.md(CLAUDE.md)|기능 탭에 출처를 달고, 스킬은 하위 파일과 원문을, 출처를 누르면 그 출처만 보인다 (ticket slcode-sidebar-revamp, 사용자 2026-11-26)', { skip: !chrome && 'chrome 없음', timeout: 120000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const api = await fakeApi();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  const home = tmp('slcode-side-home-');
  fs.mkdirSync(path.join(home, '.claude/skills/my-skill'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/skills/my-skill/SKILL.md'), '---\nname: my-skill\ndescription: test\n---\n\n# My skill body\n');
  fs.mkdirSync(path.join(home, '.claude/skills/my-skill/scripts'));
  fs.writeFileSync(path.join(home, '.claude/skills/my-skill/scripts/run.sh'), 'echo run\n');
  fs.writeFileSync(path.join(home, '.claude/CLAUDE.md'), '# my rules\n');
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await serveSession({ dir: tmp('slcode-side-'), cwd: tmp('slcode-side-work-'), web: true, permissionMode: 'default' });
  const c = await connectSession(h.sock);
  try {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 800, deviceScaleFactor: 1, mobile: false });
    await b.send('Page.navigate', { url: h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');
    await c.request('session.send', { id: h.session.id, text: 'hi' }); // session.ready 는 첫 턴에 온다
    await b.until(`document.querySelector('.side .top')?.textContent.includes(${JSON.stringify(h.session.id)}) && document.querySelectorAll('.side .top .row').length >= 3`, '고정 줄');
    assert.deepEqual(await b.ev(`[document.querySelectorAll('.side details').length, document.querySelectorAll('.side hr').length, document.querySelector('.side .open-pv').textContent]`), [0, 3, '세션 구성'], '접는 칸 없이 가로줄로');
    await b.ev(`document.querySelector('.side .open-pv').click()`);
    const rows = `[...document.querySelectorAll('.pvl .it')].map((x) => [x.querySelector('.nm').textContent, x.querySelector('.tag')?.textContent ?? null])`;
    const row = (nm: string) => `[...document.querySelectorAll('.pvl .it')].find((x) => x.querySelector('.nm').textContent === ${JSON.stringify(nm)})`;
    assert.deepEqual(await b.ev(`[document.querySelector('dialog.pvd').open, [...document.querySelectorAll('.pvd .tabs button')].map((x) => [x.textContent, x.getAttribute('aria-current')])]`), [true, [['지시문', 'true'], ['AGENTS.md', 'false'], ['기능', 'false']]]);
    // 지시문: system prompt 조각만, AGENTS.md: 첫 메시지에 붙는 CLAUDE.md
    assert.deepEqual(await b.ev(`[...document.querySelectorAll('.pvl .gl')].map((x) => x.textContent)`), ['system prompt']);
    // 지시문 탭은 고른 줄이 든 묶음의 줄을 한 글로 잇고, 목록의 줄을 누르면 그 자리로 간다 (사용자 2026-11-27)
    const group = (n: number) => `(() => { const out = []; let g = -1; for (const x of document.querySelector('.pvl').children) { if (x.classList.contains('gl')) g++; else if (g === ${n} && x.classList.contains('it')) out.push(x.querySelector('.nm').textContent); } return out; })()`;
    const shownDoc = `[...document.querySelectorAll('.pvb.doc .grp > section .lb .nm')].map((x) => x.textContent)`;
    await b.until(`${group(0)}.length > 0 && JSON.stringify(${shownDoc}) === JSON.stringify(${group(0)})`, '지시문 한 글');
    assert.deepEqual(await b.ev(`[...document.querySelectorAll('.pvb.doc .gh b')].map((x) => x.textContent)`), ['system prompt']);
    // 블록마다 복사 단추, 원문 상자에 포커스를 두고 Ctrl+A 를 누르면 그 상자의 글만 고른다
    assert.deepEqual(await b.ev(`(() => { const p = document.querySelector('.pvb.doc section pre'); p.focus(); p.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })); return [getSelection().toString() === p.textContent, document.querySelectorAll('.pvb.doc section .lb button.ico').length === document.querySelectorAll('.pvb.doc section').length]; })()`), [true, true]);
    // 다른 묶음의 줄을 누르면 그 묶음의 글로 바뀐다 — 두 묶음을 한 화면에 잇지 않는다
    if (((await b.ev(group(1))) as string[]).length) {
      await b.ev(`[...document.querySelectorAll('.pvl .it')].at(-1).click()`);
      await b.until(`JSON.stringify(${shownDoc}) === JSON.stringify(${group(1)})`, '첫 메시지 글');
      assert.equal(await b.ev(`[...document.querySelectorAll('.pvl .it')].at(-1).getAttribute('aria-current')`), 'true');
    }
    await b.ev(`[...document.querySelectorAll('.pvd .tabs button')][1].click()`);
    await b.until(`!!${row('CLAUDE.md')}`, 'AGENTS.md 목록');
    assert.deepEqual(await b.ev(rows), [['CLAUDE.md', '사용자']]);
    await b.ev(`${row('CLAUDE.md')}.click()`);
    await b.until(`document.querySelector('.pvb pre')?.textContent === '# my rules\\n'`, 'CLAUDE.md 원문');
    // 기능: 첫 줄(파일 스킬)을 고른 채로, 하위 파일 목록과 SKILL.md 원문
    await b.ev(`[...document.querySelectorAll('.pvd .tabs button')][2].click()`);
    await b.until(`document.querySelector('.pvl .it[aria-current=true] .nm')?.textContent === 'my-skill'`, '기능 첫 줄');
    await b.until(`document.querySelectorAll('.pvb .files .it').length === 2`, '하위 파일');
    assert.deepEqual(await b.ev(`[...document.querySelectorAll('.pvb .files .nm')].map((x) => x.textContent)`), ['SKILL.md', 'scripts/run.sh']);
    await b.until(`document.querySelector('.pvb pre')?.textContent.includes('# My skill body')`, 'SKILL.md 원문');
    await b.ev(`[...document.querySelectorAll('.pvb .files .it')][1].click()`);
    await b.until(`document.querySelector('.pvb pre')?.textContent === 'echo run\\n'`, '하위 파일 원문');
    // 내장 스킬은 한 줄로 접고 이름만
    await b.ev(`${row('Claude Code 내장 스킬')}.click()`);
    assert.match(await b.ev(`document.querySelector('.pvb').textContent`) as string, /원문은 Claude Code 안에 있어 볼 수 없습니다/);
    // 출처를 누르면 그 출처만 — 탭을 바꿔도 남는다
    await b.ev(`${row('my-skill')}.querySelector('.tag').click()`);
    assert.equal(await b.ev(`document.querySelector('.pvl .filter span').textContent`), '출처: 사용자');
    assert.deepEqual(await b.ev(rows), [['my-skill', '사용자']]);
    await b.ev(`[...document.querySelectorAll('.pvd .tabs button')][1].click()`);
    assert.deepEqual(await b.ev(rows), [['CLAUDE.md', '사용자']]);
    await b.ev(`document.querySelector('.pvl .filter button').click()`);
    assert.equal(await b.ev(`document.querySelector('.pvl .filter')`), null);
    for (const type of ['rawKeyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await b.until(`!document.querySelector('dialog.pvd').open`, 'Esc 로 닫힘');
  } finally {
    c.close();
    await b.close().catch(() => {});
    await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
