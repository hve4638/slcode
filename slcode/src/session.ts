// Claude 어댑터 — 세션 하나 = SDK query() 하나 (streaming input, 상시 프로세스, t3code ClaudeAdapter 와 같은 꼴).
// SDK 메시지를 protocol.ts 의 벤더 중립 이벤트로 정규화해 EventLog 에 남기고 구독자에게 낸다.
// 승인(canUseTool)은 Deferred 로 무기한 기다린다 — interrupt·close·프로세스 종료만 cancelled 로 푼다 (사용자 결정 2026-09-26).
import { query, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult, type PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, Attachment, CoreEvent, LoggedEvent, Usage, LimitWindow } from './protocol.js';
import { EventLog } from './eventLog.js';
import { AgentSession } from './base.js';

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
  /** SDK 가 부모 세션의 CLAUDE_* 를 물려받지 않게 정리된 env */
  env?: NodeJS.ProcessEnv;
};

function summarize(content: unknown): string {
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
  private opts: SessionOptions;
  private running: Promise<void> = Promise.resolve();
  private restarting = false;
  /** 대화 되돌리기: 다음 run 의 resumeSessionAt */
  private resumeAt: string | null = null;
  /** 보낸 순서대로의 사용자 메시지 uuid (우리가 정해 보낸다 — SDK 의 submitMessage options.uuid 와 같은 자리). 턴이 끝날 때 하나씩 꺼낸다 */
  private turnUuids: string[] = [];
  private lastUuid: string | null = null;

  constructor(opts: SessionOptions) {
    super(opts.log, opts.raw);
    this.opts = opts;
    this.running = this.run(opts);
  }

  pendingApprovals(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ resolve: _r, ...p }) => p);
  }

  /** idle 세션에 턴 넣기 — 한 호출. 큐에 넣으면 CLI 가 다음 턴으로 집어간다. running 이면 뒤에 선다 */
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
    return { current: this.model, effort: this.effort, models: list.map((m) => ({ value: m.value, resolvedModel: m.resolvedModel, displayName: m.displayName, description: m.description, ...(m.supportedEffortLevels ? { efforts: m.supportedEffortLevels as string[] } : {}) })) };
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
  async commands(): Promise<{ name: string; description: string; argumentHint: string }[]> {
    if (!this.q) return [];
    try { return (await this.q.supportedCommands()).map((c) => ({ name: c.name, description: c.description ?? '', argumentHint: c.argumentHint ?? '' })); } catch { return []; }
  }

  /** 컨텍스트 창 사용량 — SDK getContextUsage(summary). 벤더가 안 떠 있으면 null */
  async context(): Promise<{ tokens: number; max: number; pct: number } | null> {
    if (!this.q) return null;
    try { const c = await this.q.getContextUsage({ detail: 'summary' }); return { tokens: c.totalTokens, max: c.maxTokens, pct: c.percentage }; }
    catch { return null; }
  }

  /** 다음 턴부터 쓸 effort. SDK 의 세션 한정 설정층이라 설정 파일엔 안 쓴다. meta 에 남겨 복원 때 options.effort 로 넘긴다 */
  async setEffort(effort: string) {
    await this.q?.applyFlagSettings({ effortLevel: effort as any });
    this.effort = effort;
    this.log.updateMeta({ effort });
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
  approve(requestId: string, decision: ApprovalDecision, opts: { remember?: boolean; updatedInput?: Record<string, unknown>; message?: string } = {}): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.emit({ kind: 'approval.resolved', requestId, decision });
    if (this.pending.size === 0 && this.state === 'requires_action') this.emit({ kind: 'session.state', state: 'running' });
    if (decision === 'allow') {
      const result: PermissionResult = { behavior: 'allow', updatedInput: (opts.updatedInput ?? p.input) as Record<string, unknown> };
      if (opts.remember) result.updatedPermissions = sessionScoped(p.suggestions as PermissionUpdate[], p.name);
      p.resolve(result);
    } else {
      p.resolve({ behavior: 'deny', message: opts.message ?? 'denied by user' });
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
    const evs: LoggedEvent[] = [];
    for (const e of this.log.since(0)) { if (e.ev.kind === 'turn.rewound') { const cut = e.ev.seq; while (evs.length && evs[evs.length - 1].seq >= cut) evs.pop(); } else evs.push(e); }
    const i = evs.findIndex((e) => e.seq === seq && e.ev.kind === 'turn.start');
    if (i < 0) throw new Error(`no turn at seq ${seq}`);
    const end = evs.slice(i).find((e) => e.ev.kind === 'turn.end')?.ev as Extract<CoreEvent, { kind: 'turn.end' }> | undefined;
    const prev = evs.slice(0, i).reverse().find((e) => e.ev.kind === 'turn.end')?.ev as Extract<CoreEvent, { kind: 'turn.end' }> | undefined;
    let filesChanged: string[] | null = null;
    if (files) {
      if (!end?.userUuid || !this.q) throw new Error('no checkpoint for that turn');
      const r = await this.q.rewindFiles(end.userUuid);
      if (!r.canRewind) throw new Error(r.error ?? 'cannot rewind files');
      filesChanged = r.filesChanged ?? [];
    }
    if (conversation) {
      // 가져온 세션(slcode import)의 첫 턴이면 가져올 때의 벤더 마지막 항목으로 — 새 벤더 세션으로 가면 가져온 대화가 사라진다
      const imported = evs.find((e) => e.ev.kind === 'session.imported')?.ev as Extract<CoreEvent, { kind: 'session.imported' }> | undefined;
      if (!prev && imported && !imported.uuid) throw new Error('cannot rewind before the imported conversation');
      this.resumeAt = prev?.uuid ?? imported?.uuid ?? null;
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

  async close(reason = 'closed') {
    if (this.ended) return;
    this.ended = true;
    this.cancelPending('session closed');
    try { await this.q?.interrupt(); } catch {}
    try { (this.q as any)?.return?.(); } catch {}
    this.emit({ kind: 'session.exit', reason });
    this.emit({ kind: 'session.state', state: 'exited' });
    this.log.close();
  }

  private async run(opts: SessionOptions) {
    const resume = opts.resume ?? this.log.meta.vendorSessionId ?? undefined;
    const permissionMode = opts.permissionMode ?? this.log.meta.permissionMode ?? undefined;
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
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        // CLI 와 같은 로드 — user/project/local (스파이크 (a) 실측: 플러그인·스킬·훅·MCP 가 CLI 와 같다)
        settingSources: ['user', 'project', 'local'],
        ...(opts.env ? { env: opts.env } : {}),
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
    try {
      for await (const m of q) this.onMessage(m);
      if (!this.ended && !this.restarting) { this.emit({ kind: 'session.exit', reason: 'vendor process ended' }); }
    } catch (err) {
      if (this.restarting) return; // rewind 가 생성기를 닫은 것 — finally 가 처리
      this.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      if (!this.ended) this.emit({ kind: 'session.exit', reason: 'vendor process error' });
    } finally {
      this.q = null;
      if (this.restarting) { this.restarting = false; return; } // rewind 의 재기동 — 세션은 계속 산다
      this.ended = true;
      this.cancelPending('session ended');
      if (this.state !== 'exited') this.emit({ kind: 'session.state', state: 'exited' });
      this.log.close();
    }
  }

  private onMessage(m: SDKMessage) {
    if ('session_id' in m && typeof m.session_id === 'string' && m.session_id !== this.log.meta.vendorSessionId) {
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
            tools: s.tools ?? [], skills: s.skills ?? [], plugins: s.plugins ?? [], mcp: s.mcp_servers ?? [],
            slashCommands: s.slash_commands ?? [], agents: s.agents ?? [], version: s.claude_code_version ?? null,
          }, raw);
          if (this.state === 'starting') this.emit({ kind: 'session.state', state: 'idle' });
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
        for (const b of (m as any).message.content as any[]) {
          const parent = parentOf(m);
          if (b.type === 'tool_use') this.emit({ kind: 'tool.start', toolUseId: b.id, name: b.name, input: b.input, ...parent }, raw);
          // 서브에이전트의 텍스트·thinking 은 스트림이 아니라 완성 블록으로 온다 (forwardSubagentText, 2026-09-30 실측) — 델타 하나로 낸다.
          // 슬래시 명령의 로컬 출력(/context·/cost 등)과 API 오류 문구도 model '<synthetic>' 인 assistant 메시지로 스트림 없이 온다 (2026-09-30 실측) — 같은 길
          else if ((parent.parent || synthetic) && b.type === 'text' && b.text) this.emit({ kind: 'text.delta', text: b.text, ...parent }, raw);
          else if (parent.parent && b.type === 'thinking' && b.thinking) this.emit({ kind: 'thinking.delta', text: b.thinking, ...parent }, raw);
        }
        return;
      case 'user': {
        const c = (m as any).message?.content;
        if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result') this.emit({ kind: 'tool.end', toolUseId: b.tool_use_id, ok: !b.is_error, summary: summarize(b.content), ...parentOf(m) }, raw);
        if (typeof (m as any).uuid === 'string') this.lastUuid = (m as any).uuid;
        return;
      }
      case 'result': {
        const r: any = m;
        const base = { costUsd: r.total_cost_usd ?? null, durationMs: r.duration_ms ?? null, usage: usageOf(r.usage), userUuid: this.turnUuids.shift() ?? null, uuid: this.lastUuid };
        if (r.subtype === 'success') this.emit({ kind: 'turn.end', ok: true, error: null, interrupted: false, ...base }, raw);
        else if (r.terminal_reason === 'aborted_streaming' || r.terminal_reason === 'aborted_tools') this.emit({ kind: 'turn.end', ok: false, error: null, interrupted: true, ...base }, raw);
        else this.emit({ kind: 'turn.end', ok: false, error: (r.errors?.join('; ') || r.subtype) ?? 'error', interrupted: false, ...base }, raw);
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
