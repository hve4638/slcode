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
// attach.takeover 면 떠 있는 core 의 소유권을 빼앗는다 — 카드 핸드오프의 새 카드. 그 뒤로는 소유자 serve 와 같다.
// 웹 모드(터미널의 slcode new)에서는 진입 프로세스(entry.ts)가 포트를 쥐고 들어온 연결을 넘긴다(feed) — 이 serve 는 그 자식이고 소유자가 아니다.
// serve 가 답하는 것: settings.get·set(화면 설정), serve.info·update.run·serve.restart(serve 교체, 2단계) — 그 밖은 core 로 그대로 넘긴다.
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { BUILD, connectSession, connectSock, diskBuild, PKG, VERSION, type RpcClient } from './client.js';
import { corePaths, readOrCreateToken } from './paths.js';
import { closedSessions, isLoopback, spawnCore } from './live.js';
import { readSettings, watchSettings, writeSettings } from './settings.js';
import { CoreError, ERR, FILES, type SessionInfo, type SettingsKind, type SettingsPatch, type UpdateCheck } from './protocol.js';
import { inspectBlocked } from './inspect.js';

export const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', // 로컬 파일 (fileHandler)
};
/** 화면 연결(웹·stdio)에서는 부를 수 없는 제어 메서드 — 소유권·웹 주소 등록(토큰이 붙은 url 을 돌려준다)·core 교체는 serve 의 제어 연결만 */
const CONTROL_ONLY = new Set(['core.own', 'serve.register', 'core.retire']);
/** serve 가 답하는 메서드 (ServeMethods) — core 로 넘기지 않는다 */
const SERVE_METHODS = new Set(['settings.get', 'settings.set', 'serve.info', 'update.run', 'serve.restart', 'web.files', 'file.get']);
/** 프레임의 요청·응답 id — 앞머리만 본다 (첨부가 실린 큰 프레임을 해석하지 않게). 화면·core 는 id 를 맨 앞에 쓴다 ({id, method, params}·{id, result}). 아니면 null */
const idOf = (line: string): string | null => /^\{"id":(-?\d+|"(?:[^"\\]|\\.)*")[,}]/.exec(line)?.[1] ?? null;
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
  inspect?: boolean;
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
  /** 이미 떠 있는 세션에 붙기만 한다 — core 를 띄우지 않고 소유자도 아니다. url 은 hello 에 낸 주소 (옛 빌드 세션의 server.info 에 url 이 없으면 채운다).
   *  takeover 면 소유권을 빼앗아 소유자가 된다 (카드 핸드오프 — resume --stdio --takeover) */
  attach?: { id: string; sock: string; url: string | null; takeover?: boolean };
  /** 웹 모드 진입 프로세스가 넘겨주는 TCP 연결 (entry.ts) — host·port 는 진입 프로세스가 listen 한 주소. 이 serve 는 listen 하지 않고 받은 연결만 서빙한다 */
  feed?: { host: string; port: number; onConn: (cb: (sock: net.Socket) => void) => void };
  /** serve.restart — 진입 프로세스에 교체를 맡긴다. 새 serve 가 준비되면 풀리고, 못 뜨면 사유로 거절된다. 없으면(카드·--no-web) 이 serve 는 스스로 바뀌지 못한다 */
  onRestart?: () => Promise<void>;
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
 *  (카드 iframe 이 다시 로드될 때 시스템 색이 비치지 않게, ticket slcode-web-settings). 이 serve 의 버전(data-version)도 함께 — 웹은 이 serve 가 고정한 것이라
 *  화면의 버전이다. 설정 창이 세션(core) 버전과 견준다 (ticket slcode-web-version-display). 빌드(data-build)는 다시 붙은 serve 가 바뀌었는지(serve.info), 입구(data-kind)는
 *  [업데이트] 를 serve 와 플러그인 중 누구에게 물을지 화면이 안다 (ticket slcode-core-serve-split 2단계) */
export function staticHandler(req: http.IncomingMessage, res: http.ServerResponse, web: Map<string, Buffer>, dir?: string, kind: SettingsKind = 'web'): void {
  const file = path.posix.normalize(decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'index.html').replace(/\/+$/, '');
  const name = web.has(file) ? file : `${file}/index.html`;
  const body = web.get(name);
  if (!body) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  if (dir && name === 'index.html') { res.end(withPageAttrs(body.toString('utf8'), dir, kind)); return; }
  res.end(body);
}

/** 화면 html 의 <html> 에 테마·serve 버전·빌드·입구를 넣는다 (staticHandler 의 index.html, 카드 모드 web.files 의 card.html) */
function withPageAttrs(html: string, dir: string, kind: SettingsKind): string {
  const { theme } = readSettings(dir, kind);
  const attr = (/^[\w-]+$/.test(theme) ? ` data-theme="${theme}"` : '') + ` data-version="${VERSION}" data-build="${BUILD}" data-kind="${kind}"`;
  return html.replace('<html lang="ko">', `<html lang="ko"${attr}>`);
}

/** 카드 모드 화면 파일 (ticket slcode-card-svc-token-dead) — superlite 플러그인이 stdio 로 받아 주소 없는 iframe(srcdoc)에 넣는다.
 *  html 은 card.html(테마·버전을 넣은), files 는 그 밖의 글 파일 전부 (모듈·css) */
export function webFiles(web: Map<string, Buffer>, dir: string, kind: SettingsKind): { html: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  for (const [name, body] of web) if (/\.(js|css)$/.test(name)) files[name] = body.toString('utf8');
  return { html: withPageAttrs(web.get('card.html')?.toString('utf8') ?? '', dir, kind), files };
}

/** 답변 속 로컬 파일 경로 → 실제 파일과 content-type. Codex 꼴 줄 번호(a.ts:12)는 그 경로가 없으면 떼고. 없으면 null */
function localFile(want: string): { path: string; type: string } | null {
  const p = [want, want.replace(/:\d+(:\d+)?$/, '')].find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
  if (!p) return null;
  let type = TYPES[path.extname(p).toLowerCase()];
  if (!type) { // 소스·로그 같은 글은 브라우저에 보이게, 나머지는 내려받기
    const head = Buffer.alloc(8192), fd = fs.openSync(p, 'r');
    try { type = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0)).includes(0) ? 'application/octet-stream' : 'text/plain; charset=utf-8'; } finally { fs.closeSync(fd); }
  }
  return { path: p, type };
}

/** 카드 모드의 file (file.get) — 화면이 포트로 받아 blob 주소로 그린다. 범위는 fileHandler 와 같다 */
const FILE_GET_MAX = 32 * 1024 * 1024;
export function fileGet(want: unknown): { mediaType: string; size: number; data: string } {
  if (typeof want !== 'string' || !path.isAbsolute(want)) throw new CoreError(ERR.badRequest, 'absolute path required');
  const f = localFile(want);
  if (!f) throw new CoreError(ERR.badRequest, 'not found');
  const size = fs.statSync(f.path).size;
  if (size > FILE_GET_MAX) throw new CoreError(ERR.badRequest, `file too large (${size} bytes)`);
  return { mediaType: f.type, size, data: fs.readFileSync(f.path).toString('base64') };
}

/** 로컬 파일 — 답변의 마크다운 링크·이미지가 가리키는 절대 경로를 `file?path=` 로 (ticket slcode-append-system-prompt, 사용자 결정 2026-10-17).
 *  범위는 serve 사용자가 읽을 수 있는 모든 파일 — 토큰을 통과한 화면은 이미 에이전트로 무엇이든 읽힐 수 있다. token 이 있으면(루프백 밖 웹) 같은 토큰만.
 *  file 경로가 아니면 false — 정적 파일로 넘긴다 */
export function fileHandler(req: http.IncomingMessage, res: http.ServerResponse, token: string | null): boolean {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname !== '/file') return false;
  const end = (code: number, msg: string) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg); };
  if (token !== null && u.searchParams.get('token') !== token) { end(401, 'unauthorized'); return true; }
  const want = u.searchParams.get('path') ?? '';
  if (!path.isAbsolute(want)) { end(400, 'absolute path required'); return true; }
  // Codex 는 파일 링크에 줄 번호를 붙인다 ([a.ts:12](/abs/a.ts:12)) — 그 경로가 없으면 떼고 다시
  const f = localFile(want);
  if (!f) { end(404, 'not found'); return true; }
  const { path: p, type } = f;
  // 같은 출처로 열린 html·svg 가 스크립트로 화면의 토큰(localStorage)이나 /ws 에 닿지 못하게 sandbox
  res.writeHead(200, { 'content-type': type, 'content-security-policy': 'sandbox', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' });
  fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
  return true;
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
  /** core 를 이 serve 가 띄웠다 — 웹을 열지 못하면 세션을 닫는다. attach(takeover 포함)는 남의 세션이라 닫지 않는다 */
  const spawned = !opts.attach;
  const owner = spawned || !!opts.attach?.takeover;
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
    ({ id: sid, sock, session } = await spawnCore({ dir: P.dir, cwd: opts.cwd, resume, title: opts.title, raw: opts.raw, inspect: opts.inspect, permissionMode: opts.permissionMode, vendor: opts.vendor }));
  }
  let control = await connectSession(sock);
  // 소유권을 빼앗기면(core.owner — 카드 핸드오프) 이 serve 가 닫혀도 세션을 닫지 않는다
  let owns = owner;
  /** serve.register 로 알린 웹 주소 — core 가 바뀌면 새 core 에 다시 알린다 */
  let registered: { host: string; port: number } | null = null;
  /** 제어 연결의 이벤트. core.replaced 뒤에 끊기면 serve 를 끝내지 않고 새 core 에 다시 붙는다 (ticket slcode-core-serve-split 3단계) */
  const hook = (c: RpcClient) => {
    let replaced = false;
    c.onEvent((m) => {
      if (m.event === 'core.owner') { owns = false; log(`session ownership moved to pid ${(m.params as { pid: number | null }).pid ?? '?'}`); }
      else if (m.event === 'core.replaced') replaced = true;
    });
    void c.done.then(async () => {
      if (!replaced || down) { shutdown(); return; } // core 가 끝났다 (세션 닫힘·벤더 종료·크래시)
      try {
        const next = await connectSession(sock);
        control = next; hook(next);
        if (owns) await next.request('core.own', { pid: process.pid, follows: true });
        if (registered) await next.request('serve.register', { ...registered, version: VERSION });
        log(`core replaced (pid ${(await next.request('core.auth', {})).pid}) — reconnected`);
      } catch (e) { log(`core replaced but reconnecting failed: ${(e as Error).message}`); shutdown(); }
    });
  };
  hook(control);
  if (owner) await control.request('core.own', { pid: process.pid, takeover: opts.attach?.takeover, follows: true }).catch((e) => { control.close(); throw e; });
  if (opts.attach) {
    // 기록은 받지 않는다 — since 를 끝으로 (CLI 는 id 만 쓰지만 핸들 꼴을 맞춘다)
    session = (await control.request('session.attach', { id: sid, since: Number.MAX_SAFE_INTEGER })).info;
    await control.request('session.detach', { id: sid });
  }

  // ---- 화면 설정 (ticket slcode-web-settings) — settings.get·set 은 core 로 넘기지 않고 여기서 답한다 (설정은 세션이 아니라 입구의 것).
  // 묶음은 연결이 들어온 입구가 정한다: TCP 웹은 web, 서비스 웹·stdio 는 superlite (사용자 결정 2026-10-16 — 두 벌은 완전히 따로).
  // 파일이 바뀌면(어느 serve 가 썼든) 그 입구의 인증된 화면 연결 모두에 settings.changed. 쓴 serve 도 자기 감시로 알린다 — 길이 하나
  const screens: Record<SettingsKind, Set<(line: string) => void>> = { web: new Set(), superlite: new Set() };
  // ---- serve 교체 (ticket slcode-core-serve-split 2단계, 사용자 2026-10-19). update 는 [업데이트] 가 찾은 새 버전 — 화면을 다시 열어도 남는다
  let update: UpdateCheck | null = null;
  function checkUpdate(): UpdateCheck {
    const d = diskBuild();
    if (d.version === VERSION && d.build === BUILD) return { status: 'latest' };
    return (update = { status: 'restart-required', version: d.version, build: d.build });
  }
  /** ServeMethods 면 답하고 true — 메서드 이름이 들어 있을 때만 해석한다 */
  function serveCall(line: string, send: (line: string) => void, kind: SettingsKind): boolean {
    if (![...SERVE_METHODS].some((n) => line.includes(`"${n}"`))) return false;
    let m: { id?: unknown; method?: unknown; params?: { settings?: SettingsPatch } };
    try { m = JSON.parse(line); } catch { return false; }
    if (typeof m?.method !== 'string' || !SERVE_METHODS.has(m.method)) return false;
    const answer = async () => {
      switch (m.method) {
        case 'settings.get': return readSettings(P.dir, kind);
        case 'settings.set': return writeSettings(P.dir, kind, m.params?.settings);
        case 'serve.info': return { version: VERSION, build: BUILD, pid: process.pid, update, inspectBlocked: inspectBlocked(path.join(P.dir, FILES.inspectBlocked)) };
        case 'update.run':
          if (kind !== 'web') throw new CoreError(ERR.badRequest, 'update.run is for the web entry — a card asks the plugin');
          return checkUpdate();
        case 'web.files': return webFiles(web, P.dir, kind);
        case 'file.get': return fileGet((m.params as { path?: unknown } | undefined)?.path);
        case 'serve.restart':
          if (!opts.onRestart) throw new CoreError(ERR.badRequest, 'this serve cannot restart itself');
          await opts.onRestart();
          return { ok: true };
      }
    };
    answer().then((result) => send(JSON.stringify({ id: m.id, result })), (e) => send(JSON.stringify({ id: m.id, error: { code: (e as CoreError).code, message: (e as Error).message } })));
    return true;
  }

  // ---- 중계: 화면 연결 하나 ↔ 세션 소켓 연결 하나
  const relays = new Set<net.Socket>();
  /** gate 면 core.auth 가 통과할 때까지 다른 요청을 막고 core 의 프레임을 넘기지 않는다. 그 사이 온 요청은 줄 세워 두었다가(HELD_MAX 까지) 통과하면 보낸다.
   *  제어 메서드(CONTROL_ONLY)는 화면 연결에서 늘 거절한다. kind 는 이 연결이 들어온 입구 — 화면 설정의 묶음 */
  function relay(send: (line: string) => void, end: () => void, gate: boolean, kind: SettingsKind, fix?: (line: string) => string) {
    let s!: net.Socket;
    let authed = !gate, authId: unknown, held: string[] = [], buf = '';
    if (authed) screens[kind].add(send);
    // ---- core 교체를 넘어 다시 붙기 (ticket slcode-core-serve-split 3단계) — 화면은 core 가 바뀐 것을 모른다
    let authLine: string | null = null; // 게이트를 통과한 core.auth (remote 를 붙인 것) — 새 core 에 다시
    let attached: string | null = null; // 화면이 붙은 세션
    let lastSeq = 0; // 화면에 넘긴 마지막 seq
    const asked = new Map<string, string>(); // 답을 받지 못한 요청 — id(프레임 앞머리 그대로) → 줄
    const attaches = new Set<string>(); // 그중 session.attach — 응답에서 마지막 seq 를 읽는다
    const internal = new Map<string, (line: string) => void>(); // 다시 붙을 때 serve 가 보낸 요청
    let paused: string[] | null = null; // core.replaced 뒤 새 core 에 붙을 때까지 줄 세운 화면 요청
    let gone = false; // 화면이 닫았다
    const toCore = (line: string) => {
      const k = idOf(line);
      if (k !== null) {
        asked.set(k, line);
        if (line.includes('"session.attach"') || line.includes('"session.detach"')) try {
          const m = JSON.parse(line);
          if (m.method === 'session.attach') { attached = m.params?.id ?? null; attaches.add(k); } else if (m.method === 'session.detach') attached = null;
        } catch {}
      }
      s.write(line + '\n');
    };
    const forward = (line: string) => { if (serveCall(line, send, kind)) return; if (paused) paused.push(line); else toCore(line); };
    const open = (next: net.Socket) => {
      s = next; buf = '';
      relays.add(s);
      s.setEncoding('utf8');
      s.on('data', (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          if (l.startsWith('{"event":"core.replaced"')) { paused ??= []; continue; }
          const k = idOf(l);
          if (k !== null && internal.has(k)) { internal.get(k)!(l); internal.delete(k); continue; }
          if (!authed) {
            let m: { id?: unknown; result?: unknown };
            try { m = JSON.parse(l); } catch { continue; }
            if (authId === undefined || m.id !== authId) continue;
            authId = undefined; send(l);
            if (m.result) { authed = true; screens[kind].add(send); for (const h of held.splice(0)) forward(h); }
            else { authLine = null; for (const h of held.splice(0)) deny(h); }
            continue;
          }
          if (k !== null) {
            const req = asked.get(k);
            asked.delete(k);
            // 내려가기로 정한 core 가 거절했다 — 새 core 에 다시 보낸다
            if (req && l.includes(`"code":"${ERR.retiring}"`)) { (paused ??= []).push(req); continue; }
            if (attaches.delete(k)) try { lastSeq = Math.max(lastSeq, JSON.parse(l).result?.history?.at(-1)?.seq ?? 0); } catch {}
          } else if (l.startsWith('{"event":"session.event"')) { const m = /"seq":(\d+)/.exec(l); if (m) lastSeq = Math.max(lastSeq, Number(m[1])); }
          send(fix ? fix(l) : l);
        }
      });
      s.on('close', () => {
        relays.delete(next);
        if (paused && !gone && !down) { void reopen(); return; }
        screens[kind].delete(send); end();
      });
      s.on('error', () => {});
    };
    /** serve 가 새 core 에 보내는 요청 — 응답 줄 (10초 안에 없으면 null) */
    let seq = 0;
    const call = (method: string, params: unknown, frame?: Record<string, unknown>) => new Promise<string | null>((resolve) => {
      const id = `slcode-relay-${++seq}`;
      const t = setTimeout(() => { internal.delete(JSON.stringify(id)); resolve(null); }, 10000);
      internal.set(JSON.stringify(id), (l) => { clearTimeout(t); resolve(l); });
      s.write(JSON.stringify({ id, method, params, ...frame }) + '\n');
    });
    const ok = (l: string | null) => { try { return !!l && !!JSON.parse(l).result; } catch { return false; } };
    async function reopen() {
      const stop = () => { screens[kind].delete(send); end(); };
      let next: net.Socket;
      try { next = await connectSock(sock); } catch { stop(); return; }
      if (gone || down) { next.destroy(); return; }
      open(next);
      if (authLine) { const m = JSON.parse(authLine); if (!ok(await call('core.auth', m.params))) { s.end(); stop(); return; } }
      if (attached) {
        const r = await call('session.attach', { id: attached, since: lastSeq });
        let res: { info?: unknown; history?: { seq: number }[] } | undefined;
        try { res = r ? JSON.parse(r).result : undefined; } catch {}
        if (!res) { s.end(); stop(); return; }
        // 끊긴 동안의 기록은 실시간 이벤트처럼 — 화면은 attach 를 다시 부르지 않았다
        for (const e of res.history ?? []) { lastSeq = Math.max(lastSeq, e.seq); send(JSON.stringify({ event: 'session.event', params: { id: attached, ...e } })); }
        send(JSON.stringify({ event: 'session.changed', params: res.info }));
      }
      const again = [...asked.values(), ...(paused ?? [])];
      asked.clear(); paused = null;
      for (const l of again) toCore(l);
    }
    open(net.createConnection(sock));
    const refuse = (line: string, code: string, message: string) => { try { const m = JSON.parse(line); if (m?.id !== undefined) send(JSON.stringify({ id: m.id, error: { code, message } })); } catch {} };
    const deny = (line: string) => refuse(line, ERR.unauthorized, 'core.auth first');
    /** 제어 메서드인가 — 메서드 이름이 들어 있을 때만 해석한다 (첨부가 실린 큰 프레임을 매번 읽지 않게) */
    const isControl = (line: string) => { if (!line.includes('"core.own"') && !line.includes('"serve.register"') && !line.includes('"core.retire"')) return false; try { return CONTROL_ONLY.has(JSON.parse(line)?.method); } catch { return false; } };
    return {
      write(line: string) {
        if (isControl(line)) { refuse(line, ERR.badRequest, 'not allowed on a screen connection'); return; }
        if (authed) { forward(line); return; }
        let m: { id?: unknown; method?: unknown; params?: Record<string, unknown> };
        try { m = JSON.parse(line); } catch { return; }
        if (authId !== undefined) { if (held.length < HELD_MAX) held.push(line); else deny(line); return; }
        if (m?.method !== 'core.auth' || (typeof m.id !== 'number' && typeof m.id !== 'string')) { deny(line); return; }
        authId = m.id;
        authLine = JSON.stringify({ ...m, params: { ...m.params, remote: true } });
        s.write(authLine + '\n');
      },
      close() { gone = true; s.end(); },
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
  const fail = async (e: unknown): Promise<never> => { if (spawned) await control.request('session.close', { id: sid }).catch(() => {}); control.close(); for (const f of stopAll) f(); throw e; };
  // superlite 서비스 웹 (ticket plugin-service-web) — TCP 웹과 별개, 인증 없음 (UDS 와 같은 신뢰 경계)
  if (opts.webSock) {
    const svc = http.createServer((q, r) => { if (!fileHandler(q, r, null)) staticHandler(q, r, web, P.dir, 'superlite'); });
    const svcWss = wsOn(svc, false, 'superlite');
    stopAll.push(() => { for (const c of svcWss.clients) c.close(); svcWss.close(); svc.close(); });
    // attach 는 서비스 웹을 열지 못해도 stdio 중계는 계속한다 (옛 proxyStdio 와 같다)
    await listenAddr(svc, opts.webSock).catch(spawned ? fail : (e: Error) => log(`service web: ${e.message}`));
  }
  let url: string | null = opts.attach?.url ?? null;
  const host = opts.host ?? '127.0.0.1';
  if (opts.web !== false && !opts.attach) {
    const srv = http.createServer((q, r) => { if (!fileHandler(q, r, isLoopback(host) ? null : readOrCreateToken(P))) staticHandler(q, r, web, P.dir, 'web'); });
    const wss = wsOn(srv, !isLoopback(host), 'web');
    stopAll.push(() => { for (const c of wss.clients) c.close(); wss.close(); srv.close(); });
    const port = await new Promise<number>((resolve, reject) => { srv.once('error', reject); srv.listen(opts.port ?? 0, host, () => resolve((srv.address() as net.AddressInfo).port)); }).catch(fail);
    url = (await control.request('serve.register', { host, port, version: VERSION }).catch(fail)).url;
    registered = { host, port };
  }
  if (opts.feed) {
    // 진입 프로세스가 넘긴 연결 — listen 은 진입 프로세스가 한다. 이 serve 가 끝나면 받은 연결을 모두 끊어 화면이 다음 serve 로 다시 붙게 한다
    const fh = opts.feed.host;
    const srv = http.createServer((q, r) => { if (!fileHandler(q, r, isLoopback(fh) ? null : readOrCreateToken(P))) staticHandler(q, r, web, P.dir, 'web'); });
    const wss = wsOn(srv, !isLoopback(fh), 'web');
    const socks = new Set<net.Socket>();
    opts.feed.onConn((c) => { if (down) { c.destroy(); return; } socks.add(c); c.on('close', () => socks.delete(c)); srv.emit('connection', c); });
    stopAll.push(() => { for (const c of wss.clients) c.close(1012, 'serve restart'); wss.close(); for (const c of socks) c.end(); setTimeout(() => { for (const c of socks) c.destroy(); }, 200).unref(); });
    url = (await control.request('serve.register', { host: fh, port: opts.feed.port, version: VERSION }).catch(fail)).url;
    registered = { host: fh, port: opts.feed.port };
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
  // core 교체 — 이 serve 가 core 보다 새 코드면 교체를 청한다. 새 serve 는 사용자가 [restart required] 를 눌러야 생기므로 core 도 그 뒤에 드러나지 않게 따라온다.
  // 소유자이거나 웹 모드 serve 자식일 때만 (다른 브라우저가 붙은 attach 는 청하지 않는다). 옛 core 가 모르는 메서드면 그만 (ticket slcode-core-serve-split 3단계)
  if (owner || opts.feed) void (async () => {
    const si = await control.request('server.info');
    if (!si.build || si.build >= BUILD) return;
    await control.request('core.retire', { pkg: PKG });
    log(`asked core ${si.version} to be replaced by this build (${VERSION})`);
  })().catch((e) => log(`core replacement not started: ${(e as Error).message}`));
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
