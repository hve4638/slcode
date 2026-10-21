// slcode 세션 목록 사이드바 (새 방식 화면, ticket slcode-plugin-v2) — 목록은 renderer 가 세어 rows 로 보내 준다(배지와 같은 값).
// 누르면 그 세션의 카드를, + New session 은 새 카드를 renderer 가 연다. 행 우클릭 "Force close" 는 `slcode close --force` (사용자 2026-10-11)

/** @param {HTMLElement} el @param {import('@superlite/plugin').ViewCtx} ctx */
export function mount(el, ctx) {
  const style = document.createElement('style');
  style.textContent = `.l{font:12px system-ui;padding:6px;position:relative;color:var(--vscode-foreground,#ccc)}.l button{display:block;width:100%;text-align:left;border:0;background:none;color:inherit;padding:4px 6px;border-radius:4px;cursor:pointer;font:inherit}.l button:hover{background:var(--vscode-list-hoverBackground,#2a2d2e)}.l .meta{opacity:.6;font-size:11px}.l .top{display:flex;gap:6px;margin-bottom:6px}.l .top button{width:auto;border:1px solid var(--vscode-widget-border,#444)}.l .menu{position:absolute;z-index:10;min-width:120px;padding:4px;background:var(--vscode-menu-background,#252526);border:1px solid var(--vscode-menu-border,#454545);border-radius:4px;box-shadow:0 2px 8px #0008}`;
  el.appendChild(style);
  const root = document.createElement('div'); root.className = 'l'; el.appendChild(root);
  const top = document.createElement('div'); top.className = 'top';
  const bNew = document.createElement('button'); bNew.textContent = '+ New session'; bNew.onclick = () => void ctx.post({ type: 'open' });
  const bRef = document.createElement('button'); bRef.textContent = 'Refresh'; bRef.onclick = () => { list.textContent = '…'; void ctx.post({ type: 'refresh' }); };
  top.append(bNew, bRef); root.appendChild(top);
  const list = document.createElement('div'); list.textContent = '…'; root.appendChild(list);

  ctx.onMessage((m) => {
    if (m?.type !== 'rows') return;
    if (m.error) { list.textContent = `Failed to list sessions: ${m.error}`; return; }
    list.innerHTML = '';
    if (!m.rows.length) list.textContent = '(no sessions)';
    for (const s of [...m.rows].reverse()) {
      const b = document.createElement('button');
      b.append(document.createTextNode(s.title ?? s.id));
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${s.id} · ${s.vendor} · ${s.cwd}`;
      b.appendChild(meta);
      b.onclick = () => void ctx.post({ type: 'open', id: s.id });
      b.oncontextmenu = (e) => { e.preventDefault(); rowMenu(e, 'Force close', () => { list.textContent = '…'; void ctx.post({ type: 'forceClose', id: s.id }); }); };
      list.appendChild(b);
    }
  });
  void ctx.post({ type: 'refresh' });

  /** 행 우클릭 메뉴 — 플러그인 API 에 메뉴가 없어 뷰 안에 그린다. 바깥을 누르거나 Esc 면 닫는다 */
  function rowMenu(e, label, run) {
    root.querySelector('.menu')?.remove();
    const m = document.createElement('div'); m.className = 'menu';
    const away = (ev) => { if (!ev.composedPath().includes(m)) close(); };
    const esc = (ev) => { if (ev.key === 'Escape') close(); };
    const close = () => { m.remove(); document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', esc, true); };
    const b = document.createElement('button'); b.textContent = label; b.onclick = () => { close(); run(); };
    m.appendChild(b); root.appendChild(m);
    const r = root.getBoundingClientRect();
    m.style.left = `${Math.max(0, Math.min(e.clientX - r.left, root.clientWidth - m.offsetWidth))}px`; m.style.top = `${e.clientY - r.top}px`;
    document.addEventListener('mousedown', away, true); document.addEventListener('keydown', esc, true);
  }
}
