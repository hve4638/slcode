// inspect 모드 (ticket slcode-inspect-proxy, 사용자 결정 2026-10-17) — Claude 벤더의 ANTHROPIC_BASE_URL 을 이 프로세스 안의 로컬 proxy 로 돌려
// API 요청·응답 원본을 세션 폴더 inspect/ 에 남긴다. proxy 는 받은 바이트를 도착하는 대로 그대로 넘긴다 (SSE 지연·순서, 압축 그대로) — 기록 사본만 끝난 뒤 푼다.
// 저장·compact(raw 삭제)·캐시 정리는 inspectDb.ts (ticket slcode-inspect-default-on — 세션별 SQLite, slcode-inspect-storage — 파싱된 정보와 raw 를 나눠 저장).
// Codex (ticket slcode-inspect-codex, 사용자 결정 2026-10-19): app-server 에 -c openai_base_url 로 같은 proxy 를 준다. HTTP 는 같은 길(요청 본문 zstd 는 기록 사본만 푼다),
// Responses API 의 WebSocket 은 그대로 중계하고 기록 사본에서 프레임을 풀어 요청 메시지 하나를 호출 하나로 남긴다.
// 1st party 감시 (사용자 결정 2026-10-19): 내부 플래그를 넣은 세션에서 tool 목록이 있는 첫 /v1/messages 요청에 x-claude-code-request-class 헤더가
// 없으면 플래그가 듣지 않는 것 — onLost. 상태 폴더에 SDK 버전과 함께 남겨(blockInspect) 그 버전에서는 새로 켜지 않는다.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { InspectCall, LoggedEvent } from './protocol.js';
import { RAW_CAP, type InspectCapture, type InspectStore } from './inspectDb.js';

const FIRST_PARTY = 'https://api.anthropic.com';
const ASSUME = '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL';
/** 1st party 로 볼 때만 붙는 요청 헤더 (2026-10-18 실측: 플래그 없이 ENABLE_TOOL_SEARCH 만이면 빠진다) */
const FIRST_PARTY_MARK = 'x-claude-code-request-class';
/** 인증으로 보이는 헤더 — 게이트웨이의 ANTHROPIC_CUSTOM_HEADERS(x-portkey-api-key·cf-aig-authorization 등)와 codex 의 chatgpt-account-id 까지. 사용량 헤더(anthropic-ratelimit-*-tokens-*)는 남긴다 */
const SECRET = /auth|api-?key|secret|cookie|access-token|session-token|account-id/i;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

/** seen: 이 proxy 가 받은 요청 경로(쿼리 뺀 것, WebSocket 은 업그레이드 경로) — 기록은 응답이 끝난 뒤라 감시는 이것으로 본다 */
export type InspectProxy = { url: string; seen: Set<string>; close: () => Promise<void> };

export const upstreamOf = (env: NodeJS.ProcessEnv): string => env.ANTHROPIC_BASE_URL || FIRST_PARTY;

/** codex 의 기본 업스트림 — ChatGPT 로그인과 API key (codex-cli 0.159 to_api_provider) */
const CODEX_CHATGPT = 'https://chatgpt.com/backend-api/codex';
const CODEX_API = 'https://api.openai.com/v1';
/** codex 에 주는 proxy 주소의 끝. codex 는 base_url 이 이것으로 끝날 때만 ChatGPT 백엔드로 보고, 아니면 Plus/Pro 의 실험적 컨텍스트 관리·모델별 헤더 등을 끈다
 *  (supports_codex_backend_routes). origin 이 chatgpt.com 이 아니라 app-server 의 workspace routing 이 host 를 되돌리지도 않는다 */
export const CODEX_ROUTE = '/backend-api/codex';
/** codex app-server 인자 — 주소는 env 가 아니라 설정으로만 바뀐다 (OPENAI_BASE_URL 은 더 이상 읽지 않는다) */
export const codexArgs = (url: string): string[] => ['-c', `openai_base_url="${url}${CODEX_ROUTE}"`];
/** codex 요청을 넘길 곳 — 사용자가 openai_base_url 을 정했으면 그곳, 아니면 ChatGPT 로그인(chatgpt-account-id 헤더)이면 chatgpt.com, 아니면 api.openai.com */
export const codexUpstream = (userBase: string | null, headers: http.IncomingHttpHeaders): string => userBase ?? (headers['chatgpt-account-id'] ? CODEX_CHATGPT : CODEX_API);

/** proxy 주소를 얹은 벤더 env. Claude Code 는 base URL host 가 api.anthropic.com 일 때만 1st party 로 보고, 아니면 tool search·beta 헤더가 달라진다
 *  (2026-10-17 실측: 요청 103KB → 172KB). 원래 1st party 였으면 내부 플래그로 판정을 지킨다 — 다른 BASE_URL 을 쓰던 사용자는 원래대로.
 *  ENABLE_TOOL_SEARCH=true(공식)는 플래그가 사라질 때의 안전망 — 그것만으로는 global 프롬프트 캐시 등이 빠진다 (2026-10-18 실측) */
export function inspectEnv(env: NodeJS.ProcessEnv, url: string): NodeJS.ProcessEnv {
  return { ...env, ANTHROPIC_BASE_URL: url, ...(keepsFirstParty(env) ? { [ASSUME]: '1', ENABLE_TOOL_SEARCH: env.ENABLE_TOOL_SEARCH ?? 'true' } : {}) };
}

/** 원래 1st party 였는가 (ANTHROPIC_BASE_URL 없음·api.anthropic.com·이미 플래그) — inspectEnv 가 내부 플래그를 넣고 proxy 가 감시할 세션 */
export function keepsFirstParty(env: NodeJS.ProcessEnv): boolean {
  if (env[ASSUME] || !env.ANTHROPIC_BASE_URL) return true;
  try { return new URL(env.ANTHROPIC_BASE_URL).host === 'api.anthropic.com'; } catch { return false; }
}

/** 이 slcode 가 묶은 Agent SDK 버전 — 내부 플래그가 사라지는 때는 SDK(번들 Claude Code)가 바뀔 때뿐이라 감시 기록의 기준 */
export function sdkVersion(): string {
  try {
    const main = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    return JSON.parse(fs.readFileSync(path.join(path.dirname(main), 'package.json'), 'utf8')).version ?? 'unknown';
  } catch { return 'unknown'; }
}

/** 이 SDK 버전에서 내부 플래그가 듣지 않는다고 기록돼 있으면 그 SDK 버전, 아니면 null (SDK 가 바뀌면 다시 검사한다) */
export function inspectBlocked(file: string): string | null {
  try { const b = JSON.parse(fs.readFileSync(file, 'utf8')); return b.sdk !== 'unknown' && b.sdk === sdkVersion() ? b.sdk : null; } catch { return null; }
}
/** SDK 버전을 모르면 남기지 않는다 — 'unknown' 끼리 같아 SDK 를 올려도 다시 검사하지 않게 된다 */
export function blockInspect(file: string) {
  const sdk = sdkVersion();
  if (sdk === 'unknown') return;
  try { fs.writeFileSync(file, JSON.stringify({ sdk, at: Date.now() }) + '\n'); } catch {}
}

/** 인증 값은 종류만 보이게 — "Bearer sk-ant-oat01-…" */
function redact(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = SECRET.test(k) ? `${String(v).match(/^(Bearer )?(sk-ant-[a-z]+\d*-)?/)?.[0] ?? ''}…(redacted)` : v;
  }
  return out;
}

/** 기록 사본만 푼다 — 비동기(스레드 풀)라 같은 때 흐르는 다른 스트림을 막지 않는다 */
async function decode(buf: Buffer, encoding: string | undefined): Promise<string> {
  const un = { gzip: zlib.gunzip, br: zlib.brotliDecompress, deflate: zlib.inflate, zstd: (zlib as any).zstdDecompress }[encoding ?? ''] as ((b: Buffer, cb: (e: Error | null, r: Buffer) => void) => void) | undefined;
  if (!un) return buf.toString('utf8');
  try { return (await promisify(un)(buf)).toString('utf8'); } // zstd 는 node 22.15+ (타입 정의엔 아직 없다)
  catch (e) { return `(${encoding} decode failed: ${(e as Error).message})`; }
}

export type InspectOptions = {
  /** 세션의 raw 합 상한 (기본 RAW_CAP) — 넘으면 오래된 raw 부터 지운다 */
  rawCap?: number;
  /** 들어온 경로에서 떼고 업스트림 경로에 잇는 앞부분 — codex 는 CODEX_ROUTE */
  prefix?: string;
  /** 1st party 감시 — 내부 플래그를 넣은 세션이면 true */
  watch?: boolean;
  /** 감시에서 플래그가 듣지 않는다고 보았을 때 한 번 */
  onLost?: () => void;
  /** 기록·감시가 실패했을 때 (core 로그) — 벤더 호출은 막지 않는다 */
  log?: (msg: string) => void;
};
/** 넘기기만 하고 남기지 않는 호출 — 턴과 상관없는 주기 호출이다. codex app-server 는 모델 목록(556KB)을 4분 30초마다,
 *  Claude Code 는 연결 확인을 보낸다 (사용자 2026-10-20: 켜 둔 Codex 세션의 기록이 모델 목록으로 하루 180MB 씩 늘어 턴 원본이 compact 됐다) */
export const unrecorded = (method: string | undefined, url: string | undefined): boolean => {
  const p = (url ?? '').split('?')[0];
  return (method === 'GET' && p.endsWith('/models')) || (method === 'HEAD' && p === '/api/hello');
};
/** 요청마다 넘길 곳 — codex 는 로그인 종류(요청 헤더)와 사용자 설정을 보고 고른다 */
export type Upstream = string | ((req: http.IncomingMessage) => string | Promise<string>);

export async function startInspect(store: InspectStore, upstream: Upstream, opts: InspectOptions = {}): Promise<InspectProxy> {
  const agents = { http: new http.Agent({ keepAlive: true }), https: new https.Agent({ keepAlive: true }) };
  const target = async (req: http.IncomingMessage) => {
    const up = new URL(typeof upstream === 'string' ? upstream : await upstream(req));
    const url = req.url ?? '/';
    const rest = opts.prefix && url.startsWith(opts.prefix) ? url.slice(opts.prefix.length) : url;
    const tls = up.protocol !== 'http:';
    return { up, mod: tls ? https : http, agent: tls ? agents.https : agents.http, path: up.pathname.replace(/\/$/, '') + rest };
  };
  let next = store.lastN() + 1; // 재기동·resume 뒤에도 번호를 잇는다
  let watching = !!opts.watch;
  const writing = new Set<Promise<void>>(); // 응답이 끝난 뒤 푸는 중인 기록 — close 가 기다린다
  const upgraded = new Set<net.Socket>(); // WebSocket 으로 넘어간 연결 — server.close 가 닫지 않는다
  const seen = new Set<string>();
  // 디스크 오류로 벤더 호출을 막지 않는다. 쓰기는 동기(트랜잭션 하나)라 순서가 섞이지 않는다. 실패는 처음 한 번만 로그에
  let failed = false;
  const save = (rec: InspectCapture) => {
    try { store.add(rec); store.tidy(Date.now(), opts.rawCap ?? RAW_CAP); }
    catch (e) { if (!failed) { failed = true; opts.log?.(`inspect could not record call ${rec.n}: ${(e as Error).message}`); } }
  };
  /** HTTP 호출 하나를 남긴다 — 본문은 끝난 뒤 푼다 (codex 는 요청도 zstd) */
  const keep = (c: { n: number; at: number; req: http.IncomingMessage; reqChunks: Buffer[]; status: number | null; resHeaders: http.IncomingHttpHeaders; resChunks: Buffer[]; error?: string }) => {
    const p = (async () => {
      const ms = Date.now() - c.at;
      const reqBody = await decode(Buffer.concat(c.reqChunks), c.req.headers['content-encoding'] as string | undefined);
      const resBody = await decode(Buffer.concat(c.resChunks), c.resHeaders['content-encoding'] as string | undefined);
      let model: string | null = null;
      try { model = JSON.parse(reqBody).model ?? null; } catch {}
      save({ n: c.n, at: c.at, ms, method: c.req.method ?? '', path: c.req.url ?? '', model, status: c.status, reqBytes: bytes(c.reqChunks), resBytes: bytes(c.resChunks),
        ...(c.error ? { error: c.error } : {}), reqHeaders: redact(c.req.headers), reqBody, resHeaders: redact(c.resHeaders), resBody });
    })().catch(() => {});
    writing.add(p); p.finally(() => writing.delete(p));
  };
  /** tool 목록이 있는 첫 메시지 요청 — 메인·서브 에이전트 요청이다 (제목 생성 같은 부수 요청엔 tool 이 없다) */
  const check = (req: http.IncomingMessage, body: string) => {
    if (!watching || req.method !== 'POST' || !req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) return;
    let tools: unknown;
    try { tools = JSON.parse(body).tools; } catch { return; }
    if (!Array.isArray(tools) || !tools.length) return;
    watching = false;
    // HTTP 이벤트 처리 안이다 — 여기서 던지면 core 가 죽는다
    if (req.headers[FIRST_PARTY_MARK] === undefined) try { opts.onLost?.(); } catch (e) { opts.log?.(`inspect first-party watch failed: ${(e as Error).message}`); }
  };

  const server = http.createServer(async (req, res) => {
    const skip = unrecorded(req.method, req.url);
    const n = skip ? 0 : next++, at = Date.now();
    seen.add((req.url ?? '').split('?')[0]);
    const reqChunks: Buffer[] = [], resChunks: Buffer[] = [];
    let status: number | null = null, resHeaders: http.IncomingHttpHeaders = {}, error: string | undefined, done = skip;
    const finish = () => { if (!done) { done = true; keep({ n, at, req, reqChunks, status, resHeaders, resChunks, error }); } };
    let t: Awaited<ReturnType<typeof target>>;
    try { t = await target(req); } catch (e) { error = (e as Error).message; res.writeHead(502).end(); finish(); return; }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
    const ureq = t.mod.request({ protocol: t.up.protocol, hostname: t.up.hostname, port: t.up.port || undefined, method: req.method, path: t.path, headers, agent: t.agent }, (ures) => {
      status = ures.statusCode ?? null; resHeaders = ures.headers;
      res.writeHead(ures.statusCode ?? 502, Object.fromEntries(Object.entries(ures.headers).filter(([k]) => !HOP.has(k))));
      res.flushHeaders();
      ures.on('data', (c: Buffer) => { resChunks.push(c); res.write(c); });
      ures.on('end', () => { res.end(); finish(); });
      ures.on('error', (e) => { error = e.message; res.destroy(); finish(); });
    });
    ureq.on('error', (e) => {
      error = e.message;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `slcode inspect proxy: ${e.message}` } }));
      else res.destroy();
      finish();
    });
    // 본문은 target 을 기다린 뒤에 읽는다 — 'data' 를 달기 전에는 흐르지 않는다
    req.on('data', (c: Buffer) => { reqChunks.push(c); ureq.write(c); });
    req.on('end', () => { ureq.end(); if (watching) check(req, Buffer.concat(reqChunks).toString('utf8')); });
    // 벤더가 끊으면(interrupt) 업스트림도 끊는다
    res.on('close', () => { if (!res.writableFinished) { error ??= 'client closed'; ureq.destroy(); finish(); } });
  });

  // WebSocket (codex 의 Responses API, 사용자 결정 2026-10-19: 그대로 중계) — 업그레이드를 업스트림으로 넘기고 101 뒤로는 두 소켓의 바이트를 그대로 잇는다.
  // permessage-deflate 제안만 빼서 넘긴다 — 프레임이 압축되지 않아 기록 사본을 풀 수 있다 (codex 는 압축 없이도 붙는다). 업스트림이 거절하면 그 응답을 그대로 돌려주고 호출 하나로 남긴다
  server.on('upgrade', async (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
    sock.on('error', () => {});
    const at = Date.now();
    seen.add((req.url ?? '').split('?')[0]);
    const fail = (error: string) => { if (!sock.destroyed) sock.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); keep({ n: next++, at, req, reqChunks: [], status: null, resHeaders: {}, resChunks: [], error }); };
    let t: Awaited<ReturnType<typeof target>>;
    try { t = await target(req); } catch (e) { fail((e as Error).message); return; }
    const headers = { ...req.headers };
    delete headers.host; delete headers['sec-websocket-extensions'];
    const ureq = t.mod.request({ protocol: t.up.protocol, hostname: t.up.hostname, port: t.up.port || undefined, method: req.method, path: t.path, headers });
    ureq.on('upgrade', (ures, usock: net.Socket, uhead: Buffer) => {
      const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`];
      for (let i = 0; i < ures.rawHeaders.length; i += 2) lines.push(`${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
      const calls = wsCalls({ path: req.url ?? '', status: ures.statusCode ?? null, reqHeaders: redact(req.headers), resHeaders: redact(ures.headers), next: () => next++, save });
      const up = frames(calls.up), down = frames(calls.down);
      upgraded.add(sock); upgraded.add(usock);
      usock.on('error', () => {});
      let ended = false;
      const end = () => { if (ended) return; ended = true; calls.close(); sock.destroy(); usock.destroy(); upgraded.delete(sock); upgraded.delete(usock); };
      sock.on('close', end); usock.on('close', end);
      if (uhead.length) { down(uhead); sock.write(uhead); }
      if (head.length) { up(head); usock.write(head); }
      sock.on('data', up); usock.on('data', down);
      sock.pipe(usock); usock.pipe(sock);
    });
    ureq.on('response', (ures) => {
      const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}`];
      for (let i = 0; i < ures.rawHeaders.length; i += 2) lines.push(`${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
      const resChunks: Buffer[] = [];
      ures.on('data', (c: Buffer) => { resChunks.push(c); sock.write(c); });
      ures.on('end', () => { sock.end(); keep({ n: next++, at, req, reqChunks: [], status: ures.statusCode ?? null, resHeaders: ures.headers, resChunks }); });
      ures.on('error', (e) => { sock.destroy(); keep({ n: next++, at, req, reqChunks: [], status: ures.statusCode ?? null, resHeaders: ures.headers, resChunks, error: e.message }); });
    });
    ureq.on('error', (e) => fail(e.message));
    ureq.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    seen,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve()); server.closeAllConnections();
        for (const s of upgraded) s.destroy();
        agents.http.destroy(); agents.https.destroy();
      });
      await Promise.all(writing);
    },
  };
}

const bytes = (chunks: Buffer[]) => chunks.reduce((s, c) => s + c.length, 0);

/** WebSocket 프레임 읽기 (기록 사본용) — 마스크를 풀고 조각난 메시지를 이어 텍스트 메시지마다 onText. 제어 프레임·바이너리는 버린다.
 *  프레임이 다 오기 전에는 이어 붙이지 않는다 — 수 MB 요청이 청크마다 복사되지 않게 */
export function frames(onText: (text: string, bytes: number) => void): (chunk: Buffer) => void {
  let pend: Buffer[] = [], have = 0, need = 2, parts: Buffer[] = [], op = 0;
  return (chunk) => {
    pend.push(chunk); have += chunk.length;
    while (have >= need) {
      const buf = pend.length === 1 ? pend[0] : Buffer.concat(pend);
      pend = [buf];
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (have < 4) { need = 4; return; } len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (have < 10) { need = 10; return; } len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      const total = off + (masked ? 4 : 0) + len;
      if (have < total) { need = total; return; }
      let data = buf.subarray(total - len, total);
      if (masked) { const key = buf.subarray(off, off + 4); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3]; }
      const fin = (buf[0] & 0x80) !== 0, code = buf[0] & 0x0f;
      pend = [buf.subarray(total)]; have -= total; need = 2;
      if (code >= 8) continue; // close·ping·pong
      if (code !== 0) { op = code; parts = []; }
      parts.push(data);
      if (fin) { const msg = Buffer.concat(parts); parts = []; if (op === 1) onText(msg.toString('utf8'), msg.length); }
    }
  };
}

/** 응답이 끝났다고 보는 이벤트 — completed 만 성공 */
const WS_END = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);

/** WebSocket 연결 하나의 호출들 — 클라이언트 메시지(response.create) 하나부터 그 응답의 끝 이벤트까지가 호출 하나. 응답은 SSE 꼴(event·data 줄)로 남겨 HTTP 기록과 같이 읽는다.
 *  codex 는 같은 연결에서 앞 응답을 잇는 요청에 previous_response_id 와 증분 input 만 보낸다 — 앞 요청 input + 서버가 낸 항목 + 증분으로 전체 요청을 다시 만들어 reqFull 에 (codex-cli 0.159 get_incremental_items) */
export function wsCalls(c: { path: string; status: number | null; reqHeaders: Record<string, string | string[]>; resHeaders: Record<string, string | string[]>; next: () => number; save: (rec: InspectCapture) => void }) {
  type Open = { n: number; at: number; req: string; full: string | null; model: string | null; events: string[]; up: number; down: number };
  let open: Open | null = null;
  let chain: { input: unknown[]; output: unknown[]; id: string | null } | null = null;
  const finish = (error?: string) => {
    if (!open) return;
    const o = open; open = null;
    c.save({ n: o.n, at: o.at, ms: Date.now() - o.at, method: 'WS', path: c.path, model: o.model, status: c.status, reqBytes: o.up, resBytes: o.down, ...(error ? { error } : {}),
      reqHeaders: c.reqHeaders, reqBody: o.req, ...(o.full ? { reqFull: o.full } : {}), resHeaders: c.resHeaders, resBody: o.events.join('') });
  };
  return {
    up(text: string, n: number) {
      finish('no response end before the next request');
      let msg: any = null;
      try { msg = JSON.parse(text); } catch {}
      const input: unknown[] = Array.isArray(msg?.input) ? msg.input : [];
      let full: string | null = null;
      if (chain && msg?.previous_response_id && chain.id === msg.previous_response_id) {
        const all = [...chain.input, ...chain.output, ...input];
        full = JSON.stringify({ ...msg, input: all });
        chain = { input: all, output: [], id: null };
      } else chain = { input, output: [], id: null };
      open = { n: c.next(), at: Date.now(), req: text, full, model: msg?.model ?? null, events: [], up: n, down: 0 };
    },
    down(text: string, n: number) {
      if (!open) return; // 요청 없이 온 이벤트
      let ev: any = null;
      try { ev = JSON.parse(text); } catch {}
      open.events.push(`event: ${ev?.type ?? 'message'}\ndata: ${text}\n\n`); open.down += n;
      if (!ev || !chain) return;
      if (typeof ev.response?.id === 'string') chain.id = ev.response.id;
      if (ev.type === 'response.output_item.done') chain.output.push(ev.item);
      if (WS_END.has(ev.type)) finish(ev.type === 'response.completed' ? undefined : `${ev.type}: ${ev.response?.error?.message ?? ev.response?.incomplete_details?.reason ?? ev.error?.message ?? ev.message ?? ''}`.replace(/: $/, ''));
    },
    close() { finish('connection closed'); },
  };
}

/** seq end 의 turn.end 에 귀속되는 호출 — 앞 turn.end 시각 뒤부터 이 turn.end 시각까지 시작한 것. 턴은 보낸 순서대로 끝나므로 줄 선 턴도 맞고,
 *  첫 턴 앞의 기동 호출은 첫 턴에, 턴 사이(재기동 등)의 호출은 다음 턴에 붙는다 */
export function turnCalls(store: InspectStore | null, events: readonly LoggedEvent[], end: number): InspectCall[] {
  const ends = events.filter((e) => e.ev.kind === 'turn.end');
  const i = ends.findIndex((e) => e.seq === end);
  if (i < 0 || !store) return [];
  return store.calls(i > 0 ? ends[i - 1].at : -Infinity, ends[i].at);
}
