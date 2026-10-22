// 플러그인 바이너리 자가 설치 (ticket slcode-plugin-selfinstall) — repo 루트 main.js 의 순수 함수와, 가짜 MainApi 로 돌린 새 방식 main(ticket
// slcode-plugin-v2)의 설치 흐름·셸 동사·승인 알림.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — 빌드 없는 JS 플러그인
import * as mod from '../../main.js';
// @ts-expect-error — 빌드 없는 JS 플러그인 (카드 화면 — 모듈 최상위는 DOM 에 닿지 않는다)
import * as cardMod from '../../views/session.js';

// repo 루트에 package.json 이 없어 tsx 가 main.js 를 CJS 로 감싼다 — named export 가 default 아래로 온다
const plugin = mod.default ?? mod;
const { stamp } = cardMod.default ?? cardMod;

const { satisfies, pickRelease, installState, platformOf, assetName, closedRows } = plugin;

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


// ---- 새 방식 main — 가짜 MainApi(folder·platform·proc·window·services)·fetch(GitHub). 카드 화면이 부르는 host 인터페이스와 셸 동사를 직접 부른다
type Call = string;
const releases = [rel('v0.1.0', ['linux-x64', 'win-x64']), rel('v0.1.2', ['linux-x64', 'win-x64'])];
function fakeApi(files: Record<string, string>, opts: { settings?: Record<string, string>; fetched?: unknown; services?: unknown[]; tmuxWin?: boolean } = {}) {
  const calls: Call[] = [];
  const exposed: Record<string, any> = {}; const verbs: Record<string, any> = {};
  const win = (id: string) => ({ id, call: async (iface: string, method: string, arg: unknown) => { calls.push(`call ${id} ${iface}.${method} ${JSON.stringify(arg)}`); } });
  const api = {
    settings: { get: async (k: string) => opts.settings?.[k], onChange: () => () => {} },
    storage: { get: async () => undefined, set: async () => {} },
    proc: { run: async (cmd: string) => { calls.push(`proc ${cmd}`); return { code: 0, stdout: '[]', stderr: '', truncated: false }; } },
    services: { list: async () => opts.services ?? [] },
    verbs: { handle: (name: string, run: unknown) => { verbs[name] = run; } },
    expose: (name: string, impl: unknown) => { exposed[name] = impl; return () => {}; },
    notify: (sev: string, msg: string) => calls.push(`notify ${sev} ${msg}`),
    window: { main: async (u?: { tmux?: string }) => { calls.push(`window ${u?.tmux ?? '-'}`); return u?.tmux && !opts.tmuxWin ? null : win(u?.tmux ? `w${u.tmux}` : 'wmain'); } },
    platform: async () => { calls.push('platform'); return { os: 'linux', arch: 'x86_64' }; },
    folder: {
      path: '/host/plugins/slcode',
      read: async (rel: string) => files[rel] ?? null,
      fetch: async (url: string, sub: string) => {
        calls.push(`fetch ${url} -> ${sub}`);
        const m = opts.fetched ?? { version: '0.1.2', platform: 'linux-x64', node: '24.21.0' };
        files[`${sub}/manifest.json`] = JSON.stringify(m);
        return { manifest: m };
      },
      deploy: async (sub: string) => { calls.push(`deploy ${sub}`); return `/remote/cache/slcode/abc123`; },
    },
  };
  return { api, calls, exposed, verbs };
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
/** activate 한 뒤 fn — 끝나면 deactivate */
async function withMain(files: Record<string, string>, opts: Parameters<typeof fakeApi>[1], fn: (f: ReturnType<typeof fakeApi>) => Promise<void>) {
  const f = fakeApi(files, opts);
  const restore = stubGithub(f.calls);
  try { plugin.activate(f.api); await fn(f); } finally { restore(); plugin.deactivate(); }
  return f.calls;
}
const listed = (files: Record<string, string>, opts: Parameters<typeof fakeApi>[1] = {}) =>
  withMain(files, opts, async ({ exposed }) => { await exposed.host.list(false).catch(() => {}); });
const LIST = "proc '/remote/cache/slcode/abc123/bin/slcode' list";

test('main: manifest 가 없으면 조건 안 최신 release 를 받아 deploy 경로의 bin/slcode 를 쓴다', async () => {
  const calls = await listed({ 'plugin.json': PLUGIN_JSON });
  assert.ok(calls.includes('github https://api.github.com/repos/hve4638/slcode/releases?per_page=100'));
  assert.ok(calls.includes('fetch https://dl/v0.1.2/linux-x64.zip -> bin/linux-x64'));
  assert.ok(calls.includes('deploy bin/linux-x64'));
  assert.ok(calls.includes(LIST));
});

test('main: 조건 안 manifest 면 조회·받기 없이 deploy, 조건 밖·다른 플랫폼이면 다시 받는다', async () => {
  for (const [manifest, refetch] of [[mf('0.1.0'), false], [mf('0.0.1'), true], [mf('0.1.0', 'win-x64'), true]] as const) {
    const calls = await listed({ 'plugin.json': PLUGIN_JSON, 'bin/linux-x64/manifest.json': manifest });
    assert.equal(calls.some((c) => c.startsWith('github ')), refetch, manifest);
    assert.equal(calls.some((c) => c.startsWith('fetch ')), refetch, manifest);
    assert.ok(calls.includes(LIST), manifest);
  }
});

test('main: 받은 zip 의 manifest 가 고른 release 와 맞지 않으면 실행하지 않는다', async () => {
  const calls = await listed({ 'plugin.json': PLUGIN_JSON }, { fetched: { version: '0.1.2', platform: 'win-x64' } });
  assert.ok(calls.some((c) => c.startsWith('fetch ')));
  assert.ok(!calls.some((c) => c.startsWith('deploy ') || c.includes(' list')));
});

test('main: 설정 bin 이 있으면 받지 않고 그 명령을 쓴다', async () => {
  const calls = await listed({ 'plugin.json': PLUGIN_JSON }, { settings: { bin: '/opt/slcode/bin/slcode' } });
  assert.ok(calls.includes('proc /opt/slcode/bin/slcode list'));
  assert.ok(!calls.some((c) => c === 'platform' || c.startsWith('github ') || c.startsWith('fetch ')));
});

test('main command: 카드 서비스 명령 — new 는 폴더·옵션, resume 은 id, 핸드오프는 --takeover, 설정 dir 은 --dir', async () => {
  const files = { 'plugin.json': PLUGIN_JSON, 'bin/linux-x64/manifest.json': mf('0.1.0') };
  await withMain(files, { settings: { dir: '/d x' } }, async ({ exposed }) => {
    const bin = "'/remote/cache/slcode/abc123/bin/slcode'";
    assert.equal(await exposed.host.command({ spawn: { cwd: '/w s', vendor: 'codex', title: 'T', model: 'gpt-x' } }), `${bin} new '/w s' --vendor 'codex' --title 'T' --model 'gpt-x' --stdio --no-web --dir '/d x'`);
    assert.equal(await exposed.host.command({ id: 'sess-1', takeover: true }), `${bin} resume 'sess-1' --stdio --no-web --takeover --dir '/d x'`);
    assert.equal(await exposed.host.command({ takeover: true }), `${bin} new --stdio --no-web --dir '/d x'`, 'id 없는 takeover 는 무시');
  });
});

test('closedRows: resume 카드 목록 — 그 폴더의 꺼진 세션만, closedAt·updatedAt 중 늦은 쪽 내림차순', () => {
  const row = (id: string, o: object) => ({ id, cwd: '/w', live: false, updatedAt: 0, closedAt: null, ...o });
  const rows = [
    row('a', { closedAt: 300, updatedAt: 100 }), row('b', { updatedAt: 500 }), // 옛 세션(closedAt 없음)은 updatedAt
    row('c', { closedAt: 100, updatedAt: 400 }), // 다시 띄운 뒤 비정상 종료 — 더 늦은 updatedAt
    row('d', { updatedAt: 900, live: true }), row('e', { updatedAt: 900, cwd: '/w/x' }),
  ];
  assert.deepEqual(closedRows(rows, '/w').map((r: any) => r.id), ['b', 'c', 'a']);
  assert.equal(stamp(new Date(2026, 9, 11, 1, 2, 59).getTime()), '2026-10-11 01:02', 'CLI 목록과 같은 표기');
});

// ---- 셸 동사 — main 이 요청자 터미널의 메인 창 renderer(slcode/cards)에 카드를 열게 한다
test('slcode.resume 동사: --id 는 그 세션 카드를 요청자 창에 열고 id 를 돌려준다, 없으면 그 폴더의 꺼진 세션을 고르는 카드', async () => {
  const files = { 'plugin.json': PLUGIN_JSON };
  const calls = await withMain(files, { tmuxWin: true }, async ({ verbs }) => {
    assert.equal(await verbs['slcode.resume']({ id: 'sess-1' }, { cwd: '/home', tmux: '$3' }), 'sess-1');
    assert.equal(await verbs['slcode.resume']({ cwd: '/w s' }, { cwd: '/home', tmux: null }), undefined);
    assert.equal(await verbs['slcode.resume']({}, { cwd: '/home/me', tmux: '$3' }), undefined);
  });
  assert.ok(calls.includes('call w$3 slcode/cards.open {"id":"sess-1","tmux":"$3"}'));
  assert.ok(calls.includes('call wmain slcode/cards.open {"pick":"/w s","tmux":null}'), 'tmux 없는 요청자는 이 머신의 메인 창');
  assert.ok(calls.includes('call w$3 slcode/cards.open {"pick":"/home/me","tmux":"$3"}'), '폴더 기본값은 요청자 cwd');
});

test('slcode.resume 동사: 요청자 터미널을 연 창이 없으면 동사 오류', async () => {
  await withMain({ 'plugin.json': PLUGIN_JSON }, {}, async ({ verbs }) => {
    await assert.rejects(verbs['slcode.resume']({ id: 'x' }, { cwd: '/', tmux: '$3' }), /이 터미널을 연 superlite 창이 없습니다/);
  });
});

test('slcode.new 동사: 요청자 창에 key·폴더·옵션으로 카드를 열고, 카드 화면이 started 로 알린 세션 id 를 돌려준다 (두 번째 started 는 무시)', async () => {
  await withMain({ 'plugin.json': PLUGIN_JSON }, { tmuxWin: true }, async ({ verbs, exposed, calls }) => {
    const out = verbs['slcode.new']({ cwd: '/w s', vendor: 'codex', title: 'T' }, { cwd: '/home', tmux: '$3' });
    await new Promise((r) => setTimeout(r, 10));
    const open = calls.find((c) => c.startsWith('call w$3 slcode/cards.open '))!;
    const arg = JSON.parse(open.slice('call w$3 slcode/cards.open '.length));
    assert.deepEqual(arg.spawn, { cwd: '/w s', vendor: 'codex', title: 'T' });
    assert.equal(arg.tmux, '$3'); assert.equal(arg.title, 'T'); assert.match(arg.key, /^s/);
    exposed.host.started(arg.key, 'sess-9');
    exposed.host.started(arg.key, 'sess-other');
    assert.equal(await out, 'sess-9');
    // 기동 실패는 동사 오류로
    const bad = verbs['slcode.new']({}, { cwd: '/home/me', tmux: '$3' });
    await new Promise((r) => setTimeout(r, 10));
    const arg2 = JSON.parse(calls.filter((c) => c.startsWith('call w$3 slcode/cards.open ')).at(-1)!.slice('call w$3 slcode/cards.open '.length));
    assert.equal(arg2.spawn.cwd, '/home/me', '폴더 기본값은 요청자 cwd');
    exposed.host.failed(arg2.key, '받기 실패');
    await assert.rejects(bad, /받기 실패/);
  });
});

// ---- 승인 알림 (사용자 2026-10-21 — 창 하나에만) — 같은 카드를 연 창마다 카드 화면이 알려도 한 번. 그 카드 서비스의 tmux 로 창을 고르고, 못 고르면 이 머신의 메인 창
test('main approval: 같은 요청은 한 번만, 카드 서비스의 메인 창(없으면 머신의 메인 창) renderer 에', async () => {
  const services = [{ service: 'session', owner: 'card-A', id: '$9' }, { service: 'session', owner: 'card-B', id: '$8' }];
  const a = { owner: 'card-A', requestId: 'r1', key: 'sA', id: 'sess-A', message: '승인 대기: Bash ls' };
  let calls = await withMain({ 'plugin.json': PLUGIN_JSON }, { services, tmuxWin: true }, async ({ exposed }) => {
    await exposed.host.approval(a);
    await exposed.host.approval(a); // 다른 창의 같은 카드
    await exposed.host.approval({ ...a, owner: 'card-B' }); // 다른 카드의 같은 requestId 는 따로
  });
  assert.deepEqual(calls.filter((c) => c.startsWith('call ')), [
    `call w$9 slcode/cards.notify ${JSON.stringify({ key: 'sA', id: 'sess-A', message: a.message })}`,
    `call w$8 slcode/cards.notify ${JSON.stringify({ key: 'sA', id: 'sess-A', message: a.message })}`,
  ]);
  // 서비스 tmux 로 창을 고르지 못하는 superlite(v47 이하) — 이 머신의 메인 창
  calls = await withMain({ 'plugin.json': PLUGIN_JSON }, { services }, async ({ exposed }) => { await exposed.host.approval(a); });
  assert.deepEqual(calls.filter((c) => c.startsWith('window ') || c.startsWith('call ')), ['window $9', 'window -', `call wmain slcode/cards.notify ${JSON.stringify({ key: 'sA', id: 'sess-A', message: a.message })}`]);
});
