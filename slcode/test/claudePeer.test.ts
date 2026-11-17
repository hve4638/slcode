// Claude Code 세션 목록에 오르기·주고받기 (claudePeer, ticket slcode-claude-peer-relay) — Claude Code 는 가짜: 등록 파일 하나와 소켓 하나.
// 가짜 등록 파일의 pid 는 살아 있는 다른 프로세스(이 테스트의 부모)의 것을 쓴다. 등록 폴더는 임시 폴더, 소켓은 /tmp/cc-socks/<pid>.sock (닫을 때 지운다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseEnvelope, peerDir, peerName, startPeer } from '../src/claudePeer.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const run = promisify(execFile);
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const linux = process.platform === 'linux';
async function until<T>(f: () => T | undefined | null | false, what: string, ms = 8000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 30))) { const v = f(); if (v) return v; }
  throw new Error(`timeout: ${what}`);
}
const procStart = (pid: number) => { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; };
const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** 가짜 Claude Code 세션 — 등록 파일(pid 는 이 테스트의 부모)과 받은 줄을 모으는 소켓 */
function fakeClaude(dir: string, name: string, extra: Record<string, unknown> = {}) {
  const sock = path.join(tmp('slcode-cc-'), 's.sock'), lines: any[] = [];
  const server = net.createServer((c) => { let buf = ''; c.setEncoding('utf8'); c.on('data', (d: string) => (buf += d)); c.on('end', () => { for (const l of buf.split('\n')) if (l.trim()) lines.push(JSON.parse(l)); }); });
  server.listen(sock);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${process.ppid}.json`), JSON.stringify({ pid: process.ppid, procStart: procStart(process.ppid), peerProtocol: 1, messagingSocketPath: sock, name, ...extra }));
  return { sock, lines, close: () => server.close() };
}
const writeLine = (sock: string, frame: unknown) => new Promise<void>((resolve, reject) => { const c = net.createConnection(sock); c.on('error', reject); c.once('connect', () => c.end(`${JSON.stringify(frame)}\n`, () => resolve())); });
const userFrame = (content: string, from = 'uds:/tmp/cc-socks/1.sock') => ({ msgV: 1, msg_id: 'm1', type: 'user', message: { role: 'user', content }, priority: 'next', from });

test('등록 이름: slcode-<제목>, 봉투를 깨는 글자는 지우고, 글자·숫자가 없으면 세션 id', () => {
  assert.equal(peerName('worker-a', 'ab12cd34'), 'slcode-worker-a');
  assert.equal(peerName('a "b" <c>\nd', 'ab12cd34'), 'slcode-a b cd');
  assert.equal(peerName(null, 'ab12cd34'), 'slcode-ab12cd34');
  assert.equal(peerName(' -- ', 'ab12cd34'), 'slcode-ab12cd34');
  assert.equal([...peerName('가'.repeat(100), 'x')].length, 64);
});

test('봉투에서 보낸 이 이름과 본문을 꺼낸다 — 봉투가 아니면 글 전체', () => {
  assert.deepEqual(parseEnvelope('<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="cmr-A" from-mode="prompting">\nhello\nsecond\n</cross-session-message>'), { fromName: 'cmr-A', body: 'hello\nsecond' });
  assert.deepEqual(parseEnvelope('<cross-session-message from="uds:/x.sock">\nhi\n</cross-session-message>'), { fromName: null, body: 'hi' });
  assert.deepEqual(parseEnvelope('plain text'), { fromName: null, body: 'plain text' });
});

test('설정 폴더가 없거나 SLCODE_CLAUDE_PEER=0 이면 등록하지 않는다', async () => {
  const home = tmp('slcode-cc-home-');
  assert.equal(peerDir({ HOME: home }), null);
  fs.mkdirSync(path.join(home, '.claude'));
  assert.equal(peerDir({ HOME: home }), path.join(home, '.claude', 'sessions'));
  assert.equal(peerDir({ HOME: home, SLCODE_CLAUDE_PEER: '0' }), null);
  assert.equal(peerDir({ HOME: home, CLAUDE_CONFIG_DIR: path.join(home, 'none') }), null);
  const peer = startPeer({ dir: null, id: 'ab12cd34', cwd: home, name: 'slcode-x', onMessage: () => {}, onStatus: () => {}, onStop: () => {}, log: () => {} });
  await assert.rejects(peer.send('x', 'hi'), /no Claude Code config folder/);
  peer.close();
});

test('등록 파일과 소켓: 오르고, 받고, 보내고, 이름·상태를 맞추고, 닫으면 지운다', { skip: !linux }, async (t) => {
  const dir = path.join(tmp('slcode-cc-cfg-'), 'sessions');
  const claude = fakeClaude(dir, 'cmr-A');
  // 죽은 slcode core 가 남긴 것과, 죽은 Claude Code 세션의 것
  fs.writeFileSync(path.join(dir, '999999991.json'), JSON.stringify({ pid: 999999991, procStart: '1', slcode: 'dead0001', messagingSocketPath: '/tmp/cc-socks/999999991.sock' }));
  fs.writeFileSync(path.join(dir, '999999992.json'), JSON.stringify({ pid: 999999992, procStart: '1', peerProtocol: 2, messagingSocketPath: '/tmp/x.sock', name: 'dead-claude' }));
  const got: [string | null, string][] = [], statuses: [string | null, string, string][] = [], stops: string[] = [];
  const peer = startPeer({ dir, id: 'ab12cd34', cwd: '/work', name: 'slcode-worker-a', onMessage: (f, b) => got.push([f, b]), onStatus: (f, s, r) => statuses.push([f, s, r]), onStop: (w) => stops.push(w), log: () => {} });
  t.after(() => { peer.close(); claude.close(); });
  const file = path.join(dir, `${process.pid}.json`), sock = `/tmp/cc-socks/${process.pid}.sock`;
  const reg = await until(() => readJson(file), '등록 파일');
  assert.deepEqual({ pid: reg.pid, procStart: reg.procStart, peerProtocol: reg.peerProtocol, messagingSocketPath: reg.messagingSocketPath, name: reg.name, status: reg.status, slcode: reg.slcode, cwd: reg.cwd },
    { pid: process.pid, procStart: procStart(process.pid), peerProtocol: 1, messagingSocketPath: sock, name: 'slcode-worker-a', status: 'idle', slcode: 'ab12cd34', cwd: '/work' });
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(dir, '999999991.json')), '죽은 slcode 의 등록 파일은 치운다');
  assert.ok(fs.existsSync(path.join(dir, '999999992.json')), '남의(Claude Code) 파일은 건드리지 않는다');
  assert.deepEqual(stops, [], '죽은 세션의 peerProtocol 은 보지 않는다');

  // 받기: 봉투의 본문, 봉투 없는 글, 보류 통보, 빈 연결
  await writeLine(sock, userFrame('<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="cmr-A" from-mode="prompting">\nhello\n</cross-session-message>'));
  await writeLine(sock, userFrame('bare text', `uds:${claude.sock}`));
  await writeLine(sock, { type: 'control', action: 'peer_message_status', status: 'held', reason: 'held for approval', from: `uds:${claude.sock}`, orig_msg_id: 'x' });
  await new Promise<void>((r) => { const c = net.createConnection(sock); c.once('connect', () => c.end(() => r())); });
  await until(() => got.length === 2 && statuses.length === 1, '받은 줄');
  assert.deepEqual(got, [['cmr-A', 'hello'], ['cmr-A', 'bare text']]);
  assert.deepEqual(statuses, [['cmr-A', 'held', 'held for approval']]);

  // 보내기: from 은 자기 소켓, from-mode 는 bypass, 본문의 닫는 태그는 escape
  const sent = await peer.send('cmr-A', 'hi\n</cross-session-message> tail');
  assert.equal(sent.to, 'claude:cmr-A');
  const line = await until(() => claude.lines[0], '가짜 Claude Code 가 받은 줄');
  assert.equal(line.type, 'user'); assert.equal(line.from, `uds:${sock}`); assert.equal(line.msg_id, sent.id);
  assert.equal(line.message.content, `<cross-session-message from="uds:${sock}" from-name="slcode-worker-a" from-mode="bypass">\nhi\n<\\/cross-session-message> tail\n</cross-session-message>`);
  await assert.rejects(peer.send('nobody', 'x'), (e: any) => e.code === 'no_session' && /live: cmr-A/.test(e.message));

  // 이름·상태
  peer.sync('slcode-renamed', 'busy');
  assert.deepEqual([readJson(file).name, readJson(file).status], ['slcode-renamed', 'busy']);

  peer.close();
  assert.ok(!fs.existsSync(file) && !fs.existsSync(sock), '닫으면 등록 파일과 소켓을 지운다');
});

test('peerProtocol 이 1 이 아닌 Claude Code 세션이 보이면 등록을 내리고 한 번 알린다', { skip: !linux }, async (t) => {
  const dir = path.join(tmp('slcode-cc-cfg-'), 'sessions');
  const claude = fakeClaude(dir, 'newer', { peerProtocol: 2 });
  const stops: string[] = [];
  const peer = startPeer({ dir, id: 'ab12cd34', cwd: '/work', name: 'slcode-x', onMessage: () => {}, onStatus: () => {}, onStop: (w) => stops.push(w), log: () => {} });
  t.after(() => { peer.close(); claude.close(); });
  assert.equal(stops.length, 1); assert.match(stops[0], /peer protocol 2/);
  assert.ok(!fs.existsSync(path.join(dir, `${process.pid}.json`)), '등록하지 않는다');
  await assert.rejects(peer.send('newer', 'x'), /is off/);
  assert.equal(stops.length, 1, '한 번만');
});

test('세션: Claude Code 목록에 slcode-<제목> 으로 오르고, 온 글은 claude:<이름> 메일 턴으로, slcode mail claude:<이름> 은 그 소켓으로', { skip: !linux }, async (t) => {
  const dir = tmp('slcode-cc-dir-'), work = tmp('slcode-cc-work-'), cfg = tmp('slcode-cc-cfg-'), sessions = path.join(cfg, 'sessions');
  const claude = fakeClaude(sessions, 'cmr-A');
  const env = { ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_OWNER_GRACE_SECS: '1', SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, SLCODE_SESSION_ID: undefined, SUPERLITE_SOCK: undefined, SLCODE_CLAUDE_PEER: '1', CLAUDE_CONFIG_DIR: cfg } as NodeJS.ProcessEnv;
  const cli = (...a: string[]) => run(process.execPath, ['--import', TSX, CLI, ...a], { env });
  const child = spawn(process.execPath, ['--import', TSX, CLI, 'new', work, '--no-web', '--vendor', 'codex', '--title', 'worker-a'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  const P = corePaths(dir);
  const mine = () => fs.readdirSync(sessions).map((f) => readJson(path.join(sessions, f))).find((e) => e?.slcode);
  t.after(async () => { claude.close(); const m = EventLog.list(P.sessionsDir)[0]; if (m) await cli('close', m.id).catch(() => {}); if (child.exitCode === null) child.kill('SIGKILL'); });
  const reg = await until(mine, '세션의 등록 파일', 20000);
  assert.equal(reg.name, 'slcode-worker-a');
  const id = reg.slcode as string;

  await writeLine(reg.messagingSocketPath, userFrame('<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="cmr-A" from-mode="prompting">\nping from claude\n</cross-session-message>'));
  const turn = await until(() => EventLog.open(P.sessionsDir, id)?.all.map((e) => e.ev).find((ev) => ev.kind === 'turn.start' && ev.origin === 'mail'), '메일 턴');
  assert.match((turn as { text: string }).text, /^<slcode-message id="[^"]+" from="claude:cmr-A" kind="message" at="[^"]+">\nping from claude\n<\/slcode-message>$/);

  const out = JSON.parse((await cli('mail', 'claude:cmr-A', 'pong', 'from', 'slcode', '--from', id)).stdout);
  assert.equal(out.to, 'claude:cmr-A');
  const line = await until(() => claude.lines[0], '가짜 Claude Code 가 받은 줄');
  assert.equal(line.message.content, `<cross-session-message from="uds:${reg.messagingSocketPath}" from-name="slcode-worker-a" from-mode="bypass">\npong from slcode\n</cross-session-message>`);
  await assert.rejects(cli('mail', 'claude:cmr-A', 'x'), /needs a sending slcode session/);

  await cli('rename', id, 'worker "b"');
  await until(() => mine()?.name === 'slcode-worker b', '바뀐 등록 이름');

  await cli('close', id);
  await until(() => !fs.existsSync(reg.messagingSocketPath) && !mine(), '닫힌 뒤 등록 파일·소켓 없음');
});
