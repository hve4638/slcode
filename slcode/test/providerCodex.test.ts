// custom provider 의 Codex 길 (ticket slcode-custom-provider) — 가짜 app-server(test/fixtures/fake-codex.mjs)가 받은 인자·env 와 팀원의 프로바이더.
// core.ts 는 읽힐 때 env 를 고정하므로(SDK_ENV) Claude 길(provider.test.ts)과 프로세스를 나눈다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveProvider } from '../src/provider.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 30000) { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(50); assert.ok(f(), 'timed out'); }

test('codex custom 세션: app-server 에 -c model_provider·model_providers 인자와 키 env, 팀원은 벤더를 주지 않으면 리더의 프로바이더를 따른다', { timeout: 60000 }, async () => {
  const saved = { ...process.env };
  const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
  const dir = tmp('slcode-provx-'), work = tmp('slcode-provx-work-');
  const envFile = path.join(dir, 'env.json');
  Object.assign(process.env, { SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, FAKE_CODEX_ENV: envFile });
  saveProvider(dir, { name: 'Local', template: 'ollama', vendor: 'codex', baseUrl: 'http://127.0.0.1:9/v1', key: 'ollama', models: ['qwen:7b'], limits: { 'qwen:7b': { context: 32768, output: 4096 } } });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const { EventLog } = await import('../src/eventLog.ts');
  const { corePaths } = await import('../src/paths.ts');
  const core = await runCore({ dir, cwd: work, provider: 'local' });
  const id = core.session.id;
  let child: string | null = null, c: Awaited<ReturnType<typeof connectSession>> | null = null;
  try {
    await until(() => fs.existsSync(envFile));
    const e = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(e.SLCODE_PROVIDER_KEY, 'ollama');
    const args = e.args.join(' ');
    assert.match(args, /model_provider="slcode-local"/);
    assert.match(args, /model_providers\.slcode-local\.base_url="http:\/\/127\.0\.0\.1:9\/v1"/);
    assert.doesNotMatch(args, /openai_base_url/);
    assert.match(args, /model_context_window=32768/, '모델의 컨텍스트 한도 (ticket slcode-provider-token-limits)');
    c = await connectSession(core.sock);
    await c.request('session.attach', { id });
    const m = await c.request('session.models', { id });
    assert.deepEqual(m.models.map((x) => x.value), ['qwen:7b']);
    ({ id: child } = await c.request('session.spawnChild', { id, cwd: work }));
    const cm = EventLog.open(corePaths(dir).sessionsDir, child)!.meta;
    assert.equal(cm.provider, 'local'); assert.equal(cm.vendor, 'codex'); assert.equal(cm.model, 'qwen:7b');
  } finally {
    // 팀원(teammate 프리셋)은 리더가 닫혀도 남는다 — 직접 닫는다
    if (child && c) await c.request('session.childCall', { id, child, method: 'session.close' }).catch(() => {});
    c?.close();
    await core.close('test');
    process.env = saved;
  }
});
