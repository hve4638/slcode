// 플러그인 바이너리 자가 설치 (ticket slcode-plugin-selfinstall) — repo 루트 main.js 의 순수 함수와, 가짜 api 로 돌린 activate 의 설치 흐름.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — 빌드 없는 JS 플러그인
import * as mod from '../../main.js';

// repo 루트에 package.json 이 없어 tsx 가 main.js 를 CJS 로 감싼다 — named export 가 default 아래로 온다
const plugin = mod.default ?? mod;

const { satisfies, pickRelease, installState, platformOf, assetName } = plugin;

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

test('installState: 없음·조건 밖·설치됨', () => {
  assert.equal(installState(undefined, '^0.1.0'), 'none');
  assert.equal(installState({}, '^0.1.0'), 'none');
  assert.equal(installState({ version: '0.0.9' }, '^0.1.0'), 'outdated');
  assert.equal(installState({ version: '0.1.4' }, '^0.1.0'), 'installed');
});

test('platformOf: cmd·uname 출력', () => {
  assert.equal(platformOf('%OS% %PROCESSOR_ARCHITECTURE%', 'Linux x86_64'), 'linux-x64');
  assert.equal(platformOf('Windows_NT AMD64', ''), 'win-x64');
  assert.throws(() => platformOf('Windows_NT ARM64', ''), /Windows 아키텍처/);
  assert.throws(() => platformOf('%OS%', 'Darwin arm64'), /지원하지 않는 플랫폼/);
  assert.throws(() => platformOf('%OS%', 'Linux aarch64'), /지원하지 않는 플랫폼/);
});

// ---- activate 의 설치 흐름 — 가짜 api·fetch. 받기·deploy 는 아직 relay API 가 없어 거부되는 자리라, 어디까지 갔는지로 상태를 본다
type Call = string;
function fakeApi(storage: Record<string, unknown>, settings: Record<string, string> = {}) {
  const calls: Call[] = [];
  const noop = () => {};
  const api = {
    settings: { register: noop, get: async (k: string) => settings[k] },
    storage: { get: async (k: string) => storage[k], set: async (k: string, v: unknown) => { storage[k] = v; calls.push(`storage.set ${k}`); } },
    proc: {
      run: async (cmd: string) => {
        calls.push(`proc ${cmd}`);
        if (cmd.startsWith('echo %OS%')) return { code: 0, stdout: '%OS% %PROCESSOR_ARCHITECTURE%\n', stderr: '', truncated: false };
        if (cmd === 'uname -sm') return { code: 0, stdout: 'Linux x86_64\n', stderr: '', truncated: false };
        return { code: 0, stdout: '[]', stderr: '', truncated: false };
      },
    },
    services: { onMessage: () => noop },
    views: { register: noop, open: noop },
    events: { on: noop },
    sidebar: { register: noop, setBadge: (_id: string, n: unknown) => calls.push(`badge ${n}`) },
    commands: { register: noop },
    notify: noop,
  };
  return { api, calls };
}
const releases = [rel('v0.1.0', ['linux-x64', 'win-x64']), rel('v0.1.2', ['linux-x64', 'win-x64'])];
function stubFetch(calls: Call[]) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL) => {
    const s = String(u);
    calls.push(`fetch ${s.startsWith('file:') ? 'plugin.json' : s}`);
    if (s.startsWith('file:')) return new Response(JSON.stringify({ binary: { repo: 'hve4638/slcode', version: '^0.1.0' } }));
    if (s.includes('api.github.com')) return new Response(JSON.stringify(releases));
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test('activate: 표식이 없으면 GitHub 에서 고른 release 를 받으러 간다 (받기 API 자리에서 멈춘다)', async () => {
  const storage: Record<string, unknown> = {};
  const { api, calls } = fakeApi(storage);
  const restore = stubFetch(calls);
  try {
    plugin.activate(api);
    await settle();
    assert.ok(calls.includes('proc uname -sm'));
    assert.ok(calls.includes('fetch https://api.github.com/repos/hve4638/slcode/releases?per_page=100'));
    assert.equal(storage.binary, undefined); // 받기가 실패하면 표식을 남기지 않는다
    assert.ok(!calls.some((c) => c.includes(' list')));
  } finally { restore(); plugin.deactivate(); }
});

test('activate: 조건 안의 표식이 있으면 조회 없이 deploy 로 간다, 조건 밖이면 다시 받는다', async () => {
  for (const [marker, refetch] of [[{ version: '0.1.0' }, false], [{ version: '0.0.1' }, true]] as const) {
    const { api, calls } = fakeApi({ binary: { 'linux-x64': marker } });
    const restore = stubFetch(calls);
    try {
      plugin.activate(api);
      await settle();
      assert.equal(calls.some((c) => c.includes('api.github.com')), refetch);
    } finally { restore(); plugin.deactivate(); }
  }
});

test('activate: 설정 bin 이 있으면 받지 않고 그 명령을 쓴다', async () => {
  const { api, calls } = fakeApi({}, { bin: '/opt/slcode/bin/slcode' });
  const restore = stubFetch(calls);
  try {
    plugin.activate(api);
    await settle();
    assert.ok(calls.includes('proc /opt/slcode/bin/slcode list'));
    assert.ok(!calls.some((c) => c.includes('api.github.com') || c.includes('uname')));
  } finally { restore(); plugin.deactivate(); }
});
