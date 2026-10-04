// 파일 위치 — 한 머신·한 사용자에 디렉토리 하나. $SLCODE_DIR(옛 $AGENT_CORE_DIR 도 한 버전 폴백) 로 격리(테스트·데모)할 수 있다.
//   post.sock/lock/pid/log      우체국 (post.ts)
//   slcode.token                  웹을 루프백 밖으로 열 때의 토큰 (0600)
//   sessions/<cwd 슬러그>/<id>/  meta.json · events.jsonl · sock(세션 프로세스가 살아 있을 때만)
//   mail/<세션 id>/<우편 id>.json  보관 우편 (우체국이 쓴다)
// cwd 슬러그는 claude 규칙 — 경로의 영숫자·- 밖 글자를 - 로 (사용자 결정 2026-09-27: 평탄 구조 기각, 수천 세션 전제)
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { FILES } from './protocol.js';

export function coreDir(): string {
  // 2026-10-02 개명 agent-core → slcode. 옛 이름은 한 버전 동안 폴백: 환경 변수 AGENT_CORE_DIR, 기본 폴더는 새 폴더가 없고 옛 폴더가 있으면 옛 폴더를 그대로 쓴다 (세션 이주 없음)
  const fromEnv = process.env.SLCODE_DIR ?? process.env.AGENT_CORE_DIR;
  if (fromEnv) return fromEnv;
  const state = path.join(os.homedir(), '.local', 'state');
  const cur = path.join(state, 'slcode'), old = path.join(state, 'agent-core');
  return !fs.existsSync(cur) && fs.existsSync(old) ? old : cur;
}

export type CorePaths = { dir: string; postSock: string; postLock: string; postPid: string; postLog: string; token: string; sessionsDir: string; mailDir: string };

export function corePaths(dir = coreDir()): CorePaths {
  return {
    dir,
    postSock: path.join(dir, FILES.postSock),
    postLock: path.join(dir, FILES.postLock),
    postPid: path.join(dir, FILES.postPid),
    postLog: path.join(dir, FILES.postLog),
    token: path.join(dir, FILES.token),
    sessionsDir: path.join(dir, FILES.sessionsDir),
    mailDir: path.join(dir, FILES.mailDir),
  };
}

/** claude 와 같은 규칙: /a/b.c_d → -a-b-c-d */
export function cwdSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

/** 세션 폴더 sessions/<슬러그>/<id> */
export function sessionDir(sessionsDir: string, cwd: string, id: string): string {
  return path.join(sessionsDir, cwdSlug(cwd), id);
}

/** 디렉토리를 0700 으로 만든다 — 소켓·토큰이 같은 사용자에게만 보인다 */
export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** 토큰 파일을 읽고, 없으면 만든다 (0600). 브라우저 localStorage 의 토큰이 재기동 뒤에도 유효하도록 재사용한다 */
export function readOrCreateToken(p: CorePaths): string {
  try {
    const t = fs.readFileSync(p.token, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  ensureDir(p.dir);
  const t = randomBytes(24).toString('hex');
  fs.writeFileSync(p.token, t, { mode: 0o600 });
  return t;
}
