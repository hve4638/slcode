// 프로바이더 관리 화면의 요청 (ticket slcode-custom-provider, 사용자 결정 2026-11-25: 시작 화면의 "프로바이더" 단추, 프로필 관리와 같은 꼴) — 웹 시작 화면은 startPage 의 api/,
// superlite 카드 시작 화면은 `slcode start-call`, 대화 화면(모델 메뉴의 "프로바이더 관리")은 serve 가 답한다. 화면은 web/providers.js 하나. 키는 내보내지 않는다
import { fetchModels, getProvider, publicKey, publicProvider, readKeys, readProviders, removeKey, removeProvider, saveKey, saveProvider, TEMPLATES, type Provider } from './provider.js';
import { CoreError, ERR } from './protocol.js';

export const PROVIDER_METHODS = ['provider.list', 'provider.save', 'provider.remove', 'provider.models', 'provider.keySave', 'provider.keyRemove'] as const;
export type ProviderMethod = (typeof PROVIDER_METHODS)[number];

const bad = (m: string) => new CoreError(ERR.badRequest, m);
const obj = (v: unknown, what: string): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad(`${what} must be an object`); return v as Record<string, unknown>; };

export async function providerMethod(dir: string, method: ProviderMethod, params: unknown): Promise<unknown> {
  const p = (params ?? {}) as Record<string, unknown>;
  try {
    switch (method) {
      case 'provider.list': { const providers = readProviders(dir); return { providers: providers.map(publicProvider), keys: readKeys(dir).map((k) => publicKey(k, providers)), templates: TEMPLATES }; }
      case 'provider.save': return { provider: publicProvider(saveProvider(dir, obj(p.provider, 'provider'))) };
      case 'provider.remove': if (typeof p.id !== 'string' || !p.id) throw bad('id required'); return { removed: removeProvider(dir, p.id) };
      // 키 관리 (사용자 2026-11-26) — 키 값은 받기만 하고 내보내지 않는다
      case 'provider.keySave': { const k = saveKey(dir, obj(p.key, 'key')); return { key: publicKey(k, readProviders(dir)) }; }
      case 'provider.keyRemove': if (typeof p.id !== 'string' || !p.id) throw bad('id required'); return { removed: removeKey(dir, p.id) };
      case 'provider.models': {
        // 저장한 프로바이더면 저장한 키로 — 화면은 키를 모른다. 화면에서 고친 값(주소 등)은 그 위에
        const given = obj(p.provider, 'provider');
        const saved = typeof given.id === 'string' && given.id ? getProvider(dir, given.id) : null;
        const draft = { headers: {}, auth: 'bearer', template: 'custom', vendor: 'claude', baseUrl: '', ...saved, ...given, key: typeof given.key === 'string' ? given.key : saved?.key ?? '' } as Provider;
        if (!draft.baseUrl && TEMPLATES[draft.template]?.list !== 'openrouter') throw bad('baseUrl required');
        return { models: await fetchModels(draft) };
      }
    }
  } catch (e) { throw e instanceof CoreError ? e : bad((e as Error).message); }
}
