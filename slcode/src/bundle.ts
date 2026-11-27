// 세션 파일 (ticket slcode-session-bundle, 사용자 결정 2026-11-24~25 — ws docs/ticket/slcode-session-bundle/TICKET.md "사용자 결정").
// 개발 서버를 다른 머신·다른 폴더로 옮길 때 세션 하나를 화면 기록(slcode)과 모델 기억(벤더 transcript)까지 파일 하나로 옮긴다 — `slcode export <s> <파일>`·`slcode import <파일> [폴더]`.
// 파일은 gzip 한 JSON 하나. 담은 기록의 내용(transcript 의 cwd 칸·본문의 경로)은 고치지 않는다 — 과거 실행 위치의 기록이고, 실행 위치는 들여온 폴더(meta.cwd)다.
// 들여오기는 늘 새 세션 id·새 벤더 세션이다: 원본 transcript 를 벤더 설정 폴더의 제자리에 놓고 `import --from` 처럼 복제한다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { EventLog, type SessionMeta } from './eventLog.js';
import type { LoggedEvent } from './protocol.js';
import { cwdSlug } from './paths.js';
import { claudeHome, codexHome, findVendorSession, forkClaude } from './vendor.js';
import { PROMPTS_DIR, checkPromptName } from './promptLibrary.js';

const FORMAT = 'slcode.session';
const VERSION = 1;
type BundleFile = { path: string; data: string }; // data 는 base64, path 는 Claude 면 projects/<슬러그>/ 기준, Codex 면 sessions/ 기준
export type Bundle = {
  format: typeof FORMAT; version: number; exportedAt: number;
  meta: SessionMeta; events: LoggedEvent[];
  prompt: { name: string; version: number; data: string; description: string | null } | null;
  vendor: { sessionId: string; files: BundleFile[] } | null;
};
export type Exported = { bytes: number; vendorFiles: number };

/** dir 아래 파일들의 base 기준 상대 경로 */
function walk(dir: string, base: string): string[] {
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents.flatMap((e) => { const p = path.join(dir, e.name); return e.isDirectory() ? walk(p, base) : e.isFile() ? [path.relative(base, p)] : []; });
}

export function exportBundle(log: EventLog, stateDir: string, file: string): Exported {
  const m = log.meta;
  let vendor: Bundle['vendor'] = null;
  if (m.vendorSessionId) {
    const found = findVendorSession(m.vendorSessionId, m.vendor);
    if (!found) throw new Error(`${m.vendor} session ${m.vendorSessionId} is not on this machine — cannot export the conversation`);
    // Claude: <id>.jsonl 과 같은 이름의 폴더(서브에이전트 기록·긴 도구 출력). Codex: rollout 하나
    const base = m.vendor === 'claude' ? path.dirname(found.file) : path.join(codexHome(), 'sessions');
    const rels = m.vendor === 'claude' ? [path.basename(found.file), ...walk(path.join(base, m.vendorSessionId), base)] : [path.relative(base, found.file)];
    vendor = { sessionId: m.vendorSessionId, files: rels.map((r) => ({ path: r, data: fs.readFileSync(path.join(base, r)).toString('base64') })) };
  }
  let prompt: Bundle['prompt'] = null;
  if (m.prompt && m.prompt.version > 0) {
    const dir = path.join(stateDir, PROMPTS_DIR, m.prompt.name);
    let description: string | null = null;
    try { const d = JSON.parse(fs.readFileSync(path.join(dir, 'prompt.json'), 'utf8')).description; if (typeof d === 'string') description = d; } catch {}
    try { prompt = { ...m.prompt, data: fs.readFileSync(path.join(dir, `v${m.prompt.version}.json`), 'utf8'), description }; } catch {}
  }
  const b: Bundle = { format: FORMAT, version: VERSION, exportedAt: Date.now(), meta: m, events: [...log.all], prompt, vendor };
  const out = zlib.gzipSync(JSON.stringify(b));
  fs.writeFileSync(file, out, { flag: 'wx', mode: 0o600 });
  return { bytes: out.length, vendorFiles: vendor?.files.length ?? 0 };
}

function readBundle(file: string): Bundle {
  let b: Bundle;
  try { b = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch { throw new Error(`${file} is not a slcode session file`); }
  if (b?.format !== FORMAT) throw new Error(`${file} is not a slcode session file`);
  if (b.version !== VERSION) throw new Error(`${file} is session file version ${b.version} — this slcode reads version ${VERSION}`);
  if (b.prompt) { checkPromptName(b.prompt.name); if (!Number.isInteger(b.prompt.version) || b.prompt.version < 1) throw new Error(`bad prompt version in session file: ${b.prompt.version}`); }
  return b;
}

/** 경로 조각 하나라도 base 밖을 가리키면 거절 — 파일 안의 path 를 믿지 않는다 */
function inside(base: string, rel: string): string {
  const p = path.resolve(base, rel);
  if (!p.startsWith(path.resolve(base) + path.sep)) throw new Error(`bad path in session file: ${rel}`);
  return p;
}

/** 없을 때만 쓴다 — 있으면 그대로 둔다 */
function writeNew(file: string, data: string) {
  try { fs.writeFileSync(file, data, { flag: 'wx' }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
}

export async function importBundle(file: string, sessionsDir: string, stateDir: string, cwd: string, opts: { title?: string; mode?: string } = {}): Promise<EventLog> {
  const b = readBundle(file);
  const m = b.meta;
  const claude = m.vendor === 'claude';
  // 원본 transcript 를 제자리에 — 같은 원본이 이미 있으면(같은 파일을 두 번 들여올 때) 그대로 쓴다
  const placed: string[] = [];
  let vsid: string | null = null;
  try {
    if (b.vendor) {
      const base = claude ? path.join(claudeHome(), 'projects', cwdSlug(cwd)) : path.join(codexHome(), 'sessions');
      const main = inside(base, b.vendor.files[0].path);
      if (!fs.existsSync(main)) {
        for (const f of b.vendor.files) {
          const p = inside(base, f.path);
          fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
          fs.writeFileSync(p, Buffer.from(f.data, 'base64'), { flag: 'wx', mode: 0o600 });
          placed.push(p);
        }
      }
      // Claude 는 지금 복제해 새 id 로, Codex 는 첫 기동이 meta.forkFrom 으로 thread/fork 한다
      if (claude) vsid = await forkClaude(b.vendor.sessionId, cwd);
    }
  } catch (e) { for (const p of placed) fs.rmSync(p, { force: true }); throw e; }
  // Claude 복제본은 메시지 uuid 가 새로 매겨진다 — 줄마다의 forkedFrom 으로 slcode 기록의 uuid 를 복제본 것으로 (되돌리기·fork 지점)
  const map = new Map<string, string>();
  if (vsid) {
    for (const line of fs.readFileSync(path.join(claudeHome(), 'projects', cwdSlug(cwd), `${vsid}.jsonl`), 'utf8').split('\n')) {
      try { const o = JSON.parse(line); if (o.forkedFrom?.messageUuid && o.uuid) map.set(o.forkedFrom.messageUuid, o.uuid); } catch {}
    }
  }
  const re = (u: string | null | undefined) => (u ? map.get(u) ?? null : u ?? null);
  const events = vsid ? b.events.map((e) => e.ev.kind === 'turn.end' ? { ...e, ev: { ...e.ev, userUuid: re(e.ev.userUuid), uuid: re(e.ev.uuid) } }
    : e.ev.kind === 'session.imported' ? { ...e, ev: { ...e.ev, uuid: re(e.ev.uuid) } } : e) : b.events;
  // 이 머신에 없는 관계(parent·team·agent·worktree)와 pid·fromStart·옛 복제 지점은 잇지 않는다
  // provider 는 id 만 — 설정·키(providers.json)는 담지 않는다, 이 머신에 없으면 core 가 열지 않고 알린다
  const log = EventLog.create(sessionsDir, {
    id: randomUUID().slice(0, 8), vendor: m.vendor, cwd, title: opts.title ?? m.title, vendorSessionId: vsid,
    createdAt: m.createdAt, updatedAt: m.updatedAt, closedAt: Date.now(), permissionMode: opts.mode ?? m.permissionMode, raw: m.raw,
    model: m.model, effort: m.effort, inspect: m.inspect, agentPlugins: m.agentPlugins, provider: m.provider, profile: m.profile, prompt: m.prompt, env: m.env, params: m.params, noTeam: m.noTeam,
    ...(!claude && b.vendor ? { forkFrom: b.vendor.sessionId } : {}),
    movedFrom: { id: m.id, cwd: m.cwd, exportedAt: b.exportedAt },
  });
  for (const e of events) log.append(e);
  log.close();
  // system prompt 판 — 이 머신에 그 이름·판이 없을 때만 (판은 한 번 쓰면 고치지 않는다)
  if (b.prompt) {
    const dir = path.join(stateDir, PROMPTS_DIR, b.prompt.name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeNew(path.join(dir, `v${b.prompt.version}.json`), b.prompt.data);
    if (b.prompt.description !== null) writeNew(path.join(dir, 'prompt.json'), JSON.stringify({ description: b.prompt.description }, null, 2));
  }
  return log;
}
