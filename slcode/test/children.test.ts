// 팀원 세션 (ticket slcode-team-agent, 사용자 결정 2026-11-07~08) — 세션 안의 `slcode team new` 로 리더 core 가 팀원 core 를 띄운다.
// 관여 옵션(관계 프리셋 subagent·teammate·detached + -o JSON)에 따라 잠김·자동 보고·질문·수명이 갈린다. 메시지는 fast(기본)·lazy.
// 실제 cli.ts 를 자식 프로세스로 띄우고 벤더는 가짜 codex 를 쓴다 (dist 를 빌드한 뒤에 돈다 — core 는 dist/coreMain.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { connectSession, type RpcClient } from '../src/client.ts';
import { sockAlive } from '../src/live.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import { TEAM_PRESETS } from '../src/protocol.ts';
import { teamTools } from '../src/teamTools.ts';

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
/** 테스트 폴더의 켜진 세션을 모두 닫는다 — 수명 연동이 꺼진 팀원(teammate·detached)은 리더가 닫혀도 소유자 없이 살아 남는다 */
async function closeAll(dir: string) {
  for (const m of EventLog.list(corePaths(dir).sessionsDir)) {
    const sock = new EventLog(corePaths(dir).sessionsDir, m).sockPath;
    if (!(await sockAlive(sock))) continue;
    try { const c = await connectSession(sock); await c.request('session.close', { id: m.id }).catch(() => {}); c.close(); } catch {}
  }
}
async function start(t: { after: (f: () => void | Promise<void>) => void }, extra: Record<string, string | undefined> = {}, args: string[] = []) {
  const dir = tmp('slcode-team-'), work = tmp('slcode-work-');
  const p = leader(dir, work, extra, args);
  t.after(async () => { if (p.child.exitCode === null) p.child.kill('SIGKILL'); await closeAll(dir); });
  const psock = await p.sock;
  const [pm] = EventLog.list(corePaths(dir).sessionsDir);
  return { dir, work, psock, lid: pm.id };
}

test('team new --subagent (답하면 닫힘 끔): 리더가 입력을 쥐고, 턴이 끝나면 마지막 답이 리더에 간다. 끊기는 일방향이고, 리더가 닫히면 같이 닫힌다', async (t) => {
  const { dir, work, psock, lid } = await start(t);

  // 모델이 친 slcode team new — id 를 출력하고 바로 끝난다. 폴더를 빼면 지금 폴더
  const made = await cli(dir, lid, ['team', 'new', '--cwd', work, '--subagent', '-o', '{"endWithAnswer":false}', '-n', 'sub1', '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  assert.match(kid, /^[0-9a-f]{8}$/);
  assert.deepEqual(meta(dir, kid).parent, { id: lid, kind: 'child' });
  assert.deepEqual(meta(dir, kid).team, { ...TEAM_PRESETS.subagent, endWithAnswer: false });
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
  const grand = await cli(dir, kid, ['team', 'new', '--cwd', work, '--', 'no-call']);
  assert.notEqual(grand.code, 0);
  assert.match(grand.err, /cannot start teammates/);

  // 끊기 — 화면이 지시하고, 리더의 지시는 거절되고, 리더는 알림을 한 번 받는다. 되돌리는 메서드는 없다
  await c.request('session.unlock', { id: kid });
  assert.deepEqual(meta(dir, kid).team, { ...TEAM_PRESETS.subagent, inputControl: false, outputToLeader: false, askToLeader: false, endWithAnswer: false, cut: true });
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

test('subagent 는 Claude 서브에이전트처럼: --wait 면 답이 메시지 대신 명령 출력으로 오고, 답하면 닫히고, 다시 시키면 다시 뜬다. 기다리던 명령이 끊기면 답은 메시지로 간다', async (t) => {
  const { dir, work, psock, lid } = await start(t);
  const closedMails = () => mailTurns(dir, lid, 'closed').length;

  // --wait — 첫 지시의 답을 출력한다. id 는 stderr 로
  const made = await cli(dir, lid, ['team', 'new', '--cwd', work, '-s', '--wait', '-n', 'sub1', '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  assert.equal(made.out.trim(), 'done');
  const kid = /teammate ([0-9a-f]{8}) started/.exec(made.err)![1];
  assert.deepEqual(meta(dir, kid).team, TEAM_PRESETS.subagent);
  assert.ok(await until(async () => !(await sockAlive(sockOf(dir, kid)))), '답하고 닫혔다');
  await sleep(500);
  assert.equal(mailTurns(dir, lid, 'result').length, 0, '기다린 답은 메시지로 오지 않는다');
  assert.equal(closedMails(), 0, '답하고 닫힌 것은 끝남 알림이 없다');

  // 다시 시키면 다시 뜬다 — 같은 세션(맥락 유지), 답을 출력하고 다시 닫힌다
  const again = await cli(dir, lid, ['prompt', kid, '--wait', '--', 'no-call']);
  assert.equal(again.code, 0, again.err);
  assert.equal(again.out.trim(), 'done');
  assert.equal(log(dir, kid).filter((e) => e.ev.kind === 'turn.start').length, 2, '같은 세션의 두 번째 턴');
  // 답을 받자마자(팀원이 닫히는 중에) 다시 시켜도 — 다 닫힌 뒤 다시 띄워 보낸다
  const quick = await cli(dir, lid, ['prompt', kid, '--wait', '--', 'no-call']);
  assert.equal(quick.code, 0, quick.err);
  assert.equal(quick.out.trim(), 'done');
  assert.equal(log(dir, kid).filter((e) => e.ev.kind === 'turn.start').length, 3);
  assert.ok(await until(async () => !(await sockAlive(sockOf(dir, kid)))), '다시 닫혔다');

  // --wait 없이 — 답은 메시지로 오고 닫힌다
  const bg = await cli(dir, lid, ['team', 'new', '--cwd', work, '-s', '--', 'no-call']);
  assert.equal(bg.code, 0, bg.err);
  const kid2 = bg.out.trim();
  await until(() => mailTurns(dir, lid, 'result').length === 1);
  assert.ok(await until(async () => !(await sockAlive(sockOf(dir, kid2)))));

  // 기다리던 명령이 끊기면 그 답은 메시지로 — 가짜 codex 의 보통 턴은 명령 승인에서 멈춘다
  const pc = await connectSession(psock);
  t.after(() => pc.close());
  const waiting = spawn(process.execPath, ['--import', TSX, CLI, 'team', 'new', '--cwd', work, '-s', '--wait', '--', 'touch it'], { env: baseEnv(dir, { SLCODE_SESSION_ID: lid }), stdio: ['ignore', 'ignore', 'pipe'] });
  let werr = '';
  waiting.stderr!.setEncoding('utf8').on('data', (d: string) => { werr += d; });
  const kid3 = (await until(() => /teammate ([0-9a-f]{8}) started/.exec(werr)))[1];
  const req = (await until(async () => (await pc.request('session.children', { id: lid })).children.find((k) => k.id === kid3 && k.pending.length))).pending[0];
  waiting.kill('SIGKILL');
  await sleep(300);
  await pc.request('session.childApprove', { id: lid, child: kid3, requestId: req.requestId, decision: 'deny' });
  await until(() => mailTurns(dir, lid, 'result').length === 2);
  assert.match((mailTurns(dir, lid, 'result')[1].ev as { text: string }).text, new RegExp(`from="${kid3}"`));
  assert.equal(closedMails(), 0);

  // 턴 중인 팀원에게 기다리며 시키면 — 지시는 큐에서 기다리고, 지금 턴의 답이 아니라 그 지시가 연 턴의 답을 받는다
  const busy = await cli(dir, lid, ['team', 'new', '--cwd', work, '-s', '--', 'touch it']);
  const kid4 = busy.out.trim();
  const req4 = (await until(async () => (await pc.request('session.children', { id: lid })).children.find((k) => k.id === kid4 && k.pending.length))).pending[0];
  const next = cli(dir, lid, ['prompt', kid4, '--wait', '--', 'no-call']);
  await sleep(500); // 지시가 팀원의 큐에 들어갈 때까지
  await pc.request('session.childApprove', { id: lid, child: kid4, requestId: req4.requestId, decision: 'deny' });
  const got = await next;
  assert.equal(got.code, 0, got.err);
  assert.equal(got.out.trim(), 'done', '지금 턴(touch it)의 답이 아니라 기다린 지시의 답');
  await until(() => mailTurns(dir, lid, 'result').length === 3); // 앞 턴의 답은 메시지로
  assert.match((mailTurns(dir, lid, 'result')[2].ev as { text: string }).text, new RegExp(`from="${kid4}"[^>]*>\\ndecision=decline`));
  assert.ok(await until(async () => !(await sockAlive(sockOf(dir, kid4)))), '큐가 빈 뒤에 닫혔다');

  // --wait 는 답을 받는 팀원만
  const noWait = await cli(dir, lid, ['team', 'new', '--cwd', work, '-t', '--wait', '--', 'no-call']);
  assert.equal(noWait.code, 2);
});

test('MCP 도구 Subagent·ContinueSubagent 는 CLI 를 불러 답을 도구 결과로 돌려준다 (백그라운드면 id 만)', async (t) => {
  const { dir, work, lid } = await start(t);
  const [sub, cont] = teamTools({ cli: path.resolve(import.meta.dirname, '..', 'dist', 'cli.js'), env: baseEnv(dir, { SLCODE_SESSION_ID: lid }) as NodeJS.ProcessEnv, cwd: work });
  const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('');
  const r = await sub.handler({ description: 'count files', prompt: 'no-call' }, {});
  assert.equal(r.isError, undefined, textOf(r));
  const id = /subagent ([0-9a-f]{8}) finished and closed/.exec(textOf(r))![1];
  assert.match(textOf(r), /^done\n/);
  assert.equal(meta(dir, id).title, 'count files');
  assert.equal(meta(dir, id).cwd, work);
  await until(async () => !(await sockAlive(sockOf(dir, id))));
  const r2 = await cont.handler({ to: id, prompt: 'no-call' }, {});
  assert.match(textOf(r2), /^done\n/);
  const r3 = await sub.handler({ description: 'in background', prompt: 'no-call', run_in_background: true }, {});
  assert.match(textOf(r3), /started in the background/);
  await until(() => mailTurns(dir, lid, 'result').length === 1);
  const bad = await cont.handler({ to: 'nope', prompt: 'no-call' }, {});
  assert.equal(bad.isError, true);
  // agent 는 --agent 로 (정의의 relation 보다 Subagent 의 --subagent 가 이긴다)
  fs.mkdirSync(path.join(work, '.slcode', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(work, '.slcode', 'agents', 'counter.md'), '---\nrelation: detached\n---\nCount things.\n');
  const r4 = await sub.handler({ description: 'with agent', prompt: 'no-call', agent: 'counter' }, {});
  const rid = /subagent ([0-9a-f]{8}) finished and closed/.exec(textOf(r4))![1];
  assert.deepEqual(meta(dir, rid).agent, { name: 'counter', instructions: 'Count things.' });
  assert.equal(meta(dir, rid).team!.inputControl, true);
});

test('subagent 팀원의 도구 승인은 리더 화면(session.children·childApprove)에서 사람이 답하고, 리더 모델(childCall)은 답하지 못한다', async (t) => {
  const { dir, work, psock, lid } = await start(t);
  const pc: RpcClient = await connectSession(psock);
  t.after(() => pc.close());
  await pc.request('session.attach', { id: lid, since: Number.MAX_SAFE_INTEGER });
  const events: string[] = [];
  pc.onEvent((m) => { if (m.event === 'session.children') events.push(JSON.stringify(m.params)); });

  // 가짜 codex 는 보통 턴에서 명령 승인을 묻는다
  const made = await cli(dir, lid, ['team', 'new', '--cwd', work, '-s', '-o', '{"endWithAnswer":false}', '--', 'touch it']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  const view = await until(async () => (await pc.request('session.children', { id: lid })).children.find((k) => k.id === kid && k.pending.length));
  const req = view.pending[0];
  assert.ok(events.length, 'session.children 방송');
  await expectCode(pc.request('session.childCall', { id: lid, child: kid, method: 'session.approve', params: { requestId: req.requestId, decision: 'allow' } }), 'bad_request');
  assert.notEqual(view.state, 'idle', '승인을 기다리는 팀원은 실행 중으로 센다 (리더 입력창 위 줄)');
  assert.deepEqual(await pc.request('session.childApprove', { id: lid, child: kid, requestId: req.requestId, decision: 'deny' }), { ok: true });
  await until(async () => !(await pc.request('session.children', { id: lid })).children.find((k) => k.id === kid)?.pending.length);
  // 턴이 끝나면 state 가 idle 로 바뀌고 방송된다
  await until(() => events.some((e) => { const p = JSON.parse(e); return p.children.some((k: { id: string; state: string }) => k.id === kid && k.state === 'idle'); }));
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
  assert.deepEqual(meta(dir, kid).team, TEAM_PRESETS.teammate);
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
  const dup = await cli(dir, lid, ['team', 'new', '--cwd', work, '-d', '-n', 'w1', '--', 'no-call']); // detached 는 팀이 아니다
  assert.equal(dup.code, 0, dup.err);
  const down = await cli(dir, lid, ['mail', 'w1', 'hello w1']);
  assert.equal(down.code, 0, down.err);
  assert.equal(JSON.parse(down.out).to, kid);
  const amb = await cli(dir, undefined, ['mail', 'w1', 'who']);
  assert.notEqual(amb.code, 0, '팀 밖에서는 모호하다');

  // 끝남 알림 — teammate 는 기본 꺼짐, -o notifyEnd 면 리더가 kind=closed 를 받는다. link 없이는 켤 수 없다 (ticket slcode-team-plugin-verb)
  const noLink = await cli(dir, lid, ['team', 'new', '--cwd', work, '-d', '-o', '{"notifyEnd":true}', '--', 'no-call']);
  assert.equal(noLink.code, 1);
  assert.match(noLink.err, /notifyEnd needs link/);
  const ids: string[] = [];
  for (const o of ['{}', '{"notifyEnd":true}']) {
    const r = await cli(dir, lid, ['team', 'new', '--cwd', work, '-o', o, '--', 'no-call']);
    assert.equal(r.code, 0, r.err);
    ids.push(r.out.trim());
  }
  const [quiet, loud] = ids;
  assert.deepEqual([meta(dir, quiet).team!.notifyEnd, meta(dir, loud).team!.notifyEnd], [false, true]);
  for (const k of ids) {
    const kc = await connectSession(sockOf(dir, k));
    await kc.request('session.close', { id: k }).catch(() => {});
    kc.close();
    await until(async () => !(await sockAlive(sockOf(dir, k))));
  }
  const closedText = (await until(() => mailTurns(dir, lid, 'closed').map((e) => (e.ev.kind === 'turn.start' ? e.ev.text : '')).join('\n') || undefined))!;
  assert.match(closedText, new RegExp(`Teammate ${loud} ended`));
  assert.doesNotMatch(closedText, new RegExp(`Teammate ${quiet} ended`), '기본 teammate 는 알리지 않는다');

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
  const made = await cli(dir, lid, ['team', 'new', '--cwd', work, '--detached', '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  assert.equal(meta(dir, kid).parent, undefined);
  assert.deepEqual(meta(dir, kid).team, TEAM_PRESETS.detached);
  // 리더 core 가 죽어도 산다
  process.kill(meta(dir, lid).pid!, 'SIGKILL');
  await sleep(2500);
  assert.ok(await sockAlive(sockOf(dir, kid)), 'detached 팀원은 살아 있다');
  const kc = await connectSession(sockOf(dir, kid));
  await kc.request('session.close', { id: kid });
  kc.close();

  const s2 = await start(t);
  const bad = await cli(s2.dir, s2.lid, ['team', 'new', '--cwd', work, '-d', '-o', '{"endWithLeader":true}', '--', 'no-call']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /endWithLeader needs link/);
  const unknown = await cli(s2.dir, s2.lid, ['team', 'new', '--cwd', work, '-o', '{"foo":true}', '--', 'no-call']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.err, /unknown team option foo/);
  const two = await cli(s2.dir, s2.lid, ['team', 'new', '--cwd', work, '-s', '-t']);
  assert.equal(two.code, 2);
  const outside = await cli(s2.dir, undefined, ['team', 'new', '--cwd', work]);
  assert.equal(outside.code, 2, '세션 밖에서는 쓰지 못한다');
  // -o 로 프리셋을 고친다: subagent 인데 리더가 닫혀도 산다
  const mixed = await cli(s2.dir, s2.lid, ['team', 'new', '--cwd', work, '-s', '-o', '{"endWithLeader":false}', '--', 'no-call']);
  assert.equal(mixed.code, 0, mixed.err);
  assert.equal(meta(s2.dir, mixed.out.trim()).team!.endWithLeader, false);
  assert.equal(meta(s2.dir, mixed.out.trim()).team!.cleanWithLeader, false, '프리셋의 리더 닫힘 정리는 수명 연동을 끄면 같이 꺼진다');
  const cleanAlone = await cli(s2.dir, s2.lid, ['team', 'new', '--cwd', work, '-t', '-o', '{"cleanWithLeader":true}', '--', 'no-call']);
  assert.equal(cleanAlone.code, 1);
  assert.match(cleanAlone.err, /cleanWithLeader needs endWithLeader/);

  const dir3 = tmp('slcode-team-');
  fs.writeFileSync(path.join(dir3, 'settings-web.json'), JSON.stringify({ team: false }));
  const p3 = leader(dir3, work, {}, []);
  t.after(async () => { if (p3.child.exitCode === null) p3.child.kill('SIGKILL'); await closeAll(dir3); });
  const s3 = await p3.sock;
  const [m3] = EventLog.list(corePaths(dir3).sessionsDir);
  assert.equal(m3.noTeam, true);
  const c3 = await connectSession(s3);
  t.after(() => c3.close());
  await expectCode(c3.request('session.spawnChild', { id: m3.id, cwd: work }), 'team_disabled');
});

test('리더 core 가 죽으면 subagent 팀원은 소유자 유예 뒤 닫히고, 리더 core 가 교체되면 새 리더 core 가 켜진 팀원을 다시 소유한다', async (t) => {
  const a = await start(t);
  const made = await cli(a.dir, a.lid, ['team', 'new', '--cwd', a.work, '-s', '-o', '{"endWithAnswer":false}', '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  await until(() => sockAlive(sockOf(a.dir, kid)));
  process.kill(meta(a.dir, a.lid).pid!, 'SIGKILL');
  assert.ok(await until(async () => !(await sockAlive(sockOf(a.dir, kid)))), '팀원이 닫혔다');

  const { dir, work, psock, lid } = await start(t);
  const m2 = await cli(dir, lid, ['team', 'new', '--cwd', work, '-s', '-o', '{"endWithAnswer":false}', '--', 'no-call']);
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

test('에이전트 정의: --agent 는 .slcode/agents(리더 폴더에서 위로)·상태 폴더 agents 의 Markdown 파일 — 본문은 팀원 지시문, frontmatter 는 주지 않은 옵션의 기본값. 리더 지시문에 목록이 실린다', async (t) => {
  const calls = path.join(tmp('slcode-calls-'), 'calls.jsonl');
  const dir = tmp('slcode-team-'), root = tmp('slcode-work-'), work = path.join(root, 'sub');
  fs.mkdirSync(path.join(root, '.slcode', 'agents'), { recursive: true });
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(dir, 'agents'));
  fs.writeFileSync(path.join(root, '.slcode', 'agents', 'reviewer.md'), '---\ndescription: Reviews code and reports problems\nrelation: subagent\nmode: auto\nmodel: gpt-agent\n---\nFind bugs only. Do not edit files.\n');
  fs.writeFileSync(path.join(dir, 'agents', 'reviewer.md'), '---\ndescription: shadowed\n---\nshadowed\n');
  fs.writeFileSync(path.join(dir, 'agents', 'tester.md'), '---\ndescription: Runs the tests\n---\nRun the tests.\n');
  fs.writeFileSync(path.join(dir, 'agents', 'broken.md'), '---\nrelation: boss\n---\nx\n');
  const p = leader(dir, work, { FAKE_CODEX_CALLS: calls });
  t.after(async () => { if (p.child.exitCode === null) p.child.kill('SIGKILL'); await closeAll(dir); });
  await p.sock;
  const [pm] = EventLog.list(corePaths(dir).sessionsDir);
  const lid = pm.id;
  const instr = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).developerInstructions as string | null).filter(Boolean) as string[];
  const lead = await until(() => instr()[0]);
  assert.match(lead, /--agent <name>/);
  assert.match(lead, /^- reviewer: Reviews code and reports problems$/m, '가까운 프로젝트 정의가 이긴다');
  assert.match(lead, /^- tester: Runs the tests$/m);
  assert.doesNotMatch(lead, /shadowed/);

  const made = await cli(dir, lid, ['team', 'new', '--cwd', work, '--agent', 'reviewer', '-o', '{"endWithAnswer":false}', '--', 'no-call']);
  assert.equal(made.code, 0, made.err);
  const kid = made.out.trim();
  const km = meta(dir, kid);
  assert.deepEqual(km.agent, { name: 'reviewer', instructions: 'Find bugs only. Do not edit files.' });
  assert.equal(km.team!.inputControl, true, '정의의 relation subagent');
  assert.equal(km.permissionMode, 'auto', '정의의 mode');
  assert.equal(km.model, 'gpt-agent', '정의의 model');
  const kidInstr = await until(() => instr().find((s) => s.includes('# slcode agent: reviewer')));
  assert.match(kidInstr, /# slcode agent: reviewer\nFind bugs only\. Do not edit files\./);
  assert.match(kidInstr, /# slcode teammate/);

  // 준 옵션이 정의의 값을 이긴다
  const own = await cli(dir, lid, ['team', 'new', '--cwd', work, '--agent', 'reviewer', '-t', '-m', 'gpt-mine', '--mode', 'default', '--', 'no-call']);
  assert.equal(own.code, 0, own.err);
  const om = meta(dir, own.out.trim());
  assert.equal(om.team!.inputControl, false);
  assert.equal(om.model, 'gpt-mine');
  assert.equal(om.permissionMode, 'default');

  const none = await cli(dir, lid, ['team', 'new', '--cwd', work, '--agent', 'nobody']);
  assert.equal(none.code, 2);
  assert.match(none.err, /no agent 'nobody' \(broken\|reviewer\|tester\)/);
  const broken = await cli(dir, lid, ['team', 'new', '--cwd', work, '--agent', 'broken']);
  assert.equal(broken.code, 2);
  assert.match(broken.err, /relation must be subagent\|teammate\|detached/);
});

// ---- worktree 팀원 (ticket slcode-team-worktree, 사용자 결정 2026-11-11)
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, encoding: 'utf8' }).trim();
/** 시험용 repo — 추적하는 README·.gitignore·.worktreeinclude 를 커밋하고, 추적하지 않는 파일 셋을 둔다 */
function repo(work: string) {
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'README.md'), 'hi\n');
  fs.writeFileSync(path.join(work, '.gitignore'), '.env\nnode_modules/\n');
  fs.writeFileSync(path.join(work, '.worktreeinclude'), '.env\nnotes.txt\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(work, '.env'), 'SECRET=1\n'); // gitignore 되고 .worktreeinclude 에 있다 — 복사한다
  fs.writeFileSync(path.join(work, 'notes.txt'), 'x\n'); // .worktreeinclude 에 있지만 gitignore 되지 않았다 — 복사하지 않는다
  fs.mkdirSync(path.join(work, 'node_modules'));
  fs.writeFileSync(path.join(work, 'node_modules', 'm.js'), ''); // gitignore 됐지만 .worktreeinclude 에 없다
}
const hasBranch = (work: string, b: string) => { try { git(work, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`); return true; } catch { return false; } };

test('worktree: team new --worktree [이름] 은 리더 HEAD 에서 <이름> 브랜치를 <repo>.worktrees/<이름의 / 를 -> 에 만들고 부모 브랜치를 slcodeparent 에 적는다. clean-worktree 는 잃을 작업(squash 는 반영으로 본다)이 있으면 키 없이 거절하고, --self 는 자기 세션을 닫지 않는다', async (t) => {
  const calls = path.join(tmp('slcode-calls-'), 'calls.jsonl');
  const { dir, work, lid } = await start(t, { FAKE_CODEX_CALLS: calls });
  repo(work);
  t.after(() => fs.rmSync(`${work}.worktrees`, { recursive: true, force: true }));
  const head = git(work, 'rev-parse', 'HEAD');

  const both = await cli(dir, lid, ['team', 'new', '--cwd', work, '--worktree', 'x', '--', 'no-call'], {}, undefined, work);
  assert.equal(both.code, 2);
  assert.match(both.err, /--cwd or --worktree, not both/);
  const positional = await cli(dir, lid, ['team', 'new', work, '--', 'no-call'], {}, undefined, work);
  assert.equal(positional.code, 2);
  assert.match(positional.err, /use --cwd <folder>/);
  const outside = await cli(dir, lid, ['team', 'new', '--worktree', 'x', '-t', '--', 'no-call'], {}, undefined, tmp('slcode-nogit-'));
  assert.equal(outside.code, 1);
  assert.match(outside.err, /not a git repository/);

  const a = await cli(dir, lid, ['team', 'new', '--worktree', 'feat-a', '-t', '-n', 'alpha', '--', 'no-call'], {}, undefined, work);
  assert.equal(a.code, 0, a.err);
  const aid = a.out.trim();
  const wa = path.join(`${work}.worktrees`, 'feat-a');
  assert.match(a.err, new RegExp(`started in ${wa} on branch feat-a`));
  assert.deepEqual(meta(dir, aid).worktree, { name: 'feat-a', branch: 'feat-a', path: wa, repo: work, from: work, base: head });
  assert.equal(meta(dir, aid).cwd, wa);
  assert.equal(git(wa, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat-a');
  assert.equal(git(work, 'config', 'branch.feat-a.slcodeparent'), 'main', '가른 브랜치는 git config 에');
  assert.equal(fs.readFileSync(path.join(`${work}.worktrees`, '.gitignore'), 'utf8'), '*\n');
  assert.equal(fs.readFileSync(path.join(wa, '.env'), 'utf8'), 'SECRET=1\n', '.worktreeinclude 에 맞고 gitignore 된 파일은 복사한다');
  assert.equal(fs.existsSync(path.join(wa, 'notes.txt')), false, 'gitignore 되지 않은 파일은 복사하지 않는다');
  assert.equal(fs.existsSync(path.join(wa, 'node_modules')), false, '.worktreeinclude 에 없는 파일은 복사하지 않는다');
  // 지시문 — 팀원은 자기 worktree·브랜치를, 리더는 만드는 법과 정리하는 법을 안다
  const instr = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).developerInstructions as string | null).filter(Boolean) as string[];
  const kidInstr = await until(() => instr().find((s) => s.includes('# slcode worktree')));
  assert.match(kidInstr, new RegExp(`git worktree of your own: ${wa}, on branch feat-a, made from commit ${head.slice(0, 12)} of ${work} \\(branch main\\)`));
  assert.match(kidInstr, /slcode team clean-worktree --self/);
  assert.doesNotMatch(kidInstr, /merges the branch|do not merge/, '누가 합치는지는 지시하지 않는다');
  assert.match(instr()[0], /--worktree \[name\]/);
  assert.match(instr()[0], /slcode team clean-worktree <name or id>/);
  assert.doesNotMatch(instr()[0], /merge the branch/);

  const again = await cli(dir, lid, ['team', 'new', '--worktree', 'feat-a', '-t', '--', 'no-call'], {}, undefined, work);
  assert.equal(again.code, 1);
  assert.match(again.err, /worktree feat-a already exists/);
  // 이름을 빼면 -n 이름에서 짓고, 겹치면 -2. 값 없는 --worktree 가 끝에 와도 된다
  const b = await cli(dir, lid, ['team', 'new', '-t', '-n', 'Beta Task', '--worktree', '--', 'no-call'], {}, undefined, work);
  assert.equal(b.code, 0, b.err);
  const bid = b.out.trim();
  assert.equal(meta(dir, bid).worktree!.name, 'beta-task');
  const b2 = await cli(dir, lid, ['team', 'new', '-t', '-n', 'Beta Task', '--worktree', '--', 'no-call'], {}, undefined, work);
  assert.equal(meta(dir, b2.out.trim()).worktree!.name, 'beta-task-2');
  // 브랜치는 이름 그대로 — / 는 폴더에서만 - 로. 브랜치로 못 쓰는 이름은 거절
  const slash = await cli(dir, lid, ['team', 'new', '--worktree', 'feat/login', '-t', '--', 'no-call'], {}, undefined, work);
  assert.equal(slash.code, 0, slash.err);
  assert.deepEqual([meta(dir, slash.out.trim()).worktree!.branch, meta(dir, slash.out.trim()).worktree!.path], ['feat/login', path.join(`${work}.worktrees`, 'feat-login')]);
  const bad = await cli(dir, lid, ['team', 'new', '--worktree', 'a..b', '-t', '--', 'no-call'], {}, undefined, work);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /valid git branch name/);
  // 리더가 worktree 안에 있어도 원래 repo 옆에, 그 worktree 의 HEAD 에서
  fs.writeFileSync(path.join(wa, 'a.txt'), 'a\n');
  git(wa, 'add', 'a.txt'); git(wa, 'commit', '-q', '-m', 'a');
  const nested = await cli(dir, lid, ['team', 'new', '--worktree', 'nested', '-t', '--', 'no-call'], {}, undefined, wa);
  assert.equal(nested.code, 0, nested.err);
  const nm = meta(dir, nested.out.trim()).worktree!;
  assert.equal(nm.path, path.join(`${work}.worktrees`, 'nested'));
  assert.equal(nm.base, git(wa, 'rev-parse', 'HEAD'));
  assert.equal(nm.from, wa);
  assert.equal(git(work, 'config', 'branch.nested.slcodeparent'), 'feat-a', 'worktree 안에서 가르면 그 브랜치가 부모');

  // clean-worktree — 커밋하지 않은 변경·부모 브랜치에 없는 커밋이 있으면 키 없이 거절한다. 거절할 때는 팀원을 닫지 않는다
  fs.writeFileSync(path.join(wa, 'b.txt'), 'b\n');
  const dirty = await cli(dir, lid, ['team', 'clean-worktree', aid]);
  assert.equal(dirty.code, 1);
  assert.match(dirty.err, /uncommitted changes.*commits on feat-a not in main/s);
  assert.match(dirty.err, new RegExp(`slcode team clean-worktree ${aid} --key [0-9a-f]{5}`));
  assert.equal(await sockAlive(sockOf(dir, aid)), true, '거절하면 팀원을 닫지 않는다');
  const force = await cli(dir, lid, ['team', 'clean-worktree', aid, '--force']);
  assert.equal(force.code, 2);
  assert.match(force.err, /takes no --force/);
  git(wa, 'add', 'b.txt'); git(wa, 'commit', '-q', '-m', 'b');
  const unmerged = await cli(dir, lid, ['team', 'clean-worktree', aid]);
  assert.equal(unmerged.code, 1);
  assert.match(unmerged.err, /commits on feat-a not in main/);
  assert.doesNotMatch(unmerged.err, /uncommitted/);
  // squash 로 합치면 반영된 것으로 본다 (wtree 넷째 시험) — 켜진 팀원은 닫고 지운다
  git(work, 'merge', '-q', '--squash', 'feat-a'); git(work, 'commit', '-q', '-m', 'squash feat-a');
  const cleaned = await cli(dir, lid, ['team', 'clean-worktree', aid]);
  assert.equal(cleaned.code, 0, cleaned.err);
  assert.equal(await sockAlive(sockOf(dir, aid)), false, '켜진 팀원은 먼저 닫는다');
  assert.equal(fs.existsSync(wa), false);
  assert.equal(hasBranch(work, 'feat-a'), false);
  assert.throws(() => git(work, 'config', 'branch.feat-a.slcodeparent'), '브랜치와 함께 부모 키도 지워진다');
  assert.ok(meta(dir, aid).worktree!.removedAt);
  assert.ok(EventLog.open(corePaths(dir).sessionsDir, aid), '세션 기록은 남는다');
  const twice = await cli(dir, lid, ['team', 'clean-worktree', aid]);
  assert.equal(twice.code, 0);
  assert.match(twice.err, /already removed/);
  // --self — 팀원이 자기 것을 닫지 않고 지운다. 키는 그사이 무엇이든 바뀌면 달라진다
  const wb = meta(dir, bid).worktree!.path;
  fs.writeFileSync(path.join(wb, 'c.txt'), 'c\n');
  const selfRefused = await cli(dir, bid, ['team', 'clean-worktree', '--self']);
  assert.equal(selfRefused.code, 1);
  const key = /--self --key ([0-9a-f]{5})/.exec(selfRefused.err)![1];
  fs.writeFileSync(path.join(wb, 'c.txt'), 'c2\n');
  const stale = await cli(dir, bid, ['team', 'clean-worktree', '--self', '--key', key]);
  assert.equal(stale.code, 1, '바뀐 뒤의 옛 키로는 지우지 않는다');
  const key2 = /--key ([0-9a-f]{5})/.exec(stale.err)![1];
  assert.notEqual(key2, key);
  const selfOk = await cli(dir, bid, ['team', 'clean-worktree', '--self', '--key', key2]);
  assert.equal(selfOk.code, 0, selfOk.err);
  assert.equal(fs.existsSync(wb), false);
  assert.equal(hasBranch(work, 'beta-task'), false);
  assert.equal(await sockAlive(sockOf(dir, bid)), true, '--self 는 자기 세션을 닫지 않는다');
  assert.ok(meta(dir, bid).worktree!.removedAt);
  const selfByName = await cli(dir, bid, ['team', 'clean-worktree', bid]);
  assert.equal(selfByName.code, 2);
  assert.match(selfByName.err, /use --self/);
  // slcode 가 만들지 않은 worktree 는 지우지 않는다
  const plain = await cli(dir, lid, ['team', 'clean-worktree', lid]);
  assert.equal(plain.code, 1);
  assert.match(plain.err, /has no worktree made by slcode team new --worktree/);
});

test('worktree subagent: Subagent 도구의 isolation "worktree" 는 이름 없는 --worktree, 결과에 브랜치와 정리법. 지운 worktree 의 subagent 는 다시 열지 않는다. 리더가 닫히면 잃을 것이 없는 worktree 만 지운다', async (t) => {
  const { dir, work, psock, lid } = await start(t);
  repo(work);
  t.after(() => fs.rmSync(`${work}.worktrees`, { recursive: true, force: true }));
  const [sub, cont] = teamTools({ cli: path.resolve(import.meta.dirname, '..', 'dist', 'cli.js'), env: baseEnv(dir, { SLCODE_SESSION_ID: lid }) as NodeJS.ProcessEnv, cwd: work });
  const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('');
  const idOf = (r: { content: { type: string; text?: string }[] }) => /subagent ([0-9a-f]{8}) finished and closed/.exec(textOf(r))![1];

  const bad = await sub.handler({ description: 'both', prompt: 'no-call', cwd: work, isolation: 'worktree' }, {});
  assert.equal(bad.isError, true);
  const r1 = await sub.handler({ description: 'clean one', prompt: 'no-call', isolation: 'worktree' }, {});
  assert.equal(r1.isError, undefined, textOf(r1));
  const id1 = idOf(r1), w1 = path.join(`${work}.worktrees`, 'clean-one');
  assert.match(textOf(r1), new RegExp(`git worktree ${w1} on branch clean-one; \`slcode team clean-worktree ${id1}\` removes them`));
  assert.equal(meta(dir, id1).team!.cleanWithLeader, true, 'subagent 프리셋은 리더 닫힘 정리가 켜져 있다');
  const id2 = idOf(await sub.handler({ description: 'dirty one', prompt: 'no-call', isolation: 'worktree' }, {}));
  const w2 = meta(dir, id2).worktree!.path;
  fs.writeFileSync(path.join(w2, 'wip.txt'), 'wip\n');
  const id3 = idOf(await sub.handler({ description: 'gone one', prompt: 'no-call', isolation: 'worktree' }, {}));
  const id4 = idOf(await sub.handler({ description: 'plain', prompt: 'no-call', cwd: work }, {}));
  assert.equal(meta(dir, id4).cwd, work);
  assert.equal(meta(dir, id4).worktree, undefined);

  await until(async () => !(await sockAlive(sockOf(dir, id3))));
  const rm = await cli(dir, lid, ['team', 'clean-worktree', id3]);
  assert.equal(rm.code, 0, rm.err);
  const again = await cont.handler({ to: id3, prompt: 'no-call' }, {});
  assert.equal(again.isError, true);
  assert.match(textOf(again), /the worktree of teammate .* was removed .* start a new teammate/);

  // 리더가 닫힌다 — 잃을 것이 없는 worktree 는 지우고, 커밋하지 않은 변경이 있는 것은 남긴다
  const c = await connectSession(psock);
  await c.request('session.close', { id: lid }).catch(() => {});
  c.close();
  await until(async () => !(await sockAlive(psock)));
  assert.equal(fs.existsSync(w1), false);
  assert.equal(hasBranch(work, 'clean-one'), false);
  assert.ok(meta(dir, id1).worktree!.removedAt);
  assert.equal(fs.existsSync(path.join(w2, 'wip.txt')), true, '잃을 작업이 있는 worktree 는 남는다');
  assert.equal(meta(dir, id2).worktree!.removedAt, undefined);
});
