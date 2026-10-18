// 세션 프로세스(serve.ts) — 실제 Claude 세션 하나(프롬프트는 보내지 않아 API 호출 없음). 메시지 턴은 가짜 codex 로 (API 호출 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileHandler, loadWeb, serveSession, staticHandler } from '../src/serve.ts';
import { connectSession } from '../src/client.ts';
import { sendMail } from '../src/mail.ts';
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

test('세션 프로세스: 슬러그 폴더·소켓, 웹은 그 세션만, meta 에 core pid, 닫으면 저장만 남고 --continue 가 같은 세션을 이어받는다', async () => {
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
  // core 가 자기 pid 를 meta 에 남긴다 (close --force·list)
  const pid = EventLog.open(corePaths(dir).sessionsDir, h.session.id)!.meta.pid!;
  assert.ok(pid > 0 && pidAlive(pid));
  // 같은 세션을 다른 프로세스가 또 열면 거절
  await assert.rejects(serveSession({ dir, cwd: work, resume: h.session.id }), /another slcode/);
  await h.close('test');
  await sleep(200);
  assert.ok(!fs.existsSync(h.sock), '소켓은 지운다');
  assert.deepEqual(EventLog.list(corePaths(dir).sessionsDir, work).map((m) => m.id), [h.session.id], '저장은 남는다');
  // --continue 로 이어받기
  const h2 = await serveSession({ dir, cwd: work, continueLast: true });
  assert.equal(h2.session.id, h.session.id);
  await h2.close('test');
  assert.ok(await waitGone(pid), 'core 는 닫히면 끝난다');
});

test('메시지 → 턴: 켜진 세션에만 보낸다(꺼진 세션·없는 이름은 같은 no session), idle 이면 바로 한 턴, 바쁜 동안 온 것은 다음 idle 에 한 턴으로 묶는다; reply·ask·check 는 턴 밖에서 오간다', { timeout: 30000 }, async (t) => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs')}`;
  t.after(() => { delete process.env.SLCODE_CODEX_BIN; });
  const S = corePaths(dir).sessionsDir;
  const turnsOf = async (c: any, id: string) => ((await c.request('session.attach', { id })).history as any[]).filter((e) => e.ev.kind === 'turn.start');
  /** 가짜 codex 의 턴은 승인 하나를 기다린다 — 허락해 idle 로 */
  const settle = async (c: any, id: string) => { for (const r of (await c.request('session.attach', { id })).pending) await c.request('session.approve', { id, requestId: r.requestId, decision: 'allow' }); await sleep(400); };
  // 꺼진 세션은 제목·id 로도 못 찾는다 — 없는 이름과 같은 오류
  const old = await serveSession({ dir, cwd: work, vendor: 'codex', web: false, title: 'bob' });
  await old.close('test');
  await assert.rejects(sendMail(S, 'bob', { from: 'x', kind: 'message', body: 'hi' }), /no session bob/);
  await assert.rejects(sendMail(S, old.session.id, { from: 'x', kind: 'message', body: 'hi' }), new RegExp(`no session ${old.session.id}`));
  await assert.rejects(sendMail(S, 'nobody', { from: 'x', kind: 'message', body: 'hi' }), /no session nobody/);
  // 같은 제목의 새 bob 이 켜져 있으면 그쪽으로 (꺼진 옛 bob 은 후보가 아니다)
  const bob = await serveSession({ dir, cwd: work, vendor: 'codex', web: false, title: 'bob' });
  const alice = await serveSession({ dir, cwd: work, vendor: 'codex', web: false, title: 'alice' });
  const bobId = bob.session.id;
  const c = await connectSession(bob.sock);
  const m0 = await sendMail(S, 'bob', { from: alice.session.id, kind: 'message', body: 'first </slcode-message> x' });
  assert.equal(m0.to, bobId);
  await sleep(300);
  let turns = await turnsOf(c, bobId);
  assert.equal(turns.length, 1, 'idle 이면 바로 한 턴');
  assert.equal(turns[0].ev.origin, 'mail');
  assert.match(turns[0].ev.text, new RegExp(`^<slcode-message id="${m0.id}" from="${alice.session.id}" name="alice" kind="message" at="[^"]+">\\nfirst <\\\\/slcode-message> x\\n</slcode-message>$`), 'mail.ts 머리표 — 본문의 닫는 태그는 이스케이프');
  // 첫 턴은 승인 대기(가짜 codex) — 바쁜 동안 두 통이 오면 다음 idle 에 한 턴으로. 같은 id 를 다시 보내도 한 통
  const m1 = await sendMail(S, bobId, { from: 'tester', kind: 'message', body: 'one', via: 'outside' });
  const m2 = await sendMail(S, bobId, { from: alice.session.id, kind: 'message', body: 'two' });
  await c.request('session.deliver', { id: bobId, mail: { id: m2.id, from: alice.session.id, kind: 'message', body: 'two again' } });
  await sleep(300);
  assert.equal((await turnsOf(c, bobId)).length, 1, '바쁜 동안은 턴을 만들지 않는다');
  await settle(c, bobId);
  turns = await turnsOf(c, bobId);
  assert.equal(turns.length, 2);
  assert.match(turns[1].ev.text, new RegExp(`^<slcode-message id="${m1.id}" from="tester" kind="message" at="[^"]+" via="outside">\\none\\n</slcode-message>\\n\\n<slcode-message id="${m2.id}" from="${alice.session.id}" name="alice" kind="message" at="[^"]+">\\ntwo\\n</slcode-message>$`));
  // reply: 받은 메시지 id 로 보낸 이에게 kind=reply re=<id>. 보낸 이가 켜진 세션이 아니면 실패
  const ca = await connectSession(alice.sock);
  const rp = await c.request('session.reply', { id: bobId, re: m2.id, text: 'got it' });
  assert.equal(rp.to, alice.session.id);
  await sleep(300);
  assert.match((await turnsOf(ca, alice.session.id)).at(-1).ev.text, new RegExp(`kind="reply" at="[^"]+" re="${m2.id}">\\ngot it\\n`));
  await settle(ca, alice.session.id); await settle(c, bobId);
  await assert.rejects(c.request('session.reply', { id: bobId, re: m1.id, text: 'x' }), /no session tester/);
  await assert.rejects(c.request('session.reply', { id: bobId, re: 'nope', text: 'x' }), /unknown mail/);
  // ask: 켜진 세션이 아니면 거절. 켜져 있으면 kind=ask 를 보내고, 답장(kind=reply re=<그 id>)은 턴이 아니라 ask 의 응답으로 온다
  await assert.rejects(c.request('session.ask', { id: bobId, to: 'nobody', text: 'ready?' }), /no session nobody/);
  const before = (await turnsOf(c, bobId)).length;
  const asking = c.request('session.ask', { id: bobId, to: 'alice', text: 'ready?' });
  await sleep(300);
  const askId = (await turnsOf(ca, alice.session.id)).at(-1).ev.text.match(/^<slcode-message id="([^"]+)" from="[^"]+" name="bob" kind="ask"/)![1];
  await sendMail(S, bobId, { from: alice.session.id, kind: 'reply', re: askId, body: 'yes' });
  const answer = await asking;
  assert.equal(answer.mailId, askId); assert.equal(answer.reply.body, 'yes'); assert.match(answer.text, /kind="reply"/);
  await sleep(300);
  assert.equal((await turnsOf(c, bobId)).length, before, '답장은 턴으로 들어가지 않는다');
  // check: alice 는 ask 턴의 승인을 기다리는 중 — 그 사이 온 것을 지금 꺼내면 턴으로 다시 오지 않는다
  const late = await sendMail(S, alice.session.id, { from: bobId, kind: 'message', body: 'late' });
  await sleep(200);
  const ck = await ca.request('session.check', { id: alice.session.id });
  assert.equal(ck.count, 1); assert.match(ck.text, new RegExp(`^<slcode-message id="${late.id}" from="${bobId}" name="bob"`));
  const n = (await turnsOf(ca, alice.session.id)).length;
  await settle(ca, alice.session.id);
  assert.equal((await turnsOf(ca, alice.session.id)).length, n, '꺼낸 메시지는 턴으로 오지 않는다');
  c.close(); ca.close();
  await alice.close('test'); await bob.close('test');
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
  const evs = EventLog.open(corePaths(dir).sessionsDir, h.session.id)!.all.map((e) => e.ev);
  const kinds = evs.map((e) => e.kind);
  assert.equal(kinds.filter((k) => k === 'error').length, 1);
  assert.equal(kinds.filter((k) => k === 'session.exit').length, 1);
  const states = evs.flatMap((e) => (e.kind === 'session.state' ? [e.state] : []));
  assert.equal(states[0], 'idle', '기동 직후 대기');
  assert.equal(states.filter((s) => s === 'exited').length, 1, 'exited 한 번');
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

test('claude 인증 실패: 로그인 없는 HOME 의 턴은 답변(text.delta) 없이 turn.end ok false·errorKind auth 로 끝난다 — result 는 subtype success 에 is_error (ticket slcode-auth-error-shown-as-answer)', { timeout: 60000 }, async () => {
  const { ClaudeSession } = await import('../src/session.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-auth-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-home-')); // 로그인 정보 없음 — API 를 부르기 전에 벤더가 실패한다
  const log = EventLog.create(dir, { id: 'auth0001', vendor: 'claude', cwd: work, title: null, vendorSessionId: null, createdAt: Date.now(), permissionMode: null, raw: false });
  const s = new ClaudeSession({ log, env: { HOME: home, PATH: process.env.PATH } });
  try {
    const ended = new Promise<any>((r) => s.onEvent((e) => { if (e.ev.kind === 'turn.end') r(e.ev); }));
    s.send('hi');
    const end = await ended;
    assert.equal(end.ok, false); assert.equal(end.interrupted, false);
    assert.match(end.error, /Not logged in/); assert.equal(end.errorKind, 'auth');
    assert.ok(!log.all.some((e) => e.ev.kind === 'text.delta'), '오류 문구는 답변으로 내지 않는다');
  } finally { await s.close('test'); } // 실패해도 벤더 프로세스를 내린다 — 남으면 테스트 러너가 끝나지 않는다
});

test('claude 첫 턴: 기동 직후 idle, 첫 프롬프트에 running, 끝나면 idle — init 이 프롬프트 뒤에 와도 (ticket slcode-first-turn-shows-idle)', { timeout: 60000 }, async () => {
  const { ClaudeSession } = await import('../src/session.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-first-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-home-')); // 로그인 정보 없음 — API 를 부르지 않고 턴이 끝난다
  const log = EventLog.create(dir, { id: 'frst0001', vendor: 'claude', cwd: work, title: null, vendorSessionId: null, createdAt: Date.now(), permissionMode: null, raw: false });
  const s = new ClaudeSession({ log, env: { HOME: home, PATH: process.env.PATH } });
  try {
    assert.equal(s.state, 'idle');
    const ended = new Promise<void>((r) => s.onEvent((e) => { if (e.ev.kind === 'session.state' && e.ev.state === 'idle' && log.all.some((x) => x.ev.kind === 'turn.end')) r(); }));
    s.send('hi');
    await ended;
    const evs = log.all.map((e) => e.ev).filter((e) => e.kind === 'session.state' || e.kind === 'turn.start' || e.kind === 'session.ready' || e.kind === 'turn.end');
    assert.deepEqual(evs.map((e) => (e.kind === 'session.state' ? e.state : e.kind)), ['idle', 'turn.start', 'running', 'session.ready', 'turn.end', 'idle']);
  } finally { await s.close('test'); }
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

test('입력 초안: setDraft 의 글을 다음 attach 가 draft 로 돌려준다 — 다른 연결에서 붙어도 (ticket slcode-card-periodic-reload)', async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, web: false });
  const a = await connectSession(h.sock);
  assert.equal((await a.request('session.attach', { id: h.session.id })).draft, '');
  await a.request('session.setDraft', { id: h.session.id, text: '쓰던 글\n둘째 줄' });
  a.close(); // 카드 iframe 이 다시 로드되면 연결이 바뀐다
  const b = await connectSession(h.sock);
  assert.equal((await b.request('session.attach', { id: h.session.id })).draft, '쓰던 글\n둘째 줄');
  await assert.rejects(b.request('session.setDraft', { id: h.session.id, text: 1 as unknown as string }), /text required/);
  await b.request('session.setDraft', { id: h.session.id, text: '' }); // 보내면 비운다
  assert.equal((await b.request('session.attach', { id: h.session.id })).draft, '');
  b.close();
  await h.close('test');
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

test('웹 정적 파일은 serve 시작 때 고정 — 그 뒤 설치 폴더의 web/ 이 바뀌어도(플러그인 Update) 옛 웹을 보낸다 (ticket slcode-settings-set-unknown-method)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-web-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html lang="ko">old</html>');
  fs.writeFileSync(path.join(root, 'app.js'), 'old');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'index.html'), 'sub');
  const web = loadWeb(root);
  fs.writeFileSync(path.join(root, 'index.html'), '<html lang="ko">new</html>');
  fs.writeFileSync(path.join(root, 'app.js'), 'new');
  fs.writeFileSync(path.join(root, 'settings.js'), 'new');
  const http = await import('node:http');
  const srv = http.createServer((q, r) => staticHandler(q, r, web));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
  const get = async (p: string) => { const r = await fetch(base + p); return [r.status, await r.text()]; };
  assert.deepEqual(await get('/'), [200, '<html lang="ko">old</html>']);
  assert.deepEqual(await get('/app.js?v=1'), [200, 'old']);
  assert.deepEqual(await get('/sub/'), [200, 'sub']);
  assert.equal((await get('/settings.js'))[0], 404, '시작 뒤에 생긴 파일은 없다');
  assert.equal((await get('/%2e%2e/serve.test.ts'))[0], 404);
  srv.close();
});

test('로컬 파일(file?path=): 읽을 수 있는 절대 경로를 형식·sandbox 헤더와 함께, 토큰이 있으면 같은 토큰만, file 이 아니면 정적 파일로 (ticket slcode-append-system-prompt)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-file-'));
  fs.writeFileSync(path.join(root, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(root, 'a.ts'), 'const x = 1;\n');
  fs.writeFileSync(path.join(root, 'b.bin'), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(root, 'index.html'), '<html lang="ko">web</html>');
  const web = loadWeb(root);
  const http = await import('node:http');
  let token: string | null = null;
  const srv = http.createServer((q, r) => { if (!fileHandler(q, r, token)) staticHandler(q, r, web); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as import('node:net').AddressInfo).port}`;
  const get = (p: string, extra = '') => fetch(`${base}/file?path=${encodeURIComponent(p)}${extra}`);
  let r = await get(path.join(root, 'a.png'));
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png'); assert.equal(r.headers.get('content-security-policy'), 'sandbox');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47]);
  r = await get(path.join(root, 'a.ts') + ':12');
  assert.equal(r.status, 200, '줄 번호를 떼고 다시'); assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8'); assert.equal(await r.text(), 'const x = 1;\n');
  assert.equal((await get(path.join(root, 'b.bin'))).headers.get('content-type'), 'application/octet-stream');
  assert.equal((await get(path.join(root, 'none.png'))).status, 404);
  assert.equal((await get(root)).status, 404, '폴더는 아니다');
  assert.equal((await get('a.png')).status, 400, '상대 경로는 아니다');
  assert.equal(await (await fetch(base + '/')).text(), '<html lang="ko">web</html>');
  token = 'tok';
  assert.equal((await get(path.join(root, 'a.png'))).status, 401);
  assert.equal((await get(path.join(root, 'a.png'), '&token=bad')).status, 401);
  assert.equal((await get(path.join(root, 'a.png'), '&token=tok')).status, 200);
  srv.close();
});

test('중계: 큰 프레임의 한글이 청크 경계에서 깨지지 않는다 (웹 → serve → core 소켓, ticket slcode-core-serve-split)', async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work });
  const text = '가'.repeat(100000); // 약 300KB — 소켓 청크 여러 개
  const r = await wsCalls(h.url!, [{ method: 'session.setDraft', params: { id: h.session.id, text } }, { method: 'session.attach', params: { id: h.session.id } }]);
  assert.equal(r[0].result.ok, true);
  assert.equal(r[1].result.draft, text);
  await h.close('test');
});

test('화면 연결은 제어 메서드(core.own·serve.register)를 부를 수 없다; 루프백 밖 웹은 auth 응답 전에 온 요청을 잡아 두었다가 통과하면 보낸다', async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, host: '0.0.0.0' });
  const token = new URL(h.url!).searchParams.get('token')!;
  const u = new URL(h.url!.replace('0.0.0.0', '127.0.0.1')); u.protocol = 'ws:'; u.pathname = '/ws'; u.search = '';
  // auth 응답을 기다리지 않고 한꺼번에 보낸다
  const out = await new Promise<any[]>((resolve, reject) => {
    const ws = new WebSocket(u.toString()); const got: any[] = [];
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'core.auth', params: { token } }));
      ws.send(JSON.stringify({ id: 2, method: 'server.info' }));
      ws.send(JSON.stringify({ id: 3, method: 'serve.register', params: { host: '0.0.0.0', port: 1, version: 'x' } }));
      ws.send(JSON.stringify({ id: 4, method: 'core.own', params: { takeover: true } }));
    };
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id === undefined) return; got.push(m); if (got.length === 4) { ws.close(); resolve(got); } };
    ws.onerror = () => reject(new Error('ws error'));
  });
  const by = Object.fromEntries(out.map((m) => [m.id, m]));
  assert.equal(by[1].result.ok, true);
  assert.equal(by[2].result.session, h.session.id, 'auth 응답 전에 온 요청도 통과 뒤 처리된다');
  assert.match(by[3].error.message, /not allowed on a screen connection/, '토큰이 붙은 url 을 받아 가지 못한다');
  assert.match(by[4].error.message, /not allowed on a screen connection/, '소유권을 빼앗지 못한다');
  const c = await connectSession(h.sock);
  const info = await c.request('server.info');
  assert.equal(info.owner, process.pid, '소유자는 그대로 serve');
  assert.equal(info.serves?.length, 1, '가짜 웹 등록이 없다');
  c.close();
  await h.close('test');
});

test('UDS 클라이언트(RpcClient)도 큰 응답의 한글이 청크 경계에서 깨지지 않는다 — CLI 의 log·last·status 가 긴 기록을 읽는 길', async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, web: false });
  const text = '가'.repeat(100000); // 약 300KB — 소켓 청크 여러 개
  const c = await connectSession(h.sock);
  await c.request('session.setDraft', { id: h.session.id, text });
  assert.equal((await c.request('session.attach', { id: h.session.id })).draft, text);
  c.close();
  await h.close('test');
});

test('MCP 상태: failed 는 사유가 붙고, 다시 연결은 그 서버만 — 다시 실패해도 목록으로 온다 (ticket slcode-mcp-failed-path)', async () => {
  const dir = isolated();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  // 프로젝트 MCP 하나 — 없는 명령이라 반드시 실패한다. settings.local 로 승인 없이 켠다 (settingSources 에 local 이 있다)
  fs.writeFileSync(path.join(work, '.mcp.json'), JSON.stringify({ mcpServers: { broken: { command: path.join(work, 'no-such-node') } } }));
  fs.mkdirSync(path.join(work, '.claude'));
  fs.writeFileSync(path.join(work, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
  const h = await serveSession({ dir, cwd: work, web: false });
  const c = await connectSession(h.sock);
  let list: any[] = [];
  for (let t0 = Date.now(); Date.now() - t0 < 15000; await sleep(200)) { // 연결 시도가 끝날 때까지 (pending → failed)
    list = await c.request('session.mcp', { id: h.session.id });
    if (list.find((m) => m.name === 'broken')?.status === 'failed') break;
  }
  const b = list.find((m) => m.name === 'broken');
  assert.equal(b?.status, 'failed', JSON.stringify(list));
  assert.ok(b.error, '실패 사유');
  const again = await c.request('session.mcpReconnect', { id: h.session.id, name: 'broken' });
  const b2 = again.find((m: any) => m.name === 'broken');
  assert.equal(b2.status, 'failed'); assert.ok(b2.error);
  await assert.rejects(c.request('session.mcpReconnect', { id: h.session.id, name: 'nope' }), (e: any) => e.code === 'bad_request');
  await assert.rejects(c.request('session.mcpReconnect', { id: h.session.id }), /name required/);
  c.close();
  await h.close('test');
});
