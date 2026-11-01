// 세션 시작 프로필 (profiles.ts, ticket slcode-session-profile, 사용자 결정 2026-10-28) — 기본 제공 default·bare, 사용자 프로필 add·set·remove,
// 플러그인 싣기와 설정 층(기본 설정 < 프로필 < 세션), Claude 로드 설정(settingSources·claudeMdExcludes·skills), CLI --profile.
// 살아 있는 세션은 가짜 codex(test/fixtures/fake-codex.mjs)로 본다 — Codex 는 플러그인 선택만 따르고 Claude 쪽 로드 설정은 없다고 알린다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { addPlugin, agentPaths, currentBuilds, loadSessionPlugins, readConfig, reloadSessionPlugins, setPlugin } from 'slcode-plugin/agentPlugins';
import { addProfile, claudeLoad, getProfile, listProfiles, removeProfile, sessionProfile, setProfile } from '../src/profiles.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-pf-${p}-`));
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}
/** part 셋(필수 base, 기본 꺼짐 ponytail)·옵션 하나를 가진 플러그인 원본 */
function source(name: string): string {
  const src = tmp('src');
  write(src, {
    'slcode-plugin.json': JSON.stringify({ name, version: '1.0.0', options: { proactive: { type: 'boolean', default: false } }, parts: { base: { required: true }, ponytail: { default: false } } }),
    [`base/skills/${name}-hello/SKILL.md`]: '---\ndescription: hi\n---\nHi',
    'base/instructions/base.md': `${name} base.`,
    'ponytail/instructions/p.md': `${name} ponytail.`,
    'ponytail/skills/ponytail/SKILL.md': '---\ndescription: p\n---\nP',
  });
  return src;
}
async function installed() {
  const dir = tmp('state');
  await addPlugin(source('core'), dir);
  await addPlugin(source('sfa'), dir);
  return dir;
}

test('기본 제공: default 는 전부, bare 는 아무것도 — 고치거나 지울 수 없고, 없는 이름은 default 로 띄우며 원래 이름을 알린다', async () => {
  const dir = tmp('state');
  assert.deepEqual(listProfiles(dir).map((r) => [r.name, r.builtin]), [['default', true], ['bare', true]]);
  assert.equal(getProfile('default', dir)!.rest, true);
  assert.deepEqual(getProfile('bare', dir)!.claude, { user: false, project: false, userMd: true, projectMd: true, builtinSkills: false });
  await assert.rejects(addProfile('bare', 'default', dir), /built-in/);
  await assert.rejects(setProfile('default', ['claude.user=off'], dir), /built-in/);
  await assert.rejects(removeProfile('default', dir), /built-in/);
  assert.deepEqual(sessionProfile(undefined, dir).name, 'default');
  const gone = sessionProfile('basic', dir);
  assert.equal(gone.name, 'default');
  assert.equal(gone.missing, 'basic');
});

test('사용자 프로필: from 의 값으로 시작하고, set 은 플러그인 on·part·옵션·other-plugins·claude 키를 바꾼다. 하나라도 틀리면 아무것도 바꾸지 않는다', async () => {
  const dir = await installed();
  await addProfile('basic', 'bare', dir);
  await assert.rejects(addProfile('basic', 'default', dir), /already exists/);
  await assert.rejects(addProfile('x', 'nope', dir), /no profile nope/);
  await assert.rejects(addProfile('../x', 'default', dir), /must match/);
  const r = await setProfile('basic', ['core=on', 'core.ponytail=on', 'core.proactive=true', 'claude.project=on', 'claude.project-md=off'], dir);
  assert.deepEqual(r.profile.plugins, { core: { on: true, parts: { ponytail: true }, options: { proactive: true } } });
  assert.equal(r.profile.rest, false);
  assert.deepEqual(r.profile.claude, { user: false, project: true, userMd: true, projectMd: false, builtinSkills: false });
  for (const bad of [['core.base=off'], ['nope=on'], ['core=maybe'], ['claude.user=yes'], ['core.proactive=1']]) {
    await assert.rejects(setProfile('basic', ['other-plugins=on', ...bad], dir), undefined, bad[0]);
  }
  assert.equal(getProfile('basic', dir)!.rest, false, '틀린 set 은 앞의 값도 남기지 않는다');
  assert.deepEqual(Object.keys(readConfig(agentPaths(dir)).profiles!), ['basic'], 'config.json 의 profiles 에 남는다');
  assert.deepEqual(await removeProfile('basic', dir), { name: 'basic', removed: true });
  assert.deepEqual(await removeProfile('basic', dir), { name: 'basic', removed: false });
});

test('세션에 싣기: 프로필이 싣는 플러그인만, 설정 값은 기본 설정 < 프로필 < 세션. 나열하지 않은 플러그인은 other-plugins 를 따른다', async () => {
  const dir = await installed();
  const env = { HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg' };
  const names = (s: { loaded: { name: string }[] }) => s.loaded.map((l) => l.name);
  assert.deepEqual(names(loadSessionPlugins(tmp('s'), env, {}, dir, 'claude', getProfile('default', dir)!)), ['core', 'sfa']);
  const bare = loadSessionPlugins(tmp('s'), env, {}, dir, 'claude', getProfile('bare', dir)!);
  assert.deepEqual([bare.plugins, bare.append], [[], '']);
  await addProfile('basic', 'bare', dir);
  await setProfile('basic', ['core=on', 'core.ponytail=on'], dir);
  await setPlugin('core', ['proactive=true'], dir); // 기본 설정 — 프로필이 정하지 않은 값은 그대로
  const basic = loadSessionPlugins(tmp('s'), env, {}, dir, 'claude', getProfile('basic', dir)!);
  assert.deepEqual(names(basic), ['core']);
  assert.equal(basic.loaded[0].values, 'opt.proactive=true,part.base=1,part.ponytail=1');
  assert.match(basic.append, /core ponytail\./);
  const withSession = loadSessionPlugins(tmp('s'), env, { core: { parts: { ponytail: false } } }, dir, 'claude', getProfile('basic', dir)!);
  assert.equal(withSession.loaded[0].values, 'opt.proactive=true,part.base=1,part.ponytail=0', '세션 값이 프로필 위');
  await setProfile('basic', ['other-plugins=on', 'core=off'], dir);
  assert.deepEqual(names(loadSessionPlugins(tmp('s'), env, {}, dir, 'claude', getProfile('basic', dir)!)), ['sfa']);
});

test('다시 싣기·지금 빌드: 지금 프로필을 따른다 — 빠진 플러그인은 링크를 떼고, 새로 설치해도 프로필이 싣지 않으면 새 세션부터로 알리지 않는다', async () => {
  const dir = tmp('state');
  await addPlugin(source('core'), dir);
  await addProfile('basic', 'bare', dir);
  await setProfile('basic', ['core=on'], dir);
  const sdir = tmp('s'), env = { HOME: '/h' };
  const s = loadSessionPlugins(sdir, env, {}, dir, 'claude', getProfile('basic', dir)!);
  await addPlugin(source('sfa'), dir);
  assert.deepEqual(Object.keys(currentBuilds({}, dir, 'claude', getProfile('basic', dir)!)), ['core']);
  assert.deepEqual(reloadSessionPlugins(sdir, s.loaded, env, {}, dir, 'claude', getProfile('basic', dir)!).later, []);
  await setProfile('basic', ['core.ponytail=on'], dir);
  assert.notEqual(currentBuilds({}, dir, 'claude', getProfile('basic', dir)!).core, s.loaded[0].build, '프로필 값이 바뀌면 다시 실을 것이 있다');
  await setProfile('basic', ['core=off'], dir);
  const r = reloadSessionPlugins(sdir, s.loaded, env, {}, dir, 'claude', getProfile('basic', dir)!);
  assert.deepEqual(r.removed, ['core']);
  assert.ok(!fs.existsSync(path.join(sdir, 'agent-plugins/core')));
});

test('Claude 로드: 출처는 settingSources 로, CLAUDE.md 만 끄면 claudeMdExcludes 로(사용자 설정 폴더 안은 프로젝트 쪽에서 빼지 않는다), 내장 skill 을 숨기면 허용 목록', () => {
  const home = tmp('home'), cfg = path.join(home, '.claude'), cwd = path.join(home, 'proj');
  write(home, { '.claude/skills/mine/SKILL.md': 'x', 'proj/.claude/skills/projs/SKILL.md': 'x' });
  const plug = tmp('plug');
  write(plug, { 'skills/hello/SKILL.md': 'x' });
  const env = { HOME: home };
  const all = { user: true, project: true, userMd: true, projectMd: true, builtinSkills: true };
  assert.deepEqual(claudeLoad(all, cwd, env, []), { settingSources: ['user', 'project', 'local'], claudeMdExcludes: [], skills: null, env: {} });
  assert.deepEqual(claudeLoad({ ...all, user: false, project: false, builtinSkills: false }, cwd, env, [{ name: 'core', path: plug }]),
    { settingSources: [], claudeMdExcludes: [], skills: ['core:hello'], env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } }, 'bare 꼴 — slcode 플러그인 skill 만, claude.ai 커넥터도 끈다');
  assert.deepEqual(claudeLoad({ ...all, builtinSkills: false }, cwd, env, []).skills, ['mine', 'projs'], '켠 출처의 skill 은 허용 목록에 남긴다');
  assert.deepEqual(claudeLoad({ ...all, userMd: false }, cwd, env, []).claudeMdExcludes, [path.join(cfg, 'CLAUDE.md'), path.join(cfg, 'rules/**')]);
  const proj = claudeLoad({ ...all, projectMd: false }, cwd, env, []).claudeMdExcludes;
  assert.ok(proj.includes(path.join(cwd, 'CLAUDE.md')) && proj.includes(path.join(cwd, '**/CLAUDE.md')) && proj.includes(path.join(home, 'CLAUDE.md')) && proj.includes('/CLAUDE.md'));
  assert.ok(!proj.includes(path.join(cfg, 'CLAUDE.md')), '조상(HOME)의 .claude 는 사용자 설정 폴더 — 프로젝트 쪽에서 빼지 않는다');
  assert.deepEqual(claudeLoad({ ...all, project: false, projectMd: false }, cwd, env, []).claudeMdExcludes, [], '꺼진 출처의 CLAUDE.md 는 settingSources 가 이미 뺀다');
});

// ---- CLI
const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Out = { code: number; stdout: string; stderr: string };
const baseEnv = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION_ID: undefined, SUPERLITE_SOCK: undefined, SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}` });
function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<Out> {
  return new Promise((resolve) => execFile(process.execPath, ['--import', TSX, CLI, ...args], { env: { ...baseEnv(dir), ...env } }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
}

test('CLI: profile add·set·list, new --profile 은 없는 이름을 열기 전에 거절하고 카드로 넘기며, 이어받는 세션에는 거절한다', async () => {
  const dir = await installed();
  assert.equal((await run(dir, ['profile', 'add', 'basic', '--from', 'bare'])).code, 0);
  const set = await run(dir, ['profile', 'set', 'basic', 'core=on', 'claude.project=on']);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /^basic\n  plugins  core\n  claude   user off · project on · builtin skills hidden$/m);
  const list = await run(dir, ['profile', 'list']);
  assert.match(list.stdout, /^default \(built-in\)\n  plugins  all\n  claude   user on · project on · builtin skills shown$/m);
  assert.match(list.stdout, /^bare \(built-in\)\n  plugins  none\n/m);
  const nope = await run(dir, ['new', '.', '--profile', 'nope']);
  assert.equal(nope.code, 2);
  assert.match(nope.stderr, /no profile 'nope' \(default\|bare\|basic\)/);
  // 카드로 — 가짜 superlite 심이 받은 인자
  const bin = tmp('shim'), calls = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'superlite'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\necho s-card-1\n`, { mode: 0o755 });
  const card = await run(dir, ['new', os.tmpdir(), '--profile', 'basic'], { SUPERLITE_SOCK: '/tmp/fake.sock', PATH: `${bin}:${process.env.PATH}` });
  assert.equal(card.code, 0, card.stderr);
  assert.match(fs.readFileSync(calls, 'utf8'), /^slcode\.new --cwd \S+ --profile basic$/m);
  const resume = await run(dir, ['resume', 'abc', '--profile', 'bare']);
  assert.equal(resume.code, 2);
  assert.match(resume.stderr, /--profile is only for a new session/);
});

test('CLI: Codex 세션은 프로필 이름을 남기고 플러그인 선택만 따른다고 알린다 — default 는 meta 에 남기지 않는다', async () => {
  const dir = tmp('state');
  async function session(title: string, profile?: string) {
    const child = spawn(process.execPath, ['--import', TSX, CLI, 'new', os.tmpdir(), '--no-web', '--vendor', 'codex', '--title', title, ...(profile ? ['--profile', profile] : [])], { env: baseEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (d: string) => { out += d; });
    const t0 = Date.now(); while (!out.includes('\n') && child.exitCode === null && Date.now() - t0 < 15000) await sleep(50);
    const meta = EventLog.list(corePaths(dir).sessionsDir).find((m) => m.title === title)!;
    let evs: { kind: string; message?: string; source?: string }[] = [];
    for (let i = 0; i < 50 && !evs.some((e) => e.kind === 'error' || e.kind === 'session.ready'); i++) {
      await sleep(100);
      evs = (await run(dir, ['log', meta.id, '--json'])).stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).ev);
    }
    child.kill('SIGINT');
    await new Promise((r) => child.on('exit', r));
    return { meta, evs, notices: evs.filter((e) => e.kind === 'error').map((e) => e.message ?? '') };
  }
  const bare = await session('pf-bare', 'bare');
  assert.equal(bare.meta.profile, 'bare');
  assert.ok(bare.notices.some((m) => /Codex 세션은 프로필\(bare\)의 플러그인 선택만 따릅니다/.test(m)), JSON.stringify(bare.notices));
  // 연 표지(ticket slcode-session-open-notice) — 새 세션은 startup, 기동 때의 알림보다 먼저
  const opened = bare.evs.findIndex((e) => e.kind === 'session.opened');
  assert.equal(bare.evs[opened]?.source, 'startup', JSON.stringify(bare.evs));
  assert.ok(opened < bare.evs.findIndex((e) => e.kind === 'error'));
  const def = await session('pf-default', 'default');
  assert.equal(def.meta.profile, undefined);
  assert.ok(!def.notices.some((m) => /프로필/.test(m)));
});

test('새 프로필은 시작 값 위에 값 목록을 한 번에 얹고, 하나라도 틀리면 만들지 않는다 (고르기 화면의 add)', async () => {
  const dir = await installed();
  await assert.rejects(addProfile('half', 'bare', dir, ['core=on', 'nope=on']), /no agent plugin nope/);
  assert.equal(getProfile('half', dir), null);
  await addProfile('half', 'bare', dir, ['core=on', 'claude.project=on', 'claude.project-md=off']);
  const p = getProfile('half', dir)!;
  assert.deepEqual([p.plugins.core, p.rest, p.claude.project, p.claude.projectMd, p.claude.user], [{ on: true }, false, true, false, false]);
});

test('시작 화면(동사 없는 slcode): 카드용 html 은 css·모듈을 넣은 한 장; 웹은 고를 때까지 세션을 띄우지 않고, 그 폴더·모든 폴더의 세션을 마지막 활동 순으로 보이며, 새 세션은 첫 메시지 전에 시작 화면으로 돌아가면 지워진다 (사용자 2026-10-30)', async (t) => {
  const dir = await installed();
  const work = fs.realpathSync(tmp('work')), other = fs.realpathSync(tmp('other'));
  const stored = (id: string, cwd: string, closedAt: number) => EventLog.create(corePaths(dir).sessionsDir, { id, vendor: 'codex', cwd, title: id, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false, closedAt }).close();
  stored('old11111', work, 100); stored('new22222', work, 300); stored('far33333', other, 200);
  const card = (await run(dir, ['start-page', work])).stdout;
  assert.match(card, /<html lang="ko" data-start="card" data-cwd="[^"]+"/);
  assert.ok(!card.includes('./start.js') && !card.includes('./style.css') && card.includes('slcode.start.'), '주소 없이 돈다');
  // 에이전트 플러그인 관리의 입구는 시작 화면뿐 — 카드는 plugins.js 를 넣어 두고 요청은 start-call 로 (ticket slcode-agent-plugin-export-action)
  assert.ok(card.includes('globalThis.slcodePlugins = { pluginsPanel }') && !card.includes('export function pluginsPanel'), '카드에 관리 화면 모듈');
  assert.deepEqual(JSON.parse((await run(dir, ['start-call', 'plugins.list'])).stdout).plugins.map((p: { name: string }) => p.name).sort(), ['core', 'sfa']);
  assert.match((await run(dir, ['start-call', 'plugins.check', '{"name":"nope"}'])).stderr, /no agent plugin nope/);
  assert.match((await run(dir, ['start-call', 'session.list'])).stderr, /start-call <plugins.list\|/);
  const json = JSON.parse((await run(dir, ['start-page', work, '--json'])).stdout);
  assert.deepEqual([json.here.map((m: { id: string }) => m.id), json.all.map((m: { id: string }) => m.id)], [['new22222', 'old11111'], ['new22222', 'far33333', 'old11111']]);
  const child = spawn(process.execPath, ['--import', TSX, CLI], { cwd: work, env: baseEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let out = '';
  child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (d: string) => { out += d; });
  const t0 = Date.now(); while (!out.includes('\n') && child.exitCode === null && Date.now() - t0 < 15000) await sleep(50);
  const url = out.trim();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.match(await (await fetch(url)).text(), /data-start="web"/);
  const api = (a: string, body: unknown, origin = url.slice(0, -1)) => fetch(`${url}api/${a}`, { method: 'POST', headers: { origin }, body: JSON.stringify(body) });
  assert.equal((await api('list', {}, 'http://evil.example')).status, 403);
  assert.deepEqual((await (await api('list', {})).json()).here.map((m: { id: string; live: boolean }) => [m.id, m.live]), [['new22222', false], ['old11111', false]]);
  assert.equal((await api('go', { resume: 'far33333' })).status, 400, '다른 폴더의 세션은 이 화면에서 열지 않는다');
  assert.equal((await api('go', {})).status, 400);
  assert.equal(EventLog.list(corePaths(dir).sessionsDir).length, 3, '고르기 전엔 새 세션이 없다');
  assert.equal((await api('go', { new: true })).status, 200);
  // 고른 뒤 새로 고친 화면은 세션 화면이다 — 진입 프로세스가 serve 가 뜰 때까지 연결을 쥐고 있다가 넘긴다
  assert.doesNotMatch(await (await fetch(url)).text(), /data-start=/);
  const meta = EventLog.list(corePaths(dir).sessionsDir).find((m) => !['old11111', 'new22222', 'far33333'].includes(m.id))!;
  assert.deepEqual([meta.cwd, meta.fromStart, meta.profile], [work, true, undefined]);
  // 시작 화면으로 — 대화 화면의 start.back. 빈 세션은 지우고 같은 주소에 시작 화면이 다시 열린다. 카드용 discard 는 시작 화면에서 연 세션만
  assert.match((await run(dir, ['discard', 'old11111'])).stderr, /only a session opened from the start screen/);
  const { WebSocket: WS } = await import('ws');
  const ws = new WS(url.replace('http', 'ws') + 'ws', { origin: url.slice(0, -1) });
  await new Promise((r) => ws.once('open', r));
  const replies = new Map<number, any>();
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.id) replies.set(m.id, m); });
  const rpc = async (id: number, method: string, params?: unknown) => { ws.send(JSON.stringify({ id, method, params })); for (let i = 0; i < 100 && !replies.has(id); i++) await sleep(50); return replies.get(id); };
  await rpc(1, 'core.auth', {});
  assert.deepEqual((await rpc(2, 'start.back', {})).result, { ok: true });
  let back = '';
  for (let i = 0; i < 100 && !back.includes('data-start='); i++) { await sleep(100); back = await fetch(url).then((r) => r.text(), () => ''); }
  assert.match(back, /data-start="web"/);
  assert.equal(EventLog.open(corePaths(dir).sessionsDir, meta.id), null, '빈 세션은 지웠다');
  child.kill('SIGINT');
  await new Promise((r) => child.on('exit', r));
});
