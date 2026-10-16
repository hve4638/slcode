// serve — 화면이 세션에 닿는 통로 (ticket slcode-core-serve-split, 설계 ws docs/report/slcode-core-serve-split.md, 사용자 확정 2026-10-15).
// 세션은 core(core.ts)가 쥔다. serve 는 core 를 detached 로 띄우는 데 필요한 최소 정보(폴더·이어받을 id·세션 옵션)만 넘기고,
// 그 뒤로는 세션 소켓으로만 이야기한다:
//   제어 연결 하나   core.own(소유자) · serve.register(TCP 웹 주소) — 이 연결의 수명이 곧 serve 가 core 를 붙든 시간
//   중계 연결        화면 연결(WS·stdio·서비스 웹) 하나마다 세션 소켓 연결 하나. 프레임은 해석하지 않고 그대로 넘긴다
//                    (화면 설정 settings.get·set 만 serve 가 답한다 — 설정은 세션이 아니라 입구(웹·superlite)의 것, ticket slcode-web-settings)
// 루프백 밖 웹은 core.auth 가 통과할 때까지 다른 요청을 막고 core 의 프레임도 넘기지 않는다 (토큰 검사는 core).
// 세션 파일은 건드리지 않는다. 직접 다루는 파일은 자기 설치 폴더의 web/ 정적 파일(시작 때 한 번 읽어 고정)과 상태 폴더의 settings-*.json(읽기·쓰기·감시)뿐이다.
// 수명: 소유자 serve 가 닫히면(Ctrl-C·SIGTERM) session.close 를 보내고 core 가 끝나기를 기다린다. core 가 끝나면 serve 도 끝난다.
// attach 면 이미 떠 있는 core 에 붙는 중계일 뿐이다 (소유자 아님 — superlite 카드가 떠 있는 세션에 붙는 길). stdin 이 닫히면 끝난다.
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { connectSession, PKG, VERSION } from './client.js';
import { corePaths, ensureDir } from './paths.js';
import { closedSessions, isLoopback } from './live.js';
import type { CoreOptions } from './core.js';
import { readSettings, watchSettings, writeSettings } from './settings.js';
import { CoreError, ERR, type SessionInfo, type SettingsKind, type SettingsPatch } from './protocol.js';

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
};
/** 화면 연결(웹·stdio)에서는 부를 수 없는 제어 메서드 — 소유권과 웹 주소 등록(토큰이 붙은 url 을 돌려준다)은 serve 의 제어 연결만 */
const CONTROL_ONLY = new Set(['core.own', 'serve.register']);
/** 인증 전 줄 세워 둘 수 있는 요청 수 — 인증 안 된 원격 클라이언트가 serve 메모리를 키우지 못하게 */
const HELD_MAX = 64;

export type ServeOptions = {
  dir?: string;
  cwd: string;
  /** 이어받을 세션 id (저장 세션) */
  resume?: string;
  /** 이 cwd 에서 가장 최근에 꺼진 세션을 이어받는다 (살아 있는 세션은 빼고, 없으면 새 세션) */
  continueLast?: boolean;
  title?: string;
  raw?: boolean;
  permissionMode?: string;
  /** 새 세션의 벤더 — 기본 claude. 이어받는 세션은 meta.vendor 를 따른다 */
  vendor?: 'claude' | 'codex';
  /** 웹 서버 — 기본 켬. false 면 웹 없이 (superlite 카드 서비스) */
  web?: boolean;
  host?: string;
  port?: number;
  /** 이 프로세스의 stdin/stdout 을 세션 소켓 연결 하나로 중계한다 (superlite 백그라운드 서비스의 stdio 통로, ticket agent-plugin-card 2026-10-04).
   *  인증은 UDS 처럼 없다 — 띄운 쪽(데몬)이 곧 신뢰 경계. 로그는 stderr 로만 */
  stdio?: boolean;
  /** superlite 서비스 웹 소켓 (SUPERLITE_SERVICE_WEB, ticket plugin-service-web) — uds 경로(`/` 시작) 또는 host:port. 여기에도 웹을 연다.
   *  superlite relay /svc 입구가 데몬을 거쳐 붙으므로 인증은 UDS 처럼 없다 (데몬·superlite 인증이 신뢰 경계) */
  webSock?: string;
  /** 이미 떠 있는 세션에 붙기만 한다 — core 를 띄우지 않고 소유자도 아니다. url 은 hello 에 낸 주소 (옛 빌드 세션의 server.info 에 url 이 없으면 채운다) */
  attach?: { id: string; sock: string; url: string | null };
  log?: (msg: string) => void;
};

export type ServeHandle = { url: string | null; sock: string; session: SessionInfo; close: (reason?: string) => Promise<void>; done: Promise<void> };

/** web/ 아래 파일 전부 — 상대 경로('/' 구분) → 내용. serve 가 시작할 때 한 번 읽어 고정한다 (ticket slcode-settings-set-unknown-method).
 *  플러그인 Update 는 떠 있는 serve 를 둔 채 설치 폴더의 파일만 바꾼다. 요청마다 디스크를 읽으면 옛 serve 가 새 웹을 내보내고, 새 웹이 보낸
 *  settings.set 을 옛 serve 가 모른 채 core 로 넘겨 unknown method 가 됐다 (2026-10-16 실측). web/ 을 고치면 serve 를 다시 띄워야 보인다 */
export function loadWeb(root = WEB_DIR): Map<string, Buffer> {
  const web = new Map<string, Buffer>();
  for (const f of fs.readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const fp = path.join(root, f);
    if (fs.statSync(fp).isFile()) web.set(f.split(path.sep).join('/'), fs.readFileSync(fp));
  }
  return web;
}

/** 웹 정적 파일 (loadWeb 이 고정한 web/) — 세션 웹과 서비스 웹이 같이 쓴다. 경로는 상대(경로 접두사 아래에서도 — relay /svc).
 *  dir 이 있으면 index.html 의 <html> 에 그 상태 폴더·입구(kind)의 테마(data-theme)를 넣어 보낸다 — 연결 전 첫 화면부터 그 테마로
 *  (카드 iframe 이 다시 로드될 때 시스템 색이 비치지 않게, ticket slcode-web-settings) */
export function staticHandler(req: http.IncomingMessage, res: http.ServerResponse, web: Map<string, Buffer>, dir?: string, kind: SettingsKind = 'web'): void {
  const file = path.posix.normalize(decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html').replace(/\/+$/, '');
  const name = web.has(file) ? file : `${file}/index.html`;
  const body = web.get(name);
  if (!body) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  if (dir && name === 'index.html') {
    const { theme } = readSettings(dir, kind);
    const attr = /^[\w-]+$/.test(theme) ? ` data-theme="${theme}"` : '';
    res.end(body.toString('utf8').replace('<html lang="ko">', `<html lang="ko"${attr}>`));
    return;
  }
  res.end(body);
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

/** core 를 detached 로 띄우고 stdout 첫 줄(준비·실패)을 기다린다. 그 뒤 파이프를 놓아 core 가 이 프로세스와 따로 산다.
 *  setsid 라 serve 의 프로세스 그룹 밖이다 — 터미널 Ctrl-C·superlite 서비스 중지(그룹 SIGTERM)가 core 에 닿지 않는다 */
export function spawnCore(opts: CoreOptions & { dir: string }): Promise<{ id: string; sock: string; session: SessionInfo }> {
  const P = corePaths(opts.dir);
  ensureDir(P.dir);
  const err = fs.openSync(P.coreLog, 'a');
  const child = spawn(process.execPath, [path.join(PKG, 'dist', 'coreMain.js'), JSON.stringify(opts)], { detached: true, stdio: ['ignore', 'pipe', err], windowsHide: true });
  fs.closeSync(err);
  return new Promise((resolve, reject) => {
    let buf = '', settled = false;
    const settle = (f: () => void) => { if (settled) return; settled = true; child.stdout!.destroy(); child.unref(); f(); };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let m: { id?: string; sock?: string; session?: SessionInfo; error?: string; code?: string };
      try { m = JSON.parse(buf.slice(0, i)); } catch { m = { error: `bad core hello: ${buf.slice(0, i)}` }; }
      settle(() => (m.error ? reject(new CoreError(m.code ?? 'error', m.error)) : resolve(m as { id: string; sock: string; session: SessionInfo })));
    });
    child.once('error', (e) => settle(() => reject(e)));
    // exit 가 아니라 close — stdout 이 다 읽힌 뒤라 core 가 낸 실패 사유({error})가 일반 문구에 묻히지 않는다
    child.once('close', (code) => settle(() => reject(new CoreError('core_exit', `core exited (${code}) before it was ready — see ${P.coreLog}`))));
  });
}

export async function serveSession(opts: ServeOptions): Promise<ServeHandle> {
  const log = opts.log ?? (() => {});
  const P = corePaths(opts.dir);
  const owner = !opts.attach;
  const web = loadWeb();

  // ---- core: 띄우거나(소유자) 떠 있는 것에 붙는다(attach)
  let sid: string, sock: string, session: SessionInfo;
  if (opts.attach) ({ id: sid, sock } = opts.attach);
  else {
    let resume = opts.resume;
    if (!resume && opts.continueLast) {
      resume = (await closedSessions(P.sessionsDir, opts.cwd))[0]?.id;
      if (!resume) log(`no closed session in ${opts.cwd} — starting a new one`);
    }
    ({ id: sid, sock, session } = await spawnCore({ dir: P.dir, cwd: opts.cwd, resume, title: opts.title, raw: opts.raw, permissionMode: opts.permissionMode, vendor: opts.vendor }));
  }
  const control = await connectSession(sock);
  // 소유권을 빼앗기면(core.owner — 카드 핸드오프) 이 serve 가 닫혀도 세션을 닫지 않는다
  let owns = owner;
  control.onEvent((m) => { if (m.event === 'core.owner') { owns = false; log(`session ownership moved to pid ${(m.params as { pid: number | null }).pid ?? '?'}`); } });
  if (owner) await control.request('core.own', { pid: process.pid }).catch((e) => { control.close(); throw e; });
  else {
    // 기록은 받지 않는다 — since 를 끝으로 (CLI 는 id 만 쓰지만 핸들 꼴을 맞춘다)
    session = (await control.request('session.attach', { id: sid, since: Number.MAX_SAFE_INTEGER })).info;
    await control.request('session.detach', { id: sid });
  }

  // ---- 화면 설정 (ticket slcode-web-settings) — settings.get·set 은 core 로 넘기지 않고 여기서 답한다 (설정은 세션이 아니라 입구의 것).
  // 묶음은 연결이 들어온 입구가 정한다: TCP 웹은 web, 서비스 웹·stdio 는 superlite (사용자 결정 2026-10-16 — 두 벌은 완전히 따로).
  // 파일이 바뀌면(어느 serve 가 썼든) 그 입구의 인증된 화면 연결 모두에 settings.changed. 쓴 serve 도 자기 감시로 알린다 — 길이 하나
  const screens: Record<SettingsKind, Set<(line: string) => void>> = { web: new Set(), superlite: new Set() };
  /** settings.get·set 이면 답하고 true — 메서드 이름이 들어 있을 때만 해석한다 */
  function settingsCall(line: string, send: (line: string) => void, kind: SettingsKind): boolean {
    if (!line.includes('"settings.get"') && !line.includes('"settings.set"')) return false;
    let m: { id?: unknown; method?: unknown; params?: { settings?: SettingsPatch } };
    try { m = JSON.parse(line); } catch { return false; }
    if (m?.method !== 'settings.get' && m?.method !== 'settings.set') return false;
    try { send(JSON.stringify({ id: m.id, result: m.method === 'settings.get' ? readSettings(P.dir, kind) : writeSettings(P.dir, kind, m.params?.settings) })); }
    catch (e) { send(JSON.stringify({ id: m.id, error: { message: (e as Error).message } })); }
    return true;
  }

  // ---- 중계: 화면 연결 하나 ↔ 세션 소켓 연결 하나
  const relays = new Set<net.Socket>();
  /** gate 면 core.auth 가 통과할 때까지 다른 요청을 막고 core 의 프레임을 넘기지 않는다. 그 사이 온 요청은 줄 세워 두었다가(HELD_MAX 까지) 통과하면 보낸다.
   *  제어 메서드(CONTROL_ONLY)는 화면 연결에서 늘 거절한다. kind 는 이 연결이 들어온 입구 — 화면 설정의 묶음 */
  function relay(send: (line: string) => void, end: () => void, gate: boolean, kind: SettingsKind, fix?: (line: string) => string) {
    const s = net.createConnection(sock);
    relays.add(s);
    let authed = !gate, authId: unknown, held: string[] = [], buf = '';
    if (authed) screens[kind].add(send);
    const forward = (line: string) => { if (!settingsCall(line, send, kind)) s.write(line + '\n'); };
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!authed) {
          let m: { id?: unknown; result?: unknown };
          try { m = JSON.parse(l); } catch { continue; }
          if (authId === undefined || m.id !== authId) continue;
          authId = undefined; send(l);
          if (m.result) { authed = true; screens[kind].add(send); for (const h of held.splice(0)) forward(h); }
          else for (const h of held.splice(0)) deny(h);
          continue;
        }
        send(fix ? fix(l) : l);
      }
    });
    s.on('close', () => { relays.delete(s); screens[kind].delete(send); end(); });
    s.on('error', () => {});
    const refuse = (line: string, code: string, message: string) => { try { const m = JSON.parse(line); if (m?.id !== undefined) send(JSON.stringify({ id: m.id, error: { code, message } })); } catch {} };
    const deny = (line: string) => refuse(line, ERR.unauthorized, 'core.auth first');
    /** 제어 메서드인가 — 메서드 이름이 들어 있을 때만 해석한다 (첨부가 실린 큰 프레임을 매번 읽지 않게) */
    const isControl = (line: string) => { if (!line.includes('"core.own"') && !line.includes('"serve.register"')) return false; try { return CONTROL_ONLY.has(JSON.parse(line)?.method); } catch { return false; } };
    return {
      write(line: string) {
        if (isControl(line)) { refuse(line, ERR.badRequest, 'not allowed on a screen connection'); return; }
        if (authed) { forward(line); return; }
        let m: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
        try { m = JSON.parse(line); } catch { return; }
        if (authId !== undefined) { if (held.length < HELD_MAX) held.push(line); else deny(line); return; }
        if (m?.method !== 'core.auth' || (typeof m.id !== 'number' && typeof m.id !== 'string')) { deny(line); return; }
        authId = m.id;
        s.write(JSON.stringify({ ...m, params: { ...m.params, remote: true } }) + '\n');
      },
      close() { s.end(); },
    };
  }

  // ---- http + ws
  const wsOn = (server: http.Server, gate: boolean, kind: SettingsKind) => {
    const w = new WebSocketServer({ server, path: '/ws' });
    w.on('error', () => {});
    w.on('connection', (ws: WebSocket) => {
      const r = relay((l) => { if (ws.readyState === ws.OPEN) ws.send(l); }, () => ws.close(), gate, kind);
      ws.on('message', (d) => r.write(d.toString()));
      ws.on('close', () => r.close());
      ws.on('error', () => {});
    });
    return w;
  };
  const stopAll: (() => void)[] = [];
  for (const kind of ['web', 'superlite'] as const) stopAll.push(watchSettings(P.dir, kind, (st) => { const l = JSON.stringify({ event: 'settings.changed', params: st }); for (const f of screens[kind]) f(l); }));
  const fail =async (e: unknown): Promise<never> => { if (owner) await control.request('session.close', { id: sid }).catch(() => {}); control.close(); for (const f of stopAll) f(); throw e; };
  // superlite 서비스 웹 (ticket plugin-service-web) — TCP 웹과 별개, 인증 없음 (UDS 와 같은 신뢰 경계)
  if (opts.webSock) {
    const svc = http.createServer((q, r) => staticHandler(q, r, web, P.dir, 'superlite'));
    const svcWss = wsOn(svc, false, 'superlite');
    stopAll.push(() => { for (const c of svcWss.clients) c.close(); svcWss.close(); svc.close(); });
    // attach 는 서비스 웹을 열지 못해도 stdio 중계는 계속한다 (옛 proxyStdio 와 같다)
    await listenAddr(svc, opts.webSock).catch(owner ? fail : (e: Error) => log(`service web: ${e.message}`));
  }
  let url: string | null = opts.attach?.url ?? null;
  const host = opts.host ?? '127.0.0.1';
  if (opts.web !== false && !opts.attach) {
    const srv = http.createServer((q, r) => staticHandler(q, r, web, P.dir, 'web'));
    const wss = wsOn(srv, !isLoopback(host), 'web');
    stopAll.push(() => { for (const c of wss.clients) c.close(); wss.close(); srv.close(); });
    const port = await new Promise<number>((resolve, reject) => { srv.once('error', reject); srv.listen(opts.port ?? 0, host, () => resolve((srv.address() as net.AddressInfo).port)); }).catch(fail);
    url = (await control.request('serve.register', { host, port, version: VERSION }).catch(fail)).url;
  }

  // ---- stdio (옵션) — 연결 하나. 첫 줄이 올 때 세션 소켓에 붙는다 (CLI 가 먼저 hello 를 내고, 그 앞에 core 의 방송이 끼지 않게)
  if (opts.stdio) {
    // 옛 빌드 세션(attach)은 server.info 에 url 이 없다 — 다시 붙는 쪽은 hello 를 못 보므로 hello 의 url 로 채운다
    const asked = new Set<unknown>();
    const fix = opts.attach?.url ? (l: string) => {
      if (!asked.size) return l;
      try { const m = JSON.parse(l); if (asked.delete(m.id) && m.result && !m.result.url) { m.result.url = url; return JSON.stringify(m); } } catch {}
      return l;
    } : undefined;
    let r: ReturnType<typeof relay> | null = null;
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!l.trim()) continue;
        if (fix) try { const m = JSON.parse(l); if (m.method === 'server.info') asked.add(m.id); } catch {}
        r ??= relay((x) => process.stdout.write(x + '\n'), () => {}, false, 'superlite', fix);
        r.write(l);
      }
    });
    // 띄운 쪽이 떠났다 — 소유자면 세션은 그대로 (UDS 클라이언트가 끊긴 것과 같다), attach 면 중계가 끝난다
    process.stdin.on('end', () => { r?.close(); if (!owner) void close('stdin closed'); });
    process.stdin.on('error', () => {});
  }

  // ---- 수명
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  let down = false;
  const shutdown = () => {
    if (down) return;
    down = true;
    for (const f of stopAll) f();
    for (const s of relays) s.destroy();
    control.close();
    resolveDone();
  };
  void control.done.then(shutdown); // core 가 끝났다 (세션 닫힘·벤더 종료·크래시)
  // 닫는 중에 다시 부르면(시그널 두 번 — superlite 서비스 중지는 SIGTERM 뒤 tmux 정리에서 한 번 더 온다) 같은 종료를 기다린다. 바로
  // 돌아오면 호출자의 process.exit 이 종료를 끊어 core 의 종료를 기다리지 못했다 (2026-10-11 실측)
  let closing: Promise<void> | null = null;
  const close = (reason = 'closed'): Promise<void> => (closing ??= (async () => {
    log(`closing: ${reason}`);
    // 소유자면 세션을 닫는다. core 는 detached 라 이 프로세스가 먼저 kill 돼도(superlite 는 SIGTERM 3초 뒤 SIGKILL) 스스로 닫기를 마친다
    if (owns && !control.closed) {
      control.request('session.close', { id: sid }).catch(() => {});
      let t: NodeJS.Timeout | undefined;
      await Promise.race([control.done, new Promise((r) => (t = setTimeout(r, 15000)))]);
      clearTimeout(t);
    }
    shutdown();
  })());
  return { url, sock, session: session!, close, done };
}
