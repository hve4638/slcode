// 웹 모드 진입 프로세스 — 터미널에서 친 `slcode new·resume·continue` (ticket slcode-core-serve-split 2단계, 설계 ws docs/report/slcode-core-serve-split.md "serve 교체").
// core 를 detached 로 띄우고 그 소유자가 된다. TCP 포트는 이 프로세스가 끝까지 쥐고, 들어온 연결을 지금의 serve 자식(serveMain.ts)에 IPC 로 넘긴다.
// listen 핸들을 넘기지 않는 것은 핸들을 쥔 이 프로세스도 연결을 받아 버리기 때문이다 — 연결을 넘기면 포트가 비는 순간도, 받을 쪽이 둘인 순간도 없다.
// serve 교체: 화면의 serve.restart → serve 자식이 IPC 로 알린다 → 같은 설치 폴더의 dist/serveMain.js(디스크의 새 코드)로 새 자식을 띄우고, 준비되면
// 새 연결을 그쪽으로 돌린 뒤 옛 자식을 내린다. 옛 자식이 화면 연결을 끊으면 화면은 다시 붙어 새 serve 를 만난다. 새 자식이 못 뜨면 옛 자식이 그대로 일한다.
// serve 자식이 교체 중이 아닐 때 죽으면 한 번 다시 띄운다. 다시 띄운 것도 1분 안에 죽으면 세션을 닫는다 (사용자 2026-10-19).
// 이 프로세스는 교체되지 않는다 — serve 자식과의 IPC(serveMain.ts 머리말)는 늘리기만 한다.
// core 교체(3단계)는 새 코드의 serve 자식이 청한다. 이 프로세스는 core.replaced 를 받으면 새 core 에 다시 붙어 소유권을 다시 잡는다.
import net from 'node:net';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { connectSession, PKG, type RpcClient } from './client.js';
import { spawnCore } from './live.js';
import { corePaths } from './paths.js';
import type { CoreOptions } from './core.js';
import type { SessionInfo } from './protocol.js';

export type EntryOptions = Omit<CoreOptions, 'log'> & { host?: string; port?: number; log?: (msg: string) => void };
export type EntryHandle = { url: string | null; sock: string; session: SessionInfo; close: (reason?: string) => Promise<void>; done: Promise<void> };

/** serve 자식이 준비를 알리기까지의 상한 */
const READY_MS = 15000;
/** 다시 띄운 serve 가 이 안에 또 죽으면 세션을 닫는다 */
const CRASH_WINDOW_MS = 60000;

type Serve = { child: ChildProcess; url: string | null };

export async function runEntry(opts: EntryOptions): Promise<EntryHandle> {
  const log = opts.log ?? (() => {});
  const dir = corePaths(opts.dir).dir;
  const host = opts.host ?? '127.0.0.1';
  const { id, sock, session } = await spawnCore({ dir, cwd: opts.cwd, resume: opts.resume, title: opts.title, raw: opts.raw, inspect: opts.inspect, permissionMode: opts.permissionMode, vendor: opts.vendor });
  let control = await connectSession(sock);
  const closeSession = async () => { await control.request('session.close', { id }).catch(() => {}); control.close(); };
  try { await control.request('core.own', { pid: process.pid, follows: true }); } catch (e) { control.close(); throw e; }

  // ---- 포트 — 연결은 읽지 않고(pauseOnConnect) 지금의 serve 에 넘긴다. serve 가 없는 틈(다시 띄우는 중)의 연결은 끊는다 — 화면이 다시 붙는다
  let cur: Serve | null = null;
  const tcp = net.createServer({ pauseOnConnect: true }, (s) => { if (cur?.child.connected) cur.child.send('conn', s); else s.destroy(); });
  let port: number;
  try {
    port = await new Promise<number>((resolve, reject) => { tcp.once('error', reject); tcp.listen(opts.port ?? 0, host, () => resolve((tcp.address() as net.AddressInfo).port)); });
  } catch (e) { await closeSession(); throw e; }

  function startServe(): Promise<Serve> {
    const child = fork(path.join(PKG, 'dist', 'serveMain.js'), [JSON.stringify({ dir, id, sock, host, port })], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [] });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill(); reject(new Error(`serve was not ready in ${READY_MS / 1000}s`)); }, READY_MS);
      const settle = (f: () => void) => { clearTimeout(t); child.off('message', first); child.off('exit', early); f(); };
      const first = (m: { type?: string; url?: string | null; reason?: string }) => {
        if (m?.type === 'ready') settle(() => { wire(child); resolve({ child, url: m.url ?? null }); });
        else if (m?.type === 'failed') settle(() => reject(new Error(m.reason ?? 'serve failed')));
      };
      const early = (code: number | null) => settle(() => reject(new Error(`serve exited (${code}) before it was ready`)));
      child.on('message', first);
      child.once('exit', early);
    });
  }
  let swapping = false, stopping = false, crashedAt = 0;
  function wire(child: ChildProcess) {
    child.on('message', (m: { type?: string }) => { if (m?.type === 'restart') void swap(child); });
    child.once('exit', (code, sig) => { if (cur?.child === child && !stopping) void crashed(code ?? sig); });
  }
  async function swap(from: ChildProcess) {
    const reply = (ok: boolean, reason?: string) => { if (from.connected) from.send({ type: 'restart-result', ok, reason }); };
    if (swapping) { reply(false, 'already restarting'); return; }
    swapping = true;
    try {
      const next = await startServe();
      const old = cur;
      cur = next;
      reply(true);
      if (old?.child.connected) old.child.send({ type: 'stop' });
      log(`serve replaced (pid ${old?.child.pid} → ${next.child.pid})`);
    } catch (e) { log(`serve restart failed: ${(e as Error).message}`); reply(false, (e as Error).message); }
    finally { swapping = false; }
  }
  async function crashed(why: unknown) {
    cur = null;
    if (Date.now() - crashedAt < CRASH_WINDOW_MS) { log(`serve died again (${why}) — closing the session`); void close('serve crashed'); return; }
    crashedAt = Date.now();
    log(`serve died (${why}) — starting a new one`);
    try { cur = await startServe(); } catch (e) { log(`serve restart failed: ${(e as Error).message}`); void close('serve crashed'); }
  }

  try { cur = await startServe(); }
  catch (e) { tcp.close(); await closeSession(); throw e; }

  // ---- 수명 — core 가 끝나면(세션 닫힘·벤더 종료·크래시) 포트를 닫는다. serve 자식은 core 연결이 끊겨 스스로 끝난다
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const shutdown = () => {
    stopping = true;
    tcp.close();
    resolveDone();
  };
  // core.replaced 뒤에 끊기면 새 core 에 다시 붙어 소유권을 다시 잡는다 (connectSession 이 교체 표시를 보고 기다린다). 못 붙으면 core 가 끝난 것과 같다
  const hook = (c: RpcClient) => {
    let replaced = false;
    c.onEvent((m) => { if (m.event === 'core.replaced') replaced = true; });
    void c.done.then(async () => {
      if (!replaced || stopping) { shutdown(); return; }
      try { const next = await connectSession(sock); control = next; hook(next); await next.request('core.own', { pid: process.pid, follows: true }); log('core replaced — reconnected'); }
      catch (e) { log(`core replaced but reconnecting failed: ${(e as Error).message}`); shutdown(); }
    });
  };
  hook(control);
  let closing: Promise<void> | null = null;
  const close = (reason = 'closed'): Promise<void> => (closing ??= (async () => {
    stopping = true;
    log(`closing: ${reason}`);
    if (!control.closed) {
      control.request('session.close', { id }).catch(() => {});
      let t: NodeJS.Timeout | undefined;
      await Promise.race([control.done, new Promise((r) => (t = setTimeout(r, 15000)))]);
      clearTimeout(t);
    }
    shutdown();
  })());
  return { url: cur.url, sock, session, close, done };
}
