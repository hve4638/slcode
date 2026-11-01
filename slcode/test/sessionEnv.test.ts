// 새 세션 env (ticket slcode-new-session-env, 사용자 결정 2026-11-01) — --env 이름 규칙, meta.env, 벤더 프로세스 env(첫 기동·reopen·resume)와
// 겹친 이름의 순서(셸 < --env < SLCODE_* < 플러그인 manifest env), 새 세션에만. 벤더는 가짜 codex(test/fixtures/fake-codex.mjs — SE_* 를 se 에 남긴다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { serveSession } from '../src/serve.ts';
import { connectSession } from '../src/client.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import { sessionEnv } from '../src/base.ts';
import { addPlugin } from 'slcode-plugin/agentPlugins';

const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
type Out = { code: number; stdout: string; stderr: string };
function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Out> {
  const base = { ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION_ID: undefined, SUPERLITE_SOCK: undefined, SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}` };
  return new Promise((resolve) => execFile(process.execPath, ['--import', TSX, CLI, ...args], { env: { ...base, ...env } }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
}
async function until(f: () => boolean, ms = 10000) { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(100); assert.ok(f(), 'timed out'); }

test('sessionEnv: NAME=VALUE 들, 줄바꿈으로 여러 쌍, 값의 = 는 그대로, 같은 이름은 뒤의 것. 이름 오류·SLCODE_*·= 없음은 거절', () => {
  assert.deepEqual(sessionEnv(['A=1', 'B=x=y']), { A: '1', B: 'x=y' });
  assert.deepEqual(sessionEnv(['A=1\nB=2\n', 'C=', 'A=3']), { A: '3', B: '2', C: '' });
  assert.deepEqual(sessionEnv([]), {});
  assert.throws(() => sessionEnv(['SLCODE_SESSION_ID=x']), /SLCODE_\* names cannot be given/);
  assert.throws(() => sessionEnv(['slcode_dir=x']), /SLCODE_/);
  assert.throws(() => sessionEnv(['1A=x']), /bad env name/);
  assert.throws(() => sessionEnv(['A-B=x']), /bad env name/);
  assert.throws(() => sessionEnv(['=x']), /bad env name/);
  assert.throws(() => sessionEnv(['A']), /needs NAME=VALUE/);
});

test('CLI: --env 이름 오류는 열기 전에, resume·import 에 주면 오류, 동사 없는 slcode 도 거절', async () => {
  const dir = tmp('slcode-senv-'), work = tmp('slcode-work-');
  let r = await run(dir, ['new', work, '--env', 'SLCODE_DIR=/x']);
  assert.equal(r.code, 2); assert.match(r.stderr, /SLCODE_\* names cannot be given/);
  r = await run(dir, ['new', work, '--env', 'NOEQ']);
  assert.equal(r.code, 2); assert.match(r.stderr, /needs NAME=VALUE/);
  r = await run(dir, ['resume', 'abc', '--env', 'A=1']);
  assert.equal(r.code, 2); assert.match(r.stderr, /--env is only for a new session/);
  r = await run(dir, ['import', 'abc', '--env', 'A=1']);
  assert.equal(r.code, 2); assert.match(r.stderr, /--env is only for a new session/);
  r = await run(dir, ['--env', 'A=1']);
  assert.equal(r.code, 2); assert.match(r.stderr, /takes no session options \(--env\)/);
  assert.deepEqual(EventLog.list(corePaths(dir).sessionsDir), [], '세션을 만들지 않았다');
});

test('CLI: superlite 안의 new 는 --env 를 줄바꿈으로 합쳐 slcode.new --env 하나로 넘긴다', async () => {
  const dir = tmp('slcode-senv-'), work = tmp('slcode-work-'), bin = tmp('slcode-shim-');
  const calls = path.join(bin, 'calls.json');
  fs.writeFileSync(path.join(bin, 'superlite'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('s-card-1');\n`, { mode: 0o755 });
  const r = await run(dir, ['new', work, '--env', 'SE_A=1', '--env', 'SE_B=two words'], { SUPERLITE_SOCK: '/tmp/fake.sock', PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(calls, 'utf8')), ['slcode.new', '--cwd', work, '--env', 'SE_A=1\nSE_B=two words']);
});

test('codex: --env 는 meta.env 에 남고 첫 기동·reopen(inspect 전환)·resume 의 프로세스 env 에 들어간다. 플러그인 manifest env 가 이기고 SLCODE_SESSION_ID 는 slcode 값', async () => {
  const saved = { ...process.env };
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = tmp('slcode-senv-'), work = tmp('slcode-work-'), src = tmp('slcode-src-');
  fs.writeFileSync(path.join(src, 'slcode-plugin.json'), JSON.stringify({ name: 'core', env: { CORE_X: 'plugin', SE_P: 'plugin' } }));
  await addPlugin(src, dir);
  const envFile = path.join(dir, 'env.json');
  process.env.FAKE_CODEX_ENV = envFile;
  process.env.SE_SHELL = 'shell'; process.env.SE_A = 'shell';
  const read = () => JSON.parse(fs.readFileSync(envFile, 'utf8'));
  const fresh = async () => { await until(() => fs.existsSync(envFile)); const e = read(); fs.rmSync(envFile); return e; };
  let h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false, env: { SE_A: '1', SE_B: 'x=y', SE_P: 'mine', CORE_X: 'mine' } });
  const id = h.session.id;
  try {
    assert.deepEqual(EventLog.open(corePaths(dir).sessionsDir, id)!.meta.env, { SE_A: '1', SE_B: 'x=y', SE_P: 'mine', CORE_X: 'mine' });
    let e = await fresh();
    assert.deepEqual(e.se, { SE_SHELL: 'shell', SE_A: '1', SE_B: 'x=y', SE_P: 'plugin' }, '셸 < --env < 플러그인 env');
    assert.equal(e.CORE_X, 'plugin');
    assert.equal(e.SLCODE_SESSION_ID, id);
    // reopen — inspect 를 켜면 app-server 를 다시 띄운다
    const c = await connectSession(h.sock);
    await c.request('session.attach', { id });
    await c.request('session.setInspect', { id, on: true });
    c.close();
    e = await fresh();
    assert.equal(e.se.SE_A, '1', 'reopen 뒤에도');
  } finally { await h.close('test'); }
  // resume — 셸 값이 바뀌어도 meta.env 가 위
  process.env.SE_A = 'shell2';
  h = await serveSession({ dir, cwd: work, resume: id, web: false });
  try {
    const e = await fresh();
    assert.deepEqual([e.se.SE_A, e.se.SE_B, e.SLCODE_SESSION_ID], ['1', 'x=y', id], 'resume 뒤에도');
  } finally {
    await h.close('test');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  await assert.rejects(serveSession({ dir, cwd: work, resume: id, web: false, env: { SE_A: '2' } }), /env is only for a new session/);
  await assert.rejects(serveSession({ dir, cwd: work, vendor: 'codex', web: false, env: { SLCODE_SESSION_ID: 'x' } }), /SLCODE_\* names cannot be given/);
});
