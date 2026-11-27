// custom provider (ticket slcode-custom-provider, 사용자 결정 2026-11-25) — providers.json(0600, 키를 내보내지 않음), 벤더 env·인자의 선택(provider.ts 한 곳),
// 모델 목록 받기, 그리고 실제 세션: Claude 는 진짜 claude CLI 를 가짜 프로바이더로(가짜 키, API 비용 없음), Codex 는 가짜 app-server. dist 를 빌드한 뒤에 돈다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { claudeConnection, codexProviderArgs, CONNECTION_ENV, fetchModels, getProvider, modelLimits, publicProvider, readKeys, readProviders, removeKey, removeProvider, saveKey, saveProvider, withoutConnection, type Provider } from '../src/provider.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 30000) { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(50); assert.ok(f(), 'timed out'); }
const base: Provider = { id: 'p', name: 'P', template: 'custom', vendor: 'claude', baseUrl: 'http://x', key: 'k-123', keyRef: '', models: ['m1', 'm2'], auth: 'bearer', headers: {}, tiers: {}, features: { thinking: false, effort: false, betas: false }, env: {}, limits: {} };

test('providers.json: 이름에서 id, 고치기는 준 칸만, key 를 빼면 남는다. 파일은 0600, 화면으로는 키 없이. 템플릿에 없는 엔진·주소 오류는 거절', () => {
  const dir = tmp('slcode-prov-');
  const a = saveProvider(dir, { name: 'Open Router', template: 'openrouter', vendor: 'claude', baseUrl: 'https://openrouter.ai/api', key: 'sk-or-v1-secret-abcd', models: ['x/y'] });
  assert.equal(a.id, 'open-router');
  assert.equal(fs.statSync(path.join(dir, 'providers.json')).mode & 0o777, 0o600);
  const b = saveProvider(dir, { id: a.id, models: ['x/y', 'z/w'], headers: { 'X-T': 'v' } });
  assert.equal(b.key, 'sk-or-v1-secret-abcd', 'key 를 빼면 남는다');
  assert.deepEqual(b.models, ['x/y', 'z/w']);
  assert.equal(saveProvider(dir, { name: 'Open Router', vendor: 'claude', baseUrl: 'http://h' }).id, 'open-router-2');
  const pub = publicProvider(getProvider(dir, a.id)!);
  assert.equal('key' in pub, false); assert.equal(pub.hasKey, true); assert.equal(pub.keyTail, 'abcd');
  assert.throws(() => saveProvider(dir, { name: 'DS', template: 'deepseek', vendor: 'codex', baseUrl: 'https://api.deepseek.com' }), /no OpenAI Responses endpoint/);
  assert.throws(() => saveProvider(dir, { name: 'bad', vendor: 'claude', baseUrl: 'ftp://x' }), /http/);
  assert.throws(() => saveProvider(dir, { id: 'nope', name: 'x' }), /no provider nope/);
  assert.equal(removeProvider(dir, 'open-router-2'), true);
  assert.deepEqual(readProviders(dir).map((p) => p.id), ['open-router']);
  fs.writeFileSync(path.join(dir, 'providers.json'), '{"providers":[{"id":"Bad Id","name":"x","vendor":"claude"},{"id":"ok","name":"ok","vendor":"codex"}]}');
  assert.deepEqual(readProviders(dir).map((p) => p.id), ['ok'], '꼴이 틀린 항목은 버린다');
});

test('키 관리: 한 키를 여러 프로바이더가 가리키고 값을 바꾸면 모두 새 값, 파일의 프로바이더에는 키 값이 없다. 직접 넣으면 가리킴을 푼다. 쓰는 키는 지우지 못한다', async () => {
  const dir = tmp('slcode-provk-');
  const k = saveKey(dir, { name: 'OpenRouter', value: 'sk-or-shared-1111' });
  assert.equal(k.id, 'openrouter');
  const a = saveProvider(dir, { name: 'A', vendor: 'claude', baseUrl: 'http://a', keyRef: k.id });
  const b = saveProvider(dir, { name: 'B', vendor: 'codex', baseUrl: 'http://b/v1', keyRef: k.id });
  assert.equal(a.key, 'sk-or-shared-1111'); assert.equal(b.key, 'sk-or-shared-1111');
  const disk = fs.readFileSync(path.join(dir, 'providers.json'), 'utf8');
  assert.equal(disk.split('sk-or-shared-1111').length - 1, 1, '키 값은 keys 에 한 번만');
  assert.equal(fs.statSync(path.join(dir, 'providers.json')).mode & 0o777, 0o600);
  saveKey(dir, { id: k.id, value: 'sk-or-shared-2222' });
  assert.deepEqual(readProviders(dir).map((p) => p.key), ['sk-or-shared-2222', 'sk-or-shared-2222'], '값을 바꾸면 가리키는 프로바이더 모두');
  assert.equal(saveProvider(dir, { id: a.id, models: ['m'] }).keyRef, k.id, '키를 주지 않으면 가리킴이 남는다');
  assert.throws(() => removeKey(dir, k.id), /used by A, B/);
  const a2 = saveProvider(dir, { id: a.id, key: 'direct-key-3333' });
  assert.equal(a2.keyRef, ''); assert.equal(a2.key, 'direct-key-3333');
  saveProvider(dir, { id: b.id, key: '' });
  assert.equal(removeKey(dir, k.id), true);
  assert.deepEqual(readKeys(dir), []);
  assert.throws(() => saveProvider(dir, { id: a.id, keyRef: 'nope' }), /no key nope/);
  assert.throws(() => saveKey(dir, { name: 'x', value: ' ' }), /value/);
  const { providerMethod } = await import('../src/providerMethods.ts');
  saveKey(dir, { name: 'Z', value: 'zzzz-secret-9999' });
  const listed = JSON.stringify(await providerMethod(dir, 'provider.list', {}));
  assert.equal(listed.includes('zzzz-secret'), false, '화면으로는 키 값을 내보내지 않는다');
  assert.ok(listed.includes('"tail":"9999"'));
});

test('시작 화면: 프로바이더를 지웠거나 엔진이 바뀐 custom 세션은 고를 때 사유로 거절하고 시작 화면은 그대로 — core 가 띄우다 던지면 시작 화면 프로세스가 끝난다', async () => {
  const dir = tmp('slcode-provs-'), work = fs.realpathSync(tmp('slcode-provs-work-'));
  const { EventLog } = await import('../src/eventLog.ts');
  const { corePaths } = await import('../src/paths.ts');
  const { startServer } = await import('../src/startPage.ts');
  saveProvider(dir, { name: 'Moved', vendor: 'codex', baseUrl: 'http://127.0.0.1:1/v1', template: 'vllm' });
  const stored = (id: string, provider: string) => EventLog.create(corePaths(dir).sessionsDir, { id, vendor: 'claude', provider, cwd: work, title: id, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false, closedAt: 10 }).close();
  stored('moved111', 'moved'); stored('gone2222', 'gone');
  const pick = startServer(dir, work);
  await new Promise<void>((r) => pick.server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(pick.server.address() as { port: number }).port}`;
  let chosen = false; void pick.chosen.then(() => { chosen = true; });
  try {
    const go = async (resume: string) => { const r = await fetch(`${url}/api/go`, { method: 'POST', headers: { origin: url }, body: JSON.stringify({ resume }) }); return [r.status, (await r.json()).error]; };
    const [s1, e1] = await go('moved111');
    assert.equal(s1, 400); assert.match(e1, /provider moved now runs on codex — this is a claude session/);
    const [s2, e2] = await go('gone2222');
    assert.equal(s2, 400); assert.match(e2, /provider gone is gone/);
    await sleep(50);
    assert.equal(chosen, false, '고르지 않았다 — 시작 화면이 그대로 남는다');
  } finally { pick.server.closeAllConnections(); pick.server.close(); }
});

test('claudeConnection: Bearer 면 AUTH_TOKEN + 빈 API_KEY, 빈 키도 비워 두지 않는다, 등급은 비우면 고른 모델, 헤더 줄, beta 끄기, 1st party 플래그는 빈 값', () => {
  const c = claudeConnection({ ...base, headers: { 'HTTP-Referer': 'r', 'X-T': 't' }, tiers: { haiku: 'small' } }, 'm2');
  assert.equal(c.ANTHROPIC_BASE_URL, 'http://x');
  assert.equal(c.ANTHROPIC_AUTH_TOKEN, 'k-123'); assert.equal(c.ANTHROPIC_API_KEY, '');
  assert.equal(c.ANTHROPIC_MODEL, 'm2'); assert.equal(c.ANTHROPIC_DEFAULT_OPUS_MODEL, 'm2'); assert.equal(c.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'small');
  assert.equal(c.ANTHROPIC_CUSTOM_HEADERS, 'HTTP-Referer: r\nX-T: t');
  assert.equal(c._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, '');
  assert.equal(c.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1'); assert.equal(c.ENABLE_TOOL_SEARCH, 'false');
  assert.equal(c.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1'); assert.equal(c.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
  const x = claudeConnection({ ...base, auth: 'x-api-key', key: '', features: { ...base.features, betas: true } }, null, 'http://proxy');
  assert.equal(x.ANTHROPIC_API_KEY, 'none', '빈 키면 사용자 claude.ai 로그인으로 넘어가지 않게'); assert.equal(x.ANTHROPIC_AUTH_TOKEN, '');
  assert.equal(x.ANTHROPIC_BASE_URL, 'http://proxy'); assert.equal(x.ANTHROPIC_MODEL, 'm1', '모델을 안 고르면 첫 모델');
  assert.equal('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS' in x, false);
  const env = withoutConnection({ ANTHROPIC_API_KEY: 'user', _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1', ENABLE_TOOL_SEARCH: 'true', PATH: '/bin' });
  assert.deepEqual(env, { PATH: '/bin' });
  assert.ok(CONNECTION_ENV.includes('ANTHROPIC_BASE_URL'));
});

test('codexProviderArgs: model_provider·model_providers.<id> 를 -c 로, 키가 없으면 env_key 를 빼고 헤더는 inline table', () => {
  const a = codexProviderArgs({ ...base, vendor: 'codex', headers: { 'HTTP-Referer': 'r "q"' } }, null, 'http://proxy/v1');
  assert.deepEqual(a, ['-c', 'model_provider="slcode-p"', '-c', 'model_providers.slcode-p.name="P"', '-c', 'model_providers.slcode-p.base_url="http://proxy/v1"', '-c', 'model_providers.slcode-p.wire_api="responses"',
    '-c', 'model_providers.slcode-p.env_key="SLCODE_PROVIDER_KEY"', '-c', 'model_providers.slcode-p.http_headers={"HTTP-Referer"="r \\"q\\""}']);
  assert.equal(codexProviderArgs({ ...base, vendor: 'codex', key: '' }, null).some((x) => x.includes('env_key')), false);
});

test('모델의 토큰 한도 (ticket slcode-provider-token-limits): 모델마다 저장, 목록에 없는 모델·틀린 값은 버린다. Claude 는 env 둘, Codex 는 model_context_window 만', () => {
  const dir = tmp('slcode-provl-');
  const a = saveProvider(dir, { name: 'L', vendor: 'claude', baseUrl: 'http://l', models: ['m1', 'm2'], limits: { m1: { context: 131072, output: 16384 }, m2: { context: -1, output: 1.5 }, gone: { context: 9 } } });
  assert.deepEqual(a.limits, { m1: { context: 131072, output: 16384 } });
  assert.deepEqual(getProvider(dir, a.id)!.limits, a.limits, '디스크에서 다시 읽어도 같다');
  assert.deepEqual(saveProvider(dir, { id: a.id, models: ['m2'] }).limits, {}, '모델을 빼면 그 한도도 빠진다');
  const p = { ...base, limits: { m1: { context: 131072, output: 16384 }, m2: { context: 50000 } }, env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '999', API_TIMEOUT_MS: '1' } };
  assert.deepEqual(modelLimits(p, null), { context: 131072, output: 16384 }, '모델을 안 고르면 첫 모델');
  const c = claudeConnection(p, 'm1');
  assert.equal(c.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '131072'); assert.equal(c.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '16384', '추가 env 보다 앞선다'); assert.equal(c.API_TIMEOUT_MS, '1');
  const c2 = claudeConnection(p, 'm2');
  assert.equal(c2.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '50000'); assert.equal(c2.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '999', '한도가 없으면 추가 env 그대로');
  assert.equal('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in claudeConnection(base, 'm1'), false, '한도가 없으면 넣지 않는다');
  const x = codexProviderArgs({ ...p, vendor: 'codex' }, 'm2');
  assert.deepEqual(x.slice(-2), ['-c', 'model_context_window=50000']);
  assert.equal(codexProviderArgs({ ...base, vendor: 'codex' }, 'm1').some((v) => v.startsWith('model_context_window')), false);
});

test('fetchModels: Claude 엔진은 <주소>/v1/models(Anthropic 헤더), Codex 엔진은 <주소>/models, Ollama 는 /api/tags. 목록 API 가 없는 템플릿·실패는 사유로', async () => {
  const seen: { url: string; h: http.IncomingHttpHeaders }[] = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url!, h: req.headers });
    const u = req.url!.split('?')[0];
    const body = u === '/api/tags' ? { models: [{ name: 'qwen:7b' }] } : u === '/v1/models' ? { data: [{ id: 'a', display_name: 'A' }] } : u === '/v1/x/models' ? { object: 'list', data: [{ id: 'b', context_length: 8192 }] }
      // llama.cpp (2026-11-27 DGX 실측 꼴) — models[] 와 data[] 를 같이 주고, 띄운 크기는 data[].meta.n_ctx
      : u === '/lc/v1/models' ? { models: [{ name: 'q', model: 'q' }], object: 'list', data: [{ id: 'q', owned_by: 'llamacpp', meta: { n_ctx: 131072, n_ctx_train: 262144 } }] } : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    assert.deepEqual(await fetchModels({ ...base, baseUrl: url, auth: 'x-api-key' }), [{ id: 'a', name: 'A', context: undefined }]);
    assert.equal(seen[0].h['x-api-key'], 'k-123'); assert.equal(seen[0].h['anthropic-version'], '2023-06-01');
    assert.deepEqual(await fetchModels({ ...base, vendor: 'codex', baseUrl: `${url}/v1/x` }), [{ id: 'b', name: undefined, context: 8192 }]);
    assert.equal(seen[1].h.authorization, 'Bearer k-123');
    assert.deepEqual(await fetchModels({ ...base, template: 'llamacpp', baseUrl: `${url}/lc` }), [{ id: 'q', name: undefined, context: 131072 }], 'llama.cpp 는 n_ctx_train 이 아니라 n_ctx');
    assert.deepEqual((await fetchModels({ ...base, template: 'ollama', baseUrl: `${url}/v1` })).map((m) => m.id), ['qwen:7b']);
    await assert.rejects(fetchModels({ ...base, template: 'deepseek' }), /no model list API/);
    await assert.rejects(fetchModels({ ...base, vendor: 'codex', baseUrl: `${url}/nope` }), /HTTP 404/);
  } finally { srv.close(); }
});

/** Anthropic Messages 흉내 — 요청마다 경로·인증·모델·beta·1st party 표지 헤더를 남기고 "OK <모델>" */
async function fakeMessages() {
  const reqs: { path: string; auth?: string; xkey?: string; model?: string; firstParty: boolean; tools: number; thinking?: unknown; referer?: string; maxTokens?: number }[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j: any = {}; try { j = JSON.parse(body); } catch {}
      reqs.push({ path: req.url!, auth: req.headers.authorization, xkey: req.headers['x-api-key'] as string | undefined, model: j.model, firstParty: !!req.headers['x-claude-code-request-class'], tools: j.tools?.length ?? 0, thinking: j.thinking, referer: req.headers['http-referer'] as string | undefined, maxTokens: j.max_tokens });
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":5}'); return; }
      // 스트리밍이 아닌 요청(setModel 의 모델 확인)은 JSON 한 번
      if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'msg_v', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } })); return; }
      const ev = (t: string, d: object) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end([
        ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }),
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `OK ${j.model}` } }),
        ev('content_block_stop', { index: 0 }),
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
        ev('message_stop', {}),
      ].join(''));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, reqs, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('claude custom 세션: 셸·--env·~/.claude/settings.json 의 연결 값 대신 프로바이더로, inspect 를 켜도 1st party 플래그 없이 프로바이더로. 모델 메뉴는 프로바이더 모델, effort 는 거절. 프로바이더를 지우면 열리지 않는다', { timeout: 180000 }, async () => {
  const prov = await fakeMessages(), official = await fakeMessages();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  const dir = tmp('slcode-provc-'), home = tmp('slcode-provc-home-'), work = tmp('slcode-provc-work-');
  // 사용자 settings.json 의 env 는 프로세스 env 를 덮는다 — custom 세션은 플래그 settings 로 다시 덮어야 한다
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: official.url, ANTHROPIC_MODEL: 'user-model' } }));
  Object.assign(process.env, { HOME: home, SLCODE_DIR: dir, ANTHROPIC_API_KEY: 'sk-ant-api03-USERKEY', ANTHROPIC_BASE_URL: official.url, ENABLE_TOOL_SEARCH: 'true', SLCODE_GRACE_SECS: '1', SLCODE_CLAUDE_PEER: '0' });
  saveProvider(dir, { name: 'Fake', vendor: 'claude', baseUrl: prov.url, key: 'prov-key-1', models: ['fake/alpha', 'fake/beta'], headers: { 'HTTP-Referer': 'https://example.test' } });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const { EventLog } = await import('../src/eventLog.ts');
  const { corePaths } = await import('../src/paths.ts');
  const core = await runCore({ dir, cwd: work, provider: 'fake', env: { ANTHROPIC_AUTH_TOKEN: 'from-env-flag', SE_KEEP: '1' } });
  const id = core.session.id;
  let c: Awaited<ReturnType<typeof connectSession>> | null = null;
  try {
    const meta = EventLog.open(corePaths(dir).sessionsDir, id)!.meta;
    assert.equal(meta.vendor, 'claude'); assert.equal(meta.provider, 'fake'); assert.equal(meta.model, 'fake/alpha');
    c = await connectSession(core.sock);
    await c.request('session.attach', { id });
    const turn = async (text: string) => {
      const n = prov.reqs.filter((r) => r.tools > 0).length;
      await c.request('session.send', { id, text });
      await until(() => prov.reqs.filter((r) => r.tools > 0).length > n && EventLog.open(corePaths(dir).sessionsDir, id)!.since(0).filter((e) => e.ev.kind === 'turn.end').length >= prov.reqs.filter((r) => r.tools > 0).length);
      return prov.reqs.filter((r) => r.tools > 0).at(-1)!;
    };
    let r = await turn('hi');
    assert.equal(r.auth, 'Bearer prov-key-1'); assert.equal(r.xkey, undefined);
    assert.equal(r.model, 'fake/alpha'); assert.equal(r.firstParty, false); assert.equal(r.referer, 'https://example.test');
    assert.equal(r.thinking, undefined, 'thinking 을 끄면 요청에 싣지 않는다');
    assert.equal(official.reqs.length, 0, '사용자의 공식 주소로는 아무것도 가지 않는다');
    // 키는 명령줄에 실리지 않는다 — 플래그 settings 는 세션 폴더의 0600 파일로 (ps 로 보이지 않게)
    const kids = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => { try { return fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(' ')[3] === String(process.pid); } catch { return false; } })
      .map((p) => fs.readFileSync(`/proc/${p}/cmdline`, 'utf8')).filter((cmd) => cmd.includes('--settings'));
    assert.ok(kids.length, 'claude 자식 프로세스');
    for (const cmd of kids) assert.equal(cmd.includes('prov-key-1'), false, '명령줄에 키가 없다');
    const vs = path.join(EventLog.open(corePaths(dir).sessionsDir, id)!.dir, 'vendor-settings.json');
    assert.equal(fs.statSync(vs).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(vs, 'utf8')).env.ANTHROPIC_AUTH_TOKEN, 'prov-key-1');
    const m = await c.request('session.models', { id });
    assert.deepEqual(m.provider, { id: 'fake', name: 'Fake' });
    assert.deepEqual(m.models.map((x) => x.value), ['fake/alpha', 'fake/beta']);
    assert.deepEqual(m.models[0].efforts, []);
    assert.equal(m.providers?.[0].id, 'fake');
    await assert.rejects(c.request('session.setEffort', { id, effort: 'high' }), /does not take effort/);
    // inspect — proxy 를 거쳐 프로바이더로, 1st party 플래그 없이
    await c.request('session.setInspect', { id, on: true });
    r = await turn('again');
    assert.equal(r.auth, 'Bearer prov-key-1'); assert.equal(r.firstParty, false);
    assert.ok(fs.existsSync(path.join(EventLog.open(corePaths(dir).sessionsDir, id)!.dir, 'inspect', 'inspect.db')), 'inspect 기록이 남는다');
  } finally { c?.close(); await core.close('test'); }
  // 지우면 열지 않는다 — 공식 계정으로 넘어가지 않게
  removeProvider(dir, 'fake');
  await assert.rejects(runCore({ dir, cwd: work, resume: id }), /provider fake is gone/);
  assert.equal(official.reqs.length, 0);
  prov.srv.closeAllConnections(); prov.srv.close(); official.srv.closeAllConnections(); official.srv.close();
  process.env = saved;
});

test('claude custom 세션의 토큰 한도 (ticket slcode-provider-token-limits): ctx max·max_tokens 가 모델의 한도를 따르고, 창에서 고치거나 모델을 바꾸면 다음 턴 전에 다시 띄워 맞춘다', { timeout: 180000 }, async () => {
  const prov = await fakeMessages();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  const dir = tmp('slcode-provt-'), home = tmp('slcode-provt-home-'), work = tmp('slcode-provt-work-');
  Object.assign(process.env, { HOME: home, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_CLAUDE_PEER: '0' });
  saveProvider(dir, { name: 'Fake', vendor: 'claude', baseUrl: prov.url, key: 'k', models: ['fake/alpha', 'fake/beta'], limits: { 'fake/alpha': { context: 50000, output: 4096 } } });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const { EventLog } = await import('../src/eventLog.ts');
  const { corePaths } = await import('../src/paths.ts');
  const core = await runCore({ dir, cwd: work, provider: 'fake' });
  const id = core.session.id;
  let c: Awaited<ReturnType<typeof connectSession>> | null = null;
  try {
    c = await connectSession(core.sock);
    await c.request('session.attach', { id });
    const main = () => prov.reqs.filter((r) => r.tools > 0);
    const turn = async (text: string) => {
      const n = main().length;
      await c!.request('session.send', { id, text });
      await until(() => main().length > n && EventLog.open(corePaths(dir).sessionsDir, id)!.since(0).filter((e) => e.ev.kind === 'turn.end').length >= main().length);
      return main().at(-1)!;
    };
    const max = async () => (await c!.request('session.status', { id })).context?.max;
    assert.equal((await turn('hi')).maxTokens, 4096);
    assert.equal(await max(), 50000);
    saveProvider(dir, { id: 'fake', limits: { 'fake/alpha': { context: 60000, output: 2048 } } }); // 창에서 고친다
    assert.equal((await turn('again')).maxTokens, 2048, '고친 한도로 다시 띄웠다');
    assert.equal(await max(), 60000);
    await c.request('session.setModel', { id, model: 'fake/beta' }); // 한도가 없는 모델 — Claude Code 기본
    const r = await turn('beta');
    assert.equal(r.model, 'fake/beta'); assert.equal(r.maxTokens, 32000);
    assert.equal(await max(), 200000);
    const n = EventLog.open(corePaths(dir).sessionsDir, id)!.since(0).filter((e) => e.ev.kind === 'turn.end').length;
    assert.equal(n, 3, '다시 띄워도 같은 세션의 대화');
  } finally { c?.close(); await core.close('test'); }
  prov.srv.closeAllConnections(); prov.srv.close();
  process.env = saved;
});

test('setVendor: 공식 Claude 세션에서 첫 메시지 전에 프로바이더 모델을 고르면 meta.provider·model 이 바뀌고, 공식으로 돌아가면 지워진다', { timeout: 120000 }, async () => {
  const prov = await fakeMessages();
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  const dir = tmp('slcode-provv-'), work = tmp('slcode-provv-work-');
  Object.assign(process.env, { HOME: tmp('slcode-provv-home-'), SLCODE_DIR: dir, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE', ANTHROPIC_BASE_URL: prov.url, SLCODE_GRACE_SECS: '1', SLCODE_CLAUDE_PEER: '0' });
  saveProvider(dir, { name: 'Fake', vendor: 'claude', baseUrl: prov.url, key: 'k', models: ['fake/alpha', 'fake/beta'] });
  const { serveSession } = await import('../src/serve.ts');
  const { connectSession } = await import('../src/client.ts');
  const { EventLog } = await import('../src/eventLog.ts');
  const { corePaths } = await import('../src/paths.ts');
  const h = await serveSession({ dir, cwd: work, vendor: 'claude', web: false });
  const id = h.session.id;
  const meta = () => EventLog.open(corePaths(dir).sessionsDir, id)!.meta;
  try {
    const c = await connectSession(h.sock);
    await c.request('session.attach', { id });
    await assert.rejects(c.request('session.setVendor', { id, vendor: 'codex', provider: 'fake' }), /runs on claude/);
    await c.request('session.setVendor', { id, vendor: 'claude', provider: 'fake', model: 'fake/beta' });
    await until(() => meta().provider === 'fake');
    assert.equal(meta().model, 'fake/beta'); assert.equal(meta().vendor, 'claude');
    c.close();
    // core 가 바뀐 뒤 새 소켓으로 — 공식으로 되돌린다
    await until(() => { try { return fs.existsSync(h.sock); } catch { return false; } });
    const c2 = await connectSession(h.sock);
    await until(() => true);
    await c2.request('session.attach', { id }).catch(async () => { await sleep(500); return c2.request('session.attach', { id }); });
    await c2.request('session.setVendor', { id, vendor: 'claude' });
    await until(() => meta().provider === undefined);
    assert.equal(meta().model, undefined);
    c2.close();
  } finally {
    // 바뀐 core 는 serve 가 아니라 새 소켓에 있다 — 직접 닫는다
    await connectSession(h.sock).then(async (x) => { await x.request('session.close', { id }).catch(() => {}); x.close(); }, () => {});
    await h.close('test'); prov.srv.closeAllConnections(); prov.srv.close(); process.env = saved;
  }
});
