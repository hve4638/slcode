// core 프로세스 진입점 — serve 가 detached 로 띄운다: node dist/coreMain.js '<CoreOptions JSON>'.
// 준비되면 stdout 첫 줄로 {id, sock, session}, 실패면 {error, code} 를 내고 끝난다. 그 뒤로 stdout 은 쓰지 않는다 — 띄운 serve 가
// 첫 줄만 읽고 파이프를 닫는다. 로그는 stderr 이고, 띄운 쪽이 $SLCODE_DIR/core.log 로 잇는다.
import { runCore, type CoreHandle, type CoreOptions } from './core.js';

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
let tag = `core ${process.pid}`;
const log = (msg: string) => console.error(`${new Date().toISOString()} [${tag}] ${msg}`);
const opts = JSON.parse(process.argv[2] ?? '{}') as CoreOptions;
let h: CoreHandle;
try {
  h = await runCore({ ...opts, log });
} catch (e) {
  const err = e as Error & { code?: string };
  log(`start failed: ${err.message}`);
  process.stdout.write(JSON.stringify({ error: err.message, code: err.code ?? 'error' }) + '\n', () => process.exit(1));
  await new Promise(() => {});
}
tag = `core ${process.pid} ${h!.session.id}`;
process.stdout.write(JSON.stringify({ id: h!.session.id, sock: h!.sock, session: h!.session }) + '\n');
// detached 라 터미널 시그널은 오지 않는다. kill <pid> 로 직접 받으면 세션을 닫는다
const stop = () => void h.close('signal');
process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', () => {});
await h!.done;
process.exit(0);
