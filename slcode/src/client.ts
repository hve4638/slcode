// JSON 줄 RPC 클라이언트 — 세션 소켓(sessions/<슬러그>/<id>/sock)과 우체국(post.sock)에 같은 꼴로 붙는다.
// 우체국은 없으면 detached 로 띄운다 (tmux 의 "클라이언트가 서버를 불러온다"). 세션 소켓은 띄우지 않는다 — 세션은 `slcode` 명령이 본체다.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { corePaths, ensureDir } from './paths.js';
import { CoreError, isEvent, type EventFrame, type Methods, type PostMethods, type ResponseFrame } from './protocol.js';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tryConnect(p: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(p);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** 타입 있는 JSON 줄 RPC — 요청 id 매칭 + 이벤트 구독. M 은 Methods(세션) 또는 PostMethods(우체국) */
export class RpcClient<M extends Record<string, { params: unknown; result: unknown }> = Methods> {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Set<(m: EventFrame) => void>();
  closed = false;
  readonly done: Promise<void>;

  constructor(readonly sock: net.Socket) {
    let buf = '';
    this.done = new Promise((resolveDone) => {
      sock.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) this.onLine(l); } });
      sock.on('close', () => {
        this.closed = true;
        for (const p of this.pending.values()) p.reject(new CoreError('closed', 'connection closed'));
        this.pending.clear();
        for (const h of this.handlers) h({ event: 'disconnected', params: {} });
        resolveDone();
      });
      sock.on('error', () => {});
    });
  }

  private onLine(l: string) {
    let m: ResponseFrame | EventFrame;
    try { m = JSON.parse(l); } catch { return; }
    if ('id' in m && typeof m.id === 'number' && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!; this.pending.delete(m.id);
      m.error ? p.reject(new CoreError(m.error.code ?? 'error', m.error.message)) : p.resolve(m.result);
    } else if (isEvent(m)) for (const h of this.handlers) h(m);
  }

  request<K extends keyof M & string>(method: K, params?: M[K]['params']): Promise<M[K]['result']> {
    if (this.closed) return Promise.reject(new CoreError('closed', 'connection closed'));
    const id = this.nextId++;
    this.sock.write(JSON.stringify({ id, method, params }) + '\n');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  onEvent(h: (m: EventFrame) => void): () => void { this.handlers.add(h); return () => this.handlers.delete(h); }
  close() { this.sock.end(); }
}

/** 세션 소켓에 붙는다 — 없으면 no_session (세션 프로세스가 떠 있지 않다) */
export async function connectSession(sockPath: string): Promise<RpcClient<Methods>> {
  let sock: net.Socket;
  try { sock = await tryConnect(sockPath); } catch { throw new CoreError('no_session', `no live session at ${sockPath}`); }
  return new RpcClient<Methods>(sock);
}

/** 우체국을 detached 로 띄운다 — stdio 는 post.log, CLAUDE_* 는 물려주지 않는다 */
export function spawnPost(dir: string): number | undefined {
  const p = corePaths(dir);
  ensureDir(p.dir);
  const out = fs.openSync(p.postLog, 'a');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
  env.SLCODE_DIR = p.dir;
  const child = spawn(process.execPath, [path.join(PKG, 'dist', 'post.js')], { detached: true, stdio: ['ignore', out, out], env, cwd: PKG });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

export type PostConnectOptions = { dir?: string; timeoutMs?: number; autoStart?: boolean };

/**
 * 우체국에 붙거나 띄운다. 종료 경쟁: 붙었는데 곧 끊기면(종료 중인 우체국) 잠시 뒤 다시 — lock 이 풀리면 새 우체국이 뜬다
 */
export async function connectPost(opts: PostConnectOptions = {}): Promise<{ client: RpcClient<PostMethods>; spawned: boolean; pid?: number }> {
  const p = corePaths(opts.dir);
  const timeoutMs = opts.timeoutMs ?? 15000;
  const autoStart = opts.autoStart ?? true;
  const t0 = Date.now();
  let spawned = false, pid: number | undefined;
  while (Date.now() - t0 < timeoutMs) {
    let sock: net.Socket | null = null;
    try { sock = await tryConnect(p.postSock); } catch {}
    if (sock) {
      const client = new RpcClient<PostMethods>(sock);
      try { await client.request('post.info'); return { client, spawned, pid }; }
      catch { client.close(); await sleep(150); continue; } // 종료 중 — 다시
    }
    if (!autoStart) throw new CoreError('no_post', `no post office at ${p.postSock}`);
    if (!spawned) { pid = spawnPost(p.dir); spawned = true; }
    await sleep(100);
  }
  throw new CoreError('timeout', `post office did not come up within ${timeoutMs}ms (dir ${p.dir})`);
}
