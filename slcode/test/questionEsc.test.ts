// 질문창의 Esc·Chat about this 와 승인 카드의 거절 (ticket slcode-question-esc-chat, 사용자 결정 2026-11-08) — 모델이 받는 글이 Claude Code TUI 와 같은지.
// 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음). 기대값은 TUI 2.1.319 를 같은 가짜 API 에 붙여 받은 요청 본문이다.
// 화면 쪽(키보드만으로 두 동작)은 headless Chrome 이 있을 때만 본다.
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

// TUI 2.1.319 실측 — Esc(피드백 없는 거절)와 Chat about this(피드백 거절)의 tool_result. TUI 는 끝에 system-reminder 를 덧붙이지만 그건 TUI 몫이다
const STOP = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";
const WITH_FEEDBACK = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";
const CLARIFY = (asked: string) => `The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n${asked}`;
const INTERRUPTED = '[Request interrupted by user for tool use]\n';

/** Messages API 흉내 — 마지막 사용자 글에 ASKME 면 질문 둘, BASHME 면 Bash 하나를 부르고 그 밖은 "ok". 본 대화 요청(tools 가 있는 것)의 messages 를 모은다 */
async function fakeApi() {
  let n = 0;
  // message id 는 응답마다 달라야 한다 — 같으면 CLI 가 한 메시지로 합친다
  const sse = (content: any[], stop: string) => {
    const ev: [string, unknown][] = [['message_start', { type: 'message_start', message: { id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }]];
    content.forEach((b, i) => {
      ev.push(['content_block_start', { type: 'content_block_start', index: i, content_block: b.type === 'text' ? { type: 'text', text: '' } : { ...b, input: {} } }]);
      ev.push(['content_block_delta', { type: 'content_block_delta', index: i, delta: b.type === 'text' ? { type: 'text_delta', text: b.text } : { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }]);
      ev.push(['content_block_stop', { type: 'content_block_stop', index: i }]);
    });
    ev.push(['message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } }], ['message_stop', { type: 'message_stop' }]);
    return ev.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  };
  const convos: any[][] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j: any = null; try { j = JSON.parse(body); } catch {}
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.includes('count_tokens') ? '{"input_tokens":5}' : '{}');
      const main = (j?.tools?.length ?? 0) > 0;
      if (main) convos.push(j.messages);
      const last = [...(j?.messages ?? [])].reverse().find((m: any) => m.role === 'user'); // slcode 요청은 끝에 system 메시지가 붙는다
      // 사용자 메시지의 마지막 블록으로 본다 — 중단 뒤의 새 글은 앞 tool_result 와 한 메시지로 합쳐진다
      const tail = typeof last?.content === 'string' ? { type: 'text', text: last.content } : last?.content?.at(-1);
      const text = tail?.type === 'text' ? tail.text : '', answered = tail?.type === 'tool_result';
      let content: any[] = [{ type: 'text', text: 'ok' }], stop = 'end_turn';
      if (main && !answered && /ASKME/.test(text)) {
        content = [{ type: 'tool_use', id: `toolu_q${++n}`, name: 'AskUserQuestion', input: { questions: [
          { question: 'Which color do you prefer?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] },
          { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small', description: 's' }, { label: 'Large', description: 'l' }] },
        ] } }];
        stop = 'tool_use';
      } else if (main && !answered && /ASKMULTI/.test(text)) {
        content = [{ type: 'tool_use', id: `toolu_m${++n}`, name: 'AskUserQuestion', input: { questions: [
          { question: 'Which toppings?', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese', description: 'c' }, { label: 'Ham', description: 'h' }, { label: 'Olive', description: 'o' }] },
          { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'Small', description: 's' }, { label: 'Large', description: 'l' }] },
        ] } }];
        stop = 'tool_use';
      } else if (main && !answered && /BASHME/.test(text)) {
        content = [{ type: 'tool_use', id: `toolu_b${++n}`, name: 'Bash', input: { command: 'touch bashme-ran', description: 'touch a file' } }];
        stop = 'tool_use';
      }
      if (j?.stream) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse(content, stop));
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'title' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, convos, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

/** tool_use id 에 대한 tool_result 와 그 뒤 사용자 글 — 가장 나중 요청 기준 */
function resultOf(convos: any[][], toolUseId: string) {
  for (const msgs of [...convos].reverse()) {
    for (let i = 0; i < msgs.length; i++) {
      const blocks = Array.isArray(msgs[i].content) ? msgs[i].content : [];
      const r = blocks.find((b: any) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
      if (r) return { content: typeof r.content === 'string' ? r.content : r.content.map((c: any) => c.text).join(''), isError: r.is_error === true, after: [...blocks.filter((b: any) => b !== r), ...(msgs[i + 1]?.role === 'user' ? msgs[i + 1].content : [])].filter((b: any) => b.type === 'text').map((b: any) => b.text) };
    }
  }
  return null;
}

/** 격리 env(로그인 없는 HOME + 가짜 키 + 가짜 게이트웨이)에서 세션 하나를 띄운다. core 는 자식 프로세스라 env 를 물려받는다 */
async function setup(apiUrl: string, web: boolean) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-qesc-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: apiUrl, SLCODE_GRACE_SECS: '1' });
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const work = tmp('slcode-qesc-work-');
  const h = await serveSession({ dir: tmp('slcode-qesc-'), cwd: work, web, permissionMode: 'default' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  const evs: any[] = [];
  const waiters: [(e: any) => boolean, (e: any) => void][] = [];
  c.onEvent((m: any) => {
    if (m.event !== 'session.event') return;
    const ev = m.params.ev; evs.push(ev);
    for (const w of [...waiters]) if (w[0](ev)) { waiters.splice(waiters.indexOf(w), 1); w[1](ev); }
  });
  await c.request('session.attach', { id });
  const next = (pred: (e: any) => boolean, what: string) => new Promise<any>((r, j) => { waiters.push([pred, r]); setTimeout(() => j(new Error(`timed out: ${what}`)), 30000); });
  const restore = () => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); };
  return { h, c, id, evs, next, work, restore };
}

test('claude: 질문 Chat 은 TUI 와 같은 피드백 거절로 턴이 이어지고, Esc(턴 중단)와 승인 거절(interrupt)은 TUI 의 Esc 와 같은 기록으로 턴을 끝낸다', { timeout: 180000 }, async () => {
  const api = await fakeApi();
  const s = await setup(api.url, false);
  try {
    // Chat about this — 화면이 만드는 피드백을 그대로 보낸다
    let req = s.next((e) => e.kind === 'approval.requested', '질문 1');
    await s.c.request('session.send', { id: s.id, text: 'please ASKME one' });
    let q = await req;
    const feedback = CLARIFY('- "Which color do you prefer?"\n  Answer: Red\n- "Which size?"\n  (No answer provided)');
    let end = s.next((e) => e.kind === 'turn.end', 'Chat 턴 끝');
    await s.c.request('session.approve', { id: s.id, requestId: q.requestId, decision: 'deny', message: feedback });
    assert.equal((await end).interrupted, false, 'Chat 은 턴을 끊지 않는다 — 모델이 이어서 답한다');
    let r = resultOf(api.convos, q.toolUseId)!;
    assert.equal(r.content, WITH_FEEDBACK + feedback);
    assert.equal(r.isError, true);
    assert.deepEqual(r.after, []);
    assert.ok(api.convos.at(-1)!.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.tool_use_id === q.toolUseId)), 'tool_result 를 받은 모델 요청이 이어졌다');

    // Esc — 화면은 session.interrupt 를 보낸다. 대기는 cancelled, 턴은 interrupted
    req = s.next((e) => e.kind === 'approval.requested', '질문 2');
    await s.c.request('session.send', { id: s.id, text: 'please ASKME two' });
    q = await req;
    const resolved = s.next((e) => e.kind === 'approval.resolved', 'Esc 해소');
    end = s.next((e) => e.kind === 'turn.end', 'Esc 턴 끝');
    const asked = api.convos.length;
    await s.c.request('session.interrupt', { id: s.id });
    assert.equal((await resolved).decision, 'cancelled');
    assert.equal((await end).interrupted, true);
    assert.equal(api.convos.length, asked, 'Esc 뒤에 모델을 다시 부르지 않는다');
    end = s.next((e) => e.kind === 'turn.end', '다음 턴');
    await s.c.request('session.send', { id: s.id, text: 'next' });
    await end;
    r = resultOf(api.convos, q.toolUseId)!;
    assert.equal(r.content, STOP);
    assert.deepEqual(r.after, [INTERRUPTED, 'next'], 'TUI 와 같다 — 중단 표시 뒤에 다음 사용자 글');

    // 승인 카드의 거절 — deny + interrupt. 명령은 돌지 않고 턴이 끝난다
    req = s.next((e) => e.kind === 'approval.requested' && e.name === 'Bash', 'Bash 승인');
    await s.c.request('session.send', { id: s.id, text: 'please BASHME' });
    q = await req;
    const denied = s.next((e) => e.kind === 'approval.resolved', '거절 해소');
    end = s.next((e) => e.kind === 'turn.end', '거절 턴 끝');
    await s.c.request('session.approve', { id: s.id, requestId: q.requestId, decision: 'deny', interrupt: true });
    assert.equal((await denied).decision, 'deny');
    assert.equal((await end).interrupted, true);
    end = s.next((e) => e.kind === 'turn.end', '다음 턴');
    await s.c.request('session.send', { id: s.id, text: 'next' });
    await end;
    r = resultOf(api.convos, q.toolUseId)!;
    assert.equal(r.content, STOP);
    assert.deepEqual(r.after, [INTERRUPTED, 'next'], 'TUI 와 같다 — 중단 표시 뒤에 다음 사용자 글');
    assert.equal(fs.existsSync(path.join(s.work, 'bashme-ran')), false);
  } finally {
    s.c.close();
    await s.h.close('test');
    api.srv.close();
    s.restore();
  }
});

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
      const code = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 }[k]!;
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code });
    };
    const type = (text: string) => send('Input.insertText', { text });
    await send('Page.enable'); await send('Runtime.enable');
    return { send, ev, until, key, type, close };
  } catch (e) {
    await close();
    throw e;
  }
}

test('웹: 키보드만으로 — 질문은 ↓ 로 Chat about this 에 가서 Enter, Esc 는 질문 취소·턴 종료, 승인 카드의 Esc 는 거절·턴 종료', { skip: !chrome && 'chrome 없음', timeout: 180000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const api = await fakeApi();
  const s = await setup(api.url, true);
  const card = `document.querySelector('.card.live')`;
  const lastMark = `[...document.querySelectorAll('.mark')].at(-1)?.querySelector('.res')?.textContent`;
  try {
    await b.send('Page.navigate', { url: s.h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');
    await b.ev(`document.querySelector('textarea').focus()`);

    // Chat about this — 첫 질문은 Enter 로 Red, 둘째 질문에서 ↓ 셋(Large·직접 입력·Chat about this) 뒤 Enter
    let req = s.next((e) => e.kind === 'approval.requested', '질문 1');
    await s.c.request('session.send', { id: s.id, text: 'please ASKME one' });
    let q = await req;
    await b.until(`document.activeElement === ${card}`, '질문 카드에 포커스');
    await b.key('Enter');
    await b.until(`${card}?.querySelector('.qt')?.textContent === 'Which size?'`, '둘째 질문');
    for (let i = 0; i < 3; i++) await b.key('ArrowDown');
    assert.equal(await b.ev(`${card}.querySelector('.cur')?.textContent`), 'Chat about this');
    let end = s.next((e) => e.kind === 'turn.end', 'Chat 턴 끝');
    await b.key('Enter');
    assert.equal((await end).interrupted, false);
    await b.until(`${lastMark} === '채팅으로'`, '끝난 질문 표시: 채팅으로');
    assert.equal(resultOf(api.convos, q.toolUseId)!.content, WITH_FEEDBACK + CLARIFY('- "Which color do you prefer?"\n  Answer: Red\n- "Which size?"\n  (No answer provided)'));

    // 원본(TUI 2.1.319)과 갈리기 쉬운 답 — 다중 선택은 고른 순서 + Enter 전의 직접 입력, 단일 선택은 Enter 전의 직접 입력을 답으로 치지 않는다
    const chatVia = async (text: string, keys: () => Promise<void>, asked: string) => {
      const r = s.next((e) => e.kind === 'approval.requested', text);
      await s.c.request('session.send', { id: s.id, text });
      const qq = await r;
      await b.until(`document.activeElement === ${card}`, '질문 카드에 포커스');
      const e = s.next((x) => x.kind === 'turn.end', `${text} 턴 끝`);
      await keys();
      assert.equal(await b.ev(`${card}?.querySelector('.cur')?.textContent`), 'Chat about this');
      await b.key('Enter');
      await e;
      assert.equal(resultOf(api.convos, qq.toolUseId)!.content, WITH_FEEDBACK + CLARIFY(asked));
    };
    await chatVia('please ASKMULTI', async () => {
      await b.key('ArrowDown'); await b.key('ArrowDown'); await b.key('Enter'); // Olive
      await b.key('ArrowUp'); await b.key('ArrowUp'); await b.key('Enter'); // Cheese
      for (let i = 0; i < 3; i++) await b.key('ArrowDown');
      await b.key('Enter'); await b.type('extra anchovy'); // 직접 입력 — Enter 없이
      await b.key('ArrowDown');
    }, '- "Which toppings?"\n  Answer: Olive, Cheese, extra anchovy\n- "Which size?"\n  (No answer provided)');
    await chatVia('please ASKME green', async () => {
      await b.key('ArrowDown'); await b.key('ArrowDown'); await b.key('Enter'); await b.type('green'); // Enter 없이
      await b.key('ArrowDown');
    }, '- "Which color do you prefer?"\n  (No answer provided)\n- "Which size?"\n  (No answer provided)');
    await chatVia('please ASKME green2', async () => {
      await b.key('ArrowDown'); await b.key('ArrowDown'); await b.key('Enter'); await b.type('green'); await b.key('Enter'); // 확정 → 둘째 질문
      await b.until(`${card}?.querySelector('.qt')?.textContent === 'Which size?'`, '둘째 질문');
      for (let i = 0; i < 3; i++) await b.key('ArrowDown');
    }, '- "Which color do you prefer?"\n  Answer: green\n- "Which size?"\n  (No answer provided)');

    // Esc — 질문창이 닫히고 턴이 끝나며 입력창으로
    req = s.next((e) => e.kind === 'approval.requested', '질문 2');
    await s.c.request('session.send', { id: s.id, text: 'please ASKME two' });
    q = await req;
    await b.until(`document.activeElement === ${card}`, '질문 카드에 포커스');
    // 카드 밖을 눌러도 키는 카드로 (사용자 2026-11-08) — 피드 빈 곳을 누르면 카드에 포커스, 포커스가 빠져 있어도 ↓·Esc 는 카드가 받는다
    const pt = await b.ev(`(() => { const r = document.querySelector('.feed').getBoundingClientRect(); return { x: r.left + 4, y: r.top + 4 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, ...pt, button: 'left', clickCount: 1 });
    const hit = await b.ev(`(() => { const e = document.elementFromPoint(${pt.x}, ${pt.y}); return e ? e.tagName + '.' + e.className : ''; })()`);
    await b.until(`document.activeElement === ${card}`, `빈 곳을 누르면 카드로 (누른 곳 ${hit}, 선택 ${await b.ev(`getSelection().isCollapsed`)})`);
    await b.ev(`document.activeElement.blur()`);
    await b.key('ArrowDown');
    assert.equal(await b.ev(`[...${card}.querySelectorAll('.q label')].indexOf(${card}.querySelector('.cur'))`), 1, '포커스 없이 ↓');
    await b.ev(`document.activeElement.blur()`);
    end = s.next((e) => e.kind === 'turn.end', 'Esc 턴 끝');
    await b.key('Escape');
    assert.equal((await end).interrupted, true);
    await b.until(`${lastMark} === '취소됨'`, '끝난 질문 표시: 취소됨');
    await b.until(`document.activeElement === document.querySelector('textarea') && !document.querySelector('.composer').hidden`, '입력창으로');

    // 승인 카드 Esc — 거절하고 턴이 끝난다
    req = s.next((e) => e.kind === 'approval.requested' && e.name === 'Bash', 'Bash 승인');
    await s.c.request('session.send', { id: s.id, text: 'please BASHME' });
    q = await req;
    await b.until(`document.activeElement === ${card}`, '승인 카드에 포커스');
    end = s.next((e) => e.kind === 'turn.end', '거절 턴 끝');
    await b.key('Escape');
    assert.equal((await end).interrupted, true);
    await b.until(`${lastMark} === '거절됨'`, '끝난 승인 표시: 거절됨');
    assert.equal(fs.existsSync(path.join(s.work, 'bashme-ran')), false);
  } finally {
    await b.close().catch(() => {});
    s.c.close();
    await s.h.close('test');
    api.srv.close();
    s.restore();
  }
});
