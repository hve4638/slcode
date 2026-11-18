// 프로필 관리 화면의 요청 (ticket slcode-profile-manager, 사용자 2026-11-18: 시작 화면의 "system prompt" 단추 자리를 "프로필" 로) — 웹은 시작 화면 서버(startPage)의 api/,
// superlite 카드는 `slcode start-call`. plugins.*·prompt.* 와 같은 길이다. 화면은 web/profiles.js. 고치는 요청은 CLI `slcode profile` 과 같은 함수를 부른다.
import { listPlugins } from 'slcode-plugin/agentPlugins';
import { addProfile, listProfiles, profileSummary, removeProfile, renameProfile, setProfile } from './profiles.js';
import { cleanSpec } from './systemPrompt.js';
import { CoreError, ERR } from './protocol.js';

export const PROFILE_METHODS = ['profile.list', 'profile.add', 'profile.set', 'profile.remove', 'profile.rename'] as const;
export type ProfileMethod = (typeof PROFILE_METHODS)[number];

const bad = (m: string) => new CoreError(ERR.badRequest, m);
const str = (v: unknown, what: string): string => { if (typeof v !== 'string' || !v) throw bad(`${what} must be a non-empty string`); return v; };
const strs = (v: unknown, what: string): string[] => { if (v === undefined) return []; if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw bad(`${what} must be an array of strings`); return v; };

export async function profileMethod(dir: string, method: ProfileMethod, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  if (method === 'profile.list') {
    return {
      profiles: listProfiles(dir).map((r) => ({ ...r, summary: profileSummary(r.profile), edited: !!cleanSpec(r.profile.claude.systemPrompt) })),
      // part 의 on·옵션의 value 는 플러그인 자체 설정(plugin set) — 프로필이 정하지 않으면 이 값을 따른다
      plugins: listPlugins(dir).map((x) => ({ name: x.name, version: x.version, parts: x.parts.map(({ name, on, required, default: d }) => ({ name, on, required, default: d })), options: x.options.map(({ name, type, value, default: d, label }) => ({ name, type, value, default: d, label })) })),
    };
  }
  try {
    switch (method) {
      case 'profile.add': return await addProfile(str(p.name, 'name'), typeof p.from === 'string' && p.from ? p.from : undefined, dir);
      case 'profile.set': {
        const set = strs(p.set, 'set'), unset = strs(p.unset, 'unset');
        if (!set.length && !unset.length) throw new Error('profile.set {name, set?: ["<key>=<value>"], unset?: ["<key>"]} needs set or unset');
        return await setProfile(str(p.name, 'name'), set, dir, unset);
      }
      case 'profile.remove': return await removeProfile(str(p.name, 'name'), dir);
      case 'profile.rename': return await renameProfile(str(p.from, 'from'), str(p.to, 'to'), dir);
    }
  } catch (e) { throw e instanceof CoreError ? e : bad((e as Error).message); }
}
