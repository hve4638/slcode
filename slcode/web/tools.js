// 도구 줄 (ticket slcode-tool-card-polish) — 화면에 보이는 이름, 아이콘, 펼쳤을 때 정돈된 모양.
// 실제 도구 이름(allowedTools·승인·기록·와이어)은 그대로 두고 화면 표시만 바꾼다. 모르는 도구는 펼치면 JSON 원문이다.

/** 화면 이름 — slcode 자체 MCP 는 앞머리 없이, 다른 MCP 는 { name: 도구, server }. Claude 는 mcp__<서버>__<도구>, Codex 는 mcp:<서버>/<도구>(codex.ts toolOf) */
export function toolName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name) ?? /^mcp:([^/]+)\/(.+)$/.exec(name);
  if (!m) return { name, server: null };
  return { name: m[2], server: m[1] === 'slcode' ? null : m[1] };
}
/** 상태 문구·승인 줄처럼 글자 하나로 쓰는 자리 */
export const toolLabel = (name) => { const t = toolName(name); return t.server ? `${t.server} · ${t.name}` : t.name; };

/** 도구 → 아이콘 이름 (app.js 의 ICONS) — 비슷한 도구는 한 모양: 셸은 터미널, 파일 수정은 연필, 찾기는 돋보기 (사용자 2026-11-25). Codex 명령·파일 변경은 codex.ts toolOf 가 Bash·Edit 으로 이름 붙인다 */
const TOOL_ICONS = {
  Bash: 'term', BackgroundRun: 'term', BackgroundStop: 'term', BashOutput: 'term', KillShell: 'term', TaskOutput: 'term', TaskStop: 'term',
  Read: 'file', Edit: 'pen', MultiEdit: 'pen', Write: 'pen', NotebookEdit: 'pen',
  Grep: 'search', Glob: 'search', WebSearch: 'search', WebFetch: 'globe', TodoWrite: 'listChecks',
  Agent: 'bot', Task: 'bot', task: 'bot', Subagent: 'bot', ContinueSubagent: 'bot', AskUserQuestion: 'circleHelp',
};
export function toolIcon(name) {
  const t = toolName(name);
  return TOOL_ICONS[t.name] && !t.server ? TOOL_ICONS[t.name] : t.server ? 'plug' : 'wrench';
}

/** 실패 줄 오른쪽 끝의 빨간 글자 — 명령의 종료 코드(Claude Bash 결과 'Exit code N'), 없으면 '실패' */
export const failLabel = (summary) => { const m = /^Exit code (\d+)/.exec(summary ?? ''); return m ? `exit ${m[1]}` : '실패'; };

const str = (v) => (typeof v === 'string' ? v : null);

/** 두 글의 줄 diff — [' '|'-'|'+', 줄]. 크면 LCS 를 건너뛰고 모두 빼고 더한다 */
export function lineDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  if (x.length * y.length > 250000) return [...x.map((l) => ['-', l]), ...y.map((l) => ['+', l])];
  const n = x.length, m = y.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push([' ', x[i]]); i++; j++; }
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) out.push(['-', x[i++]]);
    else out.push(['+', y[j++]]);
  }
  return out;
}

/** Read 의 줄 범위 — offset 은 시작 줄, limit 는 줄 수 */
function readRange(i) {
  if (str(i.pages)) return `${i.pages}쪽`;
  const o = Number.isFinite(i.offset) ? i.offset : null, l = Number.isFinite(i.limit) ? i.limit : null;
  if (o != null && l != null) return `${o}–${o + l - 1}줄`;
  if (o != null) return `${o}줄부터`;
  if (l != null) return `처음 ${l}줄`;
  return null;
}

/**
 * 펼쳤을 때 입력 자리 — 아는 도구만 노드 목록, 모르면 null(JSON 원문).
 * quiet: 성공이면 결과를 숨긴다(결과가 입력을 되풀이하는 도구 — 'The file … has been updated' 등)
 */
export function toolView(h, name, input) {
  const t = toolName(name);
  if (t.server || !input || typeof input !== 'object') return null;
  const i = input;
  const path = (p, extra) => h('div', { class: 'tv-path' }, h('span', { class: 'p' }, p), extra ? h('span', { class: 'x' }, extra) : null);
  const note = (s) => (s ? h('div', { class: 'tv-note' }, s) : null);
  const cmd = (c) => h('pre', { class: 'tv-cmd' }, c);
  const block = (s) => h('pre', {}, s);
  const kv = (pairs) => { const rows = pairs.filter(([, v]) => v != null && v !== '' && v !== false); return rows.length ? h('div', { class: 'tv-kv' }, ...rows.flatMap(([k, v]) => [h('span', { class: 'k' }, k), h('span', { class: 'v' }, v === true ? '예' : String(v))])) : null; };
  const diff = (a, b) => h('pre', { class: 'tv-diff' }, ...lineDiff(a ?? '', b ?? '').map(([op, l]) => h('span', { class: op === '+' ? 'add' : op === '-' ? 'del' : 'ctx' }, `${op} ${l}\n`)));
  switch (t.name) {
    case 'Bash': case 'BackgroundRun':
      if (!str(i.command)) return null;
      return { nodes: [note(i.description), cmd(i.command), kv([['폴더', i.cwd], ['제한 시간', i.timeout ? `${Math.round(i.timeout / 1000)}초` : null], ['백그라운드', i.run_in_background]])] };
    case 'Read':
      if (!str(i.file_path) && !str(i.path)) return null;
      return { nodes: [path(i.file_path ?? i.path, readRange(i))] };
    case 'Edit':
      // Codex 파일 변경 — kind 는 { type: add|delete|update } (app-server PatchChangeKind)
      if (Array.isArray(i.changes)) return { quiet: true, nodes: [h('div', { class: 'tv-files' }, ...i.changes.map((c) => h('div', {}, h('span', { class: 'tv-kind' }, c?.kind?.type ?? c?.kind ?? ''), h('span', { class: 'p' }, c?.path ?? ''))))] };
      if (!str(i.file_path)) return null;
      return { quiet: true, nodes: [path(i.file_path, i.replace_all ? '모두 바꿈' : null), diff(i.old_string, i.new_string)] };
    case 'MultiEdit':
      if (!str(i.file_path) || !Array.isArray(i.edits)) return null;
      return { quiet: true, nodes: [path(i.file_path), ...i.edits.map((e) => diff(e?.old_string, e?.new_string))] };
    case 'Write':
      if (!str(i.file_path)) return null;
      return { quiet: true, nodes: [path(i.file_path, str(i.content) ? `${i.content.split('\n').length}줄` : null), block(i.content ?? '')] };
    case 'Grep':
      if (!str(i.pattern)) return null;
      return { nodes: [cmd(i.pattern), kv([['위치', i.path], ['파일', i.glob ?? i.type], ['대소문자 무시', i['-i']], ['출력', i.output_mode]])] };
    case 'Glob':
      if (!str(i.pattern)) return null;
      return { nodes: [cmd(i.pattern), kv([['위치', i.path]])] };
    case 'WebFetch':
      if (!str(i.url)) return null;
      return { nodes: [path(i.url), note(i.prompt)] };
    case 'WebSearch':
      if (!str(i.query)) return null;
      return { nodes: [cmd(i.query), kv([['허용 도메인', i.allowed_domains?.join?.(', ')], ['제외 도메인', i.blocked_domains?.join?.(', ')]])] };
    case 'TodoWrite':
      if (!Array.isArray(i.todos)) return null;
      return { quiet: true, nodes: [h('ul', { class: 'tv-todo' }, ...i.todos.map((d) => h('li', { class: d?.status ?? '' }, d?.content ?? '')))] };
    case 'Agent': case 'Task':
      if (!str(i.prompt)) return null;
      return { nodes: [kv([['종류', i.subagent_type], ['모델', i.model], ['백그라운드', i.run_in_background]]), block(i.prompt)] };
    case 'Subagent':
      if (!str(i.prompt)) return null;
      return { nodes: [kv([['에이전트', i.agent], ['모델', i.model], ['폴더', i.cwd], ['격리', i.isolation], ['백그라운드', i.run_in_background]]), block(i.prompt)] };
    case 'ContinueSubagent':
      if (!str(i.prompt)) return null;
      return { nodes: [kv([['받는 쪽', i.to], ['백그라운드', i.run_in_background]]), block(i.prompt)] };
    case 'BackgroundStop':
      if (!str(i.id)) return null;
      return { nodes: [kv([['작업', i.id]])] };
    default: return null;
  }
}
