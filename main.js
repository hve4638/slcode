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
const FAR = Number.MAX_SAFE_INTEGER; // attach since — 이력은 iframe 이 그린다, 여기선 pending 만

/** @param {import('@superlite/plugin').PluginApi} api */
export function activate(api) {
  api.settings.register({
    title: 'Agent',
    description: 'slcode 세션 카드. 카드 하나 = 세션 하나. 카드를 닫아도 세션은 산다 — 종료는 "Agent: Close session".',
    items: [
      { key: 'bin', type: 'string', label: 'slcode command', description: 'PATH 의 이름 또는 절대 경로', default: 'slcode' },
      { key: 'dir', type: 'string', label: 'SLCODE_DIR', description: '비우면 slcode 기본 폴더 (~/.local/state/slcode)', default: '' },
    ],
  });
  const setting = async (k, d) => { const v = await api.settings.get(k); return v === undefined || v === '' ? d : String(v); };
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

  /** key → 카드 하나. 뷰가 unmount/mount 를 거듭해도(카드 전환) 연결은 여기 산다 */
  const cards = new Map();
  const card = (key) => { let c = cards.get(key); if (!c) { c = { key, id: null, url: null, title: null, state: null, conn: null, unsub: null, ctx: null, el: null, nextId: 1, pending: new Map(), waits: new Map(), starting: null }; cards.set(key, c); } return c; };
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
  function applyTitle(c) { if (c.ctx) c.ctx.setTitle(c.title || c.id || 'agent'); }
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
      p.textContent = c.state === 'exited' ? '세션이 닫혔습니다 — 목록에서 다시 여세요' : 'slcode 세션을 띄우는 중…';
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
        const [bin, dir] = await Promise.all([setting('bin', 'slcode'), setting('dir', '')]);
        const verb = c.id ? `resume ${shq(c.id)}` : 'new';
        // --no-web: TCP 웹을 열지 않는다 — 화면은 서비스 웹 소켓(SUPERLITE_SERVICE_WEB)으로만
        const command = `${bin} ${verb} --stdio --no-web${dir ? ` --dir ${shq(dir)}` : ''}`;
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
        c.state = 'exited'; badge(c); render(c);
        api.notify('error', `agent: ${e?.message ?? e}`);
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
    api.views.open(VIEW, { key, id: cards.get(key)?.id ?? id ?? null }, { as: 'card', key, title: id ?? 'agent', preserve: true });
  }
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
    const [bin, dir] = await Promise.all([setting('bin', 'slcode'), setting('dir', '')]);
    const r = await api.proc.run(`${bin} list${dir ? ` --dir ${shq(dir)}` : ''}`);
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

  shutdown = () => { for (const c of cards.values()) detach(c); cards.clear(); };
  return {
    /** 다른 플러그인용 — 세션 id 로 카드 열기 */
    open: (id) => openCard(undefined, id),
  };
}

let shutdown = () => {};
export function deactivate() { shutdown(); }
