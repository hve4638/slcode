// 세션 프로세스(serve.ts) — 실제 Claude 세션 하나(프롬프트는 보내지 않아 API 호출 없음) + 실제 우체국.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveSession } from '../src/serve.ts';
import { connectPost, connectSession } from '../src/client.ts';
import { corePaths, cwdSlug } from '../src/paths.ts';
import { EventLog } from '../src/eventLog.ts';
import { pidAlive } from '../src/lock.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function isolated() { process.env.SLCODE_GRACE_SECS = '1'; return fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-serve-')); }
async function waitGone(pid: number, ms = 8000) { const t0 = Date.now(); while (pidAlive(pid) && Date.now() - t0 < ms) await sleep(50); return !pidAlive(pid); }

/** WS 세션 하나로 요청을 차례로 보내고 응답 배열을 받는다 */
function wsCalls(url: string, calls: { method: string; params?: unknown }[]): Promise<any[]> {
  const u = new URL(url); u.protocol = 'ws:'; u.pathname = '/ws'; u.search = '';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u.toString()); const out: any[] = []; let i = 0;
    const next = () => ws.send(JSON.stringify({ id: i + 1, ...calls[i] }));
    ws.onopen = next;
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id === undefined) return; out.push(m); i++; if (i < calls.length) next(); else { ws.close(); resolve(out); } };
    ws.onerror = () => reject(new Error('ws error'));
  });
}

test('세션 프로세스: 슬러그 폴더·소켓, 웹은 그 세션만, 우체국 등록, 닫으면 저장만 남고 --continue 가 같은 세션을 이어받는다', async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, title: 't1' });
  assert.ok(h.url && !h.url.includes('token='));
  assert.match(h.url!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(h.sock, path.join(corePaths(dir).sessionsDir, cwdSlug(work), h.session.id, 'sock'));
  assert.ok(fs.existsSync(h.sock));
  const r = await wsCalls(h.url!, [
    { method: 'core.auth', params: { token: '' } },
    { method: 'server.info' },
    { method: 'session.attach', params: { id: h.session.id } },
    { method: 'session.send', params: { id: 'other', text: 'x' } }, // 다른 세션 — 거절
    { method: 'session.list' },                                     // 없는 메서드
  ]);
  assert.equal(r[0].result.session, h.session.id);
  assert.equal(r[1].result.cwd, work);
  assert.equal(r[2].result.info.id, h.session.id);
  assert.match(r[3].error.message, /serves session/);
  assert.match(r[4].error.message, /unknown method/);
  // UDS 로도 같은 메서드
  const c = await connectSession(h.sock);
  assert.equal((await c.request('server.info')).session, h.session.id);
  const st = await c.request('session.status', { id: h.session.id });
  assert.equal(st.branch, null, '임시 폴더는 git repo 가 아니다'); assert.equal(st.repo, null);
  assert.ok(st.context === null || (st.context.max > 0 && st.context.tokens >= 0), '컨텍스트 창은 tokens·max·pct');
  assert.ok(st.limits === null || ('fiveHour' in st.limits && 'sevenDay' in st.limits), '플랜이 있으면 두 창, 없으면 null');
  c.close();
  // 우체국에 등록되어 있다
  await sleep(300);
  const post = await connectPost({ dir, autoStart: false });
  const postPid = (await post.client.request('post.info')).pid;
  assert.deepEqual((await post.client.request('post.list')).map((e) => [e.id, e.sock]), [[h.session.id, h.sock]]);
  // 같은 세션을 다른 프로세스가 또 열면 거절
  await assert.rejects(serveSession({ dir, cwd: work, resume: h.session.id }), /another slcode/);
  await h.close('test');
  await sleep(200);
  assert.ok(!fs.existsSync(h.sock), '소켓은 지운다');
  assert.deepEqual((await post.client.request('post.list')), [], '등록이 빠진다');
  assert.deepEqual(EventLog.list(corePaths(dir).sessionsDir, work).map((m) => m.id), [h.session.id], '저장은 남는다');
  // --continue 로 이어받기
  const h2 = await serveSession({ dir, cwd: work, continueLast: true });
  assert.equal(h2.session.id, h.session.id);
  await h2.close('test');
  post.client.close();
  assert.ok(await waitGone(postPid), '등록·연결이 없으면 우체국은 grace 뒤 내려간다');
});

test('우편 → 턴: 우체국에 온 우편이 다음 idle(첫 프롬프트 전 포함)에 한 턴으로 들어가고 ack 된다; reply·ask 는 턴 밖에서 오간다', async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  // 세션이 뜨기 전에 온 우편 — 보관되었다가 등록 직후 들어간다
  const pre = await connectPost({ dir });
  const h = await serveSession({ dir, cwd: work });
  await pre.client.request('mail.send', { from: 'tester', to: h.session.id, body: 'before' });
  await sleep(600);
  const c = await connectSession(h.sock);
  const a = await c.request('session.attach', { id: h.session.id });
  const turns = a.history.filter((e) => e.ev.kind === 'turn.start') as any[];
  assert.equal(turns.length, 1);
  assert.equal(turns[0].ev.origin, 'mail');
  assert.match(turns[0].ev.text, /^\[mail (\S+) from tester at \S+ kind=message\]\n답장: slcode reply \1 <본문>\nbefore$/, 'mail.ts formatMail 꼴 — 머리말 + 답장 안내 + 본문');
  assert.deepEqual(await pre.client.request('mail.fetch', { to: h.session.id }), [], 'ack 되어 비어 있다');
  // reply: 받은 우편 id 로 보낸 이에게 kind=reply re=<id>
  const mailId = turns[0].ev.text.match(/^\[mail (\S+)/)![1];
  const rp = await c.request('session.reply', { id: h.session.id, re: mailId, text: 'got it' });
  assert.equal(rp.to, 'tester');
  const toTester = await pre.client.request('mail.fetch', { to: 'tester' });
  assert.deepEqual(toTester.map((m) => [m.from, m.kind, m.re, m.body]), [[h.session.id, 'reply', mailId, 'got it']]);
  await assert.rejects(c.request('session.reply', { id: h.session.id, re: 'nope', text: 'x' }), /unknown mail/);
  // ask: 상대가 live 가 아니면 거절. live 면 kind=ask 를 보내고, 답장(kind=reply re=<그 id>)은 턴이 아니라 ask 의 응답으로 온다
  await assert.rejects(c.request('session.ask', { id: h.session.id, to: 'nobody', text: 'ready?' }), /not live/);
  const fake = await connectPost({ dir }); // 'nobody' 를 우체국에 live 로 등록 (연결이 살아 있는 동안)
  await fake.client.request('post.register', { id: 'nobody', cwd: work, pid: process.pid, sock: '/nonexistent', version: 'test', title: null });
  const asking = c.request('session.ask', { id: h.session.id, to: 'nobody', text: 'ready?' });
  await sleep(300);
  const [askMail] = await pre.client.request('mail.fetch', { to: 'nobody' });
  assert.equal(askMail.kind, 'ask'); assert.equal(askMail.from, h.session.id);
  await pre.client.request('mail.send', { from: 'nobody', to: h.session.id, kind: 'reply', re: askMail.id, body: 'yes' });
  const answer = await asking;
  assert.equal(answer.mailId, askMail.id); assert.equal(answer.reply.body, 'yes'); assert.match(answer.text, /kind=reply re=/);
  await sleep(300);
  const after = await c.request('session.attach', { id: h.session.id });
  assert.equal(after.history.filter((e) => e.ev.kind === 'turn.start').length, 1, '답장은 턴으로 들어가지 않는다');
  assert.deepEqual(await pre.client.request('mail.fetch', { to: h.session.id }), [], '답장도 ack 된다');
  await assert.rejects(c.request('session.ask', { id: h.session.id, to: 'nobody', text: 'again?', timeoutMs: 200 }), /no reply/);
  fake.client.close();
  c.close(); pre.client.close();
  await h.close('test');
});

test('벤더가 첫 턴 전에 죽으면 오류 한 줄 + 종료 한 줄 (serve 의 close 가 종료를 다시 내지 않는다)', { timeout: 30000 }, async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  // 없는 모드 — CLI 가 인자 검사에서 exit 1 (API 호출 없음). root 의 skip 플래그 거부와 같은 꼴
  const h = await serveSession({ dir, cwd: work, web: false, permissionMode: 'bogus' });
  const c = await connectSession(h.sock);
  await c.request('session.attach', { id: h.session.id });
  await c.request('session.send', { id: h.session.id, text: 'x' });
  await h.done; // 벤더 종료 → serve close
  c.close();
  const kinds = EventLog.open(corePaths(dir).sessionsDir, h.session.id)!.all.map((e) => e.ev.kind);
  assert.equal(kinds.filter((k) => k === 'error').length, 1);
  assert.equal(kinds.filter((k) => k === 'session.exit').length, 1);
  assert.equal(kinds.filter((k) => k === 'session.state').length, 1, 'exited 한 번 (starting 에서 보낸 턴이라 running 은 없다)');
});

test('root: env 에 IS_SANDBOX 가 없어도 bypass 세션이 뜬다 (slcode 가 IS_SANDBOX=1 을 얹는다)', { skip: process.getuid?.() !== 0 && 'root 에서만', timeout: 60000 }, async () => {
  const { ClaudeSession } = await import('../src/session.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-root-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const log = EventLog.create(dir, { id: 'r00t0001', vendor: 'claude', cwd: work, title: null, vendorSessionId: null, createdAt: Date.now(), permissionMode: 'bypassPermissions', raw: false });
  const s = new ClaudeSession({ log, env: { HOME: process.env.HOME, PATH: process.env.PATH }, permissionMode: 'bypassPermissions' });
  // models() 가 벤더 프로세스를 띄운다 (프롬프트 없음 — API 호출 없음). root 거부면 exit 1 로 reject
  const m = await s.models();
  assert.ok(m.models.length > 0);
  assert.ok(!log.all.some((e) => e.ev.kind === 'session.exit'), '벤더가 살아 있다');
  await s.close('test');
});

test('루프백 밖 호스트는 토큰 필수; --no-web 은 소켓만', async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, host: '0.0.0.0' });
  const token = new URL(h.url!).searchParams.get('token')!;
  assert.ok(token.length >= 32);
  const local = h.url!.replace('0.0.0.0', '127.0.0.1');
  const r = await wsCalls(local, [{ method: 'server.info' }, { method: 'core.auth', params: { token: 'nope' } }, { method: 'core.auth', params: { token } }, { method: 'server.info' }]);
  assert.equal(r[0].error.code, 'unauthorized');
  assert.equal(r[1].error.code, 'unauthorized');
  assert.equal(r[2].result.ok, true);
  assert.equal(r[3].result.session, h.session.id);
  await h.close('test');
  const h2 = await serveSession({ dir, cwd: work, web: false });
  assert.equal(h2.url, null);
  const c = await connectSession(h2.sock);
  assert.equal((await c.request('server.info')).port, null);
  c.close();
  await h2.close('test');
});

test('평탄 구조 이주: sessions/<id>/ 가 sessions/<슬러그>/<id>/ 로 옮겨지고 list 가 본다', async () => {
  const dir = isolated();
  const p = corePaths(dir);
  fs.mkdirSync(path.join(p.sessionsDir, 'old1'), { recursive: true });
  fs.writeFileSync(path.join(p.sessionsDir, 'old1', 'meta.json'), JSON.stringify({ id: 'old1', vendor: 'claude', cwd: '/tmp/x_y.z', title: 't', vendorSessionId: 'v', createdAt: 1, permissionMode: null, raw: false }));
  assert.equal(EventLog.migrate(p.sessionsDir), 1);
  assert.ok(fs.existsSync(path.join(p.sessionsDir, '-tmp-x-y-z', 'old1', 'meta.json')));
  assert.equal(EventLog.migrate(p.sessionsDir), 0);
  assert.deepEqual(EventLog.list(p.sessionsDir).map((m) => m.id), ['old1']);
  assert.deepEqual(EventLog.list(p.sessionsDir, '/tmp/x_y.z').map((m) => m.id), ['old1']);
  assert.deepEqual(EventLog.list(p.sessionsDir, '/tmp/other'), []);
  assert.equal(EventLog.open(p.sessionsDir, 'old1')?.dir, path.join(p.sessionsDir, '-tmp-x-y-z', 'old1'));
  EventLog.remove(p.sessionsDir, 'old1');
  assert.equal(EventLog.find(p.sessionsDir, 'old1'), null);
});

test('superlite 서비스 웹 소켓(webSock): 인증 없이 정적 파일·WS, TCP 웹 없이도 (ticket plugin-service-web)', async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const webSock = path.join(dir, 'w.sock');
  const h = await serveSession({ dir, cwd: work, web: false, host: '0.0.0.0', webSock });
  assert.equal(h.url, null);
  assert.equal(fs.statSync(webSock).mode & 0o777, 0o600);
  const http = await import('node:http');
  const html = await new Promise<string>((resolve, reject) => {
    http.get({ socketPath: webSock, path: '/' }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b)); }).on('error', reject);
  });
  assert.match(html, /new URL\('ws', location\.href\)/, '페이지는 상대 ws 주소 — /svc/<토큰>/ 접두사 아래에서도');
  const { WebSocket: WS } = await import('ws');
  const r = await new Promise<any>((resolve, reject) => {
    const ws = new WS(`ws+unix://${webSock}:/ws`);
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'server.info' })));
    ws.on('message', (d) => { ws.close(); resolve(JSON.parse(String(d))); });
    ws.on('error', reject);
  });
  assert.equal(r.result.session, h.session.id, '토큰 없이 (core.auth 생략) 바로 요청');
  await h.close('test');
});
