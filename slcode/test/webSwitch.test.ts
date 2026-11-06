// 웹의 세션 전환을 실제 브라우저로 (ticket slcode-web-session-url) — 한 문서에 세션 화면을 여러 개 두므로, 숨은 화면이 키 입력·포커스에 끼어들지 않는지는 DOM 이 있어야 본다.
// 실제 Claude 세션(프롬프트 없음, API 호출 없음)과 headless Chrome 을 쓴다. Chrome 이 없으면 건너뛴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveSession } from '../src/serve.ts';
import { connectSession } from '../src/client.ts';
import { spawnCore } from '../src/live.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chrome = ['google-chrome', 'chromium', 'chromium-browser'].find((c) => { try { execFileSync('which', [c], { stdio: 'ignore' }); return true; } catch { return false; } });

/** headless Chrome 과 CDP 탭 하나. 뜨지 못하면 프로세스·프로필을 치우고 던진다 — 이 테스트는 그 경우 건너뛴다 */
async function openChrome(bin: string) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-chrome-'));
  const proc = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
  let ws: WebSocket | undefined;
  // 이미 끝난 프로세스엔 exit 가 다시 오지 않는다 — 기다리면 테스트 파일이 끝나지 않는다
  const close = async () => {
    ws?.close();
    if (proc.exitCode === null && proc.signalCode === null) { const out = new Promise((r) => proc.once('exit', r)); proc.kill(); await out; }
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
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
    // 응답이 끊겨도 finally 의 정리까지 가도록 호출마다 시한을 둔다
    const send = (method: string, params: unknown = {}) => new Promise<any>((r, j) => {
      const id = ++n;
      const timer = setTimeout(() => { wait.delete(id); j(new Error(`cdp ${method} timed out`)); }, 15000);
      wait.set(id, (m) => { clearTimeout(timer); r(m); });
      sock.send(JSON.stringify({ id, method, params }));
    });
    const ev = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result?.value;
    const until = async (expression: string, what: string) => { const t = Date.now(); while (Date.now() - t < 15000) { if (await ev(expression)) return; await sleep(30); } assert.fail(`timed out: ${what}`); };
    await send('Page.enable'); await send('Runtime.enable');
    return { send, ev, until, close };
  } catch (e) {
    await close();
    throw e;
  }
}

test('웹 세션 전환: 페이지를 새로 읽지 않고 바뀌고, 숨은 화면은 키 입력·포커스·활동 신호에 끼어들지 않는다', { skip: !chrome && 'chrome 없음' }, async (t) => {
  // 세션보다 먼저 띄운다 — 못 뜨면 열어 둔 core·연결 없이 건너뛴다 (CI 에서 열린 연결이 남아 파일이 끝나지 않았다)
  const b = await openChrome(chrome!).catch((e: Error) => e);
  if (b instanceof Error) { t.skip(b.message); return; }
  process.env.SLCODE_GRACE_SECS = '30';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-switch-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, title: 'main' });
  const kid = await spawnCore({ dir, cwd: work, title: 'kid', parent: { id: h.session.id, kind: 'child' } });
  const owner = await connectSession(kid.sock);
  await owner.request('core.own', { pid: process.pid, follows: true });
  try {
    // 화면이 보낸 프레임을 연결 주소와 함께 남긴다 — 숨은 화면의 활동 신호를 보려고
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__sent = []; { const s = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { window.__sent.push([this.url, String(d)]); return s.call(this, d); }; }` });
    await b.send('Page.navigate', { url: h.url });
    const visible = `document.querySelector('.session-slot:not([inert])')`;
    const titleIs = (t: string) => `${visible}?.querySelector('.hdr .title')?.textContent === ${JSON.stringify(t)} && ${visible}?.querySelector('.pill')?.textContent === '대기'`;
    await b.until(titleIs('main'), 'main 화면');
    await b.until(`location.pathname === '/s/${h.session.id}'`, '/ 가 메인 주소로');
    await b.ev(`window.__sameDocument = true`);
    // 메뉴를 열면 켜진 자손을 미리 불러 둔다
    await b.until(`!${visible}.querySelector('.fam-chip').hidden`, '메뉴 표시');
    await b.ev(`${visible}.querySelector('.fam-chip').click()`);
    await b.until(`document.querySelectorAll('.session-slot').length === 2`, '미리 불러오기');
    await b.until(`[...document.querySelectorAll('.session-slot[inert] .hdr .title')].some((t) => t.textContent === 'kid')`, '자손 화면 준비');
    // 같은 탭 이동 — 같은 문서, 주소가 바뀌고, 입력창에 포커스
    await b.ev(`[...${visible}.querySelectorAll('.fam-row')].find((a) => a.textContent.includes('kid')).click()`);
    await b.until(titleIs('kid'), '자손 화면');
    assert.equal(await b.ev(`location.pathname`), `/s/${kid.id}`);
    assert.equal(await b.ev(`window.__sameDocument`), true, '페이지를 새로 읽지 않는다');
    assert.equal(await b.ev(`document.title`), 'kid');
    assert.equal(await b.ev(`document.activeElement === ${visible}.querySelector('textarea')`), true, '보이는 화면의 입력창으로');
    // 뒤로 가기
    await b.ev(`history.back()`);
    await b.until(titleIs('main'), '뒤로 가기');
    assert.equal(await b.ev(`window.__sameDocument`), true);
    assert.equal(await b.ev(`location.pathname`), `/s/${h.session.id}`);
    // 입력창 밖에서 친 글자는 보이는 화면의 입력창으로만, 활동 신호도 보이는 세션만
    await b.ev(`document.activeElement.blur(); window.__sent.length = 0`);
    for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'x', code: 'KeyX', text: type === 'keyDown' ? 'x' : undefined, windowsVirtualKeyCode: 88 });
    await b.until(`${visible}.querySelector('textarea').value === 'x'`, '보이는 입력창에 글자');
    assert.equal(await b.ev(`document.querySelector('.session-slot[inert] textarea').value`), '', '숨은 입력창은 그대로');
    const sent = await b.ev(`window.__sent.filter(([u, d]) => d.includes('session.signal')).map(([u]) => u)`) as string[];
    assert.ok(!sent.some((u) => u.includes(kid.id)), `숨은 세션의 활동 신호가 나갔다: ${sent}`);
    // 메뉴 버튼은 자기 화면의 메뉴를 연다 — 고정 id 로 이으면 먼저 만든 화면의 메뉴가 열린다
    await b.ev(`${visible}.querySelector('.pill-btn.mode').click()`);
    assert.equal(await b.ev(`${visible}.querySelector('.menu.acf-mode').matches(':popover-open')`), true, '보이는 화면의 메뉴');
    assert.equal(await b.ev(`document.querySelector('.session-slot[inert] .menu.acf-mode').matches(':popover-open')`), false);
  } finally {
    await b.close();
    const gone = owner.done;
    owner.request('session.close', { id: kid.id }).catch(() => {});
    await gone;
    await h.close('test');
  }
});
