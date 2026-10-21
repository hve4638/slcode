// slcode 세션 카드 (새 방식 화면, ticket slcode-plugin-v2) — 카드마다 sandbox iframe 하나에서 돈다. 카드 하나 = slcode 세션 하나.
//
// (1) 기동 — card 단위 owned 서비스로 slcode 를 띄운다 (owner 는 ctx.card: 카드를 제거하면 세션도 끝난다, 사용자 2026-10-11). 명령은
// main 이 짓는다(받은 바이너리가 그 머신에 있다). 카드를 두고 세션만 끄는 길은 slcode 웹의 "세션 종료"·사이드바 "Force close"·팔레트
// "slcode: Close session"·터미널 `slcode close`. (2) 화면 — slcode 가 stdout 첫 줄로 보내는 hello {id,sock} 로 세션을 알고, serve 가
// stdio 로 준 화면 파일(web.files)의 card.html 을 이 iframe 안의 주소 없는 sandbox iframe 에 넣는다. 화면은 여기서 건넨 MessagePort 로만
// 말하고 이 카드가 stdio 로 중계한다 (ticket slcode-card-svc-token-dead). web.files 가 없는 옛 serve 는 /svc 주소(conn.webUrl)로.
// (3) 상태 — 같은 stdio 통로로 session.attach 를 걸어 배지·승인 알림에 반영한다. 선구독 services.onMessage 를 기동 전에 걸어 첫 줄을
// 놓치지 않는다. ctx 의 services 는 카드 세션에 묶여 배경 세션이어도 자기 데몬과 주고받는다.
// 승인 알림은 main 에 알려 창 하나에만 (사용자 2026-10-21, main.js 머리말). 화면 상태(사이드바 열림·inspect 남은 공간)는 sandbox 라
// localStorage 가 없어 storage 'ui' 에 — 세션 머신에 저장되어 그 머신의 카드·브라우저가 같은 값을 본다 (사용자 2026-10-21).

const VIEW = 'session';
const SVC = 'session';
const DEFAULT_NAME = 'SLCode'; // 이름 없는 세션의 카드 제목 (slcode 웹의 기본 이름과 같다)
const PICK_NAME = 'Resume'; // 고르기 전 resume 카드의 제목
const FAR = Number.MAX_SAFE_INTEGER; // attach since — 이력은 안쪽 화면이 그린다, 여기선 pending 만
// 이 화면의 표 — 카드 서비스의 stdio 는 같은 폴더를 연 모든 superlite 창에 방송된다. 요청 id 앞에 붙여 다른 창의 응답을 가려낸다
const WIN = Math.random().toString(36).slice(2, 8);
const newKey = () => 's' + Math.random().toString(36).slice(2, 8);

/** 꺼진 시각 표기 — CLI 의 id 없는 resume 목록과 같은 YYYY-MM-DD HH:MM (이 브라우저의 시간대) */
export function stamp(t) {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 웹 화면(toolArg)과 같은 한 줄 — Bash 는 명령, 파일 도구는 경로. 그 밖은 JSON
const summary = (input) => { try { const v = input?.command ?? input?.file_path ?? input?.pattern ?? input?.description; const s = typeof v === 'string' ? v : JSON.stringify(input ?? {}); return s.length > 80 ? s.slice(0, 80) + '…' : s; } catch { return ''; } };

let cleanup = () => {};

/** @param {HTMLElement} el @param {import('@superlite/plugin').ViewCtx} ctx */
export function mount(el, ctx) {
  const st = ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
  if (!st.key) { el.textContent = 'slcode: 카드 전용 뷰'; return; }
  const host = (method, ...args) => ctx.main.call('host', method, ...args);
  const c = {
    key: st.key, id: st.id ?? null, savedId: st.id ?? null,
    pick: !st.id && typeof st.pick === 'string' ? st.pick : null, // 고르기 전 resume 카드 — 서비스를 띄우지 않는다
    spawn: !st.id && st.spawn ? st.spawn : null, // slcode.new 의 새 세션 — 세션 id 를 알면 main 에 알리고 state 에서 지운다
    takeover: !!st.takeover, from: st.from ?? null, // 핸드오프의 새 카드 — 소유권을 가져오고, 붙으면 옛 카드(from)를 옮긴다
    moved: !!st.moved, // 핸드오프로 옮겨진 카드 — 다시 붙지 않는다
    title: null, state: null, conn: null, unsub: null, attached: false, hello: false, lost: false, closing: false,
    web: null, url: null, frame: null, shown: null, port: null, fwd: new Map(), portSeq: 0,
    nextId: 1, pending: new Map(), waits: new Map(), starting: null, note: null, error: null,
  };
  const owner = ctx.card ?? c.key; // 서비스 owner — 코어가 카드 제거 때 이 값으로 owned 서비스를 끝낸다
  el.style.position = 'relative'; el.style.height = '100%'; el.style.overflow = 'hidden';
  void ctx.post({ type: 'tab', key: c.key });
  const countLive = () => void ctx.post({ type: 'count' });

  // ---- 세션 id → 카드 key (storage 'owners') — 같은 세션을 다시 열 때 다른 브라우저가 연 그 카드를 renderer 가 활성화한다
  const remember = async () => {
    const m = (await ctx.storage.get('owners')) ?? {};
    if (m[c.id] !== c.key) { m[c.id] = c.key; await ctx.storage.set('owners', m); }
  };
  /** 세션 id 를 알았다 — card state {key, id}(새로고침 복원, 보존 card 라 모든 브라우저가 같이 본다), slcode.new 면 main 에 */
  function known() {
    if (!c.id) return;
    void remember().catch(() => {});
    if (c.spawn) { c.spawn = null; void host('started', c.key, c.id).catch(() => {}); }
    if (c.savedId !== c.id) { c.savedId = c.id; void ctx.setState({ key: c.key, id: c.id }); }
  }

  // ---- 프레임 (slcode 프로토콜과 같은 꼴)
  function request(method, params) {
    const id = `${WIN}.${c.nextId++}`;
    return new Promise((resolve, reject) => {
      c.pending.set(id, { resolve, reject });
      ctx.services.send(SVC, { id, method, params }, { owner }).catch((e) => { c.pending.delete(id); reject(e); });
    });
  }
  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if ('url' in m && 'sock' in m) { // hello
      c.hello = true; c.id = m.id ?? c.id;
      known(); applyTitle(); if (c.shown !== shownKey()) render();
      if (!c.attached) void attach();
      handedOver();
      return;
    }
    if (m.event) { onEvent(m.event, m.params); c.port?.postMessage(m); return; }
    if (m.id !== undefined && c.fwd.has(m.id)) { const id = c.fwd.get(m.id); c.fwd.delete(m.id); c.port?.postMessage({ ...m, id }); return; }
    if (m.id !== undefined && c.pending.has(m.id)) {
      const p = c.pending.get(m.id); c.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message ?? 'error')) : p.resolve(m.result);
    }
  }
  function onEvent(event, p) {
    if (event === 'session.changed') { c.state = p.state; c.title = p.title; applyTitle(); badge(); return; }
    if (event === 'session.closed') { c.state = 'exited'; c.waits.clear(); badge(); countLive(); return; }
    if (event !== 'session.event') return;
    const ev = p.ev;
    if (ev.kind === 'approval.requested') {
      c.waits.set(ev.requestId, ev); badge();
      const isQ = ev.name === 'AskUserQuestion';
      const what = isQ ? (ev.input?.questions?.[0]?.question ?? '질문') : `${ev.name} ${summary(ev.input)}`;
      const message = `${isQ ? '질문' : '승인 대기'}: ${what}`;
      // 창 하나에만 — main 이 같은 요청을 한 번만 띄운다. main 에 닿지 못하면 이 창에서라도
      host('approval', { owner, requestId: ev.requestId, key: c.key, id: c.id, message })
        .catch(() => ctx.notify('warning', message, { label: '열기', run: () => void ctx.views.open(VIEW, undefined, { as: 'card', key: c.key, preserve: true }) }, ctx.tabId ? { card: ctx.tabId } : undefined));
    } else if (ev.kind === 'approval.resolved') { c.waits.delete(ev.requestId); badge(); }
    else if (ev.kind === 'session.state') { c.state = ev.state; badge(); }
  }

  // ---- 카드 표면
  function badge() {
    const n = c.waits.size;
    void ctx.setBadge(c.moved ? null : n ? (n > 1 ? `!${n}` : '!') : c.state === 'running' ? '…' : c.state === 'exited' ? 'off' : null);
  }
  function applyTitle() { void ctx.setTitle(c.title || (c.pick && !c.id ? PICK_NAME : DEFAULT_NAME)); } // 카드 제목 = 세션 이름, 없으면 SLCode
  /** 안쪽 iframe 이 무엇을 띄우는가 — 카드 모드 화면(web.files, 주소 없음)이면 'port', 아니면 /svc 주소 */
  const shownKey = () => (c.web ? 'port' : c.url);
  function render() {
    c.shown = shownKey();
    el.innerHTML = '';
    c.io?.disconnect(); c.frame = null;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ccc)';
    if (c.pick && !c.id) renderPicker(wrap);
    else if (c.web || c.url) {
      const f = document.createElement('iframe');
      f.title = 'slcode';
      // 카드 모드 화면 — serve 가 준 card.html 을 sandbox(출처 없음)로. 화면은 slcode.ready 로 포트를 청하고 그 포트로만 말한다.
      // 모델 출력을 그리는 화면이라 allow-same-origin 은 주지 않는다. 이 카드 화면도 sandbox="allow-scripts" 라 안쪽은 그 제한을 물려받는다 —
      // 팝업·다운로드·모달 허용은 지금은 듣지 않는다 (링크·로컬 파일 다운로드는 동사로)
      if (c.web) { f.sandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals'; f.srcdoc = c.web.html; } else f.src = c.url;
      c.frame = f;
      f.allow = 'clipboard-read; clipboard-write';
      // 배경은 slcode 웹과 같은 색(시스템 라이트·다크) — 안쪽이 그려지기 전 흰 화면이 번쩍였다
      f.style.cssText = 'flex:1;border:0;width:100%;height:100%;color-scheme:light dark;background:light-dark(#f7f7f8,#18181b)';
      // 카드가 보이게 되면 입력창으로 — 메시지로 알린다
      const focusIn = () => requestAnimationFrame(() => { f.focus(); f.contentWindow?.postMessage({ type: 'slcode.focus' }, '*'); });
      c.io = new IntersectionObserver((es) => { if (es[0].isIntersecting) focusIn(); });
      c.io.observe(f);
      f.addEventListener('load', () => { if (f.offsetParent) focusIn(); });
      wrap.appendChild(f);
    } else {
      const p = document.createElement('div');
      p.style.cssText = 'margin:auto;font:13px system-ui;opacity:.8';
      p.textContent = c.moved ? '새 카드로 옮겨졌습니다' : c.error ? `slcode 를 준비하지 못했습니다: ${c.error}` : c.note ?? (c.state === 'exited' ? '세션이 닫혔습니다' : 'slcode 세션을 띄우는 중…');
      if (c.error) { // 받기·기동 실패 — 사유를 보이고 다시 시도 (설정을 고친 뒤 등)
        p.style.cssText += ';max-width:80%;text-align:center;white-space:pre-wrap';
        const b = document.createElement('button');
        b.textContent = '다시 시도'; b.style.cssText = 'display:block;margin:10px auto 0';
        b.onclick = () => { c.error = null; c.state = null; render(); void ensure(); };
        p.appendChild(b);
      }
      wrap.appendChild(p);
    }
    el.appendChild(wrap);
  }

  /** id 없는 `slcode resume` 의 카드 (ticket slcode-resume-like-new) — c.pick 폴더의 꺼진 세션을 꺼진 순서(최근 먼저)로 보이고, 고르면 이 카드가
   *  그 세션을 resume 해 대화 화면이 된다 */
  function renderPicker(wrap) {
    wrap.style.overflow = 'auto';
    const style = document.createElement('style');
    style.textContent = `.l{font:12px system-ui;padding:6px}.l button{display:block;width:100%;text-align:left;border:0;background:none;color:inherit;padding:4px 6px;border-radius:4px;cursor:pointer;font:inherit}.l button:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}.l .meta{opacity:.6;font-size:11px}`;
    const root = document.createElement('div'); root.className = 'l';
    const head = document.createElement('div'); head.className = 'meta'; head.textContent = `Closed sessions in ${c.pick}`;
    const list = document.createElement('div'); list.textContent = '…';
    root.append(head, list); wrap.append(style, root);
    host('closed', c.pick).then((rows) => {
      list.innerHTML = '';
      if (!rows.length) list.textContent = '(no closed sessions)';
      for (const s of rows) {
        const b = document.createElement('button');
        b.append(document.createTextNode(s.title ?? s.id));
        const m = document.createElement('div'); m.className = 'meta'; m.textContent = `${s.id} · ${s.vendor} · ${stamp(s.closedTime)}`;
        b.appendChild(m);
        b.onclick = () => { c.pick = null; c.id = s.id; known(); applyTitle(); render(); void ensure(); }; // state {key, id} — pick 을 지운다
        list.appendChild(b);
      }
    }, (e) => { list.textContent = `Failed to list sessions: ${e?.message ?? e}`; });
  }

  // ---- 기동·연결 (attach-or-start). 선구독 → open(start+connect) → 이미 돌고 있었으면 hello 가 없으니 server.info 로 id
  async function ensure() {
    if (c.moved) return;
    if (c.conn || c.starting) return c.starting;
    c.starting = (async () => {
      let dropped = false; // 이 시도에서 연 연결이 끊겼다
      try {
        if (!c.unsub) c.unsub = ctx.services.onMessage(SVC, onMessage, { owner });
        c.error = null;
        // 처음이면 main 이 바이너리를 받는다 (진행률은 없다) — 오래 걸릴 때만 알린다. 다시 붙는 중(iframe 이 떠 있다)엔 문구로 덮지 않는다
        const slow = setTimeout(() => { c.note = 'slcode 를 준비하는 중… (처음이면 받는 데 시간이 걸립니다)'; if (!c.shown) render(); }, 1500);
        let command;
        try { command = await host('command', { id: c.id, spawn: c.spawn, takeover: c.takeover }); } finally { clearTimeout(slow); }
        c.note = null;
        c.hello = false;
        const conn = await ctx.services.open(SVC, { owner, command });
        c.conn = conn; c.lost = false; c.takeover = false; // 다시 띄울 때는 보통 resume — 그 사이 소유권이 다른 카드로 갔을 수 있다
        conn.onClose(() => {
          c.conn = null; c.attached = false; c.url = null; c.lost = true; dropped = true; badge();
          portStatus(false); // 카드 모드 화면은 그대로 두고 끊겼다고만 — 다시 붙으면 같은 포트로 이어진다
          // 기다리던 응답(server.info·session.attach)은 이 연결로 오지 않는다 — 풀지 않으면 ensure 가 끝나지 않아 다시 붙지 못했다
          for (const p of c.pending.values()) p.reject(new Error('연결이 끊겼습니다'));
          c.pending.clear();
          setTimeout(resume, 1000);
        });
        if (!c.hello) { // 떠 있던 서비스에 붙었다 — hello 는 지나갔다. 세션 id 는 server.info 로
          const info = await request('server.info', {});
          c.id = info.session; known();
          handedOver(); // 다른 브라우저가 먼저 새 카드의 서비스를 띄웠다 — 소유권은 이미 넘어왔다
        }
        // 카드 모드 화면 파일 — 이 serve 가 고정한 것. 옛 serve(web.files 없음)는 /svc 주소로
        const web = await request('web.files', {}).catch((e) => { if (dropped) throw e; return null; });
        if (web) c.web = web; else { c.web = null; c.url = await conn.webUrl(); }
        applyTitle(); if (c.shown !== shownKey()) render(); // 같은 화면이면 iframe 을 다시 만들지 않는다 (다시 로드된다)
        portStatus(true);
        countLive();
        if (!c.attached) await attach(); // 연결마다 한 번 — 이벤트 구독은 새 연결에 걸어야 한다
      } catch (e) {
        if (dropped) return; // 붙는 도중 연결이 끊겼다 — onClose 의 resume 이 다시 붙는다
        c.state = 'exited'; c.note = null; c.error = String(e?.message ?? e); badge(); render();
        if (c.spawn) void host('failed', c.key, c.error).catch(() => {});
        void ctx.notify('error', `slcode: ${c.error}`);
      } finally { c.starting = null; }
    })();
    return c.starting;
  }
  /** 끊긴 카드 다시 붙기 — 이 화면이 떠 있는 동안(배경 세션이어도 카드 세션의 연결로 붙는다) */
  function resume() { if (c.lost && !c.conn && c.state !== 'exited' && !c.closing && !c.moved) void ensure(); }
  async function attach() {
    if (!c.id || c.attached) return;
    c.attached = true;
    try {
      const r = await request('session.attach', { id: c.id, since: FAR });
      c.state = r.info.state; c.title = r.info.title;
      c.waits = new Map(r.pending.map((p) => [p.requestId, p]));
      applyTitle(); badge();
    } catch { /* 닫히는 중 — onClose 가 처리 */ }
  }
  function detach() {
    c.unsub?.(); c.unsub = null;
    c.conn?.close().catch(() => {}); c.conn = null; c.attached = false;
    for (const p of c.pending.values()) p.reject(new Error('detached'));
    c.pending.clear();
  }

  // ---- 카드 모드 화면의 포트 (ticket slcode-card-svc-token-dead) — 안쪽 화면 ↔ 이 카드 ↔ 서비스 stdio. 화면이 (다시) 로드될 때마다 새 포트를 준다.
  // 화면 요청의 id 는 이 화면의 표를 붙여 stdio 로 보내고, 응답은 원래 id 로 돌려준다
  async function openPort(f) {
    const ui = (await ctx.storage.get('ui').catch(() => null)) ?? {};
    if (c.frame !== f) return; // 그 사이 다시 그렸다
    c.port?.close();
    const ch = new MessageChannel();
    c.port = ch.port1; c.fwd = new Map(); c.portSeq++;
    const gen = c.portSeq;
    ch.port1.onmessage = (e) => {
      const m = e.data;
      if (m?.ui && typeof m.ui.key === 'string') { void uiSet(m.ui.key, m.ui.value); return; }
      if (!m || m.id === undefined || typeof m.method !== 'string') return;
      if (!c.conn) { ch.port1.postMessage({ id: m.id, error: { code: 'closed', message: 'not connected' } }); return; }
      const id = `${WIN}.p${gen}.${m.id}`;
      c.fwd.set(id, m.id);
      ctx.services.send(SVC, { id, method: m.method, params: m.params }, { owner }).catch((err) => { c.fwd.delete(id); ch.port1.postMessage({ id: m.id, error: { code: 'closed', message: String(err?.message ?? err) } }); });
    };
    f.contentWindow.postMessage({ type: 'slcode.port', files: c.web.files, ui }, '*', [ch.port2]);
    if (c.conn && c.web) ch.port1.postMessage({ status: { connected: true } });
  }
  /** 화면 상태 한 칸 — storage 'ui' 를 다시 읽어 고친다 (같은 머신의 다른 카드가 다른 칸을 바꿨을 수 있다) */
  async function uiSet(k, v) {
    const ui = (await ctx.storage.get('ui').catch(() => null)) ?? {};
    ui[k] = String(v);
    await ctx.storage.set('ui', ui).catch(() => {});
  }
  function portStatus(connected) {
    if (!c.port) return;
    if (!connected) { for (const id of c.fwd.values()) c.port.postMessage({ id, error: { code: 'closed', message: 'connection closed' } }); c.fwd.clear(); }
    c.port.postMessage({ status: { connected } });
  }
  /** 화면이 다시 붙은 serve 가 자기를 낸 serve 와 다르다고 알렸다 — 연결마다 받아 둔 새 화면 파일(c.web)로 iframe 을 다시 만든다 */
  function reloadWeb() {
    if (!c.web) return;
    c.port?.close(); c.port = null;
    render();
  }

  // ---- serve 교체 (ticket slcode-core-serve-split 2단계, 사용자 확정 2026-10-14·2026-10-19) — 안쪽 화면의 [업데이트]·[restart required] 가 postMessage 로 부른다.
  // serve 의 stdio 를 거치지 않는 것은 그 카드를 띄운 모든 브라우저가 stdio 메시지를 받아 핸드오프가 여러 번 일어나기 때문이다
  /** [restart required] — 이 카드 바로 다음에 새 카드를 열어(사용자가 보고 있으면 그쪽으로 넘어간다) 새 serve 가 --takeover 로 같은 세션을 이어받게 한다.
   *  새 카드가 붙으면 renderer 를 거쳐 이 카드를 moveOut 으로 정리한다. 새 카드가 뜨지 못하면 새 카드에 사유가 보이고 이 카드는 그대로다 (사용자 2026-10-19) */
  async function handoff() {
    if (!c.id || !ctx.tabId) throw new Error('세션이 아직 준비되지 않았습니다');
    const key = newKey();
    await ctx.views.open(VIEW, { key, id: c.id, takeover: true, from: c.key }, { as: 'card', key, title: c.title || DEFAULT_NAME, preserve: true, opener: ctx.tabId, focus: true });
    return { ok: true };
  }
  /** 핸드오프의 새 카드에 serve 가 붙었다(소유권을 가져왔다) — 옛 카드를 옮겨진 카드로(이 창의 renderer 가 전한다), state 의 takeover 는 지운다 */
  function handedOver() {
    if (!c.from) return;
    void ctx.post({ type: 'moveOut', from: c.from });
    c.from = null;
    c.savedId = c.id; void ctx.setState({ key: c.key, id: c.id });
  }
  /** 옮겨진 카드 — 서비스를 멈추고(소유권이 새 카드로 가서 세션은 산다) 안내를 보인 뒤 닫기 요청([D], 사용자가 확인한다).
   *  state·shared 에 남겨 새로고침·다른 브라우저에서도 다시 붙지 않는다 */
  async function moveOut() {
    if (c.moved) return;
    c.moved = true; c.url = null; c.web = null; c.waits.clear();
    detach(); render(); badge();
    void ctx.setState({ key: c.key, id: c.id, moved: true });
    void ctx.shared?.set('moved', true).catch(() => {});
    await ctx.services.stop(SVC, { owner }).catch(() => {});
    if (ctx.tabId) void ctx.verbs.run('card.close', [ctx.tabId]).catch(() => {});
  }
  // 다른 브라우저에서 옮겨졌다 (moveOut 의 shared) — 이 창의 연결도 끊고 안내만
  const unshared = ctx.shared?.on((k, v) => { if (k === 'moved' && v && !c.moved) { c.moved = true; c.url = null; c.web = null; detach(); render(); badge(); } });

  // renderer 가 보낸 것 (renderer.js 머리말)
  ctx.onMessage((m) => {
    switch (m?.type) {
      case 'revive': // 닫힌 세션의 카드를 다시 열었다 — 다시 띄운다
        if (m.key === c.key && c.state === 'exited' && !c.conn && !c.starting && c.id) { c.state = null; c.error = null; badge(); render(); void ensure(); }
        return;
      case 'close': // 팔레트 "slcode: Close session (active card)"
        if (!c.id) { void ctx.notify('info', 'slcode: 열린 세션 카드가 없습니다'); return; }
        request('session.close', { id: c.id }).catch((e) => ctx.notify('error', `slcode: ${e.message}`));
        return;
      case 'closing': if (m.id === c.id) c.closing = !!m.on; return;
      case 'closed': if (m.id === c.id) { c.state = 'exited'; c.url = null; c.web = null; c.waits.clear(); badge(); render(); } return;
      case 'moveOut': if (m.key === c.key) void moveOut(); return;
    }
  });

  // 안쪽 화면이 보낸 것 — 포트 청하기·다시 그리기·serve 교체·링크 열기. 링크(slcode.open)는 superlite 의 open 동사(웹 주소는 URL 탭, 파일은 에디터),
  // slcode.download 는 download 동사(로컬 파일을 Download 뷰 대기열에 — 사용자가 확인하면 이 PC 로) (ticket slcode-append-system-prompt)
  const VERB = { 'slcode.open': 'open', 'slcode.download': 'download' };
  const HOST = { 'slcode.update': (d) => host('checkUpdate', { version: d.version, build: d.build }), 'slcode.restart': handoff };
  const onFrame = (e) => {
    if (!c.frame || e.source !== c.frame.contentWindow) return;
    const d = e.data;
    if (d?.type === 'slcode.ready' && c.web) { void openPort(c.frame); return; }
    if (d?.type === 'slcode.reload') { reloadWeb(); return; }
    const fn = HOST[d?.type];
    if (fn) {
      const answer = (o) => e.source.postMessage({ re: d.id, ...o }, '*');
      (async () => fn(d))().then((result) => answer({ result }), (err) => answer({ error: String(err?.message ?? err) }));
      return;
    }
    const verb = VERB[d?.type];
    if (!verb || typeof d.target !== 'string') return;
    ctx.verbs.run(verb, [d.target]).catch((err) => ctx.notify('error', `slcode: ${err?.message ?? err}`));
  };
  window.addEventListener('message', onFrame);
  cleanup = () => { window.removeEventListener('message', onFrame); unshared?.(); c.io?.disconnect(); detach(); };

  render(); applyTitle(); badge();
  if (!c.pick && !c.moved) void ensure();
}

/** 화면이 다시 로드되기 전 — 연결은 창이 닫지만 구독·관찰자도 거둔다 */
export function unmount() { cleanup(); cleanup = () => {}; }
