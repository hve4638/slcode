// slcode 플러그인 (옛 id agent, ticket agent-plugin-card, 사용자 확정 2026-10-04) — 카드 하나 = slcode 세션 하나.
//
// 세 층: (1) 기동 — 카드가 열리면 card 단위 백그라운드 서비스로 `slcode new --stdio --no-web` 을 띄운다 (lifetime persistent:
// 카드를 제거해도 세션은 산다, 종료는 팔레트 "Agent: Close session" 또는 터미널 `slcode close`). (2) 화면 — slcode 가 stdout 첫 줄로
// 보내는 hello {id,sock} 로 세션을 알고, 화면은 서비스 웹(매니페스트 web — slcode 가 SUPERLITE_SERVICE_WEB 에 연다)을 conn.webUrl() 의
// superlite /svc 주소로 iframe 에 넣는다 — 포트를 따로 열지 않아 웹 모드·원격에서도 열린다 (ticket plugin-service-web). (3) 상태 — 같은 stdio 통로가 UDS 와 같은
// 프레임 연결이라 session.attach 로 이벤트를 받아 배지·알림 센터에 반영한다. 선구독 api.services.onMessage 를 start 전에 걸어 첫 줄을
// 놓치지 않는다. 세션 목록은 액티비티바 "Agent" 뷰릿(`slcode list`, 살아 있는 세션만). superlite 등록부·동사 연동은 없다(후속).

const VIEW = 'session';
const SIDEBAR = 'sessions';
const SVC = 'session';
const DEFAULT_NAME = 'SLCode'; // 이름 없는 세션의 카드 제목 (slcode 웹의 기본 이름과 같다)
const FAR = Number.MAX_SAFE_INTEGER; // attach since — 이력은 iframe 이 그린다, 여기선 pending 만

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
    title: 'Agent',
    description: 'slcode 세션 카드. 카드 하나 = 세션 하나. 카드를 닫아도 세션은 산다 — 종료는 "Agent: Close session".',
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
  async function resolveBin(note = () => {}) {
    const over = await setting('bin', '');
    if (over) return { cmd: over, path: null };
    folder(); // api.folder·platform 이 없는 superlite 면 여기서 사유를 던진다
    const plat = platformOf(await api.platform()); // 활성 세션의 데몬 머신 — 세션(로컬·원격)마다 다르다
    await install(plat, note);
    // 원격이면 올린 사본, 로컬이면 그대로 (해시 캐시는 relay 몫이라 매번 불러도 된다). 첫 업로드는 10초 남짓이라 오래 걸릴 때만 알린다
    // — 로컬은 바로 끝나 문구가 깜빡이지 않는다
    const slow = setTimeout(() => note('slcode 를 원격에 올리는 중… (원격마다 처음 한 번)'), 400);
    let dir;
    try { dir = await folder().deploy(`bin/${plat}`); } finally { clearTimeout(slow); }
    if (plat === 'win-x64') { const path = `${dir}\\bin\\slcode.cmd`; return { cmd: `"${path}"`, path, plat }; }
    const path = `${dir}/bin/slcode`;
    return { cmd: shq(path), path, plat };
  }

  /** key → 카드 하나. 뷰가 unmount/mount 를 거듭해도(카드 전환) 연결은 여기 산다 */
  const cards = new Map();
  const card = (key) => { let c = cards.get(key); if (!c) { c = { key, id: null, url: null, title: null, state: null, conn: null, unsub: null, ctx: null, el: null, nextId: 1, pending: new Map(), waits: new Map(), starting: null, note: null, error: null }; cards.set(key, c); } return c; };
  const newKey = () => 's' + Math.random().toString(36).slice(2, 8);
  /** 세션 id → 서비스 owner(카드 key). 같은 세션을 다시 열 때 새 서비스를 띄우지 않고 떠 있는 것에 붙기 위해 플러그인 저장소에 남긴다 */
  let owners = null;
  const ownerMap = async () => (owners ??= (await api.storage.get('owners')) ?? {});
  // 세션 id → 서비스 owner. url 은 두지 않는다 — 브라우저마다 접속 호스트가 달라 고쳐 쓴 url 을 공유하면 안 된다 (다시 붙을 땐 server.info 가 준다)
  const remember = async (c) => { const m = await ownerMap(); if (m[c.id] !== c.key) { m[c.id] = c.key; await api.storage.set('owners', m); } };
  const ownerOf = async (id) => { const o = (await ownerMap())[id]; return typeof o === 'string' ? o : o?.key ?? null; }; // 객체 꼴은 잠시 쓰던 형식

  // ---- 프레임 (slcode 프로토콜과 같은 꼴)
  function request(c, method, params) {
    const id = c.nextId++;
    return new Promise((resolve, reject) => {
      c.pending.set(id, { resolve, reject });
      api.services.send(SVC, { id, method, params }, { owner: c.key }).catch((e) => { c.pending.delete(id); reject(e); });
    });
  }
  function onMessage(c, m) {
    if (!m || typeof m !== 'object') return;
    if ('url' in m && 'sock' in m) { // hello
      c.hello = true; c.id = m.id ?? c.id;
      applyUrl(c); if (!c.attached) void attach(c); if (c.id) void remember(c);
      return;
    }
    if (m.event) { onEvent(c, m.event, m.params); return; }
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
  const summary = (input) => { try { const s = JSON.stringify(input ?? {}); return s.length > 80 ? s.slice(0, 80) + '…' : s; } catch { return ''; } };

  // ---- 카드 표면
  function badge(c) {
    if (!c.ctx) return;
    const n = c.waits.size;
    c.ctx.setBadge(n ? (n > 1 ? `!${n}` : '!') : c.state === 'running' ? '…' : c.state === 'exited' ? 'off' : null);
  }
  function applyTitle(c) { if (c.ctx) c.ctx.setTitle(c.title || DEFAULT_NAME); } // 카드 제목 = 세션 이름 (slcode 웹 왼쪽 상단에서 고친다), 없으면 SLCode
  function applyUrl(c) {
    // state 는 {key, id} 만 — 보존 card 라 보관소에 적혀 모든 브라우저가 같이 본다. url(/svc 토큰)은 연결마다 새로 받는다
    if (c.ctx && c.savedId !== c.id) { c.savedId = c.id; c.ctx.setState({ key: c.key, id: c.id }); }
    applyTitle(c);
    if (c.el && c.shown !== c.url) render(c); // 같은 주소면 iframe 을 다시 만들지 않는다 (다시 로드된다)
  }
  function render(c) {
    const el = c.el; if (!el) return;
    c.shown = c.url;
    el.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc)';
    if (c.url) {
      const f = document.createElement('iframe');
      f.src = c.url; f.title = 'slcode';
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
      p.textContent = c.error ? `slcode 를 준비하지 못했습니다: ${c.error}` : c.note ?? (c.state === 'exited' ? '세션이 닫혔습니다 — 목록에서 다시 여세요' : 'slcode 세션을 띄우는 중…');
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

  // ---- 기동·연결 (attach-or-start). 선구독 → open(start+connect) → 이미 돌고 있었으면 hello 가 없으니 server.info 로 url·id
  async function ensure(c) {
    if (c.conn || c.starting) return c.starting;
    c.starting = (async () => {
      try {
        if (!c.unsub) c.unsub = api.services.onMessage(SVC, (m) => onMessage(c, m), { owner: c.key });
        c.error = null;
        const note = (s) => { c.note = s; render(c); };
        const [bin, dir] = await Promise.all([resolveBin(note), setting('dir', '')]);
        c.note = null;
        // 새 세션의 폴더·옵션은 slcode.new 동사가 준 것 (없으면 서비스 cwd = 워크스페이스 root)
        const sp = c.spawn ?? {};
        const verb = c.id ? `resume ${shq(c.id)}` : `new${sp.cwd ? ` ${shq(sp.cwd)}` : ''}${['vendor', 'title', 'mode'].map((k) => (sp[k] ? ` --${k} ${shq(sp[k])}` : '')).join('')}`;
        // --no-web: TCP 웹을 열지 않는다 — 화면은 서비스 웹 소켓(SUPERLITE_SERVICE_WEB)으로만
        const command = `${bin.cmd} ${verb} --stdio --no-web${dir ? ` --dir ${shq(dir)}` : ''}`;
        c.hello = false;
        const conn = await api.services.open(SVC, { owner: c.key, command });
        c.conn = conn;
        conn.onClose(() => {
          c.conn = null; c.attached = false; badge(c);
          // 연결이 끊기면 /svc 토큰도 폐기된다 — 보이는 카드면 다시 붙어 새 주소를 받는다 (세션 재접속·서비스 재기동)
          if (c.el && c.state !== 'exited') setTimeout(() => { if (c.el && !c.conn) void ensure(c); }, 1000);
        });
        if (!c.hello) { // 떠 있던 서비스에 붙었다 — hello 는 지나갔다. 세션 id 는 server.info 로
          const info = await request(c, 'server.info', {});
          c.id = info.session; void remember(c);
        }
        c.url = await conn.webUrl(); applyUrl(c);
        void countLive();
        if (!c.attached) await attach(c); // 연결마다 한 번 — url·id 를 이미 알아도(새로고침 복원) 이벤트 구독은 새 연결에 걸어야 한다
      } catch (e) {
        c.state = 'exited'; c.note = null; c.error = String(e?.message ?? e); badge(c); render(c);
        api.notify('error', `agent: ${c.error}`);
      } finally { c.starting = null; }
    })();
    return c.starting;
  }
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

  // ---- 뷰: 카드 (state {key, id?})
  api.views.register(VIEW, {
    title: 'Agent', icon: 'hubot',
    mount(el, ctx) {
      const st = ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
      if (!st.key) { el.textContent = 'agent: 카드 전용 뷰'; return; }
      const c = card(st.key);
      c.id = c.id ?? st.id ?? null;
      c.ctx = ctx; c.el = el; c.cardId = ctx.card; c.savedId = st.id ?? null;
      el.style.position = 'relative'; el.style.height = '100%';
      render(c); applyTitle(c); badge(c);
      // 뒤에서 연 카드(slcode.new)는 마운트 전에 세션이 떴다 — 그 id 를 card state 에 남긴다 (새로고침 복원)
      if (c.id && c.savedId !== c.id) { c.savedId = c.id; ctx.setState({ key: c.key, id: c.id }); }
      void ensure(c);
    },
    unmount(el) { for (const c of cards.values()) if (c.el === el) { c.el = null; } },
  });
  /** 카드 열기 — 있는 세션이면 그 카드를 활성화, 없으면 새 카드(새 세션 또는 저장 세션 resume) */
  async function openCard(key, id) {
    if (!key && id) for (const c of cards.values()) if (c.id === id) { key = c.key; break; }
    if (!key && id) key = await ownerOf(id); // 이전에 이 세션을 띄운 서비스의 owner — 있으면 그 서비스에 붙는다 (없으면 resume 으로 새로)
    if (!key) key = newKey();
    if (!cards.has(key)) card(key).id = id ?? null;
    api.views.open(VIEW, { key, id: cards.get(key)?.id ?? id ?? null }, { as: 'card', key, title: DEFAULT_NAME, preserve: true });
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
      { name: 'mode', kind: 'option', help: 'permission mode' },
    ],
    async run(a, ctx) {
      const key = newKey();
      const c = card(key);
      c.spawn = { cwd: a.cwd ?? ctx.cwd, vendor: a.vendor, title: a.title, mode: a.mode };
      const at = { as: 'card', key, title: a.title ?? DEFAULT_NAME, preserve: true };
      api.views.open(VIEW, { key, id: null }, { ...at, near: ctx.tmux ?? undefined });
      api.views.open(VIEW, undefined, at); // 이미 있는 key — 활성화만
      await ensure(c);
      if (!c.id) throw new Error(c.error ?? 'slcode 세션을 띄우지 못했습니다');
      return c.id;
    },
  });

  // 카드 제거 — 연결만 끊는다. 세션(서비스)은 산다 (사용자 2026-10-04: 닫아도 유지). 서비스 owner 가 card id 가 아니라 key 라 코어가
  // release 하지 않는다. ev.card 는 ctx.card 와 같은 값(보존 card 는 보관소 id)
  api.events.on({ kind: 'card.removed', pred: (ev) => ev.pluginId === 'slcode' }, (ev) => {
    const c = [...cards.values()].find((x) => x.cardId === ev.card); if (!c) return;
    detach(c); cards.delete(c.key);
  });

  // ---- 사이드바: 세션 목록 (slcode list — 살아 있는 세션만. 꺼짐과 끝남을 구분할 근거가 없어 꺼진 세션은 보이지 않는다, 사용자 2026-10-04)
  api.views.register(SIDEBAR, {
    title: 'Agent sessions', icon: 'hubot',
    mount(el) { void renderList(el); },
  });
  api.sidebar.register(SIDEBAR, { icon: 'hubot', title: 'Agent', view: SIDEBAR });
  // ponytail: 개수는 활성화·카드 기동/종료·목록 그리기 때만 다시 센다. 터미널에서 띄우거나 끈 세션은 그 다음 계기까지 늦다 — 필요하면 주기 갱신
  async function listLive() {
    const [bin, dir] = await Promise.all([resolveBin(), setting('dir', '')]);
    const r = await api.proc.run(`${bin.cmd} list${dir ? ` --dir ${shq(dir)}` : ''}`);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    const rows = JSON.parse(r.stdout || '[]');
    api.sidebar.setBadge(SIDEBAR, rows.length || null);
    return rows;
  }
  const countLive = () => listLive().catch(() => {});
  void countLive();
  async function renderList(el) {
    el.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = `.l{font:12px system-ui;padding:6px}.l button{display:block;width:100%;text-align:left;border:0;background:none;color:inherit;padding:4px 6px;border-radius:4px;cursor:pointer}.l button:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}.l .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#2ea043}.l .meta{opacity:.6;margin-left:14px;font-size:11px}.l .top{display:flex;gap:6px;margin-bottom:6px}.l .top button{width:auto;border:1px solid var(--vscode-widget-border,#444)}`;
    el.appendChild(style);
    const root = document.createElement('div'); root.className = 'l'; el.appendChild(root);
    const top = document.createElement('div'); top.className = 'top';
    const bNew = document.createElement('button'); bNew.textContent = '+ New session'; bNew.onclick = () => openCard();
    const bRef = document.createElement('button'); bRef.textContent = 'Refresh'; bRef.onclick = () => void renderList(el);
    top.append(bNew, bRef); root.appendChild(top);
    const list = document.createElement('div'); root.appendChild(list);
    list.textContent = '…';
    try {
      const rows = await listLive();
      list.innerHTML = '';
      if (!rows.length) list.textContent = '(no sessions)';
      for (const s of rows.reverse()) {
        const b = document.createElement('button');
        const dot = document.createElement('span'); dot.className = 'dot';
        b.append(dot, document.createTextNode(`${s.title ?? s.id} `));
        const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${s.id} · ${s.vendor} · ${s.cwd}`;
        b.appendChild(meta);
        b.title = '카드로 열기';
        b.onclick = () => openCard(undefined, s.id);
        list.appendChild(b);
      }
    } catch (e) { list.textContent = `목록 실패: ${e?.message ?? e}`; }
  }

  // ---- 팔레트
  api.commands.register({ id: 'new', title: 'Agent: New session (card)', run: () => openCard() });
  api.commands.register({
    id: 'close', title: 'Agent: Close session (active card)', run: () => {
      const c = [...cards.values()].find((x) => x.el); // 플러그인 뷰는 활성 카드일 때만 mount 되어 있다
      if (!c || !c.id) { api.notify('info', 'agent: 열린 에이전트 카드가 없습니다'); return; }
      request(c, 'session.close', { id: c.id }).then(() => api.notify('info', `agent: 세션 ${c.id} 종료`)).catch((e) => api.notify('error', `agent: ${e.message}`));
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

  shutdown = () => { for (const c of cards.values()) detach(c); cards.clear(); };
  return {
    /** 다른 플러그인용 — 세션 id 로 카드 열기 */
    open: (id) => openCard(undefined, id),
  };
}

let shutdown = () => {};
export function deactivate() { shutdown(); }
