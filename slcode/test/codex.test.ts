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
import { SLCODE_PROMPT, familyPrompt } from '../src/prompt.ts';
/** 새 세션의 고정 지시 — 팀원 기능은 기본 켜짐이라 만드는 법이 붙는다 (ticket slcode-team-agent) */
const LEAD_PROMPT = `${SLCODE_PROMPT}\n\n${familyPrompt({ team: true, leader: null, options: null, tools: false })}`;
import { addPlugin, setPlugin } from 'slcode-plugin/agentPlugins';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 그 세션의 n 번째 codex 기동이 끝날 때까지(로그에 session.ready 가 n 개) 기다려 그때의 로그를 준다. vendorSessionId 는 ready 보다 먼저 쓰인다.
 *  고정 sleep(300) 은 전체 테스트를 병렬로 돌리는 부하에서 모자라 단언이 실패했고, 닫지 못한 세션 때문에 파일이 끝나지 않고 멈췄다 */
async function untilReady(dir: string, id: string, n: number): Promise<EventLog> {
  for (let i = 0; i < 100; i++) {
    const log = EventLog.open(corePaths(dir).sessionsDir, id)!;
    if (log.all.filter((x) => x.ev.kind === 'session.ready').length >= n) return log;
    await sleep(100);
  }
  throw new Error(`codex start ${n} of ${id} not ready`);
}

test('codex: initialize→thread/start→turn/start, 델타·도구·승인(acceptForSession)·turn.end 매핑, models·status, resume 는 thread/resume', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false });
  assert.equal(h.session.vendor, 'codex');
  assert.equal(h.session.permissionMode, 'auto', '새 세션은 자동 승인으로 시작 (사용자 2026-10-24)');
  const c = await connectSession(h.sock);
  const evs: any[] = [];
  // core 는 다른 프로세스 — turn.end 와 뒤따르는 session.state 가 따로 도착할 수 있어 state 까지 기다린다.
  // attach 전에 듣는다: attach 응답과 같은 청크로 온 ready·idle 은 응답을 기다린 뒤 등록하면 이미 지나가 버린다
  let ended = false;
  const turnEnd = new Promise<void>((r) => c.onEvent((m) => { if (m.event !== 'session.event') return; const ev = (m.params as any).ev; evs.push(ev); if (ev.kind === 'approval.requested') void c.request('session.approve', { id: h.session.id, requestId: ev.requestId, decision: 'allow', remember: true }); if (ev.kind === 'turn.end') ended = true; if (ended && ev.kind === 'session.state') r(); }));
  const att = await c.request('session.attach', { id: h.session.id });
  await c.request('session.send', { id: h.session.id, text: 'hello codex' });
  await Promise.race([turnEnd, sleep(8000).then(() => { throw new Error('turn timeout'); })]);
  // turn.start 앞은 attach 뒤에 도착한 기동 이벤트(ready·idle)뿐이어야 한다
  const early = evs.splice(0, evs.findIndex((e) => e.kind === 'turn.start'));
  assert.ok(early.every((e) => e.kind === 'session.ready' || e.kind === 'session.state'), String(early.map((e) => e.kind)));
  const kinds = evs.map((e) => e.kind);
  assert.equal(kinds[0], 'turn.start');
  // core 는 다른 프로세스라 attach 전에 기동을 마쳤으면 ready 는 기록(history) 쪽에, 아니면 attach 직후 이벤트로 온다
  assert.ok([...att.history.map((e) => e.ev), ...early, ...evs].some((e: any) => e.kind === 'session.ready' && e.vendor === 'codex'));
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
  await assert.rejects(c.request('session.setMode', { id: h.session.id, mode: 'plan' }), /mode default\|auto\|bypassPermissions/, '메뉴에서 뺀 모드는 거절');
  await c.request('session.setMode', { id: h.session.id, mode: 'bypassPermissions' });
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
  assert.deepEqual(await c.request('session.rewindPreview', { id: h.session.id, seq: 1 }), { conversation: false, files: null, error: 'rewind is not supported for codex sessions' });
  assert.deepEqual(await c.request('session.mcp', { id: h.session.id }), []);
  await assert.rejects(c.request('session.mcpReconnect', { id: h.session.id, name: 'x' }), /not supported/);
  c.close();
  await h.close('test');
  
  // --resume: 같은 세션을 다시 열면 thread/resume 로 같은 thread id, 모드는 meta 에서 — 옛 모드(plan)는 auto 로 고쳐 쓴다 (ticket slcode-permission-modes-three)
  const old = EventLog.open(corePaths(dir).sessionsDir, h.session.id)!; assert.equal(old.meta.permissionMode, 'bypassPermissions'); old.updateMeta({ permissionMode: 'plan' }); old.close();
  const h2 = await serveSession({ dir, cwd: work, resume: h.session.id, web: false });
  assert.equal(h2.session.vendor, 'codex');
  const c2 = await connectSession(h2.sock);
  const r = await c2.request('session.attach', { id: h2.session.id });
  assert.equal(r.info.vendorSessionId, 'thr-1'); assert.equal(r.info.permissionMode, 'auto');
  assert.equal(EventLog.open(corePaths(dir).sessionsDir, h.session.id)!.meta.permissionMode, 'auto', 'meta 까지');
  await untilReady(dir, h2.session.id, 2);
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
  try { assert.equal((await untilReady(dir, 'ffff0001', 1)).meta.vendorSessionId, 'fork-thr-orig'); } finally { await h.close('test'); }
  const h2 = await serveSession({ dir, cwd: work, resume: 'ffff0001', web: false });
  try { assert.equal((await untilReady(dir, 'ffff0001', 2)).meta.vendorSessionId, 'fork-thr-orig', '두 번째 기동은 fork 가 아니라 resume'); } finally { await h2.close('test'); }
});

test('codex: slcode 고정 지시는 thread/start·thread/fork 의 developerInstructions 로, thread/resume 에는 넣지 않는다 (ticket slcode-append-system-prompt)', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const calls = path.join(dir, 'calls.jsonl');
  process.env.FAKE_CODEX_CALLS = calls;
  try {
    // n 은 그 세션의 몇 번째 기동인가 — 기동이 끝나야 thread 요청이 calls 에 남는다
    const launch = async (n: number, resume?: string) => { const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false, ...(resume ? { resume } : {}) }); try { await untilReady(dir, h.session.id, n); } finally { await h.close('test'); } return h.session.id; };
    await launch(2, await launch(1));
    EventLog.create(corePaths(dir).sessionsDir, { id: 'ffff0002', vendor: 'codex', cwd: work, title: null, vendorSessionId: null, forkFrom: 'thr-orig', createdAt: 1, permissionMode: null, raw: false }).close();
    await launch(1, 'ffff0002');
  } finally { delete process.env.FAKE_CODEX_CALLS; }
  const got = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(got.map((c) => [c.method, c.developerInstructions === LEAD_PROMPT ? 'prompt' : c.developerInstructions]),
    [['thread/start', 'prompt'], ['thread/resume', null], ['thread/fork', 'prompt']]);
});

test('codex: 에이전트 플러그인 — thread 전에 skills/extraRoots/set, 지시문은 developerInstructions 의 SLCODE_PROMPT 뒤, MCP 는 -c 인자, bin 은 PATH 앞, env 는 프로세스에. 다시 싣기는 skill 만 (ticket slcode-agent-plugin-codex)', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-src-'));
  const put = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true }); fs.writeFileSync(path.join(src, rel), body); };
  put('slcode-plugin.json', JSON.stringify({ name: 'core', parts: { base: {}, extra: { default: false } }, env: { CORE_X: '1' } }));
  put('base/skills/hello/SKILL.md', '---\ndescription: hi\n---\nbody');
  put('base/instructions/a.md', 'Plugin rule.');
  put('base/.mcp.json', JSON.stringify({ echo: { command: 'echo' } }));
  put('base/bin/tool', '#!/bin/sh\n');
  put('extra/skills/more/SKILL.md', '---\ndescription: more\n---\nbody');
  await addPlugin(src, dir);
  const calls = path.join(dir, 'calls.jsonl'), envFile = path.join(dir, 'env.json');
  process.env.FAKE_CODEX_CALLS = calls; process.env.FAKE_CODEX_ENV = envFile;
  const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false });
  try {
    await untilReady(dir, h.session.id, 1);
    const root = fs.realpathSync(path.join(corePaths(dir).sessionsDir, fs.readdirSync(corePaths(dir).sessionsDir)[0], h.session.id, 'agent-plugins/core'));
    let got = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(got.map((c) => c.method), ['skills/extraRoots/set', 'thread/start']);
    assert.deepEqual(got[0].extraRoots, [path.join(root, 'skills')]);
    assert.equal(got[1].developerInstructions, `${LEAD_PROMPT}\n\nPlugin rule.`);
    const env = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(env.CORE_X, '1');
    assert.ok(env.PATH.startsWith(`${path.join(root, 'bin')}${path.delimiter}`), env.PATH);
    // 명령의 PATH 고정(ticket slcode-session-path-rc-override)도 플러그인 bin/ 이 앞인 그 PATH
    assert.deepEqual(env.args.slice(-4), ['-c', 'mcp_servers.plugin_core_echo={"command" = "echo"}', '-c', `shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`]);
    // 다시 싣기 — part 를 켜면 새 빌드의 skill 폴더로 extraRoots 를 다시 부른다
    const c = await connectSession(h.sock);
    const reloaded = new Promise<any>((r) => c.onEvent((m) => { const ev = (m.params as any)?.ev; if (m.event === 'session.event' && ev?.kind === 'plugins.reloaded') r(ev); }));
    await c.request('session.attach', { id: h.session.id });
    await setPlugin('core', ['extra=on'], dir);
    const st = await c.request('session.plugins', { id: h.session.id });
    assert.notEqual(st.plugins[0].current, st.plugins[0].build, '다시 실을 것이 있다');
    assert.deepEqual(await c.request('session.reloadPlugins', { id: h.session.id }), { deferred: false });
    const ev = await Promise.race([reloaded, sleep(5000).then(() => { throw new Error('no plugins.reloaded'); })]);
    assert.deepEqual(ev.later, []);
    got = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const roots = got.at(-1).extraRoots;
    assert.equal(got.at(-1).method, 'skills/extraRoots/set');
    assert.ok(fs.existsSync(path.join(roots[0], 'more/SKILL.md')), roots[0]);
    c.close();
  } finally { delete process.env.FAKE_CODEX_CALLS; delete process.env.FAKE_CODEX_ENV; await h.close('test'); }
});

test('codex: auto 모드 = on-request + workspaceWrite + approvalsReviewer auto_review, 다른 모드로 돌리면 reviewer 는 user (사용자 2026-10-09)', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false });
  const c = await connectSession(h.sock);
  await c.request('session.attach', { id: h.session.id });
  await untilReady(dir, h.session.id, 1);
  const deltas: string[] = [];
  let ended: (() => void) | null = null;
  c.onEvent((m) => { if (m.event !== 'session.event') return; const ev = (m.params as any).ev; if (ev.kind === 'text.delta') deltas.push(ev.text); if (ev.kind === 'approval.requested') void c.request('session.approve', { id: h.session.id, requestId: ev.requestId, decision: 'allow' }); if (ev.kind === 'turn.end') ended?.(); });
  const turn = async (text: string) => { const done = new Promise<void>((r) => (ended = r)); await c.request('session.send', { id: h.session.id, text }); await Promise.race([done, sleep(8000).then(() => { throw new Error('turn timeout'); })]); };
  await c.request('session.setMode', { id: h.session.id, mode: 'auto' });
  await turn('a');
  assert.ok(deltas.includes('policy=on-request reviewer=auto_review sandbox=workspaceWrite'), deltas.join(' | '));
  const rv = (await c.request('session.attach', { id: h.session.id })).history.map((e: any) => e.ev).find((e: any) => e.kind === 'review');
  assert.deepEqual(rv, { kind: 'review', toolUseId: 'exec-1', decision: 'denied', risk: 'high', action: 'touch x', rationale: 'too risky' });
  await c.request('session.setMode', { id: h.session.id, mode: 'default' });
  await turn('b');
  assert.ok(deltas.includes('policy=untrusted reviewer=user sandbox=readOnly'), 'resume·다음 턴에 이전 reviewer 가 남지 않게 늘 명시');
  c.close();
  await h.close('test');
});

test('codex: 승인 거절에 interrupt 면 cancel(거절 + 턴 중단)로 답하고 턴이 interrupted 로 끝난다 (ticket slcode-question-esc-chat)', async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${FAKE}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-codex-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false });
  const c = await connectSession(h.sock);
  await c.request('session.attach', { id: h.session.id });
  await untilReady(dir, h.session.id, 1);
  await c.request('session.setMode', { id: h.session.id, mode: 'default' });
  const deltas: string[] = [], ends: any[] = [];
  c.onEvent((m) => { if (m.event !== 'session.event') return; const ev = (m.params as any).ev; if (ev.kind === 'text.delta') deltas.push(ev.text); if (ev.kind === 'turn.end') ends.push(ev); if (ev.kind === 'approval.requested') void c.request('session.approve', { id: h.session.id, requestId: ev.requestId, decision: 'deny', interrupt: true }); });
  await c.request('session.send', { id: h.session.id, text: 'hi' });
  for (let i = 0; i < 80 && !ends.some((e) => e.interrupted); i++) await sleep(100);
  assert.ok(deltas.includes('decision=cancel'), deltas.join(' | '));
  assert.ok(ends.some((e) => e.interrupted), JSON.stringify(ends));
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
  await untilReady(dir, h.session.id, 1);
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
  assert.equal(h.session.permissionMode, null, '모드를 바꾼 적 없는 옛 세션(null)은 그대로 — auto 는 새 세션만');
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
