// 화면 설정 (settings.ts · serve 의 settings.get/set/changed, ticket slcode-web-settings) — 입구(web·superlite)마다 파일 하나, 같은 입구의 떠 있는 화면에 바로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, normalizeSettings, readSettings, watchSettings, writeSettings } from '../src/settings.ts';
import http from 'node:http';
import { WebSocket as WS } from 'ws';
import { serveSession } from '../src/serve.ts';
import { BUILD, VERSION } from '../src/client.ts';
// 웹 모듈(JS) — ctxLevel 은 DOM 을 쓰지 않아 node 에서 바로 부른다
import { ctxLevel } from '../web/settings.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-settings-'));

test('설정 파일: 없으면 기본값, 꼴이 틀린 값은 버리고, 겹쳐 쓰기는 context 를 항목별로; 두 경계는 0~100 정수이고 yellow ≤ red; web·superlite 는 따로', () => {
  const dir = tmp();
  assert.deepEqual(readSettings(dir, 'web'), DEFAULT_SETTINGS);
  fs.writeFileSync(path.join(dir, 'settings-web.json'), '{ broken');
  assert.deepEqual(readSettings(dir, 'web'), DEFAULT_SETTINGS, '읽을 수 없으면 기본값');
  assert.deepEqual(normalizeSettings({ theme: 'x'.repeat(65), context: { warn: 'yes', yellow: 120.4, red: -3 } }),
    { ...DEFAULT_SETTINGS, context: { warn: true, yellow: 0, red: 100 } }, '꼴이 틀리면 기본값, 범위 밖은 자르고 순서를 맞춘다');
  const a = writeSettings(dir, 'web', { theme: 'dark', context: { yellow: 20 } });
  assert.deepEqual(a, { ...DEFAULT_SETTINGS, theme: 'dark', context: { warn: true, yellow: 20, red: 50 } });
  const b = writeSettings(dir, 'web', { context: { red: 60.4 } });
  assert.deepEqual(b.context, { warn: true, yellow: 20, red: 60 }, 'context 의 다른 항목은 남는다');
  assert.equal(b.theme, 'dark');
  assert.deepEqual(writeSettings(dir, 'web', { theme: 7 as unknown as string }).theme, 'dark', '꼴이 틀린 patch 는 지금 값을 둔다');
  assert.equal(DEFAULT_SETTINGS.inspect, false, '새 세션 inspect 는 기본 끔 (사용자 2026-10-19)');
  assert.equal(writeSettings(dir, 'web', { inspect: true }).inspect, true);
  assert.equal(writeSettings(dir, 'web', { inspect: 'yes' as unknown as boolean }).inspect, true, '꼴이 틀리면 지금 값');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings-web.json'), 'utf8')), readSettings(dir, 'web'));
  assert.deepEqual(readSettings(dir, 'superlite'), DEFAULT_SETTINGS, 'web 을 바꿔도 superlite 는 그대로');
  assert.equal(writeSettings(dir, 'superlite', { theme: 'nord' }).theme, 'nord');
  assert.equal(readSettings(dir, 'web').theme, 'dark', 'superlite 를 바꿔도 web 은 그대로');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['settings-superlite.json', 'settings-web.json'], '임시 파일이 남지 않는다');
});

/** got 이 n 개가 될 때까지 (최대 3초) */
async function until(got: unknown[], n: number) { const t0 = Date.now(); while (got.length < n && Date.now() - t0 < 3000) await sleep(20); }

test('감시: 다른 프로세스가 쓰거나 손으로 고치면 새 값으로 한 번, 내용이 같으면 부르지 않는다', async () => {
  const dir = tmp();
  const got: string[] = [], other: string[] = [];
  const stop = watchSettings(dir, 'web', (s) => got.push(s.theme), 100);
  const stopOther = watchSettings(dir, 'superlite', (s) => other.push(s.theme), 100);
  await sleep(50);
  writeSettings(dir, 'web', { theme: 'dark' });
  await until(got, 1);
  writeSettings(dir, 'web', { theme: 'dark' }); // 같은 내용
  fs.writeFileSync(path.join(dir, 'other.log'), 'x'); // 다른 파일
  await sleep(300);
  fs.writeFileSync(path.join(dir, 'settings-web.json'), JSON.stringify({ theme: 'light' })); // 손으로
  await until(got, 2);
  stop(); stopOther();
  writeSettings(dir, 'web', { theme: 'x' });
  await sleep(300);
  assert.deepEqual(got, ['dark', 'light']);
  assert.deepEqual(other, [], 'superlite 감시는 web 파일에 반응하지 않는다');
});

test('감시를 못 걸면(폴더가 아직 없다 — ENOENT, inotify 한도가 바닥나면 ENOSPC) 파일 상태를 주기적으로 본다', async () => {
  const dir = path.join(tmp(), 'later');
  const got: string[] = [];
  const stop = watchSettings(dir, 'superlite', (s) => got.push(s.theme), 50);
  await sleep(150); // watchFile 은 기준 상태를 비동기로 잡는다 — 그 전에 쓰면 기준에 섞여 바뀐 것으로 안 보인다
  fs.mkdirSync(dir);
  writeSettings(dir, 'superlite', { theme: 'nord' });
  await until(got, 1);
  stop();
  assert.deepEqual(got, ['nord']);
});

test('ctx 색: 경계 20·50 이면 19% 초록, 20%·49% 노랑, 50% 빨강 — 화면에 보이는 반올림 값으로 잰다; 끄면 색 없음', () => {
  const c = { warn: true, yellow: 20, red: 50 };
  assert.deepEqual([19, 20, 49, 50].map((p) => ctxLevel(p, c)), ['ok', 'warn', 'warn', 'err']);
  assert.equal(ctxLevel(19.6, c), 'warn', '20% 로 보이므로 노랑');
  assert.equal(ctxLevel(49.4, c), 'warn');
  assert.equal(ctxLevel(0, { warn: true, yellow: 0, red: 0 }), 'err', '경계가 0 이면 늘 빨강');
  assert.equal(ctxLevel(100, { warn: true, yellow: 100, red: 100 }), 'err');
  assert.equal(ctxLevel(99, { warn: true, yellow: 100, red: 100 }), 'ok');
  assert.equal(ctxLevel(90, { ...c, warn: false }), '');
});

/** WS 하나를 열고 요청을 보내며 받은 프레임을 모은다. addr 은 http 주소(TCP 웹) 또는 uds 경로(서비스 웹) */
function screen(addr: string) {
  let u: string;
  if (addr.startsWith('/')) u = `ws+unix://${addr}:/ws`;
  else { const x = new URL(addr); x.protocol = 'ws:'; x.pathname = '/ws'; x.search = ''; u = x.toString(); }
  const ws = new WS(u);
  const frames: any[] = [];
  let id = 0;
  const waiters: (() => void)[] = [];
  ws.on('message', (d) => { frames.push(JSON.parse(String(d))); for (const w of waiters.splice(0)) w(); });
  const opened = new Promise<void>((r) => ws.once('open', () => r()));
  const until = async (f: () => any, ms = 3000) => { const t0 = Date.now(); for (;;) { const v = f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 50); }); } };
  const changes = () => frames.filter((m) => m.event === 'settings.changed');
  return {
    frames, opened, changes, close: () => ws.close(),
    send(method: string, params?: unknown) { const i = ++id; ws.send(JSON.stringify({ id: i, method, params })); return i; },
    async call(method: string, params?: unknown) { const i = this.send(method, params); return until(() => frames.find((m) => m.id === i)); },
    changed: (n: number) => until(() => changes().length >= n && changes()),
  };
}
const getUds = (sock: string, p: string) => new Promise<string>((resolve, reject) => {
  http.get({ socketPath: sock, path: p }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b)); }).on('error', reject);
});

test('serve: settings.get·set 은 serve 가 답하고 입구마다 따로 — 브라우저(TCP 웹)와 superlite 탭(서비스 웹)은 서로 안 바뀌고, 같은 입구면 다른 serve(다른 세션)의 화면에도 settings.changed; 루프백 밖 웹은 인증 뒤에만; index.html 에 그 입구의 테마', { timeout: 60000 }, async () => {
  process.env.SLCODE_GRACE_SECS = '1';
  const dir = tmp();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-work-'));
  const svc1 = path.join(dir, 'w1.sock'), svc2 = path.join(dir, 'w2.sock');
  const h1 = await serveSession({ dir, cwd: work, webSock: svc1 });
  const h2 = await serveSession({ dir, cwd: work, host: '0.0.0.0', webSock: svc2 });
  try {
    const a = screen(h1.url!), b = screen(h2.url!.replace('0.0.0.0', '127.0.0.1')), s1 = screen(svc1), s2 = screen(svc2);
    await Promise.all([a.opened, b.opened, s1.opened, s2.opened]);
    assert.equal((await b.call('settings.get')).error.code, 'unauthorized', '인증 전엔 설정도 막는다');
    const token = new URL(h2.url!).searchParams.get('token')!;
    assert.equal((await b.call('core.auth', { token })).result.ok, true);
    assert.deepEqual((await a.call('settings.get')).result, DEFAULT_SETTINGS);
    // 브라우저 쪽
    const r = await a.call('settings.set', { settings: { theme: 'dark', context: { yellow: 20, red: 50 } } });
    assert.deepEqual(r.result, { ...DEFAULT_SETTINGS, theme: 'dark', context: { warn: true, yellow: 20, red: 50 } });
    assert.deepEqual((await b.changed(1))[0].params, r.result, '다른 세션의 브라우저 화면에 바로');
    assert.deepEqual((await a.changed(1))[0].params, r.result, '쓴 화면에도 같은 알림');
    assert.deepEqual((await s1.call('settings.get')).result, DEFAULT_SETTINGS, 'superlite 탭은 그대로');
    // superlite 쪽
    const q = await s1.call('settings.set', { settings: { theme: 'nord' } });
    assert.equal(q.result.theme, 'nord');
    assert.equal((await s2.changed(1))[0].params.theme, 'nord', '다른 세션의 superlite 탭에 바로');
    assert.equal((await b.call('settings.get')).result.theme, 'dark', '브라우저 쪽은 그대로');
    await sleep(1500); // 감시가 폴링으로 돌아도(inotify 한도) 한 번은 돌 시간
    assert.deepEqual([a, b, s1, s2].map((x) => x.changes().length), [1, 1, 1, 1], '알림은 그 입구의 화면에만');
    assert.equal((await b.call('server.info')).result.session, h2.session.id, '다른 요청은 그대로 core 로');
    // 첫 화면부터 그 입구의 테마로 — index.html 의 <html> 에 넣어 보낸다. 화면의 버전·빌드(이 serve 의 것)와 입구도 함께
    assert.ok((await (await fetch(h1.url!)).text()).includes(`<html lang="ko" data-theme="dark" data-version="${VERSION}" data-build="${BUILD}" data-kind="web">`));
    assert.ok((await getUds(svc1, '/')).includes(`<html lang="ko" data-theme="nord" data-version="${VERSION}" data-build="${BUILD}" data-kind="superlite">`));
    for (const x of [a, b, s1, s2]) x.close();
  } finally {
    await Promise.all([h1.close('test'), h2.close('test')]);
  }
});
