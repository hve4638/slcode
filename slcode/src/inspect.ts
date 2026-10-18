// inspect 모드 (ticket slcode-inspect-proxy, 사용자 결정 2026-10-17) — Claude 벤더의 ANTHROPIC_BASE_URL 을 이 프로세스 안의 로컬 proxy 로 돌려
// API 요청·응답 원본을 세션 폴더 inspect/ 에 남긴다. proxy 는 받은 바이트를 도착하는 대로 그대로 넘긴다 (SSE 지연·순서, 압축 그대로) — 기록 사본만 끝난 뒤 푼다.
// 저장·compact·전체 상한은 inspectDb.ts (ticket slcode-inspect-default-on — 세션별 SQLite).
// 1st party 감시 (사용자 결정 2026-10-19): 내부 플래그를 넣은 세션에서 tool 목록이 있는 첫 /v1/messages 요청에 x-claude-code-request-class 헤더가
// 없으면 플래그가 듣지 않는 것 — onLost. 상태 폴더에 SDK 버전과 함께 남겨(blockInspect) 그 버전에서는 새로 켜지 않는다.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import type { InspectCall, InspectRecord, LoggedEvent } from './protocol.js';
import { RAW_CAP, type InspectStore } from './inspectDb.js';

const FIRST_PARTY = 'https://api.anthropic.com';
const ASSUME = '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL';
/** 1st party 로 볼 때만 붙는 요청 헤더 (2026-10-18 실측: 플래그 없이 ENABLE_TOOL_SEARCH 만이면 빠진다) */
const FIRST_PARTY_MARK = 'x-claude-code-request-class';
/** 인증으로 보이는 헤더 — 게이트웨이의 ANTHROPIC_CUSTOM_HEADERS(x-portkey-api-key·cf-aig-authorization 등)까지. 사용량 헤더(anthropic-ratelimit-*-tokens-*)는 남긴다 */
const SECRET = /auth|api-?key|secret|cookie|access-token|session-token/i;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

export type InspectProxy = { url: string; close: () => Promise<void> };

export const upstreamOf = (env: NodeJS.ProcessEnv): string => env.ANTHROPIC_BASE_URL || FIRST_PARTY;

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
  /** 세션의 raw 합 상한 (기본 RAW_CAP) — 넘으면 오래된 raw 부터 compact */
  rawCap?: number;
  /** 1st party 감시 — 내부 플래그를 넣은 세션이면 true */
  watch?: boolean;
  /** 감시에서 플래그가 듣지 않는다고 보았을 때 한 번 */
  onLost?: () => void;
  /** 기록·감시가 실패했을 때 (core 로그) — 벤더 호출은 막지 않는다 */
  log?: (msg: string) => void;
};

export async function startInspect(store: InspectStore, upstream: string, opts: InspectOptions = {}): Promise<InspectProxy> {
  const up = new URL(upstream);
  const base = up.pathname.replace(/\/$/, '');
  const mod = up.protocol === 'http:' ? http : https;
  const agent = new mod.Agent({ keepAlive: true });
  let next = store.lastN() + 1; // 재기동·resume 뒤에도 번호를 잇는다
  let watching = !!opts.watch;
  const writing = new Set<Promise<void>>(); // 응답이 끝난 뒤 푸는 중인 기록 — close 가 기다린다
  // 디스크 오류로 벤더 호출을 막지 않는다. 쓰기는 동기(트랜잭션 하나)라 순서가 섞이지 않는다. 실패는 처음 한 번만 로그에
  let failed = false;
  const save = (rec: InspectRecord) => {
    try { store.add(rec); store.tidy(Date.now(), opts.rawCap ?? RAW_CAP); }
    catch (e) { if (!failed) { failed = true; opts.log?.(`inspect could not record call ${rec.n}: ${(e as Error).message}`); } }
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

  const server = http.createServer((req, res) => {
    const n = next++, at = Date.now();
    const reqChunks: Buffer[] = [], resChunks: Buffer[] = [];
    let status: number | null = null, resHeaders: http.IncomingHttpHeaders = {}, error: string | undefined, done = false;
    const finish = () => {
      if (done) return; done = true;
      const p = record().catch(() => {});
      writing.add(p); p.finally(() => writing.delete(p));
    };
    const record = async () => {
      const ms = Date.now() - at;
      const reqBody = Buffer.concat(reqChunks).toString('utf8'), resBody = await decode(Buffer.concat(resChunks), resHeaders['content-encoding'] as string | undefined);
      let model: string | null = null;
      try { model = JSON.parse(reqBody).model ?? null; } catch {}
      save({ n, at, ms, method: req.method ?? '', path: req.url ?? '', model, status, reqBytes: reqChunks.reduce((s, c) => s + c.length, 0), resBytes: resChunks.reduce((s, c) => s + c.length, 0),
        ...(error ? { error } : {}), reqHeaders: redact(req.headers), reqBody, resHeaders: redact(resHeaders), resBody });
    };
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
    const ureq = mod.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: req.method, path: base + (req.url ?? '/'), headers, agent }, (ures) => {
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
    req.on('data', (c: Buffer) => { reqChunks.push(c); ureq.write(c); });
    req.on('end', () => { ureq.end(); if (watching) check(req, Buffer.concat(reqChunks).toString('utf8')); });
    // 벤더가 끊으면(interrupt) 업스트림도 끊는다
    res.on('close', () => { if (!res.writableFinished) { error ??= 'client closed'; ureq.destroy(); finish(); } });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); agent.destroy(); }); await Promise.all(writing); },
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
