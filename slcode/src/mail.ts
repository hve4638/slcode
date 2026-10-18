// 세션 사이 메시지 (ticket slcode-p2p-messaging, 사용자 결정 2026-10-19: 우체국 없이 P2P) — 받는 이 찾기·전달·턴 본문 꼴.
// 받는 이는 켜진 세션 중에서 id 또는 제목으로 찾고, 그 소켓의 session.deliver 로 넘긴다. 못 찾으면 꺼져 있든 없든 no_session —
// 꺼진 세션에는 보내지 않는다 (보관하면 같은 제목의 옛 세션이 계속 지목되어 받는 이가 모호해진다, 사용자 2026-10-19).
// 턴 본문은 slcode 독자 머리표 — Claude Code 의 <cross-session-message> 봉투는 권한 부류가 다르면 보류되고 SDK 에 승인 수단이 없어
// 5분 뒤 버려진다 (Agent SDK 0.3.282 실측). 머리표의 뜻은 prompt.ts 가 알린다. web/app.js 의 MAIL_RE 는 이 정규식의 사본 (브라우저라 import 못 한다).
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventLog, type SessionMeta } from './eventLog.js';
import { connectSession } from './client.js';
import { sockAlive } from './live.js';
import { CoreError, ERR, type Mail } from './protocol.js';

const TAG = 'slcode-message';
const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, ' ');
const unattr = (v: string) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** `<slcode-message id from name kind at [via] [re]>` + 본문(문자열 아니면 JSON) + 닫는 태그. name 은 from 세션의 제목 (없으면 뺀다) */
export function formatMail(m: Mail, fromName: string | null): string {
  const attrs: [string, string | null | undefined][] = [['id', m.id], ['from', m.from], ['name', fromName], ['kind', m.kind], ['at', new Date(m.ts).toISOString()], ['via', m.via], ['re', m.re]];
  const body = (typeof m.body === 'string' ? m.body : JSON.stringify(m.body, null, 2)).replaceAll(`</${TAG}`, `<\\/${TAG}`);
  return `<${TAG} ${attrs.filter(([, v]) => v).map(([k, v]) => `${k}="${attr(v!)}"`).join(' ')}>\n${body}\n</${TAG}>`;
}

const MAIL_RE = new RegExp(`<${TAG} ([^>]*)>\\n([\\s\\S]*?)\\n</${TAG}>`, 'g');

/** 한 턴 본문(빈 줄로 이은 여러 통)에서 머리표의 속성 — 재기동 뒤 reply 대상 복원 */
export function parseMails(text: string): Record<string, string>[] {
  return [...text.matchAll(MAIL_RE)].map((m) => Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], unattr(a[2])])));
}

/** id 의 저장 세션 meta — events 를 읽지 않는다 (없으면 null). 머리표의 name(보낸 세션의 제목) */
export function sessionMeta(sessionsDir: string, id: string): SessionMeta | null {
  const dir = EventLog.find(sessionsDir, id);
  if (!dir) return null;
  try { return JSON.parse(fs.readFileSync(EventLog.metaPath(dir), 'utf8')) as SessionMeta; } catch { return null; }
}

export function newMail(p: Omit<Mail, 'id' | 'ts'> & { id?: string; ts?: number }): Mail {
  return { ...p, id: p.id || randomUUID().slice(0, 8), ts: p.ts || Date.now() };
}

/** 켜진 세션 중에서 id 또는 제목으로 — 없으면 no_session, 같은 제목이 여럿 켜져 있으면 후보를 담아 bad_request */
export async function findLive(sessionsDir: string, s: string): Promise<{ sock: string; meta: SessionMeta }> {
  const hits = EventLog.list(sessionsDir).filter((m) => m.id === s || m.title === s).map((m) => ({ meta: m, sock: new EventLog(sessionsDir, m).sockPath }));
  const alive = await Promise.all(hits.map((h) => sockAlive(h.sock)));
  const live = hits.filter((_, i) => alive[i]);
  const one = live.find((h) => h.meta.id === s) ?? (live.length === 1 ? live[0] : null);
  if (one) return one;
  if (live.length > 1) throw new CoreError(ERR.badRequest, `ambiguous title "${s}": ${live.map((h) => h.meta.id).join(', ')}`);
  throw new CoreError(ERR.noSession, `no session ${s}`);
}

/** 켜진 세션을 찾아 그 소켓에 session.deliver — 받는 core 가 다음 idle 에 한 턴으로 넣는다 */
export async function sendMail(sessionsDir: string, to: string, p: Omit<Mail, 'id' | 'ts' | 'to'>): Promise<{ id: string; to: string }> {
  const target = await findLive(sessionsDir, to);
  const m = newMail({ ...p, to: target.meta.id });
  let client;
  try { client = await connectSession(target.sock); } catch { throw new CoreError(ERR.noSession, `no session ${to}`); }
  try { await client.request('session.deliver', { id: target.meta.id, mail: m }); } finally { client.close(); }
  return { id: m.id, to: target.meta.id };
}
