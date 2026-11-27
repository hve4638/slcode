// custom provider (ticket slcode-custom-provider, 사용자 결정 2026-11-25) — Anthropic·OpenAI 공식 계정이 아닌 프로바이더(OpenRouter 같은 제3자, Ollama·LM Studio 같은 로컬 모델)로 세션을 돌린다.
// 프로바이더 하나 = 엔진(vendor: claude 면 Claude Code 가 Anthropic Messages 주소로, codex 면 Codex 가 OpenAI Responses 주소로) + 주소·키·모델 + 세부.
// 저장은 상태 폴더의 providers.json 하나 — 키는 평문, 파일 권한 0600 (사용자 결정). 세션은 meta.provider 에 id 만 적고 띄울 때마다 지금 값을 읽는다.
// 키는 프로바이더에 직접 넣거나, 키 관리(같은 파일의 keys)에 둔 키 하나를 가리킨다(keyRef) — 여러 프로바이더가 한 키를 같이 쓴다 (사용자 2026-11-26).
// 벤더 env·인자에서 무엇을 넣고 빼는지는 이 모듈이 고른다. 근거와 표는 ws docs/report/slcode-custom-provider.md
import fs from 'node:fs';
import path from 'node:path';
import { FILES } from './protocol.js';

export type ProviderVendor = 'claude' | 'codex';
/** 기능 표시 — 꺼진 기능은 요청에 넣지 않는다. thinking: SDK thinking 옵션, effort: 모델 메뉴의 effort, betas: Claude Code 의 tool search·실험 beta */
export type ProviderFeatures = { thinking: boolean; effort: boolean; betas: boolean };
export type Provider = {
  id: string; name: string; template: string; vendor: ProviderVendor;
  /** key 는 쓸 키 — keyRef 가 있으면 읽을 때 키 관리의 값으로 채운다(디스크에는 keyRef 만) */
  baseUrl: string; key: string; keyRef: string; models: string[];
  /** Claude 엔진의 키 전달 — bearer(ANTHROPIC_AUTH_TOKEN, 기본)·x-api-key(ANTHROPIC_API_KEY) */
  auth: 'bearer' | 'x-api-key';
  headers: Record<string, string>;
  /** Claude 엔진의 등급별 모델 — 비우면 고른 모델 */
  tiers: { opus?: string; sonnet?: string; haiku?: string; subagent?: string };
  features: ProviderFeatures;
  env: Record<string, string>;
  /** 모델마다의 토큰 한도 (ticket slcode-provider-token-limits, 사용자 결정 2026-11-27) — 벤더는 모르는 모델의 크기를 추정한다(Claude Code 200000·출력 32000, Codex 258400).
   *  models 에 있는 모델만 남는다 */
  limits: Record<string, ModelLimits>;
};
/** context: 컨텍스트 크기(ctx % 와 자동 압축의 기준), output: 한 응답의 최대 출력 토큰(Claude 엔진만 — Codex 는 설정이 없다) */
export type ModelLimits = { context?: number; output?: number };
/** 키 관리의 키 하나 — 여러 프로바이더가 keyRef 로 가리킨다 */
export type ProviderKey = { id: string; name: string; value: string };
export type ProviderModel = { id: string; name?: string; context?: number };
/** 모델 목록 API 의 꼴 — openrouter·ollama 는 정해진 경로, auto 는 엔진대로(<주소>/v1/models·<주소>/models), none 은 API 가 없다 */
type ListKind = 'openrouter' | 'ollama' | 'auto' | 'none';
export type ProviderTemplate = {
  name: string; claude?: string; codex?: string; key?: string; headers?: Record<string, string>; models?: string[]; tiers?: Provider['tiers'];
  features: ProviderFeatures; list: ListKind; note?: string;
};

const NO = { thinking: false, effort: false, betas: false };
/** 잘 알려진 프로바이더 — 값은 공식 문서로 확인 (2026-11-25, 출처는 ws docs/report/slcode-custom-provider/research-raw.md) */
export const TEMPLATES: Record<string, ProviderTemplate> = {
  openrouter: { name: 'OpenRouter', claude: 'https://openrouter.ai/api', codex: 'https://openrouter.ai/api/v1', headers: { 'HTTP-Referer': 'https://github.com/hve4638/slcode', 'X-OpenRouter-Title': 'slcode' },
    features: { thinking: true, effort: false, betas: false }, list: 'openrouter', note: 'Anthropic 모델로 보낼 때만 Claude Code 기능이 모두 보장됩니다' },
  ollama: { name: 'Ollama', claude: 'http://localhost:11434', codex: 'http://localhost:11434/v1', key: 'ollama', features: { ...NO, thinking: true }, list: 'ollama', note: 'prompt cache·tool_choice 가 없고, context 64k 이상인 모델이 필요합니다' },
  lmstudio: { name: 'LM Studio', claude: 'http://localhost:1234', codex: 'http://localhost:1234/v1', key: 'lmstudio', features: NO, list: 'auto' },
  vllm: { name: 'vLLM', claude: 'http://localhost:8000', codex: 'http://localhost:8000/v1', features: NO, list: 'auto' },
  llamacpp: { name: 'llama.cpp', claude: 'http://localhost:9931', codex: 'http://localhost:9931/v1', features: NO, list: 'auto', note: '도구 호출을 지원하는 GGUF 모델이 필요합니다. 예전 빌드는 기본 포트가 8080 입니다' },
  litellm: { name: 'LiteLLM proxy', claude: 'http://localhost:4000', codex: 'http://localhost:4000/v1', features: { ...NO, thinking: true }, list: 'auto' },
  deepseek: { name: 'DeepSeek', claude: 'https://api.deepseek.com/anthropic', models: ['deepseek-flash[1m]'], tiers: { haiku: 'deepseek-flash' }, features: { ...NO, thinking: true, effort: true }, list: 'none', note: 'cache_control 을 무시합니다' },
  kimi: { name: 'Kimi', claude: 'https://api.moonshot.ai/anthropic', models: ['kimi-k3[1m]'], features: { ...NO, thinking: true, effort: true }, list: 'none' },
  zai: { name: 'Z.ai GLM', claude: 'https://api.z.ai/api/anthropic', models: ['glm-5.4[1m]'], tiers: { haiku: 'glm-5.3-flash[1m]' }, features: { ...NO, thinking: true }, list: 'none', note: '코딩 플랜 키와 일반 키는 서로 쓸 수 없습니다' },
  minimax: { name: 'MiniMax', claude: 'https://api.minimax.io/anthropic', models: ['MiniMax-M3.1-Flash[1m]'], features: { ...NO, thinking: true, effort: true }, list: 'none', note: 'thinking 을 끄면 400 을 돌려줍니다' },
  qwen: { name: 'Qwen (Model Studio)', claude: 'https://dashscope-intl.aliyuncs.com/apps/anthropic', features: { ...NO, thinking: true }, list: 'none', note: '키 종류가 주소와 맞아야 합니다' },
  custom: { name: '직접 만들기', claude: 'http://localhost:8080', codex: 'http://localhost:8080/v1', features: NO, list: 'auto' }, // 주소는 만든 뒤 일반 탭에서 고친다 — 빈 주소는 저장하지 않는다
};

/** custom 세션의 Claude 벤더 env 에서 지우는 이름 — 셸·meta.env·플러그인 env 어디서 왔든. claudeConnection 이 다시 채운다 */
export const CONNECTION_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BETAS',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL', 'ENABLE_TOOL_SEARCH',
];
/** Codex 벤더 프로세스 env 에 키를 넣는 이름 — model_providers.<id>.env_key 가 가리킨다 */
export const PROVIDER_KEY_ENV = 'SLCODE_PROVIDER_KEY';

const fileOf = (dir: string) => path.join(dir, FILES.providers);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strMap = (v: unknown): Record<string, string> => Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([k, x]) => k && typeof x === 'string'));
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

function normalize(v: unknown, keys: ProviderKey[] = []): Provider | null {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const id = str(o.id), vendor = o.vendor === 'codex' ? 'codex' : o.vendor === 'claude' ? 'claude' : null;
  if (!ID.test(id) || !vendor || !str(o.name)) return null;
  const f = (o.features && typeof o.features === 'object' ? o.features : {}) as Record<string, unknown>;
  const t = strMap(o.tiers);
  const models = Array.isArray(o.models) ? [...new Set(o.models.filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim()))] : [];
  const lim = (o.limits && typeof o.limits === 'object' ? o.limits : {}) as Record<string, Record<string, unknown> | null>;
  return {
    id, name: str(o.name), template: TEMPLATES[str(o.template)] ? str(o.template) : 'custom', vendor, baseUrl: str(o.baseUrl).trim(),
    ...(() => { const ref = keys.find((k) => k.id === str(o.keyRef)); return ref ? { key: ref.value, keyRef: ref.id } : { key: str(o.key), keyRef: '' }; })(),
    models,
    auth: o.auth === 'x-api-key' ? 'x-api-key' : 'bearer', headers: strMap(o.headers),
    tiers: Object.fromEntries(['opus', 'sonnet', 'haiku', 'subagent'].filter((k) => t[k]?.trim()).map((k) => [k, t[k].trim()])),
    features: { thinking: f.thinking === true, effort: f.effort === true, betas: f.betas === true }, env: strMap(o.env),
    limits: Object.fromEntries(models.flatMap((m) => {
      const context = count(lim[m]?.context), output = count(lim[m]?.output);
      return context || output ? [[m, { ...(context ? { context } : {}), ...(output ? { output } : {}) }]] : [];
    })),
  };
}

function readStore(dir: string): { providers: Provider[]; keys: ProviderKey[] } {
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')) ?? {}; } catch { /* 없거나 읽을 수 없으면 빈 것 */ }
  const keys = (Array.isArray(raw.keys) ? raw.keys : []).map((k: Record<string, unknown>) => ({ id: str(k?.id), name: str(k?.name), value: str(k?.value) }))
    .filter((k: ProviderKey) => ID.test(k.id) && k.name);
  const providers = (Array.isArray(raw.providers) ? raw.providers : []).map((v: unknown) => normalize(v, keys)).filter((p: Provider | null): p is Provider => !!p);
  return { providers, keys };
}
export const readProviders = (dir: string): Provider[] => readStore(dir).providers;
export const readKeys = (dir: string): ProviderKey[] => readStore(dir).keys;
export const getProvider = (dir: string, id: string): Provider | null => readProviders(dir).find((p) => p.id === id) ?? null;

/** 임시 파일 + rename, 0600 — 키가 든 파일이다. keyRef 를 쓰는 프로바이더는 키 값을 적지 않는다 */
function write(dir: string, list: Provider[], keys: ProviderKey[] = readKeys(dir)) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${fileOf(dir)}.${process.pid}.tmp`;
  const providers = list.map(({ key, keyRef, ...rest }) => (keyRef ? { ...rest, keyRef } : { ...rest, key }));
  fs.writeFileSync(tmp, JSON.stringify({ providers, keys }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, fileOf(dir));
}
function slug(name: string, fallback = 'provider'): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || fallback;
}

/** 추가·고치기 — id 가 있으면 그 프로바이더를 고친다. key 를 주지 않으면 지금 키를 남긴다 (화면은 키를 받지 않는다).
 *  key 를 주면 직접 넣은 키(keyRef 를 푼다), keyRef 를 주면 키 관리의 그 키 */
export function saveProvider(dir: string, input: Record<string, unknown>): Provider {
  const { providers: list, keys } = readStore(dir);
  const cur = typeof input.id === 'string' && input.id ? list.find((p) => p.id === input.id) : undefined;
  if (typeof input.id === 'string' && input.id && !cur) throw new Error(`no provider ${input.id}`);
  let id = cur?.id;
  if (!id) { const base = slug(str(input.name)); id = base; for (let n = 2; list.some((p) => p.id === id); n++) id = `${base}-${n}`; }
  if (typeof input.keyRef === 'string' && input.keyRef && !keys.some((k) => k.id === input.keyRef)) throw new Error(`no key ${input.keyRef}`);
  const keyPart = input.key !== undefined ? { key: input.key, keyRef: '' } : input.keyRef !== undefined ? { key: '', keyRef: input.keyRef } : { key: cur?.key ?? '', keyRef: cur?.keyRef ?? '' };
  const p = normalize({ ...cur, ...input, id, ...keyPart }, keys);
  if (!p) throw new Error('provider needs a name and vendor claude|codex');
  const t = TEMPLATES[p.template];
  if (t[p.vendor] === undefined) throw new Error(`${t.name} has no ${p.vendor === 'codex' ? 'OpenAI Responses' : 'Anthropic Messages'} endpoint — choose the other vendor`);
  if (!/^https?:\/\/[^/]/.test(p.baseUrl)) throw new Error('baseUrl must be an http(s) URL');
  write(dir, cur ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p], keys);
  return p;
}

/** 키 관리 — 추가·고치기. id 가 있으면 그 키를 고친다(value 를 주지 않으면 지금 값을 남긴다), 없으면 이름에서 만든 새 id. 가리키는 프로바이더는 다음에 읽을 때 새 값을 쓴다 */
export function saveKey(dir: string, input: Record<string, unknown>): ProviderKey {
  const { providers, keys } = readStore(dir);
  const cur = typeof input.id === 'string' && input.id ? keys.find((k) => k.id === input.id) : undefined;
  if (typeof input.id === 'string' && input.id && !cur) throw new Error(`no key ${input.id}`);
  const name = (typeof input.name === 'string' ? input.name : cur?.name ?? '').trim();
  const value = (typeof input.value === 'string' ? input.value : cur?.value ?? '').trim();
  if (!name) throw new Error('key needs a name');
  if (!value) throw new Error('key needs a value');
  let id = cur?.id;
  if (!id) { const base = slug(name, 'key'); id = base; for (let n = 2; keys.some((k) => k.id === id); n++) id = `${base}-${n}`; }
  const k = { id, name, value };
  write(dir, providers, cur ? keys.map((x) => (x.id === id ? k : x)) : [...keys, k]);
  return k;
}
/** 키 관리 — 지운다. 쓰는 프로바이더가 있으면 지우지 않는다 (그 프로바이더가 말없이 키 없이 돌지 않게) */
export function removeKey(dir: string, id: string): boolean {
  const { providers, keys } = readStore(dir);
  if (!keys.some((k) => k.id === id)) return false;
  const users = providers.filter((p) => p.keyRef === id);
  if (users.length) throw new Error(`key ${id} is used by ${users.map((p) => p.name).join(', ')}`);
  write(dir, providers, keys.filter((k) => k.id !== id));
  return true;
}
/** 화면으로 내보낼 키 — 값은 빼고 끝 4자와 쓰는 프로바이더 */
export const publicKey = (k: ProviderKey, providers: Provider[]) =>
  ({ id: k.id, name: k.name, tail: k.value.length > 8 ? k.value.slice(-4) : '', used: providers.filter((p) => p.keyRef === k.id).map((p) => ({ id: p.id, name: p.name })) });
/** custom 세션을 열 수 없는 사유 — 프로바이더를 지웠거나 엔진이 바뀌었다. 공식 계정으로 몰래 넘어가 다른 곳에 대화를 보내지 않게 열지 않는다.
 *  core 가 띄울 때와 시작 화면이 고를 때 같이 쓴다 (시작 화면은 고르기 전에 걸러야 서버가 내려가지 않는다) */
export function providerOpenError(dir: string, meta: { provider?: string; vendor: string }): string | null {
  if (!meta.provider) return null;
  const p = getProvider(dir, meta.provider);
  if (!p) return `provider ${meta.provider} is gone — this session cannot open without it (add it again with the same name in the start screen's providers)`;
  if (p.vendor !== meta.vendor) return `provider ${p.id} now runs on ${p.vendor} — this is a ${meta.vendor} session`;
  return null;
}

export function removeProvider(dir: string, id: string): boolean {
  const { providers: list, keys } = readStore(dir);
  if (!list.some((p) => p.id === id)) return false;
  write(dir, list.filter((p) => p.id !== id), keys);
  return true;
}
/** 화면·CLI 로 내보낼 꼴 — 키는 빼고 끝 4자만 */
export function publicProvider(p: Provider) {
  const { key, ...rest } = p;
  return { ...rest, hasKey: !!key, keyTail: key.length > 8 ? key.slice(-4) : '' };
}

export const withoutConnection = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !CONNECTION_ENV.includes(k)));

/** 모델의 토큰 한도 — model 이 비면 첫 모델 */
export const modelLimits = (p: Provider, model: string | null | undefined): ModelLimits => p.limits[model || p.models[0] || ''] ?? {};

/** Claude 벤더의 연결 env — SDK env 와 플래그 settings.env 에 같은 값으로 들어간다 (~/.claude/settings.json 의 env 가 프로세스 env 를 덮는다, 2026-11-25 스파이크).
 *  키가 비어도 빈 값으로 두지 않는다 — 비면 Claude Code 가 사용자 claude.ai 로그인으로 넘어가 그 토큰을 이 주소로 보낸다 */
export function claudeConnection(p: Provider, model: string | null | undefined, baseUrl = p.baseUrl): Record<string, string> {
  const m = model || p.models[0] || '';
  const key = p.key || 'none';
  const lim = modelLimits(p, m);
  return {
    ...p.env,
    ANTHROPIC_BASE_URL: baseUrl,
    ...(p.auth === 'x-api-key' ? { ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: '' } : { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' }),
    ...(m ? { ANTHROPIC_MODEL: m, ANTHROPIC_DEFAULT_FABLE_MODEL: p.tiers.opus || m, ANTHROPIC_DEFAULT_OPUS_MODEL: p.tiers.opus || m, ANTHROPIC_DEFAULT_SONNET_MODEL: p.tiers.sonnet || m, ANTHROPIC_DEFAULT_HAIKU_MODEL: p.tiers.haiku || m } : {}),
    ...(p.tiers.subagent ? { CLAUDE_CODE_SUBAGENT_MODEL: p.tiers.subagent } : {}),
    ANTHROPIC_CUSTOM_HEADERS: Object.entries(p.headers).map(([k, v]) => `${k}: ${v}`).join('\n'),
    // 모르는 모델 이름이면 Claude Code 가 쓰는 크기 — ctx % 와 자동 압축 기준(크기 − 출력 한도 − 약 13000)이 이 값을 따른다 (Claude Code 2.1.322 실측)
    ...(lim.context ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(lim.context) } : {}),
    ...(lim.output ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(lim.output) } : {}),
    // 1st party 내부 플래그와 tool search — 셸·사용자 settings.json 의 값도 덮는다
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '',
    ...(p.features.betas ? {} : { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', ENABLE_TOOL_SEARCH: 'false' }),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  };
}
/** SDK thinking 옵션 — adaptive 는 1st party 밖에서 400 이 난다 (Claude Code 게이트웨이 문서) */
export const claudeThinking = (p: Provider) => (p.features.thinking ? { type: 'enabled' as const, budgetTokens: 8192 } : { type: 'disabled' as const });

/** Codex app-server 의 -c 인자. 값은 TOML — JSON 문자열은 TOML basic string 으로도 읽힌다 */
export function codexProviderArgs(p: Provider, model: string | null | undefined, baseUrl = p.baseUrl): string[] {
  const id = `slcode-${p.id}`, q = JSON.stringify;
  const headers = Object.entries(p.headers);
  const { context } = modelLimits(p, model);
  return [
    '-c', `model_provider=${q(id)}`,
    '-c', `model_providers.${id}.name=${q(p.name)}`,
    '-c', `model_providers.${id}.base_url=${q(baseUrl)}`,
    '-c', `model_providers.${id}.wire_api="responses"`,
    ...(p.key ? ['-c', `model_providers.${id}.env_key=${q(PROVIDER_KEY_ENV)}`] : []),
    ...(headers.length ? ['-c', `model_providers.${id}.http_headers={${headers.map(([k, v]) => `${q(k)}=${q(v)}`).join(',')}}`] : []),
    // Codex 는 이 값의 95% 를 창으로 보고 자동 압축도 그 안에서 돈다 (codex 0.172 실측). 출력 한도 설정은 없다
    ...(context ? ['-c', `model_context_window=${context}`] : []),
  ];
}
export const codexProviderEnv = (p: Provider): Record<string, string> => ({ ...p.env, ...(p.key ? { [PROVIDER_KEY_ENV]: p.key } : {}) });

/** 목록 항목의 컨텍스트 크기 — OpenRouter 는 context_length, llama.cpp 는 meta.n_ctx(서버가 띄운 크기. meta.n_ctx_train 은 학습 길이라 쓰지 않는다, 2026-11-27 실측) */
const ctxOf = (m: Record<string, unknown>): number | undefined => {
  const meta = (m.meta && typeof m.meta === 'object' ? m.meta : {}) as Record<string, unknown>;
  return count(m.context_length) ?? count(meta.n_ctx);
};
/** 모델 목록 — 실패하면 사유로 던진다 (화면은 손으로 넣는 칸을 남긴다) */
export async function fetchModels(p: Provider): Promise<ProviderModel[]> {
  const kind = TEMPLATES[p.template]?.list ?? 'auto';
  if (kind === 'none') throw new Error(`${TEMPLATES[p.template].name} has no model list API — type the model name`);
  const base = p.baseUrl.replace(/\/+$/, '');
  const url = kind === 'openrouter' ? 'https://openrouter.ai/api/v1/models'
    : kind === 'ollama' ? `${new URL(base).origin}/api/tags`
    : p.vendor === 'claude' ? `${base}/v1/models?limit=1000` : `${base}/models`;
  const headers: Record<string, string> = { ...p.headers };
  if (p.key) {
    if (p.vendor === 'claude' && p.auth === 'x-api-key') headers['x-api-key'] = p.key; else headers.authorization = `Bearer ${p.key}`;
  }
  if (p.vendor === 'claude' && kind === 'auto') headers['anthropic-version'] = '2023-06-01';
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(url, { headers, signal: ac.signal });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const body = await r.json() as { data?: unknown[]; models?: unknown[] };
    const rows = (body.data ?? body.models ?? []) as Record<string, unknown>[];
    const out = rows.map((m) => ({ id: str(m.id) || str(m.name) || str(m.model), name: str(m.display_name) || (m.id ? str(m.name) : '') || undefined, context: ctxOf(m) }))
      .filter((m) => m.id);
    if (!out.length) throw new Error(`${url}: no models`);
    return out;
  } catch (e) { throw new Error(ac.signal.aborted ? `${url}: timed out` : (e as Error).message); }
  finally { clearTimeout(t); }
}
