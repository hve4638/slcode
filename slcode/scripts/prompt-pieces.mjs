#!/usr/bin/env node
// src/promptPieces.ts 를 다시 만든다 (ticket slcode-profile-system-prompt) — Claude Code 판이 바뀌어 미리 나눠 둔 블록이 맞지 않게 되면 돌린다.
// 사용: pnpm build 뒤 `node scripts/prompt-pieces.mjs <설정 폴더> <요청 json>...` — 요청 json 은 모델별 첫 본 요청 본문(system 배열이 있는 것), 설정 폴더는 그 요청을 뽑은 CLAUDE_CONFIG_DIR.
// 아래 PLAN 이 나누는 자리와 설명이다: 블록은 그 글로 시작하는 줄부터 빈 줄(이나 다음 블록) 전까지, through 가 있으면 그 글로 시작하는 줄까지. 뜻 하나에 블록 하나.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { normalizer, pieceKey } = await import(path.join(PKG, 'dist', 'systemPrompt.js'));

const PLAN = [
  ['You are an agent working with the user', '에이전트 정체성'],
  ['IMPORTANT: Assist with authorized security testing', '보안 요청을 받는 기준'],
  [' - Text you output outside of tool use', '답은 터미널에 markdown 으로 보인다'],
  [' - Tools run behind a user-selected permission mode', '권한 모드와 거절된 도구 호출'],
  [' - The system may send updates', '대화 중 system 알림과 hook'],
  [' - Text inside <pasted_content> tags', '붙여 넣은 글(pasted_content) 다루기'],
  [' - Prefer the dedicated file/search tools', '전용 도구 우선 · 병렬 호출'],
  [' - Reference code as', '코드 위치 표기(file:line)'],
  ['When you use a pronoun for someone', '사람을 가리키는 대명사'],
  ['For actions that are hard to reverse', '되돌리기 어려운 작업은 먼저 확인'],
  ['You must treat information you learn about the user', '사용자 정보를 밖으로 보내지 않기'],
  [' - When the user types `/<skill-name>`', '/이름 을 치면 Skill 로 호출'],
  ['You have a persistent file-based memory', '파일 메모리 쓰는 법', 'Before saving, check for an existing file'],
  [' - The most recent Claude models', '최신 Claude 모델 목록'],
  [' - Claude Code is available as a CLI', 'Claude Code 제품 안내(CLI·데스크톱·IDE)'],
  [' - Fast mode for Claude Code', 'fast mode 안내'],
  ['When the conversation grows long', '긴 대화는 요약된다'],
  ['When you have enough information to act', '정보가 충분하면 바로 실행'],
  // haiku
  ['The reasoning effort setting changes', 'effort 는 생각의 양만 바꾼다 — 큰 일도 한 턴에'],
  ['Ending your turn stops all work', '할 수 있는 일이 남았으면 턴을 끝내지 않는다'],
  ['Ask before you start only when', '시작 전에 묻는 기준'],
  ['The user can inspect and undo edits', '작업 폴더의 파일 수정은 스스로 정한다'],
  ['When one part of a task is blocked', '막힌 부분이 있어도 나머지를 마친다'],
  // opus · fable
  ['Do build original games', '게임 만들기의 저작권 기준'],
  // fable
  ['This iteration of Claude is Claude Fable', '모델 소개(Fable·Mythos)'],
  ['The training of Fable', '일부 분야의 능력 제한 안내'],
  ['Ending your turn means your work stops', '맡은 일이 남았으면 멈추지 않는다'],
  ["The Edit tool's description says", '작업 폴더 안 파일은 Read 없이 Edit'],
  ['This adds to the Memory section', '메모리·노트에 남길 것의 기준', 'Same for your notes'],
  ["Don't create planning, decision, or analysis documents", '계획·분석 문서는 요청받을 때만'],
];

const [configDir, ...files] = process.argv.slice(2);
if (!configDir || !files.length) { console.error('usage: prompt-pieces.mjs <config dir> <request.json>...'); process.exit(2); }
const norm = normalizer({ configDir, cwd: '\0', home: '\0' });
const out = new Map();
for (const f of files) {
  let j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j = j.request?.body ?? j.body ?? j.request ?? j;
  if (typeof j === 'string') j = JSON.parse(j);
  for (const { text } of j.system.slice(2)) {
    const lines = text.split('\n');
    const planAt = (i) => PLAN.find(([s]) => lines[i].startsWith(s));
    for (let i = 0; i < lines.length; i++) {
      const p = planAt(i);
      if (!p) continue;
      let end = i + 1;
      if (p[2]) { end = lines.findIndex((l, k) => k > i && l.startsWith(p[2])) + 1; if (!end) throw new Error(`${f}: no line "${p[2]}" after "${p[0]}"`); }
      else while (end < lines.length && lines[end] !== '' && !planAt(end)) end++;
      const k = pieceKey(lines.slice(i, end).join('\n'), norm);
      out.set(k.hash, { ...k, note: p[1] });
      i = end - 1;
    }
  }
}
const missing = PLAN.filter(([, note]) => ![...out.values()].some((p) => p.note === note));
if (missing.length) console.error(`not found in the given requests: ${missing.map((p) => p[1]).join(', ')}`);
const body = [...out.values()].map((p) => `  { head: '${p.head}', lines: ${p.lines}, hash: '${p.hash}', note: ${JSON.stringify(p.note)} },`).join('\n');
fs.writeFileSync(path.join(PKG, 'src', 'promptPieces.ts'), `// 미리 나눠 둔 블록과 설명 (ticket slcode-profile-system-prompt) — scripts/prompt-pieces.mjs 가 만든다, 손으로 고치지 않는다.
// 받은 프롬프트에서 해시가 맞는 줄들에만 씌우는 보조다: 맞지 않으면 받은 대로 한 덩어리로 보인다. 원문은 여기에도 없다.
// Claude Code 2.1.322 (sonnet·haiku·opus·fable) 기준 — 판을 올려 다시 만들면 이 줄도 고친다.
import type { PromptPiece } from './systemPrompt.js';

export const BUILTIN_PIECES: readonly PromptPiece[] = [
${body}
];
`);
console.log(`${out.size} pieces`);
