// 리더 core 쪽 팀원 세션 (ticket slcode-team-agent, 사용자 결정 2026-11-07~08 — slcode-subagent-sessions 의 자식 세션을 이었다) — 리더 core 가 팀원 core 를 띄운다.
// link 팀원은 소유 연결 하나를 붙인다: 같은 연결로 팀원의 대기 승인을 들고(리더 화면의 승인 줄) 지시를 중계한다 — 입력 제어 중인 팀원은 이 연결의 요청만 받는다.
// 수명: 리더가 닫히면 수명 연동(endWithLeader) 팀원은 닫고 나머지는 연결만 놓는다. 리더 프로세스가 죽어 연결이 끊기면 수명 연동 팀원은 소유자 유예 뒤 닫히고
// 나머지는 소유자 없이 산다(팀원 core 가 정한다). link 가 꺼진 팀원은 띄우기만 한다 — 리더와 상관없는 보통 세션이다.
// 답하면 닫힘(endWithAnswer) 팀원은 스스로 닫히고(사유 ANSWERED — 끝남 알림을 보내지 않는다), 리더가 다시 시키면 reopen 이 다시 띄워 소유한다.
import { connectSession, BUILD, PKG, type RpcClient } from './client.js';
import { spawnCore, sockAlive } from './live.js';
import { EventLog } from './eventLog.js';
import { sessionMeta } from './mail.js';
import { CoreError, ERR, TEAM_TEMPLATES, type ApprovalRequest, type ChildView, type LoggedEvent, type Methods, type TeamOptions } from './protocol.js';
import type { SessionMeta } from './eventLog.js';
import type { CoreOptions } from './core.js';


/** 답하면 닫힘 팀원이 스스로 닫힐 때의 사유 — 리더는 끝남 알림(kind=closed)을 보내지 않는다 */
export const ANSWERED = 'answered';

type Kid = { id: string; sock: string; conn: RpcClient; pending: Map<string, ApprovalRequest>; closing: boolean };

/** 세션의 관여 옵션 — 팀원이 아니면 null. meta.team 없는 옛 실험 자식(slcode-subagent-sessions, 기본 꺼짐이라 쓴 사람이 없다)은 보통 세션으로 본다 */
export function teamOf(meta: Pick<SessionMeta, 'team'> | null | undefined): TeamOptions | null {
  return meta?.team ?? null;
}
const TEAM_KEYS = Object.keys(TEAM_TEMPLATES.teammate);
/** 옵션 오류 사유 — 모르는 키, 불리언이 아닌 값, link 없이 켠 리더 옵션. 맞으면 null */
export function teamOptionsError(o: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(o)) {
    if (!TEAM_KEYS.includes(k)) return `unknown team option ${k} (${TEAM_KEYS.join('|')})`;
    if (typeof v !== 'boolean') return `team option ${k} must be true or false`;
  }
  const leader = ['inputControl', 'outputToLeader', 'askToLeader', 'endWithLeader', 'endWithAnswer'].filter((k) => o[k]);
  if (!o.link && leader.length) return `${leader.join(', ')} need${leader.length > 1 ? '' : 's'} link (a teammate without link has no leader)`;
  return null;
}
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
    /** 자식과의 연결이 끝났다(이유와 상관없이, 교체로 다시 붙는 것은 빼고) — 그 자식의 답을 기다리던 요청을 푼다 */
    gone: (id: string, reason: string) => void;
  }) {}

  /** 새 팀원 — 띄우고, link 면 소유한다. 소유하지 못하면 띄운 팀원을 닫고 던진다 */
  async spawn(opts: SpawnOptions & { team: TeamOptions }): Promise<string> {
    if (this.gone) throw new CoreError(ERR.badRequest, 'this session is closing');
    if (!opts.team.link) return (await spawnCore({ ...opts, dir: this.o.dir })).id;
    const hello = await spawnCore({ ...opts, dir: this.o.dir, parent: { id: this.o.parent, kind: 'child' } });
    try { await this.adopt(hello.id, hello.sock, false); }
    catch (e) {
      try { const c = await connectSession(hello.sock); await c.request('session.close', { id: hello.id }).catch(() => {}); c.close(); } catch {}
      throw e;
    }
    return hello.id;
  }

  /** 답하고 닫힌 팀원을 다시 띄워 소유한다 (session.childCall 의 session.send). 이 리더의 link 팀원이 아니거나 이미 켜져 있으면 그대로 */
  async reopen(id: string): Promise<void> {
    if (this.gone) throw new CoreError(ERR.badRequest, 'this session is closing');
    const k = this.kids.get(id);
    if (k) {
      if (await sockAlive(k.sock)) return;
      await k.conn.done; // 닫히는 중 — 표에서 빠진 뒤에 다시 띄운다 (hook 의 done 처리가 먼저 돈다)
    }
    const m = sessionMeta(this.o.sessionsDir, id);
    if (m?.parent?.kind !== 'child' || m.parent.id !== this.o.parent) return;
    const hello = await spawnCore({ dir: this.o.dir, cwd: m.cwd, resume: id });
    await this.adopt(hello.id, hello.sock, false);
  }

  /** 기동 때 — 이 세션의 켜진 link 팀원(교체 전의 core 나 닫히기 전의 리더가 띄운 것)을 다시 소유한다. 사람이 따로 소유한 팀원은 팀원 core 가 거절한다 */
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
      this.o.gone(kid.id, reason);
      if (!this.gone && !kid.closing && !lost && reason !== ANSWERED) this.o.exited(kid.id, reason);
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

  /** 리더가 닫힌다 — 수명 연동 팀원은 닫고(사용자 결정 4-1, 닫기 요청만 보내고 기다리지 않는다) 나머지는 연결만 놓는다 */
  closeAll(): void {
    this.gone = true;
    for (const k of this.kids.values()) {
      if (teamOf(sessionMeta(this.o.sessionsDir, k.id))?.endWithLeader === false) { k.conn.close(); continue; }
      k.closing = true; k.conn.request('session.close', { id: k.id }).catch(() => {});
    }
  }

  /** 리더가 교체로 내려간다 — 새 리더 core 가 adoptLive 로 다시 소유한다. 알리지 않고 놓는다 */
  release(): void {
    this.gone = true;
    for (const k of this.kids.values()) k.conn.close();
  }
}
