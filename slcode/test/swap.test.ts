// serve 교체 (ticket slcode-core-serve-split 2단계) — 실제 cli.ts 를 자식 프로세스로 띄우고 벤더는 가짜 codex 를 쓴다.
// 가짜 codex 의 턴은 명령 승인 요청에서 멈춘다 — 그동안 serve 를 바꿔도 턴이 이어지는지 본다. dist/ 가 빌드돼 있어야 한다 (core·serve 자식은 dist 에서 뜬다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectSession, PKG } from '../src/client.ts';
import { sockAlive } from '../src/live.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const ENV = (dir: string) => ({ ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_OWNER_GRACE_SECS: '1', SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, SLCODE_SESSION: undefined, SUPERLITE_SOCK: undefined });

/** cli 하나 — stdout 첫 줄을 기다린다 */
function cli(dir: string, args: string[], stdin: 'ignore' | 'pipe' = 'ignore'): { child: ChildProcess; first: Promise<string>; exit: Promise<number | null> } {
  const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], { env: ENV(dir), stdio: [stdin, 'pipe', 'ignore'] });
  child.stdout!.setEncoding('utf8');
  const first = new Promise<string>((resolve) => { let buf = ''; child.stdout!.on('data', (d: string) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i)); }); });
  const exit = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  return { child, first, exit };
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
  const dir = tmp('slcode-swap-');
  const e = cli(dir, ['new', tmp('slcode-work-'), '--vendor', 'codex']);
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
  const cliJs = path.join(PKG, 'dist', 'cli.js'), st = fs.statSync(cliJs);
  fs.utimesSync(cliJs, st.atime, new Date(st.mtimeMs + 2000));
  try {
    const u = (await a.call('update.run')).result;
    assert.equal(u.status, 'restart-required');
    assert.equal((await a.call('serve.info')).result.update.status, 'restart-required', '다시 연 화면도 안다');
  } finally { fs.utimesSync(cliJs, st.atime, st.mtime); }

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

test('카드: resume --stdio --takeover 는 떠 있는 세션의 소유권을 빼앗는다 — 옛 serve 가 SIGTERM 으로 끝나도 세션은 산다', async (t) => {
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
  await sleep(1500); // 우체국 grace
});
