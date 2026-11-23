// background 실행 (ticket slcode-background-run-tool, 사용자 결정 2026-11-23) — core 밖 프로세스 그룹·exit 파일·이어 맡기·끝 알림.
// 단위는 Background 를 바로, 통합은 실제 cli.ts 와 가짜 codex 리더 (dist 를 빌드한 뒤에 돈다 — core 는 dist/coreMain.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { Background, endText } from '../src/background.ts';
import { connectSession, PKG } from '../src/client.ts';
import { sockAlive } from '../src/live.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import type { BgTask } from '../src/protocol.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
async function until<T>(f: () => T | Promise<T>, ms = 10000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(50); }
}
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
/** 그룹이 비기를 기다린다 — sh 가 끝난 뒤에도 고아가 된 손자(좀비)는 init 이 거둘 때까지 그룹에 남는다 (전체 실행 부하에서 100~200ms 실측) */
const groupGone = (pid: number) => until(() => !groupAlive(pid));

function bgs(dir: string) {
  const ended: BgTask[] = [];
  const b = new Background({ dir, env: process.env, log: () => {}, onEnd: (t) => ended.push(t) });
  return { b, ended };
}

test('Background: 끝나면 exit code 와 출력 파일로 알리고 기록을 닫는다', async () => {
  const dir = path.join(tmp('slcode-bg-'), 'bg');
  const { b, ended } = bgs(dir);
  const t = b.run('echo hello; echo oops >&2; exit 3', 'three', os.tmpdir());
  assert.match(t.id, /^[0-9a-f]{8}$/);
  assert.equal(t.output, path.join(dir, `${t.id}.log`));
  await until(() => ended.length);
  assert.equal(ended[0].code, 3);
  assert.equal(ended[0].signal, null);
  assert.equal(fs.readFileSync(t.output, 'utf8'), 'hello\noops\n');
  const rec = JSON.parse(fs.readFileSync(path.join(dir, `${t.id}.json`), 'utf8'));
  assert.equal(rec.code, 3); assert.ok(rec.endedAt >= rec.startedAt); assert.equal(rec.output, undefined, '출력 경로는 기록에 넣지 않는다');
  assert.match(endText(ended[0]), /Background task [0-9a-f]{8} \("three"\) exited with code 3\.\nCommand: echo hello.*\nOutput: \//);
  assert.deepEqual(b.list().map((x) => x.id), [t.id]);
  assert.equal(b.list()[0].size, 'hello\noops\n'.length);
  // python 의 출력이 버퍼에 남지 않는다 — 끝나지 않은 서버의 시작 줄도 파일에 (PYTHONUNBUFFERED)
  const py = b.run(`python3 -c "print('serving'); import time; time.sleep(30)"`, 'py', os.tmpdir());
  await until(() => fs.readFileSync(py.output, 'utf8') === 'serving\n', 5000);
  await b.stop(py.id);
});

test('Background: stop 은 그룹에 SIGTERM — 알림 없이 끝난 기록을 돌려주고, SIGTERM 을 무시하면 5초 뒤 SIGKILL', { timeout: 20000 }, async () => {
  const dir = path.join(tmp('slcode-bg-'), 'bg');
  const { b, ended } = bgs(dir);
  const t = b.run('echo up; sleep 30 & sleep 30', 'two sleeps', os.tmpdir());
  await until(() => fs.readFileSync(t.output, 'utf8') === 'up\n'); // 명령이 돈 뒤 — 그 전의 SIGTERM 은 sh 의 trap 이 받고 넘겨 5초 뒤 SIGKILL 로 꺼진다
  const s = await b.stop(t.id);
  assert.equal(s.code, 143); assert.equal(s.stoppedBy, 'agent');
  await groupGone(t.pid); // 그룹의 다른 프로세스도 꺼진다
  assert.deepEqual(await b.stop(t.id), s, '이미 끝났으면 그 기록');
  await assert.rejects(b.stop('nope'), /no background task/);
  const stubborn = b.run('trap "" TERM; echo ready; sleep 30', 'stubborn', os.tmpdir());
  await until(() => fs.readFileSync(stubborn.output, 'utf8') === 'ready\n'); // trap 을 건 뒤
  const t0 = Date.now();
  const k = await b.stop(stubborn.id);
  assert.ok(Date.now() - t0 >= 4500);
  assert.equal(k.code, null); assert.equal(k.signal, 'SIGKILL');
  await groupGone(stubborn.pid);
  assert.equal(ended.length, 0, '멈춘 것은 메일로 알리지 않는다');
});

test('Background: 교체 — release 뒤 새 Background 가 adopt 로 이어 맡아 끝을 알리고 멈출 수 있다. closeAll 은 알림 없이 끈다', async () => {
  const dir = path.join(tmp('slcode-bg-'), 'bg');
  const old = bgs(dir);
  const soon = old.b.run('sleep 0.5; exit 4', 'soon', os.tmpdir());
  const long = old.b.run('sleep 30', 'long', os.tmpdir());
  old.b.release();
  const next = bgs(dir);
  next.b.adopt();
  await until(() => next.ended.length);
  assert.equal(next.ended[0].id, soon.id); assert.equal(next.ended[0].code, 4);
  assert.equal(old.ended.length, 0, '손을 뗀 core 는 알리지 않는다');
  assert.ok(groupAlive(long.pid));
  const s = await next.b.stop(long.id);
  assert.equal(s.code, 143);
  const again = next.b.run('sleep 30', 'again', os.tmpdir());
  await next.b.closeAll();
  await groupGone(again.pid);
  assert.equal(next.b.list().find((x) => x.id === again.id)?.stoppedBy, 'close');
  assert.equal(next.ended.length, 1);
  next.b.release();
});

test('Background: adopt — 끝난 뒤 exit 파일만 남았으면 그 code, pid 가 없거나 남의 프로세스면 code 모름으로 알리고 그 프로세스는 건드리지 않는다', async () => {
  const dir = path.join(tmp('slcode-bg-'), 'bg');
  fs.mkdirSync(dir);
  const rec = (id: string, pid: number) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, command: 'x', description: '', cwd: '/', pid, startedAt: Date.now() }));
  rec('aaaaaaa1', 999999); fs.writeFileSync(path.join(dir, 'aaaaaaa1.exit'), '7\n');
  rec('aaaaaaa2', 999999);
  const other: ChildProcess = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  rec('aaaaaaa3', other.pid!);
  try {
    const { b, ended } = bgs(dir);
    b.adopt();
    const by = Object.fromEntries(ended.map((t) => [t.id, t]));
    assert.equal(by.aaaaaaa1.code, 7);
    assert.equal(by.aaaaaaa2.code, null); assert.equal(by.aaaaaaa2.signal, null);
    assert.equal(by.aaaaaaa3.code, null, 'pid 재사용 — 명령줄에 exit 파일이 없다');
    assert.equal(other.exitCode, null); assert.ok(groupAlive(other.pid!), '남의 프로세스는 그대로');
    assert.match(endText(by.aaaaaaa2), /exit code is unknown/);
    b.release();
  } finally { other.kill('SIGKILL'); }
});

// ---- 통합: 가짜 codex 리더 + 세션 안의 slcode bg
const baseEnv = (dir: string, extra: Record<string, string | undefined> = {}) => ({ ...process.env, SLCODE_DIR: dir, SLCODE_OWNER_GRACE_SECS: '1', SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, FAKE_CODEX_MAIL_DONE: '1', SLCODE_SESSION_ID: undefined, SLCODE_PARENT_ID: undefined, SUPERLITE_SOCK: undefined, ...extra });
function cli(dir: string, me: string | undefined, args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => execFile(process.execPath, ['--import', TSX, CLI, ...args], { env: baseEnv(dir, { SLCODE_SESSION_ID: me }), timeout: 30000, cwd },
    (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err })));
}
const log = (dir: string, id: string) => EventLog.open(corePaths(dir).sessionsDir, id)!.all;
const exitedTurns = (dir: string, id: string) => log(dir, id).filter((e) => e.ev.kind === 'turn.start' && e.ev.origin === 'mail' && e.ev.text.includes('kind="exited"')).map((e) => (e.ev as { text: string }).text);
async function leader(t: { after: (f: () => void | Promise<void>) => void }, extra: Record<string, string> = {}) {
  const dir = tmp('slcode-bgi-'), work = tmp('slcode-bgw-');
  const child = spawn(process.execPath, ['--import', TSX, CLI, 'new', work, '--no-web', '--vendor', 'codex', '--mode', 'default'], { env: baseEnv(dir, extra), stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout!.setEncoding('utf8');
  const sock = await new Promise<string>((resolve) => { let buf = ''; child.stdout!.on('data', (d: string) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i)); }); });
  const [m] = EventLog.list(corePaths(dir).sessionsDir);
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    const s = new EventLog(corePaths(dir).sessionsDir, EventLog.list(corePaths(dir).sessionsDir)[0]).sockPath;
    if (await sockAlive(s)) { const c = await connectSession(s); await c.request('session.close', { id: m.id }).catch(() => {}); c.close(); }
  });
  return { dir, work, sock, id: m.id, sessionDir: new EventLog(corePaths(dir).sessionsDir, m).dir };
}

test('slcode bg: 세션 안에서 띄우면 id·출력 파일을 내고, 끝나면 리더가 kind=exited 메일로 턴을 연다. 낱말 여럿은 셸이 나눈 그대로. 화면에는 session.bg 로 알린다. list·stop(화면의 중지는 by user), 닫으면 끈다', { timeout: 60000 }, async (t) => {
  const { dir, work, sock, id, sessionDir } = await leader(t);
  const screen = await connectSession(sock); // 화면 연결 — 작업이 생기고 끝날 때마다 목록 전부
  const bgEvents: BgTask[][] = [];
  screen.onEvent((m: any) => { if (m.event === 'session.bg' && m.params.id === id) bgEvents.push(m.params.tasks); });
  t.after(() => screen.close());
  const out = await cli(dir, undefined, ['bg', 'list']);
  assert.equal(out.code, 2, '세션 밖에서는 안 된다');
  const r = await cli(dir, id, ['bg', 'run', '-n', 'quick', '--', 'echo "$PWD"; exit 2'], work);
  assert.equal(r.code, 0, r.err);
  const [tid, output] = r.out.trim().split('\n');
  assert.match(tid, /^[0-9a-f]{8}$/);
  assert.equal(output, path.join(sessionDir, 'bg', `${tid}.log`));
  const turn = (await until(() => exitedTurns(dir, id)[0]))!;
  assert.match(turn, new RegExp(`from="bg:${tid}"[^>]*kind="exited"[^>]*>\\nBackground task ${tid} \\("quick"\\) exited with code 2\\.`));
  assert.equal(fs.readFileSync(output, 'utf8').trim(), fs.realpathSync(work), '폴더를 빼면 지금 폴더');
  assert.ok(bgEvents.some((l) => l.some((x) => x.id === tid && x.endedAt === undefined)), '생길 때');
  assert.ok(bgEvents.some((l) => l.some((x) => x.id === tid && x.code === 2)), '끝날 때');
  // 낱말 여럿 — 따옴표 안의 공백이 그대로
  const w = await cli(dir, id, ['bg', 'run', '--', 'printf', '%s|', 'a  b', "it's"], work);
  const wout = w.out.trim().split('\n')[1];
  await until(() => exitedTurns(dir, id).length === 2);
  assert.equal(fs.readFileSync(wout, 'utf8'), "a  b|it's|");
  // 도는 것: list 에 running, stop 은 알림 없이
  const s = await cli(dir, id, ['bg', 'run', '-n', 'server', '--', 'sleep 30'], work);
  const sid = s.out.trim().split('\n')[0];
  const l = await cli(dir, id, ['bg', 'list']);
  assert.match(l.out, new RegExp(`${sid}  running  \\S+  server  sleep 30  /`));
  assert.match(l.out, new RegExp(`${tid}  exited 2  `));
  const st = await cli(dir, id, ['bg', 'stop', sid]);
  assert.match(st.out, new RegExp(`background task ${sid} stopped, exited 143\\. Output: /`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(sessionDir, 'bg', `${sid}.json`), 'utf8')).stoppedBy, 'agent');
  const u = (await cli(dir, id, ['bg', 'run', '--', 'sleep 30'], work)).out.trim().split('\n')[0];
  assert.equal((await screen.request('session.bgStop', { id, task: u, by: 'user' })).stoppedBy, 'user', '화면의 중지');
  // 닫으면 끈다
  const k = await cli(dir, id, ['bg', 'run', '--', 'sleep 30'], work);
  const kid = k.out.trim().split('\n')[0];
  const pid = JSON.parse(fs.readFileSync(path.join(sessionDir, 'bg', `${kid}.json`), 'utf8')).pid;
  assert.ok(groupAlive(pid));
  const c = await connectSession(sock);
  await c.request('session.close', { id }).catch(() => {});
  c.close();
  await until(() => !groupAlive(pid));
  await until(() => JSON.parse(fs.readFileSync(path.join(sessionDir, 'bg', `${kid}.json`), 'utf8')).stoppedBy === 'close');
  assert.equal(exitedTurns(dir, id).length, 2, '멈춘 것·닫아서 끈 것은 메일이 없다');
});

test('slcode bg: core 교체 — 도는 작업은 끊기지 않고 새 core 가 이어 맡아 끝을 알리고 멈출 수 있다', { timeout: 60000 }, async (t) => {
  const { dir, work, sock, id, sessionDir } = await leader(t);
  const soon = (await cli(dir, id, ['bg', 'run', '-n', 'soon', '--', 'sleep 2; exit 5'], work)).out.trim().split('\n')[0];
  const long = (await cli(dir, id, ['bg', 'run', '-n', 'long', '--', 'sleep 30'], work)).out.trim().split('\n')[0];
  const pidOf = (tid: string) => JSON.parse(fs.readFileSync(path.join(sessionDir, 'bg', `${tid}.json`), 'utf8')).pid;
  const before = EventLog.open(corePaths(dir).sessionsDir, id)!.meta.pid;
  const c = await connectSession(sock);
  await c.request('core.retire', { pkg: PKG });
  // 교체가 끝날 때까지 연결을 쥔다 — 청한 쪽이 떠나면 core 는 교체를 거둔다 (serve 도 쥐고 있다). 'soon' 이 먼저 끝나 메일 턴이 돌면 교체는 그 턴 뒤로 밀린다
  await until(() => { const p = EventLog.open(corePaths(dir).sessionsDir, id)!.meta.pid; return p && p !== before; }, 20000);
  c.close();
  assert.ok(groupAlive(pidOf(long)), '교체해도 작업은 산다');
  const turn = (await until(() => exitedTurns(dir, id)[0], 15000))!;
  assert.match(turn, new RegExp(`from="bg:${soon}"[\\s\\S]*exited with code 5`));
  const st = await cli(dir, id, ['bg', 'stop', long]);
  assert.match(st.out, /stopped, exited 143/);
  await until(() => !groupAlive(pidOf(long)), 2000); // 이어 맡은 것은 exit 파일로 끝을 안다 — sh 는 그 직후에 끝난다
});

test('slcode bg: core 교체 중 옛 core 가 벤더를 내리는 사이에 끝난 작업도 새 core 가 끝을 알린다', { timeout: 60000 }, async (t) => {
  const hold = path.join(tmp('slcode-bgh-'), 'pid'); // 가짜 codex 는 이 pid(작업의 sh)가 없어질 때까지 내려가지 않는다
  const { dir, work, sock, id, sessionDir } = await leader(t, { FAKE_CODEX_TERM_WAIT: hold });
  // 교체 표시(옛 core 가 교체를 시작하며 쓴다)가 생기면 끝난다
  const tid = (await cli(dir, id, ['bg', 'run', '-n', 'mid', '--', `while [ ! -e ${sock}.replacing ]; do sleep 0.05; done; exit 5`], work)).out.trim().split('\n')[0];
  fs.writeFileSync(hold, String(JSON.parse(fs.readFileSync(path.join(sessionDir, 'bg', `${tid}.json`), 'utf8')).pid));
  const before = EventLog.open(corePaths(dir).sessionsDir, id)!.meta.pid;
  const c = await connectSession(sock);
  await c.request('core.retire', { pkg: PKG });
  await until(() => { const p = EventLog.open(corePaths(dir).sessionsDir, id)!.meta.pid; return p && p !== before; }, 20000);
  c.close();
  // 예전에는 옛 core 가 닫힌 뒤 이 끝을 받아 메일을 버리고 기록만 끝남으로 남겨, 새 core 도 알리지 않았다
  const turn = (await until(() => exitedTurns(dir, id)[0], 15000))!;
  assert.match(turn, new RegExp(`from="bg:${tid}"[\\s\\S]*exited with code 5`));
});

test('slcode bg: core 가 죽은 사이 끝난 작업 — resume 하면 새 core 가 바로 뜨고 그 끝을 메일로 알린다', { timeout: 60000 }, async (t) => {
  const { dir, work, id, sessionDir } = await leader(t);
  const go = path.join(work, 'go');
  const tid = (await cli(dir, id, ['bg', 'run', '-n', 'gated', '--', `while [ ! -e ${go} ]; do sleep 0.05; done; exit 5`], work)).out.trim().split('\n')[0];
  const core = EventLog.open(corePaths(dir).sessionsDir, id)!.meta.pid!;
  process.kill(core, 'SIGKILL');
  await until(() => { try { process.kill(core, 0); return false; } catch { return true; } });
  fs.writeFileSync(go, '');
  await until(() => fs.existsSync(path.join(sessionDir, 'bg', `${tid}.exit`)));
  // 예전에는 adopt 가 이 끝을 기동 중에 알리다 TDZ 로 죽었다 — 첫 resume 가 실패하고 끝 알림은 사라졌다
  const child = spawn(process.execPath, ['--import', TSX, CLI, 'resume', id, '--no-web'], { env: baseEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let err = '';
  child.stderr!.setEncoding('utf8').on('data', (d: string) => { err += d; });
  child.stdout!.setEncoding('utf8');
  await new Promise<void>((resolve, reject) => { child.stdout!.on('data', (d: string) => { if (d.includes('\n')) resolve(); }); child.once('exit', () => reject(new Error(`resume ended: ${err.trim()}`))); });
  const turn = (await until(() => exitedTurns(dir, id)[0], 15000))!;
  assert.match(turn, new RegExp(`from="bg:${tid}"[\\s\\S]*exited with code 5`));
});
