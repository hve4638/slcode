// 우체국 프로세스 — 머신에 하나. 세션을 쥐지 않는다. 하는 일은 셋뿐: 세션 등록(연결 유지 = 살아 있음), 우편 보관, 시그널.
//   $SLCODE_DIR/post.sock   접속 소켓 (JSON 줄, protocol.ts PostMethods)
//   $SLCODE_DIR/post.lock   기동 경합 잠금 (lock.ts)
//   $SLCODE_DIR/post.pid
//   $SLCODE_DIR/mail/<받는 세션 id>/<우편 id>.json   보관 우편 — 진실은 디스크. ack 하면 지운다
// 시그널은 {"event":"mail","params":{"to":id}} 뿐 — 본문은 세션이 mail.fetch 로 가져간다 (사용자 결정 2026-09-27: 폴링 없음, 시그널+요청).
// 시그널 유실은 문제가 아니다: 세션은 등록 직후에도 fetch 하므로 놓친 것은 그때 받는다.
// 수명: 등록 0·연결 0 이 GRACE(기본 10초) 지속되면 자진 종료. SIGHUP 무시. 옛 core 의 종료 경쟁 순서(소켓·pid·lock 먼저 삭제)를 그대로 쓴다.
// 버전 공존: 옛 세션 프로세스가 붙어도 깨지지 않게 이 계약은 늘리기만 한다.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { corePaths, ensureDir } from './paths.js';
import { acquireLock, releaseLock } from './lock.js';
import { CoreError, ERR, PROTOCOL_VERSION, type Mail, type PostBroadcasts, type PostEntry, type PostMethods, type RequestFrame } from './protocol.js';

const P = corePaths();
const GRACE_MS = Number(process.env.SLCODE_GRACE_SECS ?? 10) * 1000;
const startedAt = Date.now();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

type Conn = { send: (obj: unknown) => void; entry: PostEntry | null };
const conns = new Set<Conn>();
/** 세션 id → 등록한 연결 (같은 id 가 다시 등록하면 새 연결이 이긴다 — 옛 프로세스가 죽어 가는 중) */
const live = new Map<string, Conn>();
let shuttingDown = false;
let server: net.Server | null = null;

function signal<K extends keyof PostBroadcasts>(conn: Conn, event: K, params: PostBroadcasts[K]) { conn.send({ event, params }); }

// ---- 우편 파일
const mailDir = (to: string) => path.join(P.mailDir, to);
function readMail(to: string): Mail[] {
  let names: string[] = [];
  try { names = fs.readdirSync(mailDir(to)); } catch { return []; }
  const out: Mail[] = [];
  for (const n of names) { if (!n.endsWith('.json')) continue; try { out.push(JSON.parse(fs.readFileSync(path.join(mailDir(to), n), 'utf8'))); } catch {} }
  return out.sort((a, b) => a.ts - b.ts);
}
function writeMail(m: Mail) {
  fs.mkdirSync(mailDir(m.to), { recursive: true, mode: 0o700 });
  const f = path.join(mailDir(m.to), `${m.id}.json`);
  fs.writeFileSync(f + '.tmp', JSON.stringify(m), { mode: 0o600 });
  fs.renameSync(f + '.tmp', f);
}

type Handler<K extends keyof PostMethods> = (conn: Conn, params: PostMethods[K]['params']) => PostMethods[K]['result'];
const str = (v: unknown, name: string): string => { if (typeof v !== 'string' || !v) throw new CoreError(ERR.badRequest, `${name} required`); return v; };

const handlers: { [K in keyof PostMethods]: Handler<K> } = {
  'post.register': (conn, p) => {
    const id = str(p?.id, 'id');
    const entry: PostEntry = { id, cwd: str(p.cwd, 'cwd'), pid: Number(p.pid) || 0, sock: str(p.sock, 'sock'), version: String(p.version ?? ''), title: p.title ?? null, since: Date.now() };
    if (conn.entry) live.delete(conn.entry.id);
    conn.entry = entry;
    live.set(id, conn);
    disarmGrace();
    return { ok: true, unread: readMail(id).length };
  },
  'post.list': () => [...live.values()].map((c) => c.entry!).sort((a, b) => a.since - b.since),
  'post.info': () => ({ pid: process.pid, startedAt, dir: P.dir, protocol: PROTOCOL_VERSION, sessions: live.size }),
  'post.shutdown': () => { shutdown('post.shutdown'); return { ok: true }; },
  'mail.send': (_c, p) => {
    // 모르는 봉투 필드(re 등 뒤에 늘어난 것)는 그대로 싣는다 — 옛 우체국이 새 세션의 필드를 버리지 않게 (2026-10-02 실측: 옛 우체국이 re 를 떨어뜨렸다)
    const m: Mail = { ...(p as object), id: randomUUID().slice(0, 8), from: str(p?.from, 'from'), to: str(p?.to, 'to'), ts: Date.now(), kind: typeof p.kind === 'string' ? p.kind : 'message', body: p.body ?? '' };
    writeMail(m);
    const target = live.get(m.to);
    if (target) signal(target, 'mail', { to: m.to });
    return { id: m.id, delivered: !!target };
  },
  'mail.fetch': (_c, p) => readMail(str(p?.to, 'to')),
  'mail.ack': (_c, p) => {
    const to = str(p?.to, 'to');
    for (const id of Array.isArray(p.ids) ? p.ids : []) { try { fs.unlinkSync(path.join(mailDir(to), `${id}.json`)); } catch {} }
    return { ok: true };
  },
};

async function onLine(conn: Conn, line: string) {
  let msg: RequestFrame;
  try { msg = JSON.parse(line); } catch { conn.send({ error: { code: ERR.badRequest, message: 'bad json' } }); return; }
  if (msg.id === undefined || typeof msg.method !== 'string') { conn.send({ error: { code: ERR.badRequest, message: 'need id+method' } }); return; }
  try {
    if (shuttingDown) throw new CoreError('shutting_down', 'post office is shutting down — reconnect');
    const h = (handlers as Record<string, Handler<keyof PostMethods>>)[msg.method];
    if (!h) throw new CoreError(ERR.badRequest, `unknown method ${msg.method}`);
    conn.send({ id: msg.id, result: await h(conn, msg.params as never) });
  } catch (e) {
    conn.send({ id: msg.id, error: { code: e instanceof CoreError ? e.code : 'error', message: e instanceof Error ? e.message : String(e) } });
  }
}

function dropConn(conn: Conn) {
  if (conn.entry && live.get(conn.entry.id) === conn) live.delete(conn.entry.id);
  conns.delete(conn);
  armGrace();
}

// ---- 수명
let graceTimer: NodeJS.Timeout | null = null;
const idle = () => live.size === 0 && conns.size === 0;
function armGrace() { if (idle() && !graceTimer) graceTimer = setTimeout(() => { graceTimer = null; if (idle()) shutdown('idle: no sessions, no clients'); }, GRACE_MS); }
function disarmGrace() { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } }

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown: ${reason}`);
  // 동기로 소켓·pid·lock 부터 지운다 — 이 뒤에 붙으려는 쪽은 ENOENT 를 만나 새 우체국을 띄운다
  server?.close();
  for (const f of [P.postSock, P.postPid]) try { fs.unlinkSync(f); } catch {}
  releaseLock(P.postLock);
  for (const c of conns) signal(c, 'post.shutdown', { reason });
  setTimeout(() => process.exit(0), 100);
}

async function main() {
  ensureDir(P.dir);
  const lock = await acquireLock(P.postLock);
  if (!lock.ok) { log(`another post office (pid ${lock.holder}) holds ${P.postLock}; exiting`); process.exit(3); }
  ensureDir(P.mailDir);
  try { fs.unlinkSync(P.postSock); } catch {} // 죽은 우체국의 소켓 — 잠금 소유자만 지운다
  fs.writeFileSync(P.postPid, String(process.pid), { mode: 0o600 });

  server = net.createServer((sock) => {
    const conn: Conn = { send: (o) => { if (!sock.destroyed) sock.write(JSON.stringify(o) + '\n'); }, entry: null };
    conns.add(conn); disarmGrace();
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) void onLine(conn, l); } });
    sock.on('close', () => dropConn(conn));
    sock.on('error', () => {});
  });
  server.listen(P.postSock, () => { fs.chmodSync(P.postSock, 0o600); log(`post office pid ${process.pid} listening ${P.postSock} (grace ${GRACE_MS}ms)`); });
  armGrace();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => { /* 터미널이 닫혀도 산다 */ });
  process.on('uncaughtException', (e) => log('uncaught', e));
  process.on('unhandledRejection', (e) => log('unhandled', e));
}

void main();
