// 단위: 잠금·이벤트 로그. 실제 Claude 세션은 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock, readPid } from '../src/lock.ts';
import { EventLog } from '../src/eventLog.ts';
import type { LoggedEvent } from '../src/protocol.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-'));

test('lock: 빈 자리·스테일·소유자만 해제', async () => {
  const dir = tmp(); const lock = path.join(dir, 'startup.lock');
  assert.deepEqual(await acquireLock(lock, 1234, 200), { ok: true });
  assert.equal(readPid(lock), 1234);
  // 1234 는 죽은 pid → 스테일로 보고 새 소유자가 가져간다
  assert.deepEqual(await acquireLock(lock, 5678, 200), { ok: true });
  assert.equal(readPid(lock), 5678);
  releaseLock(lock, 1234); assert.ok(fs.existsSync(lock), '남의 잠금은 지우지 않는다');
  releaseLock(lock, 5678); assert.ok(!fs.existsSync(lock));
});

test('lock: 살아 있는 소유자는 기다리다 포기한다 (종료 중 틈)', async () => {
  const dir = tmp(); const lock = path.join(dir, 'startup.lock');
  fs.writeFileSync(lock, String(process.pid)); // 이 프로세스가 소유자 = 살아 있다
  const t0 = Date.now();
  const r = await acquireLock(lock, 99999, 400);
  assert.deepEqual(r, { ok: false, holder: process.pid });
  assert.ok(Date.now() - t0 >= 350, '대기했어야 한다');
  // 기다리는 동안 소유자가 풀면 가져간다
  setTimeout(() => fs.unlinkSync(lock), 150);
  assert.deepEqual(await acquireLock(lock, 99999, 2000), { ok: true });
});

test('eventLog: 생성·append·since·재열기·깨진 줄 무시·복원 정보', () => {
  const dir = tmp();
  const meta = { id: 'abc', vendor: 'claude' as const, cwd: '/x', title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false };
  const log = EventLog.create(dir, meta);
  for (let i = 1; i <= 5; i++) log.append({ seq: i, at: i, ev: { kind: 'text.delta', text: String(i) } });
  assert.equal(log.lastSeq, 5);
  assert.deepEqual(log.since(3).map((e) => e.seq), [4, 5]);
  assert.deepEqual(log.since(0).length, 5);
  log.updateMeta({ vendorSessionId: 'v-1' });
  log.close();
  fs.appendFileSync(EventLog.eventsPath(log.dir), '{"seq":6,"at":6,"ev":{"kind":"text.d'); // 죽을 때 반쯤 쓴 줄
  const re = EventLog.open(dir, 'abc')!;
  assert.equal(re.lastSeq, 5);
  assert.equal(re.meta.vendorSessionId, 'v-1');
  assert.deepEqual(re.storedInfo(), { ...meta, vendorSessionId: 'v-1', state: 'exited', live: false, seq: 5 });
  assert.deepEqual(EventLog.list(dir).map((m) => m.id), ['abc']);
  assert.equal(EventLog.open(dir, 'nope'), null);
  EventLog.remove(dir, 'abc');
  assert.deepEqual(EventLog.list(dir), []);
});

test('buildContent: 이미지·PDF 는 블록, 텍스트류는 본문 인라인, 첨부 없으면 문자열', async () => {
  const { buildContent } = await import('../src/session.ts');
  assert.equal(buildContent('hi'), 'hi');
  const b = buildContent('hi', [
    { name: 'a.png', mediaType: 'image/png', data: 'AAAA' },
    { name: 'b.pdf', mediaType: 'application/pdf', data: 'BBBB' },
    { name: 'c.txt', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64') },
  ]) as any[];
  assert.deepEqual(b.map((x) => x.type), ['image', 'document', 'text']);
  assert.equal(b[0].source.media_type, 'image/png');
  assert.equal(b[2].text, '<file name="c.txt">\nhello\n</file>\n\nhi');
});

test('eventLog.sockPath: 세션 폴더의 sock, cwd 슬러그가 길어 소켓 경로 상한(100바이트)을 넘으면 <dir>/sock/<id>', () => {
  const dir = tmp();
  const short = new EventLog(dir, { id: 'abcd1234', vendor: 'claude', cwd: '/x', title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false });
  assert.equal(short.sockPath, path.join(short.dir, 'sock'));
  const long = new EventLog(dir, { id: 'abcd1234', vendor: 'claude', cwd: '/' + 'a-very-long-folder-name/'.repeat(5), title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false });
  assert.ok(Buffer.byteLength(path.join(long.dir, 'sock')) > 100);
  assert.equal(long.sockPath, path.join(dir, '..', 'sock', 'abcd1234'));
});

test('stripEnv: 부모 Claude 세션의 표식은 빼고 사용자 설정은 남긴다, 규칙은 마지막으로 맞은 줄이 정한다', async () => {
  const { stripEnv } = await import('../src/core.ts');
  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_EFFORT: 'high', CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', CLAUDEX: 'x' };
  assert.deepEqual(stripEnv(env), { CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', CLAUDEX: 'x' });
  assert.deepEqual(stripEnv(env, ['CLAUDE_*', '!CLAUDE_C*', 'CLAUDE_CODE_*']), { CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/c', PATH: '/bin', CLAUDEX: 'x' });
});

test('historyPage·summarize: 되돌린 턴을 빼고 화면 항목(delta 묶음) 기준으로 열린 도구가 없는 turn.start 에서 자른다, 합계는 기록 전체 (ticket slcode-history-paging)', async () => {
  const { historyPage, summarize, visible } = await import('../src/eventLog.ts');
  const evs: LoggedEvent[] = [];
  const add = (ev: any) => evs.push({ seq: evs.length + 1, at: 0, ev });
  const turn = (text: string, deltas: number, cost: number) => {
    add({ kind: 'turn.start', text, origin: null });
    for (let i = 0; i < deltas; i++) add({ kind: 'text.delta', text: 'x' }); // 화면 항목 하나
    add({ kind: 'hook', event: 'Stop', phase: 'response', ok: true });
    add({ kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: cost, durationMs: 1, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  };
  add({ kind: 'session.ready', model: 'm1', tools: [] });
  turn('a', 50, 0.1); turn('b', 50, 0.3);
  // c 턴에서 시작한 도구가 d 턴(작업 중 보낸 메시지) 뒤에 끝난다 — d 의 turn.start 는 자름 지점이 아니다
  add({ kind: 'turn.start', text: 'c', origin: null }); const cSeq = evs.length;
  add({ kind: 'tool.start', toolUseId: 't1', name: 'Bash', input: {} });
  add({ kind: 'turn.start', text: 'd', origin: null }); const dSeq = evs.length;
  add({ kind: 'tool.end', toolUseId: 't1', ok: true, summary: '' });
  add({ kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: 0.05, durationMs: 1, usage: null }); // 벤더 재기동 — 누계가 줄었다
  // e 턴은 되돌렸다
  add({ kind: 'turn.start', text: 'e', origin: null }); const eSeq = evs.length;
  add({ kind: 'text.delta', text: 'gone' });
  add({ kind: 'session.ready', model: 'm2', tools: [] });
  add({ kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: 0.07, durationMs: 1, usage: null });
  add({ kind: 'turn.rewound', seq: eSeq, conversation: true, files: false, filesChanged: null });
  turn('f', 3, 0.08);

  assert.ok(!visible(evs).some((e) => e.seq >= eSeq && e.seq < eSeq + 4), '되돌린 턴은 빠진다');
  const all = historyPage(evs, Infinity, 1e9);
  assert.equal(all.more, false); assert.equal(all.history[0].seq, 1);
  // 끝에서 5개 안에 자름 지점(f)이 있다 → f 부터
  const p1 = historyPage(evs, Infinity, 5);
  assert.equal((p1.history[0].ev as any).text, 'f'); assert.equal(p1.more, true);
  // 그 앞 — d 는 열린 도구 때문에 자름 지점이 아니라 c 에서 자른다
  const p2 = historyPage(evs, p1.history[0].seq, 5);
  assert.equal(p2.history[0].seq, cSeq); assert.ok(p2.history.some((e) => e.seq === dSeq)); assert.equal(p2.history.at(-1)!.seq < p1.history[0].seq, true);
  assert.ok(p2.history.some((e) => e.ev.kind === 'turn.rewound'), '되돌림 표지는 남는다 (파일 되돌림 안내)');
  // delta 50개는 한 항목 — 턴 하나가 4항목(시작·글·훅·끝). limit 3 이면 b 안에 자름 지점이 없어 그 너머 첫 지점 b, limit 5 도 b
  assert.equal((historyPage(evs, cSeq, 3).history[0].ev as any).text, 'b');
  const p3 = historyPage(evs, cSeq, 5);
  assert.equal((p3.history[0].ev as any).text, 'b'); assert.equal(p3.more, true);
  // 처음까지(9항목) limit 안이면 전부 — 첫 턴 앞의 session.ready 만 남은 페이지를 따로 받지 않는다
  const p4 = historyPage(evs, cSeq, 10);
  assert.equal(p4.history[0].seq, 1); assert.equal(p4.more, false);

  const s = summarize(evs);
  assert.equal(s.turns, 5, '되돌린 턴도 센다');
  assert.deepEqual(s.usage, { input: 3, output: 6, cacheRead: 9, cacheWrite: 12 });
  assert.ok(Math.abs(s.costUsd! - (0.3 + 0.08)) < 1e-9, `0.3 다음에 줄었으니 기준선 0.3 + 재기동 뒤 누계 0.08 (${s.costUsd})`);
  assert.equal(s.lastCostUsd, 0.08);
  assert.equal(s.hooks, 3); assert.equal(s.lastHook, 'Stop response');
  assert.equal((s.ready as any).model, 'm2', '마지막 session.ready — 되돌린 턴 안의 것이라도');
});

test('historyPage: 끝 이벤트 없이 세션이 끝난 도구는 session.exit 뒤의 자름 지점을 막지 않는다', async () => {
  const { historyPage } = await import('../src/eventLog.ts');
  const evs: LoggedEvent[] = [];
  const add = (ev: any) => evs.push({ seq: evs.length + 1, at: 0, ev });
  add({ kind: 'turn.start', text: 'a', origin: null }); add({ kind: 'tool.start', toolUseId: 'lost', name: 'Bash', input: {} });
  add({ kind: 'session.exit', reason: 'crash' });
  for (const t of ['b', 'c']) { add({ kind: 'turn.start', text: t, origin: null }); add({ kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: null, durationMs: 1, usage: null }); }
  const p = historyPage(evs, Infinity, 1);
  assert.equal((p.history[0].ev as any).text, 'c'); assert.equal(p.more, true);
});
