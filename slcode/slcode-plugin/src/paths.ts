// 상태 폴더 기본 위치 (ticket slcode-plugin-split, 사용자 결정 2026-10-31) — slcode 와 같은 폴더를 함께 쓴다. 그 안의 agent-plugins/ 가 에이전트 플러그인의 상태다.
// $SLCODE_DIR 로 바꿀 수 있다(테스트·데모 격리). slcode 는 자기 --dir 을 넘긴다.
import path from 'node:path';
import os from 'node:os';

export function defaultStateDir(): string {
  return process.env.SLCODE_DIR || path.join(os.homedir(), '.local', 'state', 'slcode');
}
