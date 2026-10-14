// 세션이 살아 있는지·어느 세션을 이을지·웹 주소 — core·serve·cli 가 같이 쓴다. Agent SDK 를 싣지 않는 가벼운 모듈이라
// 중계만 하는 serve 가 벤더 어댑터까지 불러오지 않는다 (ticket slcode-core-serve-split).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { EventLog, type SessionMeta } from './eventLog.js';

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
