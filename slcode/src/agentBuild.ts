// 에이전트 플러그인의 하네스별 빌드 (ticket slcode-agent-plugin) — 지금은 Claude 만. 원본에서 단방향으로 만들고, 폴더 이름은 빌드 식별자다.
// 켠 part 를 parts 순서로 합친다: part 마다 바깥 항목을 먼저 놓고 raw/claude/ 를 겹친다. hooks.json 은 이벤트별로 잇고, .mcp.json 은 서버 이름별로
// 합치고(뒤의 것이 이긴다), 그 밖의 겹친 경로는 뒤의 것을 쓴다. 문법이 깨진 hooks.json·.mcp.json·session.json 은 그 파일만 뺀다. 빌드 에러는 없다.
// 형식이 따로 다루지 않는 part 파일(훅·MCP 가 부르는 스크립트 등)은 그대로 플러그인 폴더에 들어간다 — Claude 가 모르는 것은 Claude 가 무시한다.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildId, frontmatter, partLost, valuesString, walk, type Harness, type Manifest, type Resolved } from './agentFormat.js';

export type Report = {
  harness: Harness; name: string; version: string; build: string; values: string;
  /** 켠 part (parts 순서) */
  parts: string[];
  /** 지시문 — used 는 합친 순서, skipped 는 if 가 거짓이거나 판단할 수 없는 것 */
  instructions: { used: string[]; skipped: string[] };
  /** 뒤의 part 가 덮어쓴 경로·MCP 서버 */
  overridden: string[];
  /** 문법이 깨져 뺀 파일 */
  dropped: string[];
  /** 이 하네스가 받지 못해 뺀 것 (agentFormat.partLost 와 같은 규칙) */
  lost: string[];
};

/** 빌드 폴더 안의 이름들 — build/<식별자>/ 아래 */
export const BUILD_FILES = { report: 'report.json', instructions: 'instructions.md', settings: 'session.json' } as const;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const readJson = (f: string): unknown => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const RAW = 'raw/claude/';

/** src(설치한 원본)의 켠 part 를 out 에 Claude 빌드로 쓴다 — out/claude/<이름>/ (플러그인 폴더), instructions.md, session.json(있으면), report.json */
export function buildClaude(src: string, m: Manifest, r: Resolved, id: string, out: string): Report {
  const report: Report = { harness: 'claude', name: m.name, version: m.version, build: id, values: valuesString(r), parts: [], instructions: { used: [], skipped: [] }, overridden: [], dropped: [], lost: [] };
  const files = new Map<string, { abs: string; part: string }>();
  const hooks: Record<string, unknown[]> = {};
  const mcp: Record<string, { def: unknown; part: string }> = {};
  let manifestJson: Record<string, unknown> = {};
  let settings: { j: Record<string, unknown>; part: string } | null = null;
  const instr: string[] = [];
  for (const part of Object.keys(m.parts)) {
    if (!r.parts[part]) continue;
    report.parts.push(part);
    report.lost.push(...partLost(src, part).claude);
    const pdir = path.join(src, part);
    const all = walk(pdir);
    // 바깥 항목 먼저, 그 위에 raw/claude/ — raw/ 의 다른 폴더는 무시한다
    const entries = [...all.filter((f) => !f.startsWith('raw/')).map((f) => ({ rel: f, raw: false })), ...all.filter((f) => f.startsWith(RAW)).map((f) => ({ rel: f.slice(RAW.length), raw: true }))];
    for (const { rel, raw } of entries) {
      const abs = path.join(pdir, raw ? RAW + rel : rel);
      const where = `${part}/${raw ? RAW : ''}${rel}`;
      if (!raw && rel.startsWith('instructions/')) {
        if (!/^instructions\/[^/]+\.md$/.test(rel)) continue;
        const { fields, body } = frontmatter(fs.readFileSync(abs, 'utf8'));
        const why = ifFalse(m, r, fields.if);
        if (why) { report.instructions.skipped.push(`${where}: ${why}`); continue; }
        report.instructions.used.push(where);
        if (body.trim()) instr.push(body.trim());
        continue;
      }
      if (rel === 'hooks/hooks.json') {
        const j = readJson(abs);
        if (!isObj(j) || !isObj(j.hooks)) { report.dropped.push(where); continue; }
        for (const [ev, list] of Object.entries(j.hooks)) if (Array.isArray(list)) (hooks[ev] ??= []).push(...list);
        continue;
      }
      if (rel === '.mcp.json') {
        const j = readJson(abs);
        if (!isObj(j)) { report.dropped.push(where); continue; }
        const servers = isObj(j.mcpServers) ? j.mcpServers : j; // Claude 는 두 꼴을 다 받는다
        for (const [name, def] of Object.entries(servers)) {
          if (mcp[name]) report.overridden.push(`.mcp.json ${name} (${mcp[name].part} → ${part})`);
          mcp[name] = { def, part };
        }
        continue;
      }
      if (rel === '.claude-plugin/plugin.json') { // name·version 은 manifest 값으로 바꾼다
        const j = readJson(abs);
        if (!isObj(j)) report.dropped.push(where); else manifestJson = j;
        continue;
      }
      if (raw && rel === 'session.json') { // slcode 전용 — SDK settings 로 넘긴다
        const j = readJson(abs);
        if (!isObj(j)) { report.dropped.push(where); continue; }
        if (settings) report.overridden.push(`session.json (${settings.part} → ${part})`);
        settings = { j, part };
        continue;
      }
      const prev = files.get(rel);
      if (prev) report.overridden.push(`${rel} (${prev.part} → ${part})`);
      files.set(rel, { abs, part });
    }
  }
  const plugin = path.join(out, 'claude', m.name);
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
  for (const [rel, { abs }] of files) {
    const to = path.join(plugin, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(abs, to);
    fs.chmodSync(to, fs.statSync(abs).mode & 0o777); // bin/ 의 실행 비트
  }
  if (Object.keys(hooks).length) { fs.mkdirSync(path.join(plugin, 'hooks'), { recursive: true }); fs.writeFileSync(path.join(plugin, 'hooks/hooks.json'), JSON.stringify({ hooks }, null, 2)); }
  if (Object.keys(mcp).length) fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(mcp).map(([k, v]) => [k, v.def])) }, null, 2));
  fs.writeFileSync(path.join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ ...manifestJson, name: m.name, version: m.version }, null, 2));
  fs.writeFileSync(path.join(out, BUILD_FILES.instructions), instr.join('\n\n'));
  if (settings) fs.writeFileSync(path.join(out, BUILD_FILES.settings), JSON.stringify((settings as { j: unknown }).j, null, 2));
  fs.writeFileSync(path.join(out, BUILD_FILES.report), JSON.stringify(report, null, 2));
  return report;
}

/** 지시문 frontmatter if — 값은 boolean 옵션 이름, ! 로 부정. 실으면 null, 아니면 사유 */
function ifFalse(m: Manifest, r: Resolved, cond: string | undefined): string | null {
  if (cond === undefined || cond === '') return null;
  const neg = cond.startsWith('!');
  const name = neg ? cond.slice(1).trim() : cond.trim();
  if (m.options[name]?.type !== 'boolean') return `if: ${cond} (no boolean option ${name})`;
  return (r.options[name] === true) !== neg ? null : `if: ${cond}`;
}

/** 그 식별자의 빌드가 있으면 다시 쓰고, 없으면 임시 폴더에 빌드한 뒤 rename. 동시에 둘이 빌드하면 먼저 놓인 것을 쓴다 */
export function ensureBuild(buildDir: string, src: string, m: Manifest, r: Resolved, hash: string, harness: Harness = 'claude'): { id: string; dir: string; report: Report } {
  const id = buildId(valuesString(r), hash, harness);
  const dir = path.join(buildDir, id);
  const have = readJson(path.join(dir, BUILD_FILES.report));
  if (isObj(have)) { const now = new Date(); try { fs.utimesSync(dir, now, now); } catch {} return { id, dir, report: have as Report }; } // 정리 유예를 새로 센다
  fs.mkdirSync(buildDir, { recursive: true });
  const tmp = path.join(buildDir, `.tmp-${randomUUID().slice(0, 8)}`);
  const report = buildClaude(src, m, r, id, tmp);
  try { fs.renameSync(tmp, dir); }
  catch { fs.rmSync(tmp, { recursive: true, force: true }); if (!fs.existsSync(path.join(dir, BUILD_FILES.report))) throw new Error(`could not place build ${id}`); }
  return { id, dir, report };
}
