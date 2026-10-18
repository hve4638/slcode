// JSON 줄 RPC 클라이언트 — 세션 소켓(sessions/<슬러그>/<id>/sock)에 붙는다. 세션 소켓은 띄우지 않는다 — core 는 serve 가 띄운다 (serve.ts spawnCore).
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreError, isEvent, type EventFrame, type Methods, type ResponseFrame } from './protocol.js';

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
/** 지금 디스크에 있는 이 설치의 버전·빌드 — build 는 dist/cli.js 의 mtime(ms)이라 같은 버전을 다시 빌드해도 바뀐다.
 *  떠 있는 프로세스의 것(VERSION·BUILD)과 견줘 새 코드가 깔렸는지 안다 (업데이트 확인, ticket slcode-core-serve-split 2단계) */
export function diskBuild(): { version: string; build: number } {
  const version: string = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;
  let build = 0;
  try { build = Math.floor(fs.statSync(path.join(PKG, 'dist', 'cli.js')).mtimeMs); } catch {}
  return { version, build };
}
/** 이 프로세스가 뜰 때의 빌드 */
export const BUILD: number = diskBuild().build;

function tryConnect(p: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(p);
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** 타입 있는 JSON 줄 RPC — 요청 id 매칭 + 이벤트 구독. M 은 Methods */
export class RpcClient<M extends Record<string, { params: unknown; result: unknown }> = Methods> {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Set<(m: EventFrame) => void>();
  closed = false;
  readonly done: Promise<void>;

  constructor(readonly sock: net.Socket) {
    let buf = '';
    this.done = new Promise((resolveDone) => {
      sock.setEncoding('utf8'); // 청크 경계에 걸린 한글이 깨지지 않게 — 긴 기록(attach)·초안이 여러 청크로 온다
      sock.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) this.onLine(l); } });
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
