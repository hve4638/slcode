// 벤더 기록 → slcode 이벤트 (ticket slcode-import-history, 사용자 결정 2026-10-15). `slcode import` 가 Claude Code·Codex 에서 하던 대화를
// 실시간 것과 같은 이벤트로 events.jsonl 에 옮겨 써서 화면에 보인다. 다시 import 하면 벤더 쪽에서 늘어난 턴을 이어 붙인다.
//   claude  Agent SDK getSessionMessages — 살아 있는 줄기(rewind 곁가지·sidechain·meta 제외), 마지막 compact 뒤만 (Claude Code 가 resume 때 싣는 범위)
//   codex   app-server thread/read 의 turns (codex.ts readThread)
// 벤더 기록은 공개 계약이 아니다 — 모르는 항목은 건너뛴다.
import fs from 'node:fs';
import path from 'node:path';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import type { CoreEventBody, Usage } from './protocol.js';
import { EventLog, unrewound } from './eventLog.js';
import { summarize } from './session.js';
import { collabTask, isAuthError, readThread, toolOf, toolResult } from './codex.js';
import { findVendorSession } from './vendor.js';

export type TimedEvent = { at: number; ev: CoreEventBody };
export type Pulled = { turns: number; rewound: boolean };
/** SDK SessionMessage — 타입 밖으로 실려 오는 칸까지 (0.3.282 실측: timestamp·isCompactSummary·is_meta·isCompletedLocalCommand·origin).
 *  error 는 기록의 isApiErrorMessage 항목의 error 코드 — SDK 가 넘기지 않아 pullHistory 가 기록 파일에서 읽어 붙인다 */
type ClaudeMsg = { type: string; uuid: string; message?: any; timestamp?: string; isCompactSummary?: boolean; is_meta?: boolean; isCompletedLocalCommand?: boolean; origin?: { kind?: string }; error?: string };

const tag = (text: string, name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
const INTERRUPTED = '[Request interrupted by user'; // 뒤에 ']' 또는 ' for tool use]'

/** Claude 기록 → 이벤트. 턴은 사용자 프롬프트부터 다음 프롬프트 앞까지, turn.end 의 uuid 는 그 턴의 마지막 항목(대화 되돌리기의 유지 지점) */
export function claudeEvents(msgs: ClaudeMsg[]): TimedEvent[] {
  const out: TimedEvent[] = [];
  type Turn = { start: number; at: number; userUuid: string | null; uuid: string | null; interrupted: boolean; usage: Map<string, any>; error?: { code: string; text: string | null } };
  let t: Turn | null = null;
  const push = (at: number, ev: CoreEventBody) => out.push({ at, ev });
  const end = () => {
    if (!t) return;
    // 사용량은 API 메시지 id 마다 마지막 값의 합 — 한 응답이 블록마다 한 줄씩 기록된다
    let usage: Usage | null = null;
    for (const u of t.usage.values()) {
      usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      usage.input += u.input_tokens ?? 0; usage.output += u.output_tokens ?? 0; usage.cacheRead += u.cache_read_input_tokens ?? 0; usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    }
    const e = t.error;
    push(t.at, { kind: 'turn.end', ok: !t.interrupted && !e, error: e ? e.text || e.code : null, ...(e ? { errorKind: e.code === 'authentication_failed' ? 'auth' : null } : {}),
      interrupted: t.interrupted, costUsd: null, durationMs: t.at - t.start, usage, userUuid: t.userUuid, uuid: t.uuid });
    t = null;
  };
  // 프롬프트 앞에 놓인 항목·백그라운드 작업 알림은 turn.start 없는 턴 — 실시간에도 사용자 말풍선 없이 온다
  const cur = (at: number): Turn => (t ??= { start: at, at, userUuid: null, uuid: null, interrupted: false, usage: new Map() });
  for (const m of msgs) {
    if (m.type !== 'user' && m.type !== 'assistant') continue;
    const at = Date.parse(m.timestamp ?? '') || Date.now();
    if (m.isCompactSummary) { end(); push(at, { kind: 'context.compacted', trigger: 'unknown', preTokens: null }); continue; }
    if (m.is_meta || m.isCompletedLocalCommand) continue; // 스킬 본문 같은 주입, /model 같은 로컬 명령의 기록과 출력
    const c = m.message?.content;
    const blocks: any[] = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    if (m.type === 'assistant') {
      const tt = cur(at);
      // API 오류·인증 실패의 synthetic 문구는 답변이 아니라 이 턴의 실패 사유 — 실시간 session.ts 와 같다 (ticket slcode-auth-error-shown-as-answer)
      if (m.error) { tt.error = { code: m.error, text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('') || null }; tt.uuid = m.uuid; tt.at = at; continue; }
      for (const b of blocks) {
        if (b.type === 'text' && b.text) push(at, { kind: 'text.delta', text: b.text }); // 그 밖의 '<synthetic>'(로컬 명령 출력·"No response requested.")은 실시간처럼 답변으로
        else if (b.type === 'thinking' && b.thinking) push(at, { kind: 'thinking.delta', text: b.thinking });
        else if (b.type === 'tool_use') push(at, { kind: 'tool.start', toolUseId: b.id, name: b.name, input: b.input });
      }
      if (m.message?.id && m.message.usage) tt.usage.set(m.message.id, m.message.usage);
      tt.uuid = m.uuid; tt.at = at;
      continue;
    }
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const results = blocks.filter((b) => b.type === 'tool_result');
    const stdout = tag(text, 'bash-stdout'), stderr = tag(text, 'bash-stderr'); // `!` 셸의 출력
    if (results.length || text.startsWith(INTERRUPTED) || stdout !== undefined || stderr !== undefined) {
      const tt = cur(at);
      for (const b of results) push(at, { kind: 'tool.end', toolUseId: b.tool_use_id, ok: !b.is_error, summary: summarize(b.content) });
      if (text.startsWith(INTERRUPTED)) tt.interrupted = true;
      const shell = [stdout, stderr].filter(Boolean).join('\n');
      if (shell) push(at, { kind: 'text.delta', text: '```\n' + shell + '\n```' });
      tt.uuid = m.uuid; tt.at = at;
      continue;
    }
    const files = blocks.filter((b) => b.type === 'image' || b.type === 'document');
    if (!text && !files.length) continue;
    end();
    const tt = cur(at);
    tt.userUuid = tt.uuid = m.uuid;
    if (m.origin?.kind === 'task-notification') continue;
    const cmd = tag(text, 'command-name'), bash = tag(text, 'bash-input');
    const prompt = cmd ? `${cmd.trim()} ${tag(text, 'command-args')?.trim() ?? ''}`.trim() : bash !== undefined ? `! ${bash.trim()}` : text;
    push(at, { kind: 'turn.start', text: prompt, origin: null,
      ...(files.length ? { attachments: files.map((b, i) => ({ name: `${b.type} ${i + 1}`, mediaType: b.source?.media_type ?? b.type, size: Math.floor(((b.source?.data?.length ?? 0) * 3) / 4) })) } : {}) });
  }
  end();
  return out;
}

/** Codex 기록(thread/read 의 turns) → 이벤트. 항목은 codex.ts 의 실시간 매핑대로, turn.end 의 uuid 는 turn id */
export function codexEvents(turns: any[]): TimedEvent[] {
  const out: TimedEvent[] = [];
  for (const t of turns) {
    if (t.status === 'inProgress') continue; // 아직 도는 턴 — 다음 import 에서
    const at = (t.startedAt ?? 0) * 1000 || Date.now();
    const push = (ev: CoreEventBody) => out.push({ at, ev });
    const items: any[] = t.items ?? [];
    const um = items.find((i) => i.type === 'userMessage'); // 없으면 압축만 한 턴
    if (um) {
      const parts: any[] = um.content ?? [];
      const images = parts.filter((p) => p.type === 'image' || p.type === 'localImage');
      push({ kind: 'turn.start', text: parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n'), origin: null,
        ...(images.length ? { attachments: images.map((p, i) => ({ name: p.path ? path.basename(p.path) : `image ${i + 1}`, mediaType: p.url?.match(/^data:([^;,]+)/)?.[1] ?? 'image', size: 0 })) } : {}) });
    }
    for (const it of items) {
      const tool = toolOf(it);
      if (tool) { push({ kind: 'tool.start', toolUseId: it.id, name: tool.name, input: tool.input }); push({ kind: 'tool.end', toolUseId: it.id, ...toolResult(it) }); }
      else if (it.type === 'agentMessage' && it.text) push({ kind: 'text.delta', text: it.text });
      else if (it.type === 'reasoning') { const s = (it.summary?.length ? it.summary : it.content ?? []).join('\n\n'); if (s) push({ kind: 'thinking.delta', text: s }); }
      else if (it.type === 'contextCompaction') push({ kind: 'context.compacted', trigger: 'unknown', preTokens: null });
      else if (it.type === 'collabAgentToolCall') { push(collabTask(it, 'started')); push(collabTask(it, 'ended')); }
    }
    const failed = t.status === 'failed';
    out.push({ at: (t.completedAt ?? 0) * 1000 || at, ev: { kind: 'turn.end', ok: t.status === 'completed', error: failed ? t.error?.message ?? 'failed' : null, ...(failed ? { errorKind: isAuthError(t.error?.codexErrorInfo) ? 'auth' : null } : {}),
      interrupted: t.status === 'interrupted', costUsd: null, durationMs: t.durationMs ?? null, usage: null, uuid: t.id } });
  }
  return out;
}

/** SDK 메시지에 기록의 API 오류 표지(isApiErrorMessage 항목의 error 코드)를 붙인다 — 그 줄만 골라 읽는다 */
function withApiErrors(id: string, msgs: ClaudeMsg[]): ClaudeMsg[] {
  const file = findVendorSession(id, 'claude')?.file;
  if (!file) return msgs;
  const errors = new Map<string, string>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"isApiErrorMessage":true')) continue;
    try { const o = JSON.parse(line); if (o.isApiErrorMessage && typeof o.uuid === 'string') errors.set(o.uuid, typeof o.error === 'string' ? o.error : 'api_error'); } catch {}
  }
  return errors.size ? msgs.map((m) => (errors.has(m.uuid) ? { ...m, error: errors.get(m.uuid) } : m)) : msgs;
}

/** 벤더 세션 from 의 기록에서 로그가 모르는 뒤쪽을 이벤트로 붙이고 session.imported 표지를 남긴다. 세션 프로세스가 떠 있지 않을 때만 부른다 (seq 는 core 가 쥔다).
 *  어디까지 가져왔는지 모르면 null. mark 는 표지의 vendorSessionId·fork (처음 import 면 원본) */
export async function pullHistory(log: EventLog, from: string, mark: { vendorSessionId: string; fork?: boolean } = { vendorSessionId: from }): Promise<Pulled | null> {
  const claude = log.meta.vendor === 'claude';
  const items: any[] = claude ? withApiErrors(from, await getSessionMessages(from)) : (await readThread(from, log.meta.cwd)).filter((t) => t.status !== 'inProgress');
  const ids: string[] = items.map((x) => (claude ? x.uuid : x.id)); // 지점 — Claude 는 메시지 uuid, Codex 는 turn id
  let base = -1, cut: number | null = null;
  if (log.lastSeq) {
    // 우리가 아는 지점(turn.end·표지의 uuid)을 뒤에서부터 벤더 기록에서 찾는다. 찾은 지점보다 뒤의 우리 턴이 벤더 기록에 없으면 벤더 쪽에서 되돌린 것 — 그 턴부터 지운다
    const index = new Map(ids.map((id, i) => [id, i]));
    const evs = unrewound(log.all);
    let found = false, lost = false, next: number | null = null;
    for (let i = evs.length - 1; i >= 0 && !found; i--) {
      const ev = evs[i].ev;
      if (ev.kind === 'turn.start') next = evs[i].seq;
      const id = ev.kind === 'turn.end' || ev.kind === 'session.imported' ? ev.uuid : null;
      if (!id) continue;
      if (index.has(id)) { found = true; base = index.get(id)!; if (lost) cut = next; }
      else lost = true;
    }
    // 하나도 못 찾았다: 그 뒤 벤더에서 compact 해서 기록이 요약으로 시작하면 전부 새것이다. 아니면 어디까지 가져왔는지 모른다 (uuid 가 없던 옛 Codex 세션)
    if (!found && !(claude && items[0]?.isCompactSummary)) return null;
  }
  const events = claude ? claudeEvents(items.slice(base + 1)) : codexEvents(items.slice(base + 1));
  const turns = events.filter((e) => e.ev.kind === 'turn.end').length;
  if (log.lastSeq && !turns && cut === null) return { turns: 0, rewound: false };
  const add = (at: number, ev: CoreEventBody) => log.append({ seq: log.lastSeq + 1, at, ev });
  if (cut !== null) add(Date.now(), { kind: 'turn.rewound', seq: cut, conversation: true, files: false, filesChanged: null });
  for (const e of events) add(e.at, e.ev);
  add(Date.now(), { kind: 'session.imported', vendor: log.meta.vendor, vendorSessionId: mark.vendorSessionId, uuid: ids.at(-1) ?? null, ...(mark.fork ? { fork: true } : {}) });
  return { turns, rewound: cut !== null };
}
