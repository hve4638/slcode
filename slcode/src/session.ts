// Claude 어댑터 — 세션 하나 = SDK query() 하나 (streaming input, 상시 프로세스, t3code ClaudeAdapter 와 같은 꼴).
// SDK 메시지를 protocol.ts 의 벤더 중립 이벤트로 정규화해 EventLog 에 남기고 구독자에게 낸다.
// 승인(canUseTool)은 Deferred 로 무기한 기다린다 — interrupt·close·프로세스 종료만 cancelled 로 푼다 (사용자 결정 2026-09-26).
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { AgentCommandEvent, AgentHookEvent, ApprovalDecision, ApprovalRequest, Attachment, CoreEvent, RewindPreview, Usage, LimitWindow, McpStatus } from './protocol.js';
import { EventLog, unrewound } from './eventLog.js';
import { AgentSession, CLAUDE_EFFORTS, effortMisfit, type ApproveOpts, type Command } from './base.js';
import { SLCODE_PROMPT } from './prompt.js';
import type { ClaudeLoad } from './profiles.js';

/** push 와 비동기 순회를 잇는 무한 큐 — streaming input 의 프롬프트 공급원 */
class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: ((v: T) => void)[] = [];
  push(v: T) { const w = this.waiters.shift(); if (w) w(v); else this.values.push(v); }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) yield this.values.length ? this.values.shift()! : await new Promise<T>((r) => this.waiters.push(r));
  }
}

type Pending = ApprovalRequest & { resolve: (r: PermissionResult) => void };

/** Claude Code TUI 가 거절에 사용자 피드백을 붙일 때의 앞말 (cli 2.1.282·2.1.319 같은 문구) */
const REJECT_WITH_FEEDBACK = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n";

/** 텍스트 + 첨부 → Messages API content 블록. 이미지·PDF 는 벤더 블록, 그 밖은 UTF-8 로 풀어 본문에 인라인 (ponytail: 바이너리 판별 없음 — 프런트가 이미지·PDF·텍스트류만 보낸다) */
export function buildContent(text: string, attachments: Attachment[] = []): string | unknown[] {
  if (!attachments.length) return text;
  const blocks: unknown[] = [];
  const inline: string[] = [];
  for (const a of attachments) {
    if (/^image\/(png|jpeg|gif|webp)$/.test(a.mediaType)) blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
    else if (a.mediaType === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: a.mediaType, data: a.data } });
    else inline.push(`<file name="${a.name}">\n${Buffer.from(a.data, 'base64').toString('utf8')}\n</file>`);
  }
  const body = [...inline, text].filter(Boolean).join('\n\n');
  if (body) blocks.push({ type: 'text', text: body });
  return blocks;
}

export type SessionOptions = {
  log: EventLog;
  /** 벤더 세션 id 로 이어받기 (복원·벤더 CLI 에서 넘어온 세션) */
  resume?: string | null;
  permissionMode?: string | null;
  /** 이벤트에 SDK 원문을 raw 로 싣는다 */
  raw?: boolean;
  /** SDK 가 부모 세션의 표식을 물려받지 않게 정리된 env (core.ts STRIP_ENV) */
  env?: NodeJS.ProcessEnv;
  /** slcode 에이전트 플러그인 (agentPlugins.loadSessionPlugins) — 플러그인 폴더·지시문·session.json·env. 벤더를 다시 띄워도(rewind·reopen) 같은 값 */
  agent?: { plugins: { type: 'local'; path: string }[]; append: string; settings: Record<string, unknown> | null; env: Record<string, string> };
  /** 세션 시작 프로필의 Claude 쪽 (profiles.claudeLoad) — 없으면 CLI 와 같은 로드 */
  load?: ClaudeLoad;
  /** 에이전트 플러그인 js/ts 훅의 디스패처 (hookRunner.sdkHooks, ticket slcode-agent-plugin-hooks) — SDK options.hooks */
  hooks?: Options['hooks'];
  /** 팀 지시 (prompt.familyPrompt, ticket slcode-team-agent) — SLCODE_PROMPT 바로 뒤에. 없으면 빈 문자열 */
  family?: string;
  /** 팀원 도구 (teamTools.teamMcp, ticket slcode-team-agent) — 팀원을 만들 수 있는 세션의 in-process MCP 서버. 벤더를 다시 띄울 때(rewind)마다 새 인스턴스로 */
  mcpServers?: () => Options['mcpServers'];
  /** 질문 도구(AskUserQuestion)를 끈다 — 답하면 닫히는 팀원은 사람을 기다리지 않는다 (Claude 서브에이전트와 같다) */
  noAsk?: boolean;
  /** 승인 없이 쓰는 도구 — 팀원 도구는 Claude 의 Agent 도구처럼 묻지 않는다 (사용자 2026-11-08) */
  allowedTools?: string[];
};

export function summarize(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 400);
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : `[${c?.type}]`)).join('').slice(0, 400);
  return '';
}

/** 서브에이전트 안에서 난 메시지면 { parent } — 본문이면 빈 객체 (이벤트에 필드가 안 생긴다) */
function parentOf(m: any): { parent?: string } { return typeof m?.parent_tool_use_id === 'string' ? { parent: m.parent_tool_use_id } : {}; }

function usageOf(u: any): Usage | null {
  if (!u) return null;
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
}

export class ClaudeSession extends AgentSession {
  private input = new AsyncQueue<SDKUserMessage>();
  private q: Query | null = null;
  private pending = new Map<string, Pending>();
  private ended = false;
  /** close(quiet) — core 교체로 내렸다. 끝난 뒤의 exited 도 남기지 않는다 */
  private quiet = false;
  private opts: SessionOptions;
  private running: Promise<void> = Promise.resolve();
  private restarting = false;
  /** 대화 되돌리기: 다음 run 의 resumeSessionAt */
  private resumeAt: string | null = null;
  /** 보낸 순서대로의 사용자 메시지 uuid (우리가 정해 보낸다 — SDK 의 submitMessage options.uuid 와 같은 자리). 턴이 끝날 때 하나씩 꺼낸다 */
  private turnUuids: string[] = [];
  private lastUuid: string | null = null;
  /** 이 턴의 벤더 오류 — 본문 assistant 메시지의 error 칸(SDKAssistantMessageError)과 그 synthetic 문구. result 때 turn.end 로 옮기고 비운다 */
  private turnError: { code: string; text: string | null } | null = null;

  constructor(opts: SessionOptions) {
    super(opts.log, opts.raw);
    this.opts = opts;
    this.running = this.run(opts);
    // init 은 첫 프롬프트 뒤에야 온다 — 그 전도 보낼 수 있는 상태. starting 에 두면 첫 턴이 running 을 거치지 않고 idle 로만 보인다 (ticket slcode-first-turn-shows-idle)
    if (this.state === 'starting') this.emit({ kind: 'session.state', state: 'idle' }); // run 이 첫 await 전에 실패해 이미 exited 일 수 있다
  }

  pendingApprovals(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ resolve: _r, ...p }) => p);
  }

  /** 턴 넣기 — 한 호출. 큐에 넣으면 CLI 가 집어간다. running 이면 SDK 가 다음 도구 결과와 함께 같은 턴에 넣는다 (도구 호출이 더 없으면 그 턴 뒤 새 턴 — SDK 0.3.282 실측 2026-11-07) */
  send(text: string, origin: string | null = null, attachments: Attachment[] = []) {
    // 로그에는 첨부의 이름·종류·크기만 — base64 본문은 events.jsonl 에 남기지 않는다 (ponytail: 재접속 화면엔 이름만 보인다)
    this.emit({ kind: 'turn.start', text, origin, ...(attachments.length ? { attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, size: Buffer.byteLength(a.data, 'base64') })) } : {}) });
    if (this.state === 'idle') this.emit({ kind: 'session.state', state: 'running' });
    const uuid = randomUUID();
    this.turnUuids.push(uuid);
    this.input.push({ type: 'user', uuid, message: { role: 'user', content: buildContent(text, attachments) as any }, parent_tool_use_id: null } as unknown as SDKUserMessage);
  }

  /** 벤더 모델 목록 — SDK 가 init 뒤에 답한다 */
  async models() {
    const list = this.q ? await this.q.supportedModels() : [];
    // 첫 턴 전(init 전)엔 모델·effort 를 모른다 — SDK getSettings 의 applied 로 채운다 (--resume 직후, 2026-09-27 실측)
    if (this.q && (!this.model || !this.effort)) {
      const applied = (await (this.q as any).getSettings())?.applied ?? {}; // getSettings 는 0.3.282 의 Query 타입에 없다 (런타임엔 있다)
      this.model ??= applied.model ?? null; this.effort ??= applied.effort ?? null;
    }
    return { current: this.model, effort: this.effort, models: list.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel, displayName: m.displayName, description: m.description, efforts: (m.supportedEffortLevels as string[] | undefined) ?? CLAUDE_EFFORTS })) };
  }

  /** 플랜 리밋 창 — SDK 의 /usage 자료(실험 메서드, 0.3.282). 벤더가 안 떠 있거나 플랜이 없으면 null. 한 번에 1.5초쯤 (2026-09-29 실측) */
  async limits(): Promise<{ fiveHour: LimitWindow | null; sevenDay: LimitWindow | null } | null> {
    if (!this.q) return null;
    try {
      const u = await (this.q as any).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      if (!u?.rate_limits_available || !u.rate_limits) return null;
      const w = (x: any): LimitWindow | null => (x ? { pct: x.utilization ?? null, resetsAt: x.resets_at ?? null } : null);
      return { fiveHour: w(u.rate_limits.five_hour), sevenDay: w(u.rate_limits.seven_day) };
    } catch { return null; }
  }

  /** 권한 모드 — 즉시. meta 에 남겨 복원 때 options.permissionMode 로 넘긴다 */
  async setMode(mode: string) {
    await this.q?.setPermissionMode(mode as any);
    this.log.updateMeta({ permissionMode: mode });
  }

  /** 슬래시 명령 목록 — SDK supportedCommands (중간에 바뀌면 SDK 가 최신을 준다) */
  async commands(): Promise<Command[]> {
    if (!this.q) return [];
    try { return (await this.q.supportedCommands()).map((c) => ({ name: c.name, description: c.description ?? '', argumentHint: c.argumentHint ?? '', ...(c.builtin ? { builtin: true } : {}), ...(c.aliases?.length ? { aliases: c.aliases } : {}) })); } catch { return []; }
  }

  /** 컨텍스트 창 사용량 — SDK getContextUsage(summary). 벤더가 안 떠 있으면 null */
  async context(): Promise<{ tokens: number; max: number; pct: number } | null> {
    if (!this.q) return null;
    try { const c = await this.q.getContextUsage({ detail: 'summary' }); return { tokens: c.totalTokens, max: c.maxTokens, pct: c.percentage }; }
    catch { return null; }
  }

  /** MCP 서버 상태 — SDK mcpServerStatus (failed 면 error 에 사유). 벤더가 안 떠 있으면 [] */
  async mcp(): Promise<McpStatus[]> {
    if (!this.q) return [];
    try { return (await this.q.mcpServerStatus()).map((m) => ({ name: m.name, status: m.status, ...(m.error ? { error: m.error } : {}) })); }
    catch { return []; }
  }

  /** MCP 서버 하나 다시 연결 — SDK 는 실패면 던진다. 결과는 목록으로 돌려주고, 목록에 사유가 없으면 던진 메시지를 싣는다. 목록에 없는 이름이면 던진다 */
  async reconnectMcp(name: string): Promise<McpStatus[]> {
    if (!this.q) throw new Error('vendor is not running');
    let thrown: string | null = null;
    try { await this.q.reconnectMcpServer(name); } catch (e) { thrown = e instanceof Error ? e.message : String(e); }
    const list = await this.mcp();
    if (thrown && !list.some((m) => m.name === name)) throw new Error(thrown);
    return thrown ? list.map((m) => (m.name === name && !m.error ? { ...m, error: thrown } : m)) : list;
  }

  /** 다음 턴부터 쓸 effort. SDK 의 세션 한정 설정층이라 설정 파일엔 안 쓴다. meta 에 남겨 복원 때 options.effort 로 넘긴다 */
  async setEffort(effort: string) {
    await this.q?.applyFlagSettings({ effortLevel: effort as any });
    this.effort = effort;
    this.log.updateMeta({ effort });
  }

  /** 기동 때 meta.effort 가 지금 모델에 없으면 알리고 모델 기본 effort 로 (effortMisfit). 첫 프롬프트와 나란히 돌아 첫 턴은 SDK 가
   *  그 모델에 맞게 조용히 낮춘 값으로 돌 수 있다 */
  private async fitEffort(q: Query) {
    try {
      const fit = this.effort ? effortMisfit(await this.models(), this.effort) : null;
      if (!fit || this.q !== q) return;
      this.notice(`effort ${this.effort} 는 ${this.model} 모델에서 쓸 수 없습니다 (${fit.join('|')}) — 벤더 기본 effort 로 돕니다`);
      await q.applyFlagSettings({ effortLevel: null as any }); // null 은 모델 기본으로 (SDK applyFlagSettings)
      this.effort = null;
      this.log.updateMeta({ effort: null });
    } catch { /* 벤더가 내려갔다 — 다음 기동 때 다시 본다 */ }
  }

  /** 다음 턴부터 쓸 모델. meta 에 남겨 복원 때 options.model 로 넘긴다 */
  async setModel(model: string) {
    await this.q?.setModel(model);
    this.model = model;
    this.log.updateMeta({ model });
  }

  async interrupt() {
    // 진행 턴을 끊으면 그 턴의 승인 대기도 뜻을 잃는다 — cancelled 로 푼다
    this.cancelPending('interrupted');
    await this.q?.interrupt();
  }

  /** 승인 응답 — requestId 로 대기 중인 canUseTool 을 깨운다 */
  approve(requestId: string, decision: ApprovalDecision, opts: ApproveOpts = {}): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.emit({ kind: 'approval.resolved', requestId, decision });
    if (this.pending.size === 0 && this.state === 'requires_action') this.emit({ kind: 'session.state', state: 'running' });
    if (decision === 'allow') {
      const result: PermissionResult = { behavior: 'allow', updatedInput: (opts.updatedInput ?? p.input) as Record<string, unknown> };
      if (opts.remember) result.updatedPermissions = sessionScoped(p.suggestions as PermissionUpdate[], p.name);
      p.resolve(result);
    } else if (opts.interrupt) {
      // Claude Code 의 Esc·거절 — SDK deny interrupt 는 TUI 와 같은 기록(거절 문구 + [Request interrupted by user for tool use])을 남기고 턴을 끝낸다. message 는 쓰이지 않는다 (2.1.282·2.1.319 실측 2026-11-08)
      p.resolve({ behavior: 'deny', message: '', interrupt: true });
      this.cancelPending('interrupted');
    } else {
      // SDK 는 message 를 tool_result 에 그대로 쓴다 — TUI 가 피드백을 붙일 때의 앞말을 같이 넘긴다 (Chat about this 등, 2.1.319 실측)
      p.resolve({ behavior: 'deny', message: opts.message ? `${REJECT_WITH_FEEDBACK}${opts.message}` : 'denied by user' });
    }
    return true;
  }

  private cancelPending(reason: string) {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: reason });
      this.emit({ kind: 'approval.resolved', requestId: id, decision: 'cancelled' });
    }
    this.pending.clear();
  }

  /** 턴 되돌리기 — seq 의 turn.start 부터 버린다. files 는 SDK rewindFiles(그 턴의 사용자 메시지 uuid), conversation 은 벤더 세션을 앞 턴의 마지막 uuid 에서 다시 연다(첫 턴이면 새 벤더 세션) */
  async rewind(seq: number, conversation: boolean, files: boolean): Promise<string[] | null> {
    if (this.state !== 'idle') throw new Error('rewind needs an idle session');
    // 되돌림을 반영한 로그 — 앞선 turn.rewound 가 버린 턴은 벤더 쪽에도 없으므로 유지 지점 후보에서 뺀다 (2026-09-27 실측: 버린 턴의 uuid 로 다시 열면 No message found)
    const evs = unrewound(this.log.since(0));
    const i = evs.findIndex((e) => e.seq === seq && e.ev.kind === 'turn.start');
    if (i < 0) throw new Error(`no turn at seq ${seq}`);
    const end = evs.slice(i).find((e) => e.ev.kind === 'turn.end')?.ev as Extract<CoreEvent, { kind: 'turn.end' }> | undefined;
    // 유지 지점: 앞 턴의 끝, 또는 가져온 표지(slcode import) — 표지는 가져온 턴들 뒤에 서고 uuid 는 그때 벤더 쪽 마지막 항목이다. 대상보다 앞의 것만 본다
    const prev = evs.slice(0, i).reverse().find((e) => e.ev.kind === 'turn.end' || e.ev.kind === 'session.imported')?.ev as Extract<CoreEvent, { kind: 'turn.end' | 'session.imported' }> | undefined;
    let filesChanged: string[] | null = null;
    if (files) {
      if (!end?.userUuid || !this.q) throw new Error('no checkpoint for that turn');
      const r = await this.q.rewindFiles(end.userUuid);
      if (!r.canRewind) throw new Error(r.error ?? 'cannot rewind files');
      filesChanged = r.filesChanged ?? [];
    }
    if (conversation) {
      // 표지에 uuid 가 없으면 새 벤더 세션으로 갈 수밖에 없다 — 가져온 대화가 사라진다
      if (prev?.kind === 'session.imported' && !prev.uuid) throw new Error('cannot rewind before the imported conversation');
      this.resumeAt = prev?.uuid ?? null;
      if (!this.resumeAt) this.log.updateMeta({ vendorSessionId: null });
      this.restarting = true;
      try { (this.q as any)?.return?.(); } catch {}
      await this.running;
      this.lastUuid = this.resumeAt; // 벤더 쪽 마지막 항목은 이제 유지 지점 — 다음 turn.end 가 옛 uuid 를 물지 않게
      this.input = new AsyncQueue(); // 옛 생성기의 대기자가 큐에 남아 새 프롬프트를 삼킨다 (2026-09-27 실측) — idle 이라 잃는 메시지는 없다
      this.running = this.run({ ...this.opts, resume: null });
      this.emit({ kind: 'session.state', state: 'idle' }); // 새 프로세스의 init 은 다음 프롬프트 뒤에 온다 — 보낼 수 있는 상태
    }
    this.emit({ kind: 'turn.rewound', seq, conversation, files, filesChanged });
    return filesChanged;
  }

  /** 되돌리기 미리 보기 — rewind 와 같은 턴·유지 지점을 보고 파일은 SDK dry-run 으로만 잰다 */
  async rewindPreview(seq: number): Promise<RewindPreview> {
    const evs = unrewound(this.log.since(0));
    const i = evs.findIndex((e) => e.seq === seq && e.ev.kind === 'turn.start');
    if (i < 0) throw new Error(`no turn at seq ${seq}`);
    const end = evs.slice(i).find((e) => e.ev.kind === 'turn.end')?.ev as Extract<CoreEvent, { kind: 'turn.end' }> | undefined;
    const prev = evs.slice(0, i).reverse().find((e) => e.ev.kind === 'turn.end' || e.ev.kind === 'session.imported')?.ev as Extract<CoreEvent, { kind: 'turn.end' | 'session.imported' }> | undefined;
    const lost = prev?.kind === 'session.imported' && !prev.uuid;
    let files: RewindPreview['files'] = null;
    if (end?.userUuid && this.q) {
      const r = await this.q.rewindFiles(end.userUuid, { dryRun: true });
      if (r.canRewind) files = { changed: r.filesChanged ?? [], insertions: r.insertions ?? 0, deletions: r.deletions ?? 0 };
    }
    return { conversation: !lost, files, ...(lost ? { error: 'cannot rewind before the imported conversation' } : {}) };
  }

  /** 벤더 프로세스를 같은 대화로 env 만 바꿔 다시 띄운다 — inspect 토글 (ticket slcode-inspect-proxy). rewind 의 재기동과 같은 길이고, 세션 한정 승인 규칙은 잃는다 */
  /** 보냈지만 아직 turn.end 가 오지 않은 턴 수 — idle 경계에서도 다음 턴이 줄 서 있을 수 있다 (CLI 가 곧 집어간다) */
  get queued(): number { return this.turnUuids.length; }

  async reopen(env: NodeJS.ProcessEnv) {
    if (this.state !== 'idle' && this.state !== 'starting') throw new Error('reopen needs an idle session');
    // 줄 선 턴이 있으면 옛 프로세스와 함께 사라진다 (그 턴의 turn.end 가 오지 않는다) — 그 턴이 끝난 뒤에
    if (this.queued) throw new Error('reopen needs an idle session with no queued turn');
    this.opts = { ...this.opts, env };
    this.restarting = true;
    // 큐를 먼저 바꾼다 — 옛 프로세스가 내려가는 사이에 온 프롬프트는 새 큐에 쌓여 새 프로세스가 받는다 (옛 생성기의 대기자가 삼키지 않게)
    this.input = new AsyncQueue();
    try { (this.q as any)?.return?.(); } catch {}
    await this.running;
    if (this.ended) return; // 기다리는 사이에 닫혔다
    this.running = this.run({ ...this.opts, resume: null });
  }

  /** 에이전트 플러그인을 디스크에서 다시 싣는다 — SDK reloadPlugins(). 링크는 부른 쪽이 먼저 바꾼다. 지시문은 바뀌지 않는다 (시스템 프롬프트는 첫 요청 때 고정) */
  async reloadPlugins() {
    if (!this.q) throw new Error('vendor is not running');
    return this.q.reloadPlugins();
  }

  /** 다시 싣기의 결과를 기록에 — core 가 링크를 바꾸고 reloadPlugins() 를 부른 뒤 */
  emitPlugins(body: Omit<Extract<CoreEvent, { kind: 'plugins.reloaded' }>, 'kind'>) { this.emit({ kind: 'plugins.reloaded', ...body }); }
  /** init 의 skill 목록에서 프로필이 숨긴 것을 뺀다 — SDK 는 허용 목록 밖의 skill 도 init 에 그대로 보고한다 (0.3.282 실측) */
  private shownSkills(skills: string[]): string[] {
    const allow = this.opts.load?.skills;
    return allow ? skills.filter((s) => allow.includes(s)) : skills;
  }

  /** js/ts 훅의 기록 (hookRunner) */
  emitHook(ev: AgentHookEvent | AgentCommandEvent) { if (!this.ended) this.emit(ev); }

  async close(reason = 'closed', quiet = false) {
    if (this.ended) return;
    this.ended = true;
    this.quiet = quiet;
    this.cancelPending('session closed');
    try { await this.q?.interrupt(); } catch {}
    try { (this.q as any)?.return?.(); } catch {}
    if (!quiet) {
      this.emit({ kind: 'session.exit', reason });
      this.emit({ kind: 'session.state', state: 'exited' });
    }
    // 교체 — 새 core 가 같은 대화를 resume 하기 전에 claude 자식이 내려가 있게 (상한은 core 의 CLOSE_DEADLINE_MS)
    else await this.running.catch(() => {});
    this.log.close();
  }

  private async run(opts: SessionOptions) {
    const resume = opts.resume ?? this.log.meta.vendorSessionId ?? undefined;
    const permissionMode = opts.permissionMode ?? this.log.meta.permissionMode ?? undefined;
    // 플러그인 session.json 위에 프로필의 CLAUDE.md 빼기 — 플러그인이 정한 것과 합친다
    const excludes = [...((opts.agent?.settings?.claudeMdExcludes as string[] | undefined) ?? []), ...(opts.load?.claudeMdExcludes ?? [])];
    // Remote Control 은 늘 자동으로 켜지 않는다 — 사용자 설정을 끈 프로필이면 ~/.claude 의 false 가 안 실려 계정 기본값으로 켜질 수 있다 (사용자 결정 2026-10-30)
    const settings = { ...opts.agent?.settings, ...(excludes.length ? { claudeMdExcludes: excludes } : {}), remoteControlAtStartup: false };
    const q = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        includePartialMessages: true,
        enableFileCheckpointing: true,
        includeHookEvents: true,
        forwardSubagentText: true,      // 서브에이전트의 텍스트·thinking 도 parent_tool_use_id 를 달고 온다 — 작업 카드 안에 중첩해 그린다
        agentProgressSummaries: true,   // task_progress 에 한 줄 진행 요약 (약 30초마다 짧은 포크, 비용은 작다)
        thinking: { type: 'adaptive', display: 'summarized' },
        // slcode 고정 지시를 기본 프롬프트 뒤에 (ticket slcode-append-system-prompt). 에이전트 플러그인의 지시문은 그 뒤에 (ticket slcode-agent-plugin)
        systemPrompt: { type: 'preset', preset: 'claude_code', append: [SLCODE_PROMPT, opts.family, opts.agent?.append].filter(Boolean).join('\n\n') },
        // snapshot 을 끈다 — 켜 두면 첫 요청 때 기록한 시스템 프롬프트를 resume 이 그대로 보내 바뀐 지시문이 안 들어가고, import 한 세션은 그쪽 기록이라 위 append 가 빠진다.
        // SDK 옵션 systemPromptSnapshot:false 는 resume 에 듣지 않아 CLI 플래그로 (CLI 2.1.282 실측, ticket slcode-agent-plugin-instructions-resume, 사용자 결정 2026-11-02)
        extraArgs: { 'system-prompt-snapshot': 'off' },
        // slcode 에이전트 플러그인 — 세션 폴더의 링크 경로를 <이름>@inline 으로 싣는다. 사용자 설정·설치 기록은 건드리지 않는다
        ...(opts.agent?.plugins.length ? { plugins: opts.agent.plugins } : {}),
        settings: settings as any,
        ...(opts.hooks ? { hooks: opts.hooks } : {}),
        ...(opts.mcpServers ? { mcpServers: opts.mcpServers() } : {}),
        ...(opts.noAsk ? { disallowedTools: ['AskUserQuestion'] } : {}),
        ...(opts.allowedTools?.length ? { allowedTools: opts.allowedTools } : {}),
        // 기본은 CLI 와 같은 로드 — user/project/local (스파이크 (a) 실측: 플러그인·스킬·훅·MCP 가 CLI 와 같다). 프로필이 줄이고 skill 을 거른다 (ticket slcode-session-profile)
        settingSources: opts.load?.settingSources ?? ['user', 'project', 'local'],
        ...(opts.load?.skills ? { skills: opts.load.skills } : {}),
        // IS_SANDBOX=1 을 늘 얹는다 — uid 0 이면 CLI 가 이것 없이는 아래 skip 플래그나 bypass 모드만으로 첫 턴 전에 exit 1 한다 (CLI 2.1.282, 2026-10-08 실측, 값은 '1' 만).
        // root 에서도 bypass 를 쓰게 Claude Code 의 이 안전 장치를 slcode 가 끈다 (사용자 결정 2026-10-09).
        // CLAUDE_CODE_DISABLE_ARTIFACT=1 도 늘 — 셸의 같은 값은 STRIP_ENV(CLAUDE_*)가 지우므로 여기서 다시 넣는다 (사용자 결정 2026-10-30)
        env: { ...(opts.env ?? process.env), ...opts.agent?.env, ...opts.load?.env, IS_SANDBOX: '1', CLAUDE_CODE_DISABLE_ARTIFACT: '1' },
        ...(permissionMode ? { permissionMode: permissionMode as any } : {}),
        allowDangerouslySkipPermissions: true, // bypassPermissions 로 바꿀 수 있게 (그 자체로 우회하지 않는다 — 모드는 위 permissionMode)
        ...(this.log.meta.model ? { model: this.log.meta.model } : {}),
        ...(this.log.meta.effort ? { effort: this.log.meta.effort as any } : {}),
        ...(resume ? { resume, ...(this.resumeAt ? { resumeSessionAt: this.resumeAt } : {}) } : {}),
        canUseTool: (toolName, input, { suggestions, toolUseID }) =>
          new Promise<PermissionResult>((resolve) => {
            const requestId = randomUUID().slice(0, 8);
            const req: ApprovalRequest = { requestId, toolUseId: toolUseID ?? null, name: toolName, input, suggestions: suggestions ?? [] };
            this.pending.set(requestId, { ...req, resolve });
            this.emit({ kind: 'approval.requested', ...req });
            this.emit({ kind: 'session.state', state: 'requires_action' });
          }),
      },
    });
    this.q = q;
    this.resumeAt = null;
    if (this.log.meta.effort) void this.fitEffort(q);
    try {
      for await (const m of q) this.onMessage(m);
      // ended 를 먼저 세운다 — session.exit 를 받은 serve 가 곧바로 close() 를 부르는데, 그때 ended 가 아니면 종료 줄이 한 번 더 남는다 (2026-10-08 실측)
      if (!this.ended && !this.restarting) { this.ended = true; this.emit({ kind: 'session.exit', reason: 'vendor process ended' }); }
    } catch (err) {
      if (this.restarting) return; // rewind 가 생성기를 닫은 것 — finally 가 처리
      // close() 뒤에 죽은 벤더 — superlite 서비스 중지·터미널 Ctrl-C 는 프로세스 그룹에 시그널을 보내 claude 도 같이 죽는다(exit 143). 종료는 close 가 이미 남겼다 (사용자 2026-10-11)
      if (this.ended) return;
      this.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      if (!this.ended) { this.ended = true; this.emit({ kind: 'session.exit', reason: 'vendor process error' }); }
    } finally {
      this.q = null;
      if (this.restarting) { this.restarting = false; return; } // rewind 의 재기동 — 세션은 계속 산다
      this.ended = true;
      this.cancelPending('session ended');
      if (this.state !== 'exited' && !this.quiet) this.emit({ kind: 'session.state', state: 'exited' });
      this.log.close();
    }
  }

  private onMessage(m: SDKMessage) {
    // 벤더 세션 id 는 대화 기록이 생긴 뒤에만 남긴다 — 첫 프롬프트 전의 훅 알림(system hook_*)에도 session_id 가 실려 오지만 claude 는 아직 기록을 쓰지 않았고,
    // init 때도 아직 없다 (2026-11-08 실측). 그 id 로 --resume 하면 "No conversation found" 로 세션이 닫힌다 (ticket slcode-resume-empty-claude)
    if (m.type !== 'system' && 'session_id' in m && typeof m.session_id === 'string' && m.session_id !== this.log.meta.vendorSessionId) {
      this.log.updateMeta({ vendorSessionId: m.session_id });
    }
    const raw = this.rawOn ? m : undefined;
    switch (m.type) {
      case 'system': {
        const s: any = m;
        if (s.subtype === 'init') {
          this.model = this.log.meta.model ?? s.model ?? null;
          this.effort = this.log.meta.effort ?? s.effort ?? null;
          this.emit({
            kind: 'session.ready', vendor: 'claude', model: s.model, cwd: s.cwd, vendorSessionId: s.session_id, permissionMode: s.permissionMode,
            tools: s.tools ?? [], skills: this.shownSkills(s.skills ?? []), plugins: s.plugins ?? [], mcp: s.mcp_servers ?? [],
            slashCommands: s.slash_commands ?? [], agents: s.agents ?? [], version: s.claude_code_version ?? null,
          }, raw);
        } else if (s.subtype === 'session_state_changed') this.emit({ kind: 'session.state', state: s.state }, raw);
        else if (s.subtype === 'compact_boundary') this.emit({ kind: 'context.compacted', trigger: s.compact_metadata?.trigger ?? 'unknown', preTokens: s.compact_metadata?.pre_tokens ?? null }, raw);
        else if (s.subtype === 'hook_started') this.emit({ kind: 'hook', event: s.hook_event, phase: 'started', ok: null }, raw);
        else if (s.subtype === 'hook_response') this.emit({ kind: 'hook', event: s.hook_event, phase: 'response', ok: s.outcome !== 'error' }, raw);
        else if (s.subtype === 'local_command_output') { if (typeof s.content === 'string' && s.content) this.emit({ kind: 'text.delta', text: s.content }, raw); } // 슬래시 명령의 로컬 출력 — 답변처럼
        else if (s.subtype === 'worker_shutting_down') this.emit({ kind: 'error', message: `worker_shutting_down: ${s.reason}` }, raw);
        else if (s.subtype === 'task_started' || s.subtype === 'task_progress' || s.subtype === 'task_notification') {
          const usage = s.usage ? { tokens: s.usage.total_tokens ?? 0, toolUses: s.usage.tool_uses ?? 0, durationMs: s.usage.duration_ms ?? 0 } : null;
          const phase = s.subtype === 'task_started' ? 'started' : s.subtype === 'task_progress' ? 'progress' : 'ended';
          this.emit({ kind: 'task', phase, taskId: s.task_id, toolUseId: s.tool_use_id ?? null, description: s.description ?? '', agentType: s.subagent_type ?? null, background: !!s.is_backgrounded,
            summary: s.summary ?? null, lastTool: s.last_tool_name ?? null, status: phase === 'ended' ? s.status ?? null : null, usage }, raw);
        }
        return;
      }
      case 'stream_event': {
        const ev: any = (m as any).event;
        const parent = parentOf(m);
        if (ev?.type === 'content_block_delta') {
          if (ev.delta?.type === 'text_delta') this.emit({ kind: 'text.delta', text: ev.delta.text, ...parent }, raw);
          else if (ev.delta?.type === 'thinking_delta') this.emit({ kind: 'thinking.delta', text: ev.delta.thinking, ...parent }, raw);
        }
        return;
      }
      case 'assistant':
        if (typeof (m as any).uuid === 'string') this.lastUuid = (m as any).uuid;
        if (typeof (m as any).user_message_uuid === 'string') this.turnUuids[0] = (m as any).user_message_uuid; // 벤더가 확정한 값이 우선
        const synthetic = (m as any).message?.model === '<synthetic>';
        // 인증 실패·API 오류는 error 칸이 붙은 synthetic 메시지로 온다 ("Not logged in · Please run /login", 2026-10-15 실측) — 답변이 아니라 이 턴의 실패 사유다
        if (typeof (m as any).error === 'string' && !parentOf(m).parent) {
          const text = synthetic ? ((m as any).message.content as any[]).filter((b) => b.type === 'text').map((b) => b.text).join('') || null : null;
          this.turnError = { code: (m as any).error, text };
          if (synthetic) return;
        }
        for (const b of (m as any).message.content as any[]) {
          const parent = parentOf(m);
          if (b.type === 'tool_use') this.emit({ kind: 'tool.start', toolUseId: b.id, name: b.name, input: b.input, ...parent }, raw);
          // 서브에이전트의 텍스트·thinking 은 스트림이 아니라 완성 블록으로 온다 (forwardSubagentText, 2026-09-30 실측) — 델타 하나로 낸다.
          // 슬래시 명령의 로컬 출력(/context·/cost 등)과 API 오류 문구도 model '<synthetic>' 인 assistant 메시지로 스트림 없이 온다 (2026-09-30 실측) — 같은 길
          else if ((parent.parent || synthetic) && b.type === 'text' && b.text) this.emit({ kind: 'text.delta', text: b.text, ...parent }, raw);
          else if (parent.parent && b.type === 'thinking' && b.thinking) this.emit({ kind: 'thinking.delta', text: b.thinking, ...parent }, raw);
        }
        return;
      // 턴 중에 넣은 메시지를 SDK 가 같은 턴에서 처리했다 — 그 메시지에는 따로 result 가 오지 않으니 줄 선 턴에서 뺀다 (맨 앞은 지금 턴, result 가 뺀다).
      // 실측(2026-11-07): 도구 결과와 함께 들어가면 completed 가 지금 턴의 result 보다 먼저, 턴 뒤 새 턴이면 앞 턴의 result 뒤에 온다. 0.3.282 의 SDKMessage 타입에는 없다
      case 'command_lifecycle' as SDKMessage['type']: {
        const c: any = m;
        const i = c.state === 'completed' ? this.turnUuids.indexOf(c.command_uuid) : -1;
        if (i > 0) this.turnUuids.splice(i, 1);
        return;
      }
      case 'user': {
        const c = (m as any).message?.content;
        if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') this.emit({ kind: 'tool.end', toolUseId: b.tool_use_id, ok: !b.is_error, summary: summarize(b.content), ...parentOf(m) }, raw);
        if (typeof (m as any).uuid === 'string') this.lastUuid = (m as any).uuid;
        return;
      }
      case 'result': {
        const r: any = m;
        const base = { costUsd: r.total_cost_usd ?? null, durationMs: r.duration_ms ?? null, usage: usageOf(r.usage), userUuid: this.turnUuids.shift() ?? null, uuid: this.lastUuid };
        const te = this.turnError; this.turnError = null;
        // subtype 은 인증 실패에도 success 다 (is_error true, 2026-10-15 실측) — 성공은 is_error·error 칸이 둘 다 없을 때만
        if (r.subtype === 'success' && !r.is_error && !te) this.emit({ kind: 'turn.end', ok: true, error: null, interrupted: false, ...base }, raw);
        else if (r.terminal_reason === 'aborted_streaming' || r.terminal_reason === 'aborted_tools') this.emit({ kind: 'turn.end', ok: false, error: null, interrupted: true, ...base }, raw);
        else {
          const error = te?.text || r.errors?.join('; ') || (typeof r.result === 'string' && r.result) || te?.code || r.subtype || 'error';
          const errorKind = te?.code === 'authentication_failed' || r.api_error_status === 401 ? 'auth' : null;
          this.emit({ kind: 'turn.end', ok: false, error, errorKind, interrupted: false, ...base }, raw);
        }
        this.log.updateMeta({ updatedAt: Date.now() }); // --continue 의 최근 기준
        // 다음 턴이 큐에 있으면 CLI 가 곧 집어간다 — 그래도 경계는 idle 로 보인다
        if (this.state !== 'exited') this.emit({ kind: 'session.state', state: 'idle' });
        return;
      }
      default:
        return;
    }
  }
}

/** 벤더 제안 규칙을 세션 한정으로 (t3code acceptForSession) — 제안이 없으면 도구 전체 허용 규칙 하나 */
function sessionScoped(suggestions: PermissionUpdate[], toolName: string): PermissionUpdate[] {
  const scoped = suggestions
    .filter((s: any) => s && typeof s === 'object')
    .map((s: any) => ({ ...s, destination: 'session' })) as PermissionUpdate[];
  if (scoped.length) return scoped;
  return [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' } as PermissionUpdate];
}
