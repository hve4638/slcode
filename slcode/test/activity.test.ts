// 활동 기록 (ticket slcode-activity-state) — 판정(classify)은 시각을 손으로 준 원자료로, 기록(Activity)은 임시 세션 폴더로,
// core 연결은 가짜 codex 로 띄운 세션에서 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Activity, classify, THRESHOLDS } from '../src/activity.ts';
import type { ActivityRecord } from '../src/protocol.ts';

const M = 60e3;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-act-'));
const agent = (t: number, state: 'running' | 'asking' | 'idle' | 'exited'): ActivityRecord => ({ t, type: 'agent', state });
const weak = (t: number, what = 'key'): ActivityRecord => ({ t, type: 'sig', strength: 'weak', what });
const strong = (t: number, what = 'button'): ActivityRecord => ({ t, type: 'sig', strength: 'strong', what });
const afk = (r: ReturnType<typeof classify>) => r.user.filter((u) => u.label === 'afk').map((u) => [u.from / M, u.to / M]);

test('classify: 20분 동안 신호가 없으면 AFK — 시작은 마지막 신호 + 5분', () => {
  const r = classify([agent(0, 'idle'), weak(1 * M)], 30 * M);
  assert.deepEqual(afk(r), [[6, 30]]);
  assert.deepEqual(r.current, { agent: 'idle', label: 'afk', since: 6 * M, agentSince: 0 });
  assert.deepEqual(afk(classify([agent(0, 'idle'), weak(1 * M)], 20 * M)), [], '20분이 차기 전에는 확인 중이다');
});

test('classify: 강한 신호 하나로 AFK 가 그 시각에 끝난다', () => {
  const r = classify([agent(0, 'idle'), weak(0), strong(40 * M)], 50 * M);
  assert.deepEqual(afk(r), [[5, 40]]);
  assert.equal(r.current?.label, 'active');
  assert.equal(r.current?.since, 40 * M);
});

test('classify: 1분 안 약한 신호 세 번이면 첫 신호에서 끝나고, 흩어진 약한 신호는 잠깐 확인으로 남는다', () => {
  const r = classify([agent(0, 'idle'), weak(0), weak(30 * M), weak(40 * M), weak(40 * M + 20e3, 'click'), weak(40 * M + 40e3, 'scroll')], 45 * M);
  assert.deepEqual(afk(r), [[5, 40]]);
  assert.deepEqual(r.peeks.map((p) => p.t / M), [30], '30분의 하나는 1분 안에 짝이 없었다');
});

test('classify: 약한 신호로 풀린 뒤 1분 안에 다시 AFK 면 해제를 없던 것으로 한다', () => {
  const recs = [agent(0, 'idle'), weak(0), weak(30 * M), weak(30 * M + 10e3), weak(30 * M + 20e3)];
  // 30분에 풀렸다가 마지막 신호(30:20) 뒤 20분 → 다시 AFK — 해제 뒤 1분 안이라 이어 붙인다
  const r = classify(recs, 60 * M);
  assert.deepEqual(afk(r), [[5, 60]]);
  assert.equal(r.peeks.length, 3, '해제에 쓰인 약한 신호는 잠깐 확인으로');
});

test('classify: 응답 대기 동안에도 센다 — 이미 20분이 지났으면 응답이 끝난 직후부터 AFK', () => {
  const r = classify([agent(0, 'idle'), { t: 1 * M, type: 'sent' }, agent(1 * M, 'running'), agent(31 * M, 'idle')], 40 * M);
  assert.deepEqual(afk(r), [[31, 40]], 'AFK 는 6분부터지만 사람 줄은 사용자 차례에만 있다');
  assert.deepEqual(r.points, [{ t: 1 * M, kind: 'sent' }]);
  assert.deepEqual(classify([agent(0, 'idle'), agent(1 * M, 'running')], 40 * M).current, { agent: 'running', label: 'waiting', since: 1 * M, agentSince: 1 * M });
});

test('classify: 세션 꺼짐과 응답 대기는 사람 차례가 아니다', () => {
  const r = classify([agent(0, 'idle'), strong(0), agent(2 * M, 'exited'), agent(10 * M, 'idle'), strong(10 * M)], 12 * M);
  assert.deepEqual(r.user.map((u) => [u.from / M, u.to / M, u.label]), [[0, 2, 'active'], [10, 12, 'active']]);
  assert.deepEqual(r.agent.map((a) => a.state), ['idle', 'exited', 'idle']);
  assert.equal(r.start, 0);
});

test('Activity: 같은 상태는 한 번만, 신호 형식 검사, 크래시 꼬리는 다음 기동에 세션 꺼짐, 교체는 이어진다', () => {
  const dir = tmp();
  let now = 1000;
  const a = Activity.open(dir, () => now);
  a.agent('starting'); a.agent('idle'); now = 2000; a.agent('requires_action'); a.sent();
  assert.equal(a.signal('weak', 'key'), true);
  assert.equal(a.signal('weak', 'Key Down'), false);
  assert.equal(a.signal('loud', 'key'), false);
  assert.deepEqual(a.records.map((r) => r.type === 'agent' ? r.state : r.type), ['idle', 'asking', 'sent', 'sig']);

  // 크래시 — exited 없이 끝났다
  now = 9000;
  const b = Activity.open(dir, () => now);
  assert.deepEqual(b.records.at(-1), { t: 2000, type: 'agent', state: 'exited' }, '마지막 기록 시각부터 꺼짐');
  b.agent('idle'); b.handoff();
  const c = Activity.open(dir, () => now);
  assert.equal(c.records.at(-1)?.type, 'handoff', '교체 뒤에는 꺼짐을 적지 않는다');
  fs.appendFileSync(c.file, 'not json\n');
  assert.equal(Activity.open(dir, () => now).records.filter((r) => r.type === 'handoff').length, 1, '깨진 줄은 건너뛴다');
});

test('Activity.result: from 뒤에 걸친 것만', () => {
  let now = 0;
  const a = Activity.open(tmp(), () => now);
  a.agent('idle'); a.signal('strong', 'type'); now = 10 * M; a.sent(); a.agent('running'); now = 70 * M;
  const r = a.result(now - 60 * M);
  assert.deepEqual(r.points.map((p) => p.t), [10 * M]);
  assert.deepEqual(r.agent.map((x) => x.state), ['running'], '0~10분의 idle 은 빠진다');
  assert.equal(r.start, 0, 'start 는 자르지 않는다');
  assert.equal(THRESHOLDS.afkAfter, 20 * M);
});

test('core: 사람이 보낸 요청·답변과 화면 신호를 세션 폴더에 남기고, 메시지 턴은 점이 아니며, 닫으면 세션 꺼짐', { timeout: 60000 }, async () => {
  const saved = { ...process.env };
  const dir = tmp(), work = tmp();
  Object.assign(process.env, { SLCODE_CODEX_BIN: `${process.execPath} ${path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs')}`, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const h = await runCore({ dir, cwd: work, vendor: 'codex', permissionMode: 'default' });
  const c = await connectSession(h.sock);
  const id = h.session.id;
  try {
    let wake: (() => void) | null = null;
    const seen: any[] = [];
    c.onEvent((m: any) => { if (m.event === 'session.event') { seen.push(m.params.ev); wake?.(); } });
    await c.request('core.own', { pid: process.pid });
    await c.request('session.attach', { id });
    const until = async (f: (e: any) => boolean) => { while (!seen.some(f)) await new Promise<void>((r) => (wake = r)); };
    await c.request('session.signal', { id, strength: 'weak', what: 'key' });
    await assert.rejects(c.request('session.signal', { id, strength: 'weak', what: '' }), /strength weak\|strong/);
    await c.request('session.send', { id, text: 'hi' });
    await until((e) => e.kind === 'approval.requested');
    const req = seen.find((e) => e.kind === 'approval.requested');
    await c.request('session.approve', { id, requestId: req.requestId, decision: 'allow' });
    await until((e) => e.kind === 'turn.end');
    await c.request('session.send', { id, text: 'from another', origin: 'mail' });
    await until((e) => e.kind === 'turn.start' && e.origin === 'mail');
    const r = await c.request('session.activity', { id });
    assert.deepEqual(r.points.map((p) => p.kind), ['sent', 'answered'], '메시지 턴은 점이 아니다');
    assert.ok(r.agent.some((a) => a.state === 'running') && r.agent.some((a) => a.state === 'asking'), JSON.stringify(r.agent));
  } finally {
    c.close();
    await h.close('test');
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const sess = fs.readdirSync(path.join(dir, 'sessions'), { recursive: true }).map(String).find((f) => f.endsWith('activity.jsonl'))!;
  const lines = fs.readFileSync(path.join(dir, 'sessions', sess), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.at(-1).state, 'exited', '닫으면 세션 꺼짐');
  assert.ok(lines.some((l) => l.type === 'sig' && l.what === 'key'));
});
