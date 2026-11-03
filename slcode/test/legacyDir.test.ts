// 옛 상태 폴더 호환 (ticket slcode-update-no-session-old-dir, 사용자 결정 2026-11-04 — 1.0.0 에서 지운다: ticket slcode-remove-legacy-state-dir).
// 격리 HOME 에 ~/.local/state/agent-core 의 세션과 ~/.local/state/slcode 를 두고, $SLCODE_DIR 없이 CLI 를 돌린다. 벤더는 가짜 codex
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { connectSession } from '../src/client.ts';
import { readSettings, writeSettings } from '../src/settings.ts';
import { corePaths, coreDir, cwdSlug, readOrCreateToken, sessionRoots } from '../src/paths.ts';
import { inspectUsage } from '../src/inspectDb.ts';
import { addPlugin, gcBuilds } from 'slcode-plugin/agentPlugins';

const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
type Home = { home: string; cur: string; old: string; work: string; env: NodeJS.ProcessEnv };

function makeHome(work = tmp('slcode-work-')): Home {
  const home = tmp('slcode-home-');
  const state = path.join(home, '.local', 'state');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SLCODE_DIR: undefined, AGENT_CORE_DIR: undefined, SLCODE_GRACE_SECS: '1', SLCODE_SESSION_ID: undefined, SUPERLITE_SOCK: undefined, SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}` };
  return { home, cur: path.join(state, 'slcode'), old: path.join(state, 'agent-core'), work, env };
}
/** 옛 폴더에 꺼진 세션 하나 */
function oldSession(h: Home, id: string, extra: object = {}): string {
  const dir = path.join(h.old, 'sessions', cwdSlug(h.work), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, vendor: 'codex', cwd: h.work, title: `old ${id}`, vendorSessionId: null, createdAt: 1000, updatedAt: 1000, permissionMode: 'auto', raw: false, ...extra }));
  return dir;
}
function run(h: Home, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(process.execPath, ['--import', TSX, CLI, ...args], { env: h.env }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
}
type Row = { id: string; live: boolean; title: string | null; cwd: string };
const list = async (h: Home, extra: string[] = []): Promise<Row[]> => JSON.parse((await run(h, ['list', '--all', ...extra])).stdout);
async function until(f: () => boolean | Promise<boolean>, ms = 15000) { const t0 = Date.now(); while (!(await f()) && Date.now() - t0 < ms) await sleep(100); assert.ok(await f(), 'timed out'); }
/** serve 를 띄우고 떠 있는 동안 fn */
async function serving(h: Home, args: string[], id: () => Promise<string | undefined>, fn: (id: string) => Promise<void>) {
  const p: ChildProcess = spawn(process.execPath, ['--import', TSX, CLI, ...args, '--no-web'], { env: h.env, stdio: 'ignore' });
  try {
    let got: string | undefined;
    await until(async () => (got = await id()) !== undefined);
    await fn(got!);
  } finally { if (p.exitCode === null && p.signalCode === null) { p.kill('SIGTERM'); await new Promise((r) => p.once('exit', r)); } }
}
const liveId = (h: Home) => async () => (await list(h)).find((r) => r.live)?.id;
function withHome<T>(h: Home, f: () => T): T {
  const saved = { HOME: process.env.HOME, SLCODE_DIR: process.env.SLCODE_DIR, AGENT_CORE_DIR: process.env.AGENT_CORE_DIR };
  process.env.HOME = h.home; delete process.env.SLCODE_DIR; delete process.env.AGENT_CORE_DIR;
  const done = () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try {
    const r = f();
    if (r instanceof Promise) return r.finally(done) as T;
    done();
    return r;
  } catch (e) { done(); throw e; }
}

test('폴더 고르기: 기본은 늘 새 폴더, 옛 폴더를 줘도 새 폴더로 읽고, 지정한 폴더는 그 폴더만', () => withHome(makeHome(), function () {
  const h = { cur: path.join(os.homedir(), '.local/state/slcode'), old: path.join(os.homedir(), '.local/state/agent-core') };
  fs.mkdirSync(h.old, { recursive: true });
  assert.equal(coreDir(), h.cur, '옛 폴더만 있어도 새 세션은 새 폴더');
  assert.equal(corePaths(h.old).dir, h.cur, '옛 core 가 교체하며 넘기는 dir');
  assert.deepEqual(sessionRoots(path.join(h.cur, 'sessions')), [path.join(h.cur, 'sessions'), path.join(h.old, 'sessions')]);
  const other = path.join(os.tmpdir(), 'somewhere', 'sessions');
  assert.deepEqual(sessionRoots(other), [other]);
}));

test('목록·이어 하기·메시지·닫기: 옛 폴더의 세션이 제자리에서 돌고, 새 세션은 새 폴더에 생긴다', async () => {
  const h = makeHome();
  const dir = oldSession(h, 'aaaa1111');
  fs.mkdirSync(h.cur, { recursive: true }); // 플러그인이 만든 새 폴더
  assert.deepEqual((await list(h)).map((r) => r.id), ['aaaa1111']);
  const start = JSON.parse((await run(h, ['start-page', h.work, '--json'])).stdout);
  assert.deepEqual(start.here.map((r: Row) => r.id), ['aaaa1111']);

  await serving(h, ['resume', 'aaaa1111'], liveId(h), async (id) => {
    assert.equal(id, 'aaaa1111');
    assert.ok(fs.existsSync(path.join(dir, 'sock')), '소켓은 세션 폴더(옛 폴더)에');
    const mail = await run(h, ['mail', 'old aaaa1111', 'hi']);
    assert.equal(mail.code, 0, mail.stderr);
    assert.equal(JSON.parse(mail.stdout).to, 'aaaa1111');
    await serving(h, ['new', h.work, '--vendor', 'codex'], async () => (await list(h)).find((r) => r.live && r.id !== id)?.id, async (nid) => {
      assert.ok(fs.existsSync(path.join(h.cur, 'sessions', cwdSlug(h.work), nid, 'meta.json')), '새 세션은 새 폴더');
      assert.ok(!fs.existsSync(path.join(h.old, 'sessions', cwdSlug(h.work), nid)));
      assert.equal(JSON.parse((await run(h, ['mail', 'old aaaa1111', 'from outside'])).stdout).to, id);
    });
    const close = await run(h, ['close', id]);
    assert.equal(close.code, 0, close.stderr);
  });
  await until(async () => !(await list(h)).find((r) => r.id === 'aaaa1111')?.live);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).closedAt > 0, '닫은 시각도 옛 폴더의 meta 에');
  assert.ok(!fs.existsSync(path.join(h.cur, 'sessions', cwdSlug(h.work), 'aaaa1111')), '새 폴더에 그 세션의 흔적이 남지 않는다');
  assert.equal((await run(h, ['delete', 'aaaa1111'])).code, 0);
  assert.ok(!fs.existsSync(dir));
});

test('discard: 시작 화면에서 연 빈 옛 세션을 지운다', async () => {
  const h = makeHome();
  const dir = oldSession(h, 'bbbb2222', { fromStart: true });
  const r = await run(h, ['discard', 'bbbb2222']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(dir));
});

test('긴 경로: 소켓은 옛 폴더의 sock/<id> 이고 클라이언트도 같은 곳을 본다', async () => {
  const h = makeHome(fs.mkdtempSync(path.join(os.tmpdir(), `slcode-work-${'x'.repeat(90)}-`)));
  oldSession(h, 'cccc3333');
  await serving(h, ['resume', 'cccc3333'], liveId(h), async (id) => {
    assert.ok(fs.existsSync(path.join(h.old, 'sock', id)));
    assert.ok(!fs.existsSync(path.join(h.cur, 'sock', id)));
    assert.equal((await run(h, ['close', id])).code, 0);
  });
});

test('옛 core 의 교체처럼 옛 폴더를 dir 로 줘도 같은 세션을 연다', async () => {
  const h = makeHome();
  const dir = oldSession(h, 'dddd4444');
  await serving(h, ['resume', 'dddd4444', '--dir', h.old], liveId(h), async (id) => {
    assert.ok(fs.existsSync(path.join(dir, 'sock')));
    const c = await connectSession(path.join(dir, 'sock'));
    assert.equal((await c.request('session.attach', { id, since: 0 })).info.id, id);
    c.close();
    assert.equal((await run(h, ['close', id])).code, 0);
  });
});

test('지정한 폴더(--dir·$SLCODE_DIR)는 옛 폴더를 찾지 않는다', async () => {
  const h = makeHome();
  oldSession(h, 'eeee5555');
  const isolated = tmp('slcode-dir-');
  assert.deepEqual(await list(h, ['--dir', isolated]), []);
  assert.deepEqual(await list({ ...h, env: { ...h.env, SLCODE_DIR: isolated } }), []);
  assert.deepEqual(await list({ ...h, env: { ...h.env, AGENT_CORE_DIR: isolated } }), []);
  const r = await run(h, ['resume', 'eeee5555', '--dir', isolated, '--stdio', '--no-web']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no session eeee5555/);
});

test('설정·토큰: 새 폴더에 없으면 옛 폴더의 값을 읽고, 쓰기는 새 폴더에', () => withHome(makeHome(), function () {
  const cur = coreDir(), old = path.join(os.homedir(), '.local/state/agent-core');
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(cur, { recursive: true });
  fs.writeFileSync(path.join(old, 'settings-superlite.json'), JSON.stringify({ theme: 'dark', inspect: true }));
  fs.writeFileSync(path.join(old, 'slcode.token'), 'o'.repeat(48));
  assert.equal(readSettings(cur, 'superlite').theme, 'dark');
  assert.equal(readSettings(cur, 'superlite').inspect, true);
  assert.equal(readSettings(cur, 'web').theme, 'system', '입구별 파일은 따로다');
  assert.equal(readOrCreateToken(corePaths()), 'o'.repeat(48));
  assert.ok(!fs.existsSync(path.join(cur, 'slcode.token')));
  const before = fs.readFileSync(path.join(old, 'settings-superlite.json'), 'utf8');
  assert.equal(writeSettings(cur, 'superlite', { context: { warn: false } }).theme, 'dark', '옛 값 위에 겹친다');
  assert.equal(JSON.parse(fs.readFileSync(path.join(cur, 'settings-superlite.json'), 'utf8')).context.warn, false);
  assert.equal(fs.readFileSync(path.join(old, 'settings-superlite.json'), 'utf8'), before, '옛 파일은 그대로');
  fs.writeFileSync(path.join(cur, 'settings-superlite.json'), JSON.stringify({ theme: 'light' }));
  assert.equal(readSettings(cur, 'superlite').theme, 'light', '새 폴더의 파일이 이긴다');
  const isolated = tmp('slcode-dir-');
  assert.equal(readSettings(isolated, 'superlite').theme, 'system', '지정한 폴더는 옛 폴더를 읽지 않는다');
}));

test('에이전트 플러그인: 옛 세션의 링크는 새 폴더에 두어 빌드 정리가 지키고, 닫으면 치운다', async () => {
  const h = makeHome(), src = tmp('slcode-src-');
  const dir = oldSession(h, 'ffff6666');
  fs.writeFileSync(path.join(src, 'slcode-plugin.json'), JSON.stringify({ name: 'core', version: '1.0.0' }));
  await addPlugin(src, h.cur);
  const links = path.join(h.cur, 'sessions', cwdSlug(h.work), 'ffff6666', 'agent-plugins');
  await serving(h, ['resume', 'ffff6666'], liveId(h), async (id) => {
    await until(() => fs.existsSync(path.join(links, 'core')));
    assert.ok(!fs.existsSync(path.join(dir, 'agent-plugins')));
    const build = path.relative(path.join(h.cur, 'agent-plugins', 'build'), fs.realpathSync(path.join(links, 'core'))).split(path.sep)[0];
    assert.deepEqual(gcBuilds(h.cur, 0).filter((b) => b === build), [], '쓰는 빌드는 지키는 대상이다');
    assert.deepEqual((await list(h)).map((r) => r.id), ['ffff6666'], '링크 폴더는 세션으로 보이지 않는다');
    assert.equal((await run(h, ['close', id])).code, 0);
  });
  await until(() => !fs.existsSync(path.dirname(links)));
});

test('inspect 사용량: 옛 폴더의 기록도 센다', async () => {
  const h = makeHome();
  const dir = oldSession(h, 'gggg7777');
  fs.mkdirSync(path.join(dir, 'inspect'));
  fs.writeFileSync(path.join(dir, 'inspect', 'inspect.db'), 'x'.repeat(10));
  await withHome(h, async () => {
    const u = await inspectUsage(corePaths().sessionsDir);
    assert.equal(u.sessions, 1, JSON.stringify(u));
  });
});
