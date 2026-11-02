// `slcode/api` 의 구현 (ticket slcode-agent-plugin-script-portable) — 훅 스크립트가 `import { slcode } from 'slcode/api'` 로 쓰는 모듈. 빌드가 esbuild alias 로 스크립트마다 이 파일을 함께 묶는다.
// 등록만 받는다: slcode.on() 은 스크립트를 싣는 쪽(hookWorker — slcode core 안의 worker, export 한 Claude·Codex 의 세션 중간 프로세스 안의 worker, 빌드의 목록 모드)이
// globalThis 에 둔 수집기에 넣고, slcode.run() 은 등록이 끝났다는 신호다. 콜백은 언제나 그 worker 가 부른다 — 하네스별 입출력 변환은 hookBroker 가 한다.
// 묶인 사본마다 따로 평가되므로 slcode 의 다른 모듈을 import 하지 않는다. 수집기는 이 모듈이 평가될 때(스크립트를 싣는 중) 한 번 잡는다.
// slcode.vars 는 싣는 쪽이 수집기에 넣은 값(지금은 harness 하나, 사용자 결정 2026-10-31) — 묶은 파일 하나를 하네스들이 같이 쓰므로 묶을 때가 아니라 실을 때 정한다. 얼려서 읽기 전용.
export const COLLECT = Symbol.for('slcode.hooks.collect');
// slcode.command() 은 COMMAND 파일의 명령 하나(ticket slcode-agent-plugin-command) — 같은 수집기에 넣고, 꼴 검사는 싣는 쪽(hookWorker.checkCommand)이 한다.
type Collect = { on(event: unknown, a: unknown, b?: unknown): void; run(): void; command(def: unknown): void; vars: Record<string, unknown> };
const collect = (globalThis as Record<symbol, Collect | undefined>)[COLLECT];

export const slcode = {
  vars: Object.freeze({ ...collect?.vars }),
  on(event: unknown, a: unknown, b?: unknown): void {
    if (!collect) throw new Error('slcode/api: this script runs only through slcode (agent plugin hooks)');
    collect.on(event, a, b);
  },
  run(): void { collect?.run(); },
  command(def: unknown): void {
    if (!collect) throw new Error('slcode/api: this script runs only through slcode (agent plugin commands)');
    collect.command(def);
  },
};
