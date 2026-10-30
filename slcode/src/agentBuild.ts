// 에이전트 플러그인의 하네스별 빌드 (ticket slcode-agent-plugin, Codex 는 slcode-agent-plugin-codex) — Claude·Codex. 원본에서 단방향으로 만들고, 폴더 이름은 빌드 식별자다.
// 켠 part 를 parts 순서로 합친다: part 마다 바깥 항목을 먼저 놓고 raw/claude/ 를 겹친다. hooks.json 은 이벤트별로 잇고(바깥 것은 slcode 형식 — agentHooks.ts), .mcp.json 은 서버 이름별로
// 합치고(뒤의 것이 이긴다), 그 밖의 겹친 경로는 뒤의 것을 쓴다. 문법이 깨진 hooks.json·.mcp.json·session.json 은 그 파일만 뺀다. 빌드 에러는 없다.
// 형식이 따로 다루지 않는 part 파일(훅·MCP 가 부르는 스크립트 등)은 그대로 플러그인 폴더에 들어간다 — Claude 가 모르는 것은 Claude 가 무시한다.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildId, frontmatter, mcpTransport, partLost, valuesString, walk, type Harness, type Manifest, type Resolved } from './agentFormat.js';
import { buildPartHooks, CODEX_EVENTS, partCommandHooks, type ScriptEntry } from './agentHooks.js';

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
  /** js/ts 훅 (Claude, ticket slcode-agent-plugin-hooks) — built 는 묶은 스크립트("<part>/<file>"), failed 는 묶지 못해 뺀 것과 사유 */
  scripts?: { built: string[]; failed: string[] };
};

/** 빌드 폴더 안의 이름들 — build/<식별자>/ 아래. codexArgs 는 Codex 빌드의 app-server 인자(-c mcp_servers…).
 *  codexMcp·codexHooks 는 Codex export 가 플러그인의 .mcp.json·hooks/hooks.json 으로 쓴다 — slcode 의 Codex 세션은 쓰지 않는다 */
export const BUILD_FILES = { report: 'report.json', instructions: 'instructions.md', settings: 'session.json', codexArgs: 'codex-args.json', codexMcp: 'codex-mcp.json', codexHooks: 'codex-hooks.json', scripts: 'scripts.json' } as const;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const readJson = (f: string): unknown => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const RAW = 'raw/claude/';
/** Codex 가 timeout 을 3초로 줄이는(그때마다 경고를 내는) 이벤트 — Codex 빌드가 미리 3초로 맞춘다 (Codex 문서 hooks.md, 0.165 실측) */
const CODEX_SHORT = new Set(['SessionEnd', 'Interrupt']);

/** src(설치한 원본)의 켠 part 를 out 에 Claude 빌드로 쓴다 — out/claude/<이름>/ (플러그인 폴더), instructions.md, session.json(있으면), report.json */
export function buildClaude(src: string, m: Manifest, r: Resolved, id: string, out: string): Report {
  const report: Report = { harness: 'claude', name: m.name, version: m.version, build: id, values: valuesString(r), parts: [], instructions: { used: [], skipped: [] }, overridden: [], dropped: [], lost: [], scripts: { built: [], failed: [] } };
  const scripts: ScriptEntry[] = [];
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
        if (raw) { // raw/claude 는 Claude 형식 그대로
          if (!isObj(j) || !isObj(j.hooks)) { report.dropped.push(where); continue; }
          for (const [ev, list] of Object.entries(j.hooks)) if (Array.isArray(list)) (hooks[ev] ??= []).push(...list);
          continue;
        }
        const h = buildPartHooks(pdir, part, j, out, scripts); // slcode 형식 — script 는 묶고 command 는 Claude 형식으로
        if (!h) { report.dropped.push(where); continue; }
        for (const [ev, list] of Object.entries(h.claude)) (hooks[ev] ??= []).push(...list);
        report.dropped.push(...h.dropped);
        report.scripts!.failed.push(...h.failed);
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
  report.scripts!.built = scripts.map((x) => x.src);
  if (scripts.length) fs.writeFileSync(path.join(out, BUILD_FILES.scripts), JSON.stringify(scripts, null, 2));
  fs.writeFileSync(path.join(out, BUILD_FILES.report), JSON.stringify(report, null, 2));
  return report;
}

/** src 의 켠 part 를 out 에 Codex 빌드로 쓴다 — out/codex/(플러그인 폴더: skills/·bin/·그 밖의 part 파일), instructions.md, codex-args.json, report.json.
 *  훅·raw/ 는 slcode 의 Codex 세션에 싣지 않는다(report.lost). Codex 는 경로 변수를 모르므로 모든 텍스트 파일·지시문·MCP 정의에서 ${CLAUDE_PLUGIN_ROOT} 는 root,
 *  ${CLAUDE_PLUGIN_DATA} 는 data 로 바꾼다 — root 는 그 플러그인 폴더가 놓일 경로다(세션 빌드는 rename 뒤의 빌드 폴더/codex, export 는 export 링크).
 *  Codex export 용으로 codex-mcp.json(이름을 바꾼 서버)과 codex-hooks.json(command 훅 중 Codex 가 받는 이벤트, ${slcode.vars.harness} 는 codex)도 쓴다 */
export function buildCodex(src: string, m: Manifest, r: Resolved, id: string, out: string, root: string, data: string): Report {
  const report: Report = { harness: 'codex', name: m.name, version: m.version, build: id, values: valuesString(r), parts: [], instructions: { used: [], skipped: [] }, overridden: [], dropped: [], lost: [] };
  const sub = (t: string) => t.replaceAll('${CLAUDE_PLUGIN_ROOT}', root).replaceAll('${CLAUDE_PLUGIN_DATA}', data);
  const deep = (v: unknown): unknown => typeof v === 'string' ? sub(v) : Array.isArray(v) ? v.map(deep) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
  const files = new Map<string, { part: string; body: Buffer; mode: number }>();
  const put = (rel: string, part: string, body: Buffer, mode = 0o644) => {
    const prev = files.get(rel);
    if (prev) report.overridden.push(`${rel} (${prev.part} → ${part})`);
    files.set(rel, { part, body, mode });
  };
  const mcp: Record<string, { def: unknown; part: string }> = {};
  const hooks: Record<string, unknown[]> = {}, hooksExcluded: string[] = [];
  const instr: string[] = [];
  for (const part of Object.keys(m.parts)) {
    if (!r.parts[part]) continue;
    report.parts.push(part);
    report.lost.push(...partLost(src, part).codex);
    const pdir = path.join(src, part);
    for (const rel of walk(pdir)) {
      if (rel === 'hooks/hooks.json') { // slcode 의 Codex 세션은 싣지 않는다(partLost 가 적었다) — export 만 쓴다
        const h = partCommandHooks(readJson(path.join(pdir, rel)), part, 'codex', CODEX_EVENTS);
        if (!h) { hooksExcluded.push(`${part}/${rel}: broken`); continue; }
        for (const [ev, list] of Object.entries(h.hooks)) (hooks[ev] ??= []).push(...(deep(list) as Record<string, any>[]).map((g) => CODEX_SHORT.has(ev) ? { ...g, hooks: g.hooks.map((x: Record<string, any>) => (typeof x.timeout === 'number' && x.timeout > 3 ? { ...x, timeout: 3 } : x)) } : g));
        hooksExcluded.push(...h.excluded);
        continue;
      }
      if (rel.startsWith('raw/')) continue; // Codex 에는 싣지 않는다 — partLost 가 적었다
      const abs = path.join(pdir, rel);
      const where = `${part}/${rel}`;
      if (rel.startsWith('instructions/')) {
        if (!/^instructions\/[^/]+\.md$/.test(rel)) continue;
        const { fields, body } = frontmatter(fs.readFileSync(abs, 'utf8'));
        const why = ifFalse(m, r, fields.if);
        if (why) { report.instructions.skipped.push(`${where}: ${why}`); continue; }
        report.instructions.used.push(where);
        if (body.trim()) instr.push(sub(body.trim()));
        continue;
      }
      if (rel === '.mcp.json') {
        const j = readJson(abs);
        if (!isObj(j)) { report.dropped.push(where); continue; }
        for (const [name, def] of Object.entries(isObj(j.mcpServers) ? j.mcpServers : j)) {
          if (mcp[name]) report.overridden.push(`.mcp.json ${name} (${mcp[name].part} → ${part})`);
          mcp[name] = { def, part };
        }
        continue;
      }
      const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(rel);
      if (skill) {
        const s = codexSkill(sub(fs.readFileSync(abs, 'utf8')), skill[1]);
        put(rel, part, Buffer.from(s.md));
        if (s.yaml) put(`skills/${skill[1]}/agents/openai.yaml`, part, Buffer.from(s.yaml));
        continue;
      }
      const body = fs.readFileSync(abs);
      put(rel, part, body.includes(0) ? body : Buffer.from(sub(body.toString('utf8'))), fs.statSync(abs).mode & 0o777); // NUL 이 있으면 바이너리로 보고 그대로
    }
  }
  for (const [rel, { body, mode }] of files) {
    const to = path.join(out, 'codex', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, body);
    fs.chmodSync(to, mode); // bin/ 의 실행 비트
  }
  // MCP 는 app-server 인자로 — 서버 이름은 Claude 도구 이름과 같은 plugin_<플러그인>_<서버>. 못 받는 연결 방식은 partLost 가 적었다
  const args: string[] = [];
  const servers: Record<string, unknown> = {};
  for (const [name, { def }] of Object.entries(mcp)) {
    const d = deep(def) as Record<string, any>;
    const t = mcpTransport(d);
    const conf = t === 'stdio' ? { command: d.command, ...(Array.isArray(d.args) ? { args: d.args } : {}), ...(isObj(d.env) ? { env: d.env } : {}), ...(typeof d.cwd === 'string' ? { cwd: d.cwd } : {}) }
      : t === 'http' ? { url: d.url, ...(isObj(d.headers) ? { http_headers: d.headers } : {}) } : null;
    const key = `plugin_${m.name}_${name}`.replace(/[^A-Za-z0-9_-]/g, '_');
    if (conf) { args.push('-c', `mcp_servers.${key}=${toml(conf)}`); servers[key] = conf; }
  }
  fs.mkdirSync(path.join(out, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(out, BUILD_FILES.codexArgs), JSON.stringify(args, null, 2));
  fs.writeFileSync(path.join(out, BUILD_FILES.codexMcp), JSON.stringify({ mcpServers: servers }, null, 2));
  fs.writeFileSync(path.join(out, BUILD_FILES.codexHooks), JSON.stringify({ hooks, excluded: hooksExcluded }, null, 2));
  fs.writeFileSync(path.join(out, BUILD_FILES.instructions), instr.join('\n\n'));
  fs.writeFileSync(path.join(out, BUILD_FILES.report), JSON.stringify(report, null, 2));
  return report;
}

/** Claude skill → Codex skill. Codex 는 frontmatter 가 없으면 싣지 않으므로 name·description 만으로 다시 쓴다(그 밖의 필드는 Codex 가 무시한다 — partLost 가 적었다).
 *  description 이 없으면 본문 첫 줄, when_to_use 는 그 뒤에 잇는다. disable-model-invocation 은 agents/openai.yaml 의 allow_implicit_invocation: false 로 */
export function codexSkill(text: string, folder: string): { md: string; yaml: string | null } {
  const { fields, body } = frontmatter(text);
  const first = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? folder;
  const description = [fields.description || first, fields.when_to_use].filter(Boolean).join(' ');
  const md = `---\nname: ${JSON.stringify(fields.name || folder)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`;
  return { md, yaml: fields['disable-model-invocation'] === 'true' ? 'policy:\n  allow_implicit_invocation: false\n' : null };
}

/** JSON 값 → TOML 인라인 값 (-c 의 값은 TOML 로 읽힌다). JSON 문자열 이스케이프는 TOML basic string 과 같다 */
function toml(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(toml).join(', ')}]`;
  if (isObj(v)) return `{${Object.entries(v).filter(([, x]) => x != null).map(([k, x]) => `${JSON.stringify(k)} = ${toml(x)}`).join(', ')}}`;
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
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
  // Codex 빌드의 데이터 폴더는 build/ 옆 data/<이름> (agentPaths)
  const report = harness === 'codex' ? buildCodex(src, m, r, id, tmp, path.join(dir, 'codex'), path.join(path.dirname(buildDir), 'data', m.name)) : buildClaude(src, m, r, id, tmp);
  try { fs.renameSync(tmp, dir); }
  catch { fs.rmSync(tmp, { recursive: true, force: true }); if (!fs.existsSync(path.join(dir, BUILD_FILES.report))) throw new Error(`could not place build ${id}`); }
  return { id, dir, report };
}
