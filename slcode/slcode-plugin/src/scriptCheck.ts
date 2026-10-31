// js/ts 훅의 하네스 호환 검사 (ticket slcode-agent-plugin-script-portable, 사용자 결정 2026-10-30) — tsc 로 스크립트를 하네스별 `slcode/api` 타입에 맞춰 본다.
// 하네스마다 이벤트에서 쓸 수 있는 메서드가 다르다(hookApi 의 METHODS·CODEX_METHODS). 쓸 수 없는 메서드·모르는 이벤트를 경고로 낸다 — 스크립트를 빼지 않는다(실행 중에는 무시·경고).
// typescript 는 slcode·slcode-plugin 에 넣지 않는다: 처음 검사할 때 npm 레지스트리에서 받아 slcode 데이터 폴더에 둔다(버전·무결성 고정, 개발자 기능이라). 받지 못하면 경고하고 검사를 건너뛴다.
// 진단은 훅 API 에 걸린 것만 낸다 — node 타입(@types/node)은 받지 않으므로 그 밖의 진단(node 내장 import 등)은 버린다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fetchTarball, placeDir, REGISTRY, untar } from './npmFetch.js';
import { CODEX_METHODS, HOOK_EVENTS, MATCHER_EVENTS, METHODS, type HookEvent, type Method } from './hookApi.js';

export type CheckHarness = 'claude' | 'codex';
const TABLES: Record<CheckHarness, Record<HookEvent, readonly Method[]>> = { claude: METHODS, codex: CODEX_METHODS };
// slcode 의 devDependencies 와 같은 판 — 무결성은 pnpm-lock.yaml 의 것
export const TS_VERSION = '5.9.3';
const TS_INTEGRITY = 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==';
const TS_URL = `${REGISTRY}/typescript/-/typescript-${TS_VERSION}.tgz`;

/** 하네스별 `slcode/api` 선언 — 이벤트별 칸과 메서드는 hookApi 와 같다. 메서드는 그 하네스 표에 있는 것만 */
export function apiDts(harness: CheckHarness): string {
  const t = TABLES[harness];
  const allowed = HOOK_EVENTS.map((e) => `    ${e}: ${t[e].map((m) => `'${m}'`).join(' | ') || 'never'};`).join('\n');
  return `// slcode 가 만든 파일 (${harness}) — 훅 스크립트 검사용
declare module 'slcode/api' {
  export type SlcodeHookEvent = ${HOOK_EVENTS.map((e) => `'${e}'`).join(' | ')};
  type Agent = { id: string; type: string | null };
  type Tool = { name: string; input: Record<string, any>; useId: string };
  type ExecOptions = { timeout?: number; cwd?: string; input?: string; env?: Record<string, string> };
  type ExecResult = { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean };
  type Base<E extends SlcodeHookEvent> = {
    event: E; session: { id: string; cwd: string; permissionMode: string | null }; agent: Agent | null;
    state: Record<string, any>; exec(cmd: string, args?: string[], opts?: ExecOptions): Promise<ExecResult>; raw: any;
  };
  interface Fields {
    SessionStart: { source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork' }; UserPromptSubmit: { prompt: string };
    PreToolUse: { tool: Tool }; PostToolUse: { tool: Tool & { response: any } }; Stop: {};
    SubagentStart: { agent: Agent }; SubagentStop: { agent: Agent }; PreCompact: { trigger: 'manual' | 'auto' }; SessionEnd: { reason: string };
  }
  interface Methods<H> {
    block(reason: string): H; ask(reason?: string): H; allow(reason?: string): H; updateInput(input: Record<string, any>): H;
    context(text: string): H; message(text: string): H; stop(reason?: string): H;
  }
  interface Allowed {
${allowed}
  }
  export type SlcodeHook<E extends SlcodeHookEvent> = Base<E> & Fields[E] & Pick<Methods<SlcodeHook<E>>, Allowed[E]>;
  interface SlcodeHookOptions { timeout?: number; failClosed?: boolean }
  interface SlcodeHookMatcherOptions extends SlcodeHookOptions { matcher?: string }
  type MatcherEvent = ${MATCHER_EVENTS.map((e) => `'${e}'`).join(' | ')};
  export type OnOptions<E extends SlcodeHookEvent> = E extends MatcherEvent ? SlcodeHookMatcherOptions : SlcodeHookOptions;
  export const slcode: {
    readonly vars: Readonly<{ harness: 'claude' | 'codex' }>;
    on<E extends SlcodeHookEvent>(event: E, callback: (hook: SlcodeHook<E>) => unknown): void;
    on<E extends SlcodeHookEvent>(event: E, opts: OnOptions<E>, callback: (hook: SlcodeHook<E>) => unknown): void;
    run(): void;
  };
}
`;
}

/** typescript 모듈 — 없으면 받는다. 실패면 사유를 던진다 */
export async function ensureTypescript(stateDir: string): Promise<any> {
  const dir = path.join(stateDir, 'typescript', TS_VERSION);
  const entry = path.join(dir, 'package', 'lib', 'typescript.js');
  if (!fs.existsSync(entry)) {
    const tar = await fetchTarball(TS_URL, TS_INTEGRITY);
    await placeDir(dir, async (tmp) => untar(tar, tmp));
    if (!fs.existsSync(entry)) throw new Error(`typescript ${TS_VERSION}: lib/typescript.js missing after download`);
  }
  return createRequire(entry)(entry);
}

/** 검사 결과 — 하네스별 경고 줄("<파일>:<줄>: <진단>"), 검사를 못 했으면 skipped 에 사유 */
export type CheckResult = { warnings: Partial<Record<CheckHarness, string[]>>; skipped: string | null };

/** files(절대 경로, part 의 스크립트 원본)를 하네스마다 검사한다. base 는 경고에 쓸 상대 경로의 기준 */
export async function checkScripts(files: string[], harnesses: CheckHarness[], stateDir: string, base: string): Promise<CheckResult> {
  if (!files.length) return { warnings: {}, skipped: null };
  let ts: any;
  try { ts = await ensureTypescript(stateDir); }
  catch (e) { return { warnings: {}, skipped: `could not get typescript ${TS_VERSION}: ${(e as Error).message}` }; }
  const out: CheckResult = { warnings: {}, skipped: null };
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-check-'));
  try {
    for (const h of harnesses) {
      const dts = path.join(tdir, `slcode-api-${h}.d.ts`);
      fs.writeFileSync(dts, apiDts(h));
      const program = ts.createProgram([dts, ...files], {
        noEmit: true, allowJs: true, checkJs: true, strict: false, skipLibCheck: true,
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ['lib.es2022.d.ts'], types: [],
      });
      const mine = new Set(files.map((f) => path.resolve(f)));
      out.warnings[h] = ts.getPreEmitDiagnostics(program)
        .filter((d: any) => d.file && mine.has(path.resolve(d.file.fileName)))
        .map((d: any) => ({ d, text: ts.flattenDiagnosticMessageText(d.messageText, ' ') as string }))
        .filter(({ text }: { text: string }) => /SlcodeHook|'slcode\/api'/.test(text))
        .map(({ d, text }: { d: any; text: string }) => `${path.relative(base, d.file.fileName).split(path.sep).join('/')}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}: ${text}`);
    }
  } finally { fs.rmSync(tdir, { recursive: true, force: true }); }
  return out;
}
