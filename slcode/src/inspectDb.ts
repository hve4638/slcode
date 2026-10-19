// inspect 기록 저장 (ticket slcode-inspect-default-on, 사용자 결정 2026-10-19) — 세션 폴더 inspect/inspect.db (node 내장 node:sqlite).
// 호출 하나가 calls 한 행. 처음엔 원본(raw) 그대로 — 요청 본문 텍스트, 압축을 푼 응답 텍스트 (SSE 는 도착한 그대로).
// compact 는 원본만 지운다: 요청의 system·tools·messages(Anthropic)·input(OpenAI Responses) 원소를 cache_control 을 뺀 내용의 해시로 parts 에 한 번만 두고
// (Claude Code 는 캐시 표시를 매 호출 마지막 메시지로 옮긴다 — 표시 위치는 호출에 따로), SSE 응답은 메시지 하나로 다시 조립한다. 요약·request·response 탭은 그대로 보인다.
// 언제: raw 가 7일을 넘거나 세션의 raw 합이 100MB 를 넘으면 (쓰는 core 가 쓸 때마다). 전체(상태 폴더의 모든 세션) 10GB 는 sweepInspect 가 3일마다 —
// 오래된 raw 부터 compact, 그래도 넘으면 오래된 호출부터 지운다 (지운 호출은 카드에 '지움' 으로 남는다).
// 여러 프로세스(세션의 core·전체 정리)가 같은 DB 를 써도 된다 — 쓰기는 트랜잭션 하나씩이고, compact·지우기는 이미 된 행엔 할 일이 없다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { InspectCall, InspectRecord } from './protocol.js';
import { pidAlive } from './lock.js';

/** 세션 하나의 raw 합 상한 — 넘으면 오래된 raw 부터 compact (사용자 2026-10-17: 세션의 74% 가 통째로 남는 크기) */
export const RAW_CAP = 100 * 1024 * 1024;
export const RAW_AGE_MS = 7 * 24 * 3600 * 1000;
/** 상태 폴더 전체의 inspect.db 사용량 상한 */
export const TOTAL_CAP = 10 * 1024 ** 3;
export const SWEEP_EVERY_MS = 3 * 24 * 3600 * 1000;
export const INSPECT_DB = 'inspect.db';
const PARTED = ['system', 'tools', 'messages', 'input'] as const;
/** 한 번에 compact·지우는 호출 수 — 쓰는 core 는 호출을 남길 때마다 이만큼까지(나머지는 다음 호출 때), 전체 정리는 이만큼씩 하고 이벤트 루프를 놓는다.
 *  DatabaseSync 는 동기라 그동안 같은 core 의 proxy 스트림이 멈춘다 */
const BATCH = 20;

// 작은 칸을 앞에 — 큰 본문 뒤의 칸을 읽으려면 SQLite 가 그 행의 overflow 페이지를 다 따라간다 (SUM(size) 가 원본 전체를 읽었다, 리뷰 2026-10-19)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  n INTEGER PRIMARY KEY, at INTEGER NOT NULL, ms INTEGER NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, model TEXT, status INTEGER,
  req_bytes INTEGER NOT NULL, res_bytes INTEGER NOT NULL, error TEXT, size INTEGER NOT NULL, compacted INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
  req_headers TEXT NOT NULL, res_headers TEXT NOT NULL, req_body TEXT NOT NULL, res_body TEXT NOT NULL, req_full TEXT);
CREATE INDEX IF NOT EXISTS calls_at ON calls(at);
CREATE TABLE IF NOT EXISTS parts (hash TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS refs (hash TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (hash, n)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS refs_n ON refs(n);`;

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

// ---- 요청·응답을 compact 꼴로

type Mark = [(string | number)[], unknown];
/** cache_control 을 뺀 사본 — 뺀 자리와 값은 marks 에 */
function strip(v: unknown, at: (string | number)[], marks: Mark[]): unknown {
  if (Array.isArray(v)) return v.map((x, i) => strip(x, [...at, i], marks));
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === 'cache_control') marks.push([at, x]);
    else out[k] = strip(x, [...at, k], marks);
  }
  return out;
}
function unstrip(v: unknown, marks: Mark[]): unknown {
  for (const [at, cc] of marks) {
    let o: any = v;
    for (const k of at) o = o?.[k];
    if (o && typeof o === 'object') o.cache_control = cc;
  }
  return v;
}
const hashOf = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');

/** 요청 본문의 system·tools·messages 원소를 조각 참조({$p, $c})로. JSON 객체가 아니면 null (본문 그대로 둔다) */
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

/** SSE 를 메시지 하나로 — message_start 에 블록·delta 를 이어 붙인다 (web/inspect.js responseOf 와 같은 규칙). 메시지가 없으면 null.
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

export class InspectStore {
  private constructor(readonly file: string, private db: DatabaseSync) {}

  static exists(dir: string): boolean { return fs.existsSync(path.join(dir, INSPECT_DB)); }

  /** 없으면 만든다. node:sqlite 가 없으면 사유를 담아 throw */
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
      db.exec(SCHEMA);
      // codex 의 WebSocket 기록 전(b928bfa)에 만든 DB — 뒤에 붙인다 (큰 칸이 뒤에 오는 것은 같다)
      if (!(db.prepare('PRAGMA table_info(calls)').all() as Row[]).some((c) => c.name === 'req_full')) db.exec('ALTER TABLE calls ADD COLUMN req_full TEXT');
    } catch (e) { db.close(); throw e; }
    try { fs.chmodSync(file, 0o600); } catch {}
    return new InspectStore(file, db);
  }

  close() { try { this.db.close(); } catch {} }

  private tx<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = f(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  lastN(): number { return Number((this.db.prepare('SELECT MAX(n) AS m FROM calls').get() as Row).m ?? 0); }

  add(rec: InspectRecord) {
    this.db.prepare(`INSERT INTO calls (n, at, ms, method, path, model, status, req_bytes, res_bytes, error, req_headers, res_headers, req_body, res_body, req_full, size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      rec.n, rec.at, rec.ms, rec.method, rec.path, rec.model, rec.status, rec.reqBytes, rec.resBytes, rec.error ?? null,
      JSON.stringify(rec.reqHeaders), JSON.stringify(rec.resHeaders), rec.reqBody, rec.resBody, rec.reqFull ?? null,
      Buffer.byteLength(rec.reqBody) + Buffer.byteLength(rec.resBody) + Buffer.byteLength(rec.reqFull ?? ''));
  }

  /** at 이 (from, to] 인 호출 — 번호 순 */
  calls(from: number, to: number): InspectCall[] {
    const rows = this.db.prepare('SELECT n, at, ms, method, path, model, status, req_bytes, res_bytes, error, dropped FROM calls WHERE at > ? AND at <= ? ORDER BY n')
      .all(Number.isFinite(from) ? from : -1, to) as Row[];
    return rows.map((r) => ({ n: r.n, at: r.at, ms: r.ms, method: r.method, path: r.path, model: r.model, status: r.status, reqBytes: r.req_bytes, resBytes: r.res_bytes,
      ...(r.error != null ? { error: r.error } : {}), ...(r.dropped ? { dropped: true } : {}) }));
  }

  /** 호출 하나 — compact 된 것은 조각으로 다시 조립한다. 지웠거나 없으면 null */
  read(n: number): InspectRecord | null {
    if (!Number.isInteger(n)) return null;
    const r = this.db.prepare('SELECT * FROM calls WHERE n = ?').get(n) as Row | undefined;
    if (!r || r.dropped) return null;
    const part = this.db.prepare('SELECT body FROM parts WHERE hash = ?');
    const expand = (body: string) => (r.compacted ? expandRequest(body, (h) => ((part.get(h) as Row | undefined)?.body ?? null)) : body);
    return { n: r.n, at: r.at, ms: r.ms, method: r.method, path: r.path, model: r.model, status: r.status, reqBytes: r.req_bytes, resBytes: r.res_bytes,
      ...(r.error != null ? { error: r.error } : {}), reqHeaders: JSON.parse(r.req_headers), reqBody: expand(r.req_body), ...(r.req_full != null ? { reqFull: expand(r.req_full) } : {}),
      resHeaders: JSON.parse(r.res_headers), resBody: r.res_body,
      ...(r.compacted ? { compacted: true } : {}) };
  }

  /** 호출 하나의 원본을 지운다 — 이미 compact 됐거나 지웠으면 할 일이 없다. 다시 쓰지 못하는 본문은 그대로 두고 compact 로 표시한다
   *  (이상한 행 하나가 늘 가장 오래된 raw 로 남아 정리를 막지 않게, 리뷰 2026-10-19) */
  private compactOne(n: number) {
    this.tx(() => {
      const r = this.db.prepare('SELECT method, req_body, res_body, req_full, res_headers FROM calls WHERE n = ? AND compacted = 0 AND dropped = 0').get(n) as Row | undefined;
      if (!r) return;
      const putPart = this.db.prepare('INSERT OR IGNORE INTO parts (hash, body) VALUES (?, ?)');
      const putRef = this.db.prepare('INSERT OR IGNORE INTO refs (hash, n) VALUES (?, ?)');
      const parted = (body: string) => { try { return compactRequest(body, (h, json) => { putPart.run(h, json); putRef.run(h, n); }) ?? body; } catch { return body; } };
      const req = parted(r.req_body), full: string | null = r.req_full == null ? null : parted(r.req_full);
      let res: string = r.res_body;
      try {
        const type = String((JSON.parse(r.res_headers) as Record<string, unknown>)['content-type'] ?? '');
        const msg = r.method === 'WS' || type.includes('event-stream') ? sseMessage(r.res_body) : null;
        if (msg) res = JSON.stringify(msg);
      } catch {}
      this.db.prepare('UPDATE calls SET req_body = ?, res_body = ?, req_full = ?, size = ?, compacted = 1 WHERE n = ?')
        .run(req, res, full, Buffer.byteLength(req) + Buffer.byteLength(res) + Buffer.byteLength(full ?? ''), n);
    });
  }

  /** 오래된 raw 부터 k 개 compact */
  compactOldest(k: number) {
    for (const r of this.db.prepare('SELECT n FROM calls WHERE compacted = 0 AND dropped = 0 ORDER BY at LIMIT ?').all(k) as Row[]) this.compactOne(r.n);
  }

  /** 오래된 호출부터 k 개 지운다 — 행은 '지움' 카드로 남기고 본문·헤더와 아무도 안 쓰는 조각만 */
  dropOldest(k: number) {
    this.tx(() => {
      const ns = (this.db.prepare('SELECT n FROM calls WHERE dropped = 0 ORDER BY at LIMIT ?').all(k) as Row[]).map((r) => r.n as number);
      const refsOf = this.db.prepare('SELECT hash FROM refs WHERE n = ?');
      const drop = this.db.prepare("UPDATE calls SET req_body = '', res_body = '', req_full = NULL, req_headers = '{}', res_headers = '{}', size = 0, dropped = 1 WHERE n = ?");
      const unref = this.db.prepare('DELETE FROM refs WHERE n = ?');
      const gc = this.db.prepare('DELETE FROM parts WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM refs WHERE hash = ?)');
      for (const n of ns) {
        const hashes = (refsOf.all(n) as Row[]).map((r) => r.hash as string);
        drop.run(n); unref.run(n);
        for (const h of hashes) gc.run(h, h);
      }
    });
  }

  /** 가장 오래된 호출의 시각 — raw 면 compact 안 된 것 중에서. 없으면 null */
  oldestAt(raw: boolean): number | null {
    const r = this.db.prepare(`SELECT MIN(at) AS a FROM calls WHERE dropped = 0${raw ? ' AND compacted = 0' : ''}`).get() as Row;
    return r.a ?? null;
  }

  rawSize(): number { return Number((this.db.prepare('SELECT SUM(size) AS s FROM calls WHERE compacted = 0 AND dropped = 0').get() as Row).s ?? 0); }

  /** 쓰고 있는 크기 — 빈 페이지는 뺀다 (파일이 줄기 전에도 바로 준다) */
  used(): number {
    const v = (p: string) => Number(Object.values(this.db.prepare(`PRAGMA ${p}`).get() as Row)[0]);
    return (v('page_count') - v('freelist_count')) * v('page_size');
  }

  /** 7일 지난 raw 와 세션 상한을 넘는 raw 를 오래된 것부터 limit 개까지 compact — 쓰는 core 가 호출을 남길 때마다. compact 한 수를 돌려준다 */
  tidy(now = Date.now(), cap = RAW_CAP, age = RAW_AGE_MS, limit = BATCH): number {
    const old = this.db.prepare('SELECT n FROM calls WHERE compacted = 0 AND dropped = 0 AND at < ? ORDER BY at LIMIT ?').all(now - age, limit) as Row[];
    for (const r of old) this.compactOne(r.n);
    let done = old.length, over = done < limit ? this.rawSize() - cap : 0;
    if (over > 0) {
      for (const r of this.db.prepare('SELECT n, size FROM calls WHERE compacted = 0 AND dropped = 0 ORDER BY at LIMIT ?').all(limit - done) as Row[]) {
        if (over <= 0) break;
        this.compactOne(r.n); over -= r.size; done++;
      }
    }
    if (done) this.vacuum();
    return done;
  }

  /** 빈 페이지를 파일에서 돌려받는다. checkpoint 는 PASSIVE — 다른 프로세스의 읽기·쓰기를 기다리지 않는다 (WAL 은 비운 자리를 다시 쓴다) */
  vacuum() {
    try { this.db.exec('PRAGMA incremental_vacuum'); this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
  }
}

// ---- 상태 폴더 전체

/** sessions/<cwd>/<id>/inspect — inspect.db 가 있는 것만 */
function inspectDirs(sessionsDir: string): string[] {
  const ls = (d: string) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
  return ls(sessionsDir).flatMap(ls).map((d) => path.join(d, 'inspect')).filter((d) => InspectStore.exists(d));
}

const tick = () => new Promise<void>((r) => setImmediate(r));

type Stat = { dir: string; used: number; raw: number | null; any: number | null };
const statOf = (dir: string, s: InspectStore): Stat => ({ dir, used: s.used(), raw: s.oldestAt(true), any: s.oldestAt(false) });

/** 모든 세션의 7일 지난 raw 를 compact 하고, 합이 cap 을 넘으면 오래된 raw 부터 compact → 그래도 넘으면 오래된 호출부터 지운다 (세션을 가로질러 시각 순).
 *  DB 는 하나씩 열고 닫는다. 열거나 다루다 실패한 세션은 이번 정리에서 뺀다 (하나 때문에 전체가 멈추지 않게) */
export async function sweepInspect(sessionsDir: string, now = Date.now(), cap = TOTAL_CAP, log: (msg: string) => void = () => {}): Promise<void> {
  const visit = async (dir: string, work: (s: InspectStore) => boolean): Promise<Stat | null> => {
    let s: InspectStore | null = null;
    try {
      s = InspectStore.open(dir);
      while (work(s)) await tick();
      s.vacuum();
      return statOf(dir, s);
    } catch (e) { log(`inspect sweep skipped ${dir}: ${(e as Error).message}`); return null; }
    finally { s?.close(); }
  };
  const stats: Stat[] = [];
  for (const dir of inspectDirs(sessionsDir)) {
    const st = await visit(dir, (s) => s.tidy(now) > 0);
    if (st) stats.push(st);
  }
  let total = stats.reduce((t, x) => t + x.used, 0);
  for (const raw of [true, false]) {
    while (total > cap) {
      const pick = stats.reduce<Stat | null>((m, x) => { const a = raw ? x.raw : x.any; return a !== null && (!m || a < (raw ? m.raw! : m.any!)) ? x : m; }, null);
      if (!pick) break;
      const next = await visit(pick.dir, (s) => { if (raw) s.compactOldest(BATCH); else s.dropOldest(BATCH); return false; });
      stats.splice(stats.indexOf(pick), 1);
      if (!next) { total -= pick.used; continue; }
      stats.push(next);
      total += next.used - pick.used;
      await tick();
    }
  }
}

/** 지난 정리(stamp)에서 every 가 지났으면 잠금을 잡고 sweepInspect. 이미 누가 정리 중(잠금의 pid 가 살아 있음)이면 건너뛴다 — 정리했으면 true */
export async function maybeSweep(stamp: string, lock: string, sessionsDir: string, opts: { now?: number; every?: number; cap?: number; log?: (msg: string) => void } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now(), every = opts.every ?? SWEEP_EVERY_MS;
  const due = () => { try { return now - (Number(JSON.parse(fs.readFileSync(stamp, 'utf8')).at) || 0) >= every; } catch { return true; } };
  if (!due() || !takeLock(lock)) return false;
  try {
    if (!due()) return false; // 잠금을 기다리는 사이 다른 core 가 막 끝냈다
    await sweepInspect(sessionsDir, now, opts.cap ?? TOTAL_CAP, opts.log);
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
