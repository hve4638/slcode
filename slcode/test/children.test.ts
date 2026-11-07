// 자식 세션 (ticket slcode-subagent-sessions, 사용자 결정 2026-11-07) — 부모 core 가 자식 core 를 띄우고 소유한다. 잠긴 자식은 부모의 지시만 받고,
// 턴이 끝나면 마지막 답이 부모에 메시지로 간다. 실제 cli.ts 를 자식 프로세스로 띄우고 벤더는 가짜 codex 를 쓴다 (dist 를 빌드한 뒤에 돈다 — core 는 dist/coreMain.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { connectSession, type RpcClient } from '../src/client.ts';
import { sockAlive } from '../src/live.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const baseEnv = (dir: string, extra: Record<string, string | undefined> = {}) => ({ ...process.env, SLCODE_DIR: dir, SLCODE_OWNER_GRACE_SECS: '1', SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, FAKE_CODEX_MAIL_DONE: '1', SLCODE_SESSION_ID: undefined, SLCODE_PARENT_ID: undefined, SLCODE_EXPERIMENTAL_SUBAGENTS: '1', SUPERLITE_SOCK: undefined, ...extra });

/** 부모 세션 — cli new --no-web, 첫 stdout 줄이 세션 소켓 경로 */
function parent(dir: string, work: string, extra: Record<string, string | undefined> = {}): { child: ChildProcess; sock: Promise<string> } {
  const child = spawn(process.execPath, ['--import', TSX, CLI, 'new', work, '--no-web', '--vendor', 'codex', '--mode', 'default'], { env: baseEnv(dir, extra), stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout!.setEncoding('utf8');
  const sock = new Promise<string>((resolve) => { let buf = ''; child.stdout!.on('data', (d: string) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i)); }); });
  return { child, sock };
}
/** 부모 세션의 모델이 Bash 로 치는 slcode — SLCODE_SESSION_ID 가 부모 */
function cli(dir: string, me: string | undefined, args: string[], extra: Record<string, string | undefined> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => execFile(process.execPath, ['--import', TSX, CLI, ...args], { env: baseEnv(dir, { SLCODE_SESSION_ID: me, ...extra }), timeout: 30000 },
    (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err })));
}
const meta = (dir: string, id: string) => EventLog.open(corePaths(dir).sessionsDir, id)!.meta;
const log = (dir: string, id: string) => EventLog.open(corePaths(dir).sessionsDir, id)!.all;
const sockOf = (dir: string, id: string) => EventLog.open(corePaths(dir).sessionsDir, id)!.sockPath;
async function until<T>(f: () => T | Promise<T>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out'); await sleep(100); }
}
const mailTurns = (dir: string, id: string, kind: string) => log(dir, id).filter((e) => e.ev.kind === 'turn.start' && e.ev.origin === 'mail' && e.ev.text.includes(`kind="${kind}"`));
async function expectCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: { code?: string }) => { assert.equal(e.code, code); return true; });
}

test('세션 안의 slcode new 는 부모가 소유한 잠긴 자식을 만들고, 자식의 턴이 끝나면 마지막 답이 부모에 간다', async (t) => {
  const dir = tmp('slcode-kids-'), work = tmp('slcode-work-');
  const p = parent(dir, work);
  t.after(() => { if (p.child.exitCode === null) p.child.kill('SIGKILL'); });
  const psock = await p.sock;
  const [pm] = EventLog.list(corePaths(dir).sessionsDir);
  const pid = pm.id;

  // 모델이 친 slcode new — id 를 출력하고 바로 끝난다
  const made = await cli(dir, pid, ['new', work, '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  assert.match(kid, /^[0-9a-f]{8}$/);
  assert.deepEqual(meta(dir, kid).parent, { id: pid, kind: 'child' });
  assert.equal(meta(dir, kid).permissionMode, 'default', '권한 모드는 부모를 따른다');
  assert.equal(meta(dir, kid).vendor, 'codex', '벤더는 부모를 따른다');

  // 첫 턴의 답이 부모에 kind=result 로
  await until(() => mailTurns(dir, pid, 'result').length);
  assert.match(mailTurns(dir, pid, 'result')[0].ev.kind === 'turn.start' ? (mailTurns(dir, pid, 'result')[0].ev as { text: string }).text : '', /from="[0-9a-f]{8}"[\s\S]*done/);

  const c = await connectSession(sockOf(dir, kid));
  t.after(() => c.close());
  const info = (await c.request('session.attach', { id: kid, since: Number.MAX_SAFE_INTEGER })).info;
  assert.equal(info.locked, true, '잠겨 있다');
  assert.equal(info.subagents, false, '자식은 자식을 만들지 못한다');
  assert.equal((await c.request('server.info')).owner, meta(dir, pid).pid, '소유자는 부모 core');

  // 화면·사람의 지시는 거절, 소유권도 가져가지 못한다
  await expectCode(c.request('session.send', { id: kid, text: 'hi' }), 'locked');
  await expectCode(c.request('core.own', { pid: 1, takeover: true }), 'parent_owned');
  const stranger = await cli(dir, undefined, ['prompt', kid, 'hi']);
  assert.notEqual(stranger.code, 0);
  assert.match(stranger.err, /controlled by its parent/);

  // 부모의 지시는 부모 core 를 거쳐 간다
  const before = mailTurns(dir, pid, 'result').length;
  const told = await cli(dir, pid, ['prompt', kid, 'no-call']);
  assert.equal(told.code, 0, told.err);
  await until(() => mailTurns(dir, pid, 'result').length > before);

  // 자식이 다시 자식을 만들 수 없다
  const grand = await cli(dir, kid, ['new', work, '--', 'no-call']);
  assert.notEqual(grand.code, 0);
  assert.match(grand.err, /one level only/);

  // 강제로 풀기 — 화면이 지시하고, 부모의 지시는 거절되고, 부모는 알림을 받는다
  await c.request('session.unlock', { id: kid });
  assert.equal(meta(dir, kid).unlocked, true);
  await until(() => mailTurns(dir, pid, 'unlocked').length);
  const refused = await cli(dir, pid, ['prompt', kid, 'no-call']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /took over/);
  const results = mailTurns(dir, pid, 'result').length;
  await c.request('session.send', { id: kid, text: 'no-call' });
  await until(() => log(dir, kid).filter((e) => e.ev.kind === 'turn.end').length >= 3);
  await sleep(500);
  assert.equal(mailTurns(dir, pid, 'result').length, results, '풀린 동안의 턴은 보고하지 않는다');
  // 다시 잠그기
  await c.request('session.lock', { id: kid });
  await until(() => mailTurns(dir, pid, 'locked').length);
  await expectCode(c.request('session.send', { id: kid, text: 'hi' }), 'locked');

  // 부모가 닫히면 자식도 닫힌다
  const pc = await connectSession(psock);
  await pc.request('session.close', { id: pid });
  pc.close();
  assert.ok(await until(async () => !(await sockAlive(sockOf(dir, kid)))), '자식도 닫혔다');
});

test('자식의 도구 승인은 부모 화면(session.children·childApprove)에서 사람이 답하고, 부모 모델(childCall)은 답하지 못한다', async (t) => {
  const dir = tmp('slcode-kids-'), work = tmp('slcode-work-');
  const p = parent(dir, work);
  t.after(() => { if (p.child.exitCode === null) p.child.kill('SIGKILL'); });
  const psock = await p.sock;
  const [pm] = EventLog.list(corePaths(dir).sessionsDir);
  const pid = pm.id;
  const pc: RpcClient = await connectSession(psock);
  t.after(() => pc.close());
  await pc.request('session.attach', { id: pid, since: Number.MAX_SAFE_INTEGER });
  const events: string[] = [];
  pc.onEvent((m) => { if (m.event === 'session.children') events.push(JSON.stringify(m.params)); });

  // 가짜 codex 는 보통 턴에서 명령 승인을 묻는다
  const made = await cli(dir, pid, ['new', work, '--', 'touch it']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  const view = await until(async () => (await pc.request('session.children', { id: pid })).children.find((k) => k.id === kid && k.pending.length));
  const req = view.pending[0];
  assert.ok(events.length, 'session.children 방송');
  await expectCode(pc.request('session.childCall', { id: pid, child: kid, method: 'session.approve', params: { requestId: req.requestId, decision: 'allow' } }), 'bad_request');
  assert.deepEqual(await pc.request('session.childApprove', { id: pid, child: kid, requestId: req.requestId, decision: 'deny' }), { ok: true });
  await until(async () => !(await pc.request('session.children', { id: pid })).children.find((k) => k.id === kid)?.pending.length);
  // 부모가 닫기를 청하지 않고 자식이 끝나면 부모가 kind=closed 를 받는다
  const kc = await connectSession(sockOf(dir, kid));
  await kc.request('session.close', { id: kid });
  kc.close();
  await until(() => mailTurns(dir, pid, 'closed').length);
});

test('부모 core 가 죽으면 자식은 소유자 유예 뒤 닫히고, SLCODE_EXPERIMENTAL_SUBAGENTS=1 없이 뜬 세션(기본)은 자식을 만들지 않는다', async (t) => {
  const dir = tmp('slcode-kids-'), work = tmp('slcode-work-');
  const p = parent(dir, work);
  t.after(() => { if (p.child.exitCode === null) p.child.kill('SIGKILL'); });
  await p.sock;
  const [pm] = EventLog.list(corePaths(dir).sessionsDir);
  const made = await cli(dir, pm.id, ['new', work, '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  await until(() => sockAlive(sockOf(dir, kid)));
  process.kill(meta(dir, pm.id).pid!, 'SIGKILL');
  assert.ok(await until(async () => !(await sockAlive(sockOf(dir, kid)))), '자식이 닫혔다');

  const dir2 = tmp('slcode-kids-');
  const q = parent(dir2, work, { SLCODE_EXPERIMENTAL_SUBAGENTS: undefined });
  t.after(() => { if (q.child.exitCode === null) q.child.kill('SIGKILL'); });
  const qsock = await q.sock;
  const [qm] = EventLog.list(corePaths(dir2).sessionsDir);
  const qc = await connectSession(qsock);
  t.after(() => qc.close());
  assert.equal((await qc.request('session.attach', { id: qm.id, since: Number.MAX_SAFE_INTEGER })).info.subagents, false);
  await expectCode(qc.request('session.spawnChild', { id: qm.id, cwd: work }), 'subagents_disabled');
});

test('부모 core 가 교체되면 새 부모 core 가 켜진 자식을 다시 소유한다 (자식은 닫히지 않는다)', async (t) => {
  const dir = tmp('slcode-kids-'), work = tmp('slcode-work-');
  const p = parent(dir, work);
  t.after(() => { if (p.child.exitCode === null) p.child.kill('SIGKILL'); });
  const psock = await p.sock;
  const [pm] = EventLog.list(corePaths(dir).sessionsDir);
  const made = await cli(dir, pm.id, ['new', work, '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  await until(() => mailTurns(dir, pm.id, 'result').length);
  const oldPid = meta(dir, pm.id).pid;
  const rc = await connectSession(psock);
  t.after(() => rc.close());
  await rc.request('core.retire', { pkg: path.resolve(import.meta.dirname, '..') });
  await until(() => meta(dir, pm.id).pid !== oldPid, 20000);
  await sleep(2500); // 소유자 유예(1초)보다 길게
  assert.ok(await sockAlive(sockOf(dir, kid)), '자식은 살아 있다');
  const c = await connectSession(sockOf(dir, kid));
  t.after(() => c.close());
  assert.equal((await c.request('server.info')).owner, meta(dir, pm.id).pid, '새 부모 core 가 소유한다');
  await expectCode(c.request('session.send', { id: kid, text: 'hi' }), 'locked');
});
