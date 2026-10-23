// slcode 플러그인 main (새 방식 apiVersion 2, ticket slcode-plugin-v2) — 세션 머신의 node 에서 머신마다 한 번 돈다. 카드 하나 = slcode 세션 하나.
//
// 세 갈래 (사용자 확정 2026-10-21): main(이 파일) — 바이너리 받기·설치, `slcode list`·`close --force`·런처 같은 명령, 셸 동사
// slcode.new·slcode.resume, 승인 알림을 창 하나에. renderer.js — 창마다: 팔레트 명령, 액티비티바 사이드바·배지, 카드 열기(이 main 이
// 부른다). views/session.js — 카드마다: 서비스 기동·연결·배지·다시 붙기, slcode 화면 iframe 중계. views/sessions.js — 세션 목록 사이드바.
// 카드 화면이 서비스를 띄우는 명령은 여기서 짓는다 (command) — 받은 바이너리의 경로가 이 머신의 것이라서다.
// slcode.new: 이 main 이 key 를 정해 요청자 터미널의 메인 창 renderer 에 카드를 열게 하고, 카드 화면이 hello 로 세션 id 를 알면 started 로
// 알려 동사가 끝난다 (결정 문서 plugin-architecture.md "slcode 이행용 빈 곳").
// 승인 알림 (사용자 2026-10-21 — 창 하나에만): 같은 카드를 연 창마다 카드 화면이 approval 로 알린다. requestId 로 한 번만, 그 카드
// 서비스의 메인 창(와이어 v48 — 서비스 tmux 로 고른다) renderer 가 '열기' 버튼과 함께 띄운다. 그 창을 고르지 못하는 superlite(v47 이하)는
// 이 머신의 메인 창으로 간다.

const SVC = 'session';
const CARDS = 'slcode/cards'; // renderer 가 공개한 인터페이스 (scope own)
/** Claude 의 effort 이름 — slcode/src/cli.ts CLAUDE_EFFORTS 와 같다 */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** model 의 공급자 앞머리 → 벤더 (사용자 2026-10-23, 임시) — slcode/src/cli.ts PROVIDERS 와 같다 */
const PROVIDERS = { anthropic: 'claude', openai: 'codex' };

// ---- 바이너리 자가 설치 (ticket slcode-plugin-selfinstall) — 순수 함수. export 는 slcode/test/plugin.test.ts 용
// plugin.json binary {repo, version} 의 version 은 semver 조건: `1.2.3`(고정)·`^1.2.3`·`~1.2.3`(범위, 정식 release 만).
// release 는 태그 `v<ver>`, 자산 `slcode-<ver>-<platform>.zip` (slcode/README.md "바이너리 배포")

export function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(s).trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null } : null;
}
function cmpVersion(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
    || (a.pre === b.pre ? 0 : a.pre === null ? 1 : b.pre === null ? -1 : a.pre < b.pre ? -1 : 1);
}
/** version 이 조건 cond 를 만족하는가. 읽을 수 없는 조건은 throw */
export function satisfies(version, cond) {
  const c = String(cond).trim();
  const op = c[0] === '^' || c[0] === '~' ? c[0] : '';
  const b = parseVersion(op ? c.slice(1) : c);
  if (!b) throw new Error(`binary.version 조건을 읽을 수 없습니다: ${cond}`);
  const v = parseVersion(version);
  if (!v) return false;
  if (!op) return cmpVersion(v, b) === 0;
  if (v.pre !== null || cmpVersion(v, b) < 0) return false;
  if (op === '~') return v.major === b.major && v.minor === b.minor;
  if (b.major > 0) return v.major === b.major; // ^ 는 왼쪽 첫 0 아닌 자리를 고정 (npm 과 같다)
  if (b.minor > 0) return v.major === 0 && v.minor === b.minor;
  return v.major === 0 && v.minor === 0 && v.patch === b.patch;
}
export const assetName = (version, platform) => `slcode-${version}-${platform}.zip`;
/** id 없는 resume 카드의 목록 — `slcode list --all` 행에서 그 폴더의 꺼진 세션을 꺼진 순서(최근 먼저)로. 꺼진 시각은 slcode
 *  serve.closedTime 과 같은 셈 (closedAt 과 updatedAt 중 늦은 쪽 — 옛 세션·옛 바이너리는 closedAt 이 없다) */
export const closedTime = (s) => Math.max(s.closedAt ?? 0, s.updatedAt);
export const closedRows = (rows, cwd) => rows.filter((s) => !s.live && s.cwd === cwd).sort((a, b) => closedTime(b) - closedTime(a));
/** GitHub Releases API(GET /repos/:repo/releases) 응답에서 조건에 맞는 최신 release 의 그 플랫폼 자산 → {version, url} | {error} */
export function pickRelease(releases, cond, platform) {
  let best = null, noAsset = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    const tag = String(r?.tag_name ?? '');
    if (r.draft || !tag.startsWith('v')) continue;
    const ver = tag.slice(1), v = parseVersion(ver);
    if (!v || !satisfies(ver, cond)) continue;
    const a = (r.assets ?? []).find((x) => x.name === assetName(ver, platform));
    if (!a) { noAsset ??= ver; continue; }
    if (!best || cmpVersion(v, best.v) > 0) best = { v, version: ver, url: a.browser_download_url };
  }
  if (best) return { version: best.version, url: best.url };
  return { error: noAsset ? `slcode ${noAsset} release 에 ${assetName(noAsset, platform)} 가 없습니다` : `조건 ${cond} 에 맞는 slcode release 가 없습니다` };
}
/** 받아 둔 bin/<platform>/manifest.json 의 원문(없으면 null) → 'none' | 'outdated'(조건 밖) | 'installed'.
 *  manifest 가 원장이다 — 플러그인 폴더를 다시 받아 bin/ 이 지워져도 거짓 "설치됨" 이 없다 */
export function installState(manifestText, cond, platform) {
  let m = null;
  try { m = manifestText == null ? null : JSON.parse(manifestText); } catch { m = null; }
  if (typeof m?.version !== 'string' || m.platform !== platform) return 'none';
  return satisfies(m.version, cond) ? 'installed' : 'outdated';
}
/** api.platform() 의 {os, arch}(Rust 표기) → zip 의 플랫폼 이름. 그 밖은 throw */
export function platformOf({ os, arch } = {}) {
  if (os === 'linux' && arch === 'x86_64') return 'linux-x64';
  if (os === 'windows' && arch === 'x86_64') return 'win-x64';
  throw new Error(`지원하지 않는 플랫폼입니다: ${os ?? '?'}/${arch ?? '?'} (linux-x64·win-x64 만)`);
}

/** @param {import('@superlite/plugin').MainApi} api */
export function activate(api) {
  const setting = async (k, d) => { const v = await api.settings.get(k); return v === undefined || v === '' ? d : String(v); };
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const newKey = () => 's' + Math.random().toString(36).slice(2, 8);

  // ---- 바이너리 받기 — api.folder(이 머신의 플러그인 폴더). main 의 fetch 는 진행률을 주지 않는다 — 카드는 '준비하는 중' 만 보인다
  /** plugin.json binary {repo, version} */
  let binarySpec = null;
  async function spec() {
    if (!binarySpec) {
      const b = JSON.parse((await api.folder.read('plugin.json')) ?? '{}').binary;
      if (typeof b?.repo !== 'string' || typeof b?.version !== 'string') throw new Error('plugin.json 에 binary {repo, version} 이 없습니다');
      binarySpec = b;
    }
    return binarySpec;
  }
  /** 플랫폼별 받기 — 여러 카드가 동시에 불러도 한 번. 끝나면 비워 다음 기동 때 manifest 를 다시 본다 (읽기 하나라 싸다) */
  const installing = new Map();
  function install(plat) {
    let p = installing.get(plat);
    if (!p) {
      p = (async () => {
        const { repo, version: cond } = await spec();
        const sub = `bin/${plat}`;
        if (installState(await api.folder.read(`${sub}/manifest.json`), cond, plat) === 'installed') return;
        const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`);
        if (!r.ok) throw new Error(`GitHub ${repo} releases 조회 실패 (${r.status})`);
        const pick = pickRelease(await r.json(), cond, plat);
        if (pick.error) throw new Error(pick.error);
        const { manifest } = await api.folder.fetch(pick.url, sub);
        if (installState(manifest == null ? null : JSON.stringify(manifest), cond, plat) !== 'installed') {
          throw new Error(`받은 zip 의 manifest.json 이 맞지 않습니다 (기대 ${pick.version} ${plat}, 받음 ${JSON.stringify(manifest)})`);
        }
      })();
      installing.set(plat, p);
      p.then(() => installing.delete(plat), () => installing.delete(plat));
    }
    return p;
  }
  /** 서비스·목록·런처가 쓸 slcode — 설정 bin 이 있으면 그것(셸에 그대로), 없으면 받은 바이너리 `<플러그인 폴더>/bin/<platform>/bin/slcode`.
   *  cmd 는 셸 명령에 넣을 꼴, path 는 따옴표 없는 경로 (설정이면 null) */
  async function resolveBin() {
    const over = await setting('bin', '');
    if (over) return { cmd: over, path: null };
    const plat = platformOf(await api.platform());
    await install(plat);
    const dir = await api.folder.deploy(`bin/${plat}`); // main 은 그 머신에 있어 폴더 경로 그대로다
    if (plat === 'win-x64') { const path = `${dir}\\bin\\slcode.cmd`; return { cmd: `"${path}"`, path, plat }; }
    const path = `${dir}/bin/slcode`;
    return { cmd: shq(path), path, plat };
  }
  const dirOpt = async () => { const dir = await setting('dir', ''); return dir ? ` --dir ${shq(dir)}` : ''; };

  /** 카드 서비스의 명령 — id 면 resume, 아니면 slcode.new 동사가 준 폴더·옵션으로 new (없으면 서비스 cwd = 워크스페이스 root).
   *  첫 프롬프트는 맨 끝 `--` 뒤에. --no-web: TCP 웹을 열지 않는다. --takeover: 핸드오프의 새 카드 — 떠 있는 세션의 소유권을 옛 카드의 serve 에서 가져온다 */
  async function command({ id = null, spawn = null, takeover = false } = {}) {
    const [bin, dir] = await Promise.all([resolveBin(), dirOpt()]);
    const sp = spawn ?? {};
    const verb = id ? `resume ${shq(id)}` : `new${sp.cwd ? ` ${shq(sp.cwd)}` : ''}${['vendor', 'title', 'mode', 'model', 'effort'].map((k) => (sp[k] ? ` --${k} ${shq(sp[k])}` : '')).join('')}`;
    return `${bin.cmd} ${verb} --stdio --no-web${takeover && id ? ' --takeover' : ''}${dir}${!id && sp.prompt ? ` -- ${shq(sp.prompt)}` : ''}`;
  }
  /** `slcode list` 행 — all 이면 꺼진 세션까지 */
  async function list(all = false) {
    const [bin, dir] = await Promise.all([resolveBin(), dirOpt()]);
    const r = await api.proc.run(`${bin.cmd} list${all ? ' --all' : ''}${dir}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    return JSON.parse(r.stdout || '[]');
  }
  /** id 없는 resume 카드의 목록 — 그 폴더의 꺼진 세션을 꺼진 순서(최근 먼저)로, 꺼진 시각은 closedTime 에 */
  const closed = async (cwd) => closedRows(await list(true), cwd).map((s) => ({ ...s, closedTime: closedTime(s) }));
  /** 사이드바 강제 종료 (사용자 2026-10-11) — `slcode close --force`: 정상 종료, 3초 안에 안 닫히면 kill */
  async function forceClose(id) {
    const [bin, dir] = await Promise.all([resolveBin(), dirOpt()]);
    const r = await api.proc.run(`${bin.cmd} close ${shq(id)} --force${dir}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  }
  /** [업데이트] — 지금 쓸 slcode(받기 포함)에 version·build 를 물어 카드 serve 의 것(화면이 보낸 값)과 견준다.
   *  deploy 경로는 내용 해시라 serve 가 자기 폴더를 봐서는 새 버전을 모른다 */
  async function checkUpdate(d) {
    const bin = await resolveBin();
    const r = await api.proc.run(`${bin.cmd} --version --json`);
    let b = null;
    try { b = JSON.parse(r.stdout); } catch {}
    if (r.code !== 0 || typeof b?.version !== 'string') return { status: 'failed', reason: r.stderr.trim() || `exit ${r.code}` };
    return b.version !== d?.version || String(b.build) !== String(d?.build) ? { status: 'restart-required', version: b.version, build: b.build } : { status: 'latest' };
  }

  // PATH 런처 — 명시적 명령으로만 (자동 실행 없음). Linux ~/.local/bin/slcode 심링크, Windows 는 사용자 PATH 에 기본으로 있는
  // %LOCALAPPDATA%\Microsoft\WindowsApps 에 slcode.cmd. 런처는 지금 받은 바이너리를 가리킨다 — 새 버전을 받으면 다시 실행한다.
  // 돌려주는 값: 만든 자리(문자열) 또는 우리 것이 아닌 slcode 가 이미 있으면 {conflict}
  async function installCommand(force) {
    const bin = await resolveBin();
    if (!bin.path) throw new Error('설정 "slcode command" 를 쓰는 중이라 런처를 만들지 않습니다 (설정을 비우면 받은 바이너리로 만든다)');
    if (bin.plat === 'win-x64') {
      const r = await api.proc.run(`(echo @"${bin.path}" %*) > "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\slcode.cmd"`);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      return '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\slcode.cmd';
    }
    const link = '~/.local/bin/slcode';
    if (!force) {
      const cur = await api.proc.run(`if [ -L ${link} ]; then readlink ${link}; elif [ -e ${link} ]; then echo '(file)'; fi`);
      const was = cur.stdout.trim();
      if (was && was !== bin.path) return { conflict: was };
    }
    const r = await api.proc.run(`mkdir -p ~/.local/bin && ln -sfn ${shq(bin.path)} ${link}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    return link;
  }

  // ---- 창 — 요청자 터미널을 연 창 가운데 메인 창 (tmux 가 없으면 이 머신의 메인 창). 카드 열기는 그 창의 renderer 가 한다
  async function windowFor(tmux) {
    const w = await api.window.main(tmux ? { tmux } : undefined);
    if (!w) throw new Error(tmux ? '이 터미널을 연 superlite 창이 없습니다' : '이 머신에 붙은 superlite 창이 없습니다');
    return w;
  }
  /** slcode.new 의 기다림 — key → {resolve, reject}. 같은 보존 카드를 두 창이 열면 started 가 두 번 올 수 있어 처음 것만 */
  const waits = new Map();
  /** 승인 알림을 이미 보낸 요청 (카드 owner + requestId) — 같은 카드를 연 창마다 카드 화면이 알린다 */
  const told = new Set();
  async function approval({ owner, requestId, key, id, message }) {
    const k = `${owner}\n${requestId}`;
    if (told.has(k)) return;
    told.add(k);
    if (told.size > 1000) told.delete(told.values().next().value);
    // 그 카드 서비스의 메인 창 — 서비스의 tmux 세션 id 로 고른다(v48). 고르지 못하면(옛 superlite·그 카드를 연 창 없음) 이 머신의 메인 창
    const svc = (await api.services.list().catch(() => [])).find((s) => s.service === SVC && s.owner === owner);
    const w = (svc ? await api.window.main({ tmux: svc.id }).catch(() => null) : null) ?? await api.window.main();
    if (w) await w.call(CARDS, 'notify', { key, id, message });
  }

  api.expose('host', {
    command, list, closed, forceClose, checkUpdate, installCommand, approval,
    started(key, id) { const w = waits.get(key); if (w) { waits.delete(key); w.resolve(id); } },
    failed(key, reason) { const w = waits.get(key); if (w) { waits.delete(key); w.reject(new Error(String(reason))); } },
  });

  // 셸 동사 — superlite 터미널 안의 `slcode`·`slcode new` 가 부른다 (ticket slcode-bare-new). 요청자 터미널의 deck 끝에 카드를 붙이고
  // 그 카드로 포커스를 옮긴다. 세션 id 는 카드 화면이 서비스를 띄운 뒤 started 로 알린다 (심 stdout 한 줄)
  api.verbs.handle('slcode.new', async (a, ctx) => {
    // model 이 <공급자>:<모델> 이면 벤더를 고르고 앞머리를 뗀다 — 다른 앞머리는 이름 전체가 모델
    let { vendor, model } = a;
    const colon = model?.indexOf(':') ?? -1;
    const provider = colon > 0 && Object.hasOwn(PROVIDERS, model.slice(0, colon)) ? PROVIDERS[model.slice(0, colon)] : undefined;
    if (provider) {
      if (vendor !== undefined && vendor !== provider) throw new Error(`--model ${model} is a ${provider} model but --vendor is ${vendor}`);
      vendor = provider; model = model.slice(colon + 1);
      if (!model) throw new Error('--model <provider>:<model> needs a model name');
    }
    // effort 이름 오타는 카드를 열기 전에 거절 — slcode CLI 의 checkNew 와 같은 목록 (Codex 는 모델마다 열려 있어 보지 않는다)
    if (a.effort !== undefined && vendor !== 'codex' && !CLAUDE_EFFORTS.includes(a.effort)) throw new Error(`unknown effort '${a.effort}' for claude (${CLAUDE_EFFORTS.join('|')})`);
    const key = newKey();
    const done = new Promise((resolve, reject) => waits.set(key, { resolve, reject }));
    try {
      const w = await windowFor(ctx.tmux);
      await w.call(CARDS, 'open', { key, spawn: { cwd: a.cwd ?? ctx.cwd, vendor, title: a.title, mode: a.mode, model, effort: a.effort, prompt: a.prompt }, title: a.title, tmux: ctx.tmux });
      return await done;
    } finally { waits.delete(key); }
  });
  // 셸 동사 — `slcode resume`·`continue` (ticket slcode-resume-like-new). --id 면 그 세션의 카드를 활성화하고 없으면 요청자 deck 에
  // resume 카드로. --id 가 없으면 그 폴더의 꺼진 세션을 고르는 카드. 기동을 기다리지 않는다
  api.verbs.handle('slcode.resume', async (a, ctx) => {
    const w = await windowFor(ctx.tmux);
    if (a.id) { await w.call(CARDS, 'open', { id: a.id, tmux: ctx.tmux }); return a.id; }
    await w.call(CARDS, 'open', { pick: a.cwd ?? ctx.cwd, tmux: ctx.tmux });
  });

  shutdown = () => { for (const w of waits.values()) w.reject(new Error('slcode 플러그인이 내려갔습니다')); waits.clear(); };
  return {
    /** 다른 플러그인용 (같은 머신 main 의 plugins.get) — 세션 id 로 카드 열기 (이 머신의 메인 창에) */
    open: async (id) => { await (await windowFor(null)).call(CARDS, 'open', { id }); },
  };
}

let shutdown = () => {};
export function deactivate() { shutdown(); }
