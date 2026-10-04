// 우체국: 실제 프로세스(dist/post.js)를 격리 디렉토리에 띄워 등록·목록·우편(보관·시그널·fetch·ack)·GRACE·종료 경쟁을 본다. 세션은 가짜(그냥 등록만).
// 먼저 `pnpm build`. 각 테스트는 자기 SLCODE_DIR 를 쓰고 끝에 우체국을 내린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectPost, type RpcClient } from '../src/client.ts';
import { corePaths } from '../src/paths.ts';
import { pidAlive } from '../src/lock.ts';
import type { PostMethods } from '../src/protocol.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function isolated(grace = '60') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-post-'));
  process.env.SLCODE_GRACE_SECS = grace;
  return dir;
}
async function waitGone(pid: number, ms = 5000) { const t0 = Date.now(); while (pidAlive(pid) && Date.now() - t0 < ms) await sleep(50); return !pidAlive(pid); }
async function stop(client: RpcClient<PostMethods>, pid: number) { try { await client.request('post.shutdown'); } catch {} client.close(); await waitGone(pid); }
const reg = (c: RpcClient<PostMethods>, id: string) => c.request('post.register', { id, cwd: '/tmp', pid: process.pid, sock: `/tmp/${id}.sock`, version: 't', title: null });

test('기동·등록: 첫 클라이언트가 우체국을 띄운다, 등록은 연결이 살아 있는 동안만', async () => {
  const dir = isolated();
  const a = await connectPost({ dir });
  assert.ok(a.spawned);
  const info = await a.client.request('post.info');
  assert.equal(info.pid, a.pid);
  const b = await connectPost({ dir });
  assert.ok(!b.spawned);
  await reg(a.client, 's1'); await reg(b.client, 's2');
  assert.deepEqual((await a.client.request('post.list')).map((e) => e.id), ['s1', 's2']);
  b.client.close(); await sleep(100);
  assert.deepEqual((await a.client.request('post.list')).map((e) => e.id), ['s1'], '끊기면 목록에서 빠진다');
  await stop(a.client, info.pid);
  assert.ok(!fs.existsSync(corePaths(dir).postSock)); assert.ok(!fs.existsSync(corePaths(dir).postLock));
});

test('우편: 살아 있으면 시그널만, 본문은 fetch, ack 하면 지워진다; 꺼진 세션 앞의 우편은 보관되어 등록 때 unread 로 보인다', async () => {
  const dir = isolated();
  const a = await connectPost({ dir });
  const b = await connectPost({ dir });
  await reg(b.client, 'bob');
  const signals: unknown[] = [];
  b.client.onEvent((m) => { if (m.event === 'mail') signals.push(m.params); });
  const sent = await a.client.request('mail.send', { from: 'alice', to: 'bob', body: 'hi' });
  assert.equal(sent.delivered, true);
  await sleep(100);
  assert.deepEqual(signals, [{ to: 'bob' }], '시그널에는 내용이 없다');
  const mails = await b.client.request('mail.fetch', { to: 'bob', schema: 1 });
  assert.deepEqual(mails.map((m) => [m.id, m.from, m.kind, m.body]), [[sent.id, 'alice', 'message', 'hi']]);
  assert.ok(fs.existsSync(path.join(corePaths(dir).mailDir, 'bob', `${sent.id}.json`)), '진실은 디스크');
  await b.client.request('mail.ack', { to: 'bob', ids: [sent.id] });
  assert.deepEqual(await b.client.request('mail.fetch', { to: 'bob' }), []);
  // 꺼진 세션 앞으로
  const off = await a.client.request('mail.send', { from: 'alice', to: 'carol', kind: 'board', body: { x: 1 } });
  assert.equal(off.delivered, false);
  const c = await connectPost({ dir });
  assert.equal((await reg(c.client, 'carol')).unread, 1);
  assert.deepEqual((await c.client.request('mail.fetch', { to: 'carol' })).map((m) => m.body), [{ x: 1 }]);
  c.client.close(); b.client.close();
  await stop(a.client, (await a.client.request('post.info')).pid);
});

test('GRACE: 등록 0·연결 0 이 지속되면 자진 종료하고 파일을 지운다; 우편은 남는다', async () => {
  const dir = isolated('1');
  const a = await connectPost({ dir });
  const pid = a.pid!;
  await a.client.request('mail.send', { from: 'x', to: 'y', body: 'kept' });
  a.client.close();
  assert.ok(await waitGone(pid, 4000), 'grace 1s 뒤 죽어야 한다');
  const p = corePaths(dir);
  assert.ok(!fs.existsSync(p.postSock) && !fs.existsSync(p.postPid) && !fs.existsSync(p.postLock));
  assert.equal(fs.readdirSync(path.join(p.mailDir, 'y')).length, 1);
});

test('종료 경쟁: 종료 직후 틈에 붙는 클라이언트는 새 우체국으로 간다', async () => {
  for (const delay of [0, 10, 25, 60]) {
    const dir = isolated();
    const a = await connectPost({ dir });
    const oldPid = a.pid!;
    await a.client.request('post.shutdown');
    await sleep(delay);
    const b = await connectPost({ dir, timeoutMs: 10000 });
    const info = await b.client.request('post.info');
    assert.notEqual(info.pid, oldPid, `delay ${delay}: 새 우체국이어야 한다`);
    assert.ok(await waitGone(oldPid), `delay ${delay}: 옛 우체국은 죽는다`);
    a.client.close();
    await stop(b.client, info.pid);
  }
});
