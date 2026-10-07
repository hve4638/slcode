// CLI 동사 (ticket slcode-verbs) — 실제 cli.ts 를 자식 프로세스로 띄운다. 꺼진 세션은 로그를 지어내고, 살아 있는 세션은 new 로 하나 띄운다 (프롬프트는 안 보낸다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Out = { code: number; stdout: string; stderr: string };
function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Out> {
  return new Promise((resolve) => execFile(process.execPath, ['--import', 'tsx', CLI, ...args], { env: { ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION: undefined, ...env } }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
}
function start(dir: string, args: string[]): { child: ChildProcess; out: Promise<string>; line: (n: number) => Promise<string>; err: string[]; exit: Promise<number | null> } {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { env: { ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION: undefined }, stdio: ['pipe', 'pipe', 'pipe'] });
  const err: string[] = [];
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => err.push(d));
  const lines: string[] = []; let buf = '';
  child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  const line = async (n: number) => { const t0 = Date.now(); while (lines.length <= n && Date.now() - t0 < 15000) await sleep(50); if (lines.length <= n) throw new Error(`no stdout line ${n}`); return lines[n]; };
  const exit = new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
  return { child, get out() { return line(0); }, line, err, exit }; // out 은 게으르게 — attach 처럼 stdout 이 없는 자식에서 거부가 남지 않게
}
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 꺼진 세션 하나를 지어낸다 — 두 턴(둘째는 승인 포함) */
function fakeStored(dir: string, id: string, title: string | null, cwd = '/x') {
  const log = EventLog.create(corePaths(dir).sessionsDir, { id, vendor: 'claude', cwd, title, vendorSessionId: null, createdAt: 1, updatedAt: 9, permissionMode: 'acceptEdits', raw: false, model: 'm-1' });
  let seq = 0; const put = (ev: any) => log.append({ seq: ++seq, at: seq, ev });
  put({ kind: 'turn.start', text: 'first q', origin: null }); put({ kind: 'text.delta', text: 'first answer' }); put({ kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: 0.5, durationMs: 1, usage: null });
  put({ kind: 'turn.start', text: 'second q', origin: null }); put({ kind: 'approval.requested', requestId: 'rq1', toolUseId: null, name: 'Bash', input: { command: 'ls' }, suggestions: [] }); put({ kind: 'approval.resolved', requestId: 'rq1', decision: 'allow' });
  put({ kind: 'text.delta', text: 'second answer' }); put({ kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: 0.75, durationMs: 1, usage: null }); // 누계 꼴
  log.close();
}

test('--help 는 도움말(종료 0); 모르는 동사·없는 폴더·옛 동사는 오류', async () => {
  const dir = tmp('slcode-cli-');
  const h = await run(dir, ['--help']);
  assert.equal(h.code, 0); assert.match(h.stdout, /^usage: slcode \[옵션\] \| slcode <동사>/); assert.match(h.stdout, /respond <s> <req> allow\|deny/);
  assert.equal((await run(dir, ['bogus'])).code, 2);
  assert.equal((await run(dir, ['send', 'x', 'hi'])).code, 2, '옛 동사에 폴백 별칭 없음');
  assert.equal((await run(dir, ['shutdown'])).code, 2);
  assert.equal((await run(dir, ['post'])).code, 2, 'post 단독은 안 된다');
  const nf = await run(dir, ['new', '/nonexistent/folder']);
  assert.equal(nf.code, 2); assert.match(nf.stderr, /not a folder/);
  assert.equal((await run(dir, ['status', 'nope'])).code, 1);
  const c = await run(dir, ['check']); assert.equal(c.code, 2); assert.match(c.stderr, /inside a slcode session/);
});

test('꺼진 세션: status·pending·last --turn·log --tail 은 로그 파일에서, --json 은 같은 내용; respond 는 대기 목록과 함께 거절; 제목으로도 지목', async () => {
  const dir = tmp('slcode-cli-');
  fakeStored(dir, 'aaaa1111', 'alpha');
  const st = await run(dir, ['status', 'alpha']);
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /^id        aaaa1111 \(alpha\)\n/); assert.match(st.stdout, /state     exited  \(not live — slcode resume aaaa1111\)/);
  assert.match(st.stdout, /model     m-1\n/); assert.match(st.stdout, /mode      acceptEdits/); assert.match(st.stdout, /turns     2  cost \$0\.7500/); assert.match(st.stdout, /pending   0/);
  const sj = JSON.parse((await run(dir, ['status', 'aaaa1111', '--json'])).stdout);
  assert.equal(sj.live, false); assert.equal(sj.turns, 2); assert.equal(sj.costUsd, 0.75); assert.equal(sj.pending, 0); assert.equal(sj.model, 'm-1');
  const pd = await run(dir, ['pending', 'alpha']); assert.match(pd.stdout, /nothing pending — exited, not live/);
  assert.deepEqual(JSON.parse((await run(dir, ['pending', 'alpha', '--json'])).stdout), []);
  // last: 기본 마지막 턴, --turn N 은 N 턴 전
  const l0 = await run(dir, ['last', 'alpha']);
  assert.match(l0.stdout, /› second q\n/); assert.match(l0.stdout, /second answer/); assert.doesNotMatch(l0.stdout, /first/); assert.match(l0.stdout, /\? approval rq1 Bash/);
  const l1 = await run(dir, ['last', 'alpha', '--turn', '1']);
  assert.match(l1.stdout, /› first q\n/); assert.doesNotMatch(l1.stdout, /second/);
  const lj = JSON.parse((await run(dir, ['last', 'alpha', '--json'])).stdout);
  assert.deepEqual(lj.map((e: any) => e.seq), [4, 5, 6, 7, 8]);
  const l9 = await run(dir, ['last', 'alpha', '--turn', '5']); assert.equal(l9.code, 1); assert.match(l9.stderr, /no such turn \(2 turns\)/);
  // log: 전부 / --since / --tail / --json 은 원문 한 줄씩
  const lg = await run(dir, ['log', 'alpha']); assert.match(lg.stdout, /› first q[\s\S]*› second q/);
  const lgj = (await run(dir, ['log', 'alpha', '--json'])).stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lgj.length, 8); assert.equal(lgj[0].ev.kind, 'turn.start');
  assert.deepEqual((await run(dir, ['log', 'alpha', '--since', '6', '--json'])).stdout.trim().split('\n').map((l) => JSON.parse(l).seq), [7, 8]);
  assert.deepEqual((await run(dir, ['log', 'alpha', '--tail', '2', '--json'])).stdout.trim().split('\n').map((l) => JSON.parse(l).seq), [7, 8]);
  // respond: 열려 있지 않은 id
  const rs = await run(dir, ['respond', 'alpha', 'rq1', 'allow']); assert.equal(rs.code, 1); assert.match(rs.stderr, /request rq1 is not open in aaaa1111 — nothing pending/);
  // 제목이 겹치면 후보를 나열하고 실패
  fakeStored(dir, 'bbbb2222', 'alpha', '/y');
  const amb = await run(dir, ['status', 'alpha']); assert.equal(amb.code, 2); assert.match(amb.stderr, /ambiguous title "alpha": aaaa1111 \(\/x\), bbbb2222 \(\/y\)/);
  assert.equal((await run(dir, ['status', 'bbbb2222'])).code, 0, 'id 로는 된다');
  // list 는 live 만(우체국 없음 = 전부 꺼짐) / --all
  assert.deepEqual(JSON.parse((await run(dir, ['list'])).stdout), []);
  assert.deepEqual(JSON.parse((await run(dir, ['list', '--all'])).stdout).map((r: any) => r.id), ['aaaa1111', 'bbbb2222']);
  // rename 은 꺼진 세션도 meta 만
  assert.deepEqual(JSON.parse((await run(dir, ['rename', 'bbbb2222', 'beta'])).stdout), { ok: true, stored: true });
  assert.equal((await run(dir, ['status', 'alpha'])).code, 0, '이제 유일하다');
});

test('살아 있는 세션: new 는 동사 이름 폴더도 폴더로, resume 은 attach 로, status 는 live, 닫은 뒤 resume 은 다시 띄운다', async (t) => {
  const dir = tmp('slcode-cli-');
  const work = path.join(tmp('slcode-work-'), 'list'); fs.mkdirSync(work); // 동사와 같은 이름의 폴더
  const a = start(dir, ['new', work, '--no-web', '--title', 'live1']);
  t.after(() => { if (a.child.exitCode === null) a.child.kill('SIGINT'); });
  const sock = await a.out;
  assert.ok(sock.endsWith('/sock'), sock);
  const [meta] = EventLog.list(corePaths(dir).sessionsDir);
  assert.equal(meta.cwd, work); assert.equal(meta.title, 'live1');
  await sleep(500);
  const st = JSON.parse((await run(dir, ['status', 'live1', '--json'])).stdout);
  assert.equal(st.live, true); assert.equal(st.id, meta.id); assert.equal(st.turns, 0);
  assert.deepEqual(JSON.parse((await run(dir, ['list'])).stdout).map((r: any) => [r.id, r.live]), [[meta.id, true]]);
  const rs = await run(dir, ['respond', meta.id, 'zzz', 'deny']); assert.equal(rs.code, 1); assert.match(rs.stderr, /not open .* nothing pending/);
  const bad = await run(dir, ['respond', meta.id, 'zzz', 'maybe']); assert.equal(bad.code, 2, 'allow|deny 외는 usage');
  // resume 이 살아 있는 세션이면 attach — /quit 로 나온다
  const at = start(dir, ['resume', 'live1']);
  const t0 = Date.now(); while (!at.err.join('').includes('[attach]') && Date.now() - t0 < 8000) await sleep(100);
  assert.match(at.err.join(''), /is live — attaching[\s\S]*\[attach\] .* starting history=\d+ pending=0/);
  at.child.stdin!.write('/quit\n');
  assert.equal(await at.exit, 0);
  // resume --stdio 가 살아 있는 세션이면 프록시 — hello 뒤 프레임 중계 (superlite 카드가 떠 있는 세션에 붙는 길)
  const px = start(dir, ['resume', meta.id, '--stdio']);
  const hello = JSON.parse(await px.out);
  assert.equal(hello.id, meta.id); assert.equal(hello.url, null, '--no-web 세션은 url 없음');
  px.child.stdin!.write(JSON.stringify({ id: 3, method: 'server.info', params: {} }) + '\n');
  const pr = JSON.parse(await px.line(1)); assert.equal(pr.id, 3); assert.equal(pr.result.session, meta.id);
  px.child.stdin!.end(); assert.equal(await px.exit, 0);
  // 닫기
  a.child.kill('SIGINT');
  assert.equal(await a.exit, 0);
  assert.match(a.err.join(''), new RegExp(`To continue: slcode resume ${meta.id}`));
  assert.deepEqual(JSON.parse((await run(dir, ['list'])).stdout), [], '닫힌 세션은 list 에서 빠진다');
  // 꺼진 세션의 resume 은 다시 띄운다
  const b = start(dir, ['resume', meta.id, '--no-web']);
  assert.equal(await b.out, sock);
  b.child.kill('SIGINT'); assert.equal(await b.exit, 0);
  await sleep(1500); // 우체국 grace
});

test('--stdio: 첫 줄은 hello JSON, 그 뒤 stdin 의 JSON 줄은 요청·stdout 은 응답 (UDS 와 같은 프레임)', async (t) => {
  const dir = tmp('slcode-cli-');
  const work = tmp('slcode-work-');
  const a = start(dir, ['new', work, '--no-web', '--stdio', '--title', 'stdio1']);
  t.after(() => { if (a.child.exitCode === null) a.child.kill('SIGINT'); });
  const hello = JSON.parse(await a.out);
  assert.equal(hello.url, null); assert.ok(hello.sock.endsWith('/sock')); assert.equal(typeof hello.id, 'string');
  // 두 번째 줄부터는 프레임 — server.info 요청에 응답이 온다
  a.child.stdin!.write('not json\n'); // 버린다
  a.child.stdin!.write(JSON.stringify({ id: 7, method: 'server.info', params: {} }) + '\n');
  const r = JSON.parse(await a.line(1));
  assert.equal(r.id, 7); assert.equal(r.result.session, hello.id); assert.equal(r.result.cwd, work);
  // stdin 이 닫혀도 세션은 산다 (UDS 클라이언트가 끊긴 것과 같다)
  a.child.stdin!.end();
  await sleep(500);
  assert.equal(a.child.exitCode, null);
  assert.equal(JSON.parse((await run(dir, ['status', 'stdio1', '--json'])).stdout).live, true);
  a.child.kill('SIGINT');
  assert.equal(await a.exit, 0);
  await sleep(1500);
});
