// 카드 모드 화면 (ticket slcode-card-svc-token-dead) — superlite 플러그인이 stdio 로 화면 파일(web.files)·로컬 파일(file.get)을 받아 카드에 그린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileGet, fileResolve, loadWeb, webFiles } from '../src/serve.ts';
import { startPageHtml } from '../src/startPage.ts';
import { VERSION } from '../src/client.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('web.files: card.html 에 테마·버전·입구를 넣고, 모듈·css 는 상대 경로 그대로 — 카드 화면이 서로 잇는다', () => {
  const dir = tmp('slcode-card-');
  const w = webFiles(loadWeb(), dir, 'superlite');
  assert.match(w.html, new RegExp(`<html lang="ko" data-theme="system" data-version="${VERSION.replace(/\./g, '\\.')}" data-build="\\d+" data-kind="superlite">`));
  assert.match(w.html, /slcode\.ready/, '준비되면 플러그인에 포트를 청한다');
  for (const f of ['app.js', 'rpc.js', 'markdown.js', 'settings.js', 'inspect.js', 'style.css']) assert.equal(typeof w.files[f], 'string', f);
  assert.equal(w.files['index.html'], undefined, 'html 은 card.html 하나');
  // card.html 이 바꿔 잇는 꼴 — 모든 상대 import 는 from './x.js'
  for (const [name, body] of Object.entries(w.files)) for (const m of body.matchAll(/^import .* from '([^']+)'/gm)) assert.match(m[1], /^\.\/[\w.-]+\.js$/, `${name}: ${m[1]}`);
});

test('web.files: 1단 카드의 입구 card.js 를 주고, 옛 플러그인의 card.html 도 같은 입구를 쓴다 (ticket slcode-card-iframe-flatten)', () => {
  const w = webFiles(loadWeb(), tmp('slcode-card-'), 'superlite');
  assert.match(w.files['card.js'], /export function mountCard/);
  assert.match(w.html, /mod\('card\.js'\)/);
});

test('start-page: 플러그인이 1단으로 그려도 되는지 알아보는 표시(slcodeCardHost)가 html 에 있다 (ticket slcode-card-iframe-flatten)', () => {
  assert.match(startPageHtml(tmp('slcode-card-'), 'superlite', '/w', true), /slcodeCardHost/);
});

test('카드 플러그인 문서는 CSP script-src blob: 를 건다 — 주입 스크립트가 ctx 에 닿지 않게 (사용자 2026-11-06)', () => {
  assert.match(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'views', 'session.js'), 'utf8'), /csp\.content = 'script-src blob:'/);
});

test('file.get: 절대 경로만, 줄 번호 꼬리는 없으면 떼고, 본문은 base64', () => {
  const d = tmp('slcode-card-');
  const p = path.join(d, 'a.png');
  fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  const r = fileGet(p);
  assert.equal(r.mediaType, 'image/png'); assert.equal(r.size, 7); assert.deepEqual([...Buffer.from(r.data, 'base64')], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2]);
  fs.writeFileSync(path.join(d, 'b.ts'), 'const x = 1;\n');
  assert.equal(fileGet(path.join(d, 'b.ts:12')).mediaType, 'text/plain; charset=utf-8', 'Codex 꼴 a.ts:12');
  assert.throws(() => fileGet('rel/a.png'), /absolute path required/);
  assert.throws(() => fileGet(path.join(d, 'none.png')), /not found/);
});

test('file.resolve: 적힌 그대로 먼저, 없으면 # 뒤·끝의 :줄(:열) 을 뗀 것을 긴 것부터, 없으면 null (ticket slcode-link-hash-in-filename)', () => {
  const d = tmp('slcode-card-');
  for (const f of ['Report #7.md', 'Report ', 'a.ts', 'b.md']) fs.writeFileSync(path.join(d, f), 'x');
  const r = (p: string) => fileResolve(path.join(d, p)).path;
  assert.equal(r('Report #7.md'), path.join(d, 'Report #7.md'), '이름에 # 이 든 파일 — 뗀 것(Report )도 있지만 적힌 그대로가 먼저');
  assert.equal(r('Report #7.md#L3'), path.join(d, 'Report #7.md'), '마지막 # 뒤만 뗀 것이 더 길다');
  assert.equal(r('Report #7.md:12'), path.join(d, 'Report #7.md'));
  assert.equal(r('a.ts#L12-L30'), path.join(d, 'a.ts'));
  assert.equal(r('a.ts:12:3'), path.join(d, 'a.ts'));
  assert.equal(r('b.md#install'), path.join(d, 'b.md'), '문서 앵커');
  assert.equal(r('none#x'), null);
  assert.equal(fileResolve(d).path, null, '폴더는 아니다');
  assert.throws(() => fileResolve('rel/a.ts'), /absolute path required/);
});

test('--stdio 카드 서비스: web.files·file.get 을 serve 가 답하고, 창 표가 붙은 문자열 id 를 그대로 돌려준다', async (t) => {
  const dir = tmp('slcode-card-'), work = tmp('slcode-work-');
  fs.writeFileSync(path.join(work, 'x.txt'), 'hello');
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, 'new', work, '--no-web', '--stdio'], { env: { ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION_ID: undefined, SUPERLITE_SOCK: undefined }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGINT'); });
  const lines: string[] = []; let buf = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  const reply = async (id: string) => { const t0 = Date.now(); for (;;) { const l = lines.find((x) => x.startsWith(`{"id":${JSON.stringify(id)}`)); if (l) return JSON.parse(l); if (Date.now() - t0 > 15000) throw new Error(`no reply ${id}`); await sleep(50); } };
  child.stdin.write(JSON.stringify({ id: 'w1.p1.1', method: 'web.files', params: {} }) + '\n');
  const w = await reply('w1.p1.1');
  assert.match(w.result.html, /data-kind="superlite"/, 'stdio 는 superlite 입구'); assert.equal(typeof w.result.files['app.js'], 'string');
  child.stdin.write(JSON.stringify({ id: 'w1.p1.2', method: 'file.get', params: { path: path.join(work, 'x.txt') } }) + '\n');
  assert.equal(Buffer.from((await reply('w1.p1.2')).result.data, 'base64').toString(), 'hello');
  child.stdin.write(JSON.stringify({ id: 'w2.7', method: 'server.info', params: {} }) + '\n');
  assert.equal(typeof (await reply('w2.7')).result.session, 'string', 'core 로 가는 요청도 문자열 id 그대로');
  child.kill('SIGINT');
  await new Promise((r) => child.on('exit', r));
});
