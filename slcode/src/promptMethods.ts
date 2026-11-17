// system prompt 편집 창의 요청 (ticket slcode-profile-system-prompt, 사용자 2026-11-17: 시작 화면에서 연다) — 웹은 시작 화면 서버(startPage)의 api/, superlite 카드는 `slcode start-call`.
// 에이전트 플러그인 관리(serve.pluginMethod)와 같은 길이다. 화면은 web/prompt.js.
import os from 'node:os';
import { stripEnv } from './core.js';
import { claudeLoad, getProfile, listProfiles, profileSummary, setProfilePrompt } from './profiles.js';
import { SLCODE_PROMPT } from './prompt.js';
import { capturePrompt } from './promptCapture.js';
import { BUILTIN_PIECES } from './promptPieces.js';
import { CoreError, ERR } from './protocol.js';
import { cleanSpec, normOf, segment, specOf, type EditedItem, type PromptItem } from './systemPrompt.js';

export const PROMPT_METHODS = ['prompt.profiles', 'prompt.fetch', 'prompt.save'] as const;
export type PromptMethod = (typeof PROMPT_METHODS)[number];
/** prompt.fetch 의 답 — items 는 고칠 수 있는 줄들(프로필의 설정을 입힌 것), 나머지는 읽기 전용으로 보인다: identity(정체성 한 줄), tail(Claude Code 가 늘 붙이는 글), slcode(slcode 지시) */
/** items 의 user 는 사용자가 나누거나 합쳐 만든 블록 — 설정을 풀어도 저장에 남긴다 */
export type PromptView = { profile: string; builtin: boolean; identity: string; items: (PromptItem & { user?: true })[]; tail: string; slcode: string };

const bad = (m: string) => new CoreError(ERR.badRequest, m);

/** cwd 는 slcode 를 띄운 폴더 — 가져오기는 그 폴더와 그 프로필의 로드 설정, 화면에서 고른 모델로 돌린다 */
export async function promptMethod(dir: string, cwd: string, method: PromptMethod, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as { profile?: unknown; model?: unknown; as?: unknown; items?: unknown };
  const env = stripEnv(process.env), norm = normOf(env, cwd, os.homedir());
  switch (method) {
    case 'prompt.profiles':
      return { profiles: listProfiles(dir).map((r) => ({ name: r.name, builtin: r.builtin, summary: profileSummary(r.profile), edited: !!cleanSpec(r.profile.claude.systemPrompt) })) };
    case 'prompt.fetch': {
      const prof = typeof p.profile === 'string' ? getProfile(p.profile, dir) : null;
      if (!prof) throw bad(`no profile ${p.profile}`);
      let cap;
      try { cap = await capturePrompt({ cwd, env, load: claudeLoad(prof.claude, cwd, env, []), ...(typeof p.model === 'string' && p.model ? { model: p.model } : {}) }); }
      catch (e) { throw bad((e as Error).message); }
      const view: PromptView = { profile: p.profile as string, builtin: !!listProfiles(dir).find((r) => r.name === p.profile)?.builtin, identity: cap.identity, items: segment(cap.blocks, cleanSpec(prof.claude.systemPrompt), BUILTIN_PIECES, norm).map((it) => (it.kind === 'piece' && it.known === 'profile' && !BUILTIN_PIECES.some((b) => b.hash === it.hash) ? { ...it, user: true as const } : it)), tail: cap.tail, slcode: SLCODE_PROMPT };
      return view;
    }
    case 'prompt.save': {
      if (typeof p.profile !== 'string' || !Array.isArray(p.items)) throw bad('prompt.save {profile, items, as?}');
      try { return await setProfilePrompt(p.profile, specOf(p.items as EditedItem[], norm), dir, typeof p.as === 'string' && p.as ? p.as : undefined); }
      catch (e) { throw bad((e as Error).message); }
    }
  }
}
