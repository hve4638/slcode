#!/usr/bin/env node
// 단독 실행 진입점 — 동사 하나를 받아 한 번 부르고 끝난다 (attach 만 연결 유지). 인자 없는 slcode 는 도움말만 (ticket slcode-verbs, 사용자 확정 2026-10-02).
//   세션 수명  new [folder] | resume <s> | continue [folder] | import <벤더 세션 id> | export <s> | attach <s> | list [--all] | rename <s> <title> | close <s> | delete <s>
//   대화       prompt <s> <text> | interrupt <s>
//   조회       status <s> | pending <s> | last <s> [--turn N] | log <s> [--since N] [--tail N]      — 평문 기본, --json 이면 같은 내용을 JSON 으로
//   응답       respond <s> <req> allow|deny [--remember] | respond <s> <req> --answer <text> | respond <s> <req> --json '<updatedInput>'
//   우편       mail <to> <text> [--from X] | inbox [<s>] | (세션 안) check | ask <to> <text> [--timeout S] | reply <mail id> <text>
//   우체국     post status | post restart
// <s>·<to> 는 모든 동사에서 세션 id 또는 유일한 제목. 옛 동사(send·approve·shutdown·post 단독·폴더 위치 인자)는 폐기, 폴백 별칭 없음.
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { connectPost, connectSession, type RpcClient } from './client.js';
import { EventLog } from './eventLog.js';
import { corePaths, readOrCreateToken } from './paths.js';
import { serveSession, reachable, staticHandler, listenAddr } from './serve.js';
import { claudeLastUuid, findVendorSession, forkClaude, vendorResumeCommand } from './vendor.js';
import { randomUUID } from 'node:crypto';
import type { ApprovalRequest, LoggedEvent, Methods, SessionInfo } from './protocol.js';

type Flags = { port?: string; host?: string; stdio?: boolean; vendor?: string; mode?: string; title?: string; since?: string; tail?: string; turn?: string; dir?: string; raw?: boolean; fork?: boolean; all?: boolean; json?: boolean; remember?: boolean; from?: string; timeout?: string; answer?: string; 'no-web'?: boolean; web?: boolean; help?: boolean };

const HELP = `usage: slcode [옵션] | slcode <동사> ...   (<s>·<to> 는 세션 id 또는 유일한 제목. * 는 세션 안(SLCODE_SESSION)에서만)

  slcode [--vendor --title --mode …]
                                 동사 없이 부르면 slcode new . — 첫 토큰이 옵션이면 전부 new 의 옵션. 폴더·세션 id 는 받지 않는다
                                 superlite 터미널 안이면 웹 대신 그 터미널의 deck 에 slcode 카드를 열고 끝난다 (--web 은 웹 강제)

세션 수명
  new [folder] [--port N] [--host H] [--no-web] [--raw] [--mode M] [--title T] [--vendor claude|codex] [--stdio] [--web]
                                 새 세션 (폴더 생략 시 현재 폴더). 이 프로세스가 세션이다 — Ctrl-C 로 닫는다
                                 superlite 터미널 안이면 카드로 연다 (위와 같음, --web·--stdio 면 이 프로세스가 세션)
                                 --stdio: stdin/stdout 을 프레임 연결로 (첫 줄 {"url","id","sock"}; superlite 서비스용). resume·continue 도 받는다
  resume <s>                     저장된 세션을 다시 띄운다. 이미 살아 있으면 attach
  continue [folder]              그 폴더의 최근 세션을 resume
  import <벤더 세션 id> [--vendor claude|codex] [--title T] [--fork]
                                 Claude Code·Codex 에서 하던 세션을 slcode 세션으로 이어받아 resume (폴더는 벤더 기록에서).
                                 같은 벤더 세션을 이어 쓴다 — 벤더 쪽은 먼저 닫는다. 이미 가져온 세션이면 그 slcode 세션을 resume.
                                 --fork 는 벤더 복제 기능으로 갈라 낸 새 세션으로 (원본은 그대로, 매번 새 slcode 세션).
                                 이전 대화는 화면에 다시 그리지 않는다
  export <s>                     그 세션을 벤더 하네스에서 이어 갈 명령을 출력 (cd <폴더> && claude --resume <id> | codex resume <id>)
  attach <s> [--since N]         살아 있는 세션에 터미널로 붙는다 (줄 입력 = 턴, /respond <req> allow|deny, /int, /quit)
  list [--all]                   살아 있는 세션 (--all 은 꺼진 세션까지)
  rename <s> <title> | close <s> | delete <s>
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
우편
  mail <to> <text> [--from X]    세션 밖에서는 --from 필수
  inbox [<s>]                    세션 밖에서는 <s> 필수
* check                          밀린 우편을 지금 읽는다
* ask <to> <text> [--timeout S]  묻고 답장을 기다린다
* reply <mail id> <text>         받은 우편에 답장
우체국
  post status | post restart     restart 는 우체국만 내린다 — 다음 세션이 새로 띄운다
공통: --dir D (SLCODE_DIR 대체), --help`;

function usage(msg?: string): never {
  if (msg) console.error(`[slcode] ${msg}\n(slcode --help)`); else console.error(HELP);
  process.exit(2);
}
let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' }, host: { type: 'string' }, stdio: { type: 'boolean' }, vendor: { type: 'string' }, mode: { type: 'string' }, title: { type: 'string' },
      since: { type: 'string' }, tail: { type: 'string' }, turn: { type: 'string' }, raw: { type: 'boolean' }, fork: { type: 'boolean' }, all: { type: 'boolean' }, json: { type: 'boolean' },
      remember: { type: 'boolean' }, from: { type: 'string' }, timeout: { type: 'string' }, answer: { type: 'string' },
      'no-web': { type: 'boolean' }, web: { type: 'boolean' }, dir: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    },
  });
} catch (e) { usage((e as Error).message); }
const { values: flags, positionals } = parsed as { values: Flags; positionals: string[] };
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
const num = (v: string | undefined, name: string) => { if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 0) usage(`--${name} must be a non-negative integer`); return n; };

/** <s>·<to>: 세션 id 그대로, 아니면 유일한 제목. 여럿이면 후보를 나열하고 실패. 모르는 값은 그대로 (우체국은 받는 이를 몰라도 보관한다) */
function resolve(s: string | undefined): string {
  if (!s) usage(`${cmd}: session required`);
  const all = EventLog.list(P.sessionsDir);
  if (all.some((m) => m.id === s)) return s;
  const hits = all.filter((m) => m.title === s);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) { err(`ambiguous title "${s}": ${hits.map((m) => `${m.id} (${m.cwd})`).join(', ')}`); process.exit(2); }
  return s;
}
/** check·ask·reply·(인자 없는 inbox) 는 세션 안에서만 — 벤더 자식 env 의 SLCODE_SESSION */
function inSession(): string {
  const sid = process.env.SLCODE_SESSION;
  if (!sid) { err(`${cmd} works only inside a slcode session (SLCODE_SESSION)`); process.exit(2); }
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

// ---- 렌더 (attach·log·last 공용)
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
    case 'session.imported': console.log(`\n● ${ev.fork ? 'forked' : 'imported'} ${ev.vendor} session ${ev.vendorSessionId} — earlier conversation is in ${ev.vendor}`); break;
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

/** resume·import — 살아 있으면 붙고(--stdio 면 소켓 중계), 아니면 세션 프로세스가 된다 */
async function resumeLog(log: EventLog) {
  let live = false;
  try { (await connectSession(log.sockPath)).close(); live = true; } catch {}
  if (live && flags.stdio) await proxyStdio(log); // 살아 있는 세션의 소켓을 stdin/stdout 으로 중계 — superlite 카드가 떠 있는 세션에 붙는 길
  else if (live) { err(`session ${log.meta.id} is live — attaching`); await attach(log.meta.id); } // tmux new -A 꼴
  else await serve({ cwd: log.meta.cwd, resume: log.meta.id });
}
/** 세션 프로세스가 되어 끝까지 산다 — new·resume·continue */
async function serve(opts: { cwd: string; resume?: string; continueLast?: boolean }) {
  try {
    const h = await serveSession({
      dir: flags.dir, ...opts, title: flags.title, raw: flags.raw, permissionMode: flags.mode, vendor: flags.vendor === 'codex' ? 'codex' : 'claude',
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
/** superlite 터미널 안이면 웹을 열지 않고 플러그인 동사 slcode.new 로 그 터미널의 deck 에 카드를 연 뒤 끝낸다 (ticket slcode-bare-new).
 *  카드 세션은 플러그인의 card 서비스가 든다. superlite 밖(SUPERLITE_SOCK 없음)·심 없음·연결 불가(exit 3)·동사 없음(플러그인
 *  미설치·비활성)이면 돌아와 웹 서빙으로. 동사가 있는데 실패하면 그 사유로 끝낸다 */
function openCardInSuperlite(cwd: string): void {
  if (!process.env.SUPERLITE_SOCK) return;
  const args = ['slcode.new', '--cwd', cwd];
  for (const k of ['vendor', 'title', 'mode'] as const) if (flags[k] !== undefined) args.push(`--${k}`, flags[k]!);
  const r = spawnSync('superlite', args, { encoding: 'utf8' });
  if (r.error || r.status === 3 || (r.status !== 0 && /unknown verb/.test(r.stderr))) return;
  if (r.status !== 0) { process.stderr.write(r.stderr); process.exit(1); }
  const unused = (['port', 'host', 'no-web', 'raw', 'dir'] as const).filter((k) => flags[k] !== undefined);
  if (unused.length) err(`카드로 열어 웹 서빙 옵션은 쓰지 않았다: ${unused.map((k) => `--${k}`).join(' ')}`);
  process.stdout.write(r.stdout);
  process.exit(0);
}
function folderArg(a: string | undefined): string {
  const cwd = path.resolve(a ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) { err(`not a folder: ${cwd}`); process.exit(2); }
  return cwd;
}
/** `resume --stdio` 가 살아 있는 세션을 만나면: 첫 줄 hello 뒤 stdin↔소켓을 바이트 그대로 중계한다. 세션 프로세스는 그대로 (new --stdio 와 같은 모양을 카드에 준다, 2026-10-04) */
async function proxyStdio(log: EventLog) {
  const sock = net.createConnection(log.sockPath);
  await new Promise<void>((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  sock.write(JSON.stringify({ id: 0, method: 'server.info', params: {} }) + '\n');
  const first = await new Promise<string>((resolve) => { let buf = ''; const on = (d: Buffer) => { buf += d.toString(); const i = buf.indexOf('\n'); if (i >= 0) { sock.off('data', on); resolve(buf.slice(0, i)); if (buf.length > i + 1) process.stdout.write(buf.slice(i + 1)); } }; sock.on('data', on); });
  const info = JSON.parse(first).result as { host: string | null; port: number | null; url?: string | null };
  // 옛 빌드(server.info 에 url 없음)면 host·port·토큰으로 만든다
  const url = info.url ?? (info.port ? reachable(`http://${info.host}:${info.port}/${info.host && !['127.0.0.1', 'localhost', '::1'].includes(info.host) ? `?token=${readOrCreateToken(P)}` : ''}`) : null);
  console.log(JSON.stringify({ url, id: log.meta.id, sock: log.sockPath }));
  // 다시 붙는 쪽은 hello 를 못 본다 — server.info 로 url 을 묻는데 옛 빌드 세션은 url 이 없으므로 여기서 채운다
  const asked = new Set<unknown>();
  const lines = (src: NodeJS.ReadableStream, f: (l: string) => string, dst: NodeJS.WritableStream) => {
    let buf = '';
    src.on('data', (d: Buffer) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { dst.write(f(buf.slice(0, i)) + '\n'); buf = buf.slice(i + 1); } });
  };
  lines(process.stdin, (l) => { try { const m = JSON.parse(l); if (m.method === 'server.info') asked.add(m.id); } catch { /* 그대로 */ } return l; }, sock);
  lines(sock, (l) => {
    if (!asked.size) return l;
    try { const m = JSON.parse(l); if (asked.delete(m.id) && m.result && !m.result.url) { m.result.url = url; return JSON.stringify(m); } } catch { /* 그대로 */ }
    return l;
  }, process.stdout);
  process.stdin.on('end', () => sock.end());
  // superlite 서비스 웹 (ticket plugin-service-web) — 정적 파일은 여기서, WebSocket 마다 세션 소켓 연결 하나를 잇는다 (WS 메시지 하나 =
  // 프레임 한 줄). 떠 있던 세션이 TCP 웹을 안 열었거나 다른 주소여도 카드 화면이 열린다
  const webAddr = process.env.SUPERLITE_SERVICE_WEB;
  if (webAddr) {
    const srv = http.createServer(staticHandler);
    new WebSocketServer({ server: srv, path: '/ws' }).on('connection', (ws) => {
      const s = net.createConnection(log.sockPath);
      let buf = '';
      s.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (ws.readyState === ws.OPEN) ws.send(l); } });
      ws.on('message', (d) => s.write(d.toString() + '\n'));
      ws.on('close', () => s.end());
      s.on('close', () => ws.close());
      s.on('error', () => ws.close());
      ws.on('error', () => s.destroy());
    });
    await listenAddr(srv, webAddr).catch((e) => console.error(`service web: ${(e as Error).message}`));
  }
  await new Promise<void>((resolve) => sock.on('close', resolve));
  process.exit(0);
}
/** 살아 있는 세션에 터미널로 붙는다 — 유일하게 연결을 유지하는 동사 */
async function attach(s: string | undefined) {
  const { client, id } = await liveClient(s);
  const r = await client.request('session.attach', { id, since: num(flags.since, 'since') ?? 0 });
  err(`[attach] ${id} ${r.info.state} history=${r.history.length} pending=${r.pending.length} — 줄 입력 = 새 턴, /respond <req> allow|deny, /int, /quit`);
  for (const e of r.history) render(e);
  client.onEvent((m) => { if (m.event === 'session.event') render(m.params as LoggedEvent); else if (m.event !== 'session.changed') console.error(`\n[${m.event}] ${JSON.stringify(m.params)}`); });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (d: string) => {
    for (const line of d.split('\n')) {
      const t = line.trim(); if (!t) continue;
      try {
        if (t === '/quit') process.exit(0);
        else if (t === '/int') await client.request('session.interrupt', { id });
        else if (t.startsWith('/respond ')) { const [, rq, dec] = t.split(' '); if (dec !== 'allow' && dec !== 'deny') { console.error('! /respond <req> allow|deny'); continue; } await client.request('session.approve', { id, requestId: rq, decision: dec }); }
        else await client.request('session.send', { id, text: t });
      } catch (e) { console.error(`! ${(e as Error).message}`); }
    }
  });
  await client.done;
}

try {
  switch (cmd) {
    // ---- 세션 수명
    case 'new': {
      const cwd = folderArg(rest[0]);
      if (!flags.web && !flags.stdio) openCardInSuperlite(cwd); // --stdio 는 카드 서비스 자신 — 다시 카드를 열면 돈다
      await serve({ cwd });
      break;
    }
    case 'continue': await serve({ cwd: folderArg(rest[0]), continueLast: true }); break;
    case 'resume': await resumeLog(openLog(rest[0])); break;
    case 'import': {
      // 벤더 하네스의 세션을 vendorSessionId 로 든 slcode 세션 기록을 만들고 resume (ticket vendor-import, 2026-10-07)
      const vid = rest[0];
      if (!vid) usage('import <vendor session id>');
      if (flags.vendor !== undefined && flags.vendor !== 'claude' && flags.vendor !== 'codex') usage('--vendor claude|codex');
      const already = flags.fork ? undefined : EventLog.list(P.sessionsDir).find((m) => m.vendorSessionId === vid);
      if (already) { err(`already imported as ${already.id}`); await resumeLog(openLog(already.id)); break; }
      const found = findVendorSession(vid, flags.vendor as 'claude' | 'codex' | undefined);
      if (!found) { err(`no ${flags.vendor ?? 'claude or codex'} session ${vid}`); process.exit(1); }
      if (!fs.existsSync(found.cwd)) { err(`session folder is gone: ${found.cwd}`); process.exit(1); }
      // --fork: Claude 는 지금 SDK forkSession 으로 갈라 그 id 로, Codex 는 세션 프로세스의 첫 기동이 thread/fork 로 가른다 (meta.forkFrom)
      let vsid: string | null = found.id, file: string | null = found.file;
      if (flags.fork && found.vendor === 'claude') { vsid = await forkClaude(found.id, found.cwd); file = findVendorSession(vsid, 'claude')?.file ?? null; }
      else if (flags.fork) { vsid = null; file = null; }
      const log = EventLog.create(P.sessionsDir, {
        id: randomUUID().slice(0, 8), vendor: found.vendor, cwd: found.cwd, title: flags.title ?? null,
        vendorSessionId: vsid, createdAt: Date.now(), permissionMode: flags.mode ?? null, raw: flags.raw ?? false,
        ...(flags.fork ? { forkFrom: found.id } : {}),
      });
      const uuid = found.vendor === 'claude' && file ? claudeLastUuid(file) : null;
      log.append({ seq: 1, at: Date.now(), ev: { kind: 'session.imported', vendor: found.vendor, vendorSessionId: found.id, uuid, ...(flags.fork ? { fork: true } : {}) } });
      log.close();
      if (flags.fork) err(`forked ${found.vendor} session ${found.id}${vsid ? ` into ${vsid}` : ''} as ${log.meta.id} (${found.cwd}) — the original is untouched`);
      else err(`imported ${found.vendor} session ${found.id} as ${log.meta.id} (${found.cwd}) — close it in ${found.vendor} first; both at once fork the conversation`);
      await resumeLog(log);
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
    case 'attach': await attach(rest[0]); break;
    case 'list': {
      // 저장 세션은 폴더에서, 살아 있는지는 우체국에서 (우체국이 없으면 전부 꺼진 것). 기본은 live 만 — 에이전트가 메시지 상대를 고르는 목록이라 꺼진 세션이 섞이면 안 된다 (사용자 2026-10-02); --all 은 resume 대상 고르기
      EventLog.migrate(P.sessionsDir);
      const stored = EventLog.list(P.sessionsDir);
      let live = new Map<string, number>();
      try { const { client } = await connectPost({ dir: flags.dir, autoStart: false }); live = new Map((await client.request('post.list')).map((e) => [e.id, e.pid])); client.close(); } catch {}
      const me = process.env.SLCODE_SESSION ?? null;
      const rows = stored.map((m) => ({ id: m.id, vendor: m.vendor, cwd: m.cwd, title: m.title, createdAt: m.createdAt, updatedAt: m.updatedAt ?? m.createdAt, live: live.has(m.id), pid: live.get(m.id) ?? null, ...(m.id === me ? { me: true } : {}) }))
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
    case 'close': { const { client, id } = await liveClient(rest[0]); print(await client.request('session.close', { id })); client.close(); break; }
    case 'delete': {
      const log = openLog(rest[0]); const id = log.meta.id;
      try { const client = await connectSession(log.sockPath); await client.request('session.close', { id }); client.close(); } catch {}
      EventLog.remove(P.sessionsDir, id); fs.rmSync(path.join(P.mailDir, id), { recursive: true, force: true });
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
    // ---- 우편 (사용자 확정 2026-10-02): 보낸 이는 세션 안이면 SLCODE_SESSION, 밖이면 --from 필수. --as 같은 대리 지정은 없다
    case 'mail': {
      const from = process.env.SLCODE_SESSION ?? flags.from;
      if (!from) { err('--from required outside a session'); process.exit(2); }
      if (!rest[1]) usage('mail <to> <text>');
      const { client } = await connectPost({ dir: flags.dir }); print(await client.request('mail.send', { from, to: resolve(rest[0]), body: rest.slice(1).join(' ') })); client.close(); break;
    }
    case 'inbox': {
      const to = rest[0] ? resolve(rest[0]) : inSession();
      const { client } = await connectPost({ dir: flags.dir, autoStart: false }); print(await client.request('mail.fetch', { to, schema: 1 })); client.close(); break;
    }
    case 'check': { const sid = inSession(); const { client } = await liveClient(sid); const r = await client.request('session.check', { id: sid }); console.log(r.count ? r.text : '(no mail)'); client.close(); break; }
    case 'ask': {
      const sid = inSession(); if (!rest[1]) usage('ask <to> <text>');
      const { client } = await liveClient(sid);
      try { const r = await client.request('session.ask', { id: sid, to: resolve(rest[0]), text: rest.slice(1).join(' '), ...(flags.timeout ? { timeoutMs: Number(flags.timeout) * 1000 } : {}) }); console.log(r.text); }
      finally { client.close(); }
      break;
    }
    case 'reply': { const sid = inSession(); if (!rest[1]) usage('reply <mail id> <text>'); const { client } = await liveClient(sid); print(await client.request('session.reply', { id: sid, re: rest[0], text: rest.slice(1).join(' ') })); client.close(); break; }
    // ---- 우체국
    case 'post': {
      if (rest[0] !== 'status' && rest[0] !== 'restart') usage('post status | post restart');
      const { client } = await connectPost({ dir: flags.dir, autoStart: false });
      print(rest[0] === 'status' ? { ...(await client.request('post.info')), live: await client.request('post.list') } : await client.request('post.shutdown'));
      client.close(); break;
    }
    default: usage(`unknown verb: ${cmd}`);
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
}
