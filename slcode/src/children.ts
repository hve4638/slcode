// 부모 core 쪽 자식 세션 (ticket slcode-subagent-sessions, 사용자 결정 2026-11-07) — 부모 core 가 자식 core 를 띄우고 소유한다.
// 자식의 수명은 소유 연결 하나가 정한다: 부모가 닫히면 자식도 닫고, 부모 프로세스가 죽으면 연결이 끊겨 자식은 소유자 유예 뒤 닫힌다.
// 카드·웹은 자식을 보기만 한다. 같은 연결로 자식의 대기 승인을 들고(부모 화면의 "서브" 승인 줄) 지시를 중계한다 — 잠긴 자식은 이 연결의 요청만 받는다.
import { connectSession, BUILD, PKG, type RpcClient } from './client.js';
import { spawnCore, sockAlive } from './live.js';
import { EventLog } from './eventLog.js';
import { sessionMeta } from './mail.js';
import { CoreError, ERR, type ApprovalRequest, type ChildView, type LoggedEvent, type Methods } from './protocol.js';
import type { CoreOptions } from './core.js';


type Kid = { id: string; sock: string; conn: RpcClient; pending: Map<string, ApprovalRequest>; closing: boolean };
type ChildMethod = 'session.send' | 'session.interrupt' | 'session.approve' | 'session.close';
export type SpawnOptions = Omit<CoreOptions, 'dir' | 'parent' | 'log' | 'resume' | 'fromStart'>;

export class Children {
  private kids = new Map<string, Kid>();
  /** 부모가 닫히거나 교체로 내려간다 — 그 뒤 끊기는 자식은 알리지 않는다 */
  private gone = false;

  constructor(private o: {
    dir: string; sessionsDir: string; parent: string;
    log: (msg: string) => void;
    /** 자식 목록·대기 승인이 바뀌었다 */
    changed: () => void;
    /** 부모가 닫지 않은 자식이 끝났다 */
    exited: (id: string, reason: string) => void;
  }) {}

  /** 새 자식 — 띄우고 소유한다. 소유하지 못하면 띄운 자식을 닫고 던진다 */
  async spawn(opts: SpawnOptions): Promise<string> {
    if (this.gone) throw new CoreError(ERR.badRequest, 'this session is closing');
    const hello = await spawnCore({ ...opts, dir: this.o.dir, parent: { id: this.o.parent, kind: 'child' } });
    try { await this.adopt(hello.id, hello.sock, false); }
    catch (e) {
      try { const c = await connectSession(hello.sock); await c.request('session.close', { id: hello.id }).catch(() => {}); c.close(); } catch {}
      throw e;
    }
    return hello.id;
  }

  /** 기동 때 — 이 세션의 켜진 자식(교체 전의 core 가 띄운 것)을 다시 소유한다. 사람이 따로 소유한 자식은 자식 core 가 거절한다 */
  async adoptLive(): Promise<void> {
    for (const m of EventLog.list(this.o.sessionsDir)) {
      if (m.parent?.kind !== 'child' || m.parent.id !== this.o.parent || this.kids.has(m.id)) continue;
      const sock = new EventLog(this.o.sessionsDir, m).sockPath;
      if (!(await sockAlive(sock))) continue;
      await this.adopt(m.id, sock, true).catch((e) => this.o.log(`child ${m.id} not adopted: ${(e as Error).message}`));
    }
  }

  private async adopt(id: string, sock: string, takeover: boolean): Promise<void> {
    const conn = await connectSession(sock);
    let r: Methods['session.attach']['result'];
    try {
      await conn.request('core.own', { pid: process.pid, follows: true, parent: true, ...(takeover ? { takeover: true } : {}) });
      r = await conn.request('session.attach', { id, since: Number.MAX_SAFE_INTEGER });
    } catch (e) { conn.close(); throw e; }
    const old = this.kids.get(id);
    const kid: Kid = { id, sock, conn, pending: new Map(r.pending.map((p) => [p.requestId, p])), closing: old?.closing ?? false };
    this.kids.set(id, kid);
    this.hook(kid);
    this.o.changed();
    // 이 부모보다 옛 빌드의 자식 core 는 이 판으로 — serve 교체는 메인 core 에만 청한다
    void (async () => {
      const si = await conn.request('server.info');
      if (si.build && si.build < BUILD) await conn.request('core.retire', { pkg: PKG });
    })().catch((e) => this.o.log(`child ${id} replacement not started: ${(e as Error).message}`));
  }

  private hook(kid: Kid) {
    const { conn } = kid;
    let replaced = false, lost = false, reason = 'closed';
    conn.onEvent((m) => {
      if (m.event === 'core.replaced') replaced = true;
      else if (m.event === 'core.owner') lost = true; // 다른 부모 core(교체로 뜬 새 core)가 가져갔다
      else if (m.event === 'session.closed') reason = String((m.params as { reason?: unknown }).reason ?? reason);
      else if (m.event === 'session.event') {
        const ev = (m.params as LoggedEvent).ev;
        if (ev.kind === 'approval.requested') { const { kind: _k, ...req } = ev; kid.pending.set(ev.requestId, req); this.o.changed(); }
        else if (ev.kind === 'approval.resolved' && kid.pending.delete(ev.requestId)) this.o.changed();
      } else if (m.event === 'session.changed') this.o.changed(); // 제목
    });
    void conn.done.then(async () => {
      if (this.kids.get(kid.id) !== kid) return;
      if (replaced && !this.gone) {
        try { await this.adopt(kid.id, kid.sock, false); return; }
        catch (e) { this.o.log(`child ${kid.id} replaced but reconnecting failed: ${(e as Error).message}`); }
      }
      this.kids.delete(kid.id);
      this.o.changed();
      if (!this.gone && !kid.closing && !lost) this.o.exited(kid.id, reason);
    });
  }

  private kid(id: unknown): Kid {
    const k = typeof id === 'string' ? this.kids.get(id) : undefined;
    if (!k) throw new CoreError(ERR.noSession, `${String(id)} is not a live child session of this session`);
    return k;
  }

  /** 자식에게 지시 — 소유 연결로. close 면 부모가 기대한 종료라 끝나도 알리지 않는다 */
  call(id: unknown, method: ChildMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const k = this.kid(id);
    if (method === 'session.close') k.closing = true;
    return k.conn.request(method, { ...params, id: k.id } as never);
  }

  pendingOf(id: unknown, requestId: unknown): ApprovalRequest | null {
    return typeof requestId === 'string' ? this.kid(id).pending.get(requestId) ?? null : null;
  }

  has(id: unknown): boolean { return typeof id === 'string' && this.kids.has(id); }

  list(): ChildView[] {
    return [...this.kids.values()].map((k) => ({ id: k.id, title: sessionMeta(this.o.sessionsDir, k.id)?.title ?? null, pending: [...k.pending.values()] }));
  }

  /** 부모가 닫힌다 — 자식도 닫는다 (사용자 결정 4-1). 닫기 요청만 보내고 기다리지 않는다 */
  closeAll(): void {
    this.gone = true;
    for (const k of this.kids.values()) { k.closing = true; k.conn.request('session.close', { id: k.id }).catch(() => {}); }
  }

  /** 부모가 교체로 내려간다 — 새 부모 core 가 adoptLive 로 다시 소유한다. 알리지 않고 놓는다 */
  release(): void {
    this.gone = true;
    for (const k of this.kids.values()) k.conn.close();
  }
}
