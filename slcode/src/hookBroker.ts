// export 한 Claude·Codex 의 js/ts 훅 (ticket slcode-agent-plugin-script-portable, 착수 결정 TICKET.md 2026-10-30) — 훅 명령과 세션 중간 프로세스.
// 훅 명령 `<node> hookMain.js <claude|codex> <플러그인 폴더> <이벤트>`(`slcode hook …` 도 같다): stdin 의 훅 입력을 그 세션의 중간 프로세스에 넘기고, 받은 하네스 훅 JSON 을 stdout 에 쓴다.
//   중간 프로세스가 없으면 띄운다 — 동시에 둘이 띄우면 소켓을 먼저 잡은 하나만 남는다. 못 띄우거나 닿지 않으면 그 이벤트만 이 프로세스 안에서 직접 돌리고 경고한다
//   (그때는 다른 훅과 상태 수정이 겹칠 수 있다).
// 중간 프로세스: 세션(하네스·session_id·slcode 설치)마다 하나. 플러그인 폴더마다 HookRunner 하나 — 콜백은 slcode 세션과 같은 worker 에서 돌고 모듈 변수·상태가 세션 동안 남는다.
//   상태 파일: 플러그인 데이터 폴더(Claude CLAUDE_PLUGIN_DATA, Codex PLUGIN_DATA)의 .slcode/state/<session_id>.json — 플러그인 폴더(ROOT)에는 쓰지 않는다.
//   fork 하면 session_id 가 바뀌어 상태가 새로 시작한다(한계 — 원래 세션을 확실히 찾을 수 없다, 실측 2026-10-30).
//   끝: SessionEnd 를 받고 잠시 뒤(같은 세션의 다른 플러그인 SessionEnd 도 받는다), 또는 30분 동안 요청이 없으면.
// 출력: HookRunner 의 Claude 훅 JSON 을 하네스 꼴로 — Codex 가 받지 않는 것(PreToolUse 의 ask·stop, SubagentStart 의 stop)은 빼고 알린다.
//   콜백의 실패·경고와 이 알림은 systemMessage 로 보인다(slcode 화면의 빨간 줄 자리).
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { HOOK_EVENTS, type HookEvent } from './hookApi.js';
import { HookRunner, type Notes } from './hookRunner.js';
import { BUILD_FILES } from './agentBuild.js';
import type { AgentHookEvent } from './protocol.js';

export type Harness = 'claude' | 'codex';
export const HARNESSES: readonly Harness[] = ['claude', 'codex'];
/** export 한 플러그인 폴더 안에서 묶은 스크립트가 있는 곳 — scripts.json·scripts/<n>.mjs (세션 빌드 폴더의 것을 그대로 옮긴다) */
export const EXPORT_SCRIPTS_DIR = 'slcode-hooks';
/** 데이터 폴더 안에서 slcode 가 쓰는 곳 — 플러그인 개발자의 다른 코드와 겹치지 않게 */
export const DATA_SUBDIR = '.slcode';
const IDLE_MS = 30 * 60_000;
/** SessionEnd 뒤 같은 세션의 다른 플러그인 SessionEnd 를 기다리는 시간 */
const END_GRACE_MS = 3000;
/** 중간 프로세스를 띄운 뒤 소켓이 열리기를 기다리는 시간 */
const SPAWN_WAIT_MS = 5000;
/** Codex 는 apply_patch 를 Edit·Write 로, spawn_agent 를 Agent 로도 맞춘다 (Codex hooks 문서) */
export const CODEX_ALIASES: Record<string, readonly string[]> = { apply_patch: ['Edit', 'Write'], spawn_agent: ['Agent'] };

/** 훅 명령 하나가 중간 프로세스에 보내는 요청 */
export type BrokerRequest = { v: 1; harness: Harness; root: string; data: string; event: HookEvent; input: Record<string, unknown> };
export type BrokerReply = { stdout: string };

/** 그 세션의 중간 프로세스 소켓 — 같은 세션이라도 slcode 설치가 다르면 따로 */
export function brokerSocket(harness: Harness, sessionId: string, install: string): string {
  const h = createHash('sha256').update(`${harness}\n${sessionId}\n${install}\n${os.userInfo().username}`).digest('hex').slice(0, 20);
  if (process.platform === 'win32') return `\\\\.\\pipe\\slcode-hooks-${h}`;
  return path.join(os.tmpdir(), `slcode-hooks-${process.getuid?.() ?? 'u'}`, `${h}.sock`);
}

/** 플러그인 이름 — 하네스 manifest 의 name, 없으면 폴더 이름 */
function pluginName(root: string): string {
  for (const m of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
    try { const n = JSON.parse(fs.readFileSync(path.join(root, m), 'utf8')).name; if (typeof n === 'string' && n) return n; } catch {}
  }
  return path.basename(root);
}

/** Claude 훅 JSON → Codex 훅 JSON. Codex 가 받지 않는 칸은 빼고 그 사유를 warnings 에 */
export function toCodex(event: HookEvent, out: SyncHookJSONOutput): { out: SyncHookJSONOutput; warnings: string[] } {
  const o: SyncHookJSONOutput = { ...out }, warnings: string[] = [];
  const hso = o.hookSpecificOutput as Record<string, unknown> | undefined;
  if (event === 'PreToolUse') {
    if (o.continue === false) { delete o.continue; delete o.stopReason; warnings.push('Codex 는 PreToolUse 의 stop() 을 받지 않아 뺐습니다'); }
    if (hso?.permissionDecision === 'ask') {
      const { permissionDecision: _d, permissionDecisionReason: _r, ...rest } = hso;
      o.hookSpecificOutput = rest as SyncHookJSONOutput['hookSpecificOutput'];
      warnings.push('Codex 는 PreToolUse 의 ask() 를 받지 않아 뺐습니다 — 평소의 승인 절차를 따릅니다');
    }
    const h = o.hookSpecificOutput as Record<string, unknown> | undefined;
    if (h?.updatedInput && !h.permissionDecision) h.permissionDecision = 'allow'; // Codex 는 updatedInput 을 allow 와 함께만 받는다
    if (h && Object.keys(h).length === 1) delete o.hookSpecificOutput; // hookEventName 만 남았다
  }
  if (event === 'SubagentStart' && o.continue === false) { delete o.continue; delete o.stopReason; warnings.push('Codex 는 SubagentStart 의 stop() 으로 서브에이전트를 멈추지 않아 뺐습니다'); }
  return { out: o, warnings };
}

/** 플러그인 하나의 HookRunner — 빌드가 바뀌면(같은 폴더에 다시 쓴 scripts.json) 다시 싣는다 */
type Plugin = { runner: HookRunner; key: string; notes: Notes };

function pluginKey(root: string): string {
  const f = path.join(root, EXPORT_SCRIPTS_DIR, BUILD_FILES.scripts);
  try { const st = fs.statSync(f); return `${fs.realpathSync(root)}\n${st.mtimeMs}\n${st.size}`; } catch { return `${root}\n-`; }
}

function makePlugin(req: BrokerRequest, sessionId: string, log: (t: string) => void): Plugin {
  const name = pluginName(req.root);
  const notes: Notes = [];
  const emit = (ev: AgentHookEvent) => {
    if (ev.phase === 'warn') { notes.push(`${name}: ${ev.text}`); log(`${name}: ${ev.text}`); }
    else if (ev.phase === 'ready') { for (const e of ev.errors) { notes.push(`${name}: ${e}`); log(`${name}: ${e}`); } }
  };
  const runner = new HookRunner({
    sessionId, emit, harness: req.harness,
    stateFile: () => path.join(req.data, DATA_SUBDIR, 'state', `${sessionId}.json`),
    dirOf: () => path.join(req.root, EXPORT_SCRIPTS_DIR),
    ...(req.harness === 'codex' ? { aliases: CODEX_ALIASES } : {}),
  });
  const key = pluginKey(req.root);
  runner.load([{ name, build: key }]);
  return { runner, key, notes };
}

/** 이벤트 하나를 돌려 하네스 훅 JSON 문자열로 — 경고·실패는 systemMessage 에 잇는다 */
async function runOne(p: Plugin, req: BrokerRequest, extra: string[] = []): Promise<string> {
  const notes: Notes = [];
  let out = await p.runner.run(req.event, req.input, notes);
  notes.push(...p.notes.splice(0));
  if (req.harness === 'codex') { const c = toCodex(req.event, out); out = c.out; notes.push(...c.warnings); }
  const msg = [out.systemMessage, ...extra, ...notes.map((n) => `[slcode] ${n}`)].filter(Boolean).join('\n');
  if (msg) out.systemMessage = msg;
  return JSON.stringify(out);
}

/** 중간 프로세스 — sock 에서 요청을 받는다. 이미 다른 것이 그 소켓을 쥐고 있으면 곧바로 끝난다 */
export async function serveBroker(sock: string, opts: { log?: (t: string) => void; idleMs?: number } = {}): Promise<void> {
  const log = opts.log ?? (() => {});
  const plugins = new Map<string, Plugin>();
  let idle: NodeJS.Timeout | null = null, ending: NodeJS.Timeout | null = null, closed = false;
  let done!: () => void;
  const finished = new Promise<void>((r) => { done = r; });
  const shutdown = async (why: string) => {
    if (closed) return;
    closed = true;
    log(`shutdown: ${why}`);
    server.close();
    for (const p of plugins.values()) await p.runner.close();
    if (process.platform !== 'win32') { fs.rmSync(sock, { force: true }); fs.rmSync(`${sock}.log`, { force: true }); } // 정상 종료면 로그도 — 죽은 중간 프로세스의 로그만 남는다
    done();
  };
  const touch = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => void shutdown('idle'), opts.idleMs ?? IDLE_MS); idle.unref?.(); };

  async function handle(req: BrokerRequest): Promise<BrokerReply> {
    touch();
    const sessionId = String(req.input.session_id ?? '');
    let p = plugins.get(req.root);
    if (p && p.key !== pluginKey(req.root)) { p.runner.load([{ name: pluginName(req.root), build: (p.key = pluginKey(req.root)) }]); } // 다시 빌드했다 — worker 를 다시 띄운다(상태는 둔다)
    if (!p) { p = makePlugin(req, sessionId, log); plugins.set(req.root, p); }
    const stdout = await runOne(p, req);
    if (req.event === 'SessionEnd' && !ending) { ending = setTimeout(() => void shutdown('SessionEnd'), END_GRACE_MS); }
    return { stdout };
  }

  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let req: BrokerRequest;
      try { req = JSON.parse(buf.slice(0, i)); } catch { c.end(); return; }
      handle(req).then((r) => c.end(`${JSON.stringify(r)}\n`), (e) => { log(`request failed: ${(e as Error).stack ?? e}`); c.end(); });
    });
    c.on('error', () => {});
  });

  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
  const listen = () => new Promise<NodeJS.ErrnoException | null>((resolve) => {
    server.once('error', (e: NodeJS.ErrnoException) => resolve(e));
    server.listen(sock, () => resolve(null));
  });
  let err = await listen();
  if (err?.code === 'EADDRINUSE') {
    if (await reachable(sock)) { log('another broker owns the socket'); return; }
    fs.rmSync(sock, { force: true }); // 죽은 중간 프로세스가 남긴 소켓 파일
    err = await listen();
  }
  if (err) { log(`listen failed: ${err.message}`); return; }
  if (process.platform !== 'win32') { try { fs.chmodSync(sock, 0o600); } catch {} }
  touch();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(sig, () => void shutdown(sig));
  log(`listening ${sock}`);
  await finished;
}

const reachable = (sock: string) => new Promise<boolean>((resolve) => {
  const c = net.connect(sock);
  c.once('connect', () => { c.destroy(); resolve(true); });
  c.once('error', () => resolve(false));
});

/** 요청 하나 — 닿지 않으면 null (소켓 없음·거부). 닿은 뒤 끊기면 null */
function ask(sock: string, req: BrokerRequest): Promise<BrokerReply | null> {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    let buf = '', settled = false;
    const end = (r: BrokerReply | null) => { if (!settled) { settled = true; c.destroy(); resolve(r); } };
    c.once('connect', () => c.write(`${JSON.stringify(req)}\n`));
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { end(JSON.parse(buf.slice(0, i))); } catch { end(null); } } });
    c.once('error', () => end(null));
    c.once('close', () => end(null));
  });
}

/** 훅 명령 한 번 — stdout 에 쓸 문자열을 돌려준다. spawnBroker 는 중간 프로세스를 띄운다(cli 가 자기 자신을 detached 로) */
export async function hookCommand(harness: Harness, root: string, event: HookEvent, stdin: string, env: NodeJS.ProcessEnv, opts: { install: string; spawnBroker: (sock: string, cwd: string) => void }): Promise<string> {
  let input: Record<string, unknown>;
  try { input = JSON.parse(stdin || '{}'); } catch { return JSON.stringify({ systemMessage: `[slcode] ${event} 훅 입력이 JSON 이 아니라 건너뛰었습니다` }); }
  const sessionId = String(input.session_id ?? '');
  const given = env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA;
  const data = given || path.join(os.tmpdir(), `slcode-hooks-${process.getuid?.() ?? 'u'}`, 'data', pluginName(root)); // 하네스가 데이터 폴더를 주지 않았다(플러그인 밖에서 부름)
  const req: BrokerRequest = { v: 1, harness, root: path.resolve(root), data, event, input };
  const sock = brokerSocket(harness, sessionId, opts.install);
  let r = sessionId ? await ask(sock, req) : null; // session_id 가 없으면 세션을 가를 수 없다 — 직접 돈다
  if (!r && sessionId && event !== 'SessionEnd') { // SessionEnd 에 새로 띄우면 30분 동안 남는다 — 그때는 직접 돈다
    opts.spawnBroker(sock, typeof input.cwd === 'string' ? input.cwd : process.cwd());
    const until = Date.now() + SPAWN_WAIT_MS;
    while (!r && Date.now() < until) { await new Promise((res) => setTimeout(res, 50)); r = await ask(sock, req); }
  }
  if (r) return r.stdout;
  // 직접 돈다 — 상태는 파일에서 읽고 쓴다
  const p = makePlugin(req, sessionId, () => {});
  try { return await runOne(p, req, event === 'SessionEnd' ? [] : ['[slcode] 세션 중간 프로세스에 닿지 않아 이 훅을 따로 돌렸습니다 — 다른 훅과 상태 수정이 겹칠 수 있습니다']); }
  finally { await p.runner.close(); }
}

export function isHookEvent(e: string): e is HookEvent { return (HOOK_EVENTS as readonly string[]).includes(e); }
