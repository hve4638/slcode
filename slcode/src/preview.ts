// 세션 구성 (ticket slcode-sidebar-revamp, 사용자 2026-11-25) — 사이드바에서 여는 창의 system prompt 출처 나누기, 훅 목록, 출처 이름 맞추기.
// system: 받은 글(promptCapture.captureSystem)에서 slcode 가 넣은 글(slcode 지시·팀 지시·에이전트 플러그인 지시문·프로필 프롬프트)을 찾아 자르고, 나머지는 벤더(Claude Code)가 넣은 것.
// 훅: Claude Code 가 싣는 곳(설정 파일 user·project·local, 실린 플러그인의 hooks/hooks.json·plugin.json hooks)과 에이전트 플러그인의 js 훅 등록(scripts.json regs).
// 스킬·서브에이전트·지시 파일의 출처는 Claude Code 가 준다(getContextUsage) — 그 출처 글을 Origin 으로 맞춘다(originOf).
import fs from 'node:fs';
import path from 'node:path';
import type { Origin, PreviewBlock, PreviewHook, PreviewSkill } from './protocol.js';

/** system 글들을 출처 조각으로 — known 은 앞선 것이 먼저 잡힌다. 겹치면 앞서 잡힌 것을 둔다. 조각 사이의 빈 줄은 버린다 */
export function labelSystem(system: string[], known: { source: PreviewBlock['source']; text: string }[]): PreviewBlock[] {
  const out: PreviewBlock[] = [];
  const pieces = known.map((k) => ({ ...k, text: k.text.trim() })).filter((k) => k.text);
  for (const t of system) {
    const hits: { at: number; end: number; source: PreviewBlock['source'] }[] = [];
    for (const k of pieces) {
      for (let at = t.indexOf(k.text); at >= 0; at = t.indexOf(k.text, at + k.text.length)) {
        const end = at + k.text.length;
        if (!hits.some((h) => at < h.end && end > h.at)) hits.push({ at, end, source: k.source });
      }
    }
    hits.sort((a, b) => a.at - b.at);
    let pos = 0;
    const push = (source: PreviewBlock['source'], text: string) => { const s = text.replace(/^\n+|\n+$/g, ''); if (s.trim()) out.push({ source, text: s }); };
    for (const h of hits) { push('vendor', t.slice(pos, h.at)); push(h.source, t.slice(h.at, h.end)); pos = h.end; }
    push('vendor', t.slice(pos));
  }
  return out;
}

type HookDefs = Record<string, { matcher?: string; hooks?: { type?: string; command?: string; prompt?: string; url?: string }[] }[]>;
const readJson = (f: string): any => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/** 설정 범위의 output style 파일 (ticket slcode-sidebar-revamp, 세션 구성) — Claude Code 가 첫 메시지에 '# Output Style: <이름>' 으로 넣는 글의 출처를 찾는다.
 *  이름은 frontmatter name, 없으면 파일 이름. 플러그인 것은 '<플러그인>:<이름>' 이라 이름으로 안다 */
export function listStyles(s: LoadSources): PreviewSkill[] {
  const dirs = { user: path.join(s.configDir, 'output-styles'), project: path.join(s.cwd, '.claude/output-styles') } as const;
  return (['user', 'project'] as const).filter((k) => s.settingSources.includes(k)).flatMap((source) => {
    let files: string[] = [];
    try { files = fs.readdirSync(dirs[source]).filter((f) => f.endsWith('.md')).sort(); } catch { /* 폴더가 없다 */ }
    return files.map((f) => {
      const file = path.join(dirs[source], f);
      let name = f.slice(0, -3);
      try { name = /^---\n[\s\S]*?^name:\s*(.+?)\s*$/m.exec(fs.readFileSync(file, 'utf8'))?.[1]?.replace(/^["']|["']$/g, '') || name; } catch { /* 못 읽으면 파일 이름 */ }
      return { name, source, plugin: null, path: file };
    });
  });
}

/** 설정 꼴 hooks 객체 하나를 줄로 */
function rowsOf(defs: unknown, from: Omit<PreviewHook, 'event' | 'matcher' | 'what'>): PreviewHook[] {
  if (!defs || typeof defs !== 'object') return [];
  return Object.entries(defs as HookDefs).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).flatMap((g) =>
    (Array.isArray(g?.hooks) ? g.hooks : []).map((x) => ({ event, matcher: g.matcher || null, what: x?.command ?? x?.prompt ?? x?.url ?? x?.type ?? '', ...from }))));
}

export type LoadSources = {
  /** 실린 설정 범위 (ClaudeLoad.settingSources) */
  settingSources: ('user' | 'project' | 'local')[];
  /** 사용자 설정 폴더 (CLAUDE_CONFIG_DIR 또는 ~/.claude) */
  configDir: string;
  cwd: string;
  /** 실린 Claude Code 플러그인 (session.ready 의 plugins) — agent 는 slcode 에이전트 플러그인 이름들 */
  plugins: { name: string; path: string }[];
  agent: string[];
  /** 에이전트 플러그인 js 훅 등록 — 플러그인 이름과 이벤트·matcher */
  scripts: { plugin: string; regs: { event: string; matcher?: string | null }[] }[];
};

export function listHooks(s: LoadSources): PreviewHook[] {
  const files = { user: path.join(s.configDir, 'settings.json'), project: path.join(s.cwd, '.claude/settings.json'), local: path.join(s.cwd, '.claude/settings.local.json') };
  const out: PreviewHook[] = [];
  for (const src of s.settingSources) out.push(...rowsOf(readJson(files[src])?.hooks, { source: src, name: null }));
  for (const p of s.plugins) {
    const source = s.agent.includes(p.name.replace(/@inline$/, '')) ? 'agent' : 'plugin';
    const from = { source, name: p.name.replace(/@inline$/, '') } as const;
    out.push(...rowsOf(readJson(path.join(p.path, 'hooks/hooks.json'))?.hooks, from));
    // plugin.json 의 hooks — 파일 경로(들) 또는 설정 꼴 객체
    const m = readJson(path.join(p.path, '.claude-plugin/plugin.json'))?.hooks;
    for (const h of Array.isArray(m) ? m : m ? [m] : []) {
      if (typeof h === 'string') { const f = path.resolve(p.path, h.replace('${CLAUDE_PLUGIN_ROOT}', '.')); if (f !== path.join(p.path, 'hooks/hooks.json')) out.push(...rowsOf(readJson(f)?.hooks, from)); }
      else out.push(...rowsOf((h as { hooks?: unknown }).hooks ?? h, from));
    }
  }
  for (const sc of s.scripts) for (const r of sc.regs) out.push({ event: r.event, matcher: r.matcher ?? null, what: 'js', source: 'agent', name: sc.plugin });
  return out;
}

/** Claude Code 가 준 출처 글(스킬·에이전트의 userSettings·built-in·plugin…, 지시 파일의 User·Project…, MCP 의 sdk·user·project…) → Origin.
 *  plugin 은 에이전트 플러그인 이름이면 agent. MCP 의 sdk·dynamic 은 SDK 를 부른 쪽(slcode)이 옵션으로 넣은 것, claudeai 는 claude.ai 커넥터 */
export function originOf(raw: string | undefined, plugin: string | null, agentPlugins: string[]): Origin {
  const r = (raw ?? '').toLowerCase();
  if (r === 'plugin') return plugin && agentPlugins.includes(plugin) ? 'agent' : 'plugin';
  if (/^(built-?in|bundled)$/.test(r)) return 'builtin';
  if (r === 'sdk' || r === 'dynamic') return 'slcode'; // SDK 옵션으로 준 것 — 그 SDK 를 부르는 건 slcode 뿐
  if (r === 'claudeai') return 'claudeai';
  for (const o of ['user', 'project', 'local'] as const) if (r === o || r === `${o}settings`) return o;
  if (/^(policy|managed|enterprise)/.test(r)) return 'managed';
  return 'other';
}
