// 입력창의 `/<명령>` 판정 (ticket slcode-agent-plugin-command, 사용자 결정 2026-11-02) — 에이전트 플러그인 명령인지는 core 가 정한다. 화면(web)은 후보를 보이고 짧은 이름을 넓혀 보낼 뿐이다.
// 쓸 수 없는 명령: Claude 내장 명령(SDK supportedCommands 의 builtin — 이름·별칭)과 이름이 같은 것, 전체 이름(<플러그인>:<명령>)이 벤더 명령과 정확히 같은 것.
// 짧은 이름: 그 이름으로 맞는 것(플러그인 명령의 이름, 벤더 명령의 전체 이름과 ':' 뒤 이름)이 하나뿐일 때만 명령으로 — 겹치면 전체 이름으로만 부른다(웹 자동 완성의 축약과 같은 규칙).
// 대소문자는 가리지 않는다.
import type { LoadedCommand } from 'slcode-plugin/hookRunner';
import type { Command } from './base.js';

const shortOf = (name: string) => name.slice(name.indexOf(':') + 1);
export const fullName = (c: LoadedCommand) => `${c.plugin}:${c.name}`;

/** 쓸 수 있는 것과 막힌 것(사유) */
export function commandTable(cmds: LoadedCommand[], vendor: Command[]): { usable: LoadedCommand[]; blocked: { cmd: LoadedCommand; why: string }[] } {
  const builtin = new Map<string, string>();
  for (const v of vendor) if (v.builtin) for (const n of [v.name, ...(v.aliases ?? [])]) builtin.set(n.toLowerCase(), v.name);
  const names = new Set(vendor.map((v) => v.name.toLowerCase()));
  const usable: LoadedCommand[] = [], blocked: { cmd: LoadedCommand; why: string }[] = [];
  for (const c of cmds) {
    const b = builtin.get(c.name.toLowerCase());
    if (b) blocked.push({ cmd: c, why: `Claude 내장 명령 /${b} 와 이름이 겹칩니다` });
    else if (names.has(fullName(c).toLowerCase())) blocked.push({ cmd: c, why: `같은 이름의 Claude 명령 /${fullName(c)} 이 있습니다` });
    else usable.push(c);
  }
  return { usable, blocked };
}

/** 글이 명령이면 그 명령과 인자. argsAt 은 글 안에서 인자가 시작하는 자리(명령 이름 뒤 첫 공백 다음) */
export function resolveCommand(text: string, usable: LoadedCommand[], vendor: Command[]): { cmd: LoadedCommand; args: string; argsAt: number } | null {
  const m = /^\/(\S+)/.exec(text);
  if (!m) return null;
  const tok = m[1].toLowerCase();
  const argsAt = Math.min(text.length, m[0].length + 1);
  const args = text.slice(m[0].length).trim();
  if (tok.includes(':')) { const c = usable.find((x) => fullName(x).toLowerCase() === tok); return c ? { cmd: c, args, argsAt } : null; }
  const mine = usable.filter((x) => x.name.toLowerCase() === tok);
  const theirs = vendor.filter((v) => v.name.toLowerCase() === tok || shortOf(v.name.toLowerCase()) === tok);
  return mine.length === 1 && !theirs.length ? { cmd: mine[0], args, argsAt } : null;
}

/** complete 입력 — 인자 글(raw)을 공백으로 나눈 낱말, 커서가 있는 낱말(index)과 그 커서 앞부분(value), 고른 후보로 바꿀 자리(start·end, 글 기준) */
export function completeInput(text: string, cursor: number, argsAt: number): { args: string[]; index: number; value: string; raw: string; start: number; end: number } {
  const raw = text.slice(argsAt);
  const at = Math.max(0, Math.min(raw.length, cursor - argsAt));
  const words: { s: number; e: number }[] = [];
  for (const w of raw.matchAll(/\S+/g)) words.push({ s: w.index!, e: w.index! + w[0].length });
  let index = words.findIndex((w) => at >= w.s && at <= w.e);
  let cur: { s: number; e: number };
  if (index >= 0) cur = words[index];
  else { index = words.filter((w) => w.e < at).length; cur = { s: at, e: at }; words.splice(index, 0, cur); } // 낱말 사이 빈자리 — 새 낱말
  return { args: words.map((w) => raw.slice(w.s, w.e)), index, value: raw.slice(cur.s, at), raw, start: argsAt + cur.s, end: argsAt + cur.e };
}
