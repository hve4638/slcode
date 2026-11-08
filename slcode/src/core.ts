// core — 세션 하나를 쥔 프로세스 (ticket slcode-core-serve-split, 설계 ws docs/report/slcode-core-serve-split.md, 사용자 확정 2026-10-15).
// serve 가 detached 로 띄운다 (coreMain.ts). 세션(벤더 SDK)·이벤트 로그·세션 소켓·받은 메시지·입력 초안·웹 토큰 검사를 여기서 맡고,
// Methods 는 sessions/<슬러그>/<id>/sock UDS 하나로만 낸다 (소켓 0600 이 곧 인증). 웹·stdio·서비스 웹은 serve 가 연결마다 이 소켓에 하나씩 붙어 중계한다.
// 받은 메시지(session.deliver)는 메모리에 두었다가 다음 idle 에 한 턴으로 넣는다 (여러 통이면 한 번에, mail.ts 머리표).
// 보관함은 없다 — 꺼진 세션에는 보내지 않는다 (ticket slcode-p2p-messaging, 사용자 2026-10-19).
// 수명: session.close·벤더 종료 → 세션을 닫고 소켓을 지우고 끝난다. 소유자(core.own 을 보낸 연결 하나)가 close 없이 끊기면
// OWNER_GRACE 동안 새 소유자를 기다리고 없으면 닫는다 (기동 직후도 같다). 로그는 남아 --resume 으로 이어간다.
// 교체 (3단계): 새 코드의 serve 가 core.retire {pkg} 를 보내면 idle 을 기다렸다가 그 설치 폴더의 coreMain 으로 새 core 를 띄우고, core.replaced 를 알린 뒤 내려간다.
// 상태는 넘기지 않는다 — idle 이면 세션 내용은 디스크에 있고, 메모리에만 있는 입력 초안은 세션 폴더의 draft 파일로 넘긴다.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { ClaudeSession } from './session.js';
import { CodexSession, codexRunnable } from './codex.js';
import { PARAM_ENV, sessionEnvError, sessionParamsError, type AgentSession, type Command } from './base.js';
import { EventLog, historyPage, outline, promptTurns, summarize, type SessionMeta, type SessionParent } from './eventLog.js';
import { isLoopback, reachable, sockAlive, spawnCore } from './live.js';
import { BUILD, PKG, VERSION, replacing, replacingMark } from './client.js';
import { corePaths, ensureDir, readOrCreateToken, sessionDir } from './paths.js';
import { formatMail, newMail, parseMails, sendMail, sessionMeta } from './mail.js';
import { ANSWERED, Children, teamOf, teamOptionsError } from './children.js';
import { familyPrompt } from './prompt.js';
import { TEAM_TOOL_NAMES, teamMcp } from './teamTools.js';
import { blockInspect, CODEX_ROUTE, codexArgs, codexUpstream, inspectBlocked, inspectEnv, keepsFirstParty, sdkVersion, startInspect, turnCalls, upstreamOf, type InspectProxy } from './inspect.js';
import { InspectStore, maybeSweep } from './inspectDb.js';
import { Activity } from './activity.js';
import { claudeLoad, DEFAULT_PROFILE, getProfile, listProfiles, profileSummary, sessionProfile } from './profiles.js';
import { claudeSessionExists } from './vendor.js';
import { agentPaths, currentBuilds, loadSessionPlugins, reloadSessionPlugins, unlinkSessionPlugins, type Loaded, type SessionPlugins } from 'slcode-plugin/agentPlugins';
import { HookRunner, type LoadedCommand } from 'slcode-plugin/hookRunner';
import { commandTable, completeInput, fullName, resolveCommand } from './pluginCommands.js';
import { CoreError, ERR, FILES, PERMISSION_MODES, PROTOCOL_VERSION, TEAM_TEMPLATES, type AgentCommandEvent, type AgentHookEvent, type ApprovalRequest, type Attachment, type LoggedEvent, type Mail, type QueueItem, type MethodName, type TeamOptions, type Methods, type RequestFrame, type SessionInfo } from './protocol.js';

/** 벤더 자식(claude CLI·codex)에 넘기지 않을 env — 워커 Claude 세션 안에서 띄우면 그 세션의 표식(CLAUDECODE·CLAUDE_CODE_SESSION_ID·
 *  CLAUDE_CODE_CHILD_SESSION·CLAUDE_CODE_ENTRYPOINT·CLAUDE_CODE_MESSAGING_* 등, claude 2.1.282·2.1.300 실측)이 딸려 가 자식이 남의 세션 안이라 여긴다.
 *  사용자 설정은 남긴다 — CLAUDE_CONFIG_DIR 을 지우면 자식이 ~/.claude 를 봐 import·resume 이 "No conversation found" 로 끝났다.
 *  gitignore 꼴: `*` 는 아무 글자, `!` 는 빼지 않는다, 마지막으로 맞은 줄이 정한다. 표식엔 규칙이 없고 버전마다 바뀌어 이 목록만 고친다 (사용자 2026-10-15) */
export const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_*', '!CLAUDE_CONFIG_DIR'];

export function stripEnv(env: NodeJS.ProcessEnv, rules: string[] = STRIP_ENV): NodeJS.ProcessEnv {
  const pats = rules.map((r) => ({ keep: r.startsWith('!'), re: new RegExp(`^${r.replace(/^!/, '').replaceAll('*', '.*')}$`) }));
  return Object.fromEntries(Object.entries(env).filter(([k]) => {
    let strip = false;
    for (const p of pats) if (p.re.test(k)) strip = !p.keep;
    return !strip;
  }));
}
const SDK_ENV = stripEnv(process.env);
/** 세션 안의 `slcode` 가 이 core 를 띄운 판이 되게 — 벤더 env 의 PATH 맨 앞에 설치 폴더의 bin/ (ticket slcode-session-bin-path, 사용자 2026-10-24).
 *  플러그인은 ~/.local/bin 같은 일반 PATH 위치에 런처를 두지 않는다. 런처(bin/slcode, Windows 는 bin/slcode.cmd)가 없으면(소스 체크아웃의 dist) 그대로.
 *  Windows env 의 PATH 이름은 Path 처럼 대소문자가 섞여 온다 — 있는 이름에 넣는다 */
export function withBinPath(env: NodeJS.ProcessEnv, pkg: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const win = platform === 'win32';
  const bin = path.join(pkg, 'bin');
  if (!fs.existsSync(path.join(bin, win ? 'slcode.cmd' : 'slcode'))) return env;
  const key = (win && Object.keys(env).find((k) => k.toUpperCase() === 'PATH')) || 'PATH';
  return { ...env, [key]: env[key] ? `${bin}${win ? ';' : ':'}${env[key]}` : bin };
}
/** codex 명령의 PATH 를 이 env 의 PATH 로 고정하는 app-server 인자 (ticket slcode-session-path-rc-override, 사용자 2026-10-31).
 *  codex 의 셸 스냅숏은 rc 를 읽은 뒤의 PATH 를 저장해 명령마다 쓴다 — rc 가 ~/.local/bin 을 앞에 붙이면 옛 slcode 로 간다(0.165 실측).
 *  policy 의 set 은 스냅숏 뒤에 다시 export 된다. Claude Code 의 Bash 도구도 띄울 때 PATH 로 되돌리므로 같은 규칙 */
export function codexPathArgs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const key = (platform === 'win32' && Object.keys(env).find((k) => k.toUpperCase() === 'PATH')) || 'PATH';
  return env[key] ? ['-c', `shell_environment_policy.set.${key}=${JSON.stringify(env[key])}`] : [];
}
/** 소유자가 close 없이 끊긴 뒤(SIGKILL·크래시) 새 소유자를 기다리는 시간 — 카드 핸드오프·serve 재기동의 틈. 빈 값·숫자 아님은 기본값 */
const OWNER_GRACE_MS = (Number(process.env.SLCODE_OWNER_GRACE_SECS) > 0 ? Number(process.env.SLCODE_OWNER_GRACE_SECS) : 10) * 1000;
/** 벤더 종료를 기다리는 상한 — core 는 detached 라 superlite 의 SIGKILL(서비스 중지 3초 뒤)이 닿지 않는다. 넘으면 정리하고 끝낸다 */
const CLOSE_DEADLINE_MS = 5000;
/** 교체 중 표시의 기한 — 그동안 붙으려는 쪽(CLI·serve)이 새 core 를 기다린다. 벤더 종료(CLOSE_DEADLINE_MS)와 새 core 기동이 이 안에 든다 */
const REPLACE_MS = 30000;
/** 교체 때 입력 초안을 넘기는 세션 폴더의 파일 — 새 core 가 읽고 지운다 */
const DRAFT_FILE = 'draft';

/** serve 가 core 에 넘기는 것 — 세션을 고르고 띄우는 데 필요한 최소한 (어느 세션을 이을지는 CLI·serve 가 이미 골랐다) */
export type CoreOptions = {
  dir?: string;
  cwd: string;
  /** 새 세션의 부모 (SessionMeta.parent) */
  parent?: SessionParent;
  /** 이어받을 세션 id (저장 세션). 없으면 새 세션 */
  resume?: string;
  title?: string;
  raw?: boolean;
  permissionMode?: string;
  /** 새 세션의 모델 — meta.model 로 남겨 벤더가 기동 때 읽는다. 없으면 벤더 기본. 이어받는 세션은 meta 를 따른다 */
  model?: string;
  /** 새 세션의 effort — meta.effort 로 남겨 벤더가 기동 때 읽는다. 모델에 없는 값이면 어댑터가 알리고 벤더 기본으로 (effortMisfit) */
  effort?: string;
  /** 새 세션의 첫 프롬프트 — 세션을 만들자마자 넣는다. 벤더 준비 전이라도 첫 턴으로 돈다 (ticket slcode-new-effort-prompt) */
  prompt?: string;
  /** 새 세션의 벤더 — 기본 claude. 이어받는 세션은 meta.vendor 를 따른다 */
  vendor?: 'claude' | 'codex';
  /** 새 세션의 시작 프로필 이름 (ticket slcode-session-profile) — meta.profile 로 남긴다. 없으면 default. 이어받는 세션은 meta 를 따른다 */
  profile?: string;
  /** 시작 화면에서 연 새 세션 — meta.fromStart 로 남긴다 */
  fromStart?: boolean;
  /** 새 세션의 env (ticket slcode-new-session-env) — meta.env 로 남겨 띄울 때마다 벤더 env 에 넣는다. 이어받는 세션에 주면 bad_request */
  env?: Record<string, string>;
  /** 새 세션의 세션 인자 (ticket slcode-agent-plugin-part-when) — meta.params 로 남겨 띄울 때마다 SLCODE_PARAM_<이름> env·에이전트 플러그인 part 조건·js/ts 훅에 준다. 이어받는 세션에 주면 bad_request */
  params?: Record<string, string>;
  /** 새 세션을 inspect 로 — 입구 설정(Settings.inspect)을 CLI 가 읽어 넘긴다. 이어받는 세션은 meta.inspect 를 따르고, false 면 끈다 (--no-inspect) */
  inspect?: boolean;
  /** 새 세션이 팀원을 만들지 못한다 — 입구 설정(Settings.team)이 꺼졌을 때 CLI 가 넘긴다. meta.noTeam 으로 남긴다 (ticket slcode-team-agent) */
  noTeam?: boolean;
  /** 리더가 띄우는 팀원의 관여 옵션 (Children.spawn) — meta.team 으로 남기고, noTeam 이면 meta.noTeam 도 */
  team?: TeamOptions;
  log?: (msg: string) => void;
};

export type CoreHandle = { sock: string; session: SessionInfo; close: (reason?: string) => Promise<void>; done: Promise<void> };

/** 없는 폴더로는 벤더가 뜨지 못한다 — core 가 뜬 뒤 죽기 전에 사유를 알려 거절한다 (ticket slcode-small-fixes-1025) */
const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

export async function runCore(opts: CoreOptions): Promise<CoreHandle> {
  const log = opts.log ?? (() => {});
  const P = corePaths(opts.dir);
  ensureDir(P.sessionsDir);
  const migrated = EventLog.migrate(P.sessionsDir);
  if (migrated) log(`moved ${migrated} session(s) under cwd folders`);

  // ---- 세션 로그: 새로 / --resume
  const isMode = (m: unknown) => (PERMISSION_MODES as readonly unknown[]).includes(m);
  if (opts.permissionMode !== undefined && !isMode(opts.permissionMode)) throw new CoreError(ERR.badRequest, `mode ${PERMISSION_MODES.join('|')}`);
  let logFile: EventLog;
  if (opts.resume) {
    if (opts.env && Object.keys(opts.env).length) throw new CoreError(ERR.badRequest, 'env is only for a new session — a resumed session keeps its own env');
    if (opts.params && Object.keys(opts.params).length) throw new CoreError(ERR.badRequest, 'params are only for a new session — a resumed session keeps its own params');
    const found = EventLog.open(P.sessionsDir, opts.resume);
    if (!found) throw new CoreError(ERR.noSession, `no session ${opts.resume}`);
    if (await sockAlive(found.sockPath)) throw new CoreError(ERR.badRequest, `session ${opts.resume} is live — another slcode is serving it`);
    if (!isDir(found.meta.cwd)) throw new CoreError(ERR.badRequest, `session folder is gone: ${found.meta.cwd}`);
    if (opts.title !== undefined) found.updateMeta({ title: opts.title });
    // --no-inspect 는 켜져 있던 세션만 끈다 — 켠 적 없는 세션엔 값을 남기지 않는다 (inspect 버튼은 켠 적 있는 세션에만 보인다)
    if (opts.inspect === false && found.meta.inspect) found.updateMeta({ inspect: false });
    // 메뉴에서 뺀 옛 모드(acceptEdits·plan)는 auto 로 고쳐 쓴다 — core 교체도 이 길이라 업데이트 뒤 첫 기동에서 바뀐다 (ticket slcode-permission-modes-three)
    if (found.meta.permissionMode && !isMode(found.meta.permissionMode)) found.updateMeta({ permissionMode: 'auto' });
    logFile = found;
  } else {
    if (!isDir(opts.cwd)) throw new CoreError(ERR.badRequest, `not a folder: ${opts.cwd}`);
    if (opts.profile !== undefined && !getProfile(opts.profile, P.dir)) throw new CoreError(ERR.badRequest, `no profile ${opts.profile} (slcode profile list)`);
    for (const k of Object.keys(opts.env ?? {})) { const why = sessionEnvError(k); if (why) throw new CoreError(ERR.badRequest, why); }
    { const why = sessionParamsError(opts.params ?? {}); if (why) throw new CoreError(ERR.badRequest, why); }
    const meta: SessionMeta = {
      id: randomUUID().slice(0, 8), vendor: opts.vendor ?? 'claude', cwd: opts.cwd, title: opts.title ?? null,
      vendorSessionId: null, createdAt: Date.now(), permissionMode: opts.permissionMode ?? 'auto', raw: opts.raw ?? false,
      ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}), ...(opts.inspect ? { inspect: true } : {}),
      ...(opts.profile && opts.profile !== DEFAULT_PROFILE ? { profile: opts.profile } : {}), ...(opts.fromStart ? { fromStart: true } : {}),
      ...(opts.env && Object.keys(opts.env).length ? { env: opts.env } : {}),
      ...(opts.params && Object.keys(opts.params).length ? { params: opts.params } : {}),
      ...(opts.parent ? { parent: opts.parent } : {}),
      ...(opts.team ? { team: opts.team } : {}), ...(opts.noTeam || opts.team?.noTeam ? { noTeam: true } : {}),
    };
    // 새 세션의 권한 모드는 생략하면 auto (사용자 2026-10-24) — 이미 있는 세션의 null(벤더 기본 = 승인 요청)은 건드리지 않는다
    logFile = EventLog.create(P.sessionsDir, meta);
  }
  const cwd = logFile.meta.cwd;
  // 벤더 자식(과 그 Bash 도구가 띄우는 명령)이 자기 세션을 알게 — 세션 안의 `slcode mail/check/ask/reply` 가 이걸 읽는다 (사용자 확정 2026-10-02).
  // 그 `slcode` 는 이 판이다 (withBinPath). 세션 env(meta.env, ticket slcode-new-session-env)는 셸에서 물려받은 값 위·SLCODE_SESSION_ID 아래 —
  // 벤더를 다시 띄우는 길(rewind·reopen·교체)과 Codex env 가 모두 이 값에서 시작한다. 에이전트 플러그인 manifest env 는 그 위에 얹힌다
  // 세션 인자(meta.params, ticket slcode-agent-plugin-part-when)는 SLCODE_PARAM_<이름> 으로 — 물려받은 SLCODE_PARAM_* 는 지운다. leader 세션 안에서 친 slcode new 의
  // core 는 leader 의 env 를 물려받으므로, 지우지 않으면 worker 의 훅이 leader 의 값을 읽는다 (사용자 2026-11-02)
  const params = logFile.meta.params ?? {};
  // 팀원 세션 (ticket slcode-team-agent, 사용자 결정 2026-11-07~08) — 리더 core 가 띄운 팀원은 meta.team 에 관여 옵션, link 팀원은 meta.parent {kind: child}.
  // 옵션은 끊기(session.unlock)로 바뀌므로 쓸 때마다 meta 에서 읽는다 (team()). 팀원을 만들 수 있는지는 meta.noTeam — 설정의 "새 세션 팀원" 이나 noTeam 팀원.
  // link 팀원의 벤더 env 에는 SLCODE_PARENT_ID(`slcode mail leader`) — 물려받은 값은 지운다
  const team = () => teamOf(logFile.meta);
  const parentId = team()?.link && logFile.meta.parent?.kind === 'child' ? logFile.meta.parent.id : null;
  const canTeam = !logFile.meta.noTeam;
  const shell = Object.fromEntries(Object.entries(SDK_ENV).filter(([k]) => !k.toUpperCase().startsWith(PARAM_ENV) && k !== 'SLCODE_PARENT_ID'));
  const env: NodeJS.ProcessEnv = withBinPath({ ...shell, ...logFile.meta.env, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [PARAM_ENV + k, v])), SLCODE_SESSION_ID: logFile.meta.id, ...(parentId ? { SLCODE_PARENT_ID: parentId } : {}) }, PKG);
  // inspect (ticket slcode-inspect-proxy·slcode-inspect-default-on) — 켜져 있으면 벤더를 띄우기 전에 proxy 를 세우고 벤더 env 의 ANTHROPIC_BASE_URL 을 그리로.
  // 기록은 세션 폴더 inspect/inspect.db. proxy 를 띄운 core 는 3일마다 상태 폴더의 꺼진 세션 raw 를 정리한다 (기록이 늘어나는 것은 proxy 가 떠 있을 때뿐)
  const inspectDir = path.join(logFile.dir, 'inspect');
  const blockedFile = path.join(P.dir, FILES.inspectBlocked);
  let inspect: InspectProxy | null = null;
  let store: InspectStore | null = null;
  let sweeper: NodeJS.Timeout | null = null;
  let switching = false; // session.setInspect 가 벤더를 다시 띄우는 중 — 겹친 토글은 거절한다
  const sweep = () => void maybeSweep(path.join(P.dir, FILES.inspectSweep), path.join(P.dir, FILES.inspectSweepLock), P.sessionsDir, { log })
    .catch((e) => log(`inspect sweep failed: ${(e as Error).message}`));
  // codex (ticket slcode-inspect-codex) — proxy 주소는 app-server 인자(-c openai_base_url)로. 사용자가 정한 openai_base_url 은 app-server 가 뜬 뒤
  // config/read 로 알게 되므로(onConfig) 그 전에 proxy 에 온 요청은 기다렸다가 넘긴다
  const codex = logFile.meta.vendor === 'codex';
  let gotBase: (base: string | null) => void = () => {};
  const userBase = new Promise<string | null>((r) => (gotBase = r));
  let watching = false; // codex 감시 — proxy 를 세웠고 아직 성공한 턴이 없다
  const startProxy = async () => {
    const blocked = codex ? null : inspectBlocked(blockedFile);
    if (blocked) throw new Error(`inspect is blocked for this Claude Code (Agent SDK ${blocked}): it does not treat the proxy as first party, so prompt caching and other features would be lost`);
    store ??= InspectStore.open(inspectDir);
    if (!inspect) {
      inspect = codex
        ? await startInspect(store, async (req) => codexUpstream(await userBase, req.headers), { prefix: CODEX_ROUTE, log })
        : await startInspect(store, upstreamOf(env), { watch: keepsFirstParty(env), onLost: firstPartyLost, log });
      watching = codex;
    }
    if (!sweeper) { sweep(); sweeper = setInterval(sweep, 3600_000); sweeper.unref(); }
    return inspect;
  };
  const vendorEnv = async () => {
    if (!logFile.meta.inspect || codex) return env;
    return inspectEnv(env, (await startProxy()).url);
  };
  // codex — 에이전트 플러그인의 MCP(-c mcp_servers…)는 inspect 를 바꿔 다시 띄울 때도 함께 (agent 는 아래에서 채운다)
  // codex 명령의 PATH 는 띄운 PATH 로 고정 (codexPathArgs) — inspect 를 바꿔 다시 띄울 때도
  const codexBaseArgs = () => [...(agent?.codex.args ?? []), ...codexPathArgs(codexEnv())];
  const vendorArgs = async () => [...(codex ? codexBaseArgs() : []), ...(logFile.meta.inspect && codex ? codexArgs((await startProxy()).url) : [])];
  /** 지난 기록을 읽는 DB — 켠 적 없는 세션엔 만들지 않는다 */
  const readStore = () => {
    if (!store && InspectStore.exists(inspectDir)) {
      try { store = InspectStore.open(inspectDir); } catch (e) { throw new CoreError(ERR.badRequest, (e as Error).message); }
    }
    return store;
  };
  // 에이전트 플러그인 (ticket slcode-agent-plugin, Codex 는 slcode-agent-plugin-codex) — 기동 때의 설정(기본 설정 < 세션 값)으로 그 하네스의 빌드를 만들어 세션 폴더에 링크를 건다.
  // 싣지 못해도 세션은 뜬다 — 사유는 세션이 생긴 뒤 기록에 남긴다
  const harness = codex ? 'codex' : 'claude';
  // 시작 프로필 (ticket slcode-session-profile) — meta 의 이름으로 띄울 때마다 지금 값을 읽는다. 지운 프로필이면 default.
  // 실을 플러그인과 그 값(기본 설정 < 프로필 < 세션)은 두 하네스 모두, Claude 쪽 로드 설정(사용자·프로젝트 설정·CLAUDE.md·내장 skill)은 Claude 만
  const prof = sessionProfile(logFile.meta.profile, P.dir);
  /** 다시 싣기 때의 프로필 — 그사이 고쳤으면 고친 값, 지웠으면 기동 때 값 */
  const profileNow = () => getProfile(prof.name, P.dir) ?? prof.profile;
  let agent: SessionPlugins | null = null, agentFailed: string | null = null;
  // 링크는 옛 폴더의 세션이어도 이 상태 폴더 쪽에 둔다 — 빌드 정리(gcBuilds)가 상태 폴더의 sessions 만 훑어, 옛 폴더의 링크로는 쓰는 빌드를 지키지 못한다 (옛 폴더 호환, 1.0.0 에서 지운다: ticket slcode-remove-legacy-state-dir)
  const linksDir = sessionDir(P.sessionsDir, cwd, logFile.meta.id);
  try { agent = loadSessionPlugins(linksDir, env, logFile.meta.agentPlugins ?? {}, P.dir, harness, prof.profile, params); } catch (e) { agentFailed = (e as Error).message; }
  const load = codex ? undefined : claudeLoad(prof.profile.claude, cwd, env, (agent?.loaded ?? []).map((l, i) => ({ name: l.name, path: agent!.plugins[i].path })));
  let agentLoaded: Loaded[] = agent?.loaded ?? [];
  // js/ts 훅 (ticket slcode-agent-plugin-hooks) — Claude 만. 플러그인을 하나라도 실었으면 디스패처를 건다(다시 싣기로 훅이 생겨도 받게). 세션이 생기기 전의 기록은 모았다가 낸다
  let hookQueue: (AgentHookEvent | AgentCommandEvent)[] | null = [];
  const hooks = !codex && agentLoaded.length
    ? new HookRunner({ sessionDir: logFile.dir, buildDir: agentPaths(P.dir).build, sessionId: logFile.meta.id, params, emit: (ev) => { if (hookQueue) hookQueue.push(ev); else (session as ClaudeSession).emitHook(ev); } })
    : null;
  hooks?.load(agentLoaded);
  // 기록된 Claude 대화가 없으면 resume 하지 않고 새 대화로 (ticket slcode-resume-empty-claude, 사용자 결정 2026-11-08) — 0.5.8 까지는 첫 프롬프트 전의 id 를 남겼고(빈 세션),
  // claude 가 오래된 기록을 지우기도 한다. --resume 하면 "No conversation found" 로 세션이 닫힌다. 지난 턴이 있던 세션이면 세션이 생긴 뒤 알린다
  let lostVendor: string | null = null;
  if (!codex && logFile.meta.vendorSessionId && !claudeSessionExists(logFile.meta.vendorSessionId, { ...env, ...agent?.env, ...load?.env })) {
    if (logFile.since(0).some((e) => e.ev.kind === 'turn.end')) lostVendor = logFile.meta.vendorSessionId;
    logFile.updateMeta({ vendorSessionId: null });
  }
  // 세션을 열 때(core 기동마다) SessionStart 를 돌린다 — message 는 바로 화면에, context 는 첫 프롬프트에 (ticket slcode-session-open-notice, 사용자 2026-11-01)
  const openSource = logFile.meta.vendorSessionId ? 'resume' : 'startup';
  hooks?.openSession(openSource, { cwd, permissionMode: opts.permissionMode ?? logFile.meta.permissionMode ?? null, vendorSessionId: logFile.meta.vendorSessionId ?? null });
  // codex 는 프로세스 env 로 — manifest env 와 PATH 앞의 플러그인 bin/ (Claude 는 ClaudeSession 이 agent.env 를 얹는다)
  const codexEnv = (): NodeJS.ProcessEnv => {
    if (!agent) return env;
    const key = (process.platform === 'win32' && Object.keys(env).find((k) => k.toUpperCase() === 'PATH')) || 'PATH';
    return { ...env, ...agent.env, ...(agent.codex.bin.length ? { [key]: [...agent.codex.bin, ...(env[key] ? [env[key]] : [])].join(path.delimiter) } : {}) };
  };
  // 첫 기동에서 못 켜면(이 SDK 에서 막힘·node:sqlite 없음) 끄고 띄운다 — 사유는 세션이 생긴 뒤 기록에 남긴다
  let firstEnv = env, firstArgs: string[] = [], inspectFailed: string | null = null;
  try { firstEnv = await vendorEnv(); firstArgs = await vendorArgs(); } catch (e) { logFile.updateMeta({ inspect: false }); inspectFailed = (e as Error).message; }
  if (inspectFailed && codex) firstArgs = codexBaseArgs();
  const session: AgentSession = codex
    ? new CodexSession({ log: logFile, env: codexEnv(), permissionMode: opts.permissionMode ?? logFile.meta.permissionMode, raw: opts.raw, args: firstArgs, onConfig: (base) => gotBase(base), skillRoots: agent?.codex.roots ?? [], instructions: agent?.append ?? '', family: familyPrompt({ team: canTeam, leader: parentId, options: team(), tools: false }) })
    : new ClaudeSession({
      log: logFile, env: firstEnv, resume: logFile.meta.vendorSessionId, permissionMode: opts.permissionMode ?? logFile.meta.permissionMode, raw: opts.raw, ...(agent ? { agent } : {}), ...(load ? { load } : {}), ...(hooks ? { hooks: hooks.sdkHooks() } : {}),
      family: familyPrompt({ team: canTeam, leader: parentId, options: team(), tools: canTeam }),
      // 팀원 도구(Subagent·ContinueSubagent)는 팀원을 만들 수 있는 Claude 세션에만 — 도구는 이 판의 CLI 를 부른다. Agent 도구처럼 승인을 묻지 않는다 (사용자 2026-11-08)
      ...(canTeam ? { mcpServers: () => ({ slcode: teamMcp({ cli: path.join(PKG, 'dist', 'cli.js'), env, cwd }) }), allowedTools: [...TEAM_TOOL_NAMES] } : {}),
      ...(parentId && team()?.endWithAnswer ? { noAsk: true } : {}),
    });
  // 연 표지를 열 때의 훅 기록보다 먼저 — 화면은 이것을 만나면 마지막 턴 뒤의 앞선 열 때 알림(바꾸기 전 프로필·벤더의 것 등)을 지운다
  session.opened(openSource);
  for (const ev of hookQueue ?? []) (session as ClaudeSession).emitHook(ev);
  hookQueue = null;
  const sid = session.id;
  // 활동 기록 (ticket slcode-activity-state) — 첫 프롬프트가 상태를 바꾸기 전에 구독한다
  const activity = Activity.open(logFile.dir);
  activity.agent(session.state);
  session.onEvent((e) => { if (e.ev.kind === 'session.state') activity.agent(e.ev.state); });
  if (lostVendor) session.notice(`이전 Claude 대화(${lostVendor})를 찾지 못해 새 대화로 시작합니다 — 위의 지난 턴은 모델이 기억하지 못합니다`);
  if (inspectFailed) session.notice(`inspect 를 켜지 않았습니다: ${inspectFailed}`);
  if (prof.missing) session.notice(`프로필 ${prof.missing} 이 없어 default 로 띄웠습니다`);
  if (codex && prof.name !== DEFAULT_PROFILE) session.notice(`Codex 세션은 프로필(${prof.name})의 플러그인 선택만 따릅니다 — 사용자 설정·AGENTS.md·skill 은 그대로 실립니다`);
  if (agentFailed) session.notice(`에이전트 플러그인을 싣지 못했습니다: ${agentFailed}`);
  for (const n of agent?.notes ?? []) session.notice(`에이전트 플러그인을 싣지 못했습니다 — ${n}`);
  // 에이전트 플러그인 명령 (ticket slcode-agent-plugin-command) — Claude 세션만(hooks). 벤더 명령 목록은 session.commands 때 새로 받고, 그 사이는 지난 것을 쓴다.
  // Claude 내장 명령과 겹치는 명령은 쓸 수 없다 — 열 때(와 다시 싣기 뒤) 한 번씩 알린다
  let vendorCmds: Promise<Command[]> | null = null;
  const vendorCommands = () => (vendorCmds ??= session.commands());
  const told = new Set<string>();
  const commandsNow = async () => {
    const vendor = await vendorCommands();
    const t = commandTable(hooks?.commands() ?? [], vendor);
    for (const b of t.blocked) { const k = `${fullName(b.cmd)} ${b.why}`; if (!told.has(k)) { told.add(k); session.notice(`에이전트 플러그인 명령 /${b.cmd.name} (${b.cmd.plugin}) 을 쓸 수 없습니다: ${b.why}`); } }
    return { usable: t.usable, vendor };
  };
  if (hooks?.commands().length) void commandsNow().catch(() => {});
  if (!opts.resume && opts.prompt?.trim()) session.send(opts.prompt);
  // codex 감시 (사용자 결정 2026-10-19) — proxy 를 세운 뒤 처음 성공한 턴까지 모델 호출(/responses)이 하나도 기록되지 않았으면 codex 가 proxy 를 거치지 않는다
  // (openai 가 아닌 model_provider·workspace routing 등). 알리고 이 세션만 끈다 — 새 세션은 막지 않는다
  if (codex) session.onEvent((e) => {
    if (e.ev.kind !== 'turn.end' || !e.ev.ok || !watching) return;
    watching = false;
    if (!logFile.meta.inspect || !inspect || [...inspect.seen].some((p) => p.endsWith('/responses'))) return;
    inspectOff('inspect 를 끕니다: 이 Codex 세션의 모델 호출이 proxy 를 거치지 않아 기록되지 않았습니다 (openai 가 아닌 model_provider 를 쓰는 설정 등). 지금 턴이 끝나면 proxy 없이 다시 띄웁니다.');
  });

  /** 켤 때는 proxy 를 먼저 세우고, 끌 때는 옛 벤더가 내려간 뒤에 닫는다. 실패하면 meta 와 새 proxy 를 되돌린다 */
  async function setInspect(on: boolean) {
    const s = session as ClaudeSession | CodexSession;
    if (on === !!logFile.meta.inspect) return;
    if (s.state !== 'idle' && s.state !== 'starting') throw new CoreError(ERR.badRequest, 'inspect can be switched only while idle');
    if (switching) throw new CoreError(ERR.badRequest, 'inspect is already being switched');
    switching = true;
    logFile.updateMeta({ inspect: on });
    try { if (s instanceof CodexSession) await s.reopen(await vendorArgs()); else await s.reopen(await vendorEnv()); }
    catch (e) { logFile.updateMeta({ inspect: !on }); if (on) { await inspect?.close(); inspect = null; } throw new CoreError(ERR.badRequest, (e as Error).message); }
    finally { switching = false; }
    if (!on) { await inspect?.close(); inspect = null; if (sweeper) { clearInterval(sweeper); sweeper = null; } }
    broadcast('session.changed', s.info());
  }
  /** 1st party 감시 (사용자 결정 2026-10-19) — 내부 플래그가 듣지 않는다. 이 SDK 버전을 기록해 새 세션은 inspect 없이 시작하게 하고,
   *  이 세션은 지금 턴이 끝나 idle 이 되면 proxy 없이 다시 띄운다 */
  function firstPartyLost() {
    blockInspect(blockedFile);
    inspectOff(`inspect 를 끕니다: 이 Claude Code(Agent SDK ${sdkVersion()})는 proxy 주소를 1st party 로 보지 않아 프롬프트 캐시 등 일부 기능이 꺼집니다. 지금 턴이 끝나면 proxy 없이 다시 띄우고, 이 버전에서는 새 세션도 inspect 없이 시작합니다.`);
  }
  /** 알리고, 이 세션을 다음 idle 에 proxy 없이 다시 띄운다 */
  function inspectOff(message: string) {
    session.notice(message);
    // 줄 선 턴까지 끝난 idle 에서만 — 실패하면(겹친 토글 등) 다음 idle 에 다시. 구독은 꺼진 뒤에 푼다
    let trying = false;
    const off = () => {
      const s = session as ClaudeSession | CodexSession;
      if (trying || closed || s.state !== 'idle' || switching || s.queued || waiting.length || draining) return;
      if (!logFile.meta.inspect) { stop(); return; } // 그사이 사이드바로 껐다
      trying = true;
      setInspect(false).then(() => stop(), (e) => { trying = false; log(`inspect off failed, retrying at the next idle: ${(e as Error).message}`); });
    };
    const stop = session.onEvent(off);
    off();
  }

  // ---- 디스패치 (UDS 연결마다 — CLI 동사, serve 의 중계 연결과 제어 연결)
  type Web = { host: string; port: number; url: string; version: string };
  /** parent — link 팀원의 리더 core 가 core.own {parent} 으로 붙은 소유 연결 */
  type Conn = { detach: (() => void) | null; send: (o: unknown) => void; ownerPid: number | null; web: Web | null; follows: boolean; parent: boolean };
  const conns = new Set<Conn>();
  let owner: Conn | null = null;
  let closed = false;
  // 웹 입력창 초안 (session.setDraft) — 메모리만. 교체로 뜬 core 면 옛 core 가 남긴 파일을 읽고 지운다
  const draftFile = path.join(logFile.dir, DRAFT_FILE);
  let draft = '';
  try { draft = fs.readFileSync(draftFile, 'utf8'); fs.unlinkSync(draftFile); } catch {}
  const mine = (id: unknown) => { if (id !== sid) throw new CoreError(ERR.badRequest, `this process serves session ${sid} only`); return session; };
  const webs = () => [...conns].flatMap((c) => (c.web ? [c.web] : []));
  type Handler<K extends MethodName> = (conn: Conn, params: Methods[K]['params']) => Promise<Methods[K]['result']> | Methods[K]['result'];
  /** 첫 메시지 전·쉬는 중에만 바꾸는 것(벤더·시작 프로필) — 바꾸면 core 를 다시 띄우므로 그 교체를 따라올 소유자여야 한다 */
  function beforeFirst(s: AgentSession, what: string) {
    if (s.log.all.some((e) => e.ev.kind === 'turn.start')) throw new CoreError(ERR.badRequest, `the ${what} is fixed after the first message`);
    if (closed || retire || switching || (s.state !== 'idle' && s.state !== 'starting') || s.pendingApprovals().length || pending.length || asks.size || waiting.length || draining) throw new CoreError(ERR.badRequest, `the ${what} can be switched only while the session is idle`);
    if (owner && !owner.follows) throw new CoreError(ERR.badRequest, 'the session owner cannot follow a core replacement (an older slcode started it)');
  }
  const handlers: { [K in MethodName]: Handler<K> } = {
    'core.auth': (_c, p) => {
      // 루프백 밖 웹 — serve 가 remote 를 붙여 넘긴다. 토큰 파일은 core 가 든다
      if (p?.remote && p.token !== readOrCreateToken(P)) throw new CoreError(ERR.unauthorized, 'bad token');
      return { ok: true, pid: process.pid, protocol: PROTOCOL_VERSION, session: sid };
    },
    'core.own': (conn, p) => {
      if (p?.parent && !parentId) throw new CoreError(ERR.badRequest, `session ${sid} is not a linked teammate`);
      if (owner && owner !== conn) {
        // 리더가 소유한 팀원은 다른 연결이 가져가지 못한다(카드 핸드오프는 붙기만 한다), 리더 쪽은 사람이 따로 소유한 팀원을 가져가지 못한다 (ticket slcode-team-agent)
        if (owner.parent && !p?.parent) throw new CoreError(ERR.parentOwned, `session ${sid} is a teammate owned by its leader ${parentId}`);
        if (!owner.parent && p?.parent) throw new CoreError(ERR.owned, `session ${sid} is owned by pid ${owner.ownerPid ?? '?'}, not by its leader`);
        if (!p?.takeover) throw new CoreError(ERR.owned, `session ${sid} is owned by pid ${owner.ownerPid ?? '?'}`);
        owner.send({ event: 'core.owner', params: { pid: p.pid ?? null } });
      }
      owner = conn; conn.ownerPid = p?.pid ?? null; conn.follows = !!p?.follows; conn.parent = !!p?.parent;
      disarmOwnerGrace();
      if (parentId) broadcast('session.changed', session.info()); // 잠김이 바뀌었을 수 있다
      return { ok: true };
    },
    'core.retire': async (conn, p) => {
      if (typeof p?.pkg !== 'string' || !p.pkg) throw new CoreError(ERR.badRequest, 'pkg required');
      if (owner && !owner.follows) throw new CoreError(ERR.badRequest, 'the session owner cannot follow a core replacement (an older slcode started it)');
      // 새 빌드가 깨졌으면 교체하지 않고 이 core 가 계속 일한다 (사용자 결정 2026-10-19) — 내린 뒤에는 되돌릴 core 가 없다
      await new Promise<void>((resolve, reject) => execFile(process.execPath, [path.join(p.pkg, 'dist', 'cli.js'), '--version', '--json'], { timeout: 15000 }, (e, out) => {
        if (e) { reject(new CoreError(ERR.badRequest, `the new build does not run: ${e.message.split('\n')[0]}`)); return; }
        try { JSON.parse(out); resolve(); } catch { reject(new CoreError(ERR.badRequest, 'the new build does not run: bad --version output')); }
      }));
      retire = { conn, pkg: p.pkg };
      log(`replacement requested (${p.pkg}) — waiting for idle`);
      setImmediate(maybeRetire); // 응답이 먼저 나가게
      return { ok: true };
    },
    'serve.register': (conn, p) => {
      if (typeof p?.host !== 'string' || typeof p.port !== 'number') throw new CoreError(ERR.badRequest, 'host and port required');
      const url = reachable(`http://${p.host}:${p.port}/${isLoopback(p.host) ? '' : `?token=${readOrCreateToken(P)}`}`);
      conn.web = { host: p.host, port: p.port, url, version: String(p.version ?? '') };
      return { url };
    },
    'server.info': () => {
      const w = webs()[0];
      return { session: sid, cwd, host: w?.host ?? null, port: w?.port ?? null, url: w?.url ?? null, version: VERSION, build: BUILD, owner: owner?.ownerPid ?? null, serves: webs() };
    },
    'session.attach': (conn, p) => {
      const s = mine(p?.id);
      conn.detach?.();
      // limit 이면 끝 한 페이지와 합계 (ticket slcode-history-paging)·요청 목록 (ticket slcode-prompt-outline) — 구독과 같은 틱이라 페이지와 실시간 사이에 빠지는 이벤트가 없다
      const page = p.limit ? { ...historyPage(s.log.all, Infinity, Number(p.limit)), summary: summarize(s.log.all), prompts: outline(s.log.all) } : { history: s.since(Number(p.since ?? 0)) };
      conn.detach = s.onEvent((e: LoggedEvent) => conn.send({ event: 'session.event', params: { id: sid, ...e } }));
      return { info: s.info(), ...page, pending: s.pendingApprovals() as ApprovalRequest[], draft, queue: queueItems() };
    },
    'session.history': (_c, p) => {
      if (typeof p?.before !== 'number' || !(p.limit > 0)) throw new CoreError(ERR.badRequest, 'before and limit required');
      return historyPage(mine(p.id).log.all, p.before, p.limit);
    },
    'session.detach': (conn, p) => { mine(p?.id); conn.detach?.(); conn.detach = null; return { ok: true }; },
    'session.send': async (_c, p) => {
      const s = mine(p?.id);
      const att = Array.isArray(p.attachments) ? p.attachments : [];
      // 사람이 친 `/<명령>` 이 플러그인 명령이면 턴 없이 그것만 — 메시지 턴(origin)은 보지 않는다
      if (!p.origin && hooks && typeof p.text === 'string' && p.text.trimStart().startsWith('/') && hooks.commands().length) {
        const { usable, vendor } = await commandsNow();
        const hit = resolveCommand(p.text.trim(), usable, vendor);
        if (hit) {
          if (att.length) throw new CoreError(ERR.badRequest, `에이전트 플러그인 명령 /${hit.cmd.name} 은 첨부와 함께 보낼 수 없습니다`);
          if (waiting.length || draining || !calmForCommand()) {
            waiting.push({ id: randomUUID(), cmd: hit.cmd, args: hit.args });
            queueChanged();
            return { ok: true, state: s.state, command: { plugin: hit.cmd.plugin, name: hit.cmd.name, queued: true as const } };
          }
          draining = true; // 도는 동안 친 것은 그 뒤에 선다
          try {
            const r = await hooks.runCommand(hit.cmd.plugin, hit.cmd.name, hit.args, { cwd });
            return { ok: true, state: s.state, command: { plugin: hit.cmd.plugin, name: hit.cmd.name, ...r } };
          } finally { draining = false; drainWaiting(); }
        }
      }
      if (typeof p.text !== 'string' || (!p.text.trim() && !att.length)) throw new CoreError(ERR.badRequest, 'text or attachments required');
      if (closed) throw new CoreError(ERR.notLive, `session ${sid} is closing`); // 답하고 닫히는 팀원 — 리더 core 가 닫힌 뒤 다시 띄워 다시 보낸다
      for (const a of att) if (typeof a?.name !== 'string' || typeof a.mediaType !== 'string' || typeof a.data !== 'string') throw new CoreError(ERR.badRequest, 'attachment {name, mediaType, data}');
      // 기다리는 명령 뒤에, 턴 중이면 idle 까지 core 가 쥐고 있다가 하나씩 한 턴으로 (ticket slcode-queued-message-bubble, 사용자 결정 2026-11-08)
      const ref = typeof p.ref === 'string' ? p.ref : undefined;
      if (!p.origin && (waiting.length || draining || busy())) { waiting.push({ id: randomUUID(), text: p.text, att, ref }); queueChanged(); activity.sent(); return { ok: true, state: s.state }; }
      nextRef = ref ?? null;
      s.send(p.text, p.origin ?? null, att);
      if (!p.origin) activity.sent(); // 메시지 턴(origin mail 등)은 사람이 보낸 것이 아니다
      return { ok: true, state: s.state };
    },
    'session.models': (_c, p) => mine(p?.id).models(),
    'session.setModel': async (_c, p) => { if (typeof p?.model !== 'string' || !p.model) throw new CoreError(ERR.badRequest, 'model required'); await mine(p.id).setModel(p.model); return { ok: true }; },
    'session.setEffort': async (_c, p) => { if (typeof p?.effort !== 'string' || !p.effort) throw new CoreError(ERR.badRequest, 'effort required'); await mine(p.id).setEffort(p.effort); return { ok: true }; },
    'session.setVendor': async (_c, p) => {
      const s = mine(p?.id);
      if (p.vendor !== 'claude' && p.vendor !== 'codex') throw new CoreError(ERR.badRequest, 'vendor claude|codex');
      if (p.vendor === logFile.meta.vendor) return { ok: true };
      const check = () => beforeFirst(s, 'vendor');
      check();
      // 설치돼 있지 않은 codex 로 바꾸면 새 core 의 벤더 기동이 실패해 세션이 닫힌다 — 띄워 보고 못 뜨면 그대로 둔다
      if (p.vendor === 'codex') { const why = await codexRunnable(env); if (why) throw new CoreError(ERR.badRequest, `codex is not available: ${why}`); }
      check(); // 띄워 보는 사이 턴이 들어왔을 수 있다
      // 벤더 세션·모델·effort 는 옛 벤더의 것이다 — 새 벤더 기본으로 (undefined 는 meta 파일에서 빠진다)
      logFile.updateMeta({ vendor: p.vendor, vendorSessionId: null, model: undefined, effort: undefined });
      log(`vendor switched to ${p.vendor} — replacing this core`);
      void replace(PKG); // retiring 을 바로 세운다. 이 응답은 연결이 끝나기 전에 나간다
      return { ok: true };
    },
    // 시작 프로필 (ticket slcode-session-profile, 사용자 2026-10-30) — 새 세션의 채팅창 가운데에서 첫 메시지 전에 고른다. 바꾸면 meta.profile 을 고치고
    // setVendor 처럼 core 를 다시 띄운다 — 새 core 가 그 프로필로 플러그인·Claude 로드 설정을 다시 짠다. 그 전에 default 로 뜬 것(MCP·SessionStart 훅)은 한 번 돈 뒤다
    'session.profiles': (_c, p) => {
      mine(p?.id);
      return { current: prof.name, profiles: listProfiles(P.dir).map((r) => ({ name: r.name, builtin: r.builtin, summary: profileSummary(r.profile) })) };
    },
    'session.setProfile': async (_c, p) => {
      const s = mine(p?.id);
      if (typeof p.profile !== 'string' || !getProfile(p.profile, P.dir)) throw new CoreError(ERR.badRequest, `no profile ${p?.profile}`);
      if (p.profile === prof.name && !prof.missing) return { ok: true };
      beforeFirst(s, 'profile');
      // 벤더 세션은 옛 프로필의 로드 설정으로 열린 것이다 — 첫 메시지 전이라 버려도 잃는 것이 없다
      logFile.updateMeta({ profile: p.profile === DEFAULT_PROFILE ? undefined : p.profile, vendorSessionId: null });
      log(`profile switched to ${p.profile} — replacing this core`);
      void replace(PKG);
      return { ok: true };
    },
    // 대기 항목은 거둬 입력창으로 (사용자 결정 2026-11-08). 중단으로 idle 이 되면 drainWaiting 이 바로 보내므로 먼저 거둔다
    'session.interrupt': async (_c, p) => {
      const s = mine(p?.id);
      const rest = waiting.splice(0);
      await s.interrupt();
      giveBack(rest);
      return { ok: true };
    },
    'session.unqueue': (_c, p) => {
      mine(p?.id);
      const i = waiting.findIndex((w) => w.id === p.item);
      if (i < 0) throw new CoreError(ERR.badRequest, 'this message is already being processed');
      const { text, att } = waitingInput(waiting.splice(i, 1)[0]);
      queueChanged();
      return { text, attachments: att };
    },
    'session.setMode': async (_c, p) => { const s = mine(p?.id); if (!isMode(p.mode)) throw new CoreError(ERR.badRequest, `mode ${PERMISSION_MODES.join('|')}`); await s.setMode(p.mode); broadcast('session.changed', s.info()); return { ok: true }; },
    'session.commands': async (_c, p) => {
      const s = mine(p?.id);
      vendorCmds = s.commands();
      if (!hooks?.commands().length) return vendorCmds;
      const { usable, vendor } = await commandsNow();
      return [...vendor, ...usable.map((c) => ({ name: fullName(c), description: c.description, argumentHint: c.argumentHint, kind: 'command' as const, complete: c.complete }))];
    },
    'session.completeCommand': async (_c, p) => {
      mine(p?.id);
      if (typeof p?.text !== 'string') throw new CoreError(ERR.badRequest, 'text required');
      const cursor = typeof p.cursor === 'number' ? p.cursor : p.text.length;
      const none = { command: null, hint: '', items: [], start: cursor, end: cursor, error: null };
      if (!hooks?.commands().length) return none;
      const { usable, vendor } = await commandsNow();
      const hit = resolveCommand(p.text, usable, vendor);
      if (!hit || cursor < hit.argsAt) return none;
      const { start, end, ...input } = completeInput(p.text, cursor, hit.argsAt);
      const r = hit.cmd.complete ? await hooks.complete(hit.cmd.plugin, hit.cmd.name, input, { cwd }) : { items: [], error: null };
      return { command: fullName(hit.cmd), hint: hit.cmd.argumentHint, start, end, ...r };
    },
    'session.status': async (_c, p) => {
      const s = mine(p?.id);
      // repo·브랜치는 부를 때마다 git 에 묻는다 — 세션 중에 바뀔 수 있다. git 이 없거나 repo 가 아니면 null, detached 면 브랜치만 null (첫 커밋 전 브랜치도 보인다)
      const git = (args: string[]) => new Promise<string | null>((r) => execFile('git', ['-C', cwd, ...args], { timeout: 2000 }, (e, out) => r(e ? null : out.trim() || null)));
      const [top, branch, limits, context] = await Promise.all([git(['rev-parse', '--show-toplevel']), git(['branch', '--show-current']), s.limits(), s.context()]);
      return { repo: top ? path.basename(top) : null, branch, limits, context };
    },
    'session.mcp': (_c, p) => mine(p?.id).mcp(),
    'session.mcpReconnect': async (_c, p) => {
      if (typeof p?.name !== 'string' || !p.name) throw new CoreError(ERR.badRequest, 'name required');
      try { return await mine(p.id).reconnectMcp(p.name); }
      catch (e) { if (e instanceof CoreError) throw e; throw new CoreError(ERR.badRequest, (e as Error).message); }
    },
    'session.plugins': (_c, p) => {
      mine(p?.id);
      const cur = currentBuilds(logFile.meta.agentPlugins ?? {}, P.dir, harness, profileNow(), params, env);
      return { profile: prof.name, plugins: agentLoaded.map((l) => ({ name: l.name, version: l.version, build: l.build, values: l.values, current: cur[l.name] ?? null })), added: Object.keys(cur).filter((n) => !agentLoaded.some((l) => l.name === n)), pending: reloadWanted };
    },
    'session.reloadPlugins': async (_c, p) => {
      const s = mine(p?.id);
      // 다음 턴 전에 — 턴 중이면 그 턴이 끝난 idle 에서
      if (s.state === 'idle' || s.state === 'starting') { await reloadPlugins(); return { deferred: false }; }
      reloadWanted = true;
      return { deferred: true };
    },
    'session.rewind': async (_c, p) => {
      if (typeof p?.seq !== 'number') throw new CoreError(ERR.badRequest, 'seq required');
      try { return { ok: true, filesChanged: await mine(p.id).rewind(p.seq, !!p.conversation, !!p.files) }; }
      catch (e) { if (e instanceof CoreError) throw e; throw new CoreError(ERR.badRequest, (e as Error).message); }
    },
    'session.prompts': (_c, p) => promptTurns(mine(p?.id).log.all),
    'session.rewindPreview': async (_c, p) => {
      if (typeof p?.seq !== 'number') throw new CoreError(ERR.badRequest, 'seq required');
      try { return await mine(p.id).rewindPreview(p.seq); }
      catch (e) { if (e instanceof CoreError) throw e; throw new CoreError(ERR.badRequest, (e as Error).message); }
    },
    'session.approve': (_c, p) => {
      const s = mine(p?.id);
      if (p.decision !== 'allow' && p.decision !== 'deny') throw new CoreError(ERR.badRequest, 'decision allow|deny');
      const ok = s.approve(p.requestId, p.decision, { remember: p.remember, updatedInput: p.updatedInput, message: p.message, interrupt: p.interrupt === true });
      // 거절해 턴을 끝내면 Stop 처럼 대기 항목을 입력창으로 — 끝난 턴의 idle 은 벤더에서 나중에 오니 drainWaiting 보다 먼저다
      if (ok && p.decision === 'deny' && p.interrupt === true) giveBack(waiting.splice(0));
      if (ok) activity.answered();
      return { ok };
    },
    'session.close': (_c, p) => { mine(p?.id); setImmediate(() => void close('closed by client')); return { ok: true }; },
    'session.rename': (_c, p) => { const s = mine(p?.id); s.log.updateMeta({ title: p.title ?? null }); broadcast('session.changed', s.info()); return { ok: true }; },
    'session.setInspect': async (_c, p) => {
      const s = mine(p?.id);
      if (typeof p.on !== 'boolean') throw new CoreError(ERR.badRequest, 'on required');
      await setInspect(p.on);
      return { ok: true };
    },
    'session.inspectTurn': (_c, p) => ({ calls: turnCalls(readStore(), mine(p?.id).log.all, Number(p.end)) }),
    'session.inspectCall': (_c, p) => {
      mine(p?.id);
      const rec = readStore()?.read(Number(p.n)) ?? null;
      if (!rec) throw new CoreError(ERR.badRequest, `no inspect call ${p.n} (cleared or never recorded)`);
      return rec;
    },
    'session.setDraft': (_c, p) => { mine(p?.id); if (typeof p.text !== 'string') throw new CoreError(ERR.badRequest, 'text required'); draft = p.text; return { ok: true }; },
    'session.signal': (_c, p) => { mine(p?.id); if (!activity.signal(p.strength, p.what)) throw new CoreError(ERR.badRequest, 'strength weak|strong and what [a-z0-9-]{1,32}'); return { ok: true }; },
    'session.activity': (_c, p) => { mine(p?.id); return activity.result(typeof p.from === 'number' ? p.from : undefined); },
    // ---- 메시징 (ticket slcode-p2p-messaging, 2026-10-19)
    'session.deliver': (_c, p) => {
      mine(p?.id);
      const m = p.mail;
      if (typeof m?.from !== 'string' || !m.from) throw new CoreError(ERR.badRequest, 'mail.from required');
      // 팀원도 누구의 메시지든 받는다 — 잠김(입력 제어)은 지시만 막는다 (사용자 2026-11-07)
      const mail = newMail({ id: typeof m.id === 'string' && /^[\w-]{1,40}$/.test(m.id) ? m.id : undefined, ts: Number(m.ts) || undefined, from: m.from, to: sid, kind: typeof m.kind === 'string' && m.kind ? m.kind : 'message', body: m.body ?? '', ...(m.re ? { re: String(m.re) } : {}), ...(m.via ? { via: String(m.via) } : {}), ...(m.lazy === true ? { lazy: true } : {}) });
      take(mail);
      return { mailId: mail.id };
    },
    'session.check': (_c, p) => {
      mine(p?.id);
      const batch = pending.splice(0);
      for (const m of batch) received.set(m.id, m.from);
      return { count: batch.length, text: batch.map(renderMail).join('\n\n') };
    },
    'session.ask': async (_c, p) => {
      mine(p?.id);
      if (typeof p.to !== 'string' || !p.to) throw new CoreError(ERR.badRequest, 'to required');
      // 받는 이는 켜진 세션 — 아니면 sendMail 이 no_session
      const { id: mailId } = await sendMail(P.sessionsDir, p.to, { from: sid, kind: 'ask', body: String(p.text ?? '') });
      const reply = await new Promise<Mail>((resolve, reject) => {
        const timer = p.timeoutMs ? setTimeout(() => { asks.delete(mailId); reject(new CoreError('timeout', `no reply to ${mailId} in ${p.timeoutMs}ms`)); }, p.timeoutMs) : null;
        asks.set(mailId, { resolve: (m) => { if (timer) clearTimeout(timer); resolve(m); }, reject: (e) => { if (timer) clearTimeout(timer); reject(e); } });
      });
      return { mailId, reply, text: renderMail(reply) };
    },
    'session.reply': async (_c, p) => {
      mine(p?.id);
      const to = received.get(String(p.re));
      if (!to) throw new CoreError(ERR.badRequest, `unknown mail ${p.re} — this session did not receive it (use: slcode mail <to> <text>)`);
      return sendMail(P.sessionsDir, to, { from: sid, kind: 'reply', body: String(p.text ?? ''), re: String(p.re) });
    },
    // ---- 팀원 세션 (ticket slcode-team-agent, 사용자 결정 2026-11-07~08)
    'session.spawnChild': async (_c, p) => {
      const s = mine(p?.id);
      if (!canTeam) throw new CoreError(ERR.teamDisabled, `session ${sid} cannot start teammates (the new-session teammate setting was off, or it is a teammate started with noTeam)`);
      if (typeof p.cwd !== 'string' || !path.isAbsolute(p.cwd)) throw new CoreError(ERR.badRequest, 'cwd must be an absolute folder');
      if (p.vendor !== undefined && p.vendor !== 'claude' && p.vendor !== 'codex') throw new CoreError(ERR.badRequest, 'vendor claude|codex');
      // 빠진 옵션은 teammate 템플릿 값 (사용자 2026-11-08: 모든 옵션은 선택, 없으면 teammate 템플릿)
      const { cut: _cut, ...given } = p.team ?? {};
      const options: TeamOptions = { ...TEAM_TEMPLATES.teammate, ...given };
      { const why = teamOptionsError(options); if (why) throw new CoreError(ERR.badRequest, why); }
      // 주지 않은 벤더·모델·effort·권한 모드는 리더를 따른다 — 모델·effort 는 벤더가 같을 때만 (사용자 결정 5-1·3)
      const vendor = p.vendor ?? logFile.meta.vendor;
      const same = vendor === logFile.meta.vendor;
      const id = await children.spawn({
        cwd: p.cwd, vendor, title: p.title, model: p.model ?? (same ? s.model ?? undefined : undefined), effort: p.effort ?? (same ? s.effort ?? undefined : undefined),
        permissionMode: p.mode ?? logFile.meta.permissionMode ?? undefined, profile: p.profile, env: p.env, params: p.params, prompt: p.prompt, raw: opts.raw, team: options,
        ...(logFile.meta.inspect ? { inspect: true } : {}),
      });
      return { id };
    },
    'session.childCall': async (_c, p) => {
      mine(p?.id);
      if (!['session.send', 'session.interrupt', 'session.approve', 'session.close'].includes(p.method)) throw new CoreError(ERR.badRequest, `${p.method} is not a teammate instruction`);
      if (p.wait && p.method !== 'session.send') throw new CoreError(ERR.badRequest, 'wait works only with session.send');
      // 리더 모델은 질문 수신 팀원의 질문에만 답한다 — 도구 승인은 사람이 화면에서 (사용자 결정 3)
      if (p.method === 'session.approve') {
        const req = children.pendingOf(p.child, p.params?.requestId);
        if (req && req.name !== 'AskUserQuestion') throw new CoreError(ERR.badRequest, `${req.requestId} is a tool approval (${req.name}) — the user answers it in the screen, not the leader session`);
        if (req && !teamOf(sessionMeta(P.sessionsDir, String(p.child)))?.askToLeader) throw new CoreError(ERR.badRequest, `teammate ${p.child} does not pass its questions to the leader (askToLeader off) — the user answers ${req.requestId} in its screen`);
      }
      if (p.method !== 'session.send' || typeof p.child !== 'string') return children.call(p.child, p.method, p.params ?? {});
      const child = p.child;
      if (p.wait && !teamOf(sessionMeta(P.sessionsDir, child))?.outputToLeader) throw new CoreError(ERR.badRequest, `teammate ${child} does not report its answers (outputToLeader off) — wait works only for a teammate that does (a subagent)`);
      // 답하고 닫힌 팀원(답하면 닫힘)은 다시 시키면 다시 띄운다 (사용자 2026-11-08). 닫히는 중에 보냈으면(not_live) 다 닫힌 뒤 다시 띄워 한 번 더
      // 기다리면 지시에 표지(ref)를 붙인다 — 팀원은 그 지시가 연 턴의 답에만 re 로 단다. 턴 중인 팀원에게 보낸 지시는 큐에서 기다리므로 지금 턴의 답을 받지 않는다.
      // 기다림은 보내기 전에 건다 (표지로 맞추니 순서가 상관없다), 보내기가 실패하면 뺀다. 팀원이 끝나서 푸는 것은 지시가 닿은 뒤부터다 (arm) —
      // 닫히는 중인 팀원에게 보내 다시 띄우는 동안 앞 팀원의 끝남이 이 기다림을 풀지 않게
      const ref = p.wait ? randomUUID().slice(0, 8) : undefined;
      const params = { ...(p.params ?? {}), ...(ref ? { ref } : {}) };
      const answer = ref ? waitAnswer(_c, child, ref) : null;
      const send = async () => { await children.reopen(child); return children.call(child, 'session.send', params); };
      let r: unknown;
      try {
        try { r = await send(); }
        catch (e) { if ((e as CoreError).code !== ERR.notLive) throw e; r = await send(); }
      } catch (e) { if (ref) dropRef(child, ref); throw e; }
      if (!answer) return r;
      arm(child, ref!);
      return { answer: await answer };
    },
    'session.childApprove': async (_c, p) => {
      mine(p?.id);
      if (p.decision !== 'allow' && p.decision !== 'deny') throw new CoreError(ERR.badRequest, 'decision allow|deny');
      return children.call(p.child, 'session.approve', { requestId: p.requestId, decision: p.decision, ...(p.updatedInput ? { updatedInput: p.updatedInput } : {}) }) as Promise<{ ok: boolean }>;
    },
    'session.children': (_c, p) => { mine(p?.id); return { children: children.list() }; },
    'session.unlock': (_c, p) => { mine(p?.id); cut(); return { ok: true }; },
  };
  // ---- 팀원의 잠김 (ticket slcode-team-agent) — 입력 제어가 켜진 팀원은 리더가 소유하는 동안(소유자 유예 중 포함) 화면·CLI 의 지시를 받지 않는다.
  // 사람이 따로 소유하면(리더 없이 resume) 잠기지 않는다. 끊은 뒤(team.cut)에는 반대로 리더의 지시를 거절한다. 도구 승인과 닫기는 잠김과 상관없다
  const locked = () => !!parentId && !!team()?.inputControl && (!owner || owner.parent);
  const lockedWhy = () => `session ${sid} is a teammate whose input its leader ${parentId} controls — cut it loose in its screen (the lock icon) to give it instructions yourself`;
  const unlockedWhy = () => `the user cut teammate ${sid} loose from its leader — instructions from the leader are refused (send it a message instead: slcode mail ${sid} <text>)`;
  session.extraInfo = () => (parentId ? { locked: locked() } : {});
  /** 끊기 (사용자 2026-11-08) — 입력 제어·출력 수신·질문 수신을 끈다. 일방향이라 되돌리는 길이 없다. 관계(메시지·가족 메뉴)와 수명 연동은 그대로 */
  function cut() {
    const t = team();
    if (!parentId || !t) throw new CoreError(ERR.badRequest, `session ${sid} is not a teammate`);
    if (t.cut) return;
    logFile.updateMeta({ team: { ...t, inputControl: false, outputToLeader: false, askToLeader: false, endWithAnswer: false, cut: true } });
    broadcast('session.changed', session.info());
    tellParent('unlocked', 'The user cut this teammate loose. It no longer takes your instructions, reports its turns or passes its questions to you. You can still exchange messages with it (slcode mail).');
  }
  /** 리더에게 메시지 — 리더가 꺼졌으면 그만 */
  function tellParent(kind: string, body: string, re?: string | null): Promise<void> {
    if (!parentId) return Promise.resolve();
    return sendMail(P.sessionsDir, parentId, { from: sid, kind, body, ...(re ? { re } : {}) }).then(() => {}, (e) => log(`could not tell the leader (${kind}): ${(e as Error).message}`));
  }
  /** 리더가 지시하는 메서드 — 잠긴 동안 리더 밖의 연결은 거절, 끊은 뒤에는 리더를 거절 */
  const LOCKED_METHODS = new Set(['session.send', 'session.interrupt', 'session.unqueue', 'session.setModel', 'session.setEffort', 'session.setVendor', 'session.setProfile', 'session.setMode', 'session.rewind']);
  function gate(conn: Conn, method: string) {
    if (!parentId) return;
    if (LOCKED_METHODS.has(method) && locked() && !conn.parent) throw new CoreError(ERR.locked, lockedWhy());
    if (conn.parent && team()?.cut && (LOCKED_METHODS.has(method) || method === 'session.approve')) throw new CoreError(ERR.unlocked, unlockedWhy());
  }
  const children = new Children({
    dir: P.dir, sessionsDir: P.sessionsDir, parent: sid, log,
    changed: () => broadcast('session.children', { id: sid, children: children.list() }),
    exited: (id, reason) => take(newMail({ from: id, to: sid, kind: 'closed', body: `Teammate ${id} ended (${reason}) without this session closing it.` })),
    // 답 없이 끝난 팀원을 기다리던 요청 — 답이 오면 그 전에 풀린다 (답 메시지는 팀원이 닫기 전에 보낸다)
    gone: (id, reason) => { endWaits(id, `(teammate ${id} ended before answering: ${reason})`); },
  });
  function broadcast(event: string, params: unknown) { for (const c of conns) c.send({ event, params }); }

  // ---- 에이전트 플러그인 다시 싣기 (ticket slcode-agent-plugin) — 링크를 지금 설정의 빌드로 바꾸고 SDK reloadPlugins(). 결과는 plugins.reloaded 이벤트로.
  // Codex 는 skill 만 — 새 extra root 로 skills/extraRoots/set, 나머지는 later (slcode-agent-plugin-codex)
  let reloadWanted = false;
  async function reloadPlugins() {
    reloadWanted = false;
    try {
      const r = reloadSessionPlugins(linksDir, agentLoaded, env, logFile.meta.agentPlugins ?? {}, P.dir, harness, profileNow(), params);
      for (const n of r.notes) session.notice(`에이전트 플러그인을 싣지 못했습니다 — ${n}`);
      if (session instanceof CodexSession) {
        await session.setSkillRoots(r.roots);
        agentLoaded = r.loaded;
        session.emitPlugins({ plugins: r.loaded.map((l) => ({ name: l.name, version: l.version, build: l.build, values: l.values })), removed: r.removed, later: r.later, sdk: { plugins: [], commands: [], agents: [], mcp: [] } });
        return;
      }
      const s = session as ClaudeSession;
      const sdk = await s.reloadPlugins();
      agentLoaded = r.loaded;
      hooks?.load(r.loaded); // 빌드가 바뀐 플러그인의 worker 만 다시 띄운다
      vendorCmds = null;
      if (hooks?.commands().length) void commandsNow().catch(() => {}); // 새로 실린 명령이 내장 명령과 겹치면 알린다
      s.emitPlugins({
        plugins: r.loaded.map((l) => ({ name: l.name, version: l.version, build: l.build, values: l.values })), removed: r.removed, later: r.later,
        sdk: { plugins: sdk.plugins.map((x) => ({ name: x.name, ...(x.source ? { source: x.source } : {}) })), commands: sdk.commands.map((c) => c.name), agents: sdk.agents.map((a) => a.name), mcp: sdk.mcpServers.map((m) => ({ name: m.name, status: m.status, ...(m.error ? { error: m.error } : {}) })) },
      });
    } catch (e) { session.notice(`에이전트 플러그인을 다시 싣지 못했습니다: ${(e as Error).message}`); }
  }
  session.onEvent((e) => { if (reloadWanted && e.ev.kind === 'session.state' && e.ev.state === 'idle') void reloadPlugins(); });

  async function onLine(conn: Conn, line: string) {
    let msg: RequestFrame;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined || typeof msg.method !== 'string') return;
    // 내려가기로 정했다 — 받은 척하고 버리지 않는다. 보낸 쪽이 새 core 에 다시 보낸다 (serve 의 중계·sendMail)
    if (retiring) { conn.send({ id: msg.id, error: { code: ERR.retiring, message: 'this core is being replaced — send it again' } }); return; }
    try {
      const h = (handlers as Record<string, Handler<MethodName>>)[msg.method];
      if (!h) throw new CoreError(ERR.badRequest, `unknown method ${msg.method}`);
      gate(conn, msg.method);
      conn.send({ id: msg.id, result: await h(conn, msg.params as never) });
    } catch (e) {
      conn.send({ id: msg.id, error: { code: e instanceof CoreError ? e.code : 'error', message: e instanceof Error ? e.message : String(e) } });
    }
  }
  // 벤더가 기동 중(아래 listen 을 기다리는 사이)에 죽으면 close 가 아직 없다 — 사유를 들고 있다가 끝에서 던진다 (2026-10-04 실측: TDZ 'close' 로 진짜 사유가 묻혔다)
  let closeFn: ((reason?: string) => Promise<void>) | null = null;
  let earlyExit: string | null = null;
  session.onEvent((e) => {
    if (e.ev.kind === 'session.state') broadcast('session.changed', session.info());
    if (e.ev.kind === 'session.state' && (e.ev.state === 'idle' || e.ev.state === 'starting')) { drainWaiting(); flushMail(); }
    if (parentId) reportToParent(e);
    if (parentId && e.ev.kind === 'turn.start') { turnRef = nextRef; nextRef = null; }
    if (parentId && e.ev.kind === 'turn.end') answered = true;
    if (e.ev.kind === 'session.state' && e.ev.state === 'idle') maybeEndWithAnswer();
    if (e.ev.kind === 'session.exit') { broadcast('session.closed', { id: sid, reason: e.ev.reason }); const r = `session exited: ${e.ev.reason}`; if (closeFn) void closeFn(r); else earlyExit = r; }
    if (e.ev.kind === 'task') { if (e.ev.phase === 'ended') bg.delete(e.ev.taskId); else if (e.ev.background) bg.add(e.ev.taskId); }
    if (retire) setImmediate(maybeRetire); // idle 에서 밀린 메시지가 턴으로 들어갔는지 본 뒤에
  });

  // ---- 팀원의 보고 (사용자 결정 2026-11-07) — 출력 수신이면 턴이 끝날 때 마지막 답 전체를 kind=result 로, 질문 수신이면 질문(AskUserQuestion)을 kind=question 으로 리더에게.
  // 끊은 뒤에는 둘 다 꺼져 있다. 도구 승인은 리더 화면이 소유 연결로 본다
  function reportToParent(e: LoggedEvent) {
    const t = team(), ev = e.ev;
    if (!t || closed) return; // 닫히는 중의 턴 끝(Codex 는 닫을 때 끝난 턴에도 interrupt 를 보내 turn.end 가 한 번 더 온다)은 보고하지 않는다
    if (ev.kind === 'turn.end' && t.outputToLeader) {
      const answer = lastAnswer(logFile.all);
      const head = ev.ok ? '' : ev.interrupted ? '(the turn was interrupted)\n' : `(the turn failed: ${ev.error ?? 'unknown error'})\n`;
      reported = tellParent('result', `${head}${answer || '(no answer text)'}`, turnRef);
    } else if (ev.kind === 'approval.requested' && ev.name === 'AskUserQuestion' && t.askToLeader) {
      tellParent('question', `Request ${ev.requestId}: ${JSON.stringify(ev.input)}\nAnswer with: slcode respond ${sid} ${ev.requestId} --answer <text>`);
    }
  }

  // ---- 답하면 닫힘 (사용자 2026-11-08) — 턴을 마치고 할 일 없이 쉬게 되면 답(kind=result)을 리더에게 보낸 뒤 닫는다. 오래 켜 둔 세션의 메모리를 막으려고.
  // 기동 직후의 idle(다시 띄운 직후 포함)에는 닫지 않는다 — 턴이 끝난 뒤의 idle 만. 리더가 다시 시키면 리더 core 가 다시 띄운다(Children.reopen)
  let answered = false;
  let reported: Promise<void> = Promise.resolve();
  /** 리더의 기다림 표지 — nextRef 는 지금 넣는 지시의 것, turnRef 는 그 지시가 연 턴의 것 (turn.start 에서 옮긴다). 턴 중에 보낸 지시는 큐에서 기다리므로
   *  지금 턴의 답이 그 지시의 답으로 가지 않게 한다 (ticket slcode-team-agent) */
  let nextRef: string | null = null, turnRef: string | null = null;
  function maybeEndWithAnswer() {
    if (!answered || closed || !team()?.endWithAnswer) return;
    answered = false;
    void reported.then(() => setImmediate(() => {
      const calm = session.state === 'idle' && !pending.length && !waiting.length && !draining && !session.pendingApprovals().length;
      if (calm && team()?.endWithAnswer) void close(ANSWERED);
    }));
  }

  // ---- 소유권 — 소유자가 없는 동안은 유예 시계가 돈다 (기동 직후, 소유자가 close 없이 끊긴 뒤)
  let ownerGrace: NodeJS.Timeout | null = null;
  /** 팀원의 리더 core 가 교체 중이다 — 새 리더 core 가 다시 소유할 때까지 유예를 늘린다 (교체는 소유자 유예보다 길 수 있다) */
  const parentReplacing = () => { const m = parentId ? sessionMeta(P.sessionsDir, parentId) : null; return !!m && replacing(new EventLog(P.sessionsDir, m).sockPath); };
  /** 수명 연동이 꺼진 팀원(link·detached 템플릿)은 소유자 없이도 산다 — slcode close·화면의 종료로만 닫힌다 (ticket slcode-team-agent) */
  const ownerless = () => { const t = team(); return !!t && !t.endWithLeader; };
  function armOwnerGrace() {
    if (ownerGrace || closed || ownerless()) return;
    ownerGrace = setTimeout(() => { ownerGrace = null; if (owner) return; if (parentReplacing()) armOwnerGrace(); else void close('owner gone'); }, OWNER_GRACE_MS);
  }
  function disarmOwnerGrace() { if (ownerGrace) { clearTimeout(ownerGrace); ownerGrace = null; } }

  // ---- UDS
  const sockPath = logFile.sockPath;
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 }); // 긴 경로 폴백(<dir>/sock/<id>)의 폴더
  try { fs.unlinkSync(sockPath); } catch {} // 죽은 프로세스의 소켓 (위에서 살아 있지 않음을 확인했다)
  const socks = new Set<net.Socket>();
  const uds = net.createServer((sock) => {
    socks.add(sock);
    const conn: Conn = { detach: null, send: (o) => { if (!sock.destroyed) sock.write(JSON.stringify(o) + '\n'); }, ownerPid: null, web: null, follows: false, parent: false };
    conns.add(conn);
    let buf = '';
    sock.setEncoding('utf8'); // 청크 경계에 걸린 한글이 깨지지 않게 — 웹·stdio 프레임이 모두 이 스트림을 거친다
    sock.on('data', (d: string) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) void onLine(conn, l); } });
    sock.on('close', () => {
      socks.delete(sock); conn.detach?.(); conns.delete(conn); dropWait(conn);
      if (owner === conn) { owner = null; armOwnerGrace(); }
      if (retire?.conn === conn && !retiring) { retire = null; log('replacement cancelled: the requester is gone'); }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => { uds.once('error', reject); uds.listen(sockPath, () => { fs.chmodSync(sockPath, 0o600); resolve(); }); })
    .catch(async (e) => { await session.close('listen failed'); throw e; });

  // ---- 받은 메시지 → 다음 idle 에 한 턴
  const pending: Mail[] = [];
  /** 팀원의 답을 기다리는 요청 (`slcode team new·prompt --wait`, MCP 도구) — 팀원 id → 먼저 온 요청부터. 요청 연결이 끊기면 빠지고, 그 뒤의 답은 메시지로 온다 */
  /** 답은 보낸 지시의 표지(ref)로 맞춘다 — 팀원이 턴 중일 때 보낸 지시가 지금 턴의 답을 받지 않게. 팀원이 끝나거나 끊기면 그 팀원의 기다림을 모두 푼다 */
  const answerWaits = new Map<string, { conn: Conn; ref: string; armed: boolean; resolve: (answer: string) => void }[]>();
  function waitAnswer(conn: Conn, child: string, ref: string): Promise<string> {
    return new Promise((resolve) => { const l = answerWaits.get(child) ?? []; l.push({ conn, ref, armed: false, resolve }); answerWaits.set(child, l); });
  }
  /** 지시가 팀원에게 닿았다 — 이제부터 팀원이 끝나면 이 기다림도 푼다 */
  function arm(child: string, ref: string) { const w = answerWaits.get(child)?.find((x) => x.ref === ref); if (w) w.armed = true; }
  function dropRef(child: string, ref: string) {
    const rest = (answerWaits.get(child) ?? []).filter((w) => w.ref !== ref);
    if (rest.length) answerWaits.set(child, rest); else answerWaits.delete(child);
  }
  /** 지시가 닿은 기다림만 푼다 (아직 보내는 중인 것은 남긴다) — 푼 것이 있으면 true */
  function endWaits(child: string, answer: string) {
    const l = answerWaits.get(child) ?? [], done = l.filter((w) => w.armed), rest = l.filter((w) => !w.armed);
    if (rest.length) answerWaits.set(child, rest); else answerWaits.delete(child);
    for (const w of done) w.resolve(answer);
    return done.length > 0;
  }
  function dropWait(conn: Conn) {
    for (const [k, l] of answerWaits) {
      const rest = l.filter((w) => w.conn !== conn);
      if (rest.length) answerWaits.set(k, rest); else answerWaits.delete(k);
    }
  }
  const seen = new Set<string>();
  /** 받은 메시지 id → 보낸 이 (session.reply 의 대상). 재기동 뒤에는 로그의 mail 턴 머리표에서 복원 */
  const received = new Map<string, string>();
  for (const e of logFile.all) if (e.ev.kind === 'turn.start' && e.ev.origin === 'mail') for (const h of parseMails(e.ev.text)) if (h.id && h.from) received.set(h.id, h.from);
  /** session.ask 대기 — 메시지 id → 답장이 오면 푼다 */
  const asks = new Map<string, { resolve: (m: Mail) => void; reject: (e: Error) => void }>();
  /** name 은 보낸 세션의 제목 (세션이 아니거나 제목이 없으면 null) */
  const renderMail = (m: Mail) => formatMail(m, sessionMeta(P.sessionsDir, m.from)?.title ?? null);
  function take(m: Mail) {
    if (closed || seen.has(m.id)) return; // 같은 id 를 다시 보내도 한 통
    seen.add(m.id);
    // 대기 중인 ask 의 답장은 턴이 아니라 그 요청의 응답으로
    const waiter = m.kind === 'reply' && m.re ? asks.get(m.re) : undefined;
    if (waiter) { asks.delete(m.re!); waiter.resolve(m); return; }
    // --wait 로 기다리는 팀원의 답(과 끝남)은 턴이 아니라 그 요청의 응답으로 — 한 답은 한 길로만 (사용자 2026-11-08)
    const body = typeof m.body === 'string' ? m.body : JSON.stringify(m.body);
    const l = m.kind === 'result' && m.re ? answerWaits.get(m.from) : undefined, i = l?.findIndex((w) => w.ref === m.re) ?? -1;
    if (l && i >= 0) { const [w] = l.splice(i, 1); if (!l.length) answerWaits.delete(m.from); w.resolve(body); return; }
    // 끝남·끊김은 그 팀원을 기다리던 요청 모두에 — 기다리던 요청이 있었으면 턴으로 넣지 않는다 (한 답은 한 길로만)
    if ((m.kind === 'closed' || m.kind === 'unlocked') && endWaits(m.from, `(${m.kind === 'closed' ? body : `the user cut teammate ${m.from} loose before it answered`})`)) return;
    // fast(기본, ticket slcode-team-agent 사용자 2026-11-07) — 턴 중이어도 바로 넣는다. Claude 는 다음 도구 결과와 함께 같은 턴에, Codex 는 지금 턴 뒤에 줄 선다.
    // lazy 는 밀려 있다가 idle 에 한 턴으로
    if (!m.lazy && !mailCalm()) { deliverMail([m]); return; }
    pending.push(m);
    flushMail();
  }
  // 턴 중에 친 에이전트 플러그인 명령 (사용자 결정 2026-11-02) — 바로 돌리지 않고 idle(첫 프롬프트 전 starting 포함)로 돌아온 뒤 친 순서대로 돌린다. 화면은 입력창 위 대기 영역(session.queue)으로 보인다.
  // 기다리는 명령이 있는 동안 사람이 보낸 메시지도 그 뒤에 선다 — '/roleas lead' 다음에 친 요청이 바뀐 역할로 돌게. 메시지 하나를 넣으면 턴이 시작되니 다음 idle 까지 멈춘다
  // 턴 중 메시지(ticket slcode-queued-message-bubble, 사용자 결정 2026-11-08): 벤더와 상관없이 여기서 idle 을 기다렸다가 하나씩 한 턴으로 — 도구 호출 중간에 끼우지 않는다.
  // Claude SDK 에 바로 넣으면 다음 도구 결과에 끼고, 턴 끝에 줄 선 것은 한 턴으로 합쳐진다(priority later 도 같다, 2026-11-08 실측)
  type Waiting = { id: string } & ({ cmd: LoadedCommand; args: string } | { text: string; att: Attachment[]; ref?: string });
  const waiting: Waiting[] = [];
  /** 입력창에 되돌릴 글 — 명령은 친 꼴 그대로 */
  const waitingInput = (w: Waiting) => ('cmd' in w ? { text: `/${w.cmd.name}${w.args ? ` ${w.args}` : ''}`, att: [] as Attachment[] } : { text: w.text, att: w.att });
  let draining = false; // 명령 하나가 도는 중
  const calmForCommand = () => session.state === 'idle' || session.state === 'starting';
  /** 턴이 돌거나 벤더에 넣은 메시지가 남았다 — 첫 프롬프트 전 starting 에 넣은 것은 state 를 바꾸지 않는다 */
  const busy = () => !calmForCommand() || (session instanceof ClaudeSession && session.queued > 0);
  const queueItems = (): QueueItem[] => waiting.map((w) => ('cmd' in w ? { id: w.id, kind: 'command', text: waitingInput(w).text } : { id: w.id, kind: 'message', text: w.text, ...(w.att.length ? { attachments: w.att.length } : {}) }));
  const queueChanged = () => broadcast('session.queue', { id: sid, items: queueItems() });
  /** 거둔 대기 항목을 입력창으로 (사용자 결정 2026-11-08) — 줄바꿈으로 이어 초안 앞에 붙이고 session.restored 로 알린다 */
  function giveBack(rest: Waiting[]) {
    const items = rest.map(waitingInput);
    if (!items.length) return;
    queueChanged();
    const text = items.map((i) => i.text).join('\n');
    draft = draft ? `${text}\n${draft}` : text;
    broadcast('session.restored', { id: sid, text, attachments: items.flatMap((i) => i.att) });
  }
  function drainWaiting() {
    if (draining || closed || !waiting.length || busy()) return;
    draining = true;
    void (async () => {
      try {
        while (waiting.length && !closed && !busy()) {
          const w = waiting.shift()!;
          queueChanged();
          if ('cmd' in w) await hooks!.runCommand(w.cmd.plugin, w.cmd.name, w.args, { cwd });
          else { nextRef = w.ref ?? null; session.send(w.text, null, w.att); }
        }
      } finally { draining = false; }
    })();
  }
  const mailCalm = () => session.state === 'idle' || session.state === 'starting';
  // 밀린 것(lazy): idle(첫 프롬프트 전 starting 포함)이면 즉시, 아니면 다음 idle 에. 여러 통은 한 턴으로 (사용자 결정 2026-09-27)
  function flushMail() {
    if (closed || !pending.length || !mailCalm()) return;
    deliverMail(pending.splice(0));
  }
  function deliverMail(batch: Mail[]) {
    for (const m of batch) received.set(m.id, m.from);
    session.send(batch.map(renderMail).join('\n\n'), 'mail');
  }
  logFile.updateMeta({ pid: process.pid });
  void children.adoptLive(); // 교체 전의 core 가 띄운 켜진 link 팀원

  // ---- 수명
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  // 닫는 중에 다시 부르면 같은 종료를 기다린다. 바로 돌아오면 호출자의 process.exit 이 종료를 끊어 closedAt·session.exit 가 남지 않았다 (2026-10-11 실측)
  let closing: Promise<void> | null = null;
  const close = (reason = 'closed'): Promise<void> => (closing ??= retiring ? done : (async () => {
    closed = true;
    disarmOwnerGrace();
    log(`closing: ${reason}`);
    activity.exited();
    // 꺼진 시각은 먼저 — 벤더 종료가 길어 SIGKILL 을 맞아도 남는다
    try { logFile.updateMeta({ closedAt: Date.now() }); } catch { /* delete 가 세션 폴더를 먼저 지웠다 */ }
    for (const [id, w] of asks) { asks.delete(id); w.reject(new CoreError('closed', `session closed: ${reason}`)); }
    children.closeAll(); // 리더가 닫히면 수명 연동 팀원도 닫는다 (사용자 결정 4-1), 나머지는 놓는다
    // 처리되지 않은 대기 항목은 입력 초안 앞에 붙여 파일로 — 다시 열면 입력창에 들어 있고 보내지 않는다 (사용자 결정 2026-11-08)
    const left = waiting.map((w) => waitingInput(w).text);
    if (left.length) try { fs.writeFileSync(draftFile, [...left, ...(draft ? [draft] : [])].join('\n')); } catch {}
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([session.close(reason), new Promise<void>((r) => { deadline = setTimeout(() => { log(`vendor did not close in ${CLOSE_DEADLINE_MS / 1000}s — leaving it`); r(); }, CLOSE_DEADLINE_MS); })]);
    clearTimeout(deadline);
    await hooks?.close(); // worker 와 hook.exec 가 띄운 프로세스 그룹도
    await inspect?.close();
    if (sweeper) clearInterval(sweeper);
    store?.close();
    uds.close();
    for (const s of socks) s.end(); // serve 의 중계·제어 연결이 닫힘을 본다
    try { fs.unlinkSync(sockPath); } catch {}
    try { unlinkSessionPlugins(linksDir); if (linksDir !== logFile.dir) fs.rmdirSync(linksDir); } catch {} // 이 세션이 쓰던 빌드를 정리 대상으로
    resolveDone();
  })());
  closeFn = close;

  // ---- 교체 (ticket slcode-core-serve-split 3단계, 설계 "core 교체", 사용자 2026-10-19)
  let retire: { conn: Conn; pkg: string } | null = null;
  let retiring = false;
  /** 돌고 있는 background task — 끝날 때까지 교체를 미룬다 */
  const bg = new Set<string>();
  /** 내려도 잃는 것이 초안뿐인 때 — 진행 턴·대기 승인·줄 선 턴·밀린 메시지·대기 ask·background task·inspect 토글이 없다 */
  const calm = () => !closed && !switching && session.state === 'idle' && !session.pendingApprovals().length
    && !(session instanceof ClaudeSession && session.queued) && !pending.length && !asks.size && !bg.size && !waiting.length && !draining;
  function maybeRetire() {
    if (!retire || retiring || !calm()) return;
    if (owner && !owner.follows) { log('replacement cancelled: the session owner cannot follow it'); retire = null; return; }
    void replace(retire.pkg);
  }
  async function replace(pkg: string) {
    retiring = true; closed = true;
    disarmOwnerGrace();
    activity.handoff(); // 새 core 가 이어 적는다 — 세션 꺼짐이 아니다
    log(`replacing this core with ${pkg}`);
    // 소켓을 지우기 전에 표시부터 — 그 사이 붙으려는 쪽이 꺼진 세션으로 보지 않고 기다린다
    const mark = replacingMark(sockPath);
    try { fs.writeFileSync(mark, String(Date.now() + REPLACE_MS)); } catch {}
    uds.close();
    try { fs.unlinkSync(sockPath); } catch {}
    if (draft) try { fs.writeFileSync(draftFile, draft); } catch {}
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([session.close('replaced', true), new Promise<void>((r) => { deadline = setTimeout(() => { log(`vendor did not close in ${CLOSE_DEADLINE_MS / 1000}s — leaving it`); r(); }, CLOSE_DEADLINE_MS); })]);
    clearTimeout(deadline);
    await hooks?.close(); // 상태는 파일에 있다 — 새 core 가 이어 쓴다
    children.release(); // 새 core 가 다시 소유한다 (Children.adoptLive)
    await inspect?.close();
    if (sweeper) clearInterval(sweeper);
    store?.close();
    try {
      // 권한 모드·모델·inspect 는 meta 를 따른다 — 기동 때의 opts.permissionMode 를 넘기면 그 뒤 바꾼 모드가 되돌아간다
      const next = await spawnCore({ dir: P.dir, cwd, resume: sid, raw: opts.raw }, pkg);
      log(`replaced by core ${next.pid}`);
      broadcast('core.replaced', { pid: next.pid ?? 0, version: next.version ?? '' });
    } catch (e) {
      // 벤더는 이미 내렸다 — 되돌릴 core 가 없어 세션을 닫는다 (빌드는 core.retire 에서 확인했으니 띄운 뒤의 실패다)
      const reason = `core replacement failed: ${(e as Error).message}`;
      log(reason);
      try { logFile.updateMeta({ closedAt: Date.now() }); } catch {}
      try { fs.unlinkSync(draftFile); } catch {}
      broadcast('session.closed', { id: sid, reason });
    }
    try { fs.unlinkSync(mark); } catch {}
    for (const s of socks) s.end();
    resolveDone();
  }
  if (earlyExit) { await close(earlyExit); throw new CoreError('vendor_exit', earlyExit); }
  armOwnerGrace();
  return { sock: sockPath, session: session.info(), close, done };
}

/** 마지막 턴의 답 — 본문(서브에이전트 밖)의 마지막 도구 뒤 글, 없으면 그 턴의 본문 글 전부 (팀원의 보고, ticket slcode-team-agent) */
function lastAnswer(events: readonly LoggedEvent[]): string {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].ev.kind === 'turn.start') { start = i; break; }
  if (start < 0) return '';
  let all = '', tail = '';
  for (const e of events.slice(start + 1)) {
    const ev = e.ev;
    if (ev.kind === 'text.delta' && !ev.parent) { all += ev.text; tail += ev.text; }
    else if ((ev.kind === 'tool.start' || ev.kind === 'tool.end') && !ev.parent) tail = '';
  }
  return (tail.trim() || all).trim();
}
