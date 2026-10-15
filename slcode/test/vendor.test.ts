// 벤더 세션 가져오기·내보내기 (ticket vendor-import → slcode-import-history) — 가짜 CLAUDE_CONFIG_DIR·CODEX_HOME 에 기록을 지어 찾기와 import·export 동사를 본다.
// Claude 기록은 test/fixtures/claude-session.jsonl(실제 두 턴 세션), Codex 는 rollout 첫 줄 + 가짜 app-server 의 thread/read(fixtures/codex-turns.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import { findVendorSession, vendorResumeCommand } from '../src/vendor.ts';
import { sockAlive } from '../src/live.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 끝났으면 바로, 아니면 exit 까지. 가짜 홈엔 로그인이 없어 import 한 세션이 곧 스스로 닫힐 수 있으므로 kill 전에 이미 끝났을 수 있다 */
const ended = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise((r) => c.once('exit', r)));
const FIX = path.resolve(import.meta.dirname, 'fixtures');
const CID = 'eca2ea0c-cd14-4216-b88c-558435351e88'; // fixtures/claude-session.jsonl
const XID = '019f0000-0000-7000-8000-000000000002';

/** 가짜 벤더 홈 — claude 기록 하나(실제 두 턴 세션), codex rollout 하나와 그 thread 의 턴들(가짜 app-server 가 thread/read 로 준다) */
function homes() {
  const work = tmp('slcode-vi-work-');
  const claude = tmp('slcode-vi-claude-'), codex = tmp('slcode-vi-codex-');
  const pd = path.join(claude, 'projects', work.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, `${CID}.jsonl`), fs.readFileSync(path.join(FIX, 'claude-session.jsonl'), 'utf8').replaceAll('__CWD__', work));
  // 세션 프로세스의 claude 가 이 홈의 설정을 읽었다는 표 — 세션이 뜨면 SessionStart 훅이 started 를 만든다 (첫 프롬프트 전에도 돈다)
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${path.join(claude, 'started')}'` }] }] } }));
  const xd = path.join(codex, 'sessions', '2026', '10', '07');
  fs.mkdirSync(xd, { recursive: true });
  fs.writeFileSync(path.join(xd, `rollout-2026-10-07T01-02-03-${XID}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: XID, cwd: work } }) + '\n');
  const turns = path.join(codex, 'turns.json');
  fs.copyFileSync(path.join(FIX, 'codex-turns.json'), turns);
  return { work, turns, env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, SLCODE_CODEX_BIN: `${process.execPath} ${path.join(FIX, 'fake-codex.mjs')}`, FAKE_CODEX_TURNS: turns } };
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

/** import 세션 하나를 띄우고(첫 stdout 줄까지, until 이 있으면 그것까지) SIGINT 로 내린 뒤 세션 소켓이 닫히기를 기다린다 — stderr 를 돌려준다 */
async function importOnce(t: { after: (f: () => void) => void }, dir: string, env: Record<string, string>, args: string[], until?: () => boolean): Promise<string> {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'import', ...args, '--no-web'], { env: { ...process.env, ...env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGINT'); });
  let out = '', err = '';
  child.stdout!.on('data', (d) => (out += d)); child.stderr!.on('data', (d) => (err += d));
  const t0 = Date.now(); while (!out.includes('\n') && child.exitCode === null && Date.now() - t0 < 15000) await sleep(50);
  assert.ok(out.trim().endsWith('sock'), out + err);
  for (const t1 = Date.now(); until && !until() && Date.now() - t1 < 5000;) await sleep(50);
  child.kill('SIGINT'); await ended(child);
  const sock = out.trim().split('\n')[0];
  for (const t2 = Date.now(); (await sockAlive(sock)) && Date.now() - t2 < 5000;) await sleep(50); // 다음 import 가 살아 있는 세션으로 보지 않게
  return err;
}
const sessions = (dir: string) => EventLog.list(corePaths(dir).sessionsDir);
const rowsOf = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const events = (dir: string, id: string) => EventLog.open(corePaths(dir).sessionsDir, id)!.since(0).map((e) => e.ev as any);

test('import (claude): 복제본으로 slcode 세션 — 이전 대화가 표지 앞에, 원본은 그대로; 같은 원본을 또 import 하면 새 복제본; export 는 복제본 명령', async (t) => {
  const { work, env } = homes();
  const dir = tmp('slcode-vi-');
  const src = withEnv(env, () => findVendorSession(CID, 'claude')!.file);
  const before = fs.readFileSync(src, 'utf8');
  const started = path.join(env.CLAUDE_CONFIG_DIR, 'started');
  const err = await importOnce(t, dir, env, [CID, '--title', 'imp'], () => fs.existsSync(started));
  assert.match(err, new RegExp(`imported claude session ${CID} as \\w+ \\(${work}, 2 earlier turns\\) — a copy \\([0-9a-f-]{36}\\), the original is untouched`));
  assert.ok(fs.existsSync(started), '세션 프로세스의 claude 가 CLAUDE_CONFIG_DIR 의 설정을 읽는다 (core 가 지우지 않는다)');

  const [meta] = sessions(dir);
  assert.deepEqual([meta.vendor, meta.cwd, meta.forkFrom, meta.title], ['claude', work, CID, 'imp']);
  assert.notEqual(meta.vendorSessionId, CID);
  const copy = withEnv(env, () => findVendorSession(meta.vendorSessionId!, 'claude'));
  assert.ok(copy, '복제본 기록이 같은 프로젝트 폴더에 생긴다');
  const evs = events(dir, meta.id);
  assert.deepEqual(evs.filter((e) => e.kind === 'turn.start').map((e) => e.text), ['Create a file named hello.txt containing exactly the word hi. Then reply with one short sentence.', 'Read hello.txt and tell me its content in one word.']);
  const mark = evs.find((e) => e.kind === 'session.imported');
  assert.deepEqual([mark.vendorSessionId, mark.fork], [CID, true]);
  // 표지 뒤의 것은 세션 프로세스가 낸 것 — 같은 홈에서 복제본을 찾아 이어 받는다 (예전엔 core 가 CLAUDE_CONFIG_DIR 까지 지워 "No conversation found" 로 끝났다)
  assert.ok(!evs.some((e) => /No conversation found/.test(e.error ?? e.message ?? '')), '세션 프로세스가 복제본을 찾는다');
  const imported = evs.slice(0, evs.indexOf(mark));
  assert.equal(imported.filter((e) => e.kind === 'turn.end').length, 2, '표지는 옮긴 대화 뒤에');
  assert.equal(mark.uuid, imported.filter((e) => e.kind === 'turn.end').at(-1).uuid, '표지의 uuid 는 복제본의 마지막 항목 (forkSession 이 uuid 를 새로 매긴다)');
  assert.notEqual(mark.uuid, rowsOf(src).at(-1).uuid);
  assert.equal(fs.readFileSync(src, 'utf8'), before, '원본 기록은 그대로');

  const off = await run(dir, env, ['export', 'imp']);
  assert.equal(off.stderr, ''); assert.equal(off.stdout.trim(), `cd '${work}' && claude --resume ${meta.vendorSessionId}`);

  // 살아 있는 세션: export 는 세션 소켓에 붙어 보기만 하므로 그 자리에 소켓을 연다. 가져온 세션은 스스로 닫힐 수 있어
  // 그 세션으로 재면 export 가 붙기 전에 끝날 수 있다 (GitHub Actions runner 에서 실제로 졌다)
  const srv = net.createServer((s) => s.end());
  await new Promise<void>((r) => srv.listen(EventLog.open(corePaths(dir).sessionsDir, meta.id)!.sockPath, r));
  const live = await run(dir, env, ['export', meta.id]).finally(() => srv.close());
  assert.equal(live.code, 0); assert.match(live.stderr, /is live — close it first/);

  // 같은 원본을 또 — 새 복제본·새 slcode 세션 (사용자 2026-10-15: 여러 번 복제 허용)
  const again = await importOnce(t, dir, env, [CID]);
  assert.match(again, new RegExp(`${CID} was already imported as ${meta.id} — making another copy`));
  assert.equal(sessions(dir).length, 2);
});

test('import (claude): slcode 세션이 이어 쓰는 벤더 세션 id 면 복제하지 않고 늘어난 턴을 붙인다', async (t) => {
  const { env } = homes();
  const dir = tmp('slcode-vi-');
  await importOnce(t, dir, env, [CID]);
  const [meta] = sessions(dir);
  const n = events(dir, meta.id).length;
  // export 뒤 벤더에서 한 턴 더 — 복제본 기록 끝에 프롬프트와 답을 잇는다
  const copy = withEnv(env, () => findVendorSession(meta.vendorSessionId!, 'claude'))!.file;
  const last = [...rowsOf(copy)].reverse().find((o) => o.type === 'assistant');
  fs.appendFileSync(copy, [
    { ...last, type: 'user', uuid: 'u-more', parentUuid: last.uuid, message: { role: 'user', content: 'one more' } },
    { ...last, uuid: 'a-more', parentUuid: 'u-more', message: { ...last.message, id: 'msg-more', content: [{ type: 'text', text: 'ok' }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const err = await importOnce(t, dir, env, [meta.vendorSessionId!]);
  assert.match(err, new RegExp(`pulled 1 turn from claude into ${meta.id}`));
  assert.equal(sessions(dir).length, 1, '새 세션을 만들지 않는다');
  const added = events(dir, meta.id).slice(n);
  assert.equal(added.find((e) => e.kind === 'turn.start')?.text, 'one more');
  assert.deepEqual(added.filter((e) => e.kind === 'session.imported').map((e) => [e.vendorSessionId, e.uuid]), [[meta.vendorSessionId, 'a-more']]);
});

test('import (codex): 원본 thread 의 턴을 옮기고 첫 기동이 thread/fork; fork 한 thread id 를 다시 import 하면 늘어난 턴만', async (t) => {
  const { work, turns, env } = homes();
  const dir = tmp('slcode-vi-');
  const err = await importOnce(t, dir, env, [XID], () => !!sessions(dir)[0]?.vendorSessionId); // 첫 기동의 thread/fork 까지
  assert.match(err, new RegExp(`imported codex session ${XID} as \\w+ \\(${work}, 2 earlier turns\\) — a copy, the original is untouched`));
  const [meta] = sessions(dir);
  assert.deepEqual([meta.forkFrom, meta.vendorSessionId], [XID, `fork-${XID}`]);
  const tt = JSON.parse(fs.readFileSync(turns, 'utf8'));
  assert.deepEqual(events(dir, meta.id).find((e) => e.kind === 'session.imported'), { kind: 'session.imported', vendor: 'codex', vendorSessionId: XID, uuid: tt[1].id, fork: true });

  fs.writeFileSync(turns, JSON.stringify([...tt, { ...tt[1], id: 'turn-3', items: [{ type: 'userMessage', id: 'um3', content: [{ type: 'text', text: 'third' }] }, { type: 'agentMessage', id: 'am3', text: 'done' }] }]));
  const n = events(dir, meta.id).length;
  assert.match(await importOnce(t, dir, env, [`fork-${XID}`]), new RegExp(`pulled 1 turn from codex into ${meta.id}`));
  const added = events(dir, meta.id).slice(n);
  assert.deepEqual(added.filter((e) => e.kind === 'turn.start' || e.kind === 'text.delta').map((e) => e.text), ['third', 'done']);
});

test('import·export 실패: 없는 id, 턴 없는 세션', async () => {
  const { env } = homes();
  const dir = tmp('slcode-vi-');
  const nf = await run(dir, env, ['import', 'deadbeef']);
  assert.equal(nf.code, 1); assert.match(nf.stderr, /no claude or codex session deadbeef/);
  assert.equal((await run(dir, env, ['import', CID, '--vendor', 'gpt'])).code, 2);
  assert.equal((await run(dir, env, ['import', CID, '--fork'])).code, 2, '--fork 는 없앴다 (늘 복제)');
  EventLog.create(corePaths(dir).sessionsDir, { id: 'eeee0000', vendor: 'claude', cwd: '/x', title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false }).close();
  const ex = await run(dir, env, ['export', 'eeee0000']);
  assert.equal(ex.code, 1); assert.match(ex.stderr, /no claude session yet/);
});
