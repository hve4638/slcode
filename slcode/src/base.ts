// 벤더 어댑터의 공통 뼈대 — 세션 id·EventLog·state·seq·구독자·raw 스위치와 emit/info/onEvent/since.
// 벤더별 동작은 추상 메서드로 두고 serve.ts 는 이 표면만 본다 (ticket agent-core-codex, 2026-09-30).
import type { ApprovalDecision, ApprovalRequest, Attachment, CoreEvent, LoggedEvent, SessionInfo, SessionState, LimitWindow } from './protocol.js';
import { EventLog } from './eventLog.js';

export type ModelsResult = { current: string | null; effort: string | null; models: { value: string; resolvedModel?: string; displayName: string; description: string; efforts?: string[] }[] };
export type Limits = { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null } | null;
export type ContextUsage = { tokens: number; max: number; pct: number } | null;
export type Command = { name: string; description: string; argumentHint: string };
export type ApproveOpts = { remember?: boolean; updatedInput?: Record<string, unknown>; message?: string };

export abstract class AgentSession {
  readonly id: string;
  readonly log: EventLog;
  state: SessionState = 'starting';
  protected seq: number;
  protected listeners = new Set<(e: LoggedEvent) => void>();
  protected readonly rawOn: boolean;
  /** 지금 모델 — 벤더가 알려준 값 또는 setModel 값 */
  model: string | null = null;
  /** 지금 effort */
  effort: string | null = null;

  constructor(log: EventLog, raw?: boolean) {
    this.log = log;
    this.id = log.meta.id;
    this.model = log.meta.model ?? null;
    this.effort = log.meta.effort ?? null;
    this.seq = log.lastSeq;
    this.rawOn = raw ?? log.meta.raw;
  }

  get cwd() { return this.log.meta.cwd; }
  get vendorSessionId() { return this.log.meta.vendorSessionId; }

  info(): SessionInfo {
    return { ...this.log.meta, state: this.state, live: this.state !== 'exited', seq: this.seq };
  }

  onEvent(fn: (e: LoggedEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  since(seq: number): LoggedEvent[] { return this.log.since(seq); }

  protected emit(ev: CoreEvent, raw?: unknown) {
    if (ev.kind === 'session.state') this.state = ev.state;
    if (this.rawOn && raw !== undefined) ev = { ...ev, raw };
    const e: LoggedEvent = { seq: ++this.seq, at: Date.now(), ev };
    this.log.append(e);
    for (const l of this.listeners) l(e);
  }

  abstract pendingApprovals(): ApprovalRequest[];
  abstract send(text: string, origin?: string | null, attachments?: Attachment[]): void;
  abstract models(): Promise<ModelsResult>;
  abstract setModel(model: string): Promise<void>;
  abstract setEffort(effort: string): Promise<void>;
  abstract setMode(mode: string): Promise<void>;
  abstract commands(): Promise<Command[]>;
  abstract limits(): Promise<Limits>;
  abstract context(): Promise<ContextUsage>;
  abstract interrupt(): Promise<void>;
  abstract approve(requestId: string, decision: ApprovalDecision, opts?: ApproveOpts): boolean;
  abstract rewind(seq: number, conversation: boolean, files: boolean): Promise<string[] | null>;
  abstract close(reason?: string): Promise<void>;
}
