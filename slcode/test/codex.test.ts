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
import { estimateCostUsd } from '../src/codex.ts';

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
  const att = await c.request('session.attach', { id: h.session.id });
  const evs: any[] = [];
  // core 는 다른 프로세스 — turn.end 와 뒤따르는 session.state 가 따로 도착할 수 있어 state 까지 기다린다
  let ended = false;
  const turnEnd = new Promise<void>((r) => c.onEvent((m) => { if (m.event !== 'session.event') return; const ev = (m.params as any).ev; evs.push(ev); if (ev.kind === 'approval.requested') void c.request('session.approve', { id: h.session.id, requestId: ev.requestId, decision: 'allow', remember: true }); if (ev.kind === 'turn.end') ended = true; if (ended && ev.kind === 'session.state') r(); }));
  await c.request('session.send', { id: h.session.id, text: 'hello codex' });
  await Promise.race([turnEnd, sleep(8000).then(() => { throw new Error('turn timeout'); })]);
  const kinds = evs.map((e) => e.kind);
  assert.equal(kinds[0], 'turn.start');
  // core 는 다른 프로세스라 attach 전에 기동을 마쳤으면 ready 는 기록(history) 쪽에 있다
  assert.ok([...att.history.map((e) => e.ev), ...evs].some((e: any) => e.kind === 'session.ready' && e.vendor === 'codex'));
  assert.ok(kinds.includes('thinking.delta'));
  assert.ok(evs.some((e) => e.kind === 'text.delta' && e.text === 'echo:hello codex'));
  const ts = evs.find((e) => e.kind === 'tool.start'); assert.equal(ts.name, 'Bash'); assert.equal(ts.toolUseId, 'exec-1'); assert.equal(ts.input.command, 'touch x');
  const ap = evs.find((e) => e.kind === 'approval.requested'); assert.equal(ap.name, 'Bash'); assert.equal(ap.toolUseId, 'exec-1'); assert.equal(ap.input.reason, 'outside sandbox');
  assert.ok(evs.some((e) => e.kind === 'text.delta' && e.text === 'decision=acceptForSession'), 'remember → acceptForSession');
  const te = evs.find((e) => e.kind === 'tool.end'); assert.equal(te.ok, true); assert.equal(te.summary, 'ok');
  const end = evs.find((e) => e.kind === 'turn.end'); assert.equal(end.ok, true); assert.equal(end.costUsd, null); assert.equal(end.usage.output, 50);
  assert.equal(end.uuid, 't-1', 'turn id — 다시 import 할 때 이어 붙일 기준');
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

test('codex: 인증 실패 턴 — 재시도 알림은 오류 줄로 남기지 않고, 마지막 오류는 turn.end(ok false, errorKind auth) 하나로 (ticket slcode-auth-error-shown-as-answer)', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false });
  const c = await connectSession(h.sock);
  try {
    await c.request('session.attach', { id: h.session.id });
    const evs: any[] = [];
    const turnEnd = new Promise<void>((r) => c.onEvent((m) => { if (m.event !== 'session.event') return; const ev = (m.params as any).ev; evs.push(ev); if (ev.kind === 'turn.end') r(); }));
    await c.request('session.send', { id: h.session.id, text: 'auth-fail' });
    await Promise.race([turnEnd, sleep(8000).then(() => { throw new Error('turn timeout'); })]);
    assert.deepEqual(evs.filter((e) => e.kind === 'error'), []);
    const end = evs.find((e) => e.kind === 'turn.end');
    assert.equal(end.ok, false); assert.equal(end.interrupted, false);
    assert.equal(end.error, 'unexpected status 401 Unauthorized'); assert.equal(end.errorKind, 'auth');
  } finally { c.close(); await h.close('test'); }
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

test('codex: auto 모드 = on-request + workspaceWrite + approvalsReviewer auto_review, 다른 모드로 돌리면 reviewer 는 user (사용자 2026-10-09)', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false });
  const c = await connectSession(h.sock);
  await c.request('session.attach', { id: h.session.id });
  await sleep(300);
  const deltas: string[] = [];
  let ended: (() => void) | null = null;
  c.onEvent((m) => { if (m.event !== 'session.event') return; const ev = (m.params as any).ev; if (ev.kind === 'text.delta') deltas.push(ev.text); if (ev.kind === 'approval.requested') void c.request('session.approve', { id: h.session.id, requestId: ev.requestId, decision: 'allow' }); if (ev.kind === 'turn.end') ended?.(); });
  const turn = async (text: string) => { const done = new Promise<void>((r) => (ended = r)); await c.request('session.send', { id: h.session.id, text }); await Promise.race([done, sleep(8000).then(() => { throw new Error('turn timeout'); })]); };
  await c.request('session.setMode', { id: h.session.id, mode: 'auto' });
  await turn('a');
  assert.ok(deltas.includes('policy=on-request reviewer=auto_review sandbox=workspaceWrite'), deltas.join(' | '));
  const rv = (await c.request('session.attach', { id: h.session.id })).history.map((e: any) => e.ev).find((e: any) => e.kind === 'review');
  assert.deepEqual(rv, { kind: 'review', toolUseId: 'exec-1', decision: 'denied', risk: 'high', action: 'touch x', rationale: 'too risky' });
  await c.request('session.setMode', { id: h.session.id, mode: 'acceptEdits' });
  await turn('b');
  assert.ok(deltas.includes('policy=on-request reviewer=user sandbox=workspaceWrite'), 'resume·다음 턴에 이전 reviewer 가 남지 않게 늘 명시');
  c.close();
  await h.close('test');
});

test('codex: 비용은 가격표로 추정한 누계 — 표에 없는 모델은 null (사용자 2026-10-09)', async () => {
  assert.equal(estimateCostUsd('fake-model', { inputTokens: 1000 }), null);
  assert.equal(estimateCostUsd(null, { inputTokens: 1000 }), null);
  // terra: 새 입력 50만 × $2 + 캐시 읽기 50만 × $0.2 + 출력 10만 × $12
  assert.ok(Math.abs(estimateCostUsd('gpt-5.6-terra', { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 })! - 2.3) < 1e-9);
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false });
  const c = await connectSession(h.sock);
  await c.request('session.attach', { id: h.session.id });
  await sleep(300);
  await c.request('session.setModel', { id: h.session.id, model: 'gpt-5.6-luna' });
  const turnEnd = new Promise<any>((r) => c.onEvent((m) => { if (m.event !== 'session.event') return; const ev = (m.params as any).ev; if (ev.kind === 'approval.requested') void c.request('session.approve', { id: h.session.id, requestId: ev.requestId, decision: 'allow' }); if (ev.kind === 'turn.end') r(ev); }));
  await c.request('session.send', { id: h.session.id, text: 'hi' });
  const end = await Promise.race([turnEnd, sleep(8000).then(() => { throw new Error('turn timeout'); })]);
  // 첫 tokenUsage 는 last 만 센다 (total 엔 resume 이전 사용량이 있을 수 있다): 새 입력 400 × 0.2 + 캐시 50 × 0.02 + 출력 50 × 1.2 = 141 (/1M)
  assert.ok(Math.abs(end.costUsd - 141e-6) < 1e-12, String(end.costUsd));
  c.close();
  await h.close('test');
});

test('core: session.attach limit 은 끝 한 페이지·more·summary, session.history 는 그 앞 페이지, limit 없으면 지금처럼 전체 (ticket slcode-history-paging)', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const log = EventLog.create(corePaths(dir).sessionsDir, { id: 'pppp0001', vendor: 'codex', cwd: work, title: null, vendorSessionId: 'thr-1', createdAt: 1, permissionMode: null, raw: false });
  let seq = 0;
  for (let t = 0; t < 30; t++) for (const ev of [{ kind: 'turn.start', text: `t${t}`, origin: null }, { kind: 'text.delta', text: 'a' }, { kind: 'text.delta', text: 'b' },
    { kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: 0.01 * (t + 1), durationMs: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }]) log.append({ seq: ++seq, at: 0, ev: ev as any });
  log.close();
  const h = await serveSession({ dir, cwd: work, resume: 'pppp0001', web: false });
  const c = await connectSession(h.sock);
  try {
    const a = await c.request('session.attach', { id: h.session.id, limit: 10 });
    assert.equal(a.more, true);
    assert.equal(a.history[0].ev.kind, 'turn.start'); assert.match((a.history[0].ev as any).text, /^t2[6-9]$/, '턴당 3항목(delta 묶음) — 끝에서 10항목 안팎 (재개 때 붙는 상태 이벤트도 센다)');
    assert.equal(a.summary!.turns, 30); assert.ok(Math.abs(a.summary!.costUsd! - 0.3) < 1e-9); assert.equal(a.summary!.usage.input, 30);
    const older = await c.request('session.history', { id: h.session.id, before: a.history[0].seq, limit: 1000 });
    assert.equal(older.more, false); assert.equal(older.history[0].seq, 1); assert.equal(older.history.at(-1)!.seq, a.history[0].seq - 1);
    const full = await c.request('session.attach', { id: h.session.id });
    assert.equal(full.summary, undefined); assert.equal(full.more, undefined); assert.equal(full.history[0].seq, 1, 'limit 없으면 지금처럼 since 뒤 전체');
    await assert.rejects(c.request('session.history', { id: h.session.id } as any), /before and limit/);
  } finally { c.close(); await h.close('test'); }
});
