// 세션이 살아 있는지·어느 세션을 이을지·웹 주소 — core·serve·cli 가 같이 쓴다. Agent SDK 를 싣지 않는 가벼운 모듈이라
// 중계만 하는 serve 가 벤더 어댑터까지 불러오지 않는다 (ticket slcode-core-serve-split).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventLog, type SessionMeta } from './eventLog.js';
import { PKG } from './client.js';
import { corePaths, ensureDir } from './paths.js';
import { CoreError, type SessionInfo } from './protocol.js';
import type { CoreOptions } from './core.js';

export const isLoopback = (host: string) => ['127.0.0.1', 'localhost', '::1'].includes(host);
/** 0.0.0.0 으로 열었으면 접속 가능한 주소로 바꾼다 — 첫 비내부 IPv4, 없으면 localhost. CLI 출력·--stdio hello·server.info 가 같은 값을 낸다 */
export function reachable(url: string): string {
  if (!url.includes('//0.0.0.0:')) return url;
  const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';
  return url.replace('//0.0.0.0:', `//${ip}:`);
}

/** 소켓 파일이 살아 있는 프로세스 것인지 — 붙어 보면 안다 (cli close --force 도 쓴다) */
export function sockAlive(p: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(p)) return resolve(false);
    const s = net.createConnection(p);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

/** 꺼진 시각 — closedAt, 없으면(옛 세션) updatedAt. 다시 띄운 뒤 비정상 종료해 closedAt 이 옛 값이면 더 늦은 updatedAt 이 맞다 */
export const closedTime = (m: SessionMeta) => Math.max(m.closedAt ?? 0, m.updatedAt ?? m.createdAt);
/** 그 cwd 의 꺼진 세션 — 꺼진 순서(최근 먼저). 소켓이 살아 있는 세션은 뺀다 (continue·id 없는 resume). 슬러그가 같은 다른 폴더(/a-b·/a/b)는 cwd 로 거른다 */
export async function closedSessions(sessionsDir: string, cwd: string): Promise<SessionMeta[]> {
  const out: SessionMeta[] = [];
  for (const m of EventLog.list(sessionsDir, cwd)) if (m.cwd === cwd && !(await sockAlive(new EventLog(sessionsDir, m).sockPath))) out.push(m);
  return out.sort((a, b) => closedTime(b) - closedTime(a));
}

/** core 의 준비 줄 — pid·version 은 3단계부터 (옛 core 엔 없다) */
export type CoreHello = { id: string; sock: string; session: SessionInfo; pid?: number; version?: string };

/** <pkg>/dist/coreMain.js(기본 이 설치)를 detached 로 띄우고 stdout 첫 줄(준비·실패)을 기다린다. 그 뒤 파이프를 놓아 core 가 이 프로세스와 따로 산다.
 *  serve 가 세션을 열 때, 내리는 core 가 새 core 를 띄울 때(pkg 는 core.retire 를 보낸 serve 의 설치 폴더) 같이 쓴다.
 *  setsid 라 serve 의 프로세스 그룹 밖이다 — 터미널 Ctrl-C·superlite 서비스 중지(그룹 SIGTERM)가 core 에 닿지 않는다 */
export function spawnCore(opts: CoreOptions & { dir: string }, pkg = PKG): Promise<CoreHello> {
  const P = corePaths(opts.dir);
  ensureDir(P.dir);
  const err = fs.openSync(P.coreLog, 'a');
  const child = spawn(process.execPath, [path.join(pkg, 'dist', 'coreMain.js'), JSON.stringify(opts)], { detached: true, stdio: ['ignore', 'pipe', err], windowsHide: true });
  fs.closeSync(err);
  return new Promise((resolve, reject) => {
    let buf = '', settled = false;
    const settle = (f: () => void) => { if (settled) return; settled = true; child.stdout!.destroy(); child.unref(); f(); };
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let m: Partial<CoreHello> & { error?: string; code?: string };
      try { m = JSON.parse(buf.slice(0, i)); } catch { m = { error: `bad core hello: ${buf.slice(0, i)}` }; }
      settle(() => (m.error ? reject(new CoreError(m.code ?? 'error', m.error)) : resolve(m as CoreHello)));
    });
    child.once('error', (e) => settle(() => reject(e)));
    // exit 가 아니라 close — stdout 이 다 읽힌 뒤라 core 가 낸 실패 사유({error})가 일반 문구에 묻히지 않는다
    child.once('close', (code) => settle(() => reject(new CoreError('core_exit', `core exited (${code}) before it was ready — see ${P.coreLog}`))));
  });
}
