// core — 세션 하나를 쥔 프로세스 (ticket slcode-core-serve-split, 설계 ws docs/report/slcode-core-serve-split.md, 사용자 확정 2026-10-15).
// serve 가 detached 로 띄운다 (coreMain.ts). 세션(벤더 SDK)·이벤트 로그·세션 소켓·우체국·입력 초안·웹 토큰 검사를 여기서 맡고,
// Methods 는 sessions/<슬러그>/<id>/sock UDS 하나로만 낸다 (소켓 0600 이 곧 인증). 웹·stdio·서비스 웹은 serve 가 연결마다 이 소켓에 하나씩 붙어 중계한다.
// 우체국(post.ts)에는 붙어서 등록하고 연결을 유지한다. 시그널 mail 이 오면 mail.fetch 로 가져와 다음 idle 에 한 턴으로 넣고 ack 한다
// (여러 통이면 한 번에). 우체국이 없으면 띄우고, 끊기면 다시 붙는다 — 세션 동작은 우체국과 무관하다.
// 수명: session.close·벤더 종료 → 세션을 닫고 소켓을 지우고 끝난다. 소유자(core.own 을 보낸 연결 하나)가 close 없이 끊기면
// OWNER_GRACE 동안 새 소유자를 기다리고 없으면 닫는다 (기동 직후도 같다). 로그는 남아 --resume 으로 이어간다.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { ClaudeSession } from './session.js';
import { CodexSession } from './codex.js';
import type { AgentSession } from './base.js';
import { EventLog, historyPage, summarize, type SessionMeta } from './eventLog.js';
import { isLoopback, reachable, sockAlive } from './live.js';
import { BUILD, connectPost, VERSION, type RpcClient } from './client.js';
import { corePaths, ensureDir, readOrCreateToken } from './paths.js';
import { formatMail, parseMailHeads } from './mail.js';
import { inspectEnv, readCall, startInspect, turnCalls, upstreamOf, type InspectProxy } from './inspect.js';
import { CoreError, ERR, PROTOCOL_VERSION, type ApprovalRequest, type LoggedEvent, type Mail, type MethodName, type Methods, type PostMethods, type RequestFrame, type SessionInfo } from './protocol.js';

/** 벤더 자식(claude CLI·codex)에 넘기지 않을 env — 워커 Claude 세션 안에서 띄우면 그 세션의 표식(CLAUDECODE·CLAUDE_CODE_SESSION_ID·
 *  CLAUDE_CODE_CHILD_SESSION·CLAUDE_CODE_ENTRYPOINT·CLAUDE_CODE_MESSAGING_* 등, claude 2.1.282·2.1.300 실측)이 딸려 가 자식이 남의 세션 안이라 여긴다.
 *  사용자 설정은 남긴다 — CLAUDE_CONFIG_DIR 을 지우면 자식이 ~/.claude 를 봐 import·resume 이 "No conversation found" 로 끝났다.
 *  gitignore 꼴: `*` 는 아무 글자, `!` 는 빼지 않는다, 마지막으로 맞은 줄이 정한다. 표식엔 규칙이 없고 버전마다 바뀌어 이 목록만 고친다 (사용자 2026-10-15) */
export const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_*', '!CLAUDE_CONFIG_DIR'];

export function stripEnv(env: NodeJS.ProcessEnv, rules: string[] = STRIP_ENV): NodeJS.ProcessEnv {
  const pats = rules.map((r) => ({ keep: r.startsWith('!'), re: new RegExp(`^${r.replace(/^!/, '').replaceAll('*', '.*')}$`) }));
  return Object.fromEntries(Object.entries(env).filter(([k]) => {
    let strip = false;
    for (const p of pats) if (p.re.test(k)) strip = !p.keep;
    return !strip;
  }));
}
const SDK_ENV = stripEnv(process.env);
/** 소유자가 close 없이 끊긴 뒤(SIGKILL·크래시) 새 소유자를 기다리는 시간 — 카드 핸드오프·serve 재기동의 틈. 빈 값·숫자 아님은 기본값 */
const OWNER_GRACE_MS = (Number(process.env.SLCODE_OWNER_GRACE_SECS) > 0 ? Number(process.env.SLCODE_OWNER_GRACE_SECS) : 10) * 1000;
/** 벤더 종료를 기다리는 상한 — core 는 detached 라 superlite 의 SIGKILL(서비스 중지 3초 뒤)이 닿지 않는다. 넘으면 정리하고 끝낸다 */
const CLOSE_DEADLINE_MS = 5000;

/** serve 가 core 에 넘기는 것 — 세션을 고르고 띄우는 데 필요한 최소한 (어느 세션을 이을지는 CLI·serve 가 이미 골랐다) */
export type CoreOptions = {
  dir?: string;
  cwd: string;
  /** 이어받을 세션 id (저장 세션). 없으면 새 세션 */
  resume?: string;
  title?: string;
  raw?: boolean;
  permissionMode?: string;
  /** 새 세션의 벤더 — 기본 claude. 이어받는 세션은 meta.vendor 를 따른다 */
  vendor?: 'claude' | 'codex';
  /** 새 세션을 inspect 로 (Claude 만). 이어받는 세션은 meta.inspect 를 따른다 */
  inspect?: boolean;
  log?: (msg: string) => void;
};

export type CoreHandle = { sock: string; session: SessionInfo; close: (reason?: string) => Promise<void>; done: Promise<void> };

export async function runCore(opts: CoreOptions): Promise<CoreHandle> {
  const log = opts.log ?? (() => {});
  const P = corePaths(opts.dir);
  ensureDir(P.sessionsDir);
  const migrated = EventLog.migrate(P.sessionsDir);
  if (migrated) log(`moved ${migrated} session(s) under cwd folders`);

  // ---- 세션 로그: 새로 / --resume
  let logFile: EventLog;
  if (opts.resume) {
    const found = EventLog.open(P.sessionsDir, opts.resume);
    if (!found) throw new CoreError(ERR.noSession, `no session ${opts.resume}`);
    if (await sockAlive(found.sockPath)) throw new CoreError(ERR.badRequest, `session ${opts.resume} is live — another slcode is serving it`);
    if (opts.title !== undefined) found.updateMeta({ title: opts.title });
    if (opts.inspect && found.meta.vendor !== 'codex') found.updateMeta({ inspect: true });
    logFile = found;
  } else {
    const meta: SessionMeta = {
      id: randomUUID().slice(0, 8), vendor: opts.vendor ?? 'claude', cwd: opts.cwd, title: opts.title ?? null,
      vendorSessionId: null, createdAt: Date.now(), permissionMode: opts.permissionMode ?? null, raw: opts.raw ?? false,
      ...(opts.inspect ? { inspect: true } : {}),
    };
    logFile = EventLog.create(P.sessionsDir, meta);
  }
  const cwd = logFile.meta.cwd;
  // 벤더 자식(과 그 Bash 도구가 띄우는 명령)이 자기 세션을 알게 — 세션 안의 `slcode mail/check/ask/reply` 가 이걸 읽는다 (사용자 확정 2026-10-02)
  const env: NodeJS.ProcessEnv = { ...SDK_ENV, SLCODE_SESSION: logFile.meta.id };
  // inspect (ticket slcode-inspect-proxy) — 켜져 있으면 벤더를 띄우기 전에 proxy 를 세우고 벤더 env 의 ANTHROPIC_BASE_URL 을 그리로
  const inspectDir = path.join(logFile.dir, 'inspect');
  let inspect: InspectProxy | null = null;
  let switching = false; // session.setInspect 가 벤더를 다시 띄우는 중 — 겹친 토글은 거절한다
  const vendorEnv = async () => {
    if (!logFile.meta.inspect || logFile.meta.vendor === 'codex') return env;
    inspect ??= await startInspect(inspectDir, upstreamOf(env));
    return inspectEnv(env, inspect.url);
  };
  const session: AgentSession = logFile.meta.vendor === 'codex'
    ? new CodexSession({ log: logFile, env, permissionMode: opts.permissionMode ?? logFile.meta.permissionMode, raw: opts.raw })
    : new ClaudeSession({ log: logFile, env: await vendorEnv(), resume: logFile.meta.vendorSessionId, permissionMode: opts.permissionMode ?? logFile.meta.permissionMode, raw: opts.raw });
  const sid = session.id;

  // ---- 디스패치 (UDS 연결마다 — CLI 동사, serve 의 중계 연결과 제어 연결)
  type Web = { host: string; port: number; url: string; version: string };
  type Conn = { detach: (() => void) | null; send: (o: unknown) => void; ownerPid: number | null; web: Web | null };
  const conns = new Set<Conn>();
  let owner: Conn | null = null;
  let closed = false;
  let draft = ''; // 웹 입력창 초안 (session.setDraft) — 메모리만
  const mine = (id: unknown) => { if (id !== sid) throw new CoreError(ERR.badRequest, `this process serves session ${sid} only`); return session; };
  const webs = () => [...conns].flatMap((c) => (c.web ? [c.web] : []));
  type Handler<K extends MethodName> = (conn: Conn, params: Methods[K]['params']) => Promise<Methods[K]['result']> | Methods[K]['result'];
  const handlers: { [K in MethodName]: Handler<K> } = {
    'core.auth': (_c, p) => {
      // 루프백 밖 웹 — serve 가 remote 를 붙여 넘긴다. 토큰 파일은 core 가 든다
      if (p?.remote && p.token !== readOrCreateToken(P)) throw new CoreError(ERR.unauthorized, 'bad token');
      return { ok: true, pid: process.pid, protocol: PROTOCOL_VERSION, session: sid };
    },
    'core.own': (conn, p) => {
      if (owner && owner !== conn) {
        if (!p?.takeover) throw new CoreError(ERR.owned, `session ${sid} is owned by pid ${owner.ownerPid ?? '?'}`);
        owner.send({ event: 'core.owner', params: { pid: p.pid ?? null } });
      }
      owner = conn; conn.ownerPid = p?.pid ?? null;
      disarmOwnerGrace();
      return { ok: true };
    },
    'serve.register': (conn, p) => {
      if (typeof p?.host !== 'string' || typeof p.port !== 'number') throw new CoreError(ERR.badRequest, 'host and port required');
      const url = reachable(`http://${p.host}:${p.port}/${isLoopback(p.host) ? '' : `?token=${readOrCreateToken(P)}`}`);
      conn.web = { host: p.host, port: p.port, url, version: String(p.version ?? '') };
      return { url };
    },
    'server.info': () => {
      const w = webs()[0];
      return { session: sid, cwd, host: w?.host ?? null, port: w?.port ?? null, url: w?.url ?? null, version: VERSION, build: BUILD, owner: owner?.ownerPid ?? null, serves: webs() };
    },
    'session.attach': (conn, p) => {
      const s = mine(p?.id);
      conn.detach?.();
      // limit 이면 끝 한 페이지와 합계 (ticket slcode-history-paging) — 구독과 같은 틱이라 페이지와 실시간 사이에 빠지는 이벤트가 없다
      const page = p.limit ? { ...historyPage(s.log.all, Infinity, Number(p.limit)), summary: summarize(s.log.all) } : { history: s.since(Number(p.since ?? 0)) };
      conn.detach = s.onEvent((e: LoggedEvent) => conn.send({ event: 'session.event', params: { id: sid, ...e } }));
      return { info: s.info(), ...page, pending: s.pendingApprovals() as ApprovalRequest[], draft };
    },
    'session.history': (_c, p) => {
      if (typeof p?.before !== 'number' || !(p.limit > 0)) throw new CoreError(ERR.badRequest, 'before and limit required');
      return historyPage(mine(p.id).log.all, p.before, p.limit);
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
      const git = (args: string[]) => new Promise<string | null>((r) => execFile('git', ['-C', cwd, ...args], { timeout: 2000 }, (e, out) => r(e ? null : out.trim() || null)));
      const [top, branch, limits, context] = await Promise.all([git(['rev-parse', '--show-toplevel']), git(['branch', '--show-current']), s.limits(), s.context()]);
      return { repo: top ? path.basename(top) : null, branch, limits, context };
    },
    'session.mcp': (_c, p) => mine(p?.id).mcp(),
    'session.mcpReconnect': async (_c, p) => {
      if (typeof p?.name !== 'string' || !p.name) throw new CoreError(ERR.badRequest, 'name required');
      try { return await mine(p.id).reconnectMcp(p.name); }
      catch (e) { if (e instanceof CoreError) throw e; throw new CoreError(ERR.badRequest, (e as Error).message); }
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
    'session.setInspect': async (_c, p) => {
      const s = mine(p?.id);
      if (!(s instanceof ClaudeSession)) throw new CoreError(ERR.badRequest, 'inspect is for claude sessions only');
      if (typeof p.on !== 'boolean') throw new CoreError(ERR.badRequest, 'on required');
      if (p.on === !!logFile.meta.inspect) return { ok: true };
      if (s.state !== 'idle' && s.state !== 'starting') throw new CoreError(ERR.badRequest, 'inspect can be switched only while idle');
      if (switching) throw new CoreError(ERR.badRequest, 'inspect is already being switched');
      switching = true;
      logFile.updateMeta({ inspect: p.on });
      // 켤 때는 proxy 를 먼저 세우고, 끌 때는 옛 벤더가 내려간 뒤에 닫는다. 실패하면 meta 와 새 proxy 를 되돌린다
      try { await s.reopen(await vendorEnv()); }
      catch (e) { logFile.updateMeta({ inspect: !p.on }); if (p.on) { await inspect?.close(); inspect = null; } throw new CoreError(ERR.badRequest, (e as Error).message); }
      finally { switching = false; }
      if (!p.on) { await inspect?.close(); inspect = null; }
      broadcast('session.changed', s.info());
      return { ok: true };
    },
    'session.inspectTurn': (_c, p) => ({ calls: turnCalls(inspectDir, mine(p?.id).log.all, Number(p.end)) }),
    'session.inspectCall': (_c, p) => {
      mine(p?.id);
      const rec = readCall(inspectDir, Number(p.n));
      if (!rec) throw new CoreError(ERR.badRequest, `no inspect call ${p.n} (dropped by the size cap or never recorded)`);
      return rec;
    },
    'session.setDraft': (_c, p) => { mine(p?.id); if (typeof p.text !== 'string') throw new CoreError(ERR.badRequest, 'text required'); draft = p.text; return { ok: true }; },
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
  function broadcast(event: string, params: unknown) { for (const c of conns) c.send({ event, params }); }
  async function onLine(conn: Conn, line: string) {
    let msg: RequestFrame;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || typeof msg.method !== 'string') return;
    try {
      const h = (handlers as Record<string, Handler<MethodName>>)[msg.method];
      if (!h) throw new CoreError(ERR.badRequest, `unknown method ${msg.method}`);
      conn.send({ id: msg.id, result: await h(conn, msg.params as never) });
    } catch (e) {
      conn.send({ id: msg.id, error: { code: e instanceof CoreError ? e.code : 'error', message: e instanceof Error ? e.message : String(e) } });
    }
  }
  // 벤더가 기동 중(아래 listen 을 기다리는 사이)에 죽으면 close 가 아직 없다 — 사유를 들고 있다가 끝에서 던진다 (2026-10-04 실측: TDZ 'close' 로 진짜 사유가 묻혔다)
  let closeFn: ((reason?: string) => Promise<void>) | null = null;
  let earlyExit: string | null = null;
  session.onEvent((e) => {
    if (e.ev.kind === 'session.state') broadcast('session.changed', session.info());
    if (e.ev.kind === 'session.state' && (e.ev.state === 'idle' || e.ev.state === 'starting')) flushMail();
    if (e.ev.kind === 'session.exit') { broadcast('session.closed', { id: sid, reason: e.ev.reason }); const r = `session exited: ${e.ev.reason}`; if (closeFn) void closeFn(r); else earlyExit = r; }
  });

  // ---- 소유권 — 소유자가 없는 동안은 유예 시계가 돈다 (기동 직후, 소유자가 close 없이 끊긴 뒤)
  let ownerGrace: NodeJS.Timeout | null = null;
  function armOwnerGrace() {
    if (ownerGrace || closed) return;
    ownerGrace = setTimeout(() => { ownerGrace = null; if (!owner) void close('owner gone'); }, OWNER_GRACE_MS);
  }
  function disarmOwnerGrace() { if (ownerGrace) { clearTimeout(ownerGrace); ownerGrace = null; } }

  // ---- UDS
  const sockPath = logFile.sockPath;
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 }); // 긴 경로 폴백(<dir>/sock/<id>)의 폴더
  try { fs.unlinkSync(sockPath); } catch {} // 죽은 프로세스의 소켓 (위에서 살아 있지 않음을 확인했다)
  const socks = new Set<net.Socket>();
  const uds = net.createServer((sock) => {
    socks.add(sock);
    const conn: Conn = { detach: null, send: (o) => { if (!sock.destroyed) sock.write(JSON.stringify(o) + '\n'); }, ownerPid: null, web: null };
    conns.add(conn);
    let buf = '';
    sock.setEncoding('utf8'); // 청크 경계에 걸린 한글이 깨지지 않게 — 웹·stdio 프레임이 모두 이 스트림을 거친다
    sock.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) void onLine(conn, l); } });
    sock.on('close', () => {
      socks.delete(sock); conn.detach?.(); conns.delete(conn);
      if (owner === conn) { owner = null; armOwnerGrace(); }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => { uds.once('error', reject); uds.listen(sockPath, () => { fs.chmodSync(sockPath, 0o600); resolve(); }); })
    .catch(async (e) => { await session.close('listen failed'); throw e; });

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
      await client.request('post.register', { id: sid, cwd, pid: process.pid, sock: sockPath, version: VERSION, title: logFile.meta.title });
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
  // 닫는 중에 다시 부르면 같은 종료를 기다린다. 바로 돌아오면 호출자의 process.exit 이 종료를 끊어 closedAt·session.exit 가 남지 않았다 (2026-10-11 실측)
  let closing: Promise<void> | null = null;
  const close = (reason = 'closed'): Promise<void> => (closing ??= (async () => {
    closed = true;
    disarmOwnerGrace();
    log(`closing: ${reason}`);
    // 꺼진 시각은 먼저 — 벤더 종료가 길어 SIGKILL 을 맞아도 남는다
    try { logFile.updateMeta({ closedAt: Date.now() }); } catch { /* delete 가 세션 폴더를 먼저 지웠다 */ }
    for (const [id, w] of asks) { asks.delete(id); w.reject(new CoreError('closed', `session closed: ${reason}`)); }
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([session.close(reason), new Promise<void>((r) => { deadline = setTimeout(() => { log(`vendor did not close in ${CLOSE_DEADLINE_MS / 1000}s — leaving it`); r(); }, CLOSE_DEADLINE_MS); })]);
    clearTimeout(deadline);
    await inspect?.close();
    uds.close();
    for (const s of socks) s.end(); // serve 의 중계·제어 연결이 닫힘을 본다
    try { fs.unlinkSync(sockPath); } catch {}
    post?.close();
    resolveDone();
  })());
  closeFn = close;
  if (earlyExit) { await close(earlyExit); throw new CoreError('vendor_exit', earlyExit); }
  armOwnerGrace();
  return { sock: sockPath, session: session.info(), close, done };
}
