// Codex 어댑터 — 세션 하나 = `codex app-server` 자식 프로세스 하나 (codex-cli 0.159 실측 2026-09-30, ticket agent-core-codex).
// stdio 위 JSON-RPC 를 줄 단위(개행)로 주고받는다. initialize → initialized → thread/start | thread/resume → 턴마다 turn/start.
// 알림을 protocol.ts 의 벤더 중립 이벤트로 정규화하고, 서버→클라이언트 요청(승인·질문)을 approval.requested 로 낸다.
// 권한 모드는 Codex 의 approvalPolicy·sandboxPolicy 로 턴마다 넘긴다 (t3code 선례 안: on-request/workspace-write 가 기본).
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ApprovalDecision, ApprovalRequest, Attachment, LimitWindow } from './protocol.js';
import { AgentSession, type ApproveOpts, type Command, type ContextUsage, type Limits, type ModelsResult } from './base.js';
import type { EventLog } from './eventLog.js';

export type CodexOptions = {
  log: EventLog;
  permissionMode?: string | null;
  raw?: boolean;
  env?: NodeJS.ProcessEnv;
  /** 실행 파일 — 기본 PATH 의 codex */
  bin?: string;
};

/** Codex 는 비용을 주지 않는다 — 공식 가격표(USD / 1M 토큰: 입력·캐시 입력·출력, developers.openai.com 2026-10-09)로 추정한다.
 *  캐시 쓰기는 입력의 1.25배. 272K 넘는 요청의 할증(입력 2배·출력 1.5배)은 요청 단위라 셈하지 않는다. 표에 없는 모델은 null */
const PRICES: Record<string, [number, number, number]> = {
  'gpt-5.6-sol': [4, 0.4, 20], // 2026-11-21 까지 할인가
  'gpt-5.6-terra': [2, 0.2, 12],
  'gpt-5.6-luna': [0.2, 0.02, 1.2],
  'gpt-5.5': [5, 0.5, 30],
};
type TokenCounts = { inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number };
/** inputTokens 는 캐시 읽기·쓰기를 포함하고 outputTokens 는 reasoning 을 포함한다 (rollout token_count 실측) */
export function estimateCostUsd(model: string | null, u: TokenCounts): number | null {
  const p = model ? PRICES[model] : undefined;
  if (!p) return null;
  const cached = u.cachedInputTokens ?? 0, write = u.cacheWriteInputTokens ?? 0;
  const fresh = Math.max(0, (u.inputTokens ?? 0) - cached - write);
  return (fresh * p[0] + cached * p[1] + write * p[0] * 1.25 + (u.outputTokens ?? 0) * p[2]) / 1e6;
}
const tokenDiff = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  inputTokens: (a.inputTokens ?? 0) - (b.inputTokens ?? 0), cachedInputTokens: (a.cachedInputTokens ?? 0) - (b.cachedInputTokens ?? 0),
  cacheWriteInputTokens: (a.cacheWriteInputTokens ?? 0) - (b.cacheWriteInputTokens ?? 0), outputTokens: (a.outputTokens ?? 0) - (b.outputTokens ?? 0),
});

type Pending = ApprovalRequest & { rpcId: number | string; kind: 'command' | 'file' | 'question' | 'permissions' | 'elicitation' };
type Waiter = { res: (v: any) => void; rej: (e: Error) => void };

/** 우리 권한 모드 → Codex 의 턴 파라미터 (t3code 의 runtimeMode 매핑 안에서, codex-ref 보고 §7):
 *  default = untrusted + readOnly(명령·편집 모두 묻는다, t3code approval-required), acceptEdits = on-request + workspaceWrite(t3code auto-accept-edits),
 *  plan = on-request + readOnly(쓰려면 묻는다), bypassPermissions = never + dangerFullAccess(t3code full-access). approvalsReviewer 는 늘 user 로 명시한다 — resume 에서 생략하면 이전 값이 남는다 */
function policyOf(mode: string | null | undefined): { approvalPolicy: unknown; sandboxPolicy: unknown; approvalsReviewer: 'user' } {
  const ro = { type: 'readOnly', networkAccess: false };
  const ww = { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  switch (mode) {
    case 'acceptEdits': return { approvalPolicy: 'on-request', sandboxPolicy: ww, approvalsReviewer: 'user' };
    case 'plan': return { approvalPolicy: 'on-request', sandboxPolicy: ro, approvalsReviewer: 'user' };
    case 'bypassPermissions': return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, approvalsReviewer: 'user' };
    default: return { approvalPolicy: 'untrusted', sandboxPolicy: ro, approvalsReviewer: 'user' };
  }
}
const sandboxModeOf = (mode: string | null | undefined) => (mode === 'acceptEdits' ? 'workspace-write' : mode === 'bypassPermissions' ? 'danger-full-access' : 'read-only');

/** ThreadItem → 도구 이름·입력 (Claude 어휘에 가깝게: 명령은 Bash, 패치는 Edit) */
function toolOf(item: any): { name: string; input: unknown } | null {
  switch (item?.type) {
    case 'commandExecution': return { name: 'Bash', input: { command: item.command, cwd: item.cwd } };
    case 'fileChange': return { name: 'Edit', input: { changes: (item.changes ?? []).map((c: any) => ({ path: c.path, kind: c.kind })) } };
    case 'mcpToolCall': return { name: `mcp:${item.server}/${item.tool}`, input: item.arguments ?? {} };
    case 'dynamicToolCall': return { name: item.tool, input: item.arguments ?? {} };
    case 'webSearch': return { name: 'WebSearch', input: { query: item.query ?? item.action?.query ?? '' } };
    case 'imageView': return { name: 'Read', input: { path: item.path } };
    default: return null;
  }
}

function toolResult(item: any): { ok: boolean; summary: string } {
  const status: string = item.status ?? 'completed';
  const ok = status === 'completed' && (item.exitCode == null || item.exitCode === 0) && item.error == null && item.success !== false;
  let summary = '';
  if (item.type === 'commandExecution') summary = item.aggregatedOutput ?? (item.exitCode != null ? `exit ${item.exitCode}` : '');
  else if (item.type === 'fileChange') summary = (item.changes ?? []).map((c: any) => `${c.kind} ${c.path}`).join('\n');
  else if (item.type === 'mcpToolCall') summary = item.error?.message ?? JSON.stringify(item.result ?? '').slice(0, 400);
  else if (item.type === 'dynamicToolCall') summary = (item.contentItems ?? []).map((c: any) => c.text ?? `[${c.type}]`).join('');
  else summary = status;
  if (status === 'declined') summary = summary || 'declined';
  return { ok, summary: String(summary ?? '').slice(0, 400) };
}

const isoOf = (secs: number | null | undefined) => (secs ? new Date(secs * 1000).toISOString() : null);

export class CodexSession extends AgentSession {
  private proc: ChildProcess | null = null;
  private rpcId = 0;
  private waits = new Map<number, Waiter>();
  private pending = new Map<string, Pending>();
  private threadId: string | null;
  private turnId: string | null = null;
  private queue: { text: string; attachments: Attachment[] }[] = [];
  /** /compact 로 우리가 시킨 압축이 진행 중 — contextCompaction 항목을 manual 로 표시하기 위해 */
  private compacting = false;
  private ended = false;
  private mode: string | null;
  private lastUsage: any = null;
  // 추정 비용 — Claude 의 total_cost_usd 처럼 프로세스 누계. 이번 턴에 값을 매긴 사용량이 없으면 turn.end 는 null
  private costUsd = 0;
  private turnPriced = false;
  private prevTotal: TokenCounts | null = null;
  private lastLimits: any = null;
  private modelList: any[] | null = null; // model/list 는 한 번만 — 목록은 세션 중 바뀌지 않는다
  private streamed = new Set<string>();
  private ready: Promise<void>;
  private readonly opts: CodexOptions;

  constructor(opts: CodexOptions) {
    super(opts.log, opts.raw);
    this.opts = opts;
    this.threadId = opts.log.meta.vendorSessionId;
    this.mode = opts.permissionMode ?? opts.log.meta.permissionMode ?? null;
    this.ready = this.start();
  }

  pendingApprovals(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ rpcId: _i, kind: _k, ...p }) => p);
  }

  // ---- 프로세스·RPC
  private async start() {
    // 실행 파일: 옵션 → SLCODE_CODEX_BIN(테스트의 가짜 서버, 공백으로 인자 분리) → PATH 의 codex
    const spec = this.opts.bin ?? process.env.SLCODE_CODEX_BIN ?? 'codex';
    const [bin, ...pre] = spec.split(' ');
    const proc = spawn(bin, [...pre, ...(pre.length ? [] : ['app-server'])], { cwd: this.cwd, env: this.opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stderr?.on('data', () => {}); // 진단 출력은 버린다 (ponytail: 필요하면 파일로)
    readline.createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));
    proc.on('exit', (code) => { for (const w of this.waits.values()) w.rej(new Error('codex exited')); this.waits.clear(); if (!this.ended) { this.emit({ kind: 'session.exit', reason: `codex exited (${code})` }); this.emit({ kind: 'session.state', state: 'exited' }); } });
    try {
      const init = await this.request('initialize', { clientInfo: { name: 'slcode', title: null, version: '0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      this.notify('initialized', {});
      const pol = policyOf(this.mode);
      const base = { cwd: this.cwd, approvalPolicy: pol.approvalPolicy, approvalsReviewer: pol.approvalsReviewer, sandbox: sandboxModeOf(this.mode), ...(this.model ? { model: this.model } : {}) };
      let r: any = null;
      if (this.threadId) {
        // rollout 이 지워졌으면(not found) 새 thread 로 — t3code 와 같은 대체 (codex-ref §2)
        try { r = await this.request('thread/resume', { threadId: this.threadId, ...base, excludeTurns: true }); }
        catch (e) { if (!/not found|no rollout/i.test((e as Error).message)) throw e; this.emit({ kind: 'error', message: `codex thread ${this.threadId} not found — starting a new thread` }); }
      }
      // slcode import --fork — 원본은 두고 갈라 낸 새 thread 로 (원본이 없으면 새 thread 로 대체하지 않고 실패)
      if (!r && this.log.meta.forkFrom) r = await this.request('thread/fork', { threadId: this.log.meta.forkFrom, ...base, excludeTurns: true });
      r ??= await this.request('thread/start', base);
      this.threadId = r.thread.id;
      this.log.updateMeta({ vendorSessionId: r.thread.id });
      this.model ??= r.model ?? null;
      this.effort ??= r.reasoningEffort ?? null;
      this.emit({ kind: 'session.ready', vendor: 'codex', model: this.model ?? r.model, cwd: r.cwd ?? this.cwd, vendorSessionId: r.thread.id, permissionMode: this.mode ?? 'default',
        tools: [], skills: [], plugins: [], mcp: [], slashCommands: [], agents: [], version: String(init?.userAgent ?? '').match(/\/(\S+)/)?.[1] ?? null }, this.rawOn ? r : undefined);
      this.emit({ kind: 'session.state', state: 'idle' });
      const next = this.queue.shift(); // 기동 전에 온 턴 (첫 프롬프트·우편)
      if (next) void this.startTurn(next.text, next.attachments);
    } catch (e) {
      this.emit({ kind: 'error', message: `codex start failed: ${(e as Error).message}` });
      this.emit({ kind: 'session.exit', reason: 'codex start failed' });
      this.emit({ kind: 'session.state', state: 'exited' });
    }
  }

  private write(o: unknown) { this.proc?.stdin?.write(JSON.stringify(o) + '\n'); }
  private notify(method: string, params: unknown) { this.write({ jsonrpc: '2.0', method, params }); }
  private request(method: string, params: unknown): Promise<any> {
    const id = ++this.rpcId;
    return new Promise((res, rej) => { this.waits.set(id, { res, rej }); this.write({ jsonrpc: '2.0', id, method, params }); });
  }
  private reply(id: number | string, result: unknown) { this.write({ jsonrpc: '2.0', id, result }); }

  private onLine(line: string) {
    let m: any; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const w = this.waits.get(m.id); this.waits.delete(m.id);
      if (w) m.error ? w.rej(new Error(m.error.message ?? JSON.stringify(m.error))) : w.res(m.result);
      return;
    }
    if (m.id !== undefined && m.method) return this.onServerRequest(m.id, m.method, m.params ?? {});
    if (m.method) this.onNotification(m.method, m.params ?? {}, m);
  }

  // ---- 알림 → 이벤트
  private onNotification(method: string, p: any, raw: unknown) {
    const r = this.rawOn ? raw : undefined;
    // 서브에이전트(multi-agent)는 자식 thread 로 뜬다 — 다른 threadId 의 알림은 본문에 섞지 않는다 (ponytail: 자식 thread 의 중첩 표시는 후속; 부모 쪽 collabAgentToolCall 만 task 로)
    if (typeof p?.threadId === 'string' && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case 'item/agentMessage/delta': this.streamed.add(p.itemId); this.emit({ kind: 'text.delta', text: p.delta }, r); return;
      case 'item/reasoning/textDelta': case 'item/reasoning/summaryTextDelta': this.emit({ kind: 'thinking.delta', text: p.delta }, r); return;
      case 'item/started': {
        const it = p.item; const t = toolOf(it);
        if (t) this.emit({ kind: 'tool.start', toolUseId: it.id, name: t.name, input: t.input }, r);
        else if (it?.type === 'collabAgentToolCall') this.emit({ kind: 'task', phase: 'started', taskId: it.id, toolUseId: it.id, description: it.prompt ?? '', agentType: it.model ?? null, background: false, summary: null, lastTool: null, status: null, usage: null }, r);
        return;
      }
      case 'item/completed': {
        const it = p.item; const t = toolOf(it);
        if (t) { const res = toolResult(it); this.emit({ kind: 'tool.end', toolUseId: it.id, ok: res.ok, summary: res.summary }, r); }
        else if (it?.type === 'agentMessage' && it.text && !this.streamed.has(it.id)) this.emit({ kind: 'text.delta', text: it.text }, r); // 델타 없이 완성본만 온 경우
        else if (it?.type === 'contextCompaction') { this.emit({ kind: 'context.compacted', trigger: this.compacting ? 'manual' : 'auto', preTokens: null }, r); this.compacting = false; }
        else if (it?.type === 'collabAgentToolCall') this.emit({ kind: 'task', phase: 'ended', taskId: it.id, toolUseId: it.id, description: it.prompt ?? '', agentType: it.model ?? null, background: false, summary: null, lastTool: null, status: it.status === 'failed' ? 'failed' : 'completed', usage: null }, r);
        return;
      }
      case 'thread/tokenUsage/updated': {
        const t = p.tokenUsage; this.lastUsage = t;
        // 비용은 total 이 늘어난 만큼 — 같은 total 이 다시 와도 0 이다. 처음 받은 것은 last 만 새 것으로 본다 (resume 한 thread 의 total 엔 이전 사용량이 들어 있을 수 있다)
        if (t?.total) {
          const c = estimateCostUsd(this.model, tokenDiff(t.total, this.prevTotal ?? tokenDiff(t.total, t.last ?? {})));
          if (c != null) { this.costUsd += c; this.turnPriced = true; }
          this.prevTotal = t.total;
        }
        return;
      }
      case 'account/rateLimits/updated': this.lastLimits = p.rateLimits; return;
      case 'thread/compacted': this.emit({ kind: 'context.compacted', trigger: 'manual', preTokens: null }, r); return;
      case 'turn/started': this.turnId = p.turn?.id ?? this.turnId; return;
      case 'turn/completed': {
        const turn = p.turn ?? {};
        const u = this.lastUsage?.last;
        this.emit({ kind: 'turn.end', ok: turn.status === 'completed', error: turn.status === 'failed' ? turn.error?.message ?? 'failed' : null, interrupted: turn.status === 'interrupted', costUsd: this.turnPriced ? this.costUsd : null, durationMs: turn.durationMs ?? null,
          usage: u ? { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cachedInputTokens ?? 0, cacheWrite: u.cacheWriteInputTokens ?? 0 } : null }, r);
        this.turnId = null; this.turnPriced = false;
        this.log.updateMeta({ updatedAt: Date.now() });
        if (this.state !== 'exited') this.emit({ kind: 'session.state', state: 'idle' });
        const next = this.queue.shift();
        if (next) void this.startTurn(next.text, next.attachments);
        return;
      }
      case 'error': this.emit({ kind: 'error', message: p.error?.message ?? 'error' }, r); return;
      default: return;
    }
  }

  // ---- 서버 요청 → 승인
  private onServerRequest(id: number | string, method: string, p: any) {
    const requestId = randomUUID().slice(0, 8);
    const put = (kind: Pending['kind'], name: string, toolUseId: string | null, input: unknown) => {
      this.pending.set(requestId, { requestId, toolUseId, name, input, suggestions: [], rpcId: id, kind });
      this.emit({ kind: 'approval.requested', requestId, toolUseId, name, input, suggestions: [] });
      this.emit({ kind: 'session.state', state: 'requires_action' });
    };
    switch (method) {
      case 'item/commandExecution/requestApproval': case 'execCommandApproval':
        return put('command', 'Bash', p.itemId ?? null, { command: p.command, cwd: p.cwd, ...(p.reason ? { reason: p.reason } : {}) });
      case 'item/fileChange/requestApproval': case 'applyPatchApproval':
        return put('file', 'Edit', p.itemId ?? null, { ...(p.reason ? { reason: p.reason } : {}), ...(p.grantRoot ? { grantRoot: p.grantRoot } : {}) });
      case 'item/tool/requestUserInput':
        // AskUserQuestion 과 같은 꼴로 — 프런트의 질문 카드가 그대로 쓴다. 답은 updatedInput.answers {질문문: '답'} 로 돌아온다
        return put('question', 'AskUserQuestion', p.itemId ?? null, { questions: (p.questions ?? []).map((q: any) => ({ id: q.id, question: q.question, header: q.header, multiSelect: false, options: (q.options ?? []).map((o: any) => ({ label: o.label, description: o.description })) })) });
      case 'item/permissions/requestApproval':
        return put('permissions', 'Permissions', p.itemId ?? null, { permissions: p.permissions, cwd: p.cwd, ...(p.reason ? { reason: p.reason } : {}) });
      case 'mcpServer/elicitation/request':
        return put('elicitation', 'Elicitation', null, p);
      default:
        this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported server request ${method}` } });
    }
  }

  approve(requestId: string, decision: ApprovalDecision, opts: ApproveOpts = {}): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    this.emit({ kind: 'approval.resolved', requestId, decision });
    if (this.pending.size === 0 && this.state === 'requires_action') this.emit({ kind: 'session.state', state: 'running' });
    this.respond(p, decision, opts);
    return true;
  }

  private respond(p: Pending, decision: ApprovalDecision | 'cancelled', opts: ApproveOpts = {}) {
    const allow = decision === 'allow';
    switch (p.kind) {
      case 'command': case 'file':
        return this.reply(p.rpcId, { decision: decision === 'cancelled' ? 'cancel' : allow ? (opts.remember ? 'acceptForSession' : 'accept') : 'decline' });
      case 'question': {
        const qs = ((p.input as any)?.questions ?? []) as { id: string; question: string }[];
        const given = (opts.updatedInput as any)?.answers ?? {};
        const answers: Record<string, { answers: string[] }> = {};
        for (const q of qs) { const a = allow ? given[q.question] ?? '' : ''; answers[q.id] = { answers: a ? String(a).split(', ') : [] }; }
        return this.reply(p.rpcId, { answers });
      }
      case 'permissions':
        return this.reply(p.rpcId, allow ? { permissions: (p.input as any).permissions ?? {}, scope: opts.remember ? 'session' : 'turn' } : { permissions: {}, scope: 'turn' });
      case 'elicitation':
        return this.reply(p.rpcId, { action: allow ? 'accept' : 'cancel', content: null });
    }
  }

  private cancelPending(reason: string) {
    for (const [id, p] of this.pending) { this.respond(p, 'cancelled'); this.emit({ kind: 'approval.resolved', requestId: id, decision: 'cancelled' }); }
    this.pending.clear();
    void reason;
  }

  // ---- 턴
  send(text: string, origin: string | null = null, attachments: Attachment[] = []) {
    this.emit({ kind: 'turn.start', text, origin, ...(attachments.length ? { attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, size: Buffer.byteLength(a.data, 'base64') })) } : {}) });
    if (this.state === 'idle') { this.emit({ kind: 'session.state', state: 'running' }); void this.startTurn(text, attachments); }
    else this.queue.push({ text, attachments }); // 진행 중이면 turn/completed 뒤에
  }

  private async startTurn(text: string, attachments: Attachment[]) {
    await this.ready;
    if (!this.threadId || this.ended) return;
    if (this.state !== 'running') this.emit({ kind: 'session.state', state: 'running' });
    if (text.trim() === '/compact' && !attachments.length) {
      // 압축은 Codex 안에서 한 턴으로 돈다 (turn/started → contextCompaction 항목 → turn/completed, 2026-10-01 실측) — 나머지는 기존 매핑
      this.compacting = true;
      try { await this.request('thread/compact/start', { threadId: this.threadId }); }
      catch (e) { this.compacting = false; this.emit({ kind: 'turn.end', ok: false, error: (e as Error).message, interrupted: false, costUsd: null, durationMs: null, usage: null }); if (this.state !== 'exited') this.emit({ kind: 'session.state', state: 'idle' }); }
      return;
    }
    const input: unknown[] = [];
    const inline: string[] = [];
    for (const a of attachments) {
      if (/^image\/(png|jpeg|gif|webp)$/.test(a.mediaType)) input.push({ type: 'image', url: `data:${a.mediaType};base64,${a.data}` });
      else inline.push(`<file name="${a.name}">\n${Buffer.from(a.data, 'base64').toString('utf8')}\n</file>`);
    }
    const body = [...inline, text].filter(Boolean).join('\n\n');
    if (body) input.unshift({ type: 'text', text: body, text_elements: [] });
    const pol = policyOf(this.mode);
    try {
      const r = await this.request('turn/start', { threadId: this.threadId, input, ...pol, ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {}) });
      this.turnId = r?.turn?.id ?? this.turnId;
    } catch (e) {
      this.emit({ kind: 'turn.end', ok: false, error: (e as Error).message, interrupted: false, costUsd: null, durationMs: null, usage: null });
      if (this.state !== 'exited') this.emit({ kind: 'session.state', state: 'idle' });
    }
  }

  async interrupt() {
    this.cancelPending('interrupted');
    if (this.threadId && this.turnId) { try { await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); } catch {} }
  }

  // ---- 설정
  async models(): Promise<ModelsResult> {
    await this.ready;
    if (!this.modelList) { try { this.modelList = (await this.request('model/list', {}))?.data ?? []; } catch { this.modelList = null; } }
    const data: any[] = this.modelList ?? [];
    return { current: this.model, effort: this.effort, models: data.filter((m) => !m.hidden).map((m) => ({ value: m.id, resolvedModel: m.model, displayName: m.displayName, description: m.description ?? '', efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort ?? e) })) };
  }
  async setModel(model: string) { this.model = model; this.log.updateMeta({ model }); }
  async setEffort(effort: string) { this.effort = effort; this.log.updateMeta({ effort }); }
  async setMode(mode: string) { this.mode = mode; this.log.updateMeta({ permissionMode: mode }); }
  // Codex 의 슬래시 명령은 TUI 가 처리한다 — app-server 메서드가 있는 것만 우리가 대신한다 (compact → thread/compact/start)
  async commands(): Promise<Command[]> { return [{ name: 'compact', description: '컨텍스트를 압축한다', argumentHint: '' }]; }
  async limits(): Promise<Limits> {
    if (!this.lastLimits) { try { this.lastLimits = (await this.request('account/rateLimits/read', {}))?.rateLimits ?? null; } catch { return null; } }
    const w = (x: any): LimitWindow | null => (x ? { pct: x.usedPercent ?? null, resetsAt: isoOf(x.resetsAt) } : null);
    const l = this.lastLimits; if (!l) return null;
    return { fiveHour: w(l.primary), sevenDay: w(l.secondary) };
  }
  async context(): Promise<ContextUsage> {
    // total 은 턴들의 누계라 계속 늘고, 지금 컨텍스트 크기는 last(마지막 턴의 입력+출력) 이다 (t3code 도 같다, 2026-10-01 실측 13.7k→27k→41k 누계)
    const u = this.lastUsage; if (!u?.last || !u.modelContextWindow) return null;
    return { tokens: u.last.totalTokens, max: u.modelContextWindow, pct: (u.last.totalTokens / u.modelContextWindow) * 100 };
  }
  async rewind(): Promise<string[] | null> { throw new Error('rewind is not supported for codex sessions'); }

  async close(reason = 'closed') {
    if (this.ended) return;
    this.ended = true;
    this.cancelPending('session closed');
    // 진행 턴은 끊되 2초 안에 답이 없으면 그냥 죽인다 (t3code 도 2초 뒤 강제 종료) — Ctrl-C 가 여기서 멈춰 프로세스가 안 내려가던 실측 2026-09-30
    try { if (this.threadId && this.turnId) await Promise.race([this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }), new Promise((r) => setTimeout(r, 2000))]); } catch {}
    // stdio 파이프를 우리 쪽에서 닫는다 — 열린 채 두면 부모 프로세스가 안 끝난다 (테스트 실측 2026-09-30)
    try { this.proc?.stdin?.end(); this.proc?.stdout?.destroy(); this.proc?.stderr?.destroy(); this.proc?.kill(); } catch {}
    this.emit({ kind: 'session.exit', reason });
    this.emit({ kind: 'session.state', state: 'exited' });
    this.log.close();
  }
}

