// 웹 모드 serve 프로세스 진입점 — 진입 프로세스(entry.ts)가 fork 로 띄운다: node dist/serveMain.js '<{dir, id, sock, host, port} JSON>'.
// listen 은 하지 않는다. 진입 프로세스가 쥔 포트로 들어온 연결을 IPC 로 받아('conn' + 소켓) 서빙하고, 떠 있는 core 에 소유자가 아닌 serve 로 붙는다.
// IPC (진입 프로세스와 이 파일 사이 — 진입 프로세스는 옛 코드로 남으므로 늘리기만 한다):
//   → 진입  {type:'ready', url} 준비됨 · {type:'failed', reason} 못 떴다 · {type:'restart'} 화면이 serve.restart 를 보냈다
//   ← 진입  'conn' + 소켓 · {type:'restart-result', ok, reason?} · {type:'stop'} 새 serve 로 넘어갔다 — 화면 연결을 끊고 끝난다
// 터미널 Ctrl-C·SIGHUP 은 진입 프로세스가 받아 세션을 닫는다 — 이 프로세스는 무시하고 core 가 끝나면 따라 끝난다. 진입 프로세스가 사라지면(IPC 끊김) 끝난다.
import type net from 'node:net';
import { serveSession, type ServeHandle } from './serve.js';

const opts = JSON.parse(process.argv[2] ?? '{}') as { dir?: string; id: string; sock: string; host: string; port: number };
const log = (msg: string) => console.error(`[slcode serve ${process.pid}] ${msg}`);
const send = (m: unknown) => { try { process.send?.(m); } catch {} };
process.on('SIGINT', () => {}); process.on('SIGHUP', () => {});
process.stderr.on('error', () => {});

let onConn: ((s: net.Socket) => void) | null = null;
let restarting: { resolve: () => void; reject: (e: Error) => void } | null = null;
let h: ServeHandle | null = null;
process.on('message', (m: { type?: string; ok?: boolean; reason?: string } | string, handle?: unknown) => {
  if (m === 'conn') { const s = handle as net.Socket | undefined; if (s) { if (onConn) onConn(s); else s.destroy(); } return; }
  if (typeof m !== 'object' || !m) return;
  if (m.type === 'restart-result') { const r = restarting; restarting = null; if (m.ok) r?.resolve(); else r?.reject(new Error(m.reason ?? 'restart failed')); }
  // restart-result 와 같은 틱에 올 수 있다 — serve.restart 응답이 화면에 먼저 나가게 한 박자 뒤에
  else if (m.type === 'stop') setImmediate(() => void h?.close('replaced by a new serve'));
});
process.on('disconnect', () => { if (h) void h.close('entry process gone'); else process.exit(1); });

try {
  h = await serveSession({
    dir: opts.dir, cwd: '', web: false, attach: { id: opts.id, sock: opts.sock, url: null }, log,
    feed: { host: opts.host, port: opts.port, onConn: (cb) => { onConn = cb; } },
    onRestart: () => new Promise<void>((resolve, reject) => {
      if (restarting) { reject(new Error('already restarting')); return; }
      restarting = { resolve, reject };
      send({ type: 'restart' });
    }),
  });
} catch (e) {
  send({ type: 'failed', reason: (e as Error).message });
  process.exit(1);
}
send({ type: 'ready', url: h!.url });
await h!.done;
// 닫는 프레임·serve.restart 응답이 화면에 나갈 틈
setTimeout(() => process.exit(0), 300);
