// 기동 잠금 — startup.lock 을 O_EXCL 로 만들어 한 core 만 산다 (Codex app-server-startup.lock 선례).
// 내용은 pid. 파일이 있고 그 pid 가 살아 있으면 잠시 기다린다: 종료 중인 core 가 lock 을 곧 지우는 틈
// (background-service 검증에서 발견된 경쟁 — 죽어 가는 core 에 붙은 클라이언트가 새 core 를 띄우는데,
// 옛 core 가 lock 을 아직 쥐고 있으면 새 core 가 바로 죽어 클라이언트가 timeout 까지 기다렸다).
import fs from 'node:fs';

export function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LockResult = { ok: true } | { ok: false; holder: number };

/**
 * 잠금을 쥔다. 살아 있는 소유자가 있으면 waitMs 동안 100ms 간격으로 다시 본다 (종료 중 틈).
 * 죽은 소유자의 잠금은 스테일로 보고 지운다.
 */
export async function acquireLock(lockPath: string, pid = process.pid, waitMs = 3000): Promise<LockResult> {
  const deadline = Date.now() + waitMs;
  let holder = 0;
  for (;;) {
    try { fs.writeFileSync(lockPath, String(pid), { flag: 'wx', mode: 0o600 }); return { ok: true }; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    holder = readPid(lockPath);
    if (holder && holder !== pid && pidAlive(holder)) {
      if (Date.now() >= deadline) return { ok: false, holder };
      await sleep(100);
      continue;
    }
    // 스테일 (소유자 죽음, 빈 파일) — 지우고 다시
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

export function readPid(p: string): number {
  try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; }
}

/** 소유자만 지운다 — 다른 core 가 이미 새 잠금을 만들었을 수 있다 */
export function releaseLock(lockPath: string, pid = process.pid) {
  if (readPid(lockPath) === pid) { try { fs.unlinkSync(lockPath); } catch {} }
}
