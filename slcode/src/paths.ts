// 파일 위치 — 한 머신·한 사용자에 디렉토리 하나. $SLCODE_DIR(옛 $AGENT_CORE_DIR 도 한 버전 폴백) 로 격리(테스트·데모)할 수 있다.
//   core.log                      core 프로세스들의 stderr (serve 가 detached 로 띄울 때 잇는다)
//   slcode.token                  웹을 루프백 밖으로 열 때의 토큰 (0600)
//   sessions/<cwd 슬러그>/<id>/  meta.json · events.jsonl · sock(core 가 살아 있을 때만)
// cwd 슬러그는 claude 규칙 — 경로의 영숫자·- 밖 글자를 - 로 (사용자 결정 2026-09-27: 평탄 구조 기각, 수천 세션 전제)
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { FILES } from './protocol.js';

const defaultDir = (name: 'slcode' | 'agent-core') => path.join(os.homedir(), '.local', 'state', name);

export function coreDir(): string {
  // 2026-10-02 개명 agent-core → slcode. 옛 이름은 한 버전 동안 폴백: 환경 변수 AGENT_CORE_DIR
  const fromEnv = process.env.SLCODE_DIR ?? process.env.AGENT_CORE_DIR;
  return fromEnv || defaultDir('slcode');
}

// 옛 상태 폴더 호환 (ticket slcode-update-no-session-old-dir, 사용자 결정 2026-11-04). 1.0.0 에서 지운다 (ticket slcode-remove-legacy-state-dir).
// 개명 전 세션은 ~/.local/state/agent-core 에 그대로 두고 함께 찾는다. 새 세션과 그 밖의 상태(프로필·플러그인·core.log·쓰는 설정)는 새 폴더다.
// 지정한 폴더(--dir·$SLCODE_DIR)는 그 폴더만 본다 — 격리한 시험이 사용자의 세션을 찾아가면 안 된다.

/** 세션을 찾을 sessions 폴더들 — 먼저 나온 쪽이 이긴다 */
export function sessionRoots(sessionsDir: string): string[] {
  return path.resolve(sessionsDir) === path.join(defaultDir('slcode'), FILES.sessionsDir) ? [sessionsDir, path.join(defaultDir('agent-core'), FILES.sessionsDir)] : [sessionsDir];
}

/** 읽을 상태 파일 — 기본 폴더에 없고 옛 폴더에 있으면 옛 폴더의 것. 쓰기는 늘 dir 에 */
export function stateFile(dir: string, name: string): string {
  const file = path.join(dir, name), old = path.join(defaultDir('agent-core'), name);
  return path.resolve(dir) === defaultDir('slcode') && !fs.existsSync(file) && fs.existsSync(old) ? old : file;
}

export type CorePaths = { dir: string; coreLog: string; token: string; sessionsDir: string };

export function corePaths(dir = coreDir()): CorePaths {
  // 옛 core 는 자기를 교체할 때 옛 폴더를 dir 로 넘긴다 — 교체된 세션도 새로 연 세션과 같은 프로필·플러그인을 쓴다 (옛 폴더 호환, 1.0.0 에서 지운다: ticket slcode-remove-legacy-state-dir)
  if (path.resolve(dir) === defaultDir('agent-core')) dir = defaultDir('slcode');
  return {
    dir,
    coreLog: path.join(dir, FILES.coreLog),
    token: path.join(dir, FILES.token),
    sessionsDir: path.join(dir, FILES.sessionsDir),
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
    const t = fs.readFileSync(stateFile(p.dir, FILES.token), 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  ensureDir(p.dir);
  const t = randomBytes(24).toString('hex');
  fs.writeFileSync(p.token, t, { mode: 0o600 });
  return t;
}
