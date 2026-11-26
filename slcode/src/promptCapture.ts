// Claude Code 가 지금 보내는 기본 system prompt 받아 오기 (ticket slcode-profile-system-prompt) — 원문을 저장하지 않으므로 편집 창을 열 때와
// 프롬프트 설정이 있는 세션을 띄울 때마다 받는다. 설치된 claude 를 이 프로세스의 가짜 Messages API 로 한 번 돌려 첫 본 요청의 system 을 읽는다(요금 없음, 대화 기록도 남기지 않는다).
// 두 번을 함께 돌린다: 기본 프롬프트 그대로, 그리고 표지 글로 덮어쓰고 끝 표지를 append 한 것. 덮어써도 Claude Code 가 뒤에 붙이는 글(tail — WebSearch 문단)을 뒤쪽에서 알아내
// 기본 프롬프트에서 뗀다 — 우리가 넘긴 글 뒤에 Claude Code 가 다시 붙이므로 그대로 두면 두 번 나간다.
// SDK 0.3.322 실측(2026-11-17): 요청의 system 은 [과금 표지, 정체성 한 줄, 정적 블록(전역 캐시), 동적 블록]. systemPrompt 를 string[] 로 주면
// SYSTEM_PROMPT_DYNAMIC_BOUNDARY 앞이 정적 블록, 뒤가 동적 블록이 되고, CLI 플래그 --append-system-prompt 를 함께 주면 정체성 한 줄이 preset 때와 같다.
import http from 'node:http';
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type Options } from '@anthropic-ai/claude-agent-sdk';
import { inspectEnv } from './inspect.js';
import type { ClaudeLoad } from './profiles.js';

/** identity 는 정체성 한 줄(읽기 전용), blocks 는 고칠 수 있는 배열 블록(tail 을 뗀 것), tail 은 Claude Code 가 늘 뒤에 붙이는 글 */
export type Capture = { identity: string; blocks: string[]; tail: string };
export type CaptureOptions = { cwd: string; env: NodeJS.ProcessEnv; model?: string; load?: ClaudeLoad; timeoutMs?: number };

const SENTINEL = 'slcode-prompt-capture-sentinel';
const SENTINEL_END = 'slcode-prompt-capture-end';
const SSE = ([
  ['message_start', { message: { id: 'msg_capture', type: 'message', role: 'assistant', model: 'capture', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }],
  ['content_block_stop', { index: 0 }],
  ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
  ['message_stop', {}],
] as const).map(([t, d]) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`).join('');

type Msg = { role?: string; content?: string | { type?: string; text?: string }[] };
/** 가짜 Messages API — 본 요청의 system 글들과 messages 를 onMain 에 넘기고 짧게 답한다. 본 요청만: 제목 짓기 같은 곁 요청은 도구가 없다 */
async function fakeApi(onMain: (sys: string[], messages: Msg[]) => void): Promise<{ srv: http.Server; url: string }> {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"not_found_error","message":"capture"}}'); return; }
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}'); return; }
      let j: { system?: { text?: string }[]; tools?: unknown[]; messages?: Msg[] } = {};
      try { j = JSON.parse(body); } catch { /* 본문이 아니면 아래에서 그냥 답한다 */ }
      if (Array.isArray(j.system) && j.tools?.length) onMain(j.system.map((s) => s.text ?? ''), j.messages ?? []);
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(SSE);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

export async function capturePrompt(o: CaptureOptions): Promise<Capture> {
  const got: { preset?: string[]; custom?: string[] } = {};
  let done!: () => void;
  const both = new Promise<void>((r) => (done = r));
  const { srv, url } = await fakeApi((sys) => {
    got[sys.some((t) => t.startsWith(SENTINEL)) ? 'custom' : 'preset'] ??= sys;
    if (got.preset && got.custom) done();
  });
  const ac = new AbortController();
  const run = (systemPrompt: Options['systemPrompt'], append?: string) => {
    const q = query({
      prompt: 'x',
      options: {
        cwd: o.cwd, systemPrompt, persistSession: false, abortController: ac, extraArgs: { 'system-prompt-snapshot': 'off', ...(append ? { 'append-system-prompt': append } : {}) },
        settingSources: o.load?.settingSources ?? ['user', 'project', 'local'],
        ...(o.load?.skills ? { skills: o.load.skills } : {}), ...(o.model ? { model: o.model } : {}),
        env: { ...inspectEnv(o.env, url), ...o.load?.env, IS_SANDBOX: '1', CLAUDE_CODE_DISABLE_ARTIFACT: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      },
    });
    return (async () => { for await (const _ of q) { /* 응답은 쓰지 않는다 */ } })();
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    // 두 실행이 받기 전에 끝나면(로그인 없음·claude 없음) 그 사유로, 받지 못한 채 오래 걸리면 시간 초과로
    const runs = Promise.all([run({ type: 'preset', preset: 'claude_code' }), run(SENTINEL, SENTINEL_END)]).then(() => { throw new Error('Claude Code ended before sending a request'); });
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timed out waiting for Claude Code')), o.timeoutMs ?? 60000); });
    await Promise.race([both, runs, timeout]);
  } catch (e) {
    if (!(got.preset && got.custom)) throw new Error(`could not read the default system prompt: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    ac.abort();
    srv.close(); srv.closeAllConnections();
  }
  const preset = got.preset!, custom = got.custom!;
  if (preset.length < 3) throw new Error('could not read the default system prompt: unexpected request shape');
  // 덮어쓴 쪽의 마지막 블록은 [표지 글, Claude Code 가 붙이는 글, 끝 표지] — 세션도 이 꼴(직접 준 글 + append 플래그)로 띄우므로 정체성 한 줄은 이쪽 것이 세션과 같다
  const end = custom[custom.length - 1];
  const tail = end.slice(SENTINEL.length, end.endsWith(SENTINEL_END) ? -SENTINEL_END.length : undefined).replace(/^\n+|\n+$/g, '');
  const blocks = preset.slice(2);
  const last = blocks[blocks.length - 1];
  const cut = tail && last.endsWith(tail);
  if (cut) blocks[blocks.length - 1] = last.slice(0, -tail.length).replace(/\n+$/, '');
  return { identity: custom[1], blocks, tail: cut ? tail : '' };
}

/** 조립한 배열 블록 글(systemPrompt.compose)을 SDK 옵션으로 — 첫 블록은 정적(전역 캐시 자리), 나머지는 동적. 받은 블록이 하나뿐이면 모두 동적 */
export function promptOption(composed: string[]): string[] {
  const fixed = composed.length > 1 ? composed[0] : '', rest = (composed.length > 1 ? composed.slice(1) : composed).filter((t) => t !== '').join('\n\n');
  return fixed ? [fixed, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, rest] : [rest];
}

/** system 은 system 글들, context 는 같은 요청의 messages 에 Claude Code 가 넣은 글 — 첫 사용자 메시지의 system-reminder(CLAUDE.md 등)와
 *  그 뒤 system 역할 메시지(Environment·output style·MCP 안내·스킬 목록 등), 보낸 순서대로. 우리가 친 글(PROBE)은 뺀다 */
export type SystemCapture = { system: string[]; context: string[] };
const PROBE = 'x';

/** 세션의 query 옵션(ClaudeSession.loadOptions) 그대로 Claude Code 를 한 번 돌려 첫 본 요청의 system 글들과 messages 에 붙은 글을 받는다 (ticket slcode-sidebar-revamp, 세션 구성).
 *  요금·대화 기록 없음. 사용자 훅이 이 실행에서 돌지 않게 끈다 — 그래서 SessionStart 훅이 넣는 글은 context 에 없다.
 *  SDK 0.3.322 실측(2026-11-26): output style·MCP 안내는 system 이 아니라 첫 사용자 메시지 뒤 system 역할 메시지에 들어간다 */
export async function captureSystem(options: Options, timeoutMs = 60000): Promise<SystemCapture> {
  let got: SystemCapture | null = null;
  let done!: () => void;
  const first = new Promise<void>((r) => (done = r));
  const { srv, url } = await fakeApi((system, messages) => {
    const texts = (m: Msg) => (typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? ''));
    got ??= { system, context: messages.flatMap(texts).filter((t) => t !== PROBE && t.trim()) };
    done();
  });
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    const q = query({ prompt: PROBE, options: { ...options, persistSession: false, abortController: ac, settings: { ...(options.settings as object | undefined), disableAllHooks: true } as any, env: inspectEnv(options.env ?? process.env, url) } });
    const run = (async () => { for await (const _ of q) { /* 응답은 쓰지 않는다 */ } })().then(() => { throw new Error('Claude Code ended before sending a request'); });
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timed out waiting for Claude Code')), timeoutMs); });
    await Promise.race([first, run, timeout]);
  } catch (e) {
    if (!got) throw new Error(`could not read the system prompt: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    ac.abort();
    srv.close(); srv.closeAllConnections();
  }
  return got!;
}
