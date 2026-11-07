// 세션 복제 (ticket slcode-session-fork) — forkSession 이 원본 기록을 지점까지 복제하고 설정·관계를 잇는지. Claude 는 실제 기록(test/fixtures)과
// SDK forkSession, Codex 는 가짜 app-server 의 thread/read·thread/fork 로 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLog } from '../src/eventLog.ts';
import { pullHistory } from '../src/history.ts';
import { forkSession } from '../src/fork.ts';
import { serveSession } from '../src/serve.ts';
import { corePaths } from '../src/paths.ts';
import type { CoreEvent } from '../src/protocol.ts';
import { execFile } from 'node:child_process';

const FIX = path.join(import.meta.dirname, 'fixtures');
const CID = 'eca2ea0c-cd14-4216-b88c-558435351e88';
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kinds = (log: EventLog) => log.all.map((e) => e.ev.kind);
const settings = { permissionMode: 'bypassPermissions', raw: false, model: 'claude-x', effort: 'high', profile: 'bare', env: { SE_A: '1' }, params: { P: 'v' }, inspect: true };

/** 가짜 CLAUDE_CONFIG_DIR 에 실제 기록(두 턴)을 두고, 그 기록을 옮겨 쓴 원본 slcode 세션 */
async function claudeSource() {
  const work = tmp('slcode-f-work-'), home = tmp('slcode-f-claude-');
  const pd = path.join(home, 'projects', work.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, `${CID}.jsonl`), fs.readFileSync(path.join(FIX, 'claude-session.jsonl'), 'utf8').replaceAll('__CWD__', work));
  process.env.CLAUDE_CONFIG_DIR = home;
  const sessionsDir = path.join(tmp('slcode-f-'), 'sessions');
  const src = EventLog.create(sessionsDir, { id: 'src00001', vendor: 'claude', cwd: work, title: 'A', vendorSessionId: CID, createdAt: 1, ...settings });
  await pullHistory(src, CID);
  return { sessionsDir, src, pd };
}

test('forkSession(claude): 끝난 턴까지 복제 — 설정을 잇고 parent {id, fork, seq}, 제목 "A (forked)", 복제본 벤더 세션은 새 id, 원본은 그대로', async () => {
  const { sessionsDir, src, pd } = await claudeSource();
  // 진행 중인 턴 — 복제에 넣지 않는다
  src.append({ seq: src.lastSeq + 1, at: 2, ev: { kind: 'turn.start', text: 'still running', origin: null } });
  const before = fs.readdirSync(pd).length;
  const f = await forkSession(sessionsDir, 'src00001');
  const ends = src.all.filter((e) => e.ev.kind === 'session.imported');
  assert.deepEqual(f.meta.parent, { id: 'src00001', kind: 'fork', seq: ends.at(-1)!.seq });
  assert.equal(f.meta.title, 'A (forked)');
  for (const [k, v] of Object.entries(settings)) assert.deepEqual((f.meta as any)[k], v, k);
  assert.equal(f.meta.cwd, src.meta.cwd);
  assert.ok(f.meta.vendorSessionId && f.meta.vendorSessionId !== CID);
  assert.equal(f.meta.forkFrom, undefined, 'Claude 는 지금 갈랐다 — 첫 기동의 fork 가 아니다');
  assert.equal(fs.readdirSync(pd).length, before + 1, '벤더 쪽 복제본 파일');
  const g = EventLog.open(sessionsDir, f.meta.id)!;
  assert.deepEqual(kinds(g).filter((k) => k === 'turn.start' || k === 'turn.end'), ['turn.start', 'turn.end', 'turn.start', 'turn.end']);
  const mark = g.all.at(-1)!.ev as Extract<CoreEvent, { kind: 'session.imported' }>;
  assert.deepEqual([mark.kind, mark.vendorSessionId, mark.fork], ['session.imported', CID, true]);
  const lastEnd = [...g.all].reverse().find((e) => e.ev.kind === 'turn.end')!.ev as Extract<CoreEvent, { kind: 'turn.end' }>;
  assert.equal(mark.uuid, lastEnd.uuid, '표지 지점은 복제본 벤더 세션의 마지막 항목 — 되돌리기가 거기서 다시 연다');
  const srcEnd = [...src.all].reverse().find((e) => e.ev.kind === 'turn.end')!;
  const gEnd = [...g.all].reverse().find((e) => e.ev.kind === 'turn.end')!;
  assert.deepEqual([gEnd.at, (gEnd.ev as any).durationMs], [srcEnd.at, (srcEnd.ev as any).durationMs], 'SDK 가 복제한 때로 바꿔 쓴 마지막 턴의 시각은 원본 값으로');
  assert.equal(EventLog.open(sessionsDir, 'src00001')!.all.length, src.all.length, '원본 기록은 그대로');
});

test('forkSession(claude): seq 면 그 응답까지만 — 두 번째 복제본은 "A (forked 2)". 끝난 턴이 없거나 모르는 seq 면 거절', async () => {
  const { sessionsDir, src } = await claudeSource();
  const first = src.all.find((e) => e.ev.kind === 'turn.end')!;
  await forkSession(sessionsDir, 'src00001');
  const f = await forkSession(sessionsDir, 'src00001', { seq: first.seq });
  assert.equal(f.meta.title, 'A (forked 2)');
  assert.equal(f.meta.parent?.seq, first.seq);
  const g = EventLog.open(sessionsDir, f.meta.id)!;
  assert.deepEqual(kinds(g).filter((k) => k === 'turn.start' || k === 'turn.end'), ['turn.start', 'turn.end']);
  assert.equal((g.all.find((e) => e.ev.kind === 'turn.start')!.ev as any).text, (src.all.find((e) => e.ev.kind === 'turn.start')!.ev as any).text);
  await assert.rejects(forkSession(sessionsDir, 'src00001', { seq: 1 }), /no finished turn at seq 1/);
  await assert.rejects(forkSession(sessionsDir, 'nope0000'), /no session nope0000/);
  EventLog.create(sessionsDir, { id: 'empty001', vendor: 'claude', cwd: src.meta.cwd, title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false }).close();
  await assert.rejects(forkSession(sessionsDir, 'empty001'), /no finished turn to fork yet/);
  assert.equal(EventLog.list(sessionsDir).length, 4, '거절된 복제는 세션을 남기지 않는다');
});

test('forkSession(codex): 원본 thread 를 지점까지 읽고 forkFrom·forkAt — 복제본의 첫 기동이 thread/fork lastTurnId 로 가른다', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${path.join(FIX, 'fake-codex.mjs')}`;
  process.env.FAKE_CODEX_TURNS = path.join(FIX, 'codex-turns.json');
  const turns = JSON.parse(fs.readFileSync(process.env.FAKE_CODEX_TURNS, 'utf8'));
  const dir = tmp('slcode-f-'), work = tmp('slcode-f-work-');
  const calls = path.join(dir, 'calls.jsonl');
  process.env.FAKE_CODEX_CALLS = calls;
  try {
    const { sessionsDir } = corePaths(dir);
    const src = EventLog.create(sessionsDir, { id: 'cdx00001', vendor: 'codex', cwd: work, title: null, vendorSessionId: 'thr-x', createdAt: 1, permissionMode: 'auto', raw: false, model: 'gpt-x' });
    await pullHistory(src, 'thr-x');
    const first = src.all.find((e) => e.ev.kind === 'turn.end')!;
    const f = await forkSession(sessionsDir, 'cdx00001', { seq: first.seq });
    assert.deepEqual([f.meta.title, f.meta.vendorSessionId, f.meta.forkFrom, f.meta.forkAt, f.meta.model], ['cdx00001 (forked)', null, 'thr-x', turns[0].id, 'gpt-x']);
    const g = EventLog.open(sessionsDir, f.meta.id)!;
    assert.deepEqual(kinds(g).filter((k) => k === 'turn.end').length, 1);
    assert.deepEqual(g.all.at(-1)!.ev, { kind: 'session.imported', vendor: 'codex', vendorSessionId: 'thr-x', uuid: turns[0].id, fork: true });
    const h = await serveSession({ dir, cwd: work, resume: f.meta.id, web: false });
    try {
      for (let i = 0; i < 100 && EventLog.open(sessionsDir, f.meta.id)!.meta.vendorSessionId === null; i++) await sleep(100);
      assert.equal(EventLog.open(sessionsDir, f.meta.id)!.meta.vendorSessionId, 'fork-thr-x');
    } finally { await h.close('test'); }
  } finally { delete process.env.FAKE_CODEX_CALLS; delete process.env.FAKE_CODEX_TURNS; }
  const got = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.method === 'thread/fork');
  assert.deepEqual(got.map((c) => [c.method, c.lastTurnId]), [['thread/fork', turns[0].id]]);
});

test('CLI fork: 세션 밖에서 <s> 없이 치면 거절, 세션 안(superlite 밖)에서는 지금 세션을 복제하고 id 만 출력한다 (웹을 붙잡지 않는다), --title', async () => {
  const { sessionsDir, src } = await claudeSource();
  const dir = path.dirname(sessionsDir);
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => execFile(process.execPath, ['--import', import.meta.resolve('tsx'), path.resolve(import.meta.dirname, '..', 'src', 'cli.ts'), ...args],
    { env: { ...process.env, SLCODE_DIR: dir, SLCODE_SESSION_ID: undefined, SUPERLITE_SOCK: undefined, ...env } }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
  assert.equal((await run(['fork'])).code, 2);
  assert.equal((await run(['fork', 'src00001', '--model', 'x'])).code, 2, '새 세션 옵션은 받지 않는다');
  const r = await run(['fork', '--title', 'try-b'], { SLCODE_SESSION_ID: 'src00001' });
  assert.equal(r.code, 0, r.stderr);
  const id = r.stdout.trim();
  const m = EventLog.open(sessionsDir, id)!.meta;
  assert.deepEqual([m.title, m.parent?.id, m.parent?.kind], ['try-b', src.meta.id, 'fork']);
  assert.match(r.stderr, new RegExp(`slcode resume ${id}`));
});
