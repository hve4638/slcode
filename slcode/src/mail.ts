// 우편 본문 꼴 (ticket superlite-agent-messaging, 사용자 확정 2026-10-02: 스탠드얼론 slcode 메시징) — 세션 턴에 들어가는 머리말과 그 역파싱.
// serve.ts(flushMail·재기동 복원)와 cli.ts(check 출력)가 같은 꼴을 쓴다. web/app.js 의 MAIL_HEAD 는 이 정규식의 사본 (브라우저라 import 못 한다).
// 둘째 줄의 답장 안내는 우편을 받은 Claude 가 Claude Code 의 SendMessage 를 부른 실측 때문 (agent-core-split 경계 실측).
import type { Mail } from './protocol.js';

/** `[mail <id> from <세션 id> (<제목>) at <iso> kind=<kind> re=<원 우편 id>]` + `답장: slcode reply <id> <본문>` + 본문 */
export function formatMail(m: Mail, fromTitle: string | null): string {
  const head = `[mail ${m.id} from ${m.from}${fromTitle ? ` (${fromTitle})` : ''} at ${new Date(m.ts).toISOString()} kind=${m.kind}${m.re ? ` re=${m.re}` : ''}]`;
  const body = typeof m.body === 'string' ? m.body : JSON.stringify(m.body, null, 2);
  return `${head}\n답장: slcode reply ${m.id} <본문>\n${body}`;
}

export const MAIL_HEAD = /^\[mail (\S+) from (\S+)(?: \((.*?)\))? at (\S+) kind=(\S+)(?: re=(\S+))?\]\n(?:답장: [^\n]*\n)?/;

/** 한 턴 본문(빈 줄로 이은 여러 통)에서 우편 id·보낸 이 — 재기동 뒤 reply 대상 복원 */
export function parseMailHeads(text: string): { id: string; from: string }[] {
  const out: { id: string; from: string }[] = [];
  for (const chunk of text.split(/\n\n(?=\[mail )/)) { const m = chunk.match(MAIL_HEAD); if (m) out.push({ id: m[1], from: m[2] }); }
  return out;
}
