// 벤더 어댑터의 공통 뼈대 — 세션 id·EventLog·state·seq·구독자·raw 스위치와 emit/info/onEvent/since.
// 벤더별 동작은 추상 메서드로 두고 serve.ts 는 이 표면만 본다 (ticket agent-core-codex, 2026-09-30).
import type { ApprovalDecision, ApprovalRequest, Attachment, CoreEvent, LoggedEvent, RewindPreview, SessionInfo, SessionState, LimitWindow, McpStatus } from './protocol.js';
import { EventLog } from './eventLog.js';

/** Claude 의 effort 이름 (SDK EffortLevel) — 한 곳. CLI 의 --effort 검사와 supportedEffortLevels 를 주지 않는 모델의 efforts. 플러그인 main.js 는 따로 둔다 */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export type ModelsResult = { current: string | null; effort: string | null; models: { value: string; resolvedModel?: string; displayName: string; description: string; efforts?: string[] }[] };
export type Limits = { fiveHour: LimitWindow | null; sevenDay: LimitWindow | null } | null;
export type ContextUsage = { tokens: number; max: number; pct: number } | null;
/** 슬래시 명령 하나 — builtin·aliases 는 Claude SDK 가 준 것(내장 명령 표시와 별칭), kind 'command' 는 에이전트 플러그인 명령(이름은 <플러그인>:<명령>, ticket slcode-agent-plugin-command) */
export type Command = { name: string; description: string; argumentHint: string; builtin?: boolean; aliases?: string[]; kind?: 'command'; complete?: boolean };
export type ApproveOpts = { remember?: boolean; updatedInput?: Record<string, unknown>; message?: string };

/** 새 세션 env 이름이 받을 수 없으면 사유 (ticket slcode-new-session-env, 사용자 결정 2026-11-01) — SLCODE_* 는 slcode 가 넣는 값이라 덮지 못한다 */
export function sessionEnvError(name: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `bad env name '${name}' (letters, digits and _, not starting with a digit)`;
  if (/^SLCODE_/i.test(name)) return `env ${name} is set by slcode — SLCODE_* names cannot be given`;
  return null;
}
/** --env NAME=VALUE 들 → 이름→값. 값 하나에 여러 쌍을 줄바꿈으로 나눠도 된다 — superlite 동사 인자는 같은 option 을 여러 번 주면 마지막 값만 남겨
 *  slcode.new --env 는 줄바꿈으로 받는다. 빈 줄은 건너뛰고 같은 이름은 뒤의 것. 플러그인 main.js 는 같은 규칙을 따로 둔다 */
export function sessionEnv(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of pairs.flatMap((p) => p.split(/\r?\n/))) {
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`--env needs NAME=VALUE: ${line}`);
    const name = line.slice(0, eq), why = sessionEnvError(name);
    if (why) throw new Error(why);
    out[name] = line.slice(eq + 1);
  }
  return out;
}

/** 세션 인자가 에이전트에 들어가는 env 이름 앞부분 (ticket slcode-agent-plugin-part-when, 사용자 결정 2026-11-02) — SLCODE_PARAM_<이름>.
 *  SLCODE_* 라 --env 로는 줄 수 없고, core 는 물려받은 것을 지우고 세션 기록 값만 넣는다 */
export const PARAM_ENV = 'SLCODE_PARAM_';
/** 세션 인자 묶음이 받을 수 없으면 사유 — 이름은 env 이름 글자, 대소문자만 다른 두 이름은 거절(Windows env 는 대소문자를 가리지 않는다) */
export function sessionParamsError(params: Record<string, string>): string | null {
  const seen = new Map<string, string>();
  for (const name of Object.keys(params)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `bad param name '${name}' (letters, digits and _, not starting with a digit)`;
    const up = name.toUpperCase(), other = seen.get(up);
    if (other !== undefined) return `params ${other} and ${name} differ only in case`;
    seen.set(up, name);
  }
  return null;
}
/** --param NAME=VALUE 들 → 이름→값 (ticket slcode-agent-plugin-part-when) — 줄바꿈으로 나눈 여러 쌍·빈 줄·같은 이름은 sessionEnv 와 같다. 플러그인 main.js 는 같은 규칙을 따로 둔다 */
export function sessionParams(pairs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of pairs.flatMap((p) => p.split(/\r?\n/))) {
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq < 0) throw new Error(`--param needs NAME=VALUE: ${line}`);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const why = sessionParamsError(out);
  if (why) throw new Error(why);
  return out;
}

/** effort 가 지금 모델에 없으면 그 모델의 efforts, 맞거나 알 수 없으면 null. 지금 모델 찾기는 화면(web/app.js)과 같고, 모르면 default.
 *  벤더 기동 때 meta.effort 를 이것으로 보고 맞지 않으면 알린 뒤 벤더 기본으로 (ticket slcode-new-effort-prompt, 사용자 결정 2026-10-23) */
export function effortMisfit(r: ModelsResult, effort: string): string[] | null {
  const base = (v?: string | null) => (v ?? '').replace(/\[.*\]$/, '');
  const cur = r.current == null ? r.models.find((m) => m.value === 'default')
    : r.models.find((m) => m.value === r.current) ?? r.models.find((m) => m.value !== 'default' && base(m.resolvedModel) === base(r.current));
  return cur?.efforts && !cur.efforts.includes(effort) ? cur.efforts : null;
}

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

  /** core 가 얹는 세션 정보 — 팀원의 잠김 (ticket slcode-team-agent). meta 에 없는 지금 상태라 info 를 부를 때마다 계산한다 */
  extraInfo: () => Partial<SessionInfo> = () => ({});

  info(): SessionInfo {
    return { ...this.log.meta, state: this.state, live: this.state !== 'exited', seq: this.seq, ...this.extraInfo() };
  }

  onEvent(fn: (e: LoggedEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  since(seq: number): LoggedEvent[] { return this.log.since(seq); }

  /** 벤더가 아니라 core 가 알리는 일 — 기록에 error 이벤트로 남는다 (inspect 를 껐다 등) */
  notice(message: string) { this.emit({ kind: 'error', message }); }
  /** core 가 이 세션을 열었다(기동마다) — 기록에 session.opened 로 남는다 */
  opened(source: 'startup' | 'resume') { this.emit({ kind: 'session.opened', source }); }

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
  abstract mcp(): Promise<McpStatus[]>;
  abstract reconnectMcp(name: string): Promise<McpStatus[]>;
  abstract interrupt(): Promise<void>;
  abstract approve(requestId: string, decision: ApprovalDecision, opts?: ApproveOpts): boolean;
  abstract rewind(seq: number, conversation: boolean, files: boolean): Promise<string[] | null>;
  abstract rewindPreview(seq: number): Promise<RewindPreview>;
  /** quiet 면 session.exit·exited 를 남기지 않는다 — core 교체로 내릴 때 (세션은 새 core 에서 이어진다) */
  abstract close(reason?: string, quiet?: boolean): Promise<void>;
}
