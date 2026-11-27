// 세션 파일 (ticket slcode-session-bundle) — 옮기기 전·뒤 두 머신(서로 다른 SLCODE_DIR·CLAUDE_CONFIG_DIR·CODEX_HOME)과 서로 다른 작업 폴더로
// export <s> <파일> → import <파일> [폴더] 를 본다. Claude 기록은 test/fixtures/claude-session.jsonl(실제 두 턴 세션).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import { importBundle } from '../src/bundle.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const FIX = path.resolve(import.meta.dirname, 'fixtures');
const CID = 'eca2ea0c-cd14-4216-b88c-558435351e88';
const XID = '019f0000-0000-7000-8000-000000000002';
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const slug = (p: string) => p.replace(/[^A-Za-z0-9-]/g, '-');
const rows = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

/** 머신 하나 — slcode 상태 폴더, Claude·Codex 설정 폴더, 작업 폴더 */
function machine(name: string) {
  const work = tmp(`slcode-bd-${name}-work-`), dir = tmp(`slcode-bd-${name}-state-`);
  const claude = tmp(`slcode-bd-${name}-claude-`), codex = tmp(`slcode-bd-${name}-codex-`);
  return { work, dir, env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } };
}
async function withEnv<T>(env: Record<string, string>, f: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await f(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
function run(dir: string, env: Record<string, string>, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => execFile(process.execPath, ['--import', 'tsx', CLI, ...args], { env: { ...process.env, ...env, SLCODE_DIR: dir, SLCODE_SESSION_ID: undefined } }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
}

/** 옮기기 전 머신의 Claude 세션 — 두 턴의 transcript, 서브에이전트 기록 하나, system prompt 판 하나, 팀원 관계 */
function claudeSession(a: ReturnType<typeof machine>) {
  const pd = path.join(a.env.CLAUDE_CONFIG_DIR, 'projects', slug(a.work));
  fs.mkdirSync(path.join(pd, CID, 'subagents'), { recursive: true });
  const transcript = path.join(pd, `${CID}.jsonl`);
  fs.writeFileSync(transcript, fs.readFileSync(path.join(FIX, 'claude-session.jsonl'), 'utf8').replaceAll('__CWD__', a.work));
  fs.writeFileSync(path.join(pd, CID, 'subagents', 'agent-1.jsonl'), '{"type":"user"}\n');
  fs.mkdirSync(path.join(a.dir, 'prompts', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'prompts', 'mine', 'v2.json'), '{"savedAt":1,"original":null,"spec":null}');
  fs.writeFileSync(path.join(a.dir, 'prompts', 'mine', 'prompt.json'), '{"description":"d"}');
  const r = rows(transcript);
  const users = r.filter((o) => o.type === 'user' && typeof o.message.content === 'string');
  const log = EventLog.create(corePaths(a.dir).sessionsDir, {
    id: 'aaaa1111', vendor: 'claude', cwd: a.work, title: 'moved', vendorSessionId: CID, createdAt: 10, updatedAt: 20, closedAt: 30, permissionMode: 'auto', raw: false,
    model: 'claude-haiku-5-5', provider: 'myprov', profile: 'p', prompt: { name: 'mine', version: 2 }, env: { A: '1' }, pid: 99, parent: { id: 'lead0000', kind: 'child' },
  });
  // turn.end 의 uuid 는 그 턴의 사용자 메시지·마지막 항목 (되돌리기가 쓴다)
  const second = r.indexOf(users[1]);
  log.append({ seq: 1, at: 11, ev: { kind: 'turn.start', text: users[0].message.content } as any });
  log.append({ seq: 2, at: 12, ev: { kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: null, durationMs: 1, usage: null, userUuid: users[0].uuid, uuid: r[second - 1].uuid } as any });
  log.append({ seq: 3, at: 13, ev: { kind: 'turn.start', text: users[1].message.content } as any });
  log.append({ seq: 4, at: 14, ev: { kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: null, durationMs: 1, usage: null, userUuid: users[1].uuid, uuid: r.at(-1).uuid } as any });
  log.close();
  return { transcript };
}

test('export <s> <파일>: 0600 한 파일, 비밀 경고, 있는 파일은 덮어쓰지 않는다; 파일 없이는 지금처럼 벤더 명령', async () => {
  const a = machine('a');
  claudeSession(a);
  const file = path.join(tmp('slcode-bd-out-'), 'move.slsession');
  const r = await run(a.dir, a.env, ['export', 'moved', file]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /exported aaaa1111 to .*move\.slsession/);
  assert.match(r.stderr, /warning: the file holds the whole conversation, tool output included — treat it like a secret/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  assert.deepEqual([b.format, b.version, b.meta.id, b.events.length, b.vendor.sessionId], ['slcode.session', 1, 'aaaa1111', 4, CID]);
  assert.deepEqual(b.vendor.files.map((f: { path: string }) => f.path).sort(), [`${CID}.jsonl`, path.join(CID, 'subagents', 'agent-1.jsonl')]);
  assert.deepEqual([b.prompt.name, b.prompt.version, b.prompt.description], ['mine', 2, 'd']);
  const again = await run(a.dir, a.env, ['export', 'moved', file]);
  assert.equal(again.code, 1); assert.match(again.stderr, /already exists/);
  const cmd = await run(a.dir, a.env, ['export', 'moved']);
  assert.equal(cmd.stdout.trim(), `cd '${a.work}' && claude --resume ${CID}`);
});

test('import <파일> (claude): 새 머신·새 폴더의 새 세션 — 원본 transcript 를 제자리에 두고 복제, slcode 기록의 uuid 는 복제본 것으로; 두 번 들여오면 둘', async () => {
  const a = machine('a'), b = machine('b');
  const { transcript } = claudeSession(a);
  const file = path.join(tmp('slcode-bd-out-'), 'move.slsession');
  assert.equal((await run(a.dir, a.env, ['export', 'aaaa1111', file])).code, 0);

  const P = corePaths(b.dir);
  const log = await withEnv(b.env, () => importBundle(file, P.sessionsDir, P.dir, b.work));
  const m = log.meta;
  assert.notEqual(m.id, 'aaaa1111');
  assert.deepEqual([m.cwd, m.title, m.model, m.provider, m.profile, m.env, m.prompt, m.createdAt, m.updatedAt], [b.work, 'moved', 'claude-haiku-5-5', 'myprov', 'p', { A: '1' }, { name: 'mine', version: 2 }, 10, 20]);
  assert.deepEqual(m.movedFrom!.id + m.movedFrom!.cwd, 'aaaa1111' + a.work);
  assert.equal(m.parent, undefined, '이 머신에 없는 관계는 잇지 않는다'); assert.equal(m.pid, undefined);
  assert.ok(m.closedAt! > 30, '들여온 때가 꺼진 순서의 맨 앞');

  // 원본은 새 폴더의 프로젝트 폴더에 그대로(내용을 고치지 않는다), 복제본이 같은 곳에
  const pd = path.join(b.env.CLAUDE_CONFIG_DIR, 'projects', slug(b.work));
  assert.equal(fs.readFileSync(path.join(pd, `${CID}.jsonl`), 'utf8'), fs.readFileSync(transcript, 'utf8'));
  assert.ok(fs.existsSync(path.join(pd, CID, 'subagents', 'agent-1.jsonl')));
  assert.ok(m.vendorSessionId && m.vendorSessionId !== CID);
  const fork = rows(path.join(pd, `${m.vendorSessionId}.jsonl`)).filter((o) => o.forkedFrom);
  const newOf = new Map(fork.map((o) => [o.forkedFrom.messageUuid, o.uuid]));
  const ends = EventLog.open(P.sessionsDir, m.id)!.all.filter((e) => e.ev.kind === 'turn.end').map((e) => e.ev as any);
  const old = (await withEnv(a.env, async () => EventLog.open(corePaths(a.dir).sessionsDir, 'aaaa1111')!)).all.filter((e) => e.ev.kind === 'turn.end').map((e) => e.ev as any);
  assert.deepEqual(ends.map((e) => [e.userUuid, e.uuid]), old.map((e) => [newOf.get(e.userUuid), newOf.get(e.uuid)]));
  assert.ok(ends.every((e) => e.uuid && e.userUuid));
  assert.equal(fs.readFileSync(path.join(P.dir, 'prompts', 'mine', 'v2.json'), 'utf8'), '{"savedAt":1,"original":null,"spec":null}');

  const second = await withEnv(b.env, () => importBundle(file, P.sessionsDir, P.dir, b.work));
  assert.notEqual(second.meta.id, m.id); assert.notEqual(second.meta.vendorSessionId, m.vendorSessionId);
  assert.equal(EventLog.list(P.sessionsDir).length, 2);
});

test('import <파일> (codex): rollout 을 원래 날짜 폴더에 두고 첫 기동이 thread/fork', async () => {
  const a = machine('a'), b = machine('b');
  const rel = path.join('2026', '10', '07', `rollout-2026-10-07T01-02-03-${XID}.jsonl`);
  fs.mkdirSync(path.dirname(path.join(a.env.CODEX_HOME, 'sessions', rel)), { recursive: true });
  fs.writeFileSync(path.join(a.env.CODEX_HOME, 'sessions', rel), JSON.stringify({ type: 'session_meta', payload: { id: XID, cwd: a.work } }) + '\n');
  EventLog.create(corePaths(a.dir).sessionsDir, { id: 'cccc2222', vendor: 'codex', cwd: a.work, title: null, vendorSessionId: XID, createdAt: 1, permissionMode: 'auto', raw: false }).close();
  const file = path.join(tmp('slcode-bd-out-'), 'x.slsession');
  assert.equal((await run(a.dir, a.env, ['export', 'cccc2222', file])).code, 0);
  const P = corePaths(b.dir);
  const m = (await withEnv(b.env, () => importBundle(file, P.sessionsDir, P.dir, b.work))).meta;
  assert.deepEqual([m.cwd, m.vendorSessionId, m.forkFrom], [b.work, null, XID]);
  assert.ok(fs.existsSync(path.join(b.env.CODEX_HOME, 'sessions', rel)));
});

test('import 실패: 세션 파일이 아니면 아무것도 쓰지 않는다; 폴더가 아니면 usage', async () => {
  const b = machine('b');
  const bad = path.join(tmp('slcode-bd-out-'), 'bad.slsession');
  fs.writeFileSync(bad, zlib.gzipSync('{"format":"other"}'));
  const r = await run(b.dir, b.env, ['import', bad, b.work]);
  assert.equal(r.code, 1); assert.match(r.stderr, /is not a slcode session file/);
  assert.equal(EventLog.list(corePaths(b.dir).sessionsDir).length, 0);
  const nf = await run(b.dir, b.env, ['import', bad, path.join(b.work, 'nope')]);
  assert.equal(nf.code, 2); assert.match(nf.stderr, /not a folder/);
});
