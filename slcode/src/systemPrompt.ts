// Claude system prompt 편집 (ticket slcode-profile-system-prompt, 사용자 결정 2026-11-17 — ws docs/ticket/slcode-profile-system-prompt/TICKET.md).
// 프롬프트(promptLibrary.ts 의 판)는 Claude Code 의 기본 프롬프트를 블록 단위로 끄고·고치고·나누고, 사이에 글을 더한다. 설정은 원문과 따로 블록 해시로 가리킨다 —
// 다시 가져온 원본에도 같은 블록이면 설정이 이어진다 (ticket slcode-prompt-library: 원문은 판에 함께 저장한다).
// 받은 프롬프트(promptCapture.ts)를 줄로 쪼개고, 블록은 연속한 줄 몇 개다. 블록마다 첫 줄 해시(head)·줄 수(lines)·전체 해시(hash)를 저장해
// 첫 줄 해시로 시작 자리를 찾고 전체 해시가 맞으면 그 블록의 설정을 적용한다. 맞지 않는 줄은 받은 글 그대로 나간다 — Claude Code 가 한 블록의 글을
// 바꾸면 그 블록의 설정만 풀린다. 해시는 세션마다 다른 값(메모리 경로·작업 폴더·홈)을 자리표시로 바꾼 뒤 잰다.
// 우리가 미리 나눠 둔 블록과 설명(promptPieces.ts)은 같은 방식으로 맞는 것에만 씌우는 보조다.
import { createHash } from 'node:crypto';
import path from 'node:path';

/** 저장되는 블록 — 끄거나(off) 고치거나(text) 사용자가 직접 나눈 것만. note 는 화면의 설명. 미리 나눠 둔 블록(promptPieces)의 off 는 처음 가져올 때 끌지 여부라 segment 가 입히지 않는다 */
export type PromptPiece = { head: string; lines: number; hash: string; note?: string; off?: true; text?: string };
/** 사용자가 더한 글 — after 는 바로 앞 블록(이나 제목 줄)의 hash, null 이면 맨 앞. 앞 블록을 찾지 못하면 맨 끝에 둔다 */
export type PromptAdded = { after: string | null; text: string; note?: string; off?: true };
export type PromptSpec = { pieces: PromptPiece[]; added: PromptAdded[] };

/** 화면과 조립이 함께 쓰는 한 줄 — block 은 받은 배열 블록의 번호, gap 은 앞의 빈 줄 수.
 *  piece 의 known 은 어느 표에서 맞았는가(없으면 맞는 것이 없어 통째로 둔 줄들). text 는 받은 글, edit 는 고친 글 */
export type PromptItem =
  | { kind: 'heading'; block: number; gap: number; text: string; hash: string }
  | { kind: 'piece'; block: number; gap: number; text: string; head: string; lines: number; hash: string; known: 'profile' | 'builtin' | null; note?: string; off?: true; edit?: string }
  | { kind: 'added'; block: number; gap: number; text: string; note?: string; off?: true };

export type Norm = (s: string) => string;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 세션마다 다른 값을 자리표시로 — 메모리 경로(<설정 폴더>/projects/<폴더 슬러그>/…), 설정 폴더, 작업 폴더, 홈. 긴 것부터 */
export function normalizer(p: { configDir: string; cwd: string; home: string }): Norm {
  const rules: [RegExp, string][] = [[new RegExp(`${esc(p.configDir)}/projects/[^/\\s\`'"]+`, 'g'), '<memory>']];
  for (const [v, to] of ([[p.configDir, '<config>'], [p.cwd, '<cwd>'], [p.home, '<home>']] as const).filter(([v]) => v.length > 1).sort((a, b) => b[0].length - a[0].length)) rules.push([new RegExp(esc(v), 'g'), to]);
  return (s) => rules.reduce((t, [re, to]) => t.replace(re, to), s);
}
export const normOf = (env: NodeJS.ProcessEnv, cwd: string, home: string): Norm =>
  normalizer({ configDir: path.resolve(env.CLAUDE_CONFIG_DIR || path.join(env.HOME || home, '.claude')), cwd: path.resolve(cwd), home: env.HOME || home });

const sha = (s: string, n: number) => createHash('sha256').update(s).digest('hex').slice(0, n);
/** 블록 글의 세 값 — 첫 줄 해시·줄 수·전체 해시 */
export function pieceKey(text: string, norm: Norm): { head: string; lines: number; hash: string } {
  const t = norm(text), lines = t.split('\n');
  return { head: sha(lines[0], 8), lines: lines.length, hash: sha(t, 16) };
}
const isHeading = (l: string) => /^#{1,6} \S/.test(l);

/** 받은 배열 블록들을 화면·조립의 줄로 — 저장된 블록(spec)을 먼저, 그다음 미리 나눠 둔 블록(builtin)을 맞춘다. 맞는 것이 없는 줄들은 다음 맞는 블록·제목 줄 전까지 한 덩어리 */
export function segment(blocks: string[], spec: PromptSpec | undefined, builtin: readonly PromptPiece[], norm: Norm): PromptItem[] {
  const byHead = new Map<string, { p: PromptPiece; from: 'profile' | 'builtin' }[]>();
  const put = (p: PromptPiece, from: 'profile' | 'builtin') => { const a = byHead.get(p.head) ?? []; a.push({ p, from }); byHead.set(p.head, a); };
  for (const p of spec?.pieces ?? []) put(p, 'profile');
  for (const p of builtin) put(p, 'builtin');
  // 저장된 블록에 설명이 없으면(처음 가져올 때 끈 블록·옛 설정) 같은 블록의 미리 쓴 설명을 쓴다
  const noteOf = new Map(builtin.filter((p) => p.note).map((p) => [p.hash, p.note!]));
  const items: PromptItem[] = [];
  blocks.forEach((text, block) => {
    const raw = text.split('\n'), nl = raw.map(norm), heads = nl.map((l) => sha(l, 8));
    const match = (i: number) => (byHead.get(heads[i]) ?? []).find(({ p }) => i + p.lines <= raw.length && sha(nl.slice(i, i + p.lines).join('\n'), 16) === p.hash);
    let gap = 0;
    for (let i = 0; i < raw.length;) {
      if (raw[i] === '') { gap++; i++; continue; }
      const m = match(i);
      if (m) {
        const { p, from } = m;
        items.push({ kind: 'piece', block, gap, text: raw.slice(i, i + p.lines).join('\n'), head: p.head, lines: p.lines, hash: p.hash, known: from, ...(p.note ?? noteOf.get(p.hash) ? { note: p.note ?? noteOf.get(p.hash) } : {}), ...(from === 'profile' && p.off ? { off: true } : {}), ...(p.text !== undefined ? { edit: p.text } : {}) });
        i += p.lines; gap = 0; continue;
      }
      if (isHeading(raw[i])) { items.push({ kind: 'heading', block, gap, text: raw[i], hash: sha(nl[i], 16) }); i++; gap = 0; continue; }
      let j = i + 1, end = j; // end 는 덩어리의 마지막 글 줄 다음
      for (; j < raw.length; j++) { if (raw[j] === '') continue; if (match(j) || isHeading(raw[j])) break; end = j + 1; }
      const t = raw.slice(i, end).join('\n');
      items.push({ kind: 'piece', block, gap, text: t, ...pieceKey(t, norm), known: null });
      i = end; gap = 0;
    }
  });
  // 더한 글 — 앞 블록 바로 뒤(같은 앞 블록이면 저장된 순서), 앞 블록이 없어졌으면 맨 끝
  for (const a of spec?.added ?? []) {
    let at = a.after === null ? 0 : items.findIndex((it) => it.kind !== 'added' && it.hash === a.after) + 1;
    if (a.after !== null && at === 0) at = items.length;
    else while (at < items.length && items[at].kind === 'added') at++;
    const block = at > 0 ? items[at - 1].block : 0;
    items.splice(at, 0, { kind: 'added', block, gap: 1, text: a.text, ...(a.note ? { note: a.note } : {}), ...(a.off ? { off: true } : {}) });
  }
  return items;
}

/** 줄들을 배열 블록별 글로 — 끈 것은 빼고 고친 것은 고친 글로. 제목 줄은 다음 제목 줄 전에 나가는 글이 있을 때만 나간다. 아무것도 바꾸지 않았으면 받은 글과 같다 */
export function compose(items: PromptItem[], blocks: number): string[] {
  const out: string[] = [];
  for (let b = 0; b < blocks; b++) {
    const mine = items.filter((it) => it.block === b);
    const body = (it: PromptItem) => (it.kind === 'heading' ? it.text : it.off ? '' : it.kind === 'piece' ? it.edit ?? it.text : it.text);
    const live = (i: number) => { const it = mine[i]; if (it.kind !== 'heading') return body(it).trim() !== ''; for (let j = i + 1; j < mine.length && mine[j].kind !== 'heading'; j++) if (body(mine[j]).trim() !== '') return true; return false; };
    let s = '', first = true, afterAdded = false;
    mine.forEach((it, i) => {
      if (!live(i)) return;
      const gap = afterAdded ? Math.max(it.gap, 1) : it.gap;
      s += '\n'.repeat(first ? gap : gap + 1) + body(it);
      first = false; afterAdded = it.kind === 'added';
    });
    out.push(s);
  }
  return out;
}

const str = (v: unknown): v is string => typeof v === 'string';
/** 디스크·화면에서 온 값을 PromptSpec 으로 — 꼴이 아니면 undefined, 비었으면(블록도 더한 글도 없음) undefined */
export function cleanSpec(v: unknown): PromptSpec | undefined {
  const o = v as { pieces?: unknown; added?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.pieces) || !Array.isArray(o.added)) return undefined;
  const pieces: PromptPiece[] = [], added: PromptAdded[] = [];
  for (const p of o.pieces as Record<string, unknown>[]) {
    if (!p || !str(p.head) || !str(p.hash) || !Number.isInteger(p.lines) || (p.lines as number) < 1) return undefined;
    pieces.push({ head: p.head, lines: p.lines as number, hash: p.hash, ...(str(p.note) && p.note ? { note: p.note } : {}), ...(p.off === true ? { off: true } : {}), ...(str(p.text) ? { text: p.text } : {}) });
  }
  for (const a of o.added as Record<string, unknown>[]) {
    if (!a || !str(a.text) || !(a.after === null || str(a.after))) return undefined;
    added.push({ after: a.after as string | null, text: a.text, ...(str(a.note) && a.note ? { note: a.note } : {}), ...(a.off === true ? { off: true } : {}) });
  }
  return pieces.length || added.length ? { pieces, added } : undefined;
}
export const sameSpec = (a: PromptSpec | undefined, b: PromptSpec | undefined) => JSON.stringify(cleanSpec(a) ?? null) === JSON.stringify(cleanSpec(b) ?? null);

/** 편집 창이 저장할 때 보내는 줄 — 받은 글(text) 그대로와 화면에서 정한 것. user 는 사용자가 나누거나 합쳐 만든 블록 */
export type EditedItem =
  | { kind: 'heading'; text: string }
  | { kind: 'piece'; text: string; note?: string; off?: boolean; edit?: string | null; user?: boolean }
  | { kind: 'added'; text: string; note?: string; off?: boolean };
/** 편집 창의 줄들을 저장할 꼴로 — 블록은 끄거나 고치거나 사용자가 만든 것만 남긴다(나머지는 받은 대로라 적을 것이 없다) */
export function specOf(edited: EditedItem[], norm: Norm): PromptSpec | undefined {
  const pieces: PromptPiece[] = [], added: PromptAdded[] = [];
  let anchor: string | null = null;
  for (const it of edited) {
    if (it.kind === 'heading') { anchor = sha(norm(it.text), 16); continue; }
    if (it.kind === 'added') { if (it.text.trim()) added.push({ after: anchor, text: it.text, ...(it.note ? { note: it.note } : {}), ...(it.off ? { off: true } : {}) }); continue; }
    const k = pieceKey(it.text, norm), edit = str(it.edit) && it.edit !== it.text ? it.edit : undefined;
    anchor = k.hash;
    if (it.off || edit !== undefined || it.user) pieces.push({ ...k, ...(it.note ? { note: it.note } : {}), ...(it.off ? { off: true } : {}), ...(edit !== undefined ? { text: edit } : {}) });
  }
  return cleanSpec({ pieces, added });
}
