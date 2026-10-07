// 동사 없는 slcode = new . 와 superlite 안 카드 경로 (ticket slcode-bare-new) — 카드 경로는 PATH 앞의 가짜 `superlite` 심으로 본다
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
const baseEnv = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION: undefined, SUPERLITE_SOCK: undefined });
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
/** 가짜 superlite 심 — 받은 인자를 calls 파일에 적고, mode 에 따라 성공·동사 없음·연결 불가·다른 실패 */
function fakeShim(mode: 'ok' | 'unknown' | 'unreachable' | 'fail') {
  const bin = tmp('slcode-shim-');
  const calls = path.join(bin, 'calls');
  const body = {
    ok: 'echo s-card-1',
    unknown: 'echo "superlite: unknown verb: slcode.new — see superlite --help" >&2; exit 1',
    unreachable: 'echo "superlite: 데몬 접속 실패" >&2; exit 3',
    fail: 'echo "superlite: card failed" >&2; exit 1',
  }[mode];
  fs.writeFileSync(path.join(bin, 'superlite'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n${body}\n`, { mode: 0o755 });
  const env = { SUPERLITE_SOCK: '/tmp/fake.sock', PATH: `${bin}:${process.env.PATH}` };
  // slcode.new 호출만 — 띄운 세션의 claude 가 사용자 훅으로 `superlite agent-event` 를 부르기도 한다
  return { env, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter((l) => l.startsWith('slcode.new')) : []) };
}

test('동사 없는 slcode = new . — 옵션만 받는다, 위치 인자·모르는 동사는 거부', async () => {
  const dir = tmp('slcode-bare-');
  const work = tmp('slcode-work-');
  const a = await serveOnce(dir, ['--no-web', '--title', 'bare1'], { cwd: work });
  assert.ok(a.first.endsWith('/sock'), a.first + a.err);
  const [meta] = EventLog.list(corePaths(dir).sessionsDir);
  assert.equal(meta.cwd, fs.realpathSync(work)); assert.equal(meta.title, 'bare1');
  const pos = await run(dir, ['--title', 'x', 'elsewhere']);
  assert.equal(pos.code, 2); assert.match(pos.stderr, /옵션만 받는다: elsewhere/);
  const unk = await run(dir, ['foo']);
  assert.equal(unk.code, 2); assert.match(unk.stderr, /unknown verb: foo/);
  await sleep(1500); // 우체국 grace
});

test('superlite 안: slcode·slcode new 는 slcode.new 동사로 카드를 열고 끝난다 — 옵션 전달, 웹 전용 옵션은 경고', async () => {
  const dir = tmp('slcode-bare-');
  const work = tmp('slcode-work-');
  const shim = fakeShim('ok');
  const a = await run(dir, ['--vendor', 'codex', '--title', 'T 1', '--mode', 'plan', '--port', '9'], { cwd: work, env: shim.env });
  assert.equal(a.code, 0, a.stderr); assert.equal(a.stdout.trim(), 's-card-1');
  assert.match(a.stderr, /웹 서빙 옵션은 쓰지 않았다: --port/);
  const b = await run(dir, ['new', work], { env: shim.env });
  assert.equal(b.code, 0); assert.equal(b.stdout.trim(), 's-card-1');
  const real = fs.realpathSync(work);
  assert.deepEqual(shim.calls(), [`slcode.new --cwd ${real} --vendor codex --title T 1 --mode plan`, `slcode.new --cwd ${work}`]);
  assert.deepEqual(EventLog.list(corePaths(dir).sessionsDir), [], '이 프로세스는 세션을 만들지 않는다');
});

test('superlite 안 폴백: --web·--stdio·동사 없음·연결 불가는 웹 서빙, 다른 동사 실패는 그 사유로 끝난다', async () => {
  const dir = tmp('slcode-bare-');
  const work = tmp('slcode-work-');
  const ok = fakeShim('ok');
  const w = await serveOnce(dir, ['--web', '--no-web'], { cwd: work, env: ok.env });
  assert.ok(w.first.endsWith('/sock'), w.first + w.err); assert.deepEqual(ok.calls(), [], '--web 은 심을 부르지 않는다');
  // --stdio 는 카드 서비스 자신 — superlite 안(SUPERLITE_SOCK)에서도 다시 카드를 열지 않고 hello 를 낸다
  const st = await serveOnce(dir, ['new', work, '--stdio', '--no-web'], { env: ok.env });
  assert.ok(JSON.parse(st.first).id, st.first + st.err); assert.deepEqual(ok.calls(), [], '--stdio 는 심을 부르지 않는다');
  for (const mode of ['unknown', 'unreachable'] as const) {
    const s = fakeShim(mode);
    const r = await serveOnce(dir, ['--no-web'], { cwd: work, env: s.env });
    assert.ok(r.first.endsWith('/sock'), `${mode}: ${r.first} ${r.err}`); assert.equal(s.calls().length, 1);
  }
  const f = fakeShim('fail');
  const r = await run(dir, ['--no-web'], { cwd: work, env: f.env });
  assert.equal(r.code, 1); assert.match(r.stderr, /card failed/);
  await sleep(1500);
});
