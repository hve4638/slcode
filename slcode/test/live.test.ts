// 실제 프롬프트 한 턴 — API 를 부르므로 SLCODE_LIVE=1 일 때만 (수 센트). turn.start→text.delta→turn.end 와 session.status 를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveSession } from '../src/serve.ts';
import { connectSession } from '../src/client.ts';

test('실제 턴: 프롬프트 하나가 text.delta 와 turn.end 로 끝나고 status 가 컨텍스트를 준다', { skip: !process.env.SLCODE_LIVE && 'SLCODE_LIVE=1 일 때만' }, async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-live-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const h = await serveSession({ dir, cwd: work, web: false });
  const c = await connectSession(h.sock);
  await c.request('session.attach', { id: h.session.id });
  const kinds: string[] = []; let text = '';
  const done = new Promise<void>((r) => c.onEvent((m) => { if (m.event !== 'session.event') return; const ev = (m.params as any).ev; kinds.push(ev.kind); if (ev.kind === 'text.delta') text += ev.text; if (ev.kind === 'turn.end') r(); }));
  await c.request('session.send', { id: h.session.id, text: 'Reply with exactly the single word: pong' });
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), 120000))]);
  assert.equal(kinds[0], 'turn.start');
  assert.ok(kinds.includes('session.ready'), 'init 은 첫 프롬프트 뒤에 온다');
  assert.match(text, /pong/i);
  const end = kinds.lastIndexOf('turn.end'); assert.ok(end > 0);
  const st = await c.request('session.status', { id: h.session.id });
  assert.ok(st.context && st.context.max > 0 && st.context.tokens > 0, '컨텍스트 창');
  c.close();
  await h.close('test');
});
