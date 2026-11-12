// 플러그인 바이너리 자가 설치 (ticket slcode-plugin-selfinstall) — repo 루트 main.js 의 순수 함수와, 가짜 MainApi 로 돌린 새 방식 main(ticket
// slcode-plugin-v2)의 설치 흐름·셸 동사·승인 알림.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — 빌드 없는 JS 플러그인
import * as mod from '../../main.js';
// @ts-expect-error — 빌드 없는 JS 플러그인 (카드 화면 — 모듈 최상위는 DOM 에 닿지 않는다)
import * as cardMod from '../../views/session.js';
// @ts-expect-error — 빌드 없는 JS 플러그인
import * as rendererMod from '../../renderer.js';

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

test('pickRelease: arm64·x64 가 각자의 자산을 고르고, arm64 자산이 없는 옛 release 는 건너뛴다', () => {
  const rs = [rel('v0.5.6', ['linux-x64', 'win-x64']), rel('v0.5.7', ['linux-x64', 'linux-arm64', 'win-x64'])];
  assert.deepEqual(pickRelease(rs, '^0.5.6', 'linux-arm64'), { version: '0.5.7', url: 'https://dl/v0.5.7/linux-arm64.zip' });
  assert.deepEqual(pickRelease(rs, '^0.5.6', 'linux-x64'), { version: '0.5.7', url: 'https://dl/v0.5.7/linux-x64.zip' });
  assert.match(pickRelease(rs.slice(0, 1), '^0.5.6', 'linux-arm64').error, /slcode-0\.5\.6-linux-arm64\.zip 가 없습니다/);
  assert.equal(pickRelease(rs.slice(0, 1), '^0.5.6', 'linux-x64').version, '0.5.6');
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
  assert.equal(platformOf({ os: 'linux', arch: 'aarch64' }), 'linux-arm64');
  assert.throws(() => platformOf({ os: 'windows', arch: 'aarch64' }), /지원하지 않는 플랫폼입니다: windows\/aarch64/);
  assert.throws(() => platformOf({ os: 'macos', arch: 'aarch64' }), /지원하지 않는 플랫폼/);
});


// ---- 새 방식 main — 가짜 MainApi(folder·platform·proc·window)·fetch(GitHub). 카드 화면이 부르는 host 인터페이스와 셸 동사를 직접 부른다
type Call = string;
const releases = [rel('v0.1.0', ['linux-x64', 'win-x64']), rel('v0.1.2', ['linux-x64', 'linux-arm64', 'win-x64'])];
function fakeApi(files: Record<string, string>, opts: { settings?: Record<string, string>; fetched?: unknown; arch?: string; tmuxWin?: boolean; run?: (cmd: string) => { code: number; stdout: string; stderr: string } | undefined; windows?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const exposed: Record<string, any> = {}; const verbs: Record<string, any> = {};
  const win = (id: string) => ({ id, call: async (iface: string, method: string, arg: unknown) => { calls.push(`call ${id} ${iface}.${method} ${JSON.stringify(arg)}`); return opts.windows?.[id]; } });
  const api = {
    settings: { get: async (k: string) => opts.settings?.[k], onChange: () => () => {} },
    storage: { get: async () => undefined, set: async () => {} },
    proc: { run: async (cmd: string) => { calls.push(`proc ${cmd}`); return { code: 0, stdout: '[]', stderr: '', ...opts.run?.(cmd), truncated: false }; } },
    verbs: { handle: (name: string, run: unknown) => { verbs[name] = run; } },
    expose: (name: string, impl: unknown) => { exposed[name] = impl; return () => {}; },
    notify: (sev: string, msg: string) => calls.push(`notify ${sev} ${msg}`),
    window: {
      main: async (u?: { tmux?: string }) => { calls.push(`window ${u?.tmux ?? '-'}`); return u?.tmux && !opts.tmuxWin ? null : win(u?.tmux ? `w${u.tmux}` : 'wmain'); },
      all: async () => Object.keys(opts.windows ?? {}).map(win),
    },
    platform: async () => { calls.push('platform'); return { os: 'linux', arch: opts.arch ?? 'x86_64' }; },
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
async function withMain(files: Record<string, string>, opts: Parameters<typeof fakeApi>[1], fn: (f: ReturnType<typeof fakeApi> & { exports?: any }) => Promise<void>) {
  const f: ReturnType<typeof fakeApi> & { exports?: any } = fakeApi(files, opts);
  const restore = stubGithub(f.calls);
  try { f.exports = plugin.activate(f.api); await fn(f); } finally { restore(); plugin.deactivate(); }
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

test('main: aarch64 는 linux-arm64 zip 을 받고 터미널 명령 자리(bin/linux-x64)에 링크를 둔다, x64 는 링크를 만들지 않는다', async () => {
  const LN = "proc ln -sfn linux-arm64 '/remote/cache/slcode/abc123/../linux-x64'";
  const arm = await listed({ 'plugin.json': PLUGIN_JSON }, { arch: 'aarch64', fetched: { version: '0.1.2', platform: 'linux-arm64', node: '24.21.0' } });
  assert.ok(arm.includes('fetch https://dl/v0.1.2/linux-arm64.zip -> bin/linux-arm64'));
  assert.ok(arm.includes('deploy bin/linux-arm64'));
  assert.ok(arm.includes(LN));
  assert.ok(arm.includes(LIST));
  const x64 = await listed({ 'plugin.json': PLUGIN_JSON });
  assert.ok(!x64.some((c) => c.includes('ln -sfn')));
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
    // effort 는 옵션, 첫 프롬프트는 맨 끝 -- 뒤에 (ticket slcode-new-effort-prompt) — resume 에는 싣지 않는다
    assert.equal(await exposed.host.command({ spawn: { cwd: '/w', effort: 'high', prompt: "fix the 'login' bug\nnow" } }), `${bin} new '/w' --effort 'high' --stdio --no-web --dir '/d x' -- 'fix the '\\''login'\\'' bug\nnow'`);
    assert.equal(await exposed.host.command({ id: 'sess-1', spawn: { prompt: 'x' } }), `${bin} resume 'sess-1' --stdio --no-web --dir '/d x'`);
    // 세션 env 는 쌍마다 --env (ticket slcode-new-session-env) — resume 에는 싣지 않는다
    assert.equal(await exposed.host.command({ spawn: { cwd: '/w', env: ['A=1', "B=it's"] } }), `${bin} new '/w' --env 'A=1' --env 'B=it'\\''s' --stdio --no-web --dir '/d x'`);
    assert.equal(await exposed.host.command({ id: 'sess-1', spawn: { env: ['A=1'] } }), `${bin} resume 'sess-1' --stdio --no-web --dir '/d x'`);
    // 세션 인자는 쌍마다 --param (ticket slcode-agent-plugin-part-when) — resume 에는 싣지 않는다
    assert.equal(await exposed.host.command({ spawn: { cwd: '/w', params: ['ORCH_ROLE=worker', 'B=x y'] } }), `${bin} new '/w' --param 'ORCH_ROLE=worker' --param 'B=x y' --stdio --no-web --dir '/d x'`);
    assert.equal(await exposed.host.command({ id: 'sess-1', spawn: { params: ['A=1'] } }), `${bin} resume 'sess-1' --stdio --no-web --dir '/d x'`);
  });
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

test('slcode.team 동사: --leader 를 SLCODE_SESSION_ID 로 slcode team new 를 요청자 cwd 에서 돌리고, 팀원 카드를 요청자 창에 열고 id 를 돌려준다 (ticket slcode-team-plugin-verb)', async () => {
  const files = { 'plugin.json': PLUGIN_JSON };
  const runs: { cmd: string; cwd?: string }[] = [];
  const calls = await withMain(files, { tmuxWin: true, run: (cmd) => (cmd.includes(" 'team' 'new'") ? { code: 0, stdout: 'ab12cd34\n', stderr: 'teammate ab12cd34 started' } : undefined) }, async ({ verbs, api }) => {
    const run = api.proc.run;
    api.proc.run = async (cmd: string, o?: { cwd?: string }) => { runs.push({ cmd, cwd: o?.cwd }); return run(cmd); };
    await assert.rejects(verbs['slcode.team']({ prompt: 'x' }, { cwd: '/w', tmux: '$3' }), /needs --leader/);
    const id = await verbs['slcode.team']({ leader: 'L1', teammate: true, worktree: 'feat/x', name: 'w 1', options: '{"notifyEnd":false}', env: 'A=1\nB=2', param: 'P=v', prompt: "it's go" }, { cwd: '/w s', tmux: '$3' });
    assert.equal(id, 'ab12cd34');
    await assert.rejects(verbs['slcode.team']({ leader: 'L1', env: 'SLCODE_X=1' }, { cwd: '/w', tmux: '$3' }), /SLCODE_\* names cannot be given/);
  });
  const team = runs.find((r) => r.cmd.includes(" 'team' 'new'"))!;
  assert.equal(team.cmd, "SLCODE_SESSION_ID='L1' SUPERLITE_SOCK= '/remote/cache/slcode/abc123/bin/slcode' 'team' 'new' '--teammate' '--worktree' 'feat/x' '--name' 'w 1' '--options' '{\"notifyEnd\":false}' '--env' 'A=1' '--env' 'B=2' '--param' 'P=v' -- 'it'\\''s go'");
  assert.equal(team.cwd, '/w s', '요청자 cwd 에서 — --worktree 는 그 checkout 의 HEAD, 상대 --cwd 의 기준');
  assert.ok(calls.includes('call w$3 slcode/cards.open {"id":"ab12cd34","tmux":"$3"}'), '카드는 요청자 deck 에');
});

test('slcode.team 동사: CLI 가 거절하면 그 사유로 throw 하고 카드를 열지 않는다. 카드를 못 열어도 id 를 돌려주고 알린다', async () => {
  const files = { 'plugin.json': PLUGIN_JSON };
  const calls = await withMain(files, { tmuxWin: false, run: (cmd) => (cmd.includes(" 'team' 'new'") ? (cmd.includes("'bad'") ? { code: 1, stdout: '', stderr: '[slcode] session bad is not live\n' } : { code: 0, stdout: 'ab12cd34\n', stderr: '' }) : undefined) }, async ({ verbs }) => {
    await assert.rejects(verbs['slcode.team']({ leader: 'L1', name: 'bad' }, { cwd: '/w', tmux: '$3' }), /^Error: session bad is not live$/);
    assert.equal(await verbs['slcode.team']({ leader: 'L1' }, { cwd: '/w', tmux: '$3' }), 'ab12cd34');
  });
  assert.ok(!calls.some((c) => c.includes('cards.open')));
  assert.ok(calls.some((c) => c.startsWith('notify warning 팀원 ab12cd34 의 카드를 열지 못했습니다')));
});

test('slcode.new 동사: 요청자 창에 key·폴더·옵션으로 카드를 열고, 카드 화면이 started 로 알린 세션 id 를 돌려준다 (두 번째 started 는 무시)', async () => {
  await withMain({ 'plugin.json': PLUGIN_JSON }, { tmuxWin: true }, async ({ verbs, exposed, calls }) => {
    const out = verbs['slcode.new']({ cwd: '/w s', vendor: 'codex', title: 'T' }, { cwd: '/home', tmux: '$3' });
    await new Promise((r) => setTimeout(r, 10));
    const open = calls.find((c) => c.startsWith('call w$3 slcode/cards.open '))!;
    const arg = JSON.parse(open.slice('call w$3 slcode/cards.open '.length));
    assert.deepEqual(arg.spawn, { cwd: '/w s', vendor: 'codex', title: 'T' });
    assert.equal(arg.tmux, '$3'); assert.equal(arg.title, 'T'); assert.match(arg.key, /^s/); assert.equal(arg.focus, undefined, '기본은 포커스 없음');
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
    // effort·첫 프롬프트는 spawn 으로, Claude 의 effort 이름 오타는 카드를 열기 전에 거절 (Codex 는 이름을 보지 않는다)
    const n = calls.length;
    await assert.rejects(verbs['slcode.new']({ effort: 'hgih' }, { cwd: '/w', tmux: '$3' }), /unknown effort 'hgih' for claude \(low\|medium\|high\|xhigh\|max\)/);
    assert.equal(calls.length, n, '카드를 열지 않는다');
    void verbs['slcode.new']({ vendor: 'codex', effort: 'turbo', prompt: 'go' }, { cwd: '/w', tmux: '$3' });
    await new Promise((r) => setTimeout(r, 10));
    const arg3 = JSON.parse(calls.filter((c) => c.startsWith('call w$3 slcode/cards.open ')).at(-1)!.slice('call w$3 slcode/cards.open '.length));
    assert.deepEqual(arg3.spawn, { cwd: '/w', vendor: 'codex', effort: 'turbo', prompt: 'go' });
    assert.equal(arg3.focus, undefined);
    exposed.host.started(arg3.key, 'sess-3');
    // model 의 공급자 앞머리는 벤더를 고르고 떼어 낸다 (임시) — 벤더가 어긋나면 카드를 열기 전에 거절
    void verbs['slcode.new']({ model: 'openai:gpt-5.6-sol', effort: 'minimal' }, { cwd: '/w', tmux: '$3' });
    await new Promise((r) => setTimeout(r, 10));
    const arg4 = JSON.parse(calls.filter((c) => c.startsWith('call w$3 slcode/cards.open ')).at(-1)!.slice('call w$3 slcode/cards.open '.length));
    assert.deepEqual(arg4.spawn, { cwd: '/w', vendor: 'codex', model: 'gpt-5.6-sol', effort: 'minimal' });
    exposed.host.started(arg4.key, 'sess-4');
    // --focus(사람이 친 slcode new)는 renderer 에 focus 로
    void verbs['slcode.new']({ focus: true }, { cwd: '/w', tmux: '$3' });
    await new Promise((r) => setTimeout(r, 10));
    const arg5 = JSON.parse(calls.filter((c) => c.startsWith('call w$3 slcode/cards.open ')).at(-1)!.slice('call w$3 slcode/cards.open '.length));
    assert.equal(arg5.focus, true);
    exposed.host.started(arg5.key, 'sess-5');
    const m = calls.length;
    await assert.rejects(verbs['slcode.new']({ vendor: 'claude', model: 'openai:gpt-x' }, { cwd: '/w', tmux: '$3' }), /is a codex model but --vendor is claude/);
    assert.equal(calls.length, m);
    // --env (ticket slcode-new-session-env) — 한 값의 줄바꿈 쌍, 배열(option 반복을 모으는 superlite)도. 이름 오류·SLCODE_* 는 카드를 열기 전에 거절
    void verbs['slcode.new']({ env: 'A=1\nB=x=y\n' }, { cwd: '/w', tmux: '$3' });
    await new Promise((r) => setTimeout(r, 10));
    const arg6 = JSON.parse(calls.filter((c) => c.startsWith('call w$3 slcode/cards.open ')).at(-1)!.slice('call w$3 slcode/cards.open '.length));
    assert.deepEqual(arg6.spawn.env, ['A=1', 'B=x=y']);
    exposed.host.started(arg6.key, 'sess-6');
    void verbs['slcode.new']({ env: ['A=1', 'B=2'] }, { cwd: '/w', tmux: '$3' });
    await new Promise((r) => setTimeout(r, 10));
    const arg7 = JSON.parse(calls.filter((c) => c.startsWith('call w$3 slcode/cards.open ')).at(-1)!.slice('call w$3 slcode/cards.open '.length));
    assert.deepEqual(arg7.spawn.env, ['A=1', 'B=2']);
    exposed.host.started(arg7.key, 'sess-7');
    const k = calls.length;
    await assert.rejects(verbs['slcode.new']({ env: 'SLCODE_DIR=/x' }, { cwd: '/w', tmux: '$3' }), /SLCODE_\* names cannot be given/);
    await assert.rejects(verbs['slcode.new']({ env: 'A' }, { cwd: '/w', tmux: '$3' }), /needs NAME=VALUE/);
    await assert.rejects(verbs['slcode.new']({ env: '1A=x' }, { cwd: '/w', tmux: '$3' }), /bad env name/);
    assert.equal(calls.length, k, '카드를 열지 않는다');
    // --param (ticket slcode-agent-plugin-part-when) — --env 와 같은 줄바꿈 쌍. 이름 오류·대소문자만 다른 이름은 카드를 열기 전에 거절, SLCODE_ 로 시작해도 된다
    void verbs['slcode.new']({ param: 'ORCH_ROLE=worker\nSLCODE_X=1' }, { cwd: '/w', tmux: '$3' });
    await new Promise((r) => setTimeout(r, 10));
    const arg8 = JSON.parse(calls.filter((c) => c.startsWith('call w$3 slcode/cards.open ')).at(-1)!.slice('call w$3 slcode/cards.open '.length));
    assert.deepEqual(arg8.spawn.params, ['ORCH_ROLE=worker', 'SLCODE_X=1']);
    exposed.host.started(arg8.key, 'sess-8');
    const j = calls.length;
    await assert.rejects(verbs['slcode.new']({ param: 'role=a\nROLE=b' }, { cwd: '/w', tmux: '$3' }), /differ only in case/);
    await assert.rejects(verbs['slcode.new']({ param: 'A' }, { cwd: '/w', tmux: '$3' }), /--param needs NAME=VALUE/);
    await assert.rejects(verbs['slcode.new']({ param: 'A-B=x' }, { cwd: '/w', tmux: '$3' }), /bad param name/);
    assert.equal(calls.length, j, '카드를 열지 않는다');
  });
});

// ---- renderer 카드 열기 (ticket slcode-new-card-no-focus, 사용자 2026-10-25) — 요청자 deck 끝에 조용히 붙이기만 하고 포커스를 옮기는 두 번째 열기는 없다
test('renderer cards.open: tmux 요청자면 views.open 한 번(opener·end), 포커스용 다시 열기 없음', async () => {
  const opens: unknown[][] = [];
  let cards: any;
  const noop = () => {};
  const api = {
    main: { call: async () => [] }, notify: noop, storage: { get: async () => ({ 'sess-1': 'sOld' }) },
    expose: (name: string, impl: unknown) => { if (name === 'cards') cards = impl; },
    sidebar: { register: noop, setBadge: noop }, events: { on: noop }, commands: { register: noop },
    views: { open: async (...a: unknown[]) => { opens.push(a); }, post: noop, onMessage: noop, active: () => null },
  };
  (rendererMod.default ?? rendererMod).activate(api);
  await cards.open({ key: 'sNew', spawn: { cwd: '/w' }, tmux: '$3' });
  assert.equal(opens.length, 1);
  assert.deepEqual(opens[0][2], { as: 'card', key: 'sNew', title: 'SLCode', preserve: true, opener: '$3', end: true });
  // 이미 있는 세션 — 같은 key 로 한 번 연다(코어가 있는 카드를 활성화한다)
  await cards.open({ id: 'sess-1', tmux: '$3' });
  assert.equal(opens.length, 2);
  assert.equal((opens[1][2] as { key: string }).key, 'sOld');
  // 사람이 친 slcode new(--focus) — superlite focus 로 연다 (요청자 터미널을 보고 있을 때만 보인다)
  await cards.open({ key: 'sF', spawn: { cwd: '/w' }, tmux: '$3', focus: true });
  assert.deepEqual(opens[2][2], { as: 'card', key: 'sF', title: 'SLCode', preserve: true, opener: '$3', end: true, focus: true });
});

// ---- 폴더를 고르지 않은 새 세션 (ticket slcode-sidebar-new-stuck) — 사이드바 머리 + 와 팔레트는 워크스페이스 폴더의 시작 화면 카드를 연다
function rendererWith(proc: { code: number | null; stdout: string; stderr: string }, os = 'linux') {
  const opens: any[][] = [], notes: string[] = [], ran: string[] = [], commands: Record<string, () => void> = {};
  let onMsg: (m: unknown, from: unknown) => void = () => {};
  const noop = () => {};
  const api = {
    main: { call: async () => [] }, notify: (_: string, m: string) => { notes.push(m); }, storage: { get: async () => ({}) }, expose: noop,
    sidebar: { register: noop, setBadge: noop }, events: { on: noop }, commands: { register: (c: { id: string; run: () => void }) => { commands[c.id] = c.run; } },
    platform: async () => ({ os, arch: 'x86_64' }), proc: { run: async (cmd: string) => { ran.push(cmd); return { ...proc, truncated: false }; } },
    views: { open: async (...a: unknown[]) => { opens.push(a); }, post: noop, onMessage: (cb: typeof onMsg) => { onMsg = cb; }, active: () => null },
  };
  (rendererMod.default ?? rendererMod).activate(api);
  return { opens, notes, ran, commands, click: (m: unknown) => onMsg(m, { tabId: null, viewId: 'sessions', slot: 'sidebar' }) };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test('renderer: 사이드바 머리 + 는 워크스페이스 폴더의 시작 화면 카드를 연다 (프로필 출력이 앞에 있어도 마지막 줄)', async () => {
  const r = rendererWith({ code: 0, stdout: 'hello from profile\n/w s\n', stderr: '' });
  r.click({ type: 'open' });
  await tick();
  assert.deepEqual(r.ran, ['pwd']);
  assert.equal(r.opens.length, 1);
  assert.equal(r.opens[0][1].start, '/w s');
  assert.equal(r.opens[0][1].spawn, undefined);
  assert.equal(r.opens[0][2].title, 'Start');
});

test('renderer: 팔레트 새 세션도 시작 화면, Windows 는 cd 로 묻는다', async () => {
  const r = rendererWith({ code: 0, stdout: 'C:\\w\r\n', stderr: '' }, 'windows');
  r.commands.new();
  await tick();
  assert.deepEqual(r.ran, ['cd']);
  assert.equal(r.opens[0][1].start, 'C:\\w');
});

test('renderer: 폴더 줄의 + 는 그대로 그 폴더의 새 세션, 폴더를 알지 못하면 카드를 열지 않고 알린다', async () => {
  const ok = rendererWith({ code: 0, stdout: '/w\n', stderr: '' });
  ok.click({ type: 'open', spawn: { cwd: '/f' } });
  await tick();
  assert.deepEqual(ok.ran, []);
  assert.deepEqual(ok.opens[0][1].spawn, { cwd: '/f' });
  const bad = rendererWith({ code: 1, stdout: '', stderr: 'no shell' });
  bad.click({ type: 'open' });
  await tick();
  assert.equal(bad.opens.length, 0);
  assert.deepEqual(bad.notes, ['slcode: no shell']);
});

// ---- 카드 기동 실패 (ticket slcode-sidebar-new-stuck) — 서비스가 응답 전에 끝나면 다시 띄우기를 멈추고 사유를 보인다. 화면은 작은 DOM 흉내로 돌린다
function fakeEl(tag = 'div'): any {
  const el: any = { tag, style: {}, children: [], textContent: '', onclick: null, addEventListener() {}, remove() {}, setAttribute() {} };
  el.append = (...k: any[]) => { el.children.push(...k); };
  el.appendChild = (k: any) => { el.children.push(k); return k; };
  Object.defineProperty(el, 'innerHTML', { set() { el.children = []; }, get: () => '' });
  return el;
}
const textOf = (el: any): string => [el.textContent, ...el.children.map(textOf)].join(' ');
async function mountCard(state: unknown, hostImpl: (method: string, ...a: unknown[]) => unknown = async () => 'cmd') {
  const opens: any[] = [], notes: string[] = [], failed: unknown[][] = [];
  let onMsg: (m: unknown) => void = () => {};
  const g = globalThis as any;
  const saved = { document: g.document, window: g.window };
  g.document = { createElement: fakeEl };
  g.window = { addEventListener() {}, removeEventListener() {} };
  const el = fakeEl();
  const ctx = {
    state, card: 'card-1', tabId: 't1', storage: { get: async () => ({}), set: async () => {} },
    post: async () => {}, onMessage: () => () => {}, setBadge: async () => {}, setTitle: async () => {}, setState: async () => {},
    notify: async (_: string, m: string) => { notes.push(m); },
    main: { call: async (_: string, method: string, ...a: unknown[]) => { if (method === 'failed') failed.push(a); return hostImpl(method, ...a); } },
    services: {
      onMessage: (_: string, cb: typeof onMsg) => { onMsg = cb; return () => {}; },
      send: async () => {},
      open: async () => { const conn: any = { close: async () => {}, closers: [] as ((e: string | null) => void)[], onClose(cb: (e: string | null) => void) { conn.closers.push(cb); } }; opens.push(conn); return conn; },
    },
  };
  (cardMod.default ?? cardMod).mount(el, ctx);
  await tick();
  return { el, opens, notes, failed, msg: (m: unknown) => onMsg(m), exit: async (e: string | null = '서비스 종료') => { for (const cb of opens.at(-1).closers) cb(e); await tick(); }, restore: async () => { (cardMod.default ?? cardMod).unmount(); await tick(); g.document = saved.document; g.window = saved.window; } };
}

test('카드: {fatal} 을 내고 끝나면 다시 띄우지 않고 그 오류와 다시 시도를 보인다, slcode.new 동사에도 실패로 알린다', async () => {
  const c = await mountCard({ key: 'k', id: null, spawn: { cwd: '/gone' } });
  try {
    assert.equal(c.opens.length, 1);
    c.msg({ fatal: 'not a folder: /gone' });
    await c.exit();
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(c.opens.length, 1, '다시 띄우지 않는다');
    assert.match(textOf(c.el), /not a folder: \/gone/);
    assert.match(textOf(c.el), /다시 시도/);
    assert.doesNotMatch(textOf(c.el), /띄우는 중/);
    assert.deepEqual(c.failed, [['k', 'not a folder: /gone']]);
    assert.deepEqual(c.notes, ['slcode: not a folder: /gone']);
  } finally { await c.restore(); }
});

test('카드: 핸드오프의 새 카드가 기동에 실패하면 [다시 시도] 도 --takeover 로 띄운다. 붙은 뒤의 다시 붙기는 takeover 없이 (ticket slcode-update-no-session-old-dir)', async () => {
  const asked: { takeover?: boolean }[] = [];
  const c = await mountCard({ key: 'k', id: 's1', takeover: true, from: 'old' }, async (m, a) => { if (m === 'command') asked.push(a as { takeover?: boolean }); return 'cmd'; });
  const find = (el: any): any => (el.textContent === '다시 시도' ? el : el.children.map(find).find(Boolean));
  try {
    assert.equal(asked.at(-1)?.takeover, true);
    c.msg({ fatal: 'no session s1' });
    await c.exit();
    find(c.el).onclick();
    await tick();
    assert.equal(c.opens.length, 2);
    assert.equal(asked.at(-1)?.takeover, true, '아직 소유권을 가져오지 못했다 — 없이 붙으면 옛 카드를 정리할 때 옛 serve 가 세션을 닫는다');
    c.msg({ url: null, id: 's1', sock: '/s' });
    await c.exit();
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(c.opens.length, 3);
    assert.equal(asked.at(-1)?.takeover, false, '붙은 뒤에는 그 사이 소유권이 다른 카드로 갔을 수 있다');
  } finally { await c.restore(); }
});

test('카드: {fatal} 없이 끝나면 한 번 더 띄워 보고, 또 끝나면 --version 의 stderr 를 보인다', async () => {
  const c = await mountCard({ key: 'k', id: null, spawn: { cwd: '/w' } }, async (m) => (m === 'checkUpdate' ? { status: 'failed', reason: 'sh: slcode: not found' } : 'cmd'));
  try {
    await c.exit();
    assert.doesNotMatch(textOf(c.el), /not found/);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(c.opens.length, 2, '한 번 더 띄운다');
    await c.exit();
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(c.opens.length, 2, '그 뒤로는 띄우지 않는다');
    assert.match(textOf(c.el), /sh: slcode: not found/);
  } finally { await c.restore(); }
});

test('카드: --version 이 돌면 일반 문구, 스스로 끊은 연결(reason null)은 실패로 치지 않는다', async () => {
  const c = await mountCard({ key: 'k', id: null, spawn: { cwd: '/w' } }, async (m) => (m === 'checkUpdate' ? { status: 'latest' } : 'cmd'));
  try {
    await c.exit(null);
    assert.equal(c.notes.length, 0);
    await new Promise((r) => setTimeout(r, 1100));
    await c.exit();
    await new Promise((r) => setTimeout(r, 1100));
    await c.exit();
    await tick();
    assert.match(textOf(c.el), /세션을 시작하기 전에 끝났습니다/);
  } finally { await c.restore(); }
});

test('카드: 붙기 전에 사라져 open 이 거절하면 실제 사유를, --version 이 돌면 거절 문구를 보인다', async () => {
  const g = globalThis as any;
  const saved = { document: g.document, window: g.window };
  g.document = { createElement: fakeEl };
  g.window = { addEventListener() {}, removeEventListener() {} };
  for (const [check, want] of [[{ status: 'failed', reason: 'sh: slcode: not found' }, /sh: slcode: not found/], [{ status: 'latest' }, /실행 중이 아니다/]] as const) {
    const el = fakeEl();
    (cardMod.default ?? cardMod).mount(el, {
      state: { key: 'k', id: 'sess-1' }, card: 'c', tabId: 't', storage: { get: async () => ({}), set: async () => {} },
      post: async () => {}, onMessage: () => () => {}, setBadge: async () => {}, setTitle: async () => {}, setState: async () => {}, notify: async () => {},
      main: { call: async (_: string, m: string) => (m === 'checkUpdate' ? check : 'cmd') },
      services: { onMessage: () => () => {}, send: async () => {}, open: async () => { throw new Error('실행 중이 아니다: slcode/session'); } },
    });
    await tick();
    assert.match(textOf(el), want);
    (cardMod.default ?? cardMod).unmount();
    await tick();
  }
  g.document = saved.document; g.window = saved.window;
});

test('카드: hello 를 본 서비스가 끝나면 지금처럼 다시 붙는다', async () => {
  const c = await mountCard({ key: 'k', id: 'sess-1' });
  try {
    c.msg({ url: null, id: 'sess-1', sock: '/s' });
    await tick();
    await c.exit();
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(c.opens.length, 2, '다시 띄운다');
    assert.equal(c.notes.length, 0);
    assert.doesNotMatch(textOf(c.el), /준비하지 못했습니다/);
  } finally { await c.restore(); }
});

// ---- 승인 요청은 카드 배지로만 (사용자 2026-10-24) — main 은 승인 알림을 받지도 띄우지도 않는다
test('main host: approval 이 없다', async () => {
  await withMain({ 'plugin.json': PLUGIN_JSON }, {}, async ({ exposed }) => { assert.equal(exposed.host.approval, undefined); });
});

// ---- 다른 플러그인용 exports (ticket slcode-close-mail-verbs, 사용자 2026-10-24) — plugins.get('slcode').close·mail
const BIN = '/opt/slcode'; // 설정 bin 은 셸에 그대로
const rows = (live: boolean) => JSON.stringify([{ id: 'w1', live }, { id: 'other', live: true }]);

test('exports.close: 켜진 세션은 slcode close 뒤 메인 창부터 카드가 있는 창을 찾을 때까지 closeCard, 결과 {ok, card}', async () => {
  const calls = await withMain({ 'plugin.json': PLUGIN_JSON }, { settings: { bin: '/opt/slcode' }, run: (c) => (c.includes(' list --all') ? { code: 0, stdout: rows(true), stderr: '' } : undefined), windows: { wa: false, wmain: false, wb: true, wc: true } }, async ({ exports }) => {
    assert.deepEqual(await exports.close('w1'), { ok: true, card: true });
  });
  assert.ok(calls.includes(`proc ${BIN} close 'w1'`));
  const asked = calls.filter((c) => c.includes('closeCard')).map((c) => c.split(' ')[1]);
  assert.deepEqual(asked, ['wmain', 'wa', 'wb'], '메인 창이 먼저, 닫기 요청은 한 창에만');
});

test('exports.close: 이미 꺼진 세션은 close 없이 성공(already) — 카드 닫기 요청은 건다, 카드를 연 창이 없으면 card false', async () => {
  const calls = await withMain({ 'plugin.json': PLUGIN_JSON }, { settings: { bin: '/opt/slcode' }, run: (c) => (c.includes(' list --all') ? { code: 0, stdout: rows(false), stderr: '' } : undefined), windows: { wa: true } }, async ({ exports }) => {
    assert.deepEqual(await exports.close('w1'), { ok: true, already: true, card: true });
  });
  assert.ok(!calls.some((c) => c.includes(' close ')));
  await withMain({ 'plugin.json': PLUGIN_JSON }, { settings: { bin: '/opt/slcode' }, run: (c) => (c.includes(' list --all') ? { code: 0, stdout: rows(false), stderr: '' } : undefined) }, async ({ exports }) => {
    assert.deepEqual(await exports.close('w1'), { ok: true, already: true, card: false });
  });
});

test('exports.close: 없는 세션·close 실패는 reject', async () => {
  await withMain({ 'plugin.json': PLUGIN_JSON }, { settings: { bin: '/opt/slcode' }, run: (c) => (c.includes(' list --all') ? { code: 0, stdout: rows(true), stderr: '' } : c.includes(' close ') ? { code: 1, stdout: '', stderr: '[slcode] boom\n' } : undefined) }, async ({ exports }) => {
    await assert.rejects(exports.close('nope'), /^Error: no session nope$/);
    await assert.rejects(exports.close('w1'), /\[slcode\] boom/);
  });
});

test('exports.mail: slcode mail --from <from> -- <to> <text> (따옴표·대시로 시작하는 본문), 출력 {id, to}; 실패는 stderr 로 reject', async () => {
  const calls = await withMain({ 'plugin.json': PLUGIN_JSON }, { settings: { bin: '/opt/slcode', dir: '/d' }, run: (c) => (c.includes(" 'gone' ") ? { code: 1, stdout: '', stderr: '[slcode] no session gone\n' } : c.includes(' mail') ? { code: 0, stdout: '{"id":"m1","to":"orch-id"}', stderr: '' } : undefined) }, async ({ exports }) => {
    assert.deepEqual(await exports.mail({ to: 'orch', text: "--done: it's ok", from: 'w1' }), { id: 'm1', to: 'orch-id' });
    assert.deepEqual(await exports.mail({ to: 'orch', text: 'hi' }), { id: 'm1', to: 'orch-id' });
    await assert.rejects(exports.mail({ to: 'gone', text: 'x', from: 'w1' }), /no session gone/);
    await assert.rejects(exports.mail({ to: 'orch' }), /mail needs \{to, text\}/);
  });
  assert.ok(calls.includes(`proc ${BIN} mail --from 'w1' --dir '/d' -- 'orch' '--done: it'\\''s ok'`));
  assert.ok(calls.includes(`proc ${BIN} mail --dir '/d' -- 'orch' 'hi'`), 'from 이 없으면 CLI 가 unknown');
});
