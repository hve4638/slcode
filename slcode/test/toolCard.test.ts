// 도구 줄 (ticket slcode-tool-card-polish) — 화면 이름(slcode MCP 앞머리 없이, 다른 MCP 는 '서버 · 도구'), 도구 아이콘(실패면 빨강), 아는 도구의 정돈된 펼친 모양과 JSON 원문 단추.
// 웹 시험은 실제 claude CLI 를 가짜 Messages API 로 돌린다 (가짜 키, API 비용 없음). headless Chrome 이 있을 때만 본다. 도우미는 slashHighlight.test.ts 와 같은 꼴.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { failLabel, lineDiff, toolIcon, toolLabel, toolName, toolView } from '../web/tools.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const chrome = ['google-chrome', 'chromium', 'chromium-browser'].find((c) => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true; } catch { return false; } });

test('도구 이름 — slcode MCP 는 앞머리 없이, 다른 MCP 는 서버와 도구, Codex 꼴도 같게', () => {
  assert.deepEqual(toolName('mcp__slcode__BackgroundRun'), { name: 'BackgroundRun', server: null });
  assert.deepEqual(toolName('mcp__github__search_issues'), { name: 'search_issues', server: 'github' });
  assert.deepEqual(toolName('mcp:github/search_issues'), { name: 'search_issues', server: 'github' });
  assert.deepEqual(toolName('Bash'), { name: 'Bash', server: null });
  assert.equal(toolLabel('mcp__github__search_issues'), 'github · search_issues');
  assert.equal(toolLabel('mcp__slcode__Subagent'), 'Subagent');
  assert.equal(toolIcon('Bash'), 'term');
  assert.equal(toolIcon('mcp__slcode__BackgroundRun'), 'term');
  assert.equal(toolIcon('mcp__github__search_issues'), 'plug');
  assert.equal(toolIcon('mcp__github__Bash'), 'plug', '다른 서버의 같은 이름은 그 도구가 아니다');
  assert.equal(toolIcon('ExitPlanMode'), 'wrench');
  // 비슷한 도구는 한 모양 (사용자 2026-11-25)
  assert.deepEqual(['Bash', 'mcp__slcode__BackgroundStop'].map(toolIcon), ['term', 'term']);
  assert.deepEqual(['Edit', 'Write', 'MultiEdit'].map(toolIcon), ['pen', 'pen', 'pen']);
  assert.deepEqual(['Grep', 'Glob', 'WebSearch'].map(toolIcon), ['search', 'search', 'search']);
  assert.equal(failLabel('Exit code 3\nboom'), 'exit 3');
  assert.equal(failLabel('<tool_use_error>nope</tool_use_error>'), '실패');
});

test('줄 diff — 같은 줄은 그대로, 지운 줄이 더한 줄보다 먼저', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc\nd'), [[' ', 'a'], ['-', 'b'], ['+', 'B'], [' ', 'c'], ['+', 'd']]);
  assert.deepEqual(lineDiff('', 'x'), [['-', ''], ['+', 'x']]);
});

test('펼친 모양 — 아는 도구만, 입력이 예상과 다르거나 다른 MCP 면 null(JSON 원문)', () => {
  const h = (tag: string, _a: object, ...c: unknown[]) => ({ tag, c });
  assert.ok(toolView(h, 'Bash', { command: 'ls' }));
  assert.equal(toolView(h, 'Bash', { cmd: 'ls' }), null);
  assert.equal(toolView(h, 'mcp__github__search_issues', { query: 'x' }), null);
  assert.equal(toolView(h, 'ExitPlanMode', { plan: 'x' }), null);
  assert.equal(toolView(h, 'Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })?.quiet, true, 'Edit 은 성공 결과를 숨긴다');
  assert.ok(toolView(h, 'Edit', { changes: [{ path: '/a', kind: 'add' }] }), 'Codex 파일 변경');
  assert.ok(toolView(h, 'mcp__slcode__BackgroundRun', { command: 'sleep 9', description: 'x' }));
});

/** 대화 첫 글에 @@SEQ 가 있으면 SEQ 의 도구를 차례로 부르고(앞선 tool_use 수가 다음 차례), 다 부르면 "done". 그 밖은 "hi" */
async function fakeApi(seq: { name: string; input: unknown }[]) {
  let n = 0;
  const head = () => ['message_start', { type: 'message_start', message: { id: `msg_${++n}`, type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }];
  const text = (t: string) => [head(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]];
  const call = (c: { name: string; input: unknown }) => [head(),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${n}`, name: c.name, input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }]];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":5}'); return; }
      let body: any = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* 빈 몸 */ }
      const msgs: any[] = body.messages ?? [];
      const all = JSON.stringify(msgs);
      const used = msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.content)).flatMap((m) => m.content).filter((b: any) => b.type === 'tool_use').length;
      const events = Array.isArray(body.tools) && body.tools.length && all.includes('@@SEQ') ? (used < seq.length ? call(seq[used]) : text('done')) : text('hi');
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

/** headless Chrome 과 CDP 탭 하나 (slashHighlight.test.ts 와 같은 꼴) */
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
    const until = async (expression: string, what: string) => { const t = Date.now(); while (Date.now() - t < 30000) { if (await ev(expression)) return; await sleep(30); } assert.fail(`timed out: ${what}`); };
    await send('Page.enable'); await send('Runtime.enable');
    return { send, ev, until, close };
  } catch (e) {
    await close();
    throw e;
  }
}

test('웹: 도구 줄은 도구 아이콘·화면 이름을 보이고, 펼치면 아는 도구는 정돈된 모양, 단추로 JSON 원문', { skip: !chrome && 'chrome 없음', timeout: 180000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const cwd = tmp('slcode-toolcard-work-');
  const file = path.join(cwd, 'a.txt');
  fs.writeFileSync(file, 'one\ntwo\nthree\n');
  const api = await fakeApi([
    { name: 'Bash', input: { command: 'echo hello-tool', description: 'Say hello' } },
    { name: 'Bash', input: { command: 'echo boom >&2; exit 3' } },
    { name: 'Read', input: { file_path: file, offset: 2, limit: 2 } },
    { name: 'Edit', input: { file_path: file, old_string: 'two', new_string: 'TWO' } },
    { name: 'mcp__slcode__BackgroundStop', input: { id: 'nope' } },
    { name: 'mcp__fakesrv__thing', input: { q: 1 } },
  ]);
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: tmp('slcode-toolcard-home-'), ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await serveSession({ dir: tmp('slcode-toolcard-'), cwd, web: true, permissionMode: 'bypassPermissions' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  let ended = false;
  await c.request('session.attach', { id });
  c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') ended = true; });
  // 줄마다 [화면 이름, 서버 꼬리, 아이콘 있음, 점 있음, 오른쪽 끝 실패 글자]
  const rows = `[...document.querySelectorAll('.feed details.tool')].map((d) => [d.querySelector('.name').lastChild.textContent, d.querySelector('.name .srv')?.textContent ?? null, !!d.querySelector('summary .ic svg'), !!d.querySelector('.dot'), d.querySelector('summary > .fail')?.textContent ?? null])`;
  const card = (i: number) => `document.querySelectorAll('.feed details.tool')[${i}]`;
  const shown = (sel: string) => `(() => { const e = ${sel}; return !!e && e.getClientRects().length > 0; })()`;
  try {
    await b.send('Page.navigate', { url: h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');
    await c.request('session.send', { id, text: '@@SEQ 도구들' });
    const t0 = Date.now();
    while (!ended) { if (Date.now() - t0 > 60000) assert.fail('turn did not end'); await sleep(30); }
    await b.until(`document.querySelectorAll('.feed details.tool:not(.running)').length === 6`, '도구 줄 여섯');
    assert.deepEqual(await b.ev(rows), [
      ['Bash', null, true, false, null], ['Bash', null, true, false, 'exit 3'], ['Read', null, true, false, null], ['Edit', null, true, false, null],
      ['BackgroundStop', null, true, false, '실패'], ['thing', 'fakesrv · ', true, false, '실패'],
    ]);
    await b.ev(`document.querySelectorAll('.feed details.tool').forEach((d) => { d.open = true; })`);
    // 실패해도 아이콘 색은 그대로, 줄 끝 글자만 빨강
    const color = (sel: string) => `getComputedStyle(${sel}).color`;
    assert.equal(await b.ev(color(`${card(1)}.querySelector('summary .ic')`)), await b.ev(color(`${card(0)}.querySelector('summary .ic')`)));
    assert.notEqual(await b.ev(color(`${card(1)}.querySelector('summary .fail')`)), await b.ev(color(`${card(1)}.querySelector('summary .arg')`)));
    // Bash: 설명·명령·출력, JSON 은 숨김
    assert.equal(await b.ev(`${card(0)}.querySelector('.tv .tv-note').textContent`), 'Say hello');
    assert.equal(await b.ev(`${card(0)}.querySelector('.tv pre.tv-cmd').textContent`), 'echo hello-tool');
    assert.match(await b.ev(`${card(0)}.querySelector('.res pre').textContent`), /hello-tool/);
    assert.equal(await b.ev(shown(`${card(0)}.querySelector('.raw')`)), false);
    assert.equal(await b.ev(shown(`${card(0)}.querySelector('.res .lbl')`)), false, '성공 결과엔 라벨이 없다');
    assert.equal(await b.ev(shown(`${card(1)}.querySelector('.res .lbl')`)), true, '실패엔 오류 라벨');
    // Read: 경로와 줄 범위
    assert.equal(await b.ev(`${card(2)}.querySelector('.tv-path .x').textContent`), '2–3줄');
    // Edit: diff, 성공 결과는 숨김
    assert.deepEqual(await b.ev(`[...${card(3)}.querySelectorAll('.tv-diff span')].map((s) => s.className + ' ' + s.textContent.trim())`), ['del - two', 'add + TWO']);
    assert.equal(await b.ev(shown(`${card(3)}.querySelector('.res')`)), false);
    // JSON 원문 단추 — 누르면 지금의 입력·결과 모양, 다시 누르면 돌아온다
    await b.ev(`${card(3)}.querySelector('.rawtg').click()`);
    assert.equal(await b.ev(shown(`${card(3)}.querySelector('.raw')`)), true);
    assert.equal(await b.ev(shown(`${card(3)}.querySelector('.tv')`)), false);
    assert.equal(await b.ev(shown(`${card(3)}.querySelector('.res .lbl')`)), true);
    assert.equal(JSON.parse(await b.ev(`${card(3)}.querySelector('.raw pre').textContent`)).new_string, 'TWO');
    await b.ev(`${card(3)}.querySelector('.rawtg').click()`);
    assert.equal(await b.ev(shown(`${card(3)}.querySelector('.tv')`)), true);
    // 다른 MCP 도구는 JSON 그대로, 단추 없음
    assert.equal(await b.ev(`!${card(5)}.querySelector('.rawtg') && ${shown(`${card(5)}.querySelector('.raw')`)}`), true);
  } finally {
    await b.close().catch(() => {});
    c.close();
    await h.close('test');
    api.srv.close();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('웹: Codex 명령·파일 변경·MCP 줄도 같은 아이콘·이름·펼친 모양 (가짜 codex)', { skip: !chrome && 'chrome 없음', timeout: 120000 }, async (t) => {
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  const saved = { ...process.env };
  Object.assign(process.env, { SLCODE_CODEX_BIN: `${process.execPath} ${path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs')}`, SLCODE_GRACE_SECS: '1' });
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const cwd = tmp('slcode-toolcard-cx-work-');
  const h = await serveSession({ dir: tmp('slcode-toolcard-cx-'), cwd, web: true, vendor: 'codex', permissionMode: 'default' } as any);
  const c = await connectSession(h.sock);
  const id = h.session.id;
  const card = (i: number) => `document.querySelectorAll('.feed details.tool')[${i}]`;
  try {
    await c.request('session.attach', { id });
    await b.send('Page.navigate', { url: h.url });
    await b.until(`document.querySelector('.pill')?.textContent === '대기'`, '화면');
    await c.request('session.send', { id, text: 'tools' });
    await b.until(`document.querySelectorAll('.feed details.tool:not(.running)').length === 4`, '도구 줄 넷');
    assert.deepEqual(await b.ev(`[...document.querySelectorAll('.feed details.tool')].map((d) => [d.querySelector('.name').textContent, d.querySelector('summary > .fail')?.textContent ?? null, !!d.querySelector('summary .ic svg')])`),
      [['Bash', null, true], ['Bash', '실패', true], ['Edit', null, true], ['srv · look', null, true]]);
    await b.ev(`document.querySelectorAll('.feed details.tool').forEach((d) => { d.open = true; })`);
    assert.equal(await b.ev(`${card(0)}.querySelector('.tv pre.tv-cmd').textContent`), 'echo hi');
    assert.deepEqual(await b.ev(`[...${card(2)}.querySelectorAll('.tv-files .tv-kind')].map((k) => k.textContent)`), ['add', 'update']);
    await b.ev(`${card(2)}.querySelector('.rawtg').click()`);
    assert.match(await b.ev(`${card(2)}.querySelector('.res pre').textContent`), /^add .*a\.txt\nupdate .*b\.txt$/, '결과 글에 kind 가 글자로');
  } finally {
    await b.close().catch(() => {});
    c.close();
    await h.close('test');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
