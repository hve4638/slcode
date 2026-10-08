// 세션 프로세스 본체 — `slcode` 명령 하나 = 세션 하나 (사용자 결정 2026-09-27, ticket agent-core-split).
// 이 프로세스가 세션(벤더 SDK)을 직접 쥐고, 같은 메서드(protocol.ts Methods)를 두 통로로 낸다:
//   sessions/<슬러그>/<id>/sock  UDS — CLI·superlite·다른 클라이언트 (소켓 0600 이 곧 인증)
//   http+WebSocket /ws           브라우저 — 정적 프런트(web/) + 프레임 중계. 토큰은 루프백 밖 호스트로 열 때만
// 우체국(post.ts)에는 붙어서 등록하고 연결을 유지한다. 시그널 mail 이 오면 mail.fetch 로 가져와 다음 idle 에 한 턴으로 넣고 ack 한다
// (여러 통이면 한 번에). 우체국이 없으면 띄우고, 끊기면 다시 붙는다 — 세션 동작은 우체국과 무관하다.
// 수명: Ctrl-C·session.close·벤더 종료 → 세션을 닫고 소켓을 지우고 나간다. 로그는 남아 --resume 으로 이어간다.
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClaudeSession } from './session.js';
import { CodexSession } from './codex.js';
import type { AgentSession } from './base.js';
import { EventLog, type SessionMeta } from './eventLog.js';
import { connectPost, VERSION, type RpcClient } from './client.js';
import { corePaths, ensureDir, readOrCreateToken } from './paths.js';
import { formatMail, parseMailHeads } from './mail.js';
import { CoreError, ERR, PROTOCOL_VERSION, type ApprovalRequest, type LoggedEvent, type Mail, type MethodName, type Methods, type PostMethods, type RequestFrame, type SessionInfo } from './protocol.js';

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};
const isLoopback = (host: string) => ['127.0.0.1', 'localhost', '::1'].includes(host);
/** 0.0.0.0 으로 열었으면 접속 가능한 주소로 바꾼다 — 첫 비내부 IPv4, 없으면 localhost. CLI 출력·--stdio hello·server.info 가 같은 값을 낸다 */
export function reachable(url: string): string {
  if (!url.includes('//0.0.0.0:')) return url;
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';
  return url.replace('//0.0.0.0:', `//${ip}:`);
}
// SDK 자식(claude CLI)이 이 프로세스를 띄운 세션의 CLAUDE_* 를 물려받지 않게 — 워커 세션 안에서 띄우면 자식 세션 표식이 딸려 간다
const SDK_ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));

export type ServeOptions = {
  dir?: string;
  cwd: string;
  /** 이어받을 세션 id (저장 세션) */
  resume?: string;
  /** 이 cwd 의 마지막 세션(updatedAt)을 이어받는다 */
  continueLast?: boolean;
  title?: string;
  raw?: boolean;
  permissionMode?: string;
  /** 새 세션의 벤더 — 기본 claude. 이어받는 세션은 meta.vendor 를 따른다 */
  vendor?: 'claude' | 'codex';
  /** 웹 서버 — 기본 켬. false 면 UDS 만 (superlite 가 소켓으로 직접 붙는 경우) */
  web?: boolean;
  host?: string;
  port?: number;
  /** 세 번째 통로 — 이 프로세스의 stdin/stdout 을 UDS 와 같은 프레임 연결 하나로 쓴다 (superlite 백그라운드 서비스의 stdio 통로, ticket agent-plugin-card 2026-10-04).
   *  인증은 UDS 처럼 없다 — 띄운 쪽(데몬)이 곧 신뢰 경계. 로그는 stderr 로만 */
  stdio?: boolean;
  /** superlite 서비스 웹 소켓 (SUPERLITE_SERVICE_WEB, ticket plugin-service-web) — uds 경로(`/` 시작) 또는 host:port. 여기에도 웹을 연다.
   *  superlite relay /svc 입구가 데몬을 거쳐 붙으므로 인증은 UDS 처럼 없다 (데몬·superlite 인증이 신뢰 경계) */
  webSock?: string;
  log?: (msg: string) => void;
};

export type ServeHandle = { url: string | null; sock: string; session: SessionInfo; close: (reason?: string) => Promise<void>; done: Promise<void> };

/** 소켓 파일이 살아 있는 프로세스 것인지 — 붙어 보면 안다 */
function sockAlive(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(p)) return resolve(false);
    const s = net.createConnection(p);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/** 웹 정적 파일 (web/) — 세션 웹과 resume --stdio 프록시의 서비스 웹이 같이 쓴다. 경로는 상대(경로 접두사 아래에서도 — relay /svc) */
export function staticHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  const file = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const fp = path.join(WEB_DIR, path.normalize(file));
  if (!fp.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return; }
  let st: fs.Stats;
  try { st = fs.statSync(fp); } catch { res.writeHead(404); res.end('not found'); return; }
  const target = st.isDirectory() ? path.join(fp, 'index.html') : fp;
  if (!fs.existsSync(target)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(target).on('error', () => res.end()).pipe(res);
}

/** 서비스 웹 소켓 주소에 listen — `/` 로 시작하면 uds(0600), 아니면 host:port */
export function listenAddr(s: http.Server, addr: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    if (addr.startsWith('/')) { try { fs.unlinkSync(addr); } catch {} s.listen(addr, () => { fs.chmodSync(addr, 0o600); resolve(); }); return; }
    const i = addr.lastIndexOf(':');
    s.listen(Number(addr.slice(i + 1)), addr.slice(0, i), () => resolve());
  });
}

export async function serveSession(opts: ServeOptions): Promise<ServeHandle> {
  const log = opts.log ?? (() => {});
  const P = corePaths(opts.dir);
  ensureDir(P.sessionsDir);
  const migrated = EventLog.migrate(P.sessionsDir);
  if (migrated) log(`moved ${migrated} session(s) under cwd folders`);

  // ---- 세션 로그: 새로 / --resume / --continue
  let logFile: EventLog | null = null;
  let resumeId = opts.resume;
  if (!resumeId && opts.continueLast) {
    const mine = EventLog.list(P.sessionsDir, opts.cwd).sort((a, b) => (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt));
    resumeId = mine.at(-1)?.id;
    if (!resumeId) log(`no previous session in ${opts.cwd} — starting a new one`);
  }
  if (resumeId) {
    logFile = EventLog.open(P.sessionsDir, resumeId);
    if (!logFile) throw new CoreError(ERR.noSession, `no session ${resumeId}`);
    if (await sockAlive(logFile.sockPath)) throw new CoreError(ERR.badRequest, `session ${resumeId} is live — another slcode is serving it`);
    if (opts.title !== undefined) logFile.updateMeta({ title: opts.title });
  } else {
    const meta: SessionMeta = {
      id: randomUUID().slice(0, 8), vendor: opts.vendor ?? 'claude', cwd: opts.cwd, title: opts.title ?? null,
      vendorSessionId: null, createdAt: Date.now(), permissionMode: opts.permissionMode ?? null, raw: opts.raw ?? false,
    };
    logFile = EventLog.create(P.sessionsDir, meta);
  }
  // 벤더 자식(과 그 Bash 도구가 띄우는 명령)이 자기 세션을 알게 — 세션 안의 `slcode mail/check/ask/reply` 가 이걸 읽는다 (사용자 확정 2026-10-02)
  const env: NodeJS.ProcessEnv = { ...SDK_ENV, SLCODE_SESSION: logFile.meta.id };
  const session: AgentSession = logFile.meta.vendor === 'codex'
    ? new CodexSession({ log: logFile, env, permissionMode: opts.permissionMode ?? logFile.meta.permissionMode, raw: opts.raw })
    : new ClaudeSession({ log: logFile, env, resume: logFile.meta.vendorSessionId, permissionMode: opts.permissionMode ?? logFile.meta.permissionMode, raw: opts.raw });
  const sid = session.id;

  // ---- 디스패치 (UDS·WS 공용)
  type Conn = { authed: boolean; detach: (() => void) | null; send: (o: unknown) => void };
  const conns = new Set<Conn>();
  const host = opts.host ?? '127.0.0.1';
  const web = opts.web !== false;
  const token = web && !isLoopback(host) ? readOrCreateToken(P) : null;
  let port: number | null = null;
  let url: string | null = null;
  const mine = (id: unknown) => { if (id !== sid) throw new CoreError(ERR.badRequest, `this process serves session ${sid} only`); return session; };
  type Handler<K extends MethodName> = (conn: Conn, params: Methods[K]['params']) => Promise<Methods[K]['result']> | Methods[K]['result'];
  const handlers: { [K in MethodName]: Handler<K> } = {
    'core.auth': (conn, p) => {
      if (!conn.authed) { if (token !== null && p?.token !== token) throw new CoreError(ERR.unauthorized, 'bad token'); conn.authed = true; }
      return { ok: true, pid: process.pid, protocol: PROTOCOL_VERSION, session: sid };
    },
    'server.info': () => ({ session: sid, cwd: opts.cwd, host: web ? host : null, port, url: url ? reachable(url) : null, version: VERSION }),
    'session.attach': (conn, p) => {
      const s = mine(p?.id);
      conn.detach?.();
      const history = s.since(Number(p.since ?? 0));
      conn.detach = s.onEvent((e: LoggedEvent) => conn.send({ event: 'session.event', params: { id: sid, ...e } }));
      return { info: s.info(), history, pending: s.pendingApprovals() as ApprovalRequest[] };
    },
    'session.detach': (conn, p) => { mine(p?.id); conn.detach?.(); conn.detach = null; return { ok: true }; },
    'session.send': (_c, p) => {
      const s = mine(p?.id);
      const att = Array.isArray(p.attachments) ? p.attachments : [];
      if (typeof p.text !== 'string' || (!p.text.trim() && !att.length)) throw new CoreError(ERR.badRequest, 'text or attachments required');
      for (const a of att) if (typeof a?.name !== 'string' || typeof a.mediaType !== 'string' || typeof a.data !== 'string') throw new CoreError(ERR.badRequest, 'attachment {name, mediaType, data}');
      s.send(p.text, p.origin ?? null, att);
      return { ok: true, state: s.state };
    },
    'session.models': (_c, p) => mine(p?.id).models(),
    'session.setModel': async (_c, p) => { if (typeof p?.model !== 'string' || !p.model) throw new CoreError(ERR.badRequest, 'model required'); await mine(p.id).setModel(p.model); return { ok: true }; },
    'session.setEffort': async (_c, p) => { if (typeof p?.effort !== 'string' || !p.effort) throw new CoreError(ERR.badRequest, 'effort required'); await mine(p.id).setEffort(p.effort); return { ok: true }; },
    'session.interrupt': async (_c, p) => { await mine(p?.id).interrupt(); return { ok: true }; },
    'session.setMode': async (_c, p) => { const s = mine(p?.id); if (!['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'].includes(p.mode)) throw new CoreError(ERR.badRequest, 'mode default|acceptEdits|plan|bypassPermissions|auto'); await s.setMode(p.mode); broadcast('session.changed', s.info()); return { ok: true }; },
    'session.commands': (_c, p) => mine(p?.id).commands(),
    'session.status': async (_c, p) => {
      const s = mine(p?.id);
      // repo·브랜치는 부를 때마다 git 에 묻는다 — 세션 중에 바뀔 수 있다. git 이 없거나 repo 가 아니면 null, detached 면 브랜치만 null (첫 커밋 전 브랜치도 보인다)
      const git = (args: string[]) => new Promise<string | null>((r) => execFile('git', ['-C', opts.cwd, ...args], { timeout: 2000 }, (e, out) => r(e ? null : out.trim() || null)));
      const [top, branch, limits, context] = await Promise.all([git(['rev-parse', '--show-toplevel']), git(['branch', '--show-current']), s.limits(), s.context()]);
      return { repo: top ? path.basename(top) : null, branch, limits, context };
    },
    'session.rewind': async (_c, p) => {
      if (typeof p?.seq !== 'number') throw new CoreError(ERR.badRequest, 'seq required');
      try { return { ok: true, filesChanged: await mine(p.id).rewind(p.seq, !!p.conversation, !!p.files) }; }
      catch (e) { if (e instanceof CoreError) throw e; throw new CoreError(ERR.badRequest, (e as Error).message); }
    },
    'session.approve': (_c, p) => {
      const s = mine(p?.id);
      if (p.decision !== 'allow' && p.decision !== 'deny') throw new CoreError(ERR.badRequest, 'decision allow|deny');
      return { ok: s.approve(p.requestId, p.decision, { remember: p.remember, updatedInput: p.updatedInput, message: p.message }) };
    },
    'session.close': (_c, p) => { mine(p?.id); setImmediate(() => void close('closed by client')); return { ok: true }; },
    'session.rename': (_c, p) => { const s = mine(p?.id); s.log.updateMeta({ title: p.title ?? null }); broadcast('session.changed', s.info()); return { ok: true }; },
    // ---- 메시징 (스탠드얼론, 2026-10-02)
    'session.check': async (_c, p) => {
      mine(p?.id);
      await fetchMail(false);
      const batch = inbox.splice(0);
      for (const m of batch) received.set(m.id, m.from);
      if (batch.length) void post?.request('mail.ack', { to: sid, ids: batch.map((m) => m.id) }).catch(() => {});
      return { count: batch.length, text: batch.map(renderMail).join('\n\n') };
    },
    'session.ask': async (_c, p) => {
      mine(p?.id);
      if (!post) throw new CoreError('no_post', 'post office is not connected');
      if (typeof p.to !== 'string' || !p.to) throw new CoreError(ERR.badRequest, 'to required');
      // 꺼진 세션에 묻고 무기한 기다리는 사고를 막는다 — ask 는 live 에게만. 보관만 되는 우편은 mail 로 (사용자 2026-10-02)
      if (!(await post.request('post.list', {})).some((e) => e.id === p.to)) throw new CoreError(ERR.notLive, `${p.to} is not live — use: slcode mail ${p.to} <text>`);
      const { id: mailId } = await post.request('mail.send', { from: sid, to: p.to, kind: 'ask', body: String(p.text ?? '') });
      const reply = await new Promise<Mail>((resolve, reject) => {
        const timer = p.timeoutMs ? setTimeout(() => { asks.delete(mailId); reject(new CoreError('timeout', `no reply to ${mailId} in ${p.timeoutMs}ms`)); }, p.timeoutMs) : null;
        asks.set(mailId, { resolve: (m) => { if (timer) clearTimeout(timer); resolve(m); }, reject: (e) => { if (timer) clearTimeout(timer); reject(e); } });
      });
      return { mailId, reply, text: renderMail(reply) };
    },
    'session.reply': async (_c, p) => {
      mine(p?.id);
      if (!post) throw new CoreError('no_post', 'post office is not connected');
      const to = received.get(String(p.re));
      if (!to) throw new CoreError(ERR.badRequest, `unknown mail ${p.re} — this session did not receive it (use: slcode mail <to> <text>)`);
      const r = await post.request('mail.send', { from: sid, to, kind: 'reply', body: String(p.text ?? ''), re: String(p.re) });
      return { id: r.id, to, delivered: r.delivered };
    },
  };
  function broadcast(event: string, params: unknown) { for (const c of conns) if (c.authed) c.send({ event, params }); }
  async function onLine(conn: Conn, line: string) {
    let msg: RequestFrame;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || typeof msg.method !== 'string') return;
    try {
      if (!conn.authed && msg.method !== 'core.auth') throw new CoreError(ERR.unauthorized, 'core.auth first');
      const h = (handlers as Record<string, Handler<MethodName>>)[msg.method];
      if (!h) throw new CoreError(ERR.badRequest, `unknown method ${msg.method}`);
      conn.send({ id: msg.id, result: await h(conn, msg.params as never) });
    } catch (e) {
      conn.send({ id: msg.id, error: { code: e instanceof CoreError ? e.code : 'error', message: e instanceof Error ? e.message : String(e) } });
    }
  }
  function newConn(send: (o: unknown) => void, authed: boolean): Conn { const c: Conn = { authed, detach: null, send }; conns.add(c); return c; }
  function dropConn(c: Conn) { c.detach?.(); conns.delete(c); }
  // 벤더가 기동 중(아래 listen 들을 기다리는 사이)에 죽으면 close 가 아직 없다 — 사유를 들고 있다가 끝에서 던진다 (2026-10-04 실측: TDZ 'close' 로 진짜 사유가 묻혔다)
  let closeFn: ((reason?: string) => Promise<void>) | null = null;
  let earlyExit: string | null = null;
  session.onEvent((e) => {
    if (e.ev.kind === 'session.state') broadcast('session.changed', session.info());
    if (e.ev.kind === 'session.state' && (e.ev.state === 'idle' || e.ev.state === 'starting')) flushMail();
    if (e.ev.kind === 'session.exit') { broadcast('session.closed', { id: sid, reason: e.ev.reason }); const r = `session exited: ${e.ev.reason}`; if (closeFn) void closeFn(r); else earlyExit = r; }
  });

  // ---- UDS
  const sockPath = logFile.sockPath;
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 }); // 긴 경로 폴백(<dir>/sock/<id>)의 폴더
  try { fs.unlinkSync(sockPath); } catch {} // 죽은 프로세스의 소켓 (위에서 살아 있지 않음을 확인했다)
  const uds = net.createServer((sock) => {
    const conn = newConn((o) => { if (!sock.destroyed) sock.write(JSON.stringify(o) + '\n'); }, true);
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) void onLine(conn, l); } });
    sock.on('close', () => dropConn(conn));
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => { uds.once('error', reject); uds.listen(sockPath, () => { fs.chmodSync(sockPath, 0o600); resolve(); }); })
    .catch(async (e) => { await session.close('listen failed'); throw e; });

  // ---- http + ws
  let srv: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  const wsOn = (server: http.Server, authed: boolean) => {
    const w = new WebSocketServer({ server, path: '/ws' });
    w.on('error', () => {});
    w.on('connection', (ws: WebSocket) => {
      const conn = newConn((o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); }, authed);
      ws.on('message', (d) => void onLine(conn, d.toString()));
      ws.on('close', () => dropConn(conn));
      ws.on('error', () => {});
    });
    return w;
  };
  // superlite 서비스 웹 (ticket plugin-service-web) — TCP 웹과 별개, 인증 없음 (UDS 와 같은 신뢰 경계)
  let svcSrv: http.Server | null = null;
  let svcWss: WebSocketServer | null = null;
  if (opts.webSock) {
    svcSrv = http.createServer(staticHandler);
    svcWss = wsOn(svcSrv, true);
    try { await listenAddr(svcSrv, opts.webSock); } catch (e) { await session.close('listen failed'); uds.close(); try { fs.unlinkSync(sockPath); } catch {} throw e; }
  }
  if (web) {
    srv = http.createServer(staticHandler);
    wss = wsOn(srv, token === null);
    const s = srv;
    try {
      url = await new Promise<string>((resolve, reject) => { s.once('error', reject); s.listen(opts.port ?? 0, host, () => { port = (s.address() as { port: number }).port; resolve(`http://${host}:${port}/${token ? `?token=${token}` : ''}`); }); });
    } catch (e) { await session.close('listen failed'); uds.close(); try { fs.unlinkSync(sockPath); } catch {} throw e; }
  }

  // ---- stdio (옵션) — 한 연결. stdin 의 JSON 줄 = 요청, 응답·이벤트는 stdout 에 JSON 줄. 비JSON 입력은 onLine 이 버린다
  if (opts.stdio) {
    const conn = newConn((o) => process.stdout.write(JSON.stringify(o) + '\n'), true);
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) void onLine(conn, l); } });
    process.stdin.on('end', () => dropConn(conn)); // 띄운 쪽이 떠났다 — 세션은 그대로 (UDS 클라이언트가 끊긴 것과 같다)
    process.stdin.on('error', () => {});
  }

  // ---- 우체국: 등록 + 우편 → 다음 idle 에 한 턴
  let post: RpcClient<PostMethods> | null = null;
  const inbox: Mail[] = [];
  const seen = new Set<string>();
  /** 받은 우편 id → 보낸 이 (session.reply 의 대상). 재기동 뒤에는 로그의 mail 턴 머리말에서 복원 */
  const received = new Map<string, string>();
  for (const e of logFile.all) if (e.ev.kind === 'turn.start' && e.ev.origin === 'mail') for (const h of parseMailHeads(e.ev.text)) received.set(h.id, h.from);
  /** session.ask 대기 — 우편 id → 답장이 오면 푼다 */
  const asks = new Map<string, { resolve: (m: Mail) => void; reject: (e: Error) => void }>();
  /** 보낸 이 제목은 같은 디렉토리의 그 세션 meta 에서 (없으면 null) */
  const renderMail = (m: Mail) => formatMail(m, EventLog.open(P.sessionsDir, m.from)?.meta.title ?? null);
  let closed = false;
  async function joinPost() {
    if (closed) return;
    try {
      const { client } = await connectPost({ dir: opts.dir });
      if (closed) { client.close(); return; } // 붙는 동안 닫혔다 — 연결을 남기면 우체국이 idle 이 못 되고 이 프로세스도 안 끝난다 (codex 테스트 실측 2026-09-30)
      post = client;
      client.onEvent((m) => {
        if (m.event === 'mail') void fetchMail();
        else if (m.event === 'disconnected' || m.event === 'post.shutdown') { if (post === client) post = null; if (!closed) setTimeout(joinPost, 1000); }
      });
      await client.request('post.register', { id: sid, cwd: opts.cwd, pid: process.pid, sock: sockPath, version: VERSION, title: logFile!.meta.title });
      await fetchMail();
    } catch (e) { log(`post office: ${(e as Error).message}`); if (!closed) setTimeout(joinPost, 3000); }
  }
  async function fetchMail(flush = true) {
    if (!post) return;
    let mails: Mail[] = [];
    try { mails = await post.request('mail.fetch', { to: sid, schema: 1 }); } catch { return; }
    for (const m of mails) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      // 대기 중인 ask 의 답장은 턴이 아니라 그 요청의 응답으로
      const waiter = m.kind === 'reply' && m.re ? asks.get(m.re) : undefined;
      if (waiter) { asks.delete(m.re!); waiter.resolve(m); void post.request('mail.ack', { to: sid, ids: [m.id] }).catch(() => {}); continue; }
      inbox.push(m);
    }
    if (flush) flushMail();
  }
  // claude 의 메시지처럼: idle(첫 프롬프트 전 starting 포함)이면 즉시, 아니면 다음 idle 에. 여러 통은 한 턴으로 (사용자 결정 2026-09-27)
  function flushMail() {
    if (closed || !inbox.length || (session.state !== 'idle' && session.state !== 'starting')) return;
    const batch = inbox.splice(0);
    for (const m of batch) received.set(m.id, m.from);
    session.send(batch.map(renderMail).join('\n\n'), 'mail');
    void post?.request('mail.ack', { to: sid, ids: batch.map((m) => m.id) }).catch(() => {});
  }
  void joinPost();

  // ---- 수명
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const close = async (reason = 'closed') => {
    if (closed) return; closed = true;
    log(`closing: ${reason}`);
    for (const [id, w] of asks) { asks.delete(id); w.reject(new CoreError('closed', `session closed: ${reason}`)); }
    await session.close(reason);
    for (const c of [...(wss?.clients ?? []), ...(svcWss?.clients ?? [])]) c.close();
    wss?.close(); srv?.close(); svcWss?.close(); svcSrv?.close(); uds.close();
    try { fs.unlinkSync(sockPath); } catch {}
    post?.close();
    resolveDone();
  };
  closeFn = close;
  if (earlyExit) { await close(earlyExit); throw new CoreError('vendor_exit', earlyExit); }
  return { url, sock: sockPath, session: session.info(), close, done };
}
