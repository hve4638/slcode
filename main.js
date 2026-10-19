// slcode 플러그인 (옛 id agent, ticket agent-plugin-card, 사용자 확정 2026-10-04) — 카드 하나 = slcode 세션 하나.
//
// 세 층: (1) 기동 — 카드가 열리면 card 단위 백그라운드 서비스로 `slcode new --stdio --no-web` 을 띄운다 (lifetime owned, owner 는
// card id: 터미널 카드처럼 카드를 제거하면 세션도 끝나고 deck 을 닫는 것으로는 끝나지 않는다 — 사용자 2026-10-11, 2026-10-04 의 "카드를
// 제거해도 세션은 산다" 를 바꿈. 카드를 두고 세션만 끄는 길은 slcode 웹의 "세션 종료"·사이드바 우클릭 "Force close"·팔레트
// "slcode: Close session"·터미널 `slcode close`). (2) 화면 — slcode 가 stdout 첫 줄로
// 보내는 hello {id,sock} 로 세션을 알고, 화면은 serve 가 stdio 로 준 화면 파일(web.files)을 주소 없는 sandbox iframe 에 넣는다. 화면은 이 플러그인이
// 건넨 MessagePort 로만 말하고 플러그인이 stdio 로 중계한다 — /svc 토큰 주소가 없어 토큰이 폐기돼 멈추는 일이 없다 (ticket slcode-card-svc-token-dead).
// web.files 가 없는 옛 serve 는 서비스 웹(매니페스트 web)을 conn.webUrl() 의 superlite /svc 주소로 iframe 에 넣는다 (ticket plugin-service-web). (3) 상태 — 같은 stdio 통로가 UDS 와 같은
// 프레임 연결이라 session.attach 로 이벤트를 받아 배지·알림 센터에 반영한다. 선구독 services.onMessage 를 start 전에 걸어 첫 줄을
// 놓치지 않는다. 카드의 서비스·플랫폼·deploy 는 카드 ctx 의 것(카드 세션에 묶인다 — superlite ticket plugin-api-card-session)이라
// 사용자가 다른 세션 탭을 보는 동안에도 카드가 자기 세션의 데몬과 주고받는다. ctx 에 services 가 없는 옛 superlite 는 api 의 것(활성 세션).
// 세션 목록은 액티비티바 "slcode" 뷰릿(`slcode list`, 살아 있는 세션만). superlite 등록부·동사 연동은 없다(후속).

const VIEW = 'session';
const SIDEBAR = 'sessions';
const SVC = 'session';
const DEFAULT_NAME = 'SLCode'; // 이름 없는 세션의 카드 제목 (slcode 웹의 기본 이름과 같다)
const PICK_NAME = 'Resume'; // 고르기 전 resume 카드의 제목 — deck 에서 이름 없는 세션 카드와 갈리게
const FAR = Number.MAX_SAFE_INTEGER; // attach since — 이력은 iframe 이 그린다, 여기선 pending 만
// 이 창의 표 — 카드 서비스의 stdio 는 같은 폴더를 연 모든 superlite 창에 방송된다. 요청 id 앞에 붙여 다른 창의 응답을 가려낸다 (ticket slcode-card-svc-token-dead)
const WIN = Math.random().toString(36).slice(2, 8);

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
/** 꺼진 시각 표기 — CLI 의 id 없는 resume 목록과 같은 YYYY-MM-DD HH:MM */
export function stamp(t) {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
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
const MB = (n) => (n / 1048576).toFixed(0);
/** api.folder.fetch 의 진행 → 카드 문구 */
export function progressText(version, platform, p) {
  const head = `slcode ${version} (${platform})`;
  if (p?.phase === 'extract') return `${head} 푸는 중 ${p.done}/${p.total}`;
  if (p?.total) return `${head} 받는 중 ${Math.floor((p.done / p.total) * 100)}% (${MB(p.done)}/${MB(p.total)}MB)`;
  return `${head} 받는 중 ${MB(p?.done ?? 0)}MB`;
}

/** @param {import('@superlite/plugin').PluginApi} api */
export function activate(api) {
  api.settings.register({
    title: 'slcode',
    description: 'slcode 세션 카드. 카드를 닫아도 세션은 산다. 종료는 팔레트의 "slcode: Close session".',
    items: [
      { key: 'bin', type: 'string', label: 'slcode command', description: '비우면 플러그인이 받은 slcode. 넣으면 그것을 쓴다 (PATH 의 이름 또는 데몬 머신의 절대 경로)', default: '' },
      { key: 'dir', type: 'string', label: 'SLCODE_DIR', description: '비우면 slcode 기본 폴더 (~/.local/state/slcode)', default: '' },
    ],
  });
  const setting = async (k, d) => { const v = await api.settings.get(k); return v === undefined || v === '' ? d : String(v); };
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

  // ---- 바이너리 받기 — api.folder(호스트 플러그인 폴더: read·fetch·deploy)·api.platform (ticket plugin-fetch-deploy, superlite 0.13+)
  const folder = () => {
    if (!api.folder || !api.platform) throw new Error('이 superlite 는 플러그인 바이너리 받기를 지원하지 않습니다. 설정 "slcode command" 에 slcode 경로를 넣으세요');
    return api.folder;
  };
  /** plugin.json binary {repo, version} */
  let binarySpec = null;
  async function spec() {
    if (!binarySpec) {
      const b = JSON.parse((await folder().read('plugin.json')) ?? '{}').binary;
      if (typeof b?.repo !== 'string' || typeof b?.version !== 'string') throw new Error('plugin.json 에 binary {repo, version} 이 없습니다');
      binarySpec = b;
    }
    return binarySpec;
  }
  /** 플랫폼별 받기 — 여러 카드가 동시에 열려도 한 번. 진행 문구는 합류한 모든 호출(카드)에 보낸다 — activate 의 목록 갱신이 먼저
   *  시작해도 뒤에 열린 카드가 진행을 본다. 끝나면 비워 다음 기동 때 manifest 를 다시 본다 (읽기 하나라 싸다) */
  const installing = new Map();
  function install(plat, note) {
    let job = installing.get(plat);
    if (!job) {
      job = { notes: new Set(), last: null };
      const say = (s) => { job.last = s; for (const n of job.notes) n(s); };
      job.p = (async () => {
        const { repo, version: cond } = await spec();
        const sub = `bin/${plat}`;
        if (installState(await folder().read(`${sub}/manifest.json`), cond, plat) === 'installed') return;
        say('slcode 버전 확인 중…');
        const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`);
        if (!r.ok) throw new Error(`GitHub ${repo} releases 조회 실패 (${r.status})`);
        const pick = pickRelease(await r.json(), cond, plat);
        if (pick.error) throw new Error(pick.error);
        say(progressText(pick.version, plat, { phase: 'download', done: 0, total: null }));
        const { manifest } = await folder().fetch(pick.url, sub, { onProgress: (pr) => say(progressText(pick.version, plat, pr)) });
        if (installState(manifest == null ? null : JSON.stringify(manifest), cond, plat) !== 'installed') {
          throw new Error(`받은 zip 의 manifest.json 이 맞지 않습니다 (기대 ${pick.version} ${plat}, 받음 ${JSON.stringify(manifest)})`);
        }
      })();
      installing.set(plat, job);
      job.p.then(() => installing.delete(plat), () => installing.delete(plat));
    }
    job.notes.add(note);
    if (job.last) note(job.last);
    return job.p;
  }
  /** 서비스·목록·런처가 쓸 slcode — 설정 bin 이 있으면 그것(셸에 그대로), 없으면 받은 바이너리의 데몬 쪽 경로
   *  `<플러그인 폴더>/bin/<platform>/bin/slcode`. cmd 는 셸 명령에 넣을 꼴, path 는 따옴표 없는 경로 (설정이면 null) */
  async function resolveBin(note = () => {}, at = api) {
    const over = await setting('bin', '');
    if (over) return { cmd: over, path: null };
    folder(); // api.folder·platform 이 없는 superlite 면 여기서 사유를 던진다
    const plat = platformOf(await at.platform()); // at 의 데몬 머신(카드면 카드 세션) — 세션(로컬·원격)마다 다르다
    await install(plat, note);
    // 원격이면 올린 사본, 로컬이면 그대로 (해시 캐시는 relay 몫이라 매번 불러도 된다). 첫 업로드는 10초 남짓이라 오래 걸릴 때만 알린다
    // — 로컬은 바로 끝나 문구가 깜빡이지 않는다
    const slow = setTimeout(() => note('slcode 를 원격에 올리는 중… (원격마다 처음 한 번)'), 400);
    let dir;
    try { dir = await at.folder.deploy(`bin/${plat}`); } finally { clearTimeout(slow); }
    if (plat === 'win-x64') { const path = `${dir}\\bin\\slcode.cmd`; return { cmd: `"${path}"`, path, plat }; }
    const path = `${dir}/bin/slcode`;
    return { cmd: shq(path), path, plat };
  }

  /** key → 카드 하나. 뷰가 unmount/mount 를 거듭해도(카드 전환) 연결은 여기 산다 */
  const cards = new Map();
  const card = (key) => { let c = cards.get(key); if (!c) { c = { key, id: null, url: null, title: null, state: null, conn: null, unsub: null, ctx: null, el: null, nextId: 1, pending: new Map(), waits: new Map(), starting: null, note: null, error: null, pick: null, closing: false }; cards.set(key, c); } return c; };
  const newKey = () => 's' + Math.random().toString(36).slice(2, 8);
  /** 카드가 쓸 api 묶음 — 카드 ctx 가 세션 묶음(services 등)을 실어 오면 그것(카드 세션의 데몬), 아니면 api(활성 세션 — 옛 superlite) */
  const apiOf = (c) => (c.ctx?.services ? c.ctx : api);
  /** 서비스 owner — card id (ctx.card, 보존 card 는 보관소 id). 코어가 카드 제거 때 이 값으로 owned 서비스를 끝낸다. 없으면(옛 superlite) key */
  const ownerOf = (c) => c.cardId ?? c.key;
  /** 세션 id → 그 세션을 띄운 카드의 key. 같은 세션을 다시 열 때 다른 브라우저가 연 그 카드를 활성화하기 위해 플러그인 저장소에 남긴다 */
  let owners = null;
  const ownerMap = async () => (owners ??= (await api.storage.get('owners')) ?? {});
  // 세션 id → 카드 key. url 은 두지 않는다 — 브라우저마다 접속 호스트가 달라 고쳐 쓴 url 을 공유하면 안 된다 (다시 붙을 땐 server.info 가 준다)
  const remember = async (c) => { const m = await ownerMap(); if (m[c.id] !== c.key) { m[c.id] = c.key; await api.storage.set('owners', m); } };
  const keyOf = async (id) => { const o = (await ownerMap())[id]; return typeof o === 'string' ? o : o?.key ?? null; }; // 객체 꼴은 잠시 쓰던 형식

  // ---- 프레임 (slcode 프로토콜과 같은 꼴)
  function request(c, method, params) {
    const id = `${WIN}.${c.nextId++}`;
    return new Promise((resolve, reject) => {
      c.pending.set(id, { resolve, reject });
      apiOf(c).services.send(SVC, { id, method, params }, { owner: ownerOf(c) }).catch((e) => { c.pending.delete(id); reject(e); });
    });
  }
  function onMessage(c, m) {
    if (!m || typeof m !== 'object') return;
    if ('url' in m && 'sock' in m) { // hello
      c.hello = true; c.id = m.id ?? c.id;
      applyUrl(c); if (!c.attached) void attach(c); if (c.id) void remember(c);
      handedOver(c);
      return;
    }
    if (m.event) { onEvent(c, m.event, m.params); c.port?.postMessage(m); return; }
    if (m.id !== undefined && c.fwd?.has(m.id)) { const id = c.fwd.get(m.id); c.fwd.delete(m.id); c.port?.postMessage({ ...m, id }); return; }
    if (m.id !== undefined && c.pending.has(m.id)) {
      const p = c.pending.get(m.id); c.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message ?? 'error')) : p.resolve(m.result);
    }
  }
  function onEvent(c, event, p) {
    if (event === 'session.changed') { c.state = p.state; c.title = p.title; applyTitle(c); badge(c); return; }
    if (event === 'session.closed') { c.state = 'exited'; c.waits.clear(); badge(c); void countLive(); return; }
    if (event !== 'session.event') return;
    const ev = p.ev;
    if (ev.kind === 'approval.requested') {
      c.waits.set(ev.requestId, ev); badge(c);
      const isQ = ev.name === 'AskUserQuestion';
      const what = isQ ? (ev.input?.questions?.[0]?.question ?? '질문') : `${ev.name} ${summary(ev.input)}`;
      api.notify('warning', `${isQ ? '질문' : '승인 대기'}: ${what}`, { label: '열기', run: () => openCard(c.key) }, c.ctx?.tabId ? { card: c.ctx.tabId } : undefined);
    } else if (ev.kind === 'approval.resolved') { c.waits.delete(ev.requestId); badge(c); }
    else if (ev.kind === 'session.state') { c.state = ev.state; badge(c); }
  }
  // 웹 화면(toolArg)과 같은 한 줄 — Bash 는 명령, 파일 도구는 경로. 그 밖은 JSON
  const summary = (input) => { try { const v = input?.command ?? input?.file_path ?? input?.pattern ?? input?.description; const s = typeof v === 'string' ? v : JSON.stringify(input ?? {}); return s.length > 80 ? s.slice(0, 80) + '…' : s; } catch { return ''; } };

  // ---- 카드 표면
  function badge(c) {
    if (!c.ctx) return;
    const n = c.waits.size;
    c.ctx.setBadge(c.moved ? null : n ? (n > 1 ? `!${n}` : '!') : c.state === 'running' ? '…' : c.state === 'exited' ? 'off' : null);
  }
  function applyTitle(c) { if (c.ctx) c.ctx.setTitle(c.title || (c.pick && !c.id ? PICK_NAME : DEFAULT_NAME)); } // 카드 제목 = 세션 이름 (slcode 웹 왼쪽 상단에서 고친다), 없으면 SLCode
  function applyUrl(c) {
    // state 는 {key, id} 만 — 보존 card 라 보관소에 적혀 모든 브라우저가 같이 본다. url(/svc 토큰)은 연결마다 새로 받는다
    if (c.ctx && c.savedId !== c.id) { c.savedId = c.id; c.ctx.setState({ key: c.key, id: c.id }); }
    applyTitle(c);
    if (c.el && c.shown !== shownKey(c)) render(c); // 같은 주소면 iframe 을 다시 만들지 않는다 (다시 로드된다)
  }
  /** iframe 이 무엇을 띄우는가 — 카드 모드 화면(web.files, 주소 없음)이면 'port', 아니면 /svc 주소 */
  const shownKey = (c) => (c.web ? 'port' : c.url);
  function render(c) {
    const el = c.el; if (!el) return;
    c.shown = shownKey(c);
    el.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc)';
    if (c.pick && !c.id) renderPicker(c, wrap);
    else if (c.web || c.url) {
      const f = document.createElement('iframe');
      f.title = 'slcode';
      // 카드 모드 화면 (ticket slcode-card-svc-token-dead) — 주소 없이 serve 가 준 card.html 을 sandbox(출처 없음)로. 화면은 slcode.ready 로
      // 포트를 청하고 그 포트로만 말한다. 모델 출력을 그리는 화면이라 superlite 화면에 닿지 않게 allow-same-origin 은 주지 않는다
      if (c.web) { f.sandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals'; f.srcdoc = c.web.html; } else f.src = c.url;
      c.frame = f; // 링크 열기 요청(slcode.open)의 출처 확인
      f.allow = 'clipboard-read; clipboard-write';
      // 배경은 slcode 웹과 같은 색(시스템 라이트·다크) — 숨겼다 다시 보일 때 안쪽이 그려지기 전 흰 화면이 번쩍였다
      f.style.cssText = 'flex:1;border:0;width:100%;height:100%;color-scheme:light dark;background:light-dark(#f7f7f8,#18181b)';
      // 카드가 보이게 되면 입력창으로 — 다른 출처라 직접 못 만지므로 iframe 에 포커스를 주고 메시지로 알린다
      const focusIn = () => requestAnimationFrame(() => { f.focus(); f.contentWindow?.postMessage({ type: 'slcode.focus' }, '*'); });
      c.io?.disconnect();
      c.io = new IntersectionObserver((es) => { if (es[0].isIntersecting) focusIn(); });
      c.io.observe(f);
      f.addEventListener('load', () => { if (f.offsetParent) focusIn(); });
      wrap.appendChild(f);
    } else {
      const p = document.createElement('div');
      p.style.cssText = 'margin:auto;font:13px system-ui;opacity:.8';
      p.textContent = c.moved ? '새 카드로 옮겨졌습니다' : c.error ? `slcode 를 준비하지 못했습니다: ${c.error}` : c.note ?? (c.state === 'exited' ? '세션이 닫혔습니다' :'slcode 세션을 띄우는 중…');
      if (c.error) { // 받기·기동 실패 — 사유를 보이고 다시 시도 (설정을 고친 뒤 등)
        p.style.cssText += ';max-width:80%;text-align:center;white-space:pre-wrap';
        const b = document.createElement('button');
        b.textContent = '다시 시도'; b.style.cssText = 'display:block;margin:10px auto 0';
        b.onclick = () => { c.error = null; c.state = null; render(c); void ensure(c); };
        p.appendChild(b);
      }
      wrap.appendChild(p);
    }
    el.appendChild(wrap);
  }

  /** id 없는 `slcode resume` 의 카드 (ticket slcode-resume-like-new) — c.pick 폴더의 꺼진 세션을 꺼진 순서(최근 먼저)로 보이고, 고르면 이 카드가
   *  그 세션을 resume 해 대화 화면이 된다. 목록은 `slcode list --all` 에서 그 폴더·live 아닌 것 */
  function renderPicker(c, wrap) {
    wrap.style.overflow = 'auto';
    const { root, list } = listFrame(wrap);
    const head = document.createElement('div'); head.className = 'meta'; head.textContent = `Closed sessions in ${c.pick}`;
    root.insertBefore(head, list);
    listSessions(apiOf(c), true, (note) => { list.textContent = note; }).then((rows) => { // 받기·원격 올리기 진행은 목록 자리에
      sessionButtons(list, closedRows(rows, c.pick), (s) => `${s.id} · ${s.vendor} · ${stamp(closedTime(s))}`, (s) => pickSession(c, s.id), { empty: '(no closed sessions)' });
    }, (e) => { list.textContent = `Failed to list sessions: ${e?.message ?? e}`; });
  }
  function pickSession(c, id) {
    c.pick = null; c.id = id;
    applyUrl(c); // card state {key, id} — pick 을 지운다 (새로고침 복원이 그 세션으로)
    render(c);
    void ensure(c);
  }

  // ---- 기동·연결 (attach-or-start). 선구독 → open(start+connect) → 이미 돌고 있었으면 hello 가 없으니 server.info 로 url·id
  async function ensure(c) {
    if (c.moved) return;
    if (c.conn || c.starting) return c.starting;
    c.starting = (async () => {
      let dropped = false; // 이 시도에서 연 연결이 끊겼다
      try {
        if (!c.unsub) c.unsub = apiOf(c).services.onMessage(SVC, (m) => onMessage(c, m), { owner: ownerOf(c) });
        c.error = null;
        const note = (s) => { c.note = s; if (!c.shown) render(c); }; // 다시 붙는 중(iframe 이 떠 있다)엔 문구로 덮지 않는다 — 덮으면 iframe 이 다시 로드된다 (ticket slcode-card-occasional-reload)
        const [bin, dir] = await Promise.all([resolveBin(note, apiOf(c)), setting('dir', '')]);
        c.note = null;
        if (c.lost && !canResume(c)) return; // 받는 사이 카드가 가려졌다(옛 superlite, 다른 세션으로) — 보이게 되면 resume 이 다시 부른다
        // 새 세션의 폴더·옵션은 slcode.new 동사가 준 것 (없으면 서비스 cwd = 워크스페이스 root)
        const sp = c.spawn ?? {};
        const verb = c.id ? `resume ${shq(c.id)}` : `new${sp.cwd ? ` ${shq(sp.cwd)}` : ''}${['vendor', 'title', 'mode'].map((k) => (sp[k] ? ` --${k} ${shq(sp[k])}` : '')).join('')}`;
        // --no-web: TCP 웹을 열지 않는다 — 화면은 서비스 웹 소켓(SUPERLITE_SERVICE_WEB)으로만
        // --takeover: 핸드오프의 새 카드 — 떠 있는 세션의 소유권을 옛 카드의 serve 에서 가져온다
        const command = `${bin.cmd} ${verb} --stdio --no-web${c.takeover && c.id ? ' --takeover' : ''}${dir ? ` --dir ${shq(dir)}` : ''}`;
        c.hello = false;
        const conn = await apiOf(c).services.open(SVC, { owner: ownerOf(c), command });
        c.conn = conn; c.lost = false; c.takeover = false; // 다시 띄울 때는 보통 resume — 그 사이 소유권이 다른 카드로 갔을 수 있다
        conn.onClose(() => {
          // 연결이 끊기면 /svc 토큰도 폐기된다 — 다시 붙어 새 주소를 받는다 (세션 재접속·서비스 재기동). url 은 비운다: 그 사이 다시
          // 그리면 죽은 토큰 주소로 iframe 을 만들어 relay 의 404 본문이 보였다
          c.conn = null; c.attached = false; c.url = null; c.lost = true; dropped = true; badge(c);
          portStatus(c, false); // 카드 모드 화면은 그대로 두고 끊겼다고만 — 다시 붙으면 같은 포트로 이어진다
          // 기다리던 응답(server.info·session.attach)은 이 연결로 오지 않는다 — 풀지 않으면 ensure 가 끝나지 않아 다시 붙지 못했다
          for (const p of c.pending.values()) p.reject(new Error('연결이 끊겼습니다'));
          c.pending.clear();
          setTimeout(() => resume(c), 1000);
        });
        if (!c.hello) { // 떠 있던 서비스에 붙었다 — hello 는 지나갔다. 세션 id 는 server.info 로
          const info = await request(c, 'server.info', {});
          c.id = info.session; void remember(c);
          handedOver(c); // 다른 브라우저가 먼저 새 카드의 서비스를 띄웠다 — 소유권은 이미 넘어왔다
        }
        // 카드 모드 화면 파일 — 이 serve 가 고정한 것. 옛 serve(web.files 없음)는 /svc 주소로
        const web = await request(c, 'web.files', {}).catch((e) => { if (dropped) throw e; return null; });
        if (web) c.web = web; else { c.web = null; c.url = await conn.webUrl(); }
        applyUrl(c); portStatus(c, true);
        void countLive();
        if (!c.attached) await attach(c); // 연결마다 한 번 — url·id 를 이미 알아도(새로고침 복원) 이벤트 구독은 새 연결에 걸어야 한다
      } catch (e) {
        if (dropped) return; // 붙는 도중 연결이 끊겼다 — 오류 화면 대신 onClose 의 resume 이 다시 붙는다
        c.state = 'exited'; c.note = null; c.error = String(e?.message ?? e); badge(c); render(c);
        api.notify('error', `slcode: ${c.error}`);
      } finally { c.starting = null; }
    })();
    return c.starting;
  }
  /** 카드가 화면에 보이는가 — 배경 세션의 카드는 에디터 영역째 숨겨져(v-show) 박스가 없다 */
  const shown = (c) => !!c.el && c.el.getClientRects().length > 0;
  /** 끊긴 카드가 지금 다시 붙어도 되는가 — 카드 ctx 가 세션 묶음을 실어 오면 마운트돼 있는 한 늘 (배경 세션이어도
   *  카드 세션의 연결로 붙는다). 옛 superlite 는 보일 때(= 카드의 세션이 활성일 때)만: api.services 는 활성 세션으로 가서, 배경 세션의
   *  카드가 붙으면 다른 세션의 연결로 붙어 server.info 응답을 못 받고 멈추거나 다른 데몬이면 "실행 중이 아니다" 로 끝났다
   *  (ticket slcode-card-dies-background) */
  const canResume = (c) => !!c.el && (!!c.ctx?.services || shown(c));
  /** 끊긴 카드 다시 붙기 — 지금 못 붙는 숨은 카드(옛 superlite)는 mount 의 관찰자가 보이게 될 때 다시 부른다 */
  function resume(c) { if (c.lost && !c.conn && c.state !== 'exited' && !c.closing && !c.moved && canResume(c)) void ensure(c); }
  async function attach(c) {
    if (!c.id || c.attached) return;
    c.attached = true;
    try {
      const r = await request(c, 'session.attach', { id: c.id, since: FAR });
      c.state = r.info.state; c.title = r.info.title;
      c.waits = new Map(r.pending.map((p) => [p.requestId, p]));
      applyTitle(c); badge(c);
    } catch { /* 닫히는 중 — onClose 가 처리 */ }
  }
  function detach(c) {
    c.unsub?.(); c.unsub = null;
    c.conn?.close().catch(() => {}); c.conn = null; c.attached = false;
    for (const p of c.pending.values()) p.reject(new Error('detached'));
    c.pending.clear();
  }

  // ---- 카드 모드 화면의 포트 (ticket slcode-card-svc-token-dead) — 화면 ↔ 이 플러그인 ↔ 서비스 stdio. 화면이 (다시) 로드될 때마다 새 포트를 준다
  // (브라우저가 숨은 iframe 을 다시 로드해도 스스로 살아난다). 화면 요청의 id 는 이 창의 표를 붙여 stdio 로 보내고, 응답은 원래 id 로 돌려준다
  function openPort(c) {
    c.port?.close();
    const ch = new MessageChannel();
    c.port = ch.port1; c.fwd = new Map(); c.portSeq = (c.portSeq ?? 0) + 1;
    const gen = c.portSeq;
    ch.port1.onmessage = (e) => {
      const m = e.data;
      if (m?.ui && typeof m.ui.key === 'string') { uiSet(m.ui.key, m.ui.value); return; }
      if (!m || m.id === undefined || typeof m.method !== 'string') return;
      if (!c.conn) { ch.port1.postMessage({ id: m.id, error: { code: 'closed', message: 'not connected' } }); return; }
      const id = `${WIN}.p${gen}.${m.id}`;
      c.fwd.set(id, m.id);
      apiOf(c).services.send(SVC, { id, method: m.method, params: m.params }, { owner: ownerOf(c) }).catch((err) => { c.fwd.delete(id); ch.port1.postMessage({ id: m.id, error: { code: 'closed', message: String(err?.message ?? err) } }); });
    };
    c.frame.contentWindow.postMessage({ type: 'slcode.port', files: c.web.files, ui: uiAll() }, '*', [ch.port2]);
    if (c.conn && c.web) ch.port1.postMessage({ status: { connected: true } });
  }
  // 카드 화면의 상태(사이드바 열림·inspect 남은 공간) — sandbox 화면 대신 이 superlite 페이지의 localStorage 에 (브라우저마다, 웹 모드와 같다)
  const UI_PREFIX = 'slcode.card.';
  const uiAll = () => {
    const out = {};
    try { const ls = globalThis.localStorage; for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k?.startsWith(UI_PREFIX)) out[k.slice(UI_PREFIX.length)] = ls.getItem(k); } } catch {}
    return out;
  };
  const uiSet = (k, v) => { try { globalThis.localStorage.setItem(UI_PREFIX + k, String(v)); } catch {} };
  function portStatus(c, connected) {
    if (!c.port) return;
    if (!connected) { for (const id of c.fwd.values()) c.port.postMessage({ id, error: { code: 'closed', message: 'connection closed' } }); c.fwd.clear(); }
    c.port.postMessage({ status: { connected } });
  }
  /** 화면이 다시 붙은 serve 가 자기를 낸 serve 와 다르다고 알렸다 — 연결마다 받아 둔 새 화면 파일(c.web)로 iframe 을 다시 만든다 */
  function reloadWeb(c) {
    if (!c.web) return;
    c.port?.close(); c.port = null;
    render(c);
  }

  // ---- serve 교체 (ticket slcode-core-serve-split 2단계, 사용자 확정 2026-10-14·2026-10-19) — 카드 화면의 [업데이트]·[restart required] 가 postMessage 로 부른다.
  // serve 의 stdio 를 거치지 않는 것은 그 카드를 띄운 모든 브라우저의 플러그인이 stdio 메시지를 받아 핸드오프가 여러 번 일어나기 때문이다
  /** [업데이트] — 지금 쓸 slcode(받기·원격 올리기 포함)에 version·build 를 물어 카드 serve 의 것(화면이 보낸 값)과 견준다.
   *  원격 deploy 경로는 내용 해시라 serve 가 자기 폴더를 봐서는 새 버전을 모른다 */
  async function checkUpdate(c, d) {
    const at = apiOf(c);
    const bin = await resolveBin(() => {}, at);
    const r = await at.proc.run(`${bin.cmd} --version --json`);
    let b = null;
    try { b = JSON.parse(r.stdout); } catch {}
    if (r.code !== 0 || typeof b?.version !== 'string') return { status: 'failed', reason: r.stderr.trim() || `exit ${r.code}` };
    return b.version !== d.version || String(b.build) !== String(d.build) ? { status: 'restart-required', version: b.version, build: b.build } : { status: 'latest' };
  }
  /** [restart required] — 이 카드 바로 다음에 새 카드를 열어(사용자가 보고 있으면 그쪽으로 넘어간다) 새 serve 가 --takeover 로 같은 세션을 이어받게 한다.
   *  새 카드의 hello 가 오면 이 카드는 moveOut 으로 정리된다. 새 카드가 뜨지 못하면 새 카드에 사유가 보이고 이 카드는 그대로다 (사용자 2026-10-19) */
  function handoff(a) {
    if (!a.id || !a.ctx?.tabId) throw new Error('세션이 아직 준비되지 않았습니다');
    const key = newKey(), b = card(key);
    b.id = a.id; b.takeover = true; b.from = a.key; b.title = a.title;
    api.views.open(VIEW, { key, id: a.id, takeover: true }, { as: 'card', key, title: a.title || DEFAULT_NAME, preserve: true, opener: a.ctx.tabId, focus: true });
    return { ok: true };
  }
  /** 핸드오프의 새 카드에 serve 가 붙었다(소유권을 가져왔다) — 옛 카드를 옮겨진 카드로, state 의 takeover 는 지운다 */
  function handedOver(b) {
    if (!b.from) return;
    const a = cards.get(b.from);
    b.from = null;
    b.ctx?.setState({ key: b.key, id: b.id });
    if (a) void moveOut(a);
  }
  /** 옮겨진 카드 — 서비스를 멈추고(소유권이 새 카드로 가서 세션은 산다) 안내를 보인 뒤 닫기 요청([D], 사용자가 확인한다).
   *  state·shared 에 남겨 새로고침·다른 브라우저에서도 다시 붙지 않는다. 옛 superlite 는 플러그인 카드를 닫지 못해 안내만 남는다 */
  async function moveOut(a) {
    const at = apiOf(a), owner = ownerOf(a), ctx = a.ctx;
    a.moved = true; a.url = null; a.web = null; a.waits.clear();
    detach(a); render(a); badge(a);
    ctx?.setState({ key: a.key, id: a.id, moved: true });
    void ctx?.shared?.set('moved', true).catch(() => {});
    await at.services.stop(SVC, { owner }).catch(() => {});
    if (ctx?.tabId) api.verbs.run('card.close', [ctx.tabId]).catch(() => {});
  }

  // ---- 뷰: 카드 (state {key, id?})
  api.views.register(VIEW, {
    title: 'slcode', icon: 'hubot',
    mount(el, ctx) {
      const st = ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
      if (!st.key) { el.textContent = 'slcode: 카드 전용 뷰'; return; }
      const c = card(st.key);
      c.id = c.id ?? st.id ?? null;
      if (!c.id && typeof st.pick === 'string') c.pick = st.pick; // 고르기 전 resume 카드 — 서비스를 띄우지 않는다
      if (st.moved) c.moved = true; // 핸드오프로 옮겨진 카드 — 다시 붙지 않는다
      if (st.takeover && c.takeover === undefined) c.takeover = true; // 핸드오프의 새 카드 (다른 브라우저가 먼저 mount 해도 소유권을 가져온다)
      c.ctx = ctx; c.el = el; c.cardId = ctx.card; c.savedId = st.id ?? null;
      // 다른 브라우저에서 옮겨졌다 (moveOut 의 shared) — 이 창의 연결도 끊고 안내만
      c.unshared?.(); c.unshared = ctx.shared?.on((k, v) => { if (k === 'moved' && v && !c.moved) { c.moved = true; c.url = null; c.web = null; detach(c); render(c); badge(c); } }) ?? null;
      c.onMount?.(); c.onMount = null;
      el.style.position = 'relative'; el.style.height = '100%';
      render(c); applyTitle(c); badge(c);
      // 마운트되지 않은 사이에 세션 id 가 바뀌었으면 card state 에 남긴다 (새로고침 복원)
      if (c.id && c.savedId !== c.id) { c.savedId = c.id; ctx.setState({ key: c.key, id: c.id }); }
      c.vis?.disconnect();
      c.vis = new IntersectionObserver((es) => { if (es[0].isIntersecting) resume(c); });
      c.vis.observe(el);
      if (!c.pick && !c.moved) void ensure(c);
    },
    unmount(el) { for (const c of cards.values()) if (c.el === el) { c.el = null; c.vis?.disconnect(); } },
  });
  /** 카드 열기 — 있는 세션이면 그 카드를 활성화, 없으면 새 카드(새 세션 또는 저장 세션 resume). near 면 새 카드를 요청자 터미널의
   *  deck 에 붙인다 (slcode.resume) */
  async function openCard(key, id, near) {
    if (!key && id) { // 같은 세션의 카드가 여럿이면(닫힌 뒤 고르기 카드로 다시 연 경우) 꺼지지 않은 쪽
      const mine = [...cards.values()].filter((c) => c.id === id);
      key = (mine.find((c) => c.state !== 'exited' && !c.moved) ?? mine.find((c) => !c.moved) ?? mine[0])?.key;
    }
    if (!key && id) key = await keyOf(id); // 이 세션을 띄운 카드 — 다른 브라우저가 연 카드가 남아 있으면 그것을 활성화 (없으면 resume 으로 새로)
    if (!key) key = newKey();
    if (!cards.has(key)) card(key).id = id ?? null;
    const c = cards.get(key);
    if (id && c.state === 'exited' && !c.conn && !c.starting) { // 닫힌 세션의 카드가 남아 있다 — 활성화만 하면 "세션이 닫혔습니다" 그대로라 다시 띄운다
      c.state = null; c.error = null; badge(c);
      if (c.el) { render(c); void ensure(c); } // 마운트 전이면 mount 가 띄운다
    }
    const at = { as: 'card', key, title: DEFAULT_NAME, preserve: true };
    api.views.open(VIEW, { key, id: cards.get(key)?.id ?? id ?? null }, near ? { ...at, near } : at);
    if (near) api.views.open(VIEW, undefined, at); // near 는 뒤에서 붙인다 — 같은 key 로 한 번 더 열어 활성화 (있던 카드면 둘 다 활성화만)
  }
  // 셸 동사 — superlite 터미널 안의 `slcode`·`slcode new` 가 부른다 (ticket slcode-bare-new, 사용자 2026-10-07). 요청자 터미널이 앉은
  // deck 에 카드를 붙이고(views.open near — 이 옵션을 모르는 superlite 는 새 deck 으로) 그 카드로 포커스를 옮긴다 (사용자 2026-10-07
  // 데모 뒤 "바로 그 card 로" — near 는 뒤에서 붙이므로 같은 key 로 한 번 더 열어 활성화). 서비스는 여기서 띄워 세션 id 를 돌려준다
  // (심 stdout 한 줄)
  api.verbs.register({
    name: 'slcode.new',
    help: 'Open a slcode session card in the deck of this terminal; prints the session id',
    args: [
      { name: 'cwd', kind: 'option', value: 'dir', help: 'session folder (default: this shell\'s cwd)' },
      { name: 'vendor', kind: 'option', help: 'claude | codex' },
      { name: 'title', kind: 'option' },
      { name: 'mode', kind: 'option', help: 'default | acceptEdits | auto | bypassPermissions' },
    ],
    async run(a, ctx) {
      const key = newKey();
      const c = card(key);
      c.spawn = { cwd: a.cwd ?? ctx.cwd, vendor: a.vendor, title: a.title, mode: a.mode };
      const at = { as: 'card', key, title: a.title ?? DEFAULT_NAME, preserve: true };
      const mounted = new Promise((r) => { c.onMount = r; });
      api.views.open(VIEW, { key, id: null }, { ...at, near: ctx.tmux ?? undefined });
      api.views.open(VIEW, undefined, at); // 이미 있는 key — 활성화만
      await mounted; // 카드 ctx(카드 세션)가 온 뒤에 띄운다 — mount 가 부른 ensure 에 합친다
      await ensure(c);
      if (!c.id) throw new Error(c.error ?? 'slcode 세션을 띄우지 못했습니다');
      return c.id;
    },
  });
  // 셸 동사 — superlite 터미널 안의 `slcode resume`·`continue` 가 부른다 (ticket slcode-resume-like-new). --id 면 그 세션의 카드를
  // 활성화하고 없으면 요청자 deck 에 resume 카드로 (살아 있는 세션이면 카드 서비스의 `resume --stdio` 가 소켓 중계로 붙는다). --id 가
  // 없으면 그 폴더의 꺼진 세션을 고르는 카드. 세션 id 를 이미 알거나 고르기 전이라 기동을 기다리지 않는다
  api.verbs.register({
    name: 'slcode.resume',
    help: 'Open a saved slcode session as a card in the deck of this terminal; without --id, pick a closed session of --cwd',
    args: [
      { name: 'id', kind: 'option', help: 'session id' },
      { name: 'cwd', kind: 'option', value: 'dir', help: 'folder whose closed sessions to pick from (default: this shell\'s cwd)' },
    ],
    async run(a, ctx) {
      const near = ctx.tmux ?? undefined;
      if (a.id) { await openCard(undefined, a.id, near); return a.id; }
      const key = newKey();
      const pick = card(key).pick = a.cwd ?? ctx.cwd;
      const at = { as: 'card', key, title: PICK_NAME, preserve: true };
      api.views.open(VIEW, { key, id: null, pick }, { ...at, near });
      api.views.open(VIEW, undefined, at);
    },
  });

  // 카드 제거 — 코어가 owned 서비스를 끝낸다(세션 또는 중계). 여기서는 연결을 끊고 카드를 잊는다. ev.card 는 ctx.card 와 같은
  // 값(보존 card 는 보관소 id). 제거된 카드에 el 이 남아 있으면 끊긴 연결의 resume 이 서비스를 다시 띄워 세션이 되살아났다
  // (2026-10-11 실측) — 마운트돼 있지 않은 것으로 돌린다
  api.events.on({ kind: 'card.removed', pred: (ev) => ev.pluginId === 'slcode' }, (ev) => {
    const c = [...cards.values()].find((x) => x.cardId === ev.card); if (!c) return;
    c.el = null; c.vis?.disconnect(); c.io?.disconnect();
    detach(c); cards.delete(c.key);
    // 끝나는 세션은 프로세스가 내려가야(superlite 는 SIGTERM 3초 뒤 SIGKILL) 목록에서 빠진다 — 그 뒤에 다시 센다
    for (const ms of [1000, 4000]) setTimeout(countLive, ms);
  });

  // ---- 사이드바: 세션 목록 (slcode list — 살아 있는 세션만. 꺼짐과 끝남을 구분할 근거가 없어 꺼진 세션은 보이지 않는다, 사용자 2026-10-04)
  let listEl = null; // 열려 있는 사이드바 — 다시 셀 때 목록도 다시 그린다
  api.views.register(SIDEBAR, {
    title: 'slcode sessions', icon: 'hubot',
    mount(el) { listEl = el; void renderList(el); },
    unmount() { listEl = null; },
  });
  api.sidebar.register(SIDEBAR, { icon: 'hubot', title: 'slcode', view: SIDEBAR });
  // ponytail: 개수·목록은 활성화·카드 기동/종료·카드 제거·목록 그리기 때만 다시 센다. 터미널에서 띄우거나 끈 세션은 그 다음 계기까지 늦다 — 필요하면 주기 갱신
  /** `slcode list` 행 — at 의 데몬 머신에서 (카드면 카드 세션). all 이면 꺼진 세션까지 */
  async function listSessions(at = api, all = false, note = () => {}) {
    const [bin, dir] = await Promise.all([resolveBin(note, at), setting('dir', '')]);
    const r = await at.proc.run(`${bin.cmd} list${all ? ' --all' : ''}${dir ? ` --dir ${shq(dir)}` : ''}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    return JSON.parse(r.stdout || '[]');
  }
  async function listLive() {
    const rows = await listSessions();
    api.sidebar.setBadge(SIDEBAR, rows.length || null);
    return rows;
  }
  const countLive = () => (listEl ? renderList(listEl) : listLive()).catch(() => {});
  void countLive();
  /** 세션 목록의 틀 — 사이드바와 resume 카드가 같이 쓴다. root 에 머리를 더하고 list 를 sessionButtons 로 채운다 */
  function listFrame(el) {
    const style = document.createElement('style');
    style.textContent = `.l{font:12px system-ui;padding:6px;position:relative}.l button{display:block;width:100%;text-align:left;border:0;background:none;color:inherit;padding:4px 6px;border-radius:4px;cursor:pointer}.l button:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}.l .meta{opacity:.6;font-size:11px}.l .top{display:flex;gap:6px;margin-bottom:6px}.l .top button{width:auto;border:1px solid var(--vscode-widget-border,#444)}.l .menu{position:absolute;z-index:10;min-width:120px;padding:4px;background:var(--vscode-menu-background,#252526);border:1px solid var(--vscode-menu-border,#454545);border-radius:4px;box-shadow:0 2px 8px #0008}`;
    el.appendChild(style);
    const root = document.createElement('div'); root.className = 'l'; el.appendChild(root);
    const list = document.createElement('div'); root.appendChild(list);
    list.textContent = '…';
    return { root, list };
  }
  function sessionButtons(list, rows, meta, onPick, { empty = '(no sessions)', onMenu } = {}) {
    list.innerHTML = '';
    if (!rows.length) list.textContent = empty;
    for (const s of rows) {
      const b = document.createElement('button');
      b.append(document.createTextNode(s.title ?? s.id));
      const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta(s);
      b.appendChild(m);
      b.onclick = () => onPick(s);
      if (onMenu) b.oncontextmenu = (e) => { e.preventDefault(); onMenu(s, e); };
      list.appendChild(b);
    }
  }
  async function renderList(el) {
    el.innerHTML = '';
    const { root, list } = listFrame(el);
    const top = document.createElement('div'); top.className = 'top';
    const bNew = document.createElement('button'); bNew.textContent = '+ New session'; bNew.onclick = () => openCard();
    const bRef = document.createElement('button'); bRef.textContent = 'Refresh'; bRef.onclick = () => void renderList(el);
    top.append(bNew, bRef); root.insertBefore(top, list);
    try {
      const rows = await listLive();
      sessionButtons(list, rows.reverse(), (s) => `${s.id} · ${s.vendor} · ${s.cwd}`, (s) => openCard(undefined, s.id),
        { onMenu: (s, e) => rowMenu(root, e, 'Force close', () => void forceClose(s.id, el)) });
    } catch (e) { list.textContent = `Failed to list sessions: ${e?.message ?? e}`; }
  }
  /** 행 우클릭 메뉴 — 플러그인 API 에 메뉴가 없어 뷰 안에 그린다. 바깥을 누르거나 Esc 면 닫는다 */
  function rowMenu(root, e, label, run) {
    root.querySelector('.menu')?.remove();
    const m = document.createElement('div'); m.className = 'menu';
    const away = (ev) => { if (!ev.composedPath().includes(m)) close(); }; // 뷰는 shadow DOM 안 — document 에서 본 target 은 호스트로 바뀐다
    const esc = (ev) => { if (ev.key === 'Escape') close(); };
    const close = () => { m.remove(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc, true); };
    const b = document.createElement('button'); b.textContent = label; b.onclick = () => { close(); run(); };
    m.appendChild(b); root.appendChild(m);
    // root 기준 좌표 — 사이드바 칸이 fixed 의 기준이 되어 창 좌표가 칸 원점만큼 밀렸다. 오른쪽 끝은 넘지 않게
    const r = root.getBoundingClientRect();
    m.style.left = `${Math.max(0, Math.min(e.clientX - r.left, root.clientWidth - m.offsetWidth))}px`; m.style.top = `${e.clientY - r.top}px`;
    document.addEventListener('mousedown', away, true); document.addEventListener('keydown', esc, true);
  }
  /** 사이드바 강제 종료 (사용자 2026-10-11) — `slcode close --force`: 정상 종료, 3초 안에 안 닫히면 kill. kill 로 끊긴 카드는 session.closed 를
   *  못 받아 resume 이 persistent 서비스를 다시 띄우면 세션이 되살아난다 — 그동안 closing 으로 막고, 끝나면 닫힌 카드로 둔다 */
  async function forceClose(id, el) {
    const mine = [...cards.values()].filter((c) => c.id === id);
    for (const c of mine) c.closing = true;
    try {
      const [bin, dir] = await Promise.all([resolveBin(), setting('dir', '')]);
      const r = await api.proc.run(`${bin.cmd} close ${shq(id)} --force${dir ? ` --dir ${shq(dir)}` : ''}`);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      for (const c of mine) { c.state = 'exited'; c.url = null; c.web = null; c.waits.clear(); badge(c); render(c); }
    } catch (e) { api.notify('error', `slcode: ${e?.message ?? e}`); }
    finally { for (const c of mine) c.closing = false; }
    void renderList(el);
  }

  // ---- 팔레트
  api.commands.register({ id: 'new', title: 'slcode: New session (card)', run: () => openCard() });
  api.commands.register({
    id: 'close', title: 'slcode: Close session (active card)', run: () => {
      const c = [...cards.values()].find((x) => x.el); // 플러그인 뷰는 활성 카드일 때만 mount 되어 있다
      if (!c || !c.id) { api.notify('info', 'slcode: 열린 세션 카드가 없습니다'); return; }
      request(c, 'session.close', { id: c.id }).catch((e) => api.notify('error', `slcode: ${e.message}`));
    },
  });

  // PATH 런처 — 명시적 명령으로만 (자동 실행 없음). Linux ~/.local/bin/slcode 심링크, Windows 는 사용자 PATH 에 기본으로 있는
  // %LOCALAPPDATA%\Microsoft\WindowsApps 에 slcode.cmd. 런처는 지금 받은 바이너리를 가리킨다 — 새 버전을 받으면 다시 실행한다
  async function installCommand(force) {
    const bin = await resolveBin();
    if (!bin.path) throw new Error('설정 "slcode command" 를 쓰는 중이라 런처를 만들지 않습니다 (설정을 비우면 받은 바이너리로 만든다)');
    if (bin.plat === 'win-x64') {
      const r = await api.proc.run(`(echo @"${bin.path}" %*) > "%LOCALAPPDATA%\\Microsoft\\WindowsApps\\slcode.cmd"`);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
      return '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\slcode.cmd';
    }
    const link = '~/.local/bin/slcode';
    if (!force) { // 우리 것이 아닌 slcode 가 이미 있으면 묻는다
      const cur = await api.proc.run(`if [ -L ${link} ]; then readlink ${link}; elif [ -e ${link} ]; then echo '(file)'; fi`);
      const was = cur.stdout.trim();
      if (was && was !== bin.path) return { conflict: was };
    }
    const r = await api.proc.run(`mkdir -p ~/.local/bin && ln -sfn ${shq(bin.path)} ${link}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    return link;
  }
  const runInstallCommand = (force) => installCommand(force).then((r) => {
    if (typeof r === 'string') api.notify('info', `slcode 런처를 만들었습니다: ${r}`);
    else api.notify('warning', `이미 slcode 가 있습니다: ~/.local/bin/slcode → ${r.conflict}`, { label: '덮어쓰기', run: () => void runInstallCommand(true) });
  }).catch((e) => api.notify('error', `slcode: ${e?.message ?? e}`));
  api.commands.register({ id: 'installCommand', title: 'slcode: Install command', run: () => runInstallCommand(false) });

  // 카드 안 답변의 링크·이미지 (web/app.js, ticket slcode-append-system-prompt) — slcode.open 은 superlite 의 open 동사(웹 주소는 URL 탭, 파일은 에디터),
  // slcode.download 는 download 동사(로컬 파일을 Download 뷰 대기열에 — 사용자가 확인하면 이 PC 로)
  const VERB = { 'slcode.open': 'open', 'slcode.download': 'download' };
  // slcode.update·slcode.restart 는 [업데이트]·[restart required] — 결과를 {re: 요청 id, result | error} 로 그 iframe 에 돌려준다
  const HOST = { 'slcode.update': checkUpdate, 'slcode.restart': handoff };
  const onOpen = (e) => {
    const c = [...cards.values()].find((x) => x.frame?.contentWindow === e.source);
    if (!c) return;
    if (e.data?.type === 'slcode.ready' && c.web) { openPort(c); return; }
    if (e.data?.type === 'slcode.reload') { reloadWeb(c); return; }
    const host = HOST[e.data?.type];
    if (host) {
      const answer = (o) => e.source.postMessage({ re: e.data.id, ...o }, '*');
      (async () => host(c, e.data))().then((result) => answer({ result }), (err) => answer({ error: String(err?.message ?? err) }));
      return;
    }
    const verb = VERB[e.data?.type];
    if (!verb || typeof e.data.target !== 'string') return;
    api.verbs.run(verb, [e.data.target]).catch((err) => api.notify('error', `slcode: ${err?.message ?? err}`));
  };
  globalThis.window?.addEventListener('message', onOpen); // 테스트(node)엔 window 가 없다
  shutdown = () => { globalThis.window?.removeEventListener('message', onOpen); for (const c of cards.values()) detach(c); cards.clear(); };
  return {
    /** 다른 플러그인용 — 세션 id 로 카드 열기 */
    open: (id) => openCard(undefined, id),
  };
}

let shutdown = () => {};
export function deactivate() { shutdown(); }
