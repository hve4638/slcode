// 벤더 세션 가져오기·내보내기 (ticket vendor-import) — 가짜 CLAUDE_CONFIG_DIR·CODEX_HOME 에 기록을 지어 찾기와 import·export 동사를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import { claudeLastUuid, findVendorSession, vendorResumeCommand } from '../src/vendor.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CID = 'c1a2b3c4-0000-4000-8000-000000000001';
const XID = '019f0000-0000-7000-8000-000000000002';

/** 가짜 벤더 홈 — claude 기록 하나(마지막은 서브에이전트 곁가지), codex rollout 하나 */
function homes() {
  const work = tmp('slcode-vi-work-');
  const claude = tmp('slcode-vi-claude-'), codex = tmp('slcode-vi-codex-');
  const pd = path.join(claude, 'projects', work.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(pd, { recursive: true });
  const j = (o: object) => JSON.stringify(o);
  fs.writeFileSync(path.join(pd, `${CID}.jsonl`), [
    j({ type: 'permission-mode', permissionMode: 'default', sessionId: CID }),
    j({ type: 'user', uuid: 'u1', cwd: work, sessionId: CID }),
    j({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', cwd: work, sessionId: CID }),
    j({ type: 'assistant', uuid: 's1', isSidechain: true, cwd: work, sessionId: CID }),
    j({ type: 'last-prompt', leafUuid: 'a1', sessionId: CID }),
  ].join('\n') + '\n');
  const xd = path.join(codex, 'sessions', '2026', '10', '07');
  fs.mkdirSync(xd, { recursive: true });
  fs.writeFileSync(path.join(xd, `rollout-2026-10-07T01-02-03-${XID}.jsonl`), j({ type: 'session_meta', payload: { id: XID, cwd: work } }) + '\n');
  return { work, env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } };
}
function withEnv<T>(env: Record<string, string>, f: () => T): T {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return f(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('findVendorSession: claude·codex 기록에서 폴더를 읽고, --vendor 로 좁히고, 이상한 id 는 거절', () => {
  const { work, env } = homes();
  withEnv(env, () => {
    const c = findVendorSession(CID)!;
    assert.deepEqual([c.vendor, c.cwd], ['claude', work]);
    assert.equal(claudeLastUuid(c.file), 'a1', '서브에이전트 곁가지는 건너뛴다');
    const x = findVendorSession(XID)!;
    assert.deepEqual([x.vendor, x.cwd], ['codex', work]);
    assert.equal(findVendorSession(CID, 'codex'), null);
    assert.equal(findVendorSession(XID, 'claude'), null);
    assert.equal(findVendorSession('../etc'), null);
    assert.equal(findVendorSession('nope'), null);
  });
});

test('vendorResumeCommand: 폴더는 홑따옴표로', () => {
  assert.equal(vendorResumeCommand('claude', "/a b/it's", 'X'), `cd '/a b/it'\\''s' && claude --resume X`);
  assert.equal(vendorResumeCommand('codex', '/w', 'Y'), `cd '/w' && codex resume Y`);
});

function run(dir: string, env: Record<string, string>, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(process.execPath, ['--import', 'tsx', CLI, ...args], { env: { ...process.env, ...env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION: undefined } }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
}

test('import: claude 세션을 slcode 세션으로 띄우고 첫 이벤트에 가져온 표지; 다시 import 하면 같은 slcode 세션; export 는 벤더 명령', async (t) => {
  const { work, env } = homes();
  const dir = tmp('slcode-vi-');
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'import', CID, '--no-web', '--title', 'imp'], { env: { ...process.env, ...env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGINT'); });
  let out = '', err = '';
  child.stdout!.on('data', (d) => (out += d)); child.stderr!.on('data', (d) => (err += d));
  const t0 = Date.now(); while (!out.includes('\n') && Date.now() - t0 < 15000) await sleep(50);
  assert.ok(out.trim().endsWith('sock'), out + err);
  assert.match(err, new RegExp(`imported claude session ${CID} as \\w+ \\(${work}\\)`));

  const [meta] = EventLog.list(corePaths(dir).sessionsDir);
  assert.deepEqual([meta.vendor, meta.cwd, meta.vendorSessionId, meta.title], ['claude', work, CID, 'imp']);
  const first = EventLog.open(corePaths(dir).sessionsDir, meta.id)!.since(0)[0];
  assert.deepEqual(first.ev, { kind: 'session.imported', vendor: 'claude', vendorSessionId: CID, uuid: 'a1' });

  const live = await run(dir, env, ['export', meta.id]);
  assert.equal(live.code, 0); assert.match(live.stderr, /is live — close it first/);
  assert.equal(live.stdout.trim(), `cd '${work}' && claude --resume ${CID}`);

  child.kill('SIGINT'); await new Promise((r) => child.once('exit', r));
  const off = await run(dir, env, ['export', 'imp']);
  assert.equal(off.stderr, ''); assert.equal(off.stdout.trim(), `cd '${work}' && claude --resume ${CID}`);

  // 다시 import — 새 기록을 만들지 않고 같은 세션을 resume (띄웠다 바로 닫는다)
  const again = spawn(process.execPath, ['--import', 'tsx', CLI, 'import', CID, '--no-web'], { env: { ...process.env, ...env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (again.exitCode === null) again.kill('SIGINT'); });
  let aerr = '', aout = '';
  again.stderr!.on('data', (d) => (aerr += d)); again.stdout!.on('data', (d) => (aout += d));
  const t1 = Date.now(); while (!aout.includes('\n') && Date.now() - t1 < 15000) await sleep(50);
  assert.match(aerr, new RegExp(`already imported as ${meta.id}`));
  again.kill('SIGINT'); await new Promise((r) => again.once('exit', r));
  assert.equal(EventLog.list(corePaths(dir).sessionsDir).length, 1);
});

test('import·export 실패: 없는 id, 턴 없는 세션', async () => {
  const { env } = homes();
  const dir = tmp('slcode-vi-');
  const nf = await run(dir, env, ['import', 'deadbeef']);
  assert.equal(nf.code, 1); assert.match(nf.stderr, /no claude or codex session deadbeef/);
  assert.equal((await run(dir, env, ['import', CID, '--vendor', 'gpt'])).code, 2);
  EventLog.create(corePaths(dir).sessionsDir, { id: 'eeee0000', vendor: 'claude', cwd: '/x', title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false }).close();
  const ex = await run(dir, env, ['export', 'eeee0000']);
  assert.equal(ex.code, 1); assert.match(ex.stderr, /no claude session yet/);
});

test('import --fork (claude): SDK forkSession 으로 갈라 새 id 로 띄운다 — 원본 기록은 그대로, 다시 --fork 하면 또 새 세션', async (t) => {
  const { work, env } = homes();
  const dir = tmp('slcode-vi-');
  const src = withEnv(env, () => findVendorSession(CID, 'claude')!.file);
  const before = fs.readFileSync(src, 'utf8');
  const forkOnce = async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'import', CID, '--fork', '--no-web'], { env: { ...process.env, ...env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGINT'); });
    let out = '', err = '';
    child.stdout!.on('data', (d) => (out += d)); child.stderr!.on('data', (d) => (err += d));
    const t0 = Date.now(); while (!out.includes('\n') && Date.now() - t0 < 15000) await sleep(50);
    child.kill('SIGINT'); await new Promise((r) => child.once('exit', r));
    return err;
  };
  assert.match(await forkOnce(), new RegExp(`forked claude session ${CID} into [0-9a-f-]{36} as \\w+ \\(${work}\\) — the original is untouched`));
  await forkOnce();
  const metas = EventLog.list(corePaths(dir).sessionsDir);
  assert.equal(metas.length, 2, '--fork 는 이미 가져온 세션을 재사용하지 않는다');
  for (const m of metas) {
    assert.equal(m.forkFrom, CID); assert.notEqual(m.vendorSessionId, CID);
    const copy = withEnv(env, () => findVendorSession(m.vendorSessionId!, 'claude'));
    assert.ok(copy, '복제본 기록이 같은 프로젝트 폴더에 생긴다');
    const ev = EventLog.open(corePaths(dir).sessionsDir, m.id)!.since(0)[0].ev as { kind: string; fork?: boolean; uuid: string | null; vendorSessionId: string };
    assert.deepEqual([ev.kind, ev.fork, ev.vendorSessionId], ['session.imported', true, CID]);
    assert.equal(ev.uuid, claudeLastUuid(copy!.file), '되돌림 지점은 복제본의 uuid (forkSession 이 uuid 를 새로 매긴다)');
  }
  assert.equal(fs.readFileSync(src, 'utf8'), before, '원본 기록은 그대로');
});
