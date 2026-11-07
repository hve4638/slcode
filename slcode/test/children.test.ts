// 팀원 세션 (ticket slcode-team-agent, 사용자 결정 2026-11-07~08) — 세션 안의 `slcode team new` 로 리더 core 가 팀원 core 를 띄운다.
// 관여 옵션(템플릿 subagent·link·detached + -o JSON)에 따라 잠김·자동 보고·질문·수명이 갈린다. 메시지는 fast(기본)·lazy.
// 실제 cli.ts 를 자식 프로세스로 띄우고 벤더는 가짜 codex 를 쓴다 (dist 를 빌드한 뒤에 돈다 — core 는 dist/coreMain.js).
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
import { TEAM_TEMPLATES } from '../src/protocol.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const baseEnv = (dir: string, extra: Record<string, string | undefined> = {}) => ({ ...process.env, SLCODE_DIR: dir, SLCODE_OWNER_GRACE_SECS: '1', SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, FAKE_CODEX_MAIL_DONE: '1', SLCODE_SESSION_ID: undefined, SLCODE_PARENT_ID: undefined, SUPERLITE_SOCK: undefined, ...extra });

/** 리더 세션 — cli new --no-web, 첫 stdout 줄이 세션 소켓 경로 */
function leader(dir: string, work: string, extra: Record<string, string | undefined> = {}, args: string[] = []): { child: ChildProcess; sock: Promise<string> } {
  const child = spawn(process.execPath, ['--import', TSX, CLI, 'new', work, '--no-web', '--vendor', 'codex', '--mode', 'default', ...args], { env: baseEnv(dir, extra), stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout!.setEncoding('utf8');
  const sock = new Promise<string>((resolve) => { let buf = ''; child.stdout!.on('data', (d: string) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) resolve(buf.slice(0, i)); }); });
  return { child, sock };
}
/** 세션의 모델이 Bash 로 치는 slcode — SLCODE_SESSION_ID 가 me. input 이 있으면 bash 의 heredoc 으로 stdin 에 (모델이 치는 꼴 그대로) */
function cli(dir: string, me: string | undefined, args: string[], extra: Record<string, string | undefined> = {}, input?: string, cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const [bin, argv] = input === undefined ? [process.execPath, ['--import', TSX, CLI, ...args]]
    : ['bash', ['-c', `${[process.execPath, '--import', TSX, CLI, ...args].map(q).join(' ')} <<'EOF'\n${input}\nEOF`]];
  return new Promise((resolve) => execFile(bin, argv, { env: baseEnv(dir, { SLCODE_SESSION_ID: me, ...extra }), timeout: 30000, cwd },
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
const turnEnds = (dir: string, id: string) => log(dir, id).filter((e) => e.ev.kind === 'turn.end').length;
async function expectCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: { code?: string }) => { assert.equal(e.code, code); return true; });
}
async function start(t: { after: (f: () => void) => void }, extra: Record<string, string | undefined> = {}, args: string[] = []) {
  const dir = tmp('slcode-team-'), work = tmp('slcode-work-');
  const p = leader(dir, work, extra, args);
  t.after(() => { if (p.child.exitCode === null) p.child.kill('SIGKILL'); });
  const psock = await p.sock;
  const [pm] = EventLog.list(corePaths(dir).sessionsDir);
  return { dir, work, psock, lid: pm.id };
}

test('team new --subagent: 리더가 입력을 쥐고, 턴이 끝나면 마지막 답이 리더에 간다. 끊기는 일방향이고, 리더가 닫히면 같이 닫힌다', async (t) => {
  const { dir, work, psock, lid } = await start(t);

  // 모델이 친 slcode team new — id 를 출력하고 바로 끝난다. 폴더를 빼면 지금 폴더
  const made = await cli(dir, lid, ['team', 'new', work, '--subagent', '-n', 'sub1', '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  assert.match(kid, /^[0-9a-f]{8}$/);
  assert.deepEqual(meta(dir, kid).parent, { id: lid, kind: 'child' });
  assert.deepEqual(meta(dir, kid).team, TEAM_TEMPLATES.subagent);
  assert.equal(meta(dir, kid).noTeam, true);
  assert.equal(meta(dir, kid).title, 'sub1');
  assert.equal(meta(dir, kid).permissionMode, 'default', '권한 모드는 리더를 따른다');
  assert.equal(meta(dir, kid).vendor, 'codex', '벤더는 리더를 따른다');

  // 첫 턴의 답이 리더에 kind=result 로
  await until(() => mailTurns(dir, lid, 'result').length);
  assert.match((mailTurns(dir, lid, 'result')[0].ev as { text: string }).text, /from="[0-9a-f]{8}" name="sub1"[\s\S]*done/);

  const c = await connectSession(sockOf(dir, kid));
  t.after(() => c.close());
  const info = (await c.request('session.attach', { id: kid, since: Number.MAX_SAFE_INTEGER })).info;
  assert.equal(info.locked, true, '잠겨 있다');
  assert.equal((await c.request('server.info')).owner, meta(dir, lid).pid, '소유자는 리더 core');

  // 화면·사람의 지시는 거절, 소유권도 가져가지 못한다. 메시지는 누구에게서나 받는다
  await expectCode(c.request('session.send', { id: kid, text: 'hi' }), 'locked');
  await expectCode(c.request('core.own', { pid: 1, takeover: true }), 'parent_owned');
  const stranger = await cli(dir, undefined, ['prompt', kid, 'hi']);
  assert.notEqual(stranger.code, 0);
  assert.match(stranger.err, /leader .* controls/);
  const outside = await cli(dir, undefined, ['mail', kid, 'from outside']);
  assert.equal(outside.code, 0, outside.err);
  await until(() => log(dir, kid).some((e) => e.ev.kind === 'turn.start' && e.ev.origin === 'mail' && e.ev.text.includes('from outside')));

  // 리더의 지시는 리더 core 를 거쳐 간다
  const before = mailTurns(dir, lid, 'result').length;
  const told = await cli(dir, lid, ['prompt', kid, 'no-call']);
  assert.equal(told.code, 0, told.err);
  await until(() => mailTurns(dir, lid, 'result').length > before);

  // 팀원은 팀원을 만들지 못한다 (noTeam)
  const grand = await cli(dir, kid, ['team', 'new', work, '--', 'no-call']);
  assert.notEqual(grand.code, 0);
  assert.match(grand.err, /cannot start teammates/);

  // 끊기 — 화면이 지시하고, 리더의 지시는 거절되고, 리더는 알림을 한 번 받는다. 되돌리는 메서드는 없다
  await c.request('session.unlock', { id: kid });
  assert.deepEqual(meta(dir, kid).team, { ...TEAM_TEMPLATES.subagent, inputControl: false, outputToLeader: false, askToLeader: false, cut: true });
  await until(() => mailTurns(dir, lid, 'unlocked').length);
  await expectCode(c.request('session.lock' as never, { id: kid } as never), 'bad_request');
  const refused = await cli(dir, lid, ['prompt', kid, 'no-call']);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /cut teammate .* loose/);
  const results = mailTurns(dir, lid, 'result').length;
  const ends = turnEnds(dir, kid);
  await c.request('session.send', { id: kid, text: 'no-call' });
  await until(() => turnEnds(dir, kid) > ends);
  await sleep(500);
  assert.equal(mailTurns(dir, lid, 'result').length, results, '끊은 뒤의 턴은 보고하지 않는다');
  assert.equal((await c.request('session.attach', { id: kid, since: Number.MAX_SAFE_INTEGER })).info.locked, false);

  // 리더가 닫히면 수명 연동 팀원도 닫힌다
  const pc = await connectSession(psock);
  await pc.request('session.close', { id: lid });
  pc.close();
  assert.ok(await until(async () => !(await sockAlive(sockOf(dir, kid)))), '팀원도 닫혔다');
});

test('subagent 팀원의 도구 승인은 리더 화면(session.children·childApprove)에서 사람이 답하고, 리더 모델(childCall)은 답하지 못한다', async (t) => {
  const { dir, work, psock, lid } = await start(t);
  const pc: RpcClient = await connectSession(psock);
  t.after(() => pc.close());
  await pc.request('session.attach', { id: lid, since: Number.MAX_SAFE_INTEGER });
  const events: string[] = [];
  pc.onEvent((m) => { if (m.event === 'session.children') events.push(JSON.stringify(m.params)); });

  // 가짜 codex 는 보통 턴에서 명령 승인을 묻는다
  const made = await cli(dir, lid, ['team', 'new', work, '-s', '--', 'touch it']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  const view = await until(async () => (await pc.request('session.children', { id: lid })).children.find((k) => k.id === kid && k.pending.length));
  const req = view.pending[0];
  assert.ok(events.length, 'session.children 방송');
  await expectCode(pc.request('session.childCall', { id: lid, child: kid, method: 'session.approve', params: { requestId: req.requestId, decision: 'allow' } }), 'bad_request');
  assert.deepEqual(await pc.request('session.childApprove', { id: lid, child: kid, requestId: req.requestId, decision: 'deny' }), { ok: true });
  await until(async () => !(await pc.request('session.children', { id: lid })).children.find((k) => k.id === kid)?.pending.length);
  // 리더가 닫기를 청하지 않고 팀원이 끝나면 리더가 kind=closed 를 받는다
  const kc = await connectSession(sockOf(dir, kid));
  await kc.request('session.close', { id: kid });
  kc.close();
  await until(() => mailTurns(dir, lid, 'closed').length);
});

test('team new (기본 link): 첫 지시 뒤에는 메시지로만 — 잠기지 않고 자동 보고도 없다. leader·이름으로 주고받고, 리더가 닫혀도 산다', async (t) => {
  const { dir, work, psock, lid } = await start(t);
  // 지시는 stdin(heredoc)으로도
  const made = await cli(dir, lid, ['team', 'new', '-n', 'w1'], {}, 'no-call', work);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  assert.deepEqual(meta(dir, kid).team, TEAM_TEMPLATES.teammate);
  assert.equal(meta(dir, kid).noTeam, undefined, 'link 팀원은 팀원을 만들 수 있다');
  assert.equal(meta(dir, kid).cwd, work, '폴더를 빼면 지금 폴더');
  await until(() => turnEnds(dir, kid) >= 1);
  assert.ok(log(dir, kid).some((e) => e.ev.kind === 'turn.start' && e.ev.text === 'no-call'), 'stdin 의 지시가 첫 턴');
  await sleep(500);
  assert.equal(mailTurns(dir, lid, 'result').length, 0, '자동 보고는 없다');

  const c = await connectSession(sockOf(dir, kid));
  t.after(() => c.close());
  assert.equal((await c.request('session.attach', { id: kid, since: Number.MAX_SAFE_INTEGER })).info.locked, false, '화면이 지시한다');
  assert.equal((await c.request('server.info')).owner, meta(dir, lid).pid, '리더 core 가 소유한다(관계)');

  // 팀원 → 리더: leader 로
  const up = await cli(dir, kid, ['mail', 'leader', 'hello leader'], { SLCODE_PARENT_ID: lid });
  assert.equal(up.code, 0, up.err);
  await until(() => log(dir, lid).some((e) => e.ev.kind === 'turn.start' && e.ev.origin === 'mail' && e.ev.text.includes('hello leader')));
  // 리더 → 팀원: 이름으로. 팀 밖에 같은 이름의 켜진 세션이 있어도 자기 팀의 것
  const dup = await cli(dir, lid, ['team', 'new', work, '-d', '-n', 'w1', '--', 'no-call']); // detached 는 팀이 아니다
  assert.equal(dup.code, 0, dup.err);
  const down = await cli(dir, lid, ['mail', 'w1', 'hello w1']);
  assert.equal(down.code, 0, down.err);
  assert.equal(JSON.parse(down.out).to, kid);
  const amb = await cli(dir, undefined, ['mail', 'w1', 'who']);
  assert.notEqual(amb.code, 0, '팀 밖에서는 모호하다');

  // 리더가 닫혀도 산다 (수명 연동 꺼짐 — 소유자 없이)
  const pc = await connectSession(psock);
  await pc.request('session.close', { id: lid });
  pc.close();
  await sleep(2500); // 소유자 유예(1초)보다 길게
  assert.ok(await sockAlive(sockOf(dir, kid)), '팀원은 살아 있다');
  await c.request('session.close', { id: kid });
});

test('detached·-o 옵션: detached 는 리더 기록이 없는 세션이고, link 없이 리더 옵션은 거절, 모르는 키도 거절. 설정의 "새 세션 팀원" 을 끄고 연 세션은 팀원을 만들지 못한다', async (t) => {
  const { dir, work, lid } = await start(t);
  const made = await cli(dir, lid, ['team', 'new', work, '--detached', '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  assert.equal(meta(dir, kid).parent, undefined);
  assert.deepEqual(meta(dir, kid).team, TEAM_TEMPLATES.detached);
  // 리더 core 가 죽어도 산다
  process.kill(meta(dir, lid).pid!, 'SIGKILL');
  await sleep(2500);
  assert.ok(await sockAlive(sockOf(dir, kid)), 'detached 팀원은 살아 있다');
  const kc = await connectSession(sockOf(dir, kid));
  await kc.request('session.close', { id: kid });
  kc.close();

  const s2 = await start(t);
  const bad = await cli(s2.dir, s2.lid, ['team', 'new', work, '-d', '-o', '{"endWithLeader":true}', '--', 'no-call']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /endWithLeader needs link/);
  const unknown = await cli(s2.dir, s2.lid, ['team', 'new', work, '-o', '{"foo":true}', '--', 'no-call']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /unknown team option foo/);
  const two = await cli(s2.dir, s2.lid, ['team', 'new', work, '-s', '-t']);
  assert.equal(two.code, 2);
  const outside = await cli(s2.dir, undefined, ['team', 'new', work]);
  assert.equal(outside.code, 2, '세션 밖에서는 쓰지 못한다');
  // -o 로 템플릿을 고친다: subagent 인데 리더가 닫혀도 산다
  const mixed = await cli(s2.dir, s2.lid, ['team', 'new', work, '-s', '-o', '{"endWithLeader":false}', '--', 'no-call']);
  assert.equal(mixed.code, 0, mixed.err);
  assert.equal(meta(s2.dir, mixed.out.trim()).team!.endWithLeader, false);

  const dir3 = tmp('slcode-team-');
  fs.writeFileSync(path.join(dir3, 'settings-web.json'), JSON.stringify({ team: false }));
  const p3 = leader(dir3, work, {}, []);
  t.after(() => { if (p3.child.exitCode === null) p3.child.kill('SIGKILL'); });
  const s3 = await p3.sock;
  const [m3] = EventLog.list(corePaths(dir3).sessionsDir);
  assert.equal(m3.noTeam, true);
  const c3 = await connectSession(s3);
  t.after(() => c3.close());
  await expectCode(c3.request('session.spawnChild', { id: m3.id, cwd: work }), 'team_disabled');
});

test('리더 core 가 죽으면 subagent 팀원은 소유자 유예 뒤 닫히고, 리더 core 가 교체되면 새 리더 core 가 켜진 팀원을 다시 소유한다', async (t) => {
  const a = await start(t);
  const made = await cli(a.dir, a.lid, ['team', 'new', a.work, '-s', '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  await until(() => sockAlive(sockOf(a.dir, kid)));
  process.kill(meta(a.dir, a.lid).pid!, 'SIGKILL');
  assert.ok(await until(async () => !(await sockAlive(sockOf(a.dir, kid)))), '팀원이 닫혔다');

  const { dir, work, psock, lid } = await start(t);
  const m2 = await cli(dir, lid, ['team', 'new', work, '-s', '--', 'no-call']);
  assert.equal(m2.code, 0, m2.err);
  const kid2 = m2.out.trim();
  await until(() => mailTurns(dir, lid, 'result').length);
  const oldPid = meta(dir, lid).pid;
  const rc = await connectSession(psock);
  t.after(() => rc.close());
  await rc.request('core.retire', { pkg: path.resolve(import.meta.dirname, '..') });
  await until(() => meta(dir, lid).pid !== oldPid, 20000);
  await sleep(2500); // 소유자 유예(1초)보다 길게
  assert.ok(await sockAlive(sockOf(dir, kid2)), '팀원은 살아 있다');
  const c = await connectSession(sockOf(dir, kid2));
  t.after(() => c.close());
  assert.equal((await c.request('server.info')).owner, meta(dir, lid).pid, '새 리더 core 가 소유한다');
  await expectCode(c.request('session.send', { id: kid2, text: 'hi' }), 'locked');
});

test('메시지: fast(기본)는 받는 세션이 턴 중이어도 바로 넣고, --lazy 는 idle 이 된 뒤에 넣는다', async (t) => {
  const { dir, psock, lid } = await start(t);
  const pc = await connectSession(psock);
  t.after(() => pc.close());
  // 가짜 codex 의 보통 턴은 명령 승인에서 멈춘다 — 그동안 턴 중이다
  await pc.request('session.send', { id: lid, text: 'touch it' });
  const pending = await until(async () => (await pc.request('session.attach', { id: lid, since: Number.MAX_SAFE_INTEGER })).pending[0]);
  const lazy = await cli(dir, undefined, ['mail', lid, 'later please', '--lazy']);
  assert.equal(lazy.code, 0, lazy.err);
  const fast = await cli(dir, undefined, ['mail', lid, 'right now']);
  assert.equal(fast.code, 0, fast.err);
  const has = (s: string) => log(dir, lid).some((e) => e.ev.kind === 'turn.start' && e.ev.origin === 'mail' && e.ev.text.includes(s));
  await until(() => has('right now'));
  assert.equal(has('later please'), false, 'lazy 는 아직');
  await pc.request('session.approve', { id: lid, requestId: pending.requestId, decision: 'allow' });
  await until(() => has('later please'));
  const starts = log(dir, lid).filter((e) => e.ev.kind === 'turn.start').map((e) => (e.ev as { text: string }).text);
  assert.ok(starts.findIndex((s) => s.includes('right now')) < starts.findIndex((s) => s.includes('later please')));
});
