// system prompt 목록·판 (ticket slcode-prompt-library, 사용자 2026-11-18·19 — ws docs/ticket/slcode-prompt-library/TICKET.md).
// 프롬프트는 프로필과 따로 이름 있는 목록이다. 프로필은 claude.prompt 에 이름만 적고(없으면 벤더 기본 = SDK 에 아무것도 덮어쓰지 않는다), 세션은 띄울 때의 판을 meta.prompt 에 적는다.
// 자리: <상태 폴더>/prompts/<이름>/v<n>.json — 판마다 파일 하나, 한 번 쓰면 고치지 않는다(돌고 있는 세션이 옛 판을 쓴다). 판은 저장·가져오기마다 하나씩 오른다.
// 판에는 가져온 Claude Code 원본(original)과 블록 설정(spec, systemPrompt.ts 의 해시 꼴)을 함께 둔다 — 원본이 있어 편집 창과 세션이 Claude Code 를 다시 돌리지 않는다.
// 설명(description)은 판과 따로 <이름>/prompt.json 에 둔다 — 사용자가 언제든 고치며, 고쳐도 판이 오르지 않는다(사용자 2026-11-21). 처음 가져올 때 "from Claude on 26.11.21" 로 채운다.
// 원본의 세션마다 다른 값(메모리 경로·설정 폴더·작업 폴더·홈)은 자리표시(<memory> 등)로 저장하고 세션이 자기 값으로 바꾼다(sessionPrompt).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cleanSpec, compose, segment, type PromptSpec } from './systemPrompt.js';
import { BUILTIN_PIECES } from './promptPieces.js';

export const PROMPTS_DIR = 'prompts';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** 가져온 원본 — blocks·identity·tail 은 자리표시로 바꾼 글. model 은 가져올 때 고른 모델(null 은 Claude Code 기본), 모델별 문단이 그 모델의 것이다 */
export type PromptOriginal = { fetchedAt: number; model: string | null; identity: string; blocks: string[]; tail: string };
/** 판 하나 — original 이 없으면 사용자가 직접 쓴 판(spec.added 만, 사용자 2026-11-21) */
export type PromptVersion = { version: number; savedAt: number; original: PromptOriginal | null; spec: PromptSpec | null };
/** 세션이 쓰는 판 (SessionMeta.prompt) — version 0 은 판이 하나도 없던 프롬프트 */
export type PromptRef = { name: string; version: number };

const dirOf = (stateDir: string, name: string) => path.join(stateDir, PROMPTS_DIR, name);
const fileOf = (stateDir: string, name: string, v: number) => path.join(dirOf(stateDir, name), `v${v}.json`);

export function checkPromptName(name: string) {
  if (!NAME.test(name)) throw new Error(`prompt name must match ${NAME}`);
}
/** 만든 프롬프트 이름 — 이름 순 */
export function promptNames(stateDir: string): string[] {
  try { return fs.readdirSync(path.join(stateDir, PROMPTS_DIR), { withFileTypes: true }).filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort(); } catch { return []; }
}
/** 최신 판 번호 — 프롬프트가 없으면 null, 판이 없으면 0 */
export function latestVersion(stateDir: string, name: string): number | null {
  if (!NAME.test(name)) return null;
  let files: string[];
  try { files = fs.readdirSync(dirOf(stateDir, name)); } catch { return null; }
  return files.reduce((n, f) => { const m = /^v(\d+)\.json$/.exec(f); return m ? Math.max(n, Number(m[1])) : n; }, 0);
}
const str = (v: unknown): v is string => typeof v === 'string';
/** 판을 읽는다 — 없거나 꼴이 아니면 null */
export function readVersion(stateDir: string, name: string, v: number): PromptVersion | null {
  if (!NAME.test(name) || !(v > 0)) return null;
  let j: Record<string, unknown>;
  try { j = JSON.parse(fs.readFileSync(fileOf(stateDir, name, v), 'utf8')); } catch { return null; }
  const o = j.original as Record<string, unknown> | null;
  const original = o && typeof o === 'object' && Array.isArray(o.blocks) && o.blocks.every(str) && str(o.identity) && str(o.tail)
    ? { fetchedAt: Number(o.fetchedAt) || 0, model: str(o.model) ? o.model : null, identity: o.identity, blocks: o.blocks as string[], tail: o.tail } : null;
  return { version: v, savedAt: Number(j.savedAt) || 0, original, spec: cleanSpec(j.spec) ?? null };
}

const metaOf = (stateDir: string, name: string) => path.join(dirOf(stateDir, name), 'prompt.json');
/** 설명 — 한 번도 정하지 않았으면 null (빈 글은 사용자가 지운 것) */
export function readDescription(stateDir: string, name: string): string | null {
  if (!NAME.test(name)) return null;
  try { const d = JSON.parse(fs.readFileSync(metaOf(stateDir, name), 'utf8')).description; return str(d) ? d : null; } catch { return null; }
}
export function writeDescription(stateDir: string, name: string, description: string) {
  if (latestVersion(stateDir, name) === null) throw new Error(`no prompt ${name}`);
  const tmp = `${metaOf(stateDir, name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ description }, null, 2));
  fs.renameSync(tmp, metaOf(stateDir, name));
}

/** 빈 프롬프트를 만든다 — 판은 가져오기·저장 때 생긴다 */
export function createPrompt(stateDir: string, name: string) {
  checkPromptName(name);
  fs.mkdirSync(path.join(stateDir, PROMPTS_DIR), { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(dirOf(stateDir, name), { mode: 0o700 }); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`prompt ${name} already exists`);
    throw e;
  }
}
/** 새 판을 쓴다 — 번호는 최신 + 1. 다른 프로세스가 같은 번호를 먼저 쓰면 다음 번호로 (파일은 tmp 를 link 해 한 번에 나타난다) */
export function addVersion(stateDir: string, name: string, data: { original: PromptOriginal | null; spec: PromptSpec | null | undefined }): PromptVersion {
  const latest = latestVersion(stateDir, name);
  if (latest === null) throw new Error(`no prompt ${name}`);
  const tmp = path.join(dirOf(stateDir, name), `.v.${process.pid}.tmp`);
  for (let v = latest + 1; ; v++) {
    const ver: PromptVersion = { version: v, savedAt: Date.now(), original: data.original, spec: cleanSpec(data.spec) ?? null };
    fs.writeFileSync(tmp, JSON.stringify(ver, null, 2));
    try { fs.linkSync(tmp, fileOf(stateDir, name, v)); return ver; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    finally { fs.rmSync(tmp, { force: true }); }
  }
}
/** 프롬프트를 판째·설명째 복사한다 — to 가 있으면 던진다 */
export function copyPrompt(stateDir: string, from: string, to: string) {
  checkPromptName(to);
  if (latestVersion(stateDir, from) === null) throw new Error(`no prompt ${from}`);
  createPrompt(stateDir, to);
  fs.cpSync(dirOf(stateDir, from), dirOf(stateDir, to), { recursive: true });
}
/** 폴더 이름을 바꾼다 — 고른 프로필을 고치는 것은 부르는 쪽(profiles.renamePrompt) */
export function movePrompt(stateDir: string, from: string, to: string) {
  checkPromptName(to);
  if (latestVersion(stateDir, from) === null) throw new Error(`no prompt ${from}`);
  if (latestVersion(stateDir, to) !== null) throw new Error(`prompt ${to} already exists`);
  fs.renameSync(dirOf(stateDir, from), dirOf(stateDir, to));
}
/** 프롬프트를 판째 지운다 — 쓰는 프로필이 없는지는 부르는 쪽(profiles.removePrompt)이 본다 */
export function deletePrompt(stateDir: string, name: string): boolean {
  if (latestVersion(stateDir, name) === null) return false;
  fs.rmSync(dirOf(stateDir, name), { recursive: true, force: true });
  return true;
}

/** 처음 가져온 원본에 씌울 설정 — 미리 나눠 둔 블록 중 기본으로 끄는 것(promptPieces 의 off)을 끈다. 앞 판이 정한 블록은 그대로 */
export function firstSpec(blocks: string[], prev: PromptSpec | null): PromptSpec | undefined {
  const same = (s: string) => s;
  const offs = BUILTIN_PIECES.filter((b) => b.off && !prev?.pieces.some((p) => p.hash === b.hash));
  const hits = segment(blocks, undefined, offs, same).flatMap((it) => (it.kind === 'piece' && it.known === 'builtin' ? [{ head: it.head, lines: it.lines, hash: it.hash, off: true as const }] : []));
  if (!hits.length) return prev ?? undefined;
  return cleanSpec({ pieces: [...(prev?.pieces ?? []), ...hits], added: prev?.added ?? [] });
}

/** Claude Code 의 메모리 폴더 자리 — <설정 폴더>/projects/<프로젝트 뿌리의 경로에서 영문·숫자 밖을 - 로>. 뿌리는 git 이면 주 체크아웃(worktree 도 같은 메모리), 아니면 작업 폴더.
 *  Claude Code 2.1.326 의 규칙을 따라 한 것이다 — 틀리면 메모리 절의 경로만 어긋난다 */
export function memoryDirOf(configDir: string, cwd: string): string {
  let root = cwd;
  try {
    const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
    if (common) root = path.basename(common) === '.git' ? path.dirname(common) : execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim() || cwd;
  } catch { /* git 이 아니다 */ }
  return path.join(configDir, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
}

/** 세션이 보낼 배열 블록 글 — 판의 원본에 설정을 입히고 자리표시를 세션 값으로. 원본이 없는 판은 직접 쓴 블록만 한 덩어리로.
 *  판이 없거나 원본도 직접 쓴 블록도 없으면 사유 (세션은 벤더 기본으로 뜬다) */
export function sessionPrompt(stateDir: string, ref: PromptRef, at: { configDir: string; cwd: string; home: string }): { blocks: string[] } | { why: string } {
  const v = readVersion(stateDir, ref.name, ref.version);
  if (!v) return { why: latestVersion(stateDir, ref.name) === null ? `system prompt ${ref.name} 이 없습니다` : `system prompt ${ref.name} 에 v${ref.version} 이 없습니다` };
  if (!v.original && !v.spec?.added.length) return { why: `system prompt ${ref.name} v${ref.version} 이 비었습니다` };
  const blocks = v.original?.blocks ?? [''];
  const real = { '<memory>': memoryDirOf(at.configDir, at.cwd), '<config>': at.configDir, '<cwd>': at.cwd, '<home>': at.home };
  const fill = (s: string) => s.replace(/<(memory|config|cwd|home)>/g, (m) => real[m as keyof typeof real]);
  const out = compose(segment(blocks, v.spec ?? undefined, BUILTIN_PIECES, (s) => s), blocks.length).map(fill);
  return { blocks: v.original ? out : out.map((s) => s.replace(/^\n+/, '')) }; // 직접 쓴 판은 맨 앞이 더한 블록이라 앞 간격이 붙는다
}
