// 동사 없는 slcode = 시작 화면(ticket slcode-session-profile, 사용자 2026-10-30 — 그 전엔 new .)과 superlite 안 카드 경로 (ticket slcode-bare-new·slcode-resume-like-new) — 카드 경로는 PATH 앞의 가짜 `superlite` 심으로 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx'); // 자식의 cwd 를 바꿔도 tsx 를 찾게
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
type Out = { code: number; stdout: string; stderr: string };
const baseEnv = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION_ID: undefined, SUPERLITE_SOCK: undefined });
function run(dir: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Out> {
  return new Promise((resolve) => execFile(process.execPath, ['--import', TSX, CLI, ...args], { cwd: opts.cwd, env: { ...baseEnv(dir), ...opts.env } }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
}
/** 세션 프로세스로 뜨는 호출 — 첫 stdout 줄(--no-web 이면 소켓 경로)을 받고 SIGINT 로 닫는다 */
async function serveOnce(dir: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ first: string; err: string }> {
  const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], { cwd: opts.cwd, env: { ...baseEnv(dir), ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((r) => child.on('exit', r)); // 먼저 건다 — 곧바로 끝나는 자식(오류)을 놓치지 않게
  let out = '', err = '';
  child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (d: string) => { out += d; });
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => { err += d; });
  const t0 = Date.now(); while (!out.includes('\n') && child.exitCode === null && Date.now() - t0 < 15000) await sleep(50);
  if (child.exitCode === null) child.kill('SIGINT');
  await exit;
  return { first: out.split('\n')[0], err };
}
/** PTY 안의 호출 — 사람이 터미널에서 친 것처럼 stdin·stdout 이 TTY (util-linux script). 에이전트 표식은 지운다 (이 테스트를 에이전트가 돌려도) */
function runTty(dir: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Out> {
  const q = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
  const cmd = [process.execPath, '--import', TSX, CLI, ...args].map(q).join(' ');
  const env = { ...baseEnv(dir), CLAUDECODE: undefined, CODEX_THREAD_ID: undefined, ...opts.env };
  return new Promise((resolve) => execFile('script', ['-qec', cmd, '/dev/null'], { cwd: opts.cwd, env }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
}
/** 가짜 superlite 심 — 받은 인자를 calls 파일에 적고, mode 에 따라 성공·동사 없음·연결 불가·다른 실패·--focus 를 모르는 옛 플러그인 */
function fakeShim(mode: 'ok' | 'unknown' | 'unreachable' | 'fail' | 'nofocus') {
  const bin = tmp('slcode-shim-');
  const calls = path.join(bin, 'calls');
  const body = {
    ok: 'echo s-card-1',
    unknown: 'echo "superlite: unknown verb: slcode.new — see superlite --help" >&2; exit 1',
    unreachable: 'echo "superlite: 데몬 접속 실패" >&2; exit 3',
    fail: 'echo "superlite: card failed" >&2; exit 1',
    nofocus: 'case "$*" in *--focus*) echo "superlite: unknown option --focus" >&2; exit 2;; esac; echo s-card-1',
  }[mode];
  fs.writeFileSync(path.join(bin, 'superlite'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n${body}\n`, { mode: 0o755 });
  const env = { SUPERLITE_SOCK: '/tmp/fake.sock', PATH: `${bin}:${process.env.PATH}` };
  // slcode.* 호출만 — 띄운 세션의 claude 가 사용자 훅으로 `superlite agent-event` 를 부르기도 한다
  return { env, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter((l) => l.startsWith('slcode.')) : []) };
}

test('동사 없는 slcode = 시작 화면 — 세션은 고르기 전엔 없고, 세션 옵션·위치 인자·모르는 동사는 거부; new 는 폴더를 꼭 받는다', async () => {
  const dir = tmp('slcode-bare-');
  const work = tmp('slcode-work-');
  const a = await serveOnce(dir, ['--port', '0'], { cwd: work });
  assert.match(a.first, /^http:\/\/127\.0\.0\.1:\d+\/$/, a.first + a.err); assert.match(a.err, /start screen/);
  assert.deepEqual(EventLog.list(corePaths(dir).sessionsDir), [], '고르기 전엔 세션이 없다');
  const opt = await run(dir, ['--no-web', '--title', 'bare1'], { cwd: work });
  assert.equal(opt.code, 2); assert.match(opt.stderr, /takes no session options \(--title, --no-web\) — for a new session: slcode new <folder>/);
  const nf = await run(dir, ['new'], { cwd: work });
  assert.equal(nf.code, 2); assert.match(nf.stderr, /new needs a folder/);
  const b = await serveOnce(dir, ['new', '.', '--no-web', '--title', 'new1'], { cwd: work });
  assert.ok(b.first.endsWith('/sock'), b.first + b.err);
  const [meta] = EventLog.list(corePaths(dir).sessionsDir);
  assert.equal(meta.cwd, fs.realpathSync(work)); assert.equal(meta.title, 'new1');
  const pos = await run(dir, ['--title', 'x', 'elsewhere']);
  assert.equal(pos.code, 2); assert.match(pos.stderr, /옵션만 받는다: elsewhere/);
  const unk = await run(dir, ['foo']);
  assert.equal(unk.code, 2); assert.match(unk.stderr, /unknown verb: foo/);
  // 권한 모드는 셋만 — 메뉴에서 뺀 acceptEdits·plan 도 아무것도 열지 않고 거절 (ticket slcode-permission-modes-three)
  for (const m of ['acceptEdits', 'plan']) {
    const r = await run(dir, ['--mode', m]);
    assert.equal(r.code, 2); assert.match(r.stderr, new RegExp(`unknown mode '${m}' \\(default\\|auto\\|bypassPermissions\\)`));
  }
});

test('superlite 안: slcode 는 slcode.start 로 시작 화면 카드, slcode new 는 slcode.new 동사로 카드를 열고 끝난다 — 옵션 전달, 카드가 쓰지 않는 옵션은 경고', async () => {
  const dir = tmp('slcode-bare-');
  const work = tmp('slcode-work-');
  const shim = fakeShim('ok');
  const s = await run(dir, [], { cwd: work, env: shim.env });
  assert.equal(s.code, 0, s.stderr); assert.equal(s.stdout.trim(), 's-card-1');
  const a = await run(dir, ['new', work, '--vendor', 'codex', '--title', 'T 1', '--mode', 'auto', '--model', 'gpt-x', '--raw'], { env: shim.env });
  assert.equal(a.code, 0, a.stderr); assert.equal(a.stdout.trim(), 's-card-1');
  assert.match(a.stderr, /warning: ignoring --raw \(opened as a card\)/);
  const b = await run(dir, ['new', work], { env: shim.env });
  assert.equal(b.code, 0); assert.equal(b.stdout.trim(), 's-card-1');
  const real = fs.realpathSync(work);
  assert.deepEqual(shim.calls(), [`slcode.start --cwd ${real}`, `slcode.new --cwd ${work} --vendor codex --title T 1 --mode auto --model gpt-x`, `slcode.new --cwd ${work}`]);
  assert.deepEqual(EventLog.list(corePaths(dir).sessionsDir), [], '이 프로세스는 세션을 만들지 않는다');
});

// 포커스 (ticket slcode-new-card-no-focus, 사용자 2026-10-25) — 사람이 친 slcode new 만 --focus. 에이전트(env 표식)·TTY 가 아닌 호출은 붙이지 않는다
test('superlite 안: 사람이 터미널에서 친 slcode new 만 slcode.new --focus — slcode 세션·Claude Code·Codex 표식이나 TTY 가 아니면 없다', async () => {
  const dir = tmp('slcode-bare-');
  const work = fs.realpathSync(tmp('slcode-work-'));
  const shim = fakeShim('ok');
  const a = await runTty(dir, ['new', work], { env: shim.env });
  assert.equal(a.code, 0, a.stdout); assert.match(a.stdout, /s-card-1/);
  for (const marker of ['SLCODE_SESSION_ID', 'CLAUDECODE', 'CODEX_THREAD_ID']) assert.equal((await runTty(dir, ['new', work], { env: { ...shim.env, [marker]: 'x' } })).code, 0, marker);
  assert.equal((await run(dir, ['new', work], { env: { ...shim.env, CLAUDECODE: undefined } })).code, 0); // TTY 아님
  assert.deepEqual(shim.calls(), [`slcode.new --focus --cwd ${work}`, ...Array(4).fill(`slcode.new --cwd ${work}`)]);
  // --focus 를 모르는 옛 플러그인 — 빼고 다시 열어 성공한다
  const old = fakeShim('nofocus');
  const b = await runTty(dir, ['new', work], { env: old.env });
  assert.equal(b.code, 0, b.stdout); assert.match(b.stdout, /s-card-1/);
  assert.deepEqual(old.calls(), [`slcode.new --focus --cwd ${work}`, `slcode.new --cwd ${work}`]);
});

test('superlite 안 폴백: --web·--stdio·동사 없음·연결 불가는 웹 서빙, 다른 동사 실패는 그 사유로 끝난다', async () => {
  const dir = tmp('slcode-bare-');
  const work = tmp('slcode-work-');
  const ok = fakeShim('ok');
  const w = await serveOnce(dir, ['--web', '--port', '0'], { cwd: work, env: ok.env });
  assert.match(w.first, /^http:\/\/127\.0\.0\.1:\d+\/$/, w.first + w.err); assert.deepEqual(ok.calls(), [], '--web 은 심을 부르지 않는다');
  // --stdio 는 카드 서비스 자신 — superlite 안(SUPERLITE_SOCK)에서도 다시 카드를 열지 않고 hello 를 낸다
  const st = await serveOnce(dir, ['new', work, '--stdio', '--no-web'], { env: ok.env });
  assert.ok(JSON.parse(st.first).id, st.first + st.err); assert.deepEqual(ok.calls(), [], '--stdio 는 심을 부르지 않는다');
  for (const mode of ['unknown', 'unreachable'] as const) {
    const s = fakeShim(mode);
    const r = await serveOnce(dir, ['new', '.', '--no-web'], { cwd: work, env: s.env });
    assert.ok(r.first.endsWith('/sock'), `${mode}: ${r.first} ${r.err}`); assert.equal(s.calls().length, 1);
  }
  // slcode.start 를 모르는 옛 플러그인 — 시작 화면은 웹으로
  const old = fakeShim('unknown');
  const sw = await serveOnce(dir, [], { cwd: work, env: old.env });
  assert.match(sw.first, /^http:\/\/127\.0\.0\.1:\d+\/$/, sw.first + sw.err); assert.deepEqual(old.calls(), [`slcode.start --cwd ${fs.realpathSync(work)}`]);
  const f = fakeShim('fail');
  const r = await run(dir, ['new', '.', '--no-web'], { cwd: work, env: f.env });
  assert.equal(r.code, 1); assert.match(r.stderr, /card failed/);
});

/** 꺼진 세션 하나를 지어낸다 — 꺼진 시각은 closedAt, 없으면 updatedAt */
function stored(dir: string, id: string, cwd: string, t: { closedAt?: number; updatedAt?: number }) {
  EventLog.create(corePaths(dir).sessionsDir, { id, vendor: 'claude', cwd, title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false, ...t }).close();
}

test('superlite 안: resume·continue 는 slcode.resume 동사로 카드 — continue 는 최근 꺼진 세션, id 없는 resume 은 그 폴더의 꺼진 세션을 고르는 카드', async () => {
  const dir = tmp('slcode-bare-');
  const work = fs.realpathSync(tmp('slcode-work-'));
  stored(dir, 'old11111', work, { closedAt: 100, updatedAt: 90 }); stored(dir, 'new22222', work, { updatedAt: 200 }); // closedAt 없는 옛 세션은 updatedAt
  const shim = fakeShim('ok');
  const r = await run(dir, ['resume', 'old11111', '--mode', 'auto'], { env: shim.env });
  assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout.trim(), 's-card-1'); assert.match(r.stderr, /warning: ignoring --mode \(opened as a card\)/);
  assert.equal((await run(dir, ['continue'], { cwd: work, env: shim.env })).code, 0);
  assert.equal((await run(dir, ['resume'], { cwd: work, env: shim.env })).code, 0);
  assert.deepEqual(shim.calls(), ['slcode.resume --id old11111', 'slcode.resume --id new22222', `slcode.resume --cwd ${work}`]);
  // 꺼진 세션이 없는 폴더 — continue 는 새 세션 카드, id 없는 resume 은 카드 없이 끝난다
  const empty = fs.realpathSync(tmp('slcode-work-'));
  const s2 = fakeShim('ok');
  const c = await run(dir, ['continue', '--title', 'T'], { cwd: empty, env: s2.env });
  assert.equal(c.code, 0, c.stderr); assert.match(c.stderr, /no closed session in .*, starting a new one/);
  const p = await run(dir, ['resume'], { cwd: empty, env: s2.env });
  assert.equal(p.code, 1); assert.match(p.stderr, /no closed session in /);
  assert.deepEqual(s2.calls(), [`slcode.new --cwd ${empty} --title T`]);
  // 옛 플러그인(slcode.resume 없음)이면 웹 서빙으로 — 꺼진 세션은 이 프로세스가 세션이 된다
  const old = fakeShim('unknown');
  const f = await serveOnce(dir, ['resume', 'old11111', '--no-web'], { env: old.env });
  assert.ok(f.first.endsWith('/sock'), f.first + f.err); assert.deepEqual(old.calls(), ['slcode.resume --id old11111']);
});

test('--host·--port: superlite 안에서 --web 없이 주면 아무것도 열지 않는다; --no-web 과 함께면 오류', async () => {
  const dir = tmp('slcode-bare-');
  const work = fs.realpathSync(tmp('slcode-work-'));
  stored(dir, 'old11111', work, { closedAt: 100 });
  const shim = fakeShim('ok');
  for (const args of [['--host', '0.0.0.0'], ['new', '.', '--port', '9'], ['resume', 'old11111', '--port', '9'], ['continue', '--host', '0.0.0.0'], ['resume', '--port', '9']]) {
    const r = await run(dir, args, { cwd: work, env: shim.env });
    assert.equal(r.code, 2, args.join(' ')); assert.match(r.stderr, new RegExp(`warning: ${args.find((a) => a === '--host' || a === '--port')} is ambiguous inside superlite; add --web to serve over the web, or drop it to open a card`), args.join(' '));
  }
  assert.deepEqual(shim.calls(), [], '카드를 열지 않는다');
  for (const args of [['--no-web', '--port', '9'], ['resume', 'old11111', '--no-web', '--host', 'h'], ['--web', '--no-web']]) {
    const r = await run(dir, args, { cwd: work });
    assert.equal(r.code, 2, args.join(' ')); assert.match(r.stderr, /--no-web cannot be combined with --web, --host or --port/, args.join(' '));
  }
});

test('superlite 안의 살아 있는 세션: resume 은 slcode.resume 로 그 카드를, 옛 플러그인이면 웹 주소(없으면 안내); id 없는 resume 은 목록으로 돌아온다', async (t) => {
  const dir = tmp('slcode-bare-');
  const work = fs.realpathSync(tmp('slcode-work-'));
  stored(dir, 'old11111', work, { closedAt: 100 });
  const live = spawn(process.execPath, ['--import', TSX, CLI, 'new', work, '--no-web', '--title', 'live9'], { env: baseEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (live.exitCode === null) live.kill('SIGINT'); });
  const exited = new Promise((r) => live.on('exit', r));
  let out = ''; live.stdout!.setEncoding('utf8'); live.stdout!.on('data', (d: string) => { out += d; });
  const t0 = Date.now(); while (!out.includes('\n') && Date.now() - t0 < 15000) await sleep(50);
  const id = EventLog.list(corePaths(dir).sessionsDir).find((m) => m.title === 'live9')!.id;
  const ok = fakeShim('ok');
  assert.equal((await run(dir, ['resume', 'live9'], { env: ok.env })).code, 0);
  assert.deepEqual(ok.calls(), [`slcode.resume --id ${id}`]);
  const old = fakeShim('unknown');
  const r = await run(dir, ['resume', 'live9'], { env: old.env });
  assert.equal(r.code, 1); assert.match(r.stderr, /is live but has no web address/);
  const ls = await run(dir, ['resume'], { cwd: work, env: old.env });
  assert.equal(ls.code, 0, ls.stderr); assert.match(ls.stdout, /^old11111  /); assert.doesNotMatch(ls.stdout, new RegExp(id), '살아 있는 세션은 목록에 없다');
  assert.deepEqual(old.calls(), [`slcode.resume --id ${id}`, `slcode.resume --cwd ${work}`]);
  live.kill('SIGINT'); await exited;
});

// ---- 카드 서비스의 기동 오류 (ticket slcode-sidebar-new-stuck) — stderr 는 카드에 닿지 않아 hello 전 오류를 stdout 프레임 {fatal} 로도 낸다
test('--stdio 가 hello 전에 오류로 끝나면 stdout 에 {fatal}, stderr 는 그대로. --stdio 가 아니면 stdout 은 비어 있다', async () => {
  const dir = tmp('slcode-fatal-');
  const usage = await run(dir, ['new', '--stdio', '--no-web']);
  assert.equal(usage.code, 2);
  assert.match(JSON.parse(usage.stdout).fatal, /^new needs a folder/);
  assert.match(usage.stderr, /new needs a folder/);
  const missing = await run(dir, ['resume', 'nope', '--stdio', '--no-web']);
  assert.equal(missing.code, 1);
  assert.match(JSON.parse(missing.stdout).fatal, /no session nope/);
  const plain = await run(dir, ['new']);
  assert.equal(plain.code, 2);
  assert.equal(plain.stdout, '');
});

test('--stdio 가 hello 를 낸 뒤 끝나면 {fatal} 은 없다', async () => {
  const dir = tmp('slcode-fatal-'), cwd = tmp('slcode-fatal-work-');
  const child = spawn(process.execPath, ['--import', TSX, CLI, 'new', cwd, '--stdio', '--no-web'], { env: baseEnv(dir), stdio: ['pipe', 'pipe', 'ignore'] });
  const exit = new Promise((r) => child.on('exit', r));
  let out = '';
  child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (d: string) => { out += d; });
  const t0 = Date.now(); while (!out.includes('\n') && child.exitCode === null && Date.now() - t0 < 15000) await sleep(50);
  assert.ok(JSON.parse(out.split('\n')[0]).sock, 'hello');
  child.kill('SIGINT');
  await exit;
  assert.ok(!out.includes('"fatal"'), out);
});
