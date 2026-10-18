// inspect 모드 (ticket slcode-inspect-proxy, 사용자 결정 2026-10-17) — Claude 벤더의 ANTHROPIC_BASE_URL 을 이 프로세스 안의 로컬 proxy 로 돌려
// API 요청·응답 원본을 세션 폴더 inspect/ 에 남긴다. proxy 는 받은 바이트를 도착하는 대로 그대로 넘긴다 (SSE 지연·순서, 압축 그대로) — 기록 사본만 끝난 뒤 푼다.
//   inspect/<n>.json     호출 하나의 원본 (InspectRecord)
//   inspect/index.jsonl  끝난 순서의 요약 (InspectCall 한 줄씩) — 상한으로 <n>.json 을 지워도 남아 dropped 로 보인다
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { InspectCall, InspectRecord, LoggedEvent } from './protocol.js';

/** 세션당 <n>.json 합의 상한 — 넘으면 오래된 호출부터 지운다 (사용자 2026-10-17: 세션의 74% 가 통째로 남는 크기) */
export const INSPECT_CAP = 100 * 1024 * 1024;
const FIRST_PARTY = 'https://api.anthropic.com';
const ASSUME = '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL';
/** 인증으로 보이는 헤더 — 게이트웨이의 ANTHROPIC_CUSTOM_HEADERS(x-portkey-api-key·cf-aig-authorization 등)까지. 사용량 헤더(anthropic-ratelimit-*-tokens-*)는 남긴다 */
const SECRET = /auth|api-?key|secret|cookie|access-token|session-token/i;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

export type InspectProxy = { url: string; close: () => Promise<void> };

export const upstreamOf = (env: NodeJS.ProcessEnv): string => env.ANTHROPIC_BASE_URL || FIRST_PARTY;

/** proxy 주소를 얹은 벤더 env. Claude Code 는 base URL host 가 api.anthropic.com 일 때만 1st party 로 보고, 아니면 tool search·beta 헤더가 달라진다
 *  (2026-10-17 실측: 요청 103KB → 172KB). 원래 1st party 였으면 내부 플래그로 판정을 지킨다 — 다른 BASE_URL 을 쓰던 사용자는 원래대로.
 *  ENABLE_TOOL_SEARCH=true(공식)는 플래그가 사라질 때의 안전망 — 그것만으로는 global 프롬프트 캐시 등이 빠진다 (2026-10-18 실측) */
export function inspectEnv(env: NodeJS.ProcessEnv, url: string): NodeJS.ProcessEnv {
  let firstParty = !!env[ASSUME] || !env.ANTHROPIC_BASE_URL;
  try { if (env.ANTHROPIC_BASE_URL && new URL(env.ANTHROPIC_BASE_URL).host === 'api.anthropic.com') firstParty = true; } catch {}
  return { ...env, ANTHROPIC_BASE_URL: url, ...(firstParty ? { [ASSUME]: '1', ENABLE_TOOL_SEARCH: env.ENABLE_TOOL_SEARCH ?? 'true' } : {}) };
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

function readIndex(dir: string): InspectCall[] {
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8'); } catch {}
  return text.split('\n').flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
}

export async function startInspect(dir: string, upstream: string, cap = INSPECT_CAP): Promise<InspectProxy> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const up = new URL(upstream);
  const base = up.pathname.replace(/\/$/, '');
  const mod = up.protocol === 'http:' ? http : https;
  const agent = new mod.Agent({ keepAlive: true });
  // 남은 기록 — 번호를 이어 매기고, 상한은 남은 파일까지 센다
  let next = readIndex(dir).reduce((m, c) => Math.max(m, c.n), 0) + 1;
  const kept: { n: number; size: number }[] = fs.readdirSync(dir).flatMap((f) => {
    const m = f.match(/^(\d+)\.json$/);
    return m ? [{ n: Number(m[1]), size: fs.statSync(path.join(dir, f)).size }] : [];
  }).sort((a, b) => a.n - b.n);
  let total = kept.reduce((s, k) => s + k.size, 0);

  // 저장은 줄을 세워 하나씩 — 상한 계산과 index 순서가 섞이지 않게. 디스크 오류로 벤더 호출을 막지 않는다
  let saving = Promise.resolve();
  const save = (rec: InspectRecord) => (saving = saving.then(async () => {
    const file = JSON.stringify(rec);
    await fs.promises.writeFile(path.join(dir, `${rec.n}.json`), file, { mode: 0o600 });
    const { reqHeaders: _a, reqBody: _b, resHeaders: _c, resBody: _d, ...call } = rec;
    await fs.promises.appendFile(path.join(dir, 'index.jsonl'), JSON.stringify(call) + '\n', { mode: 0o600 });
    kept.push({ n: rec.n, size: Buffer.byteLength(file) }); total += kept[kept.length - 1].size;
    while (total > cap && kept.length > 1) { const old = kept.shift()!; total -= old.size; await fs.promises.unlink(path.join(dir, `${old.n}.json`)).catch(() => {}); }
  }).catch(() => {}));

  const server = http.createServer((req, res) => {
    const n = next++, at = Date.now();
    const reqChunks: Buffer[] = [], resChunks: Buffer[] = [];
    let status: number | null = null, resHeaders: http.IncomingHttpHeaders = {}, error: string | undefined, done = false;
    const finish = async () => {
      if (done) return; done = true;
      const ms = Date.now() - at;
      const reqBody = Buffer.concat(reqChunks).toString('utf8'), resBody = await decode(Buffer.concat(resChunks), resHeaders['content-encoding'] as string | undefined);
      let model: string | null = null;
      try { model = JSON.parse(reqBody).model ?? null; } catch {}
      await save({ n, at, ms, method: req.method ?? '', path: req.url ?? '', model, status, reqBytes: reqChunks.reduce((s, c) => s + c.length, 0), resBytes: resChunks.reduce((s, c) => s + c.length, 0),
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
    req.on('end', () => ureq.end());
    // 벤더가 끊으면(interrupt) 업스트림도 끊는다
    res.on('close', () => { if (!res.writableFinished) { error ??= 'client closed'; ureq.destroy(); finish(); } });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); agent.destroy(); }); await saving; },
  };
}

/** seq end 의 turn.end 에 귀속되는 호출 — 앞 turn.end 시각 뒤부터 이 turn.end 시각까지 시작한 것. 턴은 보낸 순서대로 끝나므로 줄 선 턴도 맞고,
 *  첫 턴 앞의 기동 호출은 첫 턴에, 턴 사이(재기동 등)의 호출은 다음 턴에 붙는다 */
export function turnCalls(dir: string, events: readonly LoggedEvent[], end: number): InspectCall[] {
  const ends = events.filter((e) => e.ev.kind === 'turn.end');
  const i = ends.findIndex((e) => e.seq === end);
  if (i < 0) return [];
  const from = i > 0 ? ends[i - 1].at : -Infinity, to = ends[i].at;
  return readIndex(dir).filter((c) => c.at > from && c.at <= to).sort((a, b) => a.n - b.n)
    .map((c) => (fs.existsSync(path.join(dir, `${c.n}.json`)) ? c : { ...c, dropped: true }));
}

export function readCall(dir: string, n: number): InspectRecord | null {
  if (!Number.isInteger(n)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), 'utf8')); } catch { return null; }
}
