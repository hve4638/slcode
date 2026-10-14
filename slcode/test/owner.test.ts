// 세션 소유권 (ticket slcode-core-serve-split) — 세션은 detached core 가 쥐고, 수명은 소유자(core.own 을 보낸 연결)가 정한다.
// 실제 cli.ts 를 자식 프로세스(serve)로 띄우고 벤더는 가짜 codex 를 쓴다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { connectPost, connectSession } from '../src/client.ts';
import { sockAlive } from '../src/live.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import { pidAlive } from '../src/lock.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** serve(cli new) 하나 — 소유자 유예는 1초, 첫 stdout 줄은 세션 소켓 경로 */
function serve(dir: string, work: string): { child: ChildProcess; sock: Promise<string>; exit: Promise<number | null> } {
  const env = { ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_OWNER_GRACE_SECS: '1', SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, SLCODE_SESSION: undefined, SUPERLITE_SOCK: undefined };
  const child = spawn(process.execPath, ['--import', TSX, CLI, 'new', work, '--no-web', '--vendor', 'codex'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout!.setEncoding('utf8');
  const sock = new Promise<string>((resolve) => { let buf = ''; child.stdout!.on('data', (d: string) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i)); }); });
  const exit = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  return { child, sock, exit };
}
async function corePid(dir: string, id: string): Promise<number> {
  const { client } = await connectPost({ dir, autoStart: false });
  const pid = (await client.request('post.list')).find((e) => e.id === id)?.pid ?? 0;
  client.close();
  return pid;
}
const pgid = (pid: number) => Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[2]);
async function waitClosed(sock: string, ms = 6000) { const t0 = Date.now(); while ((await sockAlive(sock)) && Date.now() - t0 < ms) await sleep(100); return !(await sockAlive(sock)); }

test('소유자가 close 없이 사라지면(SIGKILL) core 는 유예 동안 기다렸다가 세션을 닫는다; core 는 serve 와 다른 프로세스 그룹이다', async (t) => {
  const dir = tmp('slcode-own-');
  const a = serve(dir, tmp('slcode-work-'));
  t.after(() => { if (a.child.exitCode === null && a.child.signalCode === null) a.child.kill('SIGKILL'); });
  const sock = await a.sock;
  const [m] = EventLog.list(corePaths(dir).sessionsDir);
  await sleep(300);
  const pid = await corePid(dir, m.id);
  assert.ok(pid && pid !== a.child.pid, 'core 는 serve 와 다른 프로세스');
  if (process.platform === 'linux') assert.notEqual(pgid(pid), pgid(a.child.pid!), 'setsid — 터미널 Ctrl-C·서비스 그룹 SIGTERM 이 닿지 않는다');
  const c = await connectSession(sock);
  assert.equal((await c.request('server.info')).owner, a.child.pid, '소유자는 serve');
  c.close();
  a.child.kill('SIGKILL');
  await sleep(300);
  assert.ok(await sockAlive(sock), '유예 동안은 산다');
  assert.ok(await waitClosed(sock), '유예가 지나면 닫힌다');
  const log = EventLog.open(corePaths(dir).sessionsDir, m.id)!;
  assert.ok(log.meta.closedAt, '꺼진 시각');
  assert.ok(log.all.some((e) => e.ev.kind === 'session.exit'), '종료 이벤트');
  await sleep(300);
  assert.ok(!pidAlive(pid), 'core 프로세스도 끝난다');
  await sleep(1500); // 우체국 grace
});

test('takeover: 소유자가 있으면 core.own 은 owned, takeover 면 빼앗는다 — 빼앗긴 serve 가 끝나도 세션은 살고, 새 소유자가 끊기면 유예 뒤 닫힌다', async (t) => {
  const dir = tmp('slcode-own-');
  const a = serve(dir, tmp('slcode-work-'));
  t.after(() => { if (a.child.exitCode === null && a.child.signalCode === null) a.child.kill('SIGKILL'); });
  const sock = await a.sock;
  const c = await connectSession(sock);
  await assert.rejects(c.request('core.own', { pid: 4242 }), /owned by pid/);
  await c.request('core.own', { pid: 4242, takeover: true });
  assert.equal((await c.request('server.info')).owner, 4242);
  a.child.kill('SIGINT');
  assert.equal(await a.exit, 0);
  await sleep(300);
  assert.ok(await sockAlive(sock), '빼앗긴 serve 는 세션을 닫지 않는다');
  c.close();
  assert.ok(await waitClosed(sock), '새 소유자가 close 없이 끊기면 유예 뒤 닫힌다');
  await sleep(1500); // 우체국 grace
});

test('소유자가 사라진 뒤 유예 안에 새 소유자가 오면 세션은 산다', async (t) => {
  const dir = tmp('slcode-own-');
  const a = serve(dir, tmp('slcode-work-'));
  t.after(() => { if (a.child.exitCode === null && a.child.signalCode === null) a.child.kill('SIGKILL'); });
  const sock = await a.sock;
  const c = await connectSession(sock);
  const id = (await c.request('server.info')).session;
  a.child.kill('SIGKILL');
  await a.exit;
  await sleep(200);
  await c.request('core.own', { pid: 4243 });
  await sleep(1800); // 유예(1초)를 넘긴다
  assert.ok(await sockAlive(sock), '새 소유자가 있으면 닫지 않는다');
  assert.equal((await c.request('server.info')).owner, 4243);
  await c.request('session.close', { id });
  c.close();
  assert.ok(await waitClosed(sock));
  await sleep(1500); // 우체국 grace
});
