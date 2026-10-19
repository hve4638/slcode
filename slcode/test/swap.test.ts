// serve 교체 (ticket slcode-core-serve-split 2단계) — 실제 cli.ts 를 자식 프로세스로 띄우고 벤더는 가짜 codex 를 쓴다.
// 가짜 codex 의 턴은 명령 승인 요청에서 멈춘다 — 그동안 serve 를 바꿔도 턴이 이어지는지 본다. dist/ 가 빌드돼 있어야 한다 (core·serve 자식은 dist 에서 뜬다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectSession, PKG, replacingMark } from '../src/client.ts';
import { sockAlive } from '../src/live.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ENV = (dir: string) => ({ ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_OWNER_GRACE_SECS: '1', SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, SLCODE_SESSION: undefined, SUPERLITE_SOCK: undefined });

/** 이 패키지의 사본 (dist 복사, web·node_modules 는 링크) — dist/cli.js 의 mtime 을 올려 '새 빌드' 를 만들어도 병렬로 도는 다른 테스트 파일의 serve·core 에 닿지 않게.
 *  새 빌드를 본 serve 는 core 교체를 청한다 (3단계) */
function pkgCopy(): string {
  const d = tmp('slcode-pkg-');
  fs.cpSync(path.join(PKG, 'dist'), path.join(d, 'dist'), { recursive: true, preserveTimestamps: true });
  fs.copyFileSync(path.join(PKG, 'package.json'), path.join(d, 'package.json'));
  for (const n of ['web', 'node_modules']) fs.symlinkSync(path.join(PKG, n), path.join(d, n));
  return d;
}
/** 사본의 dist/cli.js mtime 을 올린다 — 이 뒤에 뜬 serve·core 의 BUILD 가 그 전 것보다 크다. 되돌리는 함수를 준다 */
function bumpBuild(pkg: string): () => void {
  const cliJs = path.join(pkg, 'dist', 'cli.js'), st = fs.statSync(cliJs);
  fs.utimesSync(cliJs, st.atime, new Date(st.mtimeMs + 2000));
  return () => fs.utimesSync(cliJs, st.atime, st.mtime);
}

/** cli 하나 — stdout 첫 줄을 기다린다. pkg 면 그 사본의 dist/cli.js 로 */
function cli(dir: string, args: string[], stdin: 'ignore' | 'pipe' = 'ignore', pkg?: string): { child: ChildProcess; first: Promise<string>; exit: Promise<number | null>; stderr: () => string } {
  const child = spawn(process.execPath, pkg ? [path.join(pkg, 'dist', 'cli.js'), ...args] : ['--import', TSX, CLI, ...args], { env: ENV(dir), stdio: [stdin, 'pipe', 'pipe'] });
  child.stdout!.setEncoding('utf8');
  let err = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => (err += d));
  const first = new Promise<string>((resolve) => { let buf = ''; child.stdout!.on('data', (d: string) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i)); }); });
  const exit = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  return { child, first, exit, stderr: () => err };
}
const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

/** 웹 화면 연결 하나 — 요청·이벤트·닫힘 */
async function screen(url: string) {
  const u = new URL(url); u.protocol = 'ws:'; u.pathname = '/ws'; u.search = '';
  const ws = new WebSocket(u.toString());
  let n = 0;
  const pend = new Map<number, (m: any) => void>(), events: any[] = [];
  const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id); } else events.push(m); };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const call = (method: string, params?: unknown) => new Promise<any>((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await call('core.auth', {});
  const until = async (pred: (m: any) => boolean, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = events.find(pred); if (m) return m; await sleep(30); } throw new Error('event timeout'); };
  return { call, events, closed, until, close: () => ws.close() };
}

test('웹: 턴이 승인 대기 중일 때 serve 를 바꿔도 같은 포트로 다시 붙어 턴이 이어진다; update.run 은 dist/cli.js 가 바뀌면 restart-required', async (t) => {
  const dir = tmp('slcode-swap-'), pkg = pkgCopy();
  const e = cli(dir, ['new', tmp('slcode-work-'), '--vendor', 'codex'], 'ignore', pkg);
  t.after(() => { if (alive(e.child)) e.child.kill('SIGKILL'); });
  const url = await e.first;
  const a = await screen(url);
  const si = (await a.call('serve.info')).result;
  assert.notEqual(si.pid, e.child.pid, 'serve 는 진입 프로세스의 자식');
  const id = (await a.call('server.info')).result.session;
  const lastSeq = (await a.call('session.attach', { id, since: 0 })).result.history.at(-1)?.seq ?? 0;
  await a.call('session.send', { id, text: 'hello' });
  const req = (await a.until((m) => m.params?.ev?.kind === 'approval.requested')).params.ev.requestId;

  assert.deepEqual((await a.call('update.run')).result, { status: 'latest' });
  const restore = bumpBuild(pkg);
  try {
    const u = (await a.call('update.run')).result;
    assert.equal(u.status, 'restart-required');
    assert.equal((await a.call('serve.info')).result.update.status, 'restart-required', '다시 연 화면도 안다');
  } finally { restore(); }

  assert.deepEqual((await a.call('serve.restart')).result, { ok: true });
  assert.equal(await a.closed, 1012, '옛 serve 가 화면 연결을 끊는다');
  const b = await screen(url);
  const si2 = (await b.call('serve.info')).result;
  assert.notEqual(si2.pid, si.pid, '새 serve');
  assert.equal(si2.update, null);
  const att = (await b.call('session.attach', { id, since: lastSeq })).result;
  assert.deepEqual(att.pending.map((p: any) => p.requestId), [req], '대기 중인 승인이 그대로');
  assert.ok(att.history.some((x: any) => x.ev.kind === 'turn.start'), '끊긴 동안의 기록');
  await b.call('session.approve', { id, requestId: req, decision: 'allow' });
  assert.ok((await b.until((m) => m.params?.ev?.kind === 'turn.end')).params.ev.ok, '턴이 끝까지 간다');
  b.close();
  const gone = async (pid: number) => { for (let i = 0; i < 30; i++) { if (!fs.existsSync(`/proc/${pid}`)) return true; await sleep(100); } return fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); };
  assert.equal(await gone(si.pid), true, '옛 serve 는 끝났다');
  e.child.kill('SIGINT');
  assert.equal(await e.exit, 0);
  assert.ok(EventLog.open(corePaths(dir).sessionsDir, id)!.meta.closedAt, 'Ctrl-C 는 세션을 닫는다');
  await sleep(1500); // 우체국 grace
});

test('웹: 교체 중이 아닐 때 serve 가 죽으면 한 번 다시 띄우고, 다시 띄운 것도 곧 죽으면 세션을 닫는다', async (t) => {
  const dir = tmp('slcode-swap-');
  const e = cli(dir, ['new', tmp('slcode-work-'), '--vendor', 'codex']);
  t.after(() => { if (alive(e.child)) e.child.kill('SIGKILL'); });
  const url = await e.first;
  const pidOf = async () => { for (let i = 0; i < 50; i++) { try { const s = await screen(url); const r = await s.call('serve.info'); s.close(); return r.result.pid as number; } catch { await sleep(100); } } throw new Error('no serve'); };
  const p1 = await pidOf();
  const [m] = EventLog.list(corePaths(dir).sessionsDir);
  const c = await connectSession(EventLog.open(corePaths(dir).sessionsDir, m.id)!.sockPath);
  process.kill(p1, 'SIGKILL');
  await sleep(300);
  const p2 = await pidOf();
  assert.notEqual(p2, p1, '새 serve');
  assert.ok(alive(e.child), '세션은 산다');
  process.kill(p2, 'SIGKILL');
  assert.equal(await e.exit, 0, '두 번째면 진입 프로세스가 세션을 닫고 끝난다');
  await c.done;
  await sleep(1500); // 우체국 grace
});

test('카드: resume --stdio --takeover 는 떠 있는 세션의 소유권을 빼앗는다 — 옛 serve 가 SIGTERM 으로 끝나도 세션은 산다; 새 serve 가 SIGTERM 이면 owner gone 유예 없이 바로 닫는다', async (t) => {
  const dir = tmp('slcode-swap-');
  const a = cli(dir, ['new', tmp('slcode-work-'), '--vendor', 'codex', '--stdio', '--no-web'], 'pipe');
  t.after(() => { for (const x of [a, b]) if (x && alive(x.child)) x.child.kill('SIGKILL'); });
  const hello = JSON.parse(await a.first);
  let b: ReturnType<typeof cli> | null = null;
  b = cli(dir, ['resume', hello.id, '--stdio', '--no-web', '--takeover'], 'pipe');
  assert.equal(JSON.parse(await b.first).id, hello.id);
  const c = await connectSession(hello.sock);
  assert.equal((await c.request('server.info')).owner, b.child.pid, '새 serve 가 소유자');
  a.child.kill('SIGTERM');
  await a.exit;
  await sleep(300);
  assert.ok(await sockAlive(hello.sock), '빼앗긴 serve 가 끝나도 세션은 산다');
  b.child.kill('SIGTERM');
  await b.exit;
  await c.done;
  assert.ok(!(await sockAlive(hello.sock)), '소유자가 끝나면 세션도 닫힌다');
  const closing = fs.readFileSync(corePaths(dir).coreLog, 'utf8').split('\n').filter((l) => l.includes(`${hello.id}] closing: `)).map((l) => l.replace(/.*closing: /, ''));
  assert.equal(closing[0], 'closed by client', 'core 는 owner gone 유예를 기다리지 않고 session.close 로 닫힌다');
  assert.match(b.stderr(), /closing: signal/, '새 serve 는 시그널로 닫는다');
  await sleep(1500); // 우체국 grace
});

// ---- core 교체 (3단계) — 새 코드의 serve 가 core.retire 를 청하고, core 는 idle 에서 새 core 로 바뀐다. 화면 연결은 끊기지 않는다
const corePid = async (s: Awaited<ReturnType<typeof screen>>) => (await s.call('core.auth', {})).result.pid as number;
async function waitFor<T>(f: () => Promise<T | null | false>, ms = 15000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(100); }
}

test('웹: 새 serve 가 core 교체를 청하면 진행 중인 턴이 끝난 뒤 새 core 로 바뀐다 — 화면 연결은 그대로, seq 가 이어지고 초안이 넘어간다', async (t) => {
  const dir = tmp('slcode-swap-'), pkg = pkgCopy();
  const e = cli(dir, ['new', tmp('slcode-work-'), '--vendor', 'codex'], 'ignore', pkg);
  let restore = () => {};
  t.after(() => { restore(); if (alive(e.child)) e.child.kill('SIGKILL'); });
  const url = await e.first;
  const a = await screen(url);
  const id = (await a.call('server.info')).result.session;
  await a.call('session.attach', { id, since: 0 });
  await a.call('session.setDraft', { id, text: '쓰던 글' });
  await a.call('session.send', { id, text: 'hello' });
  const req = (await a.until((m) => m.params?.ev?.kind === 'approval.requested')).params.ev.requestId;
  const oldCore = await corePid(a);

  restore = bumpBuild(pkg);
  assert.deepEqual((await a.call('serve.restart')).result, { ok: true });
  await a.closed;
  const b = await screen(url);
  const att = (await b.call('session.attach', { id, since: 0 })).result;
  assert.deepEqual(att.pending.map((p: any) => p.requestId), [req]);
  await sleep(500);
  assert.equal(await corePid(b), oldCore, '승인 대기 중에는 바꾸지 않는다');

  let closed = false;
  void b.closed.then(() => (closed = true));
  await b.call('session.approve', { id, requestId: req, decision: 'allow' });
  await b.until((m) => m.params?.ev?.kind === 'turn.end');
  const newCore = await waitFor(async () => { const p = await corePid(b); return p !== oldCore && p; });
  restore(); restore = () => {};
  assert.equal(closed, false, '화면 연결은 끊기지 않는다');
  assert.ok(!fs.existsSync(`/proc/${oldCore}`) || fs.readFileSync(`/proc/${oldCore}/stat`, 'utf8').split(' ')[2] === 'Z', '옛 core 는 끝났다');
  const si = (await b.call('server.info')).result;
  assert.equal(si.owner, e.child.pid, '진입 프로세스가 새 core 의 소유자로 다시 붙었다');

  // 같은 화면 연결로 다음 턴 — seq 가 이어지고, 옛 core 의 종료 줄은 없다
  const before = b.events.filter((m) => m.event === 'session.event').map((m) => m.params.seq);
  await b.call('session.send', { id, text: 'again' });
  const req2 = (await b.until((m) => m.params?.ev?.kind === 'approval.requested' && m.params.ev.requestId !== req)).params.ev.requestId;
  await b.call('session.approve', { id, requestId: req2, decision: 'allow' });
  await b.until((m) => m.params?.ev?.kind === 'turn.end' && m.params.seq > Math.max(...before));
  const seqs = b.events.filter((m) => m.event === 'session.event').map((m) => m.params.seq);
  assert.deepEqual(seqs, [...new Set(seqs)].sort((x, y) => x - y), 'seq 는 겹치지 않고 오름차순');
  const log = EventLog.open(corePaths(dir).sessionsDir, id)!;
  assert.ok(!log.all.some((x) => x.ev.kind === 'session.exit'), '교체는 세션 종료로 남지 않는다');
  assert.ok(!log.meta.closedAt);

  const c = await screen(url);
  assert.equal((await c.call('session.attach', { id, limit: 50 })).result.draft, '쓰던 글', '초안이 새 core 로 넘어갔다');
  c.close(); b.close();
  e.child.kill('SIGINT');
  assert.equal(await e.exit, 0);
  assert.ok(EventLog.open(corePaths(dir).sessionsDir, id)!.meta.closedAt, 'Ctrl-C 는 새 core 의 세션을 닫는다');
  assert.ok(newCore);
});

test('카드: --takeover 로 붙은 새 serve 가 core 교체를 청하고, stdio 중계는 새 core 로 이어진다; 깨진 빌드·따라오지 못하는 소유자는 거절', async (t) => {
  const dir = tmp('slcode-swap-'), pkg = pkgCopy();
  const a = cli(dir, ['new', tmp('slcode-work-'), '--vendor', 'codex', '--stdio', '--no-web'], 'pipe', pkg);
  let b: ReturnType<typeof cli> | null = null;
  let restore = () => {};
  t.after(() => { restore(); for (const x of [a, b]) if (x && alive(x.child)) x.child.kill('SIGKILL'); });
  const hello = JSON.parse(await a.first);
  const c = await connectSession(hello.sock);
  const oldCore = (await c.request('core.auth', {})).pid;
  await assert.rejects(c.request('core.retire', { pkg: '/nonexistent' }), /new build does not run/, '깨진 빌드는 교체하지 않는다');

  // 따라오지 못하는 소유자(follows 없음 — 2단계 진입 프로세스 꼴)가 쥐고 있으면 거절
  await c.request('core.own', { pid: process.pid, takeover: true });
  await assert.rejects(c.request('core.retire', { pkg: PKG }), /cannot follow/);
  assert.equal((await c.request('core.auth', {})).pid, oldCore);

  restore = bumpBuild(pkg);
  b = cli(dir, ['resume', hello.id, '--stdio', '--no-web', '--takeover'], 'pipe', pkg);
  await b.first;
  const lines: any[] = [];
  let buf = '';
  b.child.stdout!.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const ask = (id: number, method: string, params: unknown) => { b!.child.stdin!.write(JSON.stringify({ id, method, params }) + '\n'); return waitFor(async () => lines.find((m) => m.id === id)); };
  await ask(1, 'session.attach', { id: hello.id, since: 0 });
  const p2 = await waitFor(async () => { try { const x = await connectSession(hello.sock); const p = (await x.request('core.auth', {})).pid; x.close(); return p !== oldCore && p; } catch { return false; } });
  restore(); restore = () => {};
  assert.ok(p2);
  const info = await ask(2, 'server.info', {});
  assert.equal(info.result.owner, b.child.pid, '새 serve 가 새 core 의 소유자로 다시 붙었다');
  await ask(3, 'session.send', { id: hello.id, text: 'after' });
  await waitFor(async () => lines.find((m) => m.params?.ev?.kind === 'approval.requested'));
  c.close();
  b.child.kill('SIGTERM');
  await b.exit;
  await waitFor(async () => !(await sockAlive(hello.sock)));
});

test('교체 중 표시가 있으면 connectSession 이 새 소켓을 기다리고, 없으면 바로 no_session', async () => {
  const d = tmp('slcode-mark-'), sock = path.join(d, 'sock');
  await assert.rejects(connectSession(sock), /no live session/);
  fs.writeFileSync(replacingMark(sock), String(Date.now() + 5000));
  const net = await import('node:net');
  const srv = net.createServer((s) => s.end());
  setTimeout(() => srv.listen(sock), 300);
  const c = await connectSession(sock);
  c.close();
  srv.close();
});
