// 세션 인자 (ticket slcode-agent-plugin-part-when, 사용자 결정 2026-11-02) — --param·-P 이름 규칙, meta.params, 에이전트 프로세스 env SLCODE_PARAM_<이름>
// (물려받은 SLCODE_PARAM_* 는 지운다), 에이전트 플러그인 part 조건이 인자를 보는 것(켜진 part·빌드 id), resume 이 같은 값을 쓰는 것, 새 세션에만.
// 벤더는 가짜 codex(test/fixtures/fake-codex.mjs — SLCODE_PARAM_* 를 sp 에 남긴다)
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
import { sessionParams } from '../src/base.ts';
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

test('sessionParams: NAME=VALUE 들, 줄바꿈으로 여러 쌍, 같은 이름은 뒤의 것. 이름 오류·대소문자만 다른 이름·= 없음은 거절. SLCODE_ 로 시작해도 된다(env 이름 앞에 붙는다)', () => {
  assert.deepEqual(sessionParams(['ORCH_ROLE=worker', 'B=x=y']), { ORCH_ROLE: 'worker', B: 'x=y' });
  assert.deepEqual(sessionParams(['A=1\nB=2\n', 'C=', 'A=3']), { A: '3', B: '2', C: '' });
  assert.throws(() => sessionParams(['role=a', 'ROLE=b']), /differ only in case/);
  assert.throws(() => sessionParams(['1A=x']), /bad param name/);
  assert.throws(() => sessionParams(['A-B=x']), /bad param name/);
  assert.throws(() => sessionParams(['A']), /--param needs NAME=VALUE/);
});

test('CLI: -P·--param 이름 오류는 열기 전에, resume 에 주면 오류. superlite 안의 new 는 줄바꿈으로 합쳐 slcode.new --param 하나로', async () => {
  const dir = tmp('slcode-sp-'), work = tmp('slcode-work-'), bin = tmp('slcode-shim-');
  let r = await run(dir, ['new', work, '-P', 'A-B=1']);
  assert.equal(r.code, 2); assert.match(r.stderr, /bad param name/);
  r = await run(dir, ['resume', 'abc', '-P', 'A=1']);
  assert.equal(r.code, 2); assert.match(r.stderr, /--param is only for a new session/);
  assert.deepEqual(EventLog.list(corePaths(dir).sessionsDir), [], '세션을 만들지 않았다');
  const calls = path.join(bin, 'calls.json');
  fs.writeFileSync(path.join(bin, 'superlite'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('s-card-1');\n`, { mode: 0o755 });
  r = await run(dir, ['new', work, '-P', 'ORCH_ROLE=worker', '--param', 'ORCH_BRANCH=feat/x'], { SUPERLITE_SOCK: '/tmp/fake.sock', PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(calls, 'utf8')), ['slcode.new', '--cwd', work, '--param', 'ORCH_ROLE=worker\nORCH_BRANCH=feat/x']);
});

test('codex: --param 은 meta.params 에 남아 SLCODE_PARAM_<이름> 으로 들어가고(물려받은 것은 지운다), 조건 part 는 인자가 맞는 세션에서만 켜진다. resume 도 같은 값', async () => {
  const saved = { ...process.env };
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = tmp('slcode-sp-'), work = tmp('slcode-work-'), src = tmp('slcode-src-');
  fs.writeFileSync(path.join(src, 'slcode-plugin.json'), JSON.stringify({ name: 'superlite', parts: { main: { required: true }, orchestration: { when: { param: { ORCH_ROLE: ['worker', 'lead'] } } } } }));
  for (const p of ['main', 'orchestration']) { fs.mkdirSync(path.join(src, p, 'instructions'), { recursive: true }); fs.writeFileSync(path.join(src, p, 'instructions', `${p}.md`), `${p} rule`); }
  await addPlugin(src, dir);
  const envFile = path.join(dir, 'env.json');
  process.env.FAKE_CODEX_ENV = envFile;
  process.env.SLCODE_PARAM_ORCH_ROLE = 'lead'; process.env.SLCODE_PARAM_LEAK = 'leader'; // leader 세션 안에서 친 slcode new 가 물려받는 값
  const fresh = async () => { await until(() => fs.existsSync(envFile)); const e = JSON.parse(fs.readFileSync(envFile, 'utf8')); fs.rmSync(envFile); return e; };
  const plugins = async (sock: string, id: string) => { const c = await connectSession(sock); try { await c.request('session.attach', { id }); return await c.request('session.plugins', { id }) as any; } finally { c.close(); } };
  const ids: Record<string, string> = {}, builds: Record<string, string> = {};
  try {
    for (const [name, params] of [['worker', { ORCH_ROLE: 'worker' }], ['other', { ORCH_ROLE: 'reviewer' }], ['none', undefined]] as const) {
      const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false, ...(params ? { params } : {}) });
      ids[name] = h.session.id;
      try {
        assert.deepEqual(EventLog.open(corePaths(dir).sessionsDir, h.session.id)!.meta.params, params, `${name}: meta.params`);
        const e = await fresh();
        assert.deepEqual(e.sp, params ? { SLCODE_PARAM_ORCH_ROLE: params.ORCH_ROLE } : {}, `${name}: 물려받은 SLCODE_PARAM_* 는 지우고 세션 값만`);
        const p = await plugins(h.sock, h.session.id);
        assert.equal(p.plugins[0].values, name === 'worker' ? 'part.main=1,part.orchestration=1' : 'part.main=1,part.orchestration=0', name);
        assert.equal(p.plugins[0].current, p.plugins[0].build, `${name}: currentBuilds 도 같은 인자 — 다시 실을 것이 없다`);
        builds[name] = p.plugins[0].build;
      } finally { await h.close('test'); }
    }
    assert.notEqual(builds.worker, builds.none);
    assert.equal(builds.other, builds.none, '조건이 거짓이면 인자 없는 세션과 같은 빌드');
    // resume — 셸 값이 바뀌어도 meta.params 를 쓴다
    process.env.SLCODE_PARAM_ORCH_ROLE = 'reviewer';
    const h = await serveSession({ dir, cwd: work, resume: ids.worker, web: false });
    try {
      assert.deepEqual((await fresh()).sp, { SLCODE_PARAM_ORCH_ROLE: 'worker' });
      assert.equal((await plugins(h.sock, ids.worker)).plugins[0].build, builds.worker, 'resume 도 같은 빌드');
    } finally { await h.close('test'); }
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  await assert.rejects(serveSession({ dir, cwd: work, resume: ids.worker, web: false, params: { ORCH_ROLE: 'lead' } }), /params are only for a new session/);
  await assert.rejects(serveSession({ dir, cwd: work, vendor: 'codex', web: false, params: { 'A-B': 'x' } }), /bad param name/);
});
