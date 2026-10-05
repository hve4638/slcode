// 플러그인 바이너리 자가 설치 (ticket slcode-plugin-selfinstall) — repo 루트 main.js 의 순수 함수와, 가짜 api 로 돌린 activate 의 설치 흐름.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — 빌드 없는 JS 플러그인
import * as mod from '../../main.js';

// repo 루트에 package.json 이 없어 tsx 가 main.js 를 CJS 로 감싼다 — named export 가 default 아래로 온다
const plugin = mod.default ?? mod;

const { satisfies, pickRelease, installState, platformOf, assetName, progressText } = plugin;

test('satisfies: 고정·^·~ 조건', () => {
  assert.equal(satisfies('0.1.0', '0.1.0'), true);
  assert.equal(satisfies('0.1.1', '0.1.0'), false);
  assert.equal(satisfies('0.1.5', '^0.1.0'), true);
  assert.equal(satisfies('0.2.0', '^0.1.0'), false); // 0.x 의 ^ 는 minor 고정
  assert.equal(satisfies('0.0.9', '^0.1.0'), false);
  assert.equal(satisfies('1.9.0', '^1.2.0'), true);
  assert.equal(satisfies('2.0.0', '^1.2.0'), false);
  assert.equal(satisfies('0.0.3', '^0.0.3'), true);
  assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  assert.equal(satisfies('1.2.9', '~1.2.0'), true);
  assert.equal(satisfies('1.3.0', '~1.2.0'), false);
  assert.equal(satisfies('0.2.0-rc.1', '^0.1.0'), false); // 범위는 정식 release 만
  assert.equal(satisfies('0.2.0-rc.1', '0.2.0-rc.1'), true); // 고정은 그 하나
  assert.equal(satisfies('garbage', '^0.1.0'), false);
  assert.throws(() => satisfies('0.1.0', '>=0.1'), /조건을 읽을 수 없습니다/);
});

const rel = (tag: string, plats: string[], extra: object = {}) => ({
  tag_name: tag, draft: false, prerelease: false,
  assets: plats.map((p) => ({ name: assetName(tag.slice(1), p), browser_download_url: `https://dl/${tag}/${p}.zip` })),
  ...extra,
});

test('pickRelease: 조건 안의 최신, 그 플랫폼 자산', () => {
  const rs = [rel('v0.1.0', ['linux-x64', 'win-x64']), rel('v0.1.3', ['linux-x64', 'win-x64']), rel('v0.2.0', ['linux-x64', 'win-x64']), rel('v0.1.2', ['linux-x64'])];
  assert.deepEqual(pickRelease(rs, '^0.1.0', 'linux-x64'), { version: '0.1.3', url: 'https://dl/v0.1.3/linux-x64.zip' });
  assert.deepEqual(pickRelease(rs, '0.1.2', 'linux-x64'), { version: '0.1.2', url: 'https://dl/v0.1.2/linux-x64.zip' });
  assert.match(pickRelease(rs, '0.1.2', 'win-x64').error, /slcode-0\.1\.2-win-x64\.zip 가 없습니다/);
  assert.match(pickRelease(rs, '^1.0.0', 'linux-x64').error, /맞는 slcode release 가 없습니다/);
});

test('pickRelease: draft·v 없는 태그·이상한 응답은 건너뛴다', () => {
  const rs = [rel('v0.1.9', ['linux-x64'], { draft: true }), rel('0.1.8', ['linux-x64']), { tag_name: 'v0.1.1' }, rel('v0.1.1', ['linux-x64'])];
  assert.equal(pickRelease(rs, '^0.1.0', 'linux-x64').version, '0.1.1');
  assert.ok(pickRelease({ message: 'Not Found' }, '^0.1.0', 'linux-x64').error);
});

const mf = (version: string, platform = 'linux-x64') => JSON.stringify({ version, platform, node: '24.21.0' });

test('installState: manifest 원문 → 없음·조건 밖·설치됨', () => {
  assert.equal(installState(null, '^0.1.0', 'linux-x64'), 'none');
  assert.equal(installState('{broken', '^0.1.0', 'linux-x64'), 'none');
  assert.equal(installState(mf('0.1.4', 'win-x64'), '^0.1.0', 'linux-x64'), 'none'); // 다른 플랫폼 zip
  assert.equal(installState(mf('0.0.9'), '^0.1.0', 'linux-x64'), 'outdated');
  assert.equal(installState(mf('0.1.4'), '^0.1.0', 'linux-x64'), 'installed');
});

test('platformOf: api.platform 의 Rust 표기 → zip 플랫폼', () => {
  assert.equal(platformOf({ os: 'linux', arch: 'x86_64' }), 'linux-x64');
  assert.equal(platformOf({ os: 'windows', arch: 'x86_64' }), 'win-x64');
  assert.throws(() => platformOf({ os: 'linux', arch: 'aarch64' }), /지원하지 않는 플랫폼입니다: linux\/aarch64/);
  assert.throws(() => platformOf({ os: 'macos', arch: 'aarch64' }), /지원하지 않는 플랫폼/);
});

test('progressText: 받기(전체 크기 있음·없음)·풀기', () => {
  assert.equal(progressText('0.1.0', 'linux-x64', { phase: 'download', done: 68157440, total: 160346161 }), 'slcode 0.1.0 (linux-x64) 받는 중 42% (65/153MB)');
  assert.equal(progressText('0.1.0', 'linux-x64', { phase: 'download', done: 68157440, total: null }), 'slcode 0.1.0 (linux-x64) 받는 중 65MB');
  assert.equal(progressText('0.1.0', 'linux-x64', { phase: 'extract', done: 1200, total: 3400 }), 'slcode 0.1.0 (linux-x64) 푸는 중 1200/3400');
});

// ---- activate 의 설치 흐름 — 가짜 api(folder·platform)·fetch(GitHub). activate 의 사이드바 목록 갱신이 resolveBin 을 타므로
// 마지막 `<slcode> list` 호출로 조립된 명령을 본다
type Call = string;
const releases = [rel('v0.1.0', ['linux-x64', 'win-x64']), rel('v0.1.2', ['linux-x64', 'win-x64'])];
function fakeApi(files: Record<string, string>, opts: { settings?: Record<string, string>; fetched?: unknown; noFolder?: boolean } = {}) {
  const calls: Call[] = [];
  const noop = () => {};
  const api: Record<string, unknown> = {
    settings: { register: noop, get: async (k: string) => opts.settings?.[k] },
    storage: { get: async () => undefined, set: async () => {} },
    proc: { run: async (cmd: string) => { calls.push(`proc ${cmd}`); return { code: 0, stdout: '[]', stderr: '', truncated: false }; } },
    services: { onMessage: () => noop },
    views: { register: noop, open: noop },
    events: { on: noop },
    sidebar: { register: noop, setBadge: noop },
    commands: { register: noop },
    notify: (sev: string, msg: string) => calls.push(`notify ${sev} ${msg}`),
    platform: async () => { calls.push('platform'); return { os: 'linux', arch: 'x86_64' }; },
    folder: {
      path: '/host/plugins/slcode',
      read: async (rel: string) => files[rel] ?? null,
      fetch: async (url: string, sub: string, o: { onProgress?: (p: unknown) => void }) => {
        calls.push(`fetch ${url} -> ${sub}`);
        o.onProgress?.({ phase: 'download', done: 1, total: 2 });
        const m = opts.fetched ?? { version: '0.1.2', platform: 'linux-x64', node: '24.21.0' };
        files[`${sub}/manifest.json`] = JSON.stringify(m);
        return { manifest: m };
      },
      deploy: async (sub: string) => { calls.push(`deploy ${sub}`); return `/remote/cache/slcode/abc123`; },
    },
  };
  if (opts.noFolder) { delete api.folder; delete api.platform; }
  return { api, calls };
}
function stubGithub(calls: Call[]) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) => {
    calls.push(`github ${String(u)}`);
    return new Response(JSON.stringify(releases));
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}
const PLUGIN_JSON = JSON.stringify({ id: 'slcode', binary: { repo: 'hve4638/slcode', version: '^0.1.0' } });
const settle = () => new Promise((r) => setTimeout(r, 50));
async function run(files: Record<string, string>, opts: Parameters<typeof fakeApi>[1] = {}) {
  const { api, calls } = fakeApi(files, opts);
  const restore = stubGithub(calls);
  try { plugin.activate(api); await settle(); } finally { restore(); plugin.deactivate(); }
  return calls;
}
const LIST = "proc '/remote/cache/slcode/abc123/bin/slcode' list";

test('activate: manifest 가 없으면 조건 안 최신 release 를 받아 deploy 경로의 bin/slcode 를 쓴다', async () => {
  const files: Record<string, string> = { 'plugin.json': PLUGIN_JSON };
  const calls = await run(files);
  assert.ok(calls.includes('github https://api.github.com/repos/hve4638/slcode/releases?per_page=100'));
  assert.ok(calls.includes('fetch https://dl/v0.1.2/linux-x64.zip -> bin/linux-x64'));
  assert.ok(calls.includes('deploy bin/linux-x64'));
  assert.ok(calls.includes(LIST));
});

test('activate: 조건 안 manifest 면 조회·받기 없이 deploy, 조건 밖·다른 플랫폼이면 다시 받는다', async () => {
  for (const [manifest, refetch] of [[mf('0.1.0'), false], [mf('0.0.1'), true], [mf('0.1.0', 'win-x64'), true]] as const) {
    const calls = await run({ 'plugin.json': PLUGIN_JSON, 'bin/linux-x64/manifest.json': manifest });
    assert.equal(calls.some((c) => c.startsWith('github ')), refetch, manifest);
    assert.equal(calls.some((c) => c.startsWith('fetch ')), refetch, manifest);
    assert.ok(calls.includes(LIST), manifest);
  }
});

test('activate: 받은 zip 의 manifest 가 고른 release 와 맞지 않으면 실행하지 않는다', async () => {
  const calls = await run({ 'plugin.json': PLUGIN_JSON }, { fetched: { version: '0.1.2', platform: 'win-x64' } });
  assert.ok(calls.some((c) => c.startsWith('fetch ')));
  assert.ok(!calls.some((c) => c.startsWith('deploy ') || c.includes(' list')));
});

test('activate: 설정 bin 이 있으면 받지 않고 그 명령을 쓴다', async () => {
  const calls = await run({ 'plugin.json': PLUGIN_JSON }, { settings: { bin: '/opt/slcode/bin/slcode' } });
  assert.ok(calls.includes('proc /opt/slcode/bin/slcode list'));
  assert.ok(!calls.some((c) => c === 'platform' || c.startsWith('github ') || c.startsWith('fetch ')));
});

test('activate: api.folder 가 없는 superlite 면 받지 않는다 (카드에 사유)', async () => {
  const calls = await run({ 'plugin.json': PLUGIN_JSON }, { noFolder: true });
  assert.ok(!calls.some((c) => c.startsWith('github ') || c.includes(' list')));
});
