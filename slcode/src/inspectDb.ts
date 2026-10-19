// inspect 기록 저장 (ticket slcode-inspect-default-on 2026-10-19, 저장 나눔·캐시 정리 ticket slcode-inspect-storage 2026-10-20) — 세션 폴더 inspect/inspect.db (node 내장 node:sqlite).
// 저장할 때부터 파싱된 정보와 raw 를 나눈다 (사용자 확정 2026-10-20). calls 한 행이 호출 하나의 파싱된 정보 — 요청은 system·tools·messages(Anthropic)·input(OpenAI Responses)
// 원소를 cache_control 을 뺀 내용의 해시로 parts 에 한 번만 두고 (Claude Code 는 캐시 표시를 매 호출 마지막 메시지로 옮긴다 — 표시 위치는 호출에 따로), SSE 응답은 메시지 하나로.
// raw 표는 보낸 요청 본문과 압축을 푼 응답 본문 그대로. 화면(요약·request·response)은 늘 파싱된 정보로 그리고, raw 는 raw 탭만 쓴다.
// compact 는 raw 를 지우는 일 — raw 가 7일을 넘거나 세션의 raw 합이 100MB 를 넘으면 (쓰는 core 가 쓸 때마다, 꺼진 세션은 3일마다 sweepInspect).
// 전체 상한 자동 삭제는 없다 — 사용자가 설정 창의 캐시 정리(inspectUsage·cleanInspect)로 지운다. 정리는 떠 있는 세션을 뺀다 (사용자 2026-10-20) — 그 DB 는 자기 core 만 연다.
// 여러 프로세스가 같은 DB 를 열어도 된다 — 쓰기는 트랜잭션 하나씩이고, raw 지우기는 이미 지운 행엔 할 일이 없다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { InspectCall, InspectRecord, InspectUsage } from './protocol.js';
import { pidAlive } from './lock.js';
import { sockAlive } from './live.js';
import { EventLog } from './eventLog.js';

const DAY = 24 * 3600 * 1000;
/** 세션 하나의 raw 합 상한 — 넘으면 오래된 raw 부터 지운다 (사용자 2026-10-17: 세션의 74% 가 통째로 남는 크기) */
export const RAW_CAP = 100 * 1024 * 1024;
export const RAW_AGE_MS = 7 * DAY;
/** 캐시 정리의 '압축' — 이만큼 지난 raw 를 지운다 */
export const COMPACT_AGE_MS = DAY;
/** 캐시 정리의 '오래된 캐시 제거' — 마지막 기록에서 이만큼 지난 세션 */
export const STALE_MS = 7 * DAY;
export const SWEEP_EVERY_MS = 3 * DAY;
export const INSPECT_DB = 'inspect.db';
const PARTED = ['system', 'tools', 'messages', 'input'] as const;

// 작은 칸을 앞에 — 큰 본문 뒤의 칸을 읽으려면 SQLite 가 그 행의 overflow 페이지를 다 따라간다 (SUM(size) 가 원본 전체를 읽었다, 리뷰 2026-10-19). raw_size 가 NULL 이면 raw 를 지웠다
const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  n INTEGER PRIMARY KEY, at INTEGER NOT NULL, ms INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, model TEXT, status INTEGER,
  req_bytes INTEGER NOT NULL, res_bytes INTEGER NOT NULL, error TEXT, raw_size INTEGER,
  req_headers TEXT NOT NULL, res_headers TEXT NOT NULL, req TEXT NOT NULL, res TEXT NOT NULL, req_full TEXT);
CREATE INDEX IF NOT EXISTS calls_at ON calls(at);
CREATE TABLE IF NOT EXISTS raw (n INTEGER PRIMARY KEY, req TEXT NOT NULL, res TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parts (hash TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID;`;

let mod: typeof import('node:sqlite') | null | undefined;
/** node:sqlite — Node 22.5 아래엔 없다(null). 처음 읽을 때 나오는 ExperimentalWarning 은 삼킨다 (core 로그·CLI 출력에 섞이지 않게) */
export function sqlite(): typeof import('node:sqlite') | null {
  if (mod !== undefined) return mod;
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (/SQLite/.test(typeof w === 'string' ? w : w.message)) return;
    (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try { mod = createRequire(import.meta.url)('node:sqlite'); } catch { mod = null; } finally { process.emitWarning = emit; }
  return mod ?? null;
}

// ---- 요청·응답을 저장 꼴로

/** 캐시 표시 하나 — 자리, 값, 그 객체에서의 키 순서 (옛 DB 의 표시엔 순서가 없다 — 끝에 붙인다) */
type Mark = [(string | number)[], unknown, number?];
/** cache_control 을 뺀 사본 — 뺀 자리와 값은 marks 에 */
function strip(v: unknown, at: (string | number)[], marks: Mark[]): unknown {
  if (Array.isArray(v)) return v.map((x, i) => strip(x, [...at, i], marks));
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  Object.entries(v).forEach(([k, x], i) => {
    if (k === 'cache_control') marks.push([at, x, i]);
    else out[k] = strip(x, [...at, k], marks);
  });
  return out;
}
/** 캐시 표시를 제자리에 — 키 순서까지 원본과 같게 (raw 로 그리던 화면과 같은 JSON) */
function unstrip(v: unknown, marks: Mark[]): unknown {
  for (const [at, cc, i] of marks) {
    let o: any = v;
    for (const k of at) o = o?.[k];
    if (!o || typeof o !== 'object') continue;
    if (i === undefined) { o.cache_control = cc; continue; }
    const kv = Object.entries(o);
    kv.splice(i, 0, ['cache_control', cc]);
    for (const k of Object.keys(o)) delete o[k];
    for (const [k, x] of kv) o[k] = x;
  }
  return v;
}
const hashOf = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');

/** 요청 본문의 system·tools·messages·input 원소를 조각 참조({$p, $c})로. JSON 객체가 아니면 null (본문 그대로 둔다) */
export function compactRequest(body: string, put: (hash: string, json: string) => void): string | null {
  let req: any;
  try { req = JSON.parse(body); } catch { return null; }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return null;
  const out = { ...req };
  for (const f of PARTED) {
    if (!Array.isArray(req[f])) continue;
    out[f] = req[f].map((el: unknown) => {
      const marks: Mark[] = [];
      const json = JSON.stringify(strip(el, [], marks));
      const hash = hashOf(json);
      put(hash, json);
      return marks.length ? { $p: hash, $c: marks } : { $p: hash };
    });
  }
  return JSON.stringify(out);
}
export function expandRequest(body: string, get: (hash: string) => string | null): string {
  let req: any;
  try { req = JSON.parse(body); } catch { return body; }
  if (!req || typeof req !== 'object') return body;
  for (const f of PARTED) {
    if (!Array.isArray(req[f])) continue;
    req[f] = req[f].map((el: any) => {
      if (!el || typeof el !== 'object' || typeof el.$p !== 'string') return el;
      const json = get(el.$p);
      return json === null ? null : unstrip(JSON.parse(json), el.$c ?? []);
    });
  }
  return JSON.stringify(req);
}

/** SSE 를 메시지 하나로 — message_start 에 블록·delta 를 이어 붙인다. 메시지가 없으면 null.
 *  OpenAI Responses(codex) 는 response.created 의 response 에 output_item.done 의 항목을 index 자리에 두고, 끝 이벤트(completed·incomplete·failed)의 response 로 덮는다
 *  (끝 이벤트의 output 이 비어 있으면 모은 항목을 남긴다). codex 의 사용량 한도 이벤트(codex.rate_limits)는 codex_rate_limits 로 붙인다 */
export function sseMessage(text: string): Record<string, any> | null {
  const parse = (t: string) => { try { return JSON.parse(t); } catch { return null; } };
  let msg = null as Record<string, any> | null, limits: Record<string, any> | null = null;
  const json: string[] = [];
  for (const chunk of text.split(/\r?\n\r?\n/)) {
    const ev = parse(chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('\n'));
    if (!ev) continue;
    if (ev.type === 'codex.rate_limits') limits = ev;
    else if (ev.type === 'response.created' || ev.type === 'response.in_progress') msg = { ...ev.response, output: msg?.output ?? [] };
    else if (ev.type === 'response.output_item.done') { msg ??= { output: [] }; msg.output[ev.output_index ?? msg.output.length] = ev.item; }
    else if (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') msg = { ...msg, ...ev.response, output: ev.response?.output?.length ? ev.response.output : msg?.output ?? [] };
    else if (ev.type === 'message_start') msg = { ...ev.message, content: [] };
    else if (ev.type === 'error') { const cur = msg as Record<string, any> | null; msg = { ...(cur ?? {}), content: cur?.content ?? [], error: ev.error }; }
    else if (!msg) continue;
    else if (ev.type === 'content_block_start') msg.content[ev.index] = { ...ev.content_block };
    else if (ev.type === 'content_block_delta') {
      const b = msg.content[ev.index], d = ev.delta;
      if (!b || !d) continue;
      if (d.type === 'text_delta') b.text = (b.text ?? '') + d.text;
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
      else if (d.type === 'input_json_delta') json[ev.index] = (json[ev.index] ?? '') + d.partial_json;
      else if (d.type === 'citations_delta') (b.citations ??= []).push(d.citation);
    } else if (ev.type === 'content_block_stop' && json[ev.index] && msg.content[ev.index]) msg.content[ev.index].input = parse(json[ev.index]) ?? json[ev.index];
    else if (ev.type === 'message_delta') { Object.assign(msg, ev.delta ?? {}); msg.usage = { ...msg.usage, ...ev.usage }; }
  }
  if (msg && limits) msg.codex_rate_limits = { plan_type: limits.plan_type, ...limits.rate_limits, credits: limits.credits };
  return msg;
}

// ---- 세션 하나의 DB

type Row = Record<string, any>;

/** proxy 가 잡은 호출 하나 — 본문은 원본 그대로 (add 가 파싱된 정보와 raw 로 나눈다). resBody 는 압축을 푼 텍스트 (SSE 는 도착한 그대로).
 *  method 'WS' 는 WebSocket 메시지 하나(codex) — reqBody 는 보낸 메시지, resBody 는 받은 이벤트를 SSE 꼴로 이은 것, reqFull 은 증분 요청을 다시 만든 전체 요청 */
export type InspectCapture = InspectCall & {
  reqHeaders: Record<string, string | string[]>; reqBody: string; reqFull?: string; resHeaders: Record<string, string | string[]>; resBody: string;
};

/** 파싱된 응답 — SSE·WebSocket 이벤트면 메시지 하나의 JSON, 못 만들거나 그 밖이면 본문 그대로 */
function responseOf(method: string, resHeaders: Record<string, unknown>, resBody: string): string {
  try {
    const msg = method === 'WS' || String(resHeaders['content-type'] ?? '').includes('event-stream') ? sseMessage(resBody) : null;
    if (msg) return JSON.stringify(msg);
  } catch {}
  return resBody;
}
/** 요청 본문을 조각 꼴로 — 다시 쓰지 못하면 본문 그대로 */
function partedOf(body: string, put: (hash: string, json: string) => void): string {
  try { return compactRequest(body, put) ?? body; } catch { return body; }
}

export class InspectStore {
  private constructor(readonly file: string, private db: DatabaseSync) {}

  static exists(dir: string): boolean { return fs.existsSync(path.join(dir, INSPECT_DB)); }

  /** 없으면 만든다. 옛 꼴(raw/compacted 한 표)이면 바꾼다. node:sqlite 가 없으면 사유를 담아 throw */
  static open(dir: string): InspectStore {
    const m = sqlite();
    if (!m) throw new Error(`inspect needs node:sqlite (Node 22.5 or later, this is ${process.version})`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, INSPECT_DB);
    const db = new m.DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA auto_vacuum = INCREMENTAL'); // 표를 만들기 전에만 듣는다 — 지운 자리를 파일에서 돌려받게
      db.exec('PRAGMA journal_mode = WAL');
      if (columns(db).includes('compacted')) migrate(db);
      db.exec(SCHEMA);
    } catch (e) { db.close(); throw e; }
    try { fs.chmodSync(file, 0o600); } catch {}
    return new InspectStore(file, db);
  }

  close() { try { this.db.close(); } catch {} }

  private tx<T>(f: () => T): T { return tx(this.db, f); }

  lastN(): number { return Number((this.db.prepare('SELECT MAX(n) AS m FROM calls').get() as Row).m ?? 0); }

  /** 가장 늦은 호출의 시각 — 없으면 null */
  lastAt(): number | null { return ((this.db.prepare('SELECT MAX(at) AS a FROM calls').get() as Row).a as number | null) ?? null; }

  add(rec: InspectCapture) {
    this.tx(() => {
      const put = this.db.prepare('INSERT OR IGNORE INTO parts (hash, body) VALUES (?, ?)');
      const parts = (h: string, json: string) => { put.run(h, json); };
      insertCall(this.db, rec, partedOf(rec.reqBody, parts), rec.reqFull == null ? null : partedOf(rec.reqFull, parts), responseOf(rec.method, rec.resHeaders, rec.resBody),
        Buffer.byteLength(rec.reqBody) + Buffer.byteLength(rec.resBody));
      this.db.prepare('INSERT INTO raw (n, req, res) VALUES (?, ?, ?)').run(rec.n, rec.reqBody, rec.resBody);
    });
  }

  /** at 이 (from, to] 인 호출 — 번호 순 */
  calls(from: number, to: number): InspectCall[] {
    const rows = this.db.prepare('SELECT n, at, ms, method, path, model, status, req_bytes, res_bytes, error FROM calls WHERE at > ? AND at <= ? ORDER BY n')
      .all(Number.isFinite(from) ? from : -1, to) as Row[];
    return rows.map((r) => ({ n: r.n, at: r.at, ms: r.ms, method: r.method, path: r.path, model: r.model, status: r.status, reqBytes: r.req_bytes, resBytes: r.res_bytes,
      ...(r.error != null ? { error: r.error } : {}) }));
  }

  /** 호출 하나 — 요청은 조각으로 다시 조립한다. raw 는 남아 있을 때만. 없으면 null */
  read(n: number): InspectRecord | null {
    if (!Number.isInteger(n)) return null;
    const r = this.db.prepare('SELECT * FROM calls WHERE n = ?').get(n) as Row | undefined;
    if (!r) return null;
    const part = this.db.prepare('SELECT body FROM parts WHERE hash = ?');
    const expand = (body: string) => expandRequest(body, (h) => ((part.get(h) as Row | undefined)?.body ?? null));
    const raw = r.raw_size == null ? undefined : this.db.prepare('SELECT req, res FROM raw WHERE n = ?').get(n) as Row | undefined;
    return { n: r.n, at: r.at, ms: r.ms, method: r.method, path: r.path, model: r.model, status: r.status, reqBytes: r.req_bytes, resBytes: r.res_bytes,
      ...(r.error != null ? { error: r.error } : {}), reqHeaders: JSON.parse(r.req_headers), resHeaders: JSON.parse(r.res_headers),
      request: expand(r.req), ...(r.req_full != null ? { requestFull: expand(r.req_full) } : {}), response: r.res,
      ...(raw ? { raw: { req: raw.req, res: raw.res } } : {}) };
  }

  rawSize(): number { return Number((this.db.prepare('SELECT SUM(raw_size) AS s FROM calls').get() as Row).s ?? 0); }

  /** at 이 before 앞인 호출 중 raw 가 남은 것의 수와 바이트 — 캐시 정리 미리보기 */
  compactable(before: number): { calls: number; bytes: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS c, SUM(raw_size) AS s FROM calls WHERE raw_size IS NOT NULL AND at < ?').get(before) as Row;
    return { calls: Number(r.c), bytes: Number(r.s ?? 0) };
  }

  /** at 이 before 앞인 호출의 raw 를 지운다 — 지운 수와 바이트 */
  compact(before: number): { calls: number; bytes: number } {
    return this.tx(() => {
      const done = this.compactable(before);
      if (done.calls) {
        this.db.prepare('DELETE FROM raw WHERE n IN (SELECT n FROM calls WHERE raw_size IS NOT NULL AND at < ?)').run(before);
        this.db.prepare('UPDATE calls SET raw_size = NULL WHERE raw_size IS NOT NULL AND at < ?').run(before);
      }
      return done;
    });
  }

  /** 7일 지난 raw 를, 그다음 세션 상한을 넘는 만큼 오래된 raw 를 지운다 — 쓰는 core 가 호출을 남길 때마다. 지운 수를 돌려준다 */
  tidy(now = Date.now(), cap = RAW_CAP, age = RAW_AGE_MS): number {
    let done = this.compact(now - age).calls;
    let over = this.rawSize() - cap;
    if (over > 0) {
      const ns: number[] = [];
      for (const r of this.db.prepare('SELECT n, raw_size FROM calls WHERE raw_size IS NOT NULL ORDER BY at').all() as Row[]) {
        if (over <= 0) break;
        ns.push(r.n); over -= r.raw_size;
      }
      this.tx(() => {
        const del = this.db.prepare('DELETE FROM raw WHERE n = ?'), mark = this.db.prepare('UPDATE calls SET raw_size = NULL WHERE n = ?');
        for (const n of ns) { del.run(n); mark.run(n); }
      });
      done += ns.length;
    }
    if (done) this.vacuum();
    return done;
  }

  /** 빈 페이지를 파일에서 돌려받는다. checkpoint 는 PASSIVE — 다른 프로세스의 읽기·쓰기를 기다리지 않는다 (WAL 은 비운 자리를 다시 쓴다) */
  vacuum() {
    try { this.db.exec('PRAGMA incremental_vacuum'); this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
  }
}

const columns = (db: DatabaseSync) => (db.prepare('PRAGMA table_info(calls)').all() as Row[]).map((c) => c.name as string);

function tx<T>(db: DatabaseSync, f: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function insertCall(db: DatabaseSync, c: InspectCall & { reqHeaders: unknown; resHeaders: unknown }, req: string, full: string | null, res: string, rawSize: number | null) {
  db.prepare(`INSERT INTO calls (n, at, ms, method, path, model, status, req_bytes, res_bytes, error, raw_size, req_headers, res_headers, req, res, req_full)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    c.n, c.at, c.ms, c.method, c.path, c.model, c.status, c.reqBytes, c.resBytes, c.error ?? null, rawSize,
    JSON.stringify(c.reqHeaders), JSON.stringify(c.resHeaders), req, res, full);
}

/** 옛 꼴(b928bfa·6e5145a — calls 한 표에 원본과 compacted·dropped)을 새 꼴로, 트랜잭션 하나에. 같이 연 프로세스가 먼저 끝냈을 수 있어 안에서 다시 본다.
 *  raw 행은 원본에서 파싱된 정보를 만들고 원본은 raw 표로, compacted 행은 이미 저장 꼴이다 (옛 캐시 표시엔 키 순서가 없어 끝에 붙는다 — 옛 화면과 같다).
 *  전체 상한(10GB)으로 지운 행('지움' 카드)과 조각 참조 표(refs)는 지운다 — 호출 하나를 지우는 길이 이제 없다 */
function migrate(db: DatabaseSync) {
  tx(db, () => {
    const cols = columns(db);
    if (!cols.includes('compacted')) return;
    db.exec('ALTER TABLE calls RENAME TO calls_old; DROP INDEX IF EXISTS calls_at; DROP TABLE IF EXISTS refs');
    db.exec(SCHEMA);
    const get = db.prepare(`SELECT *${cols.includes('req_full') ? '' : ', NULL AS req_full'} FROM calls_old WHERE n = ?`);
    const put = db.prepare('INSERT OR IGNORE INTO parts (hash, body) VALUES (?, ?)');
    const parts = (h: string, json: string) => { put.run(h, json); };
    const raw = db.prepare('INSERT INTO raw (n, req, res) VALUES (?, ?, ?)');
    for (const { n } of db.prepare('SELECT n FROM calls_old WHERE dropped = 0 ORDER BY n').all() as Row[]) {
      const r = get.get(n) as Row;
      const c = { n: r.n, at: r.at, ms: r.ms, method: r.method, path: r.path, model: r.model, status: r.status, reqBytes: r.req_bytes, resBytes: r.res_bytes,
        ...(r.error != null ? { error: r.error } : {}), reqHeaders: JSON.parse(r.req_headers), resHeaders: JSON.parse(r.res_headers) };
      if (r.compacted) { insertCall(db, c, r.req_body, r.req_full, r.res_body, null); continue; }
      insertCall(db, c, partedOf(r.req_body, parts), r.req_full == null ? null : partedOf(r.req_full, parts), responseOf(r.method, c.resHeaders, r.res_body),
        Buffer.byteLength(r.req_body) + Buffer.byteLength(r.res_body));
      raw.run(n, r.req_body, r.res_body);
    }
    db.exec('DROP TABLE calls_old');
  });
  try { db.exec('PRAGMA incremental_vacuum'); } catch {}
}

// ---- 상태 폴더 전체

type Entry = { dir: string; bytes: number; live: boolean };
/** sessions/<cwd>/<id>/inspect 중 inspect.db 가 있는 것 — 폴더의 파일 크기 합과 떠 있는지 (meta 의 세션 소켓에 붙어 본다) */
async function sessionInspects(sessionsDir: string): Promise<Entry[]> {
  const ls = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
  const out: Entry[] = [];
  for (const sdir of ls(sessionsDir).flatMap(ls)) {
    const dir = path.join(sdir, 'inspect');
    if (!InspectStore.exists(dir)) continue;
    out.push({ dir, bytes: folderBytes(dir), live: await liveSession(sessionsDir, sdir) });
  }
  return out;
}
function folderBytes(dir: string): number {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) n += st.size; } catch {} } catch {}
  return n;
}
async function liveSession(sessionsDir: string, sdir: string): Promise<boolean> {
  try { return await sockAlive(new EventLog(sessionsDir, JSON.parse(fs.readFileSync(EventLog.metaPath(sdir), 'utf8'))).sockPath); } catch { return false; }
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/** DB 하나를 열고 닫는다 — 열거나 다루다 실패하면 null (하나 때문에 전체가 멈추지 않게) */
function withStore<T>(dir: string, f: (s: InspectStore) => T, log?: (msg: string) => void): T | null {
  let s: InspectStore | null = null;
  try { s = InspectStore.open(dir); return f(s); }
  catch (e) { log?.(`inspect ${dir}: ${(e as Error).message}`); return null; }
  finally { s?.close(); }
}

/** 캐시 정리 미리보기 (사용자 확정 2026-10-20) — 전체 크기·세션 수는 떠 있는 세션까지, 버튼마다 지울 양은 꺼진 세션만.
 *  오래된 캐시는 마지막 기록(DB 의 가장 늦은 호출, 없으면 파일 시각)에서 7일 — 파일 시각은 정리·자동 정리가 다시 쓴다. 압축 양과 같이 DB 를 하나씩 열어 본다 */
export async function inspectUsage(sessionsDir: string, now = Date.now()): Promise<InspectUsage> {
  const all = await sessionInspects(sessionsDir);
  const u: InspectUsage = { bytes: 0, sessions: all.length, live: 0, old: { sessions: 0, bytes: 0 }, compact: { calls: 0, bytes: 0 }, all: { sessions: 0, bytes: 0 } };
  for (const e of all) {
    u.bytes += e.bytes;
    if (e.live) { u.live++; continue; }
    u.all.sessions++; u.all.bytes += e.bytes;
    const st = withStore(e.dir, (s) => ({ last: s.lastAt(), raw: s.compactable(now - COMPACT_AGE_MS) }));
    if ((st?.last ?? mtime(e.dir)) < now - STALE_MS) { u.old.sessions++; u.old.bytes += e.bytes; }
    if (st) { u.compact.calls += st.raw.calls; u.compact.bytes += st.raw.bytes; }
    await tick();
  }
  return u;
}
const mtime = (dir: string) => { try { return fs.statSync(path.join(dir, INSPECT_DB)).mtimeMs; } catch { return 0; } };

/** 캐시 정리 — old 는 마지막 기록에서 7일 지난 세션의 inspect 폴더를, all 은 모든 inspect 폴더를 지우고, compact 는 하루 지난 raw 를 지운다. 떠 있는 세션은 뺀다 —
 *  폴더를 지우기 직전에 다시 본다 (미리보기 뒤에 다시 연 세션). 끝난 뒤의 미리보기를 돌려준다 */
export async function cleanInspect(sessionsDir: string, what: 'old' | 'compact' | 'all', now = Date.now(), log?: (msg: string) => void): Promise<InspectUsage> {
  for (const e of await sessionInspects(sessionsDir)) {
    if (e.live) continue;
    if (what === 'compact') withStore(e.dir, (s) => { if (s.compact(now - COMPACT_AGE_MS).calls) s.vacuum(); }, log);
    else {
      if (what === 'old' && (withStore(e.dir, (s) => s.lastAt()) ?? mtime(e.dir)) >= now - STALE_MS) continue;
      if (await liveSession(sessionsDir, path.dirname(e.dir))) continue;
      try { fs.rmSync(e.dir, { recursive: true, force: true }); } catch (err) { log?.(`inspect clean ${e.dir}: ${(err as Error).message}`); }
    }
    await tick();
  }
  return inspectUsage(sessionsDir, now);
}

/** 꺼진 세션마다 7일 지난 raw 와 세션 상한을 넘는 raw 를 지운다 — 떠 있는 세션은 자기 core 가 쓸 때마다 한다. DB 는 하나씩 열고 닫는다 */
export async function sweepInspect(sessionsDir: string, now = Date.now(), log: (msg: string) => void = () => {}): Promise<void> {
  for (const e of await sessionInspects(sessionsDir)) {
    if (e.live) continue;
    withStore(e.dir, (s) => { s.tidy(now); s.vacuum(); }, (m) => log(`inspect sweep skipped: ${m}`));
    await tick();
  }
}

/** 지난 정리(stamp)에서 every 가 지났으면 잠금을 잡고 sweepInspect. 이미 누가 정리 중(잠금의 pid 가 살아 있음)이면 건너뛴다 — 정리했으면 true */
export async function maybeSweep(stamp: string, lock: string, sessionsDir: string, opts: { now?: number; every?: number; log?: (msg: string) => void } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now(), every = opts.every ?? SWEEP_EVERY_MS;
  const due = () => { try { return now - (Number(JSON.parse(fs.readFileSync(stamp, 'utf8')).at) || 0) >= every; } catch { return true; } };
  if (!due() || !takeLock(lock)) return false;
  try {
    if (!due()) return false; // 잠금을 기다리는 사이 다른 core 가 막 끝냈다
    await sweepInspect(sessionsDir, now, opts.log);
    fs.writeFileSync(stamp, JSON.stringify({ at: now }) + '\n');
    return true;
  } finally { fs.rmSync(lock, { force: true }); }
}

/** O_EXCL 로 만들고 내용은 pid. 남은 잠금의 pid 가 죽었으면 한 번 지우고 다시 — 둘이 동시에 지워 둘 다 정리해도 DB 는 트랜잭션이 지킨다 */
function takeLock(file: string): boolean {
  for (let i = 0; i < 2; i++) {
    try { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); return true; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      let pid = 0;
      try { pid = Number(fs.readFileSync(file, 'utf8')); } catch {}
      if (pidAlive(pid)) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}
