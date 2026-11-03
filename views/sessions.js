// slcode 세션 목록 사이드바 (새 방식 화면, ticket slcode-plugin-v2) — 목록은 renderer 가 세어 rows 로 보내 준다(배지와 같은 값).
// 누르면 그 세션의 카드를, 머리의 + 는 시작 화면 카드를, 폴더 줄의 + 는 그 폴더의 새 세션 카드를 renderer 가 연다. 행 우클릭 "Force close" 는 `slcode close --force` (사용자 2026-10-11)
// 모양 (ticket slcode-sidebar-orca, 사용자 결정 2026-10-27~28 — /tmp 시안으로 정하고 GPT·critic 디자인 검토를 반영):
//   cwd 폴더별 묶음(키는 경로 전체, 이름은 폴더 이름 — 연결된 워크트리면 본 저장소 이름, 같은 이름의 다른 폴더면 부모 폴더 이름을 흐리게) →
//   세션 한 줄(상태 점 | 제목·브랜치 | 벤더 기호·지금 상태가 된 뒤 시간). 상태 점은 superlite 터미널 점과 같은 뜻 — 깜빡이는 파랑 도는 중,
//   ! 든 노랑 승인 대기, 초록 끝났는데 안 봄, 회색 링 봄. 색은 상태에만 쓴다. 꺼진 세션은 숨김. 최근 활동순(에이전트 상태가 바뀐 시각)이고
//   마우스가 목록 위에 있는 동안은 순서를 멈춘다. 머리의 "All / This session" 은 지금 superlite 세션 탭에 카드로 떠 있는 세션만 거른다.
//   다른 superlite 세션 탭에 카드가 있는 세션은 흐리게 "Other session · 그 탭" 을 붙이고 누를 수 없다 — 우클릭 "Go to session" 이 그 탭으로
//   옮겨(닫혀 있으면 새로 열어) 카드를 앞으로. 카드가 없는 세션(superlite 밖에서 띄운 것)은 renderer 가 빼고 보낸다 (사용자 2026-10-28)
//   보이는 동안 POLL 마다 renderer 에 refresh 를 보낸다

const POLL = 4000;
const VENDOR = { // 무채색 기호 — claude 별, codex 육각 (로고가 아니다)
  claude: '<svg viewBox="0 0 16 16"><path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  codex: '<svg viewBox="0 0 16 16"><path d="M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>',
};
const ICON = {
  plus: '<path d="M8 3v10M3 8h10"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.55"/><path d="M13 3v2.5h-2.5"/>',
  chev: '<path d="M4.5 6l3.5 3.5L11.5 6"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  branch: '<circle cx="5" cy="3.5" r="1.5"/><circle cx="5" cy="12.5" r="1.5"/><circle cx="11" cy="5.5" r="1.5"/><path d="M5 5v6M11 7c0 2.5-6 2-6 4"/>',
};
const LABEL = { running: 'Running', asking: 'Waiting for approval', new: 'Finished, not seen', idle: 'Idle' };
const STYLE = `
:root{--sb-fg:var(--vscode-sideBar-foreground,var(--vscode-foreground,#ccc));--desc:var(--vscode-descriptionForeground,#9d9d9d);--hover:var(--vscode-list-hoverBackground,#2a2d2e);
--selbg:var(--vscode-list-inactiveSelectionBackground,#37373d);--focus:var(--vscode-focusBorder,#0078d4);--icon:var(--vscode-icon-foreground,#c5c5c5);
--st-run:var(--vscode-charts-blue,#3794ff);--st-ask:var(--vscode-charts-yellow,#cca700);--st-new:var(--vscode-charts-green,#89d185);--st-idle:var(--vscode-disabledForeground,#8b8b8b)}
.l,.l *{box-sizing:border-box}
.l{font:13px system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--sb-fg);position:relative;padding-bottom:8px}
.l svg.i{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;flex:none}
.l svg.i.s{width:12px;height:12px}
.hd{display:flex;align-items:center;gap:2px;padding:6px 6px 6px 10px}
.seg{display:flex;flex:1;gap:2px}
.seg button{border:0;background:none;color:var(--desc);font-size:12px;font-family:inherit;padding:2px 8px;border-radius:4px;cursor:pointer}
.seg button.on{background:var(--selbg);color:var(--sb-fg)}
.ib{width:24px;height:24px;display:grid;place-items:center;background:none;border:0;color:var(--icon);border-radius:5px;cursor:pointer;padding:0}
.ib:hover,.seg button:hover{background:var(--hover)}
.ib:focus-visible,.seg button:focus-visible,.gh:focus-visible,.row:focus-visible{outline:1px solid var(--focus);outline-offset:-1px}
.msg{padding:6px 14px;color:var(--desc)}
.grp+.grp{margin-top:4px}
.gh{display:flex;align-items:center;gap:6px;width:100%;min-height:24px;padding:3px 6px 3px 12px;border:0;background:none;color:var(--sb-fg);font:inherit;text-align:left;cursor:pointer;user-select:none}
.gh .ic{color:var(--icon);opacity:.75;display:grid;place-items:center}
.gh .nm{font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:0 1 auto}
.gh .hint{font-size:11px;color:var(--desc);flex:0 100 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gh .ct{font-size:11px;color:var(--desc);background:#8881;border-radius:9px;padding:0 6px;font-variant-numeric:tabular-nums;flex:none}
.gh .sp{flex:1}
.gh .add,.gh .chev{color:var(--icon);opacity:0;display:grid;place-items:center;width:20px;height:20px;border-radius:4px;flex:none}
.gh .add:hover{background:var(--hover)}
.gh:hover .add,.gh:hover .chev,.gh:focus-visible .chev,.gh.c .chev{opacity:.8}
.gh .chev svg{transition:transform .15s}.gh.c .chev svg{transform:rotate(-90deg)}
.row{display:grid;grid-template-columns:14px minmax(0,1fr) auto;column-gap:8px;align-items:start;width:calc(100% - 8px);margin:0 4px;padding:4px 8px 4px 10px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.row:hover{background:var(--hover)}
.row.other{cursor:default}.row.other>span{opacity:.5}
.row .t2 .ws{flex:none;white-space:nowrap}
.row.sel{background:var(--selbg)}
.row .st{height:18px;display:grid;place-items:center}
.row .t1{height:18px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row.unseen .t1{font-weight:600}
.row .t1 .id{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;opacity:.75}
.row .t2{display:flex;align-items:center;gap:4px;font-size:11.5px;line-height:15px;color:var(--desc);min-width:0}
.row .t2 .br{display:flex;min-width:0}.row .t2 .pfx{flex:none;opacity:.7}.row .t2 .rest{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .meta{display:flex;align-items:center;gap:6px;height:18px;color:var(--desc)}
.row .tm{font-size:11px;min-width:24px;text-align:right;font-variant-numeric:tabular-nums}
.vm{width:12px;height:12px;display:grid;place-items:center;opacity:.85}.vm svg{width:12px;height:12px}
.g{display:inline-block;border-radius:50%}
.g.running{width:8px;height:8px;background:var(--st-run);animation:pulse 1.6s ease-in-out infinite}
.g.asking{width:12px;height:12px;background:var(--st-ask);display:grid;place-items:center}.g.asking svg{width:12px;height:12px}
.g.new{width:8px;height:8px;background:var(--st-new)}
.g.idle{width:7px;height:7px;border:1.5px solid var(--st-idle);opacity:.8}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.menu{position:absolute;z-index:10;min-width:120px;padding:4px;background:var(--vscode-menu-background,#252526);border:1px solid var(--vscode-menu-border,#454545);border-radius:4px;box-shadow:0 2px 8px #0008}
.menu button{display:block;width:100%;text-align:left;border:0;background:none;color:inherit;padding:4px 8px;border-radius:3px;cursor:pointer;font:inherit}
.menu button:hover,.menu button:focus-visible{background:var(--vscode-menu-selectionBackground,#04395e);outline:0}`;

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icon = (k, cls = '') => `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true">${ICON[k]}</svg>`;
const base = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const parent = (p) => base(p.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, ''));
/** 긴 묶음 이름은 가운데를 줄인다 — 워크트리 슬러그는 뒤쪽이 갈리는 말이다 */
const mid = (t, n = 28) => (t.length <= n ? t : t.slice(0, 9) + '…' + t.slice(-(n - 10)));
const ago = (ms) => { const m = Math.floor(ms / 60e3); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
/** 점의 종류 — 활동 기록이 없는 옛 세션은 쉬는 중(봄) */
const kind = (s) => (s.state === 'running' || s.state === 'asking' ? s.state : s.state === 'idle' && s.seen === false ? 'new' : 'idle');
function glyph(k) {
  if (k === 'asking') return '<span class="g asking"><svg viewBox="0 0 12 12"><path d="M6 3v3.6" stroke="#1e1e1e" stroke-width="1.6" stroke-linecap="round"/><circle cx="6" cy="8.7" r=".9" fill="#1e1e1e"/></svg></span>';
  return `<span class="g ${k}"></span>`;
}

/** @param {HTMLElement} el @param {import('@superlite/plugin').ViewCtx} ctx */
export function mount(el, ctx) {
  const style = document.createElement('style'); style.textContent = STYLE; el.appendChild(style);
  const root = document.createElement('div'); root.className = 'l'; el.appendChild(root);
  root.innerHTML = `<div class="hd"><div class="seg" role="radiogroup" aria-label="Scope"><button data-scope="all">All</button><button data-scope="here">This session</button></div>
    <button class="ib" data-act="refresh" title="Refresh" aria-label="Refresh">${icon('refresh')}</button><button class="ib" data-act="new" title="New session" aria-label="New session">${icon('plus')}</button></div><div class="list" role="tree"><div class="msg">…</div></div>`;
  const list = root.querySelector('.list');
  const refresh = () => void ctx.post({ type: 'refresh' });

  /** 받은 목록(행의 at — 'here' 또는 카드가 있는 다른 superlite 세션의 폴더)·지금 시각(세션 머신의 시계 — 받은 순간의 이 화면 시계와 짝), 화면 상태 */
  let data = null, error = null, scope = 'all', sel = null, frozen = false, order = null;
  const collapsed = new Set();
  void ctx.storage.get('sidebar').then((v) => { if (v?.scope === 'here') { scope = 'here'; draw(); } }).catch(() => {});

  root.querySelector('.hd').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.scope) { scope = b.dataset.scope; void ctx.storage.set('sidebar', { scope }).catch(() => {}); draw(); }
    else if (b.dataset.act === 'refresh') { list.innerHTML = '<div class="msg">…</div>'; refresh(); }
    else if (b.dataset.act === 'new') void ctx.post({ type: 'open' });
  };

  ctx.onMessage((m) => {
    if (m?.type !== 'rows') return;
    if (m.error) { error = m.error; data = null; } else { error = null; data = { rows: m.rows, now: m.now ?? Date.now(), at: Date.now() }; }
    draw();
  });
  refresh();
  // 보이는 동안만 다시 센다 — 사이드바를 닫아도 iframe 은 0×0 으로 남는다(visibilityState 는 그대로). 다시 펼치면 resize 로 바로 센다
  const shown = () => document.visibilityState === 'visible' && window.innerWidth > 0;
  let wasShown = shown();
  setInterval(() => { if (shown()) refresh(); }, POLL);
  const onShow = () => { const now = shown(); if (now && !wasShown) refresh(); wasShown = now; };
  window.addEventListener('resize', onShow); document.addEventListener('visibilitychange', onShow);
  // 마우스가 목록 위에 있는 동안은 순서를 멈춘다 — 누르려던 행이 커서 밑에서 빠지지 않게. 떠나면 한 번에 다시 정렬
  list.addEventListener('mouseenter', () => { frozen = true; });
  list.addEventListener('mouseleave', () => { frozen = false; setTimeout(() => { if (!frozen) draw(); }, 300); });

  /** 세션 머신 시각으로 지금 상태가 된 뒤 흐른 시간 */
  const elapsed = (s) => data.now + (Date.now() - data.at) - (s.stateSince ?? s.updatedAt ?? data.now);
  const recent = (s) => s.stateSince ?? s.updatedAt ?? 0;
  /** 다른 superlite 세션 탭에 카드가 있는가 (at 이 없으면 — 카드 위치를 몰랐으면 — 지금 탭의 것으로 본다) */
  const other = (s) => !!s.at && s.at !== 'here';

  function groups() {
    const rows = data.rows.filter((s) => scope === 'all' || !other(s));
    const by = new Map();
    for (const s of rows) { if (!by.has(s.cwd)) by.set(s.cwd, []); by.get(s.cwd).push(s); }
    let gs = [...by].map(([cwd, l]) => [cwd, l.sort((a, b) => recent(b) - recent(a))]).sort((a, b) => recent(b[1][0]) - recent(a[1][0]));
    if (frozen && order) { // 멈춘 동안은 지난 순서 — 새로 생긴 것은 맨 위
      const pos = new Map(order.map((id, i) => [id, i])), p = (s) => pos.get(s.id) ?? -1;
      gs = gs.map(([c, l]) => [c, [...l].sort((a, b) => p(a) - p(b))]).sort((a, b) => Math.min(...a[1].map(p)) - Math.min(...b[1].map(p)));
    }
    order = gs.flatMap(([, l]) => l.map((s) => s.id));
    return gs;
  }
  function rowHtml(s) {
    const k = kind(s), b = s.git?.branch, o = other(s);
    const name = s.title ? esc(s.title) : `<span class="id">${esc(s.id.slice(0, 8))}</span>`;
    const cut = b ? b.indexOf('/') : -1;
    const br = b ? `${icon('branch', 's')}<span class="br">${cut > 0 ? `<span class="pfx">${esc(b.slice(0, cut + 1))}</span>` : ''}<span class="rest">${esc(cut > 0 ? b.slice(cut + 1) : b)}</span></span>` : '';
    const ws = o ? `<span class="ws">${b ? '· ' : ''}Other session · ${esc(base(s.at))}</span>` : '';
    const line2 = br || ws ? `<div class="t2">${br}${ws}</div>` : '';
    const t = ago(elapsed(s));
    const aria = `${s.title ?? s.id.slice(0, 8)}, ${LABEL[k]} ${t}, ${s.vendor}${b ? `, ${b}` : ''}${o ? `, in superlite session ${base(s.at)}` : ''}`;
    return `<button class="row${k === 'new' ? ' unseen' : ''}${o ? ' other' : ''}${sel === s.id ? ' sel' : ''}" role="treeitem" data-id="${esc(s.id)}" aria-label="${esc(aria)}"${o ? ' aria-disabled="true"' : ''}${sel === s.id ? ' aria-current="true"' : ''} title="${esc(o ? `${s.cwd}\nIn superlite session ${s.at} — right-click to go there` : s.cwd)}">
      <span class="st" role="img" aria-label="${LABEL[k]}" title="${LABEL[k]}">${glyph(k)}</span>
      <span><div class="t1">${name}</div>${line2}</span>
      <span class="meta"><span class="vm" title="${esc(s.vendor)}">${VENDOR[s.vendor] ?? ''}</span><span class="tm">${t}</span></span></button>`;
  }
  /** 접힌 묶음의 요약 점 — superlite 탭 요약과 같이 승인 대기·안 본 완료만 */
  const sumDot = (l) => (l.some((s) => kind(s) === 'asking') ? glyph('asking') : l.some((s) => kind(s) === 'new') ? glyph('new') : '');

  function draw() {
    for (const b of root.querySelectorAll('.seg button')) { b.classList.toggle('on', b.dataset.scope === scope); b.setAttribute('aria-checked', String(b.dataset.scope === scope)); }
    if (error) { list.innerHTML = `<div class="msg">Failed to list sessions: ${esc(error)}</div>`; return; }
    if (!data) return;
    const focused = document.activeElement?.closest?.('[data-id],[data-g]');
    const fkey = focused ? (focused.dataset.id ? `[data-id="${CSS.escape(focused.dataset.id)}"]` : `[data-g="${CSS.escape(focused.dataset.g)}"]`) : null;
    const gs = groups();
    if (!gs.length) { list.innerHTML = `<div class="msg">${scope === 'here' && data.rows.length ? 'No sessions in this superlite session' : '(no sessions)'}</div>`; return; }
    const names = new Map(); for (const [cwd] of gs) names.set(base(cwd), (names.get(base(cwd)) ?? 0) + 1);
    let h = '';
    for (const [cwd, l] of gs) {
      const c = collapsed.has(cwd), git = l[0].git;
      const hint = git?.worktree ? git.repo : names.get(base(cwd)) > 1 ? parent(cwd) : '';
      h += `<div class="grp" role="group"><div class="gh${c ? ' c' : ''}" role="button" tabindex="0" data-g="${esc(cwd)}" aria-expanded="${!c}" title="${esc(cwd)}"><span class="ic">${icon('folder')}</span><span class="nm">${esc(mid(base(cwd)))}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}${l.length > 1 || c ? `<span class="ct">${l.length}</span>` : ''}<span class="sp"></span>${c ? sumDot(l) : ''}<span class="add" data-add="${esc(cwd)}" title="New session in this folder" role="button" aria-label="New session in this folder">${icon('plus', 's')}</span><span class="chev">${icon('chev', 's')}</span></div>`;
      if (!c) for (const s of l) h += rowHtml(s);
      h += '</div>';
    }
    list.innerHTML = h;
    if (fkey) list.querySelector(fkey)?.focus();
  }

  list.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { void ctx.post({ type: 'open', spawn: { cwd: add.dataset.add } }); return; }
    const g = e.target.closest('[data-g]');
    if (g) { const k = g.dataset.g; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); draw(); return; }
    const r = e.target.closest('[data-id]');
    if (r && !r.classList.contains('other')) { sel = r.dataset.id; draw(); void ctx.post({ type: 'open', id: sel }); }
  });
  list.addEventListener('contextmenu', (e) => {
    const r = e.target.closest('[data-id]'); if (!r) return;
    e.preventDefault(); rowMenu(e.clientX, e.clientY, r.dataset.id);
  });
  // 키보드 — 위아래로 행·머리를 옮기고, 왼쪽·오른쪽으로 묶음을 접고 편다, Shift+F10·메뉴 키로 행 메뉴
  list.addEventListener('keydown', (e) => {
    const cur = e.target.closest('[data-id],[data-g]'); if (!cur) return;
    const all = [...list.querySelectorAll('[data-id],[data-g]')], i = all.indexOf(cur);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); all[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus(); }
    else if (cur.dataset.g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); cur.click(); }
    else if (cur.dataset.g && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { const k = cur.dataset.g; if (e.key === 'ArrowLeft') collapsed.add(k); else collapsed.delete(k); draw(); }
    else if (cur.dataset.id && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) { e.preventDefault(); const b = cur.getBoundingClientRect(); rowMenu(b.left + 24, b.bottom, cur.dataset.id); }
  });

  /** 행 우클릭 메뉴 — 플러그인 API 에 메뉴가 없어 뷰 안에 그린다. 바깥을 누르거나 Esc 면 닫는다. 다른 superlite 세션 탭의 행이면 Go to session 이 먼저 */
  function rowMenu(x, y, id) {
    root.querySelector('.menu')?.remove();
    const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu');
    const away = (ev) => { if (!ev.composedPath().includes(m)) close(); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    const close = () => { m.remove(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', onKey, true); };
    const item = (label, run) => { const b = document.createElement('button'); b.textContent = label; b.setAttribute('role', 'menuitem'); b.onclick = () => { close(); run(); }; m.appendChild(b); };
    const s = data?.rows.find((r) => r.id === id);
    if (s && other(s)) item(`Go to session “${base(s.at)}”`, () => { sel = id; void ctx.post({ type: 'goTo', id, root: s.at }); });
    item('Force close', () => { list.innerHTML = '<div class="msg">…</div>'; void ctx.post({ type: 'forceClose', id }); });
    root.appendChild(m);
    const r = root.getBoundingClientRect();
    m.style.left = `${Math.max(0, Math.min(x - r.left, root.clientWidth - m.offsetWidth))}px`; m.style.top = `${y - r.top}px`;
    document.addEventListener('mousedown', away, true); document.addEventListener('keydown', onKey, true);
    m.querySelector('button').focus();
  }
}
