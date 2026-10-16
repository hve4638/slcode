// 세션별 이벤트 로그 영속 — sessions/<cwd 슬러그>/<id>/meta.json + events.jsonl.
// 한 줄이 LoggedEvent 하나. 프로세스가 죽어도 로그가 남아 attach {since} 재생과 --resume 복원의 바탕이 된다.
// 메모리에도 전체를 들고 있다 (attach 재생이 잦다) — 큰 세션의 상한은 남긴 엣지.
// 옛 평탄 구조 sessions/<id>/ 는 migrate 가 슬러그 아래로 옮긴다 (2026-09-27 이전 세션).
import fs from 'node:fs';
import path from 'node:path';
import type { HistorySummary, LoggedEvent, SessionInfo, Vendor } from './protocol.js';
import { cwdSlug, sessionDir } from './paths.js';

export type SessionMeta = {
  id: string;
  vendor: Vendor;
  cwd: string;
  title: string | null;
  vendorSessionId: string | null;
  createdAt: number;
  /** 마지막 턴이 끝난 시각 */
  updatedAt?: number;
  /** 세션 프로세스가 닫힌 시각 — continue·resume 목록의 꺼진 순서 (없는 옛 세션·비정상 종료는 updatedAt 으로 대신) */
  closedAt?: number;
  permissionMode: string | null;
  raw: boolean;
  /** session.setModel 로 고른 모델 — 없으면 벤더 기본 */
  model?: string | null;
  /** session.setEffort 로 고른 effort — 없으면 벤더 기본 */
  effort?: string | null;
  /** `slcode import --fork` 의 원본 벤더 세션 — Codex 는 첫 기동 때 thread/fork 로 갈라 vendorSessionId 를 얻는다 (Claude 는 import 때 이미 갈랐다) */
  forkFrom?: string | null;
};

/** turn.rewound 가 버린 턴(그 seq 부터)을 뺀 이벤트 — 버린 턴은 벤더 쪽에도 없으므로 대화 되돌리기의 유지 지점·다시 import 의 기준에서 뺀다 */
export function unrewound(events: readonly LoggedEvent[]): LoggedEvent[] {
  const out: LoggedEvent[] = [];
  for (const e of events) { if (e.ev.kind === 'turn.rewound') { const cut = e.ev.seq; while (out.length && out[out.length - 1].seq >= cut) out.pop(); } else out.push(e); }
  return out;
}

/** 화면에 남는 이벤트 — 되돌린 턴을 빼되 끝 이벤트는 남긴다 (앞 턴의 도구·승인 카드를 닫는다). 웹 replayHistory 와 같은 규칙 */
export function visible(events: readonly LoggedEvent[]): LoggedEvent[] {
  let out: LoggedEvent[] = [];
  for (const e of events) {
    if (e.ev.kind === 'turn.rewound') { const cut = e.ev.seq; out = out.filter((x) => x.seq < cut || x.ev.kind === 'tool.end' || x.ev.kind === 'approval.resolved'); }
    out.push(e);
  }
  return out;
}

/** 기록 한 페이지 (ticket slcode-history-paging) — seq before 앞에서 끝부터 화면 항목 limit 개 안의 가장 앞 자름 지점, 없으면 그 너머 첫 지점.
 *  화면 항목은 웹이 그리는 단위라 이어진 같은 범위의 delta 는 하나로 센다. 자름 지점은 열린 도구·승인·작업이 없는 turn.start (웹 pickCut 과 같다) */
export function historyPage(events: readonly LoggedEvent[], before: number, limit: number): { history: LoggedEvent[]; more: boolean } {
  const vis = visible(events);
  const cuts = new Set<number>(), open = new Set<string>();
  for (const { seq, ev } of vis) {
    if (ev.kind === 'turn.start' && !open.size) cuts.add(seq);
    else if (ev.kind === 'session.exit') open.clear(); // 벤더가 끝났다 — 그 전의 도구·작업은 끝 이벤트가 오지 않는다 (남으면 그 뒤로 못 자른다)
    else if (ev.kind === 'tool.start') open.add(ev.toolUseId);
    else if (ev.kind === 'tool.end') open.delete(ev.toolUseId);
    else if (ev.kind === 'approval.requested') open.add(ev.requestId);
    else if (ev.kind === 'approval.resolved') open.delete(ev.requestId);
    else if (ev.kind === 'task') { if (ev.phase === 'ended') open.delete(ev.taskId); else open.add(ev.taskId); }
  }
  let end = vis.length;
  while (end > 0 && vis[end - 1].seq >= before) end--;
  const isDelta = (k: string) => k === 'text.delta' || k === 'thinking.delta';
  let cut = 0, found = 0;
  for (let i = end - 1, n = 0; i >= 0; i--) {
    const e = vis[i].ev, p = vis[i - 1]?.ev;
    if (!(isDelta(e.kind) && p && p.kind === e.kind && (p as { parent?: string }).parent === (e as { parent?: string }).parent)) n++;
    if (cuts.has(vis[i].seq)) found = i;
    if (n >= limit && found) { cut = found; break; } // 처음까지 limit 안에 들면 전부 — 첫 턴 앞 몇 줄만 남은 페이지를 따로 받지 않게
  }
  return { history: vis.slice(cut, end), more: cut > 0 };
}

/** 기록 전체의 합계 — 되돌린 턴도 센다. SDK 비용은 프로세스 누계라 --resume 뒤 0 부터 다시 시작한다: 줄어드는 경계에서 기준선에 합친다 (웹 tally 와 같다) */
export function summarize(events: readonly LoggedEvent[]): HistorySummary {
  const s: HistorySummary = { turns: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null, lastCostUsd: null, hooks: 0, lastHook: null, ready: null };
  let costBase = 0, costLast = 0;
  for (const { ev } of events) {
    if (ev.kind === 'turn.end') {
      s.turns++;
      if (ev.usage) { s.usage.input += ev.usage.input; s.usage.output += ev.usage.output; s.usage.cacheRead += ev.usage.cacheRead; s.usage.cacheWrite += ev.usage.cacheWrite; }
      if (ev.costUsd != null) { if (ev.costUsd < costLast) costBase += costLast; costLast = ev.costUsd; s.costUsd = costBase + costLast; s.lastCostUsd = costLast; }
    } else if (ev.kind === 'hook') { s.hooks++; s.lastHook = `${ev.event} ${ev.phase}`; }
    else if (ev.kind === 'session.ready') { const { raw: _raw, ...ready } = ev; s.ready = ready; }
  }
  return s;
}

/** 유닉스 소켓 경로 상한(sun_path 108바이트)에 여유를 둔 값 — 넘으면 listen 이 EADDRINUSE/ENAMETOOLONG 로 실패한다 (2026-10-04 실측: 워크트리 경로 슬러그) */
const SOCK_PATH_MAX = 100;

export class EventLog {
  readonly dir: string;
  private readonly sessionsDir: string;
  private events: LoggedEvent[] = [];
  private fd: number | null = null;
  meta: SessionMeta;

  constructor(sessionsDir: string, meta: SessionMeta) {
    this.sessionsDir = sessionsDir;
    this.dir = sessionDir(sessionsDir, meta.cwd, meta.id);
    this.meta = meta;
  }

  static metaPath(dir: string) { return path.join(dir, 'meta.json'); }
  static eventsPath(dir: string) { return path.join(dir, 'events.jsonl'); }

  /** 새 로그 — 디렉토리·meta 를 만든다 */
  static create(sessionsDir: string, meta: SessionMeta): EventLog {
    const log = new EventLog(sessionsDir, meta);
    fs.mkdirSync(log.dir, { recursive: true, mode: 0o700 });
    log.writeMeta();
    return log;
  }

  /** 저장된 로그 열기 — 없으면 null. cwd 를 알면 그 슬러그만, 모르면 전체를 찾는다. 깨진 줄은 건너뛴다 (죽을 때 반쯤 쓴 마지막 줄) */
  static open(sessionsDir: string, id: string, cwd?: string): EventLog | null {
    const dir = cwd ? sessionDir(sessionsDir, cwd, id) : EventLog.find(sessionsDir, id);
    if (!dir) return null;
    let meta: SessionMeta;
    try { meta = JSON.parse(fs.readFileSync(EventLog.metaPath(dir), 'utf8')); } catch { return null; }
    const log = new EventLog(sessionsDir, meta);
    let text = '';
    try { text = fs.readFileSync(EventLog.eventsPath(dir), 'utf8'); } catch {}
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line) as LoggedEvent; if (typeof e.seq === 'number') log.events.push(e); } catch {}
    }
    return log;
  }

  /** 세션 폴더 찾기 — cwd 없이 id 만 알 때 (CLI 관리 명령). 슬러그 폴더를 훑는다 */
  static find(sessionsDir: string, id: string): string | null {
    let slugs: string[] = [];
    try { slugs = fs.readdirSync(sessionsDir); } catch { return null; }
    for (const s of slugs) { const d = path.join(sessionsDir, s, id); if (fs.existsSync(EventLog.metaPath(d))) return d; }
    return null;
  }

  /** 저장 세션 meta — cwd 를 주면 그 슬러그 폴더만 (--continue), 없으면 전부 */
  static list(sessionsDir: string, cwd?: string): SessionMeta[] {
    const slugs = cwd ? [cwdSlug(cwd)] : (() => { try { return fs.readdirSync(sessionsDir); } catch { return []; } })();
    const out: SessionMeta[] = [];
    for (const s of slugs) {
      let ids: string[] = [];
      try { ids = fs.readdirSync(path.join(sessionsDir, s)); } catch { continue; }
      for (const id of ids) { try { out.push(JSON.parse(fs.readFileSync(EventLog.metaPath(path.join(sessionsDir, s, id)), 'utf8'))); } catch {} }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 옛 평탄 구조 sessions/<id>/meta.json 을 sessions/<슬러그>/<id>/ 로. 한 번 옮기면 다시 볼 일 없다.
   *  옛 중앙 core(core.pid)가 아직 살아 있으면 건드리지 않는다 — 그 core 가 meta 를 옛 경로에 다시 쓴다 */
  static migrate(sessionsDir: string): number {
    let n = 0;
    let names: string[] = [];
    try { names = fs.readdirSync(sessionsDir); } catch { return 0; }
    try { const pid = Number(fs.readFileSync(path.join(sessionsDir, '..', 'core.pid'), 'utf8')) || 0; if (pid) { process.kill(pid, 0); return 0; } } catch {}
    for (const name of names) {
      const old = path.join(sessionsDir, name);
      let meta: SessionMeta;
      try { meta = JSON.parse(fs.readFileSync(EventLog.metaPath(old), 'utf8')); } catch { continue; }
      const dst = sessionDir(sessionsDir, meta.cwd, meta.id);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      try { fs.renameSync(old, dst); n++; } catch { /* 같이 뜬 다른 프로세스가 먼저 옮겼다 (2026-09-27 실측) */ }
    }
    return n;
  }

  static remove(sessionsDir: string, id: string) {
    const d = EventLog.find(sessionsDir, id);
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }

  get lastSeq(): number { return this.events.length ? this.events[this.events.length - 1].seq : 0; }
  get all(): readonly LoggedEvent[] { return this.events; }

  since(seq: number): LoggedEvent[] {
    // seq 는 단조 증가 — 이진 탐색으로 시작점
    let lo = 0, hi = this.events.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.events[mid].seq <= seq) lo = mid + 1; else hi = mid; }
    return this.events.slice(lo);
  }

  append(e: LoggedEvent) {
    this.events.push(e);
    if (this.fd === null) this.fd = fs.openSync(EventLog.eventsPath(this.dir), 'a', 0o600);
    fs.writeSync(this.fd, JSON.stringify(e) + '\n');
  }

  updateMeta(patch: Partial<SessionMeta>) {
    this.meta = { ...this.meta, ...patch };
    this.writeMeta();
  }

  private writeMeta() {
    const tmp = EventLog.metaPath(this.dir) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.meta), { mode: 0o600 });
    fs.renameSync(tmp, EventLog.metaPath(this.dir));
  }

  close() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; } }

  /** 이 세션 프로세스의 소켓 경로 — 세션 폴더의 sock. cwd 슬러그가 길어 소켓 경로 상한을 넘으면 `<SLCODE_DIR>/sock/<id>` (id 만으로 정해지므로 클라이언트도 같은 값을 계산한다) */
  get sockPath(): string {
    const p = path.join(this.dir, 'sock');
    return Buffer.byteLength(p) <= SOCK_PATH_MAX ? p : path.join(this.sessionsDir, '..', 'sock', this.meta.id);
  }

  /** 저장만 된 세션의 SessionInfo (live=false, state=exited) */
  storedInfo(): SessionInfo {
    return { ...this.meta, state: 'exited', live: false, seq: this.lastSeq };
  }
}
