// 단위: 잠금·이벤트 로그. 실제 Claude 세션은 쓰지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock, readPid } from '../src/lock.ts';
import { EventLog } from '../src/eventLog.ts';

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

test('permissionOptions: root 는 IS_SANDBOX=1 일 때만 skip 플래그, 아니면 bypass 요청은 사유와 함께 default 로', async () => {
  const { permissionOptions } = await import('../src/session.ts');
  // root·샌드박스 아님 — 플래그가 없어야 CLI 가 뜬다
  assert.deepEqual(permissionOptions(undefined, {}, 0), { options: {}, refused: null });
  assert.deepEqual(permissionOptions('default', {}, 0), { options: { permissionMode: 'default' }, refused: null });
  assert.deepEqual(permissionOptions('acceptEdits', { IS_SANDBOX: 'true' }, 0), { options: { permissionMode: 'acceptEdits' }, refused: null }, "값은 '1' 만");
  const r = permissionOptions('bypassPermissions', {}, 0);
  assert.deepEqual(r.options, { permissionMode: 'default' });
  assert.match(r.refused!, /root 에서는 bypass 모드를 쓸 수 없습니다.*IS_SANDBOX=1/);
  // root + IS_SANDBOX=1, root 아님 — 늘 플래그 (나중에 setMode 로 bypass 전환)
  assert.deepEqual(permissionOptions('bypassPermissions', { IS_SANDBOX: '1' }, 0), { options: { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }, refused: null });
  assert.deepEqual(permissionOptions('default', {}, 1000), { options: { permissionMode: 'default', allowDangerouslySkipPermissions: true }, refused: null });
});

test('eventLog.sockPath: 세션 폴더의 sock, cwd 슬러그가 길어 소켓 경로 상한(100바이트)을 넘으면 <dir>/sock/<id>', () => {
  const dir = tmp();
  const short = new EventLog(dir, { id: 'abcd1234', vendor: 'claude', cwd: '/x', title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false });
  assert.equal(short.sockPath, path.join(short.dir, 'sock'));
  const long = new EventLog(dir, { id: 'abcd1234', vendor: 'claude', cwd: '/' + 'a-very-long-folder-name/'.repeat(5), title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false });
  assert.ok(Buffer.byteLength(path.join(long.dir, 'sock')) > 100);
  assert.equal(long.sockPath, path.join(dir, '..', 'sock', 'abcd1234'));
});
