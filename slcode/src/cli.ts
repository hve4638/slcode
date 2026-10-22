#!/usr/bin/env node
// 단독 실행 진입점 — 동사 하나를 받아 한 번 부르고 끝난다. 인자 없는 slcode 는 도움말만 (ticket slcode-verbs, 사용자 확정 2026-10-02).
//   세션 수명  new [folder] | resume [<s>] | continue [folder] | import <벤더 세션 id> | export <s> | list [--all] | rename <s> <title> | close <s> | delete <s>
//   대화       prompt <s> <text> | interrupt <s>
//   조회       status <s> | pending <s> | last <s> [--turn N] | log <s> [--since N] [--tail N]      — 평문 기본, --json 이면 같은 내용을 JSON 으로
//   응답       respond <s> <req> allow|deny [--remember] | respond <s> <req> --answer <text> | respond <s> <req> --json '<updatedInput>'
//   메시지     mail <to> <text> [--from X] [--re <id>] | (세션 안) check | ask <to> <text> [--timeout S] | reply <id> <text>
// <s>·<to> 는 모든 동사에서 세션 id 또는 유일한 제목. 옛 동사(send·approve·shutdown·post·폴더 위치 인자)는 폐기, 폴백 별칭 없음.
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { connectSession, diskBuild, type RpcClient } from './client.js';
import { sendMail } from './mail.js';
import { EventLog } from './eventLog.js';
import { corePaths, readOrCreateToken } from './paths.js';
import { serveSession } from './serve.js';
import { readSettings } from './settings.js';
import { inspectBlocked } from './inspect.js';
import { runEntry } from './entry.js';
import { reachable, closedSessions, closedTime, sockAlive } from './live.js';
import { findVendorSession, forkClaude, vendorResumeCommand } from './vendor.js';
import { pullHistory } from './history.js';
import { randomUUID } from 'node:crypto';
import { FILES, type ApprovalRequest, type LoggedEvent, type Methods, type SessionInfo } from './protocol.js';

type Flags = { port?: string; host?: string; stdio?: boolean; vendor?: string; mode?: string; title?: string; model?: string; since?: string; tail?: string; turn?: string; dir?: string; raw?: boolean; 'no-inspect'?: boolean; all?: boolean; force?: boolean; json?: boolean; remember?: boolean; from?: string; re?: string; timeout?: string; answer?: string; 'no-web'?: boolean; web?: boolean; takeover?: boolean; version?: boolean; help?: boolean };

const HELP = `usage: slcode [옵션] | slcode <동사> ...   (<s>·<to> 는 세션 id 또는 유일한 제목. * 는 세션 안(SLCODE_SESSION_ID)에서만)

  slcode [--vendor --title --mode …]
                                 동사 없이 부르면 slcode new . — 첫 토큰이 옵션이면 전부 new 의 옵션. 폴더·세션 id 는 받지 않는다

세션 수명
  new·resume·continue 는 superlite 터미널 안이면 그 터미널의 deck 에 카드로 연다. superlite 밖이거나 --web 이면 세션(core)을
  띄우고 이 프로세스가 웹을 연다 (Ctrl-C 로 닫는다). 이미 살아 있는 세션이면 그 카드로 가거나 웹 주소를 출력한다.
  --host H·--port N 은 웹으로 열 때 쓴다. --no-web 과는 함께 쓸 수 없고, superlite 안에서는 --web 과 함께 쓴다
  new [folder] [--web] [--host H] [--port N] [--no-web] [--raw] [--no-inspect] [--mode M] [--title T] [--vendor claude|codex] [--model M] [--stdio]
                                 새 세션 (폴더 생략 시 현재 폴더)
                                 --no-inspect: 설정 창의 '새 세션 inspect' 가 켜져 있어도 끈 채로 시작한다 (resume 이면 켜져 있던 것을 끈다).
                                 inspect 는 벤더(Claude·Codex)의 API 요청·응답 원본을 세션 폴더 inspect/ 에 남긴다 — 떠 있는 세션은 웹 사이드바에서 켜고 끈다
                                 --stdio: stdin/stdout 을 프레임 연결로 (첫 줄 {"url","id","sock"}; superlite 서비스용). resume·continue 도 받는다
                                 resume <s> --stdio --takeover: 살아 있는 세션의 소유권을 빼앗아 붙는다 (카드 핸드오프)
  resume [<s>]                   저장된 세션을 다시 띄운다. <s> 가 없으면 현재 폴더의 꺼진 세션 목록 (superlite 안이면 카드에서 고른다)
  continue [folder]              그 폴더에서 가장 최근에 꺼진 세션을 resume (없으면 새 세션)
  import <벤더 세션 id> [--vendor claude|codex] [--title T]
                                 Claude Code·Codex 세션을 복제해 slcode 세션으로 만들고 resume (원본은 그대로, 폴더는 벤더 기록에서).
                                 이전 대화도 옮겨 보인다 (Claude 는 마지막 compact 뒤부터). 같은 원본을 다시 import 하면 또 새 복제본.
                                 slcode 세션이 이어 쓰는 벤더 세션 id(export 뒤 벤더에서 이어 간 것)면 늘어난 턴을 그 세션에 붙인다
  export <s>                     그 세션을 벤더 하네스에서 이어 갈 명령을 출력 (cd <폴더> && claude --resume <id> | codex resume <id>)
  list [--all]                   살아 있는 세션 (--all 은 꺼진 세션까지)
  rename <s> <title> | close <s> [--force] | delete <s>
                                 --force 는 3초 안에 닫히지 않으면 세션 프로세스를 kill 한다
대화
  prompt <s> <text>              턴을 넣는다
  interrupt <s>
조회 (평문 기본, --json 이면 JSON)
  status <s>                     상태·모델·권한 모드·비용·대기 요청 수
  pending <s>                    대기 중인 승인·질문 (요청 id·종류·도구 또는 질문·입력 요약·선택지)
  last <s> [--turn N]            마지막 답 (N 턴 전의 답)
  log <s> [--since N] [--tail N] 이벤트를 한 번 출력 (꺼진 세션은 로그 파일에서)
응답 (요청 id 는 pending 에서)
  respond <s> <req> allow|deny [--remember]
  respond <s> <req> --answer <text>         질문에 답 (선택지 번호·라벨·자유 텍스트)
  respond <s> <req> --json '<updatedInput>'  입력 수정·여러 질문 등 복잡한 답
메시지 (<to> 는 켜진 세션의 id 또는 제목 — 꺼진 세션에는 보내지 않는다)
  mail <to> <text> [--from X] [--re <id>]
                                 보낸 이는 --from, 없으면 지금 세션, 세션 밖이면 unknown. --re 는 그 메시지의 답장으로
* check                          밀린 메시지를 지금 읽는다
* ask <to> <text> [--timeout S]  묻고 답장을 기다린다
* reply <id> <text>              받은 메시지에 답장
공통: --dir D (SLCODE_DIR 대체), --help, --version [--json] (--json 이면 {"version","build"} — build 는 dist/cli.js 의 mtime)`;

function usage(msg?: string): never {
  if (msg) console.error(`[slcode] ${msg}\n(slcode --help)`); else console.error(HELP);
  process.exit(2);
}
let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' }, host: { type: 'string' }, stdio: { type: 'boolean' }, vendor: { type: 'string' }, mode: { type: 'string' }, title: { type: 'string' }, model: { type: 'string' },
      since: { type: 'string' }, tail: { type: 'string' }, turn: { type: 'string' }, raw: { type: 'boolean' }, 'no-inspect': { type: 'boolean' }, all: { type: 'boolean' }, force: { type: 'boolean' }, json: { type: 'boolean' },
      remember: { type: 'boolean' }, from: { type: 'string' }, re: { type: 'string' }, timeout: { type: 'string' }, answer: { type: 'string' },
      'no-web': { type: 'boolean' }, web: { type: 'boolean' }, takeover: { type: 'boolean' }, version: { type: 'boolean' }, dir: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) { usage((e as Error).message); }
const { values: flags, positionals } = parsed as { values: Flags; positionals: string[] };
// 플러그인의 [업데이트] 가 받아 둔 slcode 에 묻는다 — 디스크의 이 설치 (ticket slcode-core-serve-split 2단계)
if (flags.version) { const b = diskBuild(); console.log(flags.json ? JSON.stringify(b) : `slcode ${b.version}`); process.exit(0); }
// 동사 없는 호출 = new . (ticket slcode-bare-new, 사용자 2026-10-07) — 인자가 없거나 첫 토큰이 옵션이면. 위치 인자는 받지 않는다
// (폴더·세션 id 를 동사로 잘못 읽지 않게, 다른 폴더는 new <folder>)
const argv0 = process.argv[2];
const bare = !flags.help && (argv0 === undefined || argv0.startsWith('-'));
if (bare && positionals.length) usage(`동사 없는 slcode 는 옵션만 받는다: ${positionals.join(' ')} — 다른 폴더는 slcode new <folder>`);
const [cmd, ...rest] = bare ? ['new'] : positionals;
if (!cmd || flags.help) { console.log(HELP); process.exit(0); }
const print = (o: unknown) => console.log(JSON.stringify(o, null, 2));
const err = (msg: string) => console.error(`[slcode] ${msg}`);
const P = corePaths(flags.dir);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: string | undefined, name: string) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 0) usage(`--${name} must be a non-negative integer`); return n; };

/** <s>·<to>: 세션 id 그대로, 아니면 유일한 제목. 여럿이면 후보를 나열하고 실패. 모르는 값은 그대로 (메시지의 받는 이는 mail.findLive 가 켜진 세션에서 찾는다) */
function resolve(s: string | undefined): string {
  if (!s) usage(`${cmd}: session required`);
  const all = EventLog.list(P.sessionsDir);
  if (all.some((m) => m.id === s)) return s;
  const hits = all.filter((m) => m.title === s);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) { err(`ambiguous title "${s}": ${hits.map((m) => `${m.id} (${m.cwd})`).join(', ')}`); process.exit(2); }
  return s;
}
/** check·ask·reply 는 세션 안에서만 — 벤더 자식 env 의 SLCODE_SESSION_ID */
function inSession(): string {
  const sid = process.env.SLCODE_SESSION_ID;
  if (!sid) { err(`${cmd} works only inside a slcode session (SLCODE_SESSION_ID)`); process.exit(2); }
  return sid;
}
function openLog(s: string | undefined) {
  const id = resolve(s);
  const log = EventLog.open(P.sessionsDir, id);
  if (!log) { err(`no session ${id}`); process.exit(1); }
  return log;
}
/** 살아 있는 세션의 소켓에 붙는다 — 저장만 된 세션이면 안내 */
async function liveClient(s: string | undefined) {
  const log = openLog(s);
  try { return { client: await connectSession(log.sockPath), id: log.meta.id, log }; }
  catch { err(`session ${log.meta.id} is not live — slcode resume ${log.meta.id}`); process.exit(1); }
}
/** close --force (사이드바 강제 종료, 사용자 2026-10-11) — session.close 를 보내고 3초 안에 소켓이 닫히지 않으면(멈춘 세션) core 가 meta 에 남긴 pid 를 SIGKILL.
 *  kill 은 serve 의 close 를 거치지 않으니 closedAt 을 여기서 남긴다 */
async function forceClose(log: EventLog): Promise<{ ok: true; killed: boolean }> {
  const id = log.meta.id;
  if (!(await sockAlive(log.sockPath))) { err(`session ${id} is not live`); process.exit(1); }
  const pid = log.meta.pid ?? 0;
  try { const client = await connectSession(log.sockPath); client.request('session.close', { id }).catch(() => {}); } catch {}
  for (const t0 = Date.now(); Date.now() - t0 < 3000; await sleep(100)) if (!(await sockAlive(log.sockPath))) return { ok: true, killed: false };
  if (!pid) { err(`session ${id} did not close and its pid is unknown`); process.exit(1); }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  EventLog.open(P.sessionsDir, id)?.updateMeta({ closedAt: Date.now() });
  return { ok: true, killed: true };
}
/** 조회용 스냅샷 — 살아 있으면 소켓(session.attach), 꺼져 있으면 로그 파일에서. 둘 다 같은 꼴 */
type Snapshot = { id: string; live: boolean; info: SessionInfo; history: LoggedEvent[]; pending: ApprovalRequest[]; client: RpcClient<Methods> | null };
async function snapshot(s: string | undefined, since = 0): Promise<Snapshot> {
  const log = openLog(s);
  const id = log.meta.id;
  try {
    const client = await connectSession(log.sockPath);
    const r = await client.request('session.attach', { id, since });
    return { id, live: true, info: r.info, history: r.history, pending: r.pending, client };
  } catch { return { id, live: false, info: log.storedInfo(), history: log.since(since), pending: [], client: null }; }
}

// ---- 렌더 (log·last 공용)
function render(e: LoggedEvent) {
  const ev = e.ev;
  switch (ev.kind) {
    case 'text.delta': process.stdout.write(ev.text); break;
    case 'thinking.delta': case 'hook': case 'session.state': break; // 상태 변화는 본문이 아니다 — --json 에는 그대로 있다
    case 'session.ready': console.log(`\n● ready ${ev.vendor} ${ev.model} mode=${ev.permissionMode}${ev.version ? ` v${ev.version}` : ''}`); break;
    case 'turn.start': console.log(`\n› ${ev.text}`); break;
    case 'tool.start': console.log(`\n⚙ ${ev.name} ${JSON.stringify(ev.input).slice(0, 200)}`); break;
    case 'tool.end': console.log(`  ${ev.ok ? '✓' : '✗'} ${ev.summary.split('\n')[0].slice(0, 120)}`); break;
    case 'approval.requested': console.log(`\n? ${ev.name === 'AskUserQuestion' ? 'question' : 'approval'} ${ev.requestId} ${ev.name} ${JSON.stringify(ev.input).slice(0, 200)}\n  → respond ${ev.requestId} ${ev.name === 'AskUserQuestion' ? '--answer <text>' : 'allow|deny'}`); break;
    case 'approval.resolved': console.log(`  ↳ ${ev.requestId} ${ev.decision}`); break;
    case 'review': console.log(`  ⚖ auto review ${ev.decision}${ev.risk ? ` (risk ${ev.risk})` : ''}: ${ev.action}${ev.rationale ? ` — ${ev.rationale}` : ''}`); break;
    case 'session.imported': console.log(`\n● imported from ${ev.vendor} session ${ev.vendorSessionId}`); break;
    case 'turn.end': console.log(`\n■ turn ${ev.ok ? 'ok' : ev.interrupted ? 'interrupted' : `error: ${ev.error}`}${ev.costUsd != null ? ` $${ev.costUsd.toFixed(4)}` : ''}`); break;
    default: console.log(`\n[${e.seq}] ${JSON.stringify(ev)}`);
  }
}
type Question = { question: string; header?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] };
const questionsOf = (r: ApprovalRequest): Question[] => r.name === 'AskUserQuestion' ? ((r.input as { questions?: Question[] })?.questions ?? []) : [];
function renderPending(r: ApprovalRequest) {
  const qs = questionsOf(r);
  if (!qs.length) { console.log(`${r.requestId}  approval  ${r.name}  ${JSON.stringify(r.input).slice(0, 300)}\n  → respond ${r.requestId} allow|deny`); return; }
  console.log(`${r.requestId}  question  ${qs.length === 1 ? qs[0].question : `${qs.length} questions`}`);
  qs.forEach((q, qi) => {
    if (qs.length > 1) console.log(`  [${qi + 1}] ${q.question}`);
    (q.options ?? []).forEach((o, oi) => console.log(`    ${oi + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`));
  });
  console.log(qs.length === 1 ? `  → respond ${r.requestId} --answer <번호|라벨|텍스트>` : `  → respond ${r.requestId} --json '{"answers":{"<질문문>":"<답>", ...}}'`);
}
/** 턴 경계 — turn.start 의 위치. --turn N 은 마지막에서 N 턴 전 */
function turnSlice(history: LoggedEvent[], back: number): LoggedEvent[] | null {
  const starts = history.flatMap((e, i) => (e.ev.kind === 'turn.start' ? [i] : []));
  const k = starts.length - 1 - back;
  if (k < 0) return null;
  return history.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : undefined);
}

/** resume·continue·import — 꺼진 세션은 카드(superlite 안) 또는 core 를 띄우고 이 프로세스가 웹 서빙, 살아 있는 세션은 그 카드를
 *  활성화(superlite 안) 또는 웹 주소를 찍고 끝난다. --stdio 는 카드 서비스 자신 — 살아 있으면 소켓 중계(attach), 아니면 core 를 띄운 소유자 serve */
async function resumeLog(log: EventLog, skip: (keyof Flags)[] = ['title', 'mode', 'model', 'raw', 'no-inspect', 'no-web', 'dir']) {
  let live = false;
  try { (await connectSession(log.sockPath)).close(); live = true; } catch {}
  if (live && flags.stdio) return attachStdio(log); // 살아 있는 세션의 소켓을 stdin/stdout 으로 중계 — superlite 카드가 떠 있는 세션에 붙는 길
  if (toCard()) openCard(['slcode.resume', '--id', log.meta.id], skip);
  if (live) return printWeb(log);
  await serve({ cwd: log.meta.cwd, resume: log.meta.id });
}
/** 살아 있는 세션의 웹 주소를 찍고 끝난다 — 웹이 없는 세션(--no-web·카드 서비스)이면 한 줄 안내 */
async function printWeb(log: EventLog) {
  const client = await connectSession(log.sockPath);
  const url = webUrl(await client.request('server.info', {}));
  client.close();
  unused(['host', 'port', 'no-web', 'title', 'mode', 'model', 'raw', 'no-inspect'], 'session is already live');
  if (!url) { err(`session ${log.meta.id} is live but has no web address`); process.exit(1); }
  console.log(url);
  err(`session ${log.meta.id} is already live`);
}
/** core 를 띄우고 그 소유자가 되어 끝까지 산다 — new·resume·continue. 웹 모드(--stdio·--no-web 없음)는 진입 프로세스가 되어 serve 를 자식으로
 *  띄우고 교체한다 (entry.ts). 카드 서비스(--stdio)·--no-web 은 이 프로세스가 곧 serve 다 */
/** 세션의 inspect — --no-inspect 면 끔. 새 세션은 들어온 입구(--stdio 면 superlite 카드, 아니면 웹)의 설정을 따르되, Claude 는 이 SDK 에서 막혔으면 끔.
 *  이어받는 세션은 넘기지 않는다 (meta 를 따른다) */
function inspectOf(resume: string | undefined): boolean | undefined {
  if (flags['no-inspect']) return false;
  if (resume || !readSettings(P.dir, flags.stdio ? 'superlite' : 'web').inspect) return undefined;
  const blocked = flags.vendor === 'codex' ? null : inspectBlocked(path.join(P.dir, FILES.inspectBlocked));
  if (blocked) err(`warning: not recording with inspect — it is blocked for this Claude Code (Agent SDK ${blocked})`);
  return !blocked;
}
async function serve(opts: { cwd: string; resume?: string }) {
  try {
    const entry = !flags.stdio && !flags['no-web'];
    const inspect = inspectOf(opts.resume);
    const h = entry ? await runEntry({
      dir: flags.dir, ...opts, title: flags.title, raw: flags.raw, inspect, permissionMode: flags.mode, model: flags.model, vendor: flags.vendor === 'codex' ? 'codex' : 'claude',
      host: flags.host, port: flags.port ? Number(flags.port) : undefined, log: err,
    }) : await serveSession({
      dir: flags.dir, ...opts, title: flags.title, raw: flags.raw, inspect, permissionMode: flags.mode, model: flags.model, vendor: flags.vendor === 'codex' ? 'codex' : 'claude',
      web: !flags['no-web'], host: flags.host, port: flags.port ? Number(flags.port) : undefined, stdio: flags.stdio, log: err,
      // superlite 서비스(serviceStart web)면 데몬이 정한 웹 소켓 주소 (ticket plugin-service-web)
      webSock: flags.stdio ? process.env.SUPERLITE_SERVICE_WEB || undefined : undefined,
    });
    // --stdio 면 첫 줄이 hello(JSON) — 그 뒤 stdout 은 프레임만. 아니면 사람이 읽는 URL(또는 소켓 경로) 한 줄
    if (flags.stdio) console.log(JSON.stringify({ url: h.url ? reachable(h.url) : null, id: h.session.id, sock: h.sock }));
    else if (h.url) console.log(reachable(h.url)); else console.log(h.sock);
    err(`session ${h.session.id} in ${opts.cwd} — Ctrl-C closes the session (later: slcode resume ${h.session.id})`);
    const bye = () => { err(`session ${h.session.id} closed. To continue: slcode resume ${h.session.id}`); process.exit(0); };
    const stop = () => void h.close('signal').then(bye);
    process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
    await h.done;
    bye();
  } catch (e) { err((e as Error).message); process.exit(1); }
}
/** new·resume·continue 공통 — 카드로 갈 자리인가: superlite 터미널 안(SUPERLITE_SOCK)이고 --web·--stdio(카드 서비스 자신 — 다시 카드를
 *  열면 돈다)가 없을 때 (ticket slcode-resume-like-new). --host·--port 는 웹일 때만이라 --no-web 과 함께면 오류, 카드로 갈 자리에서
 *  --web 없이 주면 카드인지 웹인지 모호해 아무것도 열지 않고 끝낸다 */
function toCard(): boolean {
  const listen = flags.host !== undefined || flags.port !== undefined;
  if (flags['no-web'] && (flags.web || listen)) usage('--no-web cannot be combined with --web, --host or --port');
  if (!process.env.SUPERLITE_SOCK || flags.web || flags.stdio) return false;
  if (listen) {
    const given = (['host', 'port'] as const).filter((k) => flags[k] !== undefined).map((k) => `--${k}`);
    err(`warning: ${given.join(' and ')} ${given.length > 1 ? 'are' : 'is'} ambiguous inside superlite; add --web to serve over the web, or drop ${given.length > 1 ? 'them' : 'it'} to open a card`);
    process.exit(2);
  }
  return true;
}
function unused(keys: (keyof Flags)[], why: string) {
  const given = keys.filter((k) => flags[k] !== undefined);
  if (given.length) err(`warning: ignoring ${given.map((k) => `--${k}`).join(' ')} (${why})`);
}
/** 플러그인 동사(slcode.new·slcode.resume)로 요청자 터미널의 deck 에 카드를 연 뒤 끝낸다 (ticket slcode-bare-new). 카드 세션은 플러그인의
 *  card 서비스가 든다. 심 없음·연결 불가(exit 3)·동사 없음(플러그인 미설치·비활성·옛 플러그인)이면 돌아와 웹 서빙으로. 동사가 있는데
 *  실패하면 그 사유로 끝낸다 */
function openCard(verb: string[], skip: (keyof Flags)[]): void {
  const r = spawnSync('superlite', verb, { encoding: 'utf8' });
  if (r.error || r.status === 3 || (r.status !== 0 && /unknown verb/.test(r.stderr))) return;
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
  unused(skip, 'opened as a card');
  process.stdout.write(r.stdout);
  process.exit(0);
}
/** 새 세션 카드 — 폴더·벤더·제목·모드를 slcode.new 에 넘긴다 */
function newCard(cwd: string): void {
  const args = ['slcode.new', '--cwd', cwd];
  for (const k of ['vendor', 'title', 'mode', 'model'] as const) if (flags[k] !== undefined) args.push(`--${k}`, flags[k]!);
  openCard(args, ['no-web', 'raw', 'no-inspect', 'dir']);
}
/** id 없는 resume — 현재 폴더의 꺼진 세션을 꺼진 순서(최근 먼저)로. superlite 안이면 카드 안에서 고르고(slcode.resume --cwd), 밖이면
 *  목록(id·시각·제목)을 찍고 끝난다 */
async function pickClosed(cwd: string) {
  const rows = await closedSessions(P.sessionsDir, cwd);
  if (!rows.length) { err(`no closed session in ${cwd}`); process.exit(1); }
  if (toCard()) openCard(['slcode.resume', '--cwd', cwd], ['title', 'mode', 'model', 'raw', 'no-inspect', 'no-web', 'dir']);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  for (const m of rows) console.log(`${m.id}  ${stamp(closedTime(m))}  ${m.title ?? '-'}`);
  err('resume one with: slcode resume <id>');
}
function folderArg(a: string | undefined): string {
  const cwd = path.resolve(a ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) { err(`not a folder: ${cwd}`); process.exit(2); }
  return cwd;
}
/** server.info 의 웹 주소 — 옛 빌드(url 없음)면 host·port·토큰으로 만든다 */
function webUrl(info: { host: string | null; port: number | null; url?: string | null }): string | null {
  return info.url ?? (info.port ? reachable(`http://${info.host}:${info.port}/${info.host && !['127.0.0.1', 'localhost', '::1'].includes(info.host) ? `?token=${readOrCreateToken(P)}` : ''}`) : null);
}
/** `resume --stdio` 가 살아 있는 세션을 만나면: hello 를 낸 뒤 stdio·서비스 웹을 그 세션 소켓에 중계한다. 소유자가 아니라 세션은 그대로
 *  (new --stdio 와 같은 모양을 카드에 준다, 2026-10-04). 중계는 serve 의 attach — core 를 띄우지 않는다. --takeover 면 소유권을 빼앗는다 (카드 핸드오프의 새 카드) */
async function attachStdio(log: EventLog) {
  const client = await connectSession(log.sockPath);
  const url = webUrl(await client.request('server.info', {}));
  client.close();
  const h = await serveSession({
    dir: flags.dir, cwd: log.meta.cwd, web: false, stdio: true, attach: { id: log.meta.id, sock: log.sockPath, url, takeover: flags.takeover }, log: err,
    webSock: process.env.SUPERLITE_SERVICE_WEB || undefined,
  });
  console.log(JSON.stringify({ url, id: log.meta.id, sock: log.sockPath }));
  // 빼앗은 소유자면 serve() 처럼 시그널에 세션을 닫는다 — 없으면 superlite 가 카드를 멈출 때 core 가 owner gone 유예 뒤에야 닫았다
  if (flags.takeover) {
    const stop = () => void h.close('signal').then(() => process.exit(0));
    process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
  }
  await h.done;
  process.exit(0);
}
try {
  switch (cmd) {
    // ---- 세션 수명
    case 'new': {
      const cwd = folderArg(rest[0]);
      if (toCard()) newCard(cwd);
      await serve({ cwd });
      break;
    }
    case 'continue': {
      // 그 폴더에서 가장 최근에 꺼진 세션 (살아 있는 세션은 뺀다) — 없으면 새 세션
      const cwd = folderArg(rest[0]);
      const last = (await closedSessions(P.sessionsDir, cwd))[0];
      if (last) { await resumeLog(openLog(last.id)); break; }
      err(`no closed session in ${cwd}, starting a new one`);
      if (toCard()) newCard(cwd);
      await serve({ cwd });
      break;
    }
    case 'resume':
      if (rest[0] !== undefined) await resumeLog(openLog(rest[0]));
      else if (flags.stdio) usage('resume --stdio <s>');
      else await pickClosed(folderArg(undefined));
      break;
    case 'import': {
      // 벤더 하네스의 세션을 복제해 slcode 세션으로 (ticket vendor-import 2026-10-07 → slcode-import-history 사용자 결정 2026-10-15: 원본은 벤더에 그대로)
      const vid = rest[0];
      if (!vid) usage('import <vendor session id>');
      if (flags.vendor !== undefined && flags.vendor !== 'claude' && flags.vendor !== 'codex') usage('--vendor claude|codex');
      // slcode 세션이 이어 쓰는 벤더 세션(export 뒤 벤더에서 이어 간 복제본, 옛 import 의 원본)이면 복제하지 않고 늘어난 턴을 그 세션에 붙인다
      const own = EventLog.list(P.sessionsDir).find((m) => m.vendorSessionId === vid);
      if (own) {
        const log = openLog(own.id);
        if (await sockAlive(log.sockPath)) err(`session ${own.id} is live — close it, then import again to pull new ${own.vendor} turns`);
        else {
          const r = await pullHistory(log, vid).catch((e: Error) => { err(`warning: could not read ${own.vendor} session ${vid}: ${e.message}`); return undefined; });
          log.close();
          if (r === null) err(`warning: cannot tell which ${own.vendor} turns session ${own.id} already has — nothing pulled`);
          else if (r) err(`pulled ${r.turns} turn${r.turns === 1 ? '' : 's'} from ${own.vendor} into ${own.id}${r.rewound ? ` (turns rewound in ${own.vendor} are dropped)` : ''}`);
        }
        await resumeLog(log);
        break;
      }
      const found = findVendorSession(vid, flags.vendor as 'claude' | 'codex' | undefined);
      if (!found) { err(`no ${flags.vendor ?? 'claude or codex'} session ${vid}`); process.exit(1); }
      if (!fs.existsSync(found.cwd)) { err(`session folder is gone: ${found.cwd}`); process.exit(1); }
      const prior = EventLog.list(P.sessionsDir).filter((m) => m.forkFrom === found.id).map((m) => m.id);
      if (prior.length) err(`${found.id} was already imported as ${prior.join(', ')} — making another copy`);
      // 복제: Claude 는 지금 SDK forkSession 으로 갈라 그 id 로, Codex 는 세션 프로세스의 첫 기동이 thread/fork 로 가른다 (meta.forkFrom, turn id 는 그대로 남는다)
      const vsid = found.vendor === 'claude' ? await forkClaude(found.id, found.cwd) : null;
      const log = EventLog.create(P.sessionsDir, {
        id: randomUUID().slice(0, 8), vendor: found.vendor, cwd: found.cwd, title: flags.title ?? null,
        vendorSessionId: vsid, createdAt: Date.now(), permissionMode: flags.mode ?? null, raw: flags.raw ?? false, forkFrom: found.id,
      });
      // 이전 대화를 옮겨 쓰고 그 뒤에 표지 — 읽지 못하면 반쯤 만든 세션을 남기지 않는다
      const r = await pullHistory(log, vsid ?? found.id, { vendorSessionId: found.id, fork: true }).catch((e: Error) => { log.close(); EventLog.remove(P.sessionsDir, log.meta.id); err(`could not read ${found.vendor} session ${found.id}: ${e.message}`); process.exit(1); });
      log.close();
      err(`imported ${found.vendor} session ${found.id} as ${log.meta.id} (${found.cwd}, ${r?.turns ?? 0} earlier turns) — a copy${vsid ? ` (${vsid})` : ''}, the original is untouched`);
      await resumeLog(log, ['raw', 'no-inspect', 'no-web', 'dir']); // --title·--mode 는 위 기록(meta)에 들어가 카드 세션에도 간다
      break;
    }
    case 'export': {
      const log = openLog(rest[0]);
      if (!log.meta.vendorSessionId) { err(`session ${log.meta.id} has no ${log.meta.vendor} session yet (no turn)`); process.exit(1); }
      let live = false;
      try { (await connectSession(log.sockPath)).close(); live = true; } catch {}
      if (live) err(`session ${log.meta.id} is live — close it first (slcode close ${log.meta.id}); both at once fork the conversation`);
      console.log(vendorResumeCommand(log.meta.vendor, log.meta.cwd, log.meta.vendorSessionId));
      break;
    }
    case 'list': {
      // 저장 세션은 폴더에서, 살아 있는지는 세션 소켓에 붙어 보아서 (pid 는 core 가 meta 에 남긴 것). 기본은 live 만 — 에이전트가 메시지 상대를 고르는 목록이라 꺼진 세션이 섞이면 안 된다 (사용자 2026-10-02); --all 은 resume 대상 고르기
      EventLog.migrate(P.sessionsDir);
      const stored = EventLog.list(P.sessionsDir);
      const alive = await Promise.all(stored.map((m) => sockAlive(new EventLog(P.sessionsDir, m).sockPath)));
      const live = new Map(stored.flatMap((m, i) => (alive[i] ? [[m.id, m.pid ?? null] as const] : [])));
      const me = process.env.SLCODE_SESSION_ID ?? null;
      const rows = stored.map((m) => ({ id: m.id, vendor: m.vendor, cwd: m.cwd, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt ?? m.createdAt, closedAt: m.closedAt ?? null, live: live.has(m.id), pid: live.get(m.id) ?? null, ...(m.id === me ? { me: true } : {}) }))
        .sort((a, b) => a.updatedAt - b.updatedAt);
      print(flags.all ? rows : rows.filter((r) => r.live));
      break;
    }
    case 'rename': {
      const log = openLog(rest[0]);
      const title = rest.slice(1).join(' ') || null;
      try { const client = await connectSession(log.sockPath); print(await client.request('session.rename', { id: log.meta.id, title })); client.close(); }
      catch { log.updateMeta({ title }); print({ ok: true, stored: true }); } // 꺼진 세션은 meta 만
      break;
    }
    case 'close': {
      if (flags.force) { print(await forceClose(openLog(rest[0]))); break; }
      const { client, id } = await liveClient(rest[0]); print(await client.request('session.close', { id })); client.close(); break;
    }
    case 'delete': {
      const log = openLog(rest[0]); const id = log.meta.id;
      try { const client = await connectSession(log.sockPath); await client.request('session.close', { id }); client.close(); } catch {}
      EventLog.remove(P.sessionsDir, id);
      print({ ok: true }); break;
    }
    // ---- 대화
    case 'prompt': { if (!rest[1]) usage('prompt <s> <text>'); const { client, id } = await liveClient(rest[0]); print(await client.request('session.send', { id, text: rest.slice(1).join(' ') })); client.close(); break; }
    case 'interrupt': { const { client, id } = await liveClient(rest[0]); print(await client.request('session.interrupt', { id })); client.close(); break; }
    // ---- 조회 — 평문 기본, --json 이면 같은 내용을 JSON 으로. 꺼진 세션은 로그 파일에서
    case 'status': {
      const s = await snapshot(rest[0]);
      const meta = s.info as SessionInfo & { model?: string | null; effort?: string | null }; // meta 의 setModel/setEffort 값 (꺼진 세션의 유일한 단서)
      let model: string | null = meta.model ?? null, effort: string | null = meta.effort ?? null, context: { tokens: number; max: number; pct: number } | null = null;
      if (s.client) {
        try { const m = await s.client.request('session.models', { id: s.id }); model = m.current ?? model; effort = m.effort ?? effort; } catch {}
        try { context = (await s.client.request('session.status', { id: s.id })).context; } catch {}
        s.client.close();
      }
      // turn.end.costUsd 는 벤더 프로세스 누계 — resume 뒤 0 부터 다시 시작하므로 줄어드는 경계에서 기준선에 합친다 (web/app.js 와 같은 셈)
      let costBase = 0, costLast = 0, costKnown = false;
      for (const e of s.history) if (e.ev.kind === 'turn.end' && e.ev.costUsd != null) { costKnown = true; if (e.ev.costUsd < costLast) costBase += costLast; costLast = e.ev.costUsd; }
      const turns = s.history.filter((e) => e.ev.kind === 'turn.start').length;
      const costUsd = costKnown || !turns ? costBase + costLast : null; // 턴이 있는데 비용을 하나도 모르면(가격표에 없는 Codex 모델) null
      const out = { id: s.id, title: s.info.title, vendor: s.info.vendor, cwd: s.info.cwd, live: s.live, state: s.info.state, model, effort, permissionMode: s.info.permissionMode, turns, costUsd, context, pending: s.pending.length, seq: s.info.seq, updatedAt: s.info.updatedAt ?? s.info.createdAt };
      if (flags.json) { print(out); break; }
      console.log([
        `id        ${out.id}${out.title ? ` (${out.title})` : ''}`, `vendor    ${out.vendor}`, `cwd       ${out.cwd}`,
        `state     ${out.state}${out.live ? '' : '  (not live — slcode resume ' + out.id + ')'}`,
        `model     ${out.model ?? '-'}${out.effort ? `  effort ${out.effort}` : ''}`, `mode      ${out.permissionMode ?? 'default'}`,
        `turns     ${out.turns}  cost ${out.costUsd != null ? `$${out.costUsd.toFixed(4)}` : '-'}${out.context ? `  context ${Math.round(out.context.pct)}%` : ''}`,
        `pending   ${out.pending}${out.pending ? `  (slcode pending ${out.id})` : ''}`,
      ].join('\n'));
      break;
    }
    case 'pending': {
      const s = await snapshot(rest[0]); s.client?.close();
      if (flags.json) { print(s.pending); break; }
      if (!s.pending.length) console.log(`(nothing pending — ${s.info.state}${s.live ? '' : ', not live'})`);
      for (const r of s.pending) renderPending(r);
      break;
    }
    case 'last': {
      const s = await snapshot(rest[0]); s.client?.close();
      const back = num(flags.turn, 'turn') ?? 0;
      const turn = turnSlice(s.history, back);
      if (!turn) { err(`no such turn (${s.history.filter((e) => e.ev.kind === 'turn.start').length} turns)`); process.exit(1); }
      if (flags.json) { print(turn); break; }
      for (const e of turn) render(e);
      console.log();
      break;
    }
    case 'log': {
      const s = await snapshot(rest[0], num(flags.since, 'since') ?? 0); s.client?.close();
      const tail = num(flags.tail, 'tail');
      const events = tail !== undefined ? s.history.slice(Math.max(0, s.history.length - tail)) : s.history;
      if (flags.json) { for (const e of events) console.log(JSON.stringify(e)); break; }
      for (const e of events) render(e);
      console.log();
      break;
    }
    // ---- 응답 — 요청 id 필수. 열려 있지 않은 id 면 오류 + 지금 대기 중인 목록 (미리 보관하지 않는다, 사용자 2026-10-02)
    case 'respond': {
      const [, req, word] = rest;
      if (!req) usage('respond <s> <req> allow|deny | --answer <text> | --json <updatedInput>');
      if (flags.answer === undefined && !flags.json && word !== 'allow' && word !== 'deny') usage('respond <s> <req> allow|deny | --answer <text> | --json <updatedInput>');
      const s = await snapshot(rest[0]);
      const notOpen = (): never => { s.client?.close(); err(`request ${req} is not open in ${s.id}${s.pending.length ? ` — pending: ${s.pending.map((r) => r.requestId).join(', ')}` : ' — nothing pending'}`); process.exit(1); };
      const r = s.pending.find((x) => x.requestId === req);
      if (!r || !s.client) notOpen();
      let params: Methods['session.approve']['params'];
      if (flags.answer !== undefined) {
        const qs = questionsOf(r!);
        if (!qs.length) usage(`${req} is an approval (${r!.name}) — respond ${req} allow|deny`);
        if (qs.length > 1) usage(`${req} has ${qs.length} questions — respond ${req} --json '{"answers":{...}}'`);
        const q = qs[0]; const a = flags.answer.trim();
        const n = Number(a); const picked = Number.isInteger(n) && q.options?.[n - 1] ? q.options[n - 1].label : a; // 번호면 그 선택지 라벨, 아니면 라벨 또는 자유 텍스트
        params = { id: s.id, requestId: req, decision: 'allow', updatedInput: { ...(r!.input as object), answers: { [q.question]: picked } } };
      } else if (flags.json) {
        let updatedInput: Record<string, unknown>;
        try { updatedInput = JSON.parse(word ?? ''); if (!updatedInput || typeof updatedInput !== 'object') throw 0; } catch { usage(`respond --json needs a JSON object: respond ${rest[0]} ${req} --json '{...}'`); }
        params = { id: s.id, requestId: req, decision: 'allow', updatedInput };
      } else {
        if (questionsOf(r!).length) usage(`${req} is a question — respond ${req} --answer <text>`);
        params = { id: s.id, requestId: req, decision: word as 'allow' | 'deny', remember: flags.remember };
      }
      const out = await s.client!.request('session.approve', params);
      if (!out.ok) notOpen(); // 그 사이 풀렸다
      s.client!.close();
      print({ ok: true, requestId: req, decision: params.decision });
      break;
    }
    // ---- 메시지 (ticket slcode-p2p-messaging, 사용자 결정 2026-10-19): 보낸 이는 --from, 없으면 SLCODE_SESSION_ID, 둘 다 없으면 unknown.
    // via 는 옵션으로 열지 않는다 — 세션 안에서 다른 이름으로 보내면 그 세션 id, 세션 밖이면 outside (env 를 바꿔 치는 것은 막지 않는다)
    case 'mail': {
      if (!rest[1]) usage('mail <to> <text> [--from X] [--re <id>]');
      const me = process.env.SLCODE_SESSION_ID;
      const from = flags.from ?? me ?? 'unknown';
      const via = !me ? 'outside' : from !== me ? me : undefined;
      const r = await sendMail(P.sessionsDir, rest[0], { from, kind: flags.re ? 'reply' : 'message', body: rest.slice(1).join(' '), ...(flags.re ? { re: flags.re } : {}), ...(via ? { via } : {}) });
      print(r); break;
    }
    case 'check': { const sid = inSession(); const { client } = await liveClient(sid); const r = await client.request('session.check', { id: sid }); console.log(r.count ? r.text : '(no mail)'); client.close(); break; }
    case 'ask': {
      const sid = inSession(); if (!rest[1]) usage('ask <to> <text>');
      const { client } = await liveClient(sid);
      try { const r = await client.request('session.ask', { id: sid, to: rest[0], text: rest.slice(1).join(' '), ...(flags.timeout ? { timeoutMs: Number(flags.timeout) * 1000 } : {}) }); console.log(r.text); }
      finally { client.close(); }
      break;
    }
    case 'reply': { // 실패(받는 이가 꺼짐 등)에도 소켓을 닫는다 — 열린 채 두면 이 명령이 끝나지 않아 부른 벤더 도구가 멈춘다 (데모 실측 2026-10-19)
      const sid = inSession(); if (!rest[1]) usage('reply <id> <text>');
      const { client } = await liveClient(sid);
      try { print(await client.request('session.reply', { id: sid, re: rest[0], text: rest.slice(1).join(' ') })); } finally { client.close(); }
      break;
    }
    default: usage(`unknown verb: ${cmd}`);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
}
