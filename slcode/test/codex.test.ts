// Codex 어댑터 — 가짜 app-server(test/fixtures/fake-codex.mjs)로 프로토콜 매핑을 본다. 실제 codex 는 부르지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveSession } from '../src/serve.ts';
import { connectSession } from '../src/client.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('codex: initialize→thread/start→turn/start, 델타·도구·승인(acceptForSession)·turn.end 매핑, models·status, resume 는 thread/resume', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false });
  assert.equal(h.session.vendor, 'codex');
  const c = await connectSession(h.sock);
  await c.request('session.attach', { id: h.session.id });
  const evs: any[] = [];
  const turnEnd = new Promise<void>((r) => c.onEvent((m) => { if (m.event !== 'session.event') return; const ev = (m.params as any).ev; evs.push(ev); if (ev.kind === 'approval.requested') void c.request('session.approve', { id: h.session.id, requestId: ev.requestId, decision: 'allow', remember: true }); if (ev.kind === 'turn.end') r(); }));
  await c.request('session.send', { id: h.session.id, text: 'hello codex' });
  await Promise.race([turnEnd, sleep(8000).then(() => { throw new Error('turn timeout'); })]);
  const kinds = evs.map((e) => e.kind);
  assert.equal(kinds[0], 'turn.start');
  assert.ok(kinds.includes('session.ready') && evs.find((e) => e.kind === 'session.ready').vendor === 'codex');
  assert.ok(kinds.includes('thinking.delta'));
  assert.ok(evs.some((e) => e.kind === 'text.delta' && e.text === 'echo:hello codex'));
  const ts = evs.find((e) => e.kind === 'tool.start'); assert.equal(ts.name, 'Bash'); assert.equal(ts.toolUseId, 'exec-1'); assert.equal(ts.input.command, 'touch x');
  const ap = evs.find((e) => e.kind === 'approval.requested'); assert.equal(ap.name, 'Bash'); assert.equal(ap.toolUseId, 'exec-1'); assert.equal(ap.input.reason, 'outside sandbox');
  assert.ok(evs.some((e) => e.kind === 'text.delta' && e.text === 'decision=acceptForSession'), 'remember → acceptForSession');
  const te = evs.find((e) => e.kind === 'tool.end'); assert.equal(te.ok, true); assert.equal(te.summary, 'ok');
  const end = evs.find((e) => e.kind === 'turn.end'); assert.equal(end.ok, true); assert.equal(end.costUsd, null); assert.equal(end.usage.output, 50);
  assert.equal(kinds.at(-1), 'session.state');
  const models = await c.request('session.models', { id: h.session.id });
  assert.deepEqual(models.models.map((m) => [m.value, m.displayName, m.efforts]), [['fake-model', 'Fake 1.0', ['low', 'high']]]);
  const st = await c.request('session.status', { id: h.session.id });
  assert.deepEqual(st.context, { tokens: 500, max: 200000, pct: 0.25 }, 'last(현재 컨텍스트), total(누계) 아님');
  assert.equal(st.limits.fiveHour.pct, 3); assert.equal(st.limits.sevenDay.pct, 40);
  await c.request('session.setMode', { id: h.session.id, mode: 'plan' });
  assert.deepEqual((await c.request('session.commands', { id: h.session.id })).map((x: any) => x.name), ['compact']);
  // /compact 는 turn/start 대신 thread/compact/start — 압축 턴이 manual 로 표시되고 turn.end 로 끝난다
  const n0 = evs.length;
  const compactEnd = new Promise<void>((r) => c.onEvent((m) => { if (m.event === 'session.event' && (m.params as any).ev.kind === 'turn.end') r(); }));
  await c.request('session.send', { id: h.session.id, text: '/compact' });
  await compactEnd;
  const ck = evs.slice(n0).map((e) => e.kind);
  assert.ok(ck.includes('context.compacted') && evs.slice(n0).find((e) => e.kind === 'context.compacted').trigger === 'manual', String(ck));
  assert.ok(!ck.includes('text.delta'), '모델에게 텍스트로 가지 않는다');
  await assert.rejects(c.request('session.rewind', { id: h.session.id, seq: 1, conversation: true, files: false }), /not supported/);
  c.close();
  await h.close('test');
  
  // --resume: 같은 세션을 다시 열면 thread/resume 로 같은 thread id, 모드는 meta 에서
  const h2 = await serveSession({ dir, cwd: work, resume: h.session.id, web: false });
  assert.equal(h2.session.vendor, 'codex');
  const c2 = await connectSession(h2.sock);
  const r = await c2.request('session.attach', { id: h2.session.id });
  assert.equal(r.info.vendorSessionId, 'thr-1'); assert.equal(r.info.permissionMode, 'plan');
  await sleep(300);
  const ready = (await c2.request('session.attach', { id: h2.session.id })).history.filter((e) => e.ev.kind === 'session.ready');
  assert.equal(ready.length, 2, '두 번째 기동의 ready 도 로그에');
  c2.close();
  await h2.close('test'); 
});

test('codex: meta.forkFrom(slcode import --fork) 이면 첫 기동이 thread/fork 로 새 thread 를 받고, 다시 띄우면 그 thread 를 resume', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  EventLog.create(corePaths(dir).sessionsDir, { id: 'ffff0001', vendor: 'codex', cwd: work, title: null, vendorSessionId: null, forkFrom: 'thr-orig', createdAt: 1, permissionMode: null, raw: false }).close();
  const h = await serveSession({ dir, cwd: work, resume: 'ffff0001', web: false });
  await sleep(300);
  assert.equal(EventLog.open(corePaths(dir).sessionsDir, 'ffff0001')!.meta.vendorSessionId, 'fork-thr-orig');
  await h.close('test');
  const h2 = await serveSession({ dir, cwd: work, resume: 'ffff0001', web: false });
  await sleep(300);
  assert.equal(EventLog.open(corePaths(dir).sessionsDir, 'ffff0001')!.meta.vendorSessionId, 'fork-thr-orig', '두 번째 기동은 fork 가 아니라 resume');
  await h2.close('test');
});
