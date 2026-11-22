// system prompt 목록·편집 창의 요청 (ticket slcode-profile-system-prompt → slcode-prompt-library) — 웹은 시작 화면 서버(startPage)의 api/, superlite 카드는 `slcode start-call`.
// 에이전트 플러그인 관리(serve.pluginMethod)와 같은 길이다. 화면은 web/profiles.js(목록·고르기)와 web/prompt.js(편집 창).
// 가져오기(prompt.fetch)만 Claude Code 를 돌린다(약 1초, 요금 없음) — 받은 원본은 새 판에 저장되어 편집 창·세션이 다시 받지 않는다.
import os from 'node:os';
import { stripEnv } from './core.js';
import { claudeLoad, DEFAULT_PROFILE, getProfile, listProfiles, removePrompt, renamePrompt } from './profiles.js';
import { SLCODE_PROMPT } from './prompt.js';
import { capturePrompt } from './promptCapture.js';
import { addVersion, checkPromptName, copyPrompt, createPrompt, firstSpec, latestVersion, promptNames, readDescription, readVersion, writeDescription, type PromptVersion } from './promptLibrary.js';
import { BUILTIN_PIECES } from './promptPieces.js';
import { CoreError, ERR } from './protocol.js';
import { normOf, segment, specOf, type EditedItem, type PromptItem } from './systemPrompt.js';

export const PROMPT_METHODS = ['prompt.list', 'prompt.create', 'prompt.remove', 'prompt.get', 'prompt.fetch', 'prompt.save', 'prompt.describe', 'prompt.copy', 'prompt.rename'] as const;
export type PromptMethod = (typeof PROMPT_METHODS)[number];
/** prompt.list 의 한 줄 — latest 는 최신 판(0 은 판 없음), fetchedAt·model 은 최신 판 원본의 것(없으면 null), description 은 설명(없으면 빈 글), usedBy 는 고른 프로필 */
export type PromptRow = { name: string; latest: number; fetchedAt: number | null; model: string | null; description: string; usedBy: string[] };
/** 판 하나의 화면 — items 는 고칠 수 있는 줄들(판의 설정을 입힌 것, 글은 자리표시 그대로), 읽기 전용: identity(정체성 한 줄)·tail(Claude Code 가 늘 붙이는 글)·slcode(slcode 지시).
 *  판이 없거나(만들기 직후) 원본이 없으면 original false 이고 items 는 비었다. items 의 user 는 사용자가 나누거나 합쳐 만든 블록 */
export type PromptView = { name: string; version: number; latest: number; description: string; original: boolean; fetchedAt: number | null; model: string | null; identity: string; items: (PromptItem & { user?: true })[]; tail: string; slcode: string };

const bad = (m: string) => new CoreError(ERR.badRequest, m);
/** 처음 가져올 때 채우는 설명 — "from Claude (sonnet) on 26.11.21", 기본 모델이면 모델을 뺀다 */
export const fetchedNote = (model: string | null, d: Date) =>
  `from Claude${model ? ` (${model})` : ''} on ${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
const same = (s: string) => s; // 판의 글은 이미 자리표시로 바뀌어 있다

function view(dir: string, name: string, v: PromptVersion | null, latest: number): PromptView {
  const o = v?.original ?? null;
  // 원본이 없는 판은 사용자가 직접 쓴 것 — 더한 블록만 있다(빈 블록 하나에 얹는다)
  const items = segment(o?.blocks ?? [''], v?.spec ?? undefined, BUILTIN_PIECES, same).map((it) => (it.kind === 'piece' && it.known === 'profile' && !BUILTIN_PIECES.some((b) => b.hash === it.hash) ? { ...it, user: true as const } : it));
  return { name, version: v?.version ?? 0, latest, description: readDescription(dir, name) ?? '', original: !!o, fetchedAt: o?.fetchedAt ?? null, model: o?.model ?? null, identity: o?.identity ?? '', items, tail: o?.tail ?? '', slcode: SLCODE_PROMPT };
}
const nameOf = (v: unknown): string => { if (typeof v !== 'string' || !v) throw bad('name must be a non-empty string'); return v; };
const latestOf = (dir: string, name: string): number => { const n = latestVersion(dir, name); if (n === null) throw bad(`no system prompt ${name}`); return n; };

/** cwd 는 slcode 를 띄운 폴더 — 가져오기는 그 폴더와 default 프로필의 로드 설정, 화면에서 고른 모델로 돌린다 */
export async function promptMethod(dir: string, cwd: string, method: PromptMethod, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as { name?: unknown; version?: unknown; model?: unknown; recommended?: unknown; base?: unknown; items?: unknown; description?: unknown; to?: unknown };
  switch (method) {
    case 'prompt.list': {
      const profiles = listProfiles(dir);
      const rows: PromptRow[] = promptNames(dir).map((name) => {
        const latest = latestVersion(dir, name) ?? 0, o = readVersion(dir, name, latest)?.original;
        return { name, latest, fetchedAt: o?.fetchedAt ?? null, model: o ? o.model : null, description: readDescription(dir, name) ?? '', usedBy: profiles.filter((r) => r.profile.claude.prompt === name).map((r) => r.name) };
      });
      return { prompts: rows };
    }
    case 'prompt.create': {
      const name = nameOf(p.name);
      try { checkPromptName(name); createPrompt(dir, name); } catch (e) { throw bad((e as Error).message); }
      return { name };
    }
    // 복제는 판째·설명째 — 벤더 기본의 복제는 화면이 만들기·가져오기로 한다
    case 'prompt.copy': {
      const name = nameOf(p.name), to = nameOf(p.to);
      try { copyPrompt(dir, name, to); } catch (e) { throw bad((e as Error).message); }
      return { name: to };
    }
    case 'prompt.rename': {
      try { return await renamePrompt(nameOf(p.name), nameOf(p.to), dir); } catch (e) { throw e instanceof CoreError ? e : bad((e as Error).message); }
    }
    case 'prompt.remove': {
      try { return await removePrompt(nameOf(p.name), dir); } catch (e) { throw e instanceof CoreError ? e : bad((e as Error).message); }
    }
    case 'prompt.get': {
      const name = nameOf(p.name), latest = latestOf(dir, name);
      const v = typeof p.version === 'number' ? p.version : latest;
      const ver = readVersion(dir, name, v);
      if (v > 0 && !ver) throw bad(`system prompt ${name} has no v${v}`);
      return view(dir, name, ver, latest);
    }
    // 다시 가져오기도 새 판 — 앞 판의 설정은 해시가 맞는 블록에 이어진다. 처음 가져오는 것이면 recommended(기본 켬)일 때 기본으로 끄는 블록을 끈다.
    // recommended false 는 블록만 나누고 모두 켠 채 둔다 (가져오기 창의 "slcode 권장 설정 적용", 사용자 2026-11-21)
    case 'prompt.fetch': {
      const name = nameOf(p.name), latest = latestOf(dir, name);
      const env = stripEnv(process.env), norm = normOf(env, cwd, os.homedir()), model = typeof p.model === 'string' && p.model ? p.model : null;
      let cap;
      try { cap = await capturePrompt({ cwd, env, load: claudeLoad(getProfile(DEFAULT_PROFILE, dir)!.claude, cwd, env, []), ...(model ? { model } : {}) }); }
      catch (e) { throw bad((e as Error).message); }
      const prev = readVersion(dir, name, latest), blocks = cap.blocks.map(norm);
      let fetchedBefore = false;
      for (let v = latest; v > 0 && !fetchedBefore; v--) fetchedBefore = !!readVersion(dir, name, v)?.original;
      const spec = fetchedBefore || p.recommended === false ? prev?.spec : firstSpec(blocks, prev?.spec ?? null);
      if (readDescription(dir, name) === null) writeDescription(dir, name, fetchedNote(model, new Date()));
      const ver = addVersion(dir, name, { original: { fetchedAt: Date.now(), model, identity: norm(cap.identity), blocks, tail: norm(cap.tail) }, spec });
      return view(dir, name, ver, ver.version);
    }
    // 저장은 base 판의 원본에 화면의 설정을 얹은 새 판. 원본이 없으면(base 0 포함) 사용자가 직접 쓴 블록만의 판
    case 'prompt.save': {
      const name = nameOf(p.name);
      if (typeof p.base !== 'number' || !Array.isArray(p.items)) throw bad('prompt.save {name, base, items}');
      latestOf(dir, name);
      const base = p.base > 0 ? readVersion(dir, name, p.base) : null;
      if (p.base > 0 && !base) throw bad(`system prompt ${name} has no v${p.base}`);
      const ver = addVersion(dir, name, { original: base?.original ?? null, spec: specOf(p.items as EditedItem[], same) });
      return view(dir, name, ver, ver.version);
    }
    // 설명만 고친다 — 판은 오르지 않는다
    case 'prompt.describe': {
      const name = nameOf(p.name);
      if (typeof p.description !== 'string') throw bad('prompt.describe {name, description}');
      latestOf(dir, name);
      writeDescription(dir, name, p.description.trim());
      return { name, description: p.description.trim() };
    }
  }
}
