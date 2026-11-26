// background 작업의 출력 창 (ticket slcode-sidebar-revamp, 사용자 2026-11-25) — 입력창 위에 뜨는 작은 검은 창, 머리를 끌어 옮기고 모서리를 끌어 크기를 바꾼다. 출력 파일은 session.bgTail 로 조각만 받는다.
// 뒤로: 받은 위치 뒤만 — 새 출력이 오는 동안은 0.25초, 조용하면 1초까지 늘려 묻는다. 맨 아래를 보고 있으면 화면에는 끝 128K자만 둔다.
// 앞으로: 맨 위 가까이 올리면 그 앞 조각을 받아 붙인다(1M자까지). 조각은 줄 단위 텍스트 노드 — 새 출력은 덧붙이기만 하고 다 다시 그리지 않는다.
// 색 등 ANSI 제어 문자는 빼고, 줄 안의 \r 은 그 줄을 덮어쓴 것으로 본다(진행 막대). 아직 줄이 끝나지 않은 꼬리는 따로 두고 받을 때마다 다시 그린다
const KEEP = 131072, MAX_BACK = 1048576;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const termText = (raw) => raw.replace(ANSI, '').split('\n').map((l) => { const s = l.replace(/\r$/, ''); return s.slice(s.lastIndexOf('\r') + 1); }).join('\n');
const enc = new TextEncoder(), bytes = (s) => enc.encode(s).length;

/** o: { icon, ago } — open(t, sid) 로 연다, sync(tasks, sid) 는 목록이 바뀔 때마다(없어진 작업·다른 세션이면 닫는다) */
export function bgTerm(h, rpc, o) {
  let t = null, sid = null, timer = null, busy = false, older = false, wait = 250;
  let chunks = [], chars = 0, lo = 0, hi = 0, part = '', partAt = 0; // chunks: 줄로 끝나는 조각 {start, node, n}, part: 줄이 끝나지 않은 꼬리(partAt 바이트부터)
  const live = document.createTextNode('');
  const pre = h('pre', {}, live), more = h('div', { class: 'more' }), empty = h('div', { class: 'empty' }, 'empty');
  const sc = h('div', { class: 'sc', onscroll: () => { if (sc.scrollTop < 150) back(); } }, more, pre, empty);
  const st = h('span', { class: 'st' }), head = h('div', { class: 'th', title: '끌어서 옮기기' });
  // 크기 손잡이: 오른쪽 면(머리 줄까지)·아래 면·오른쪽 아래 모서리 — [요소, 가로, 세로]
  const grips = [['r', 1, 0], ['b', 0, 1], ['c', 1, 1]].map(([k, x, y]) => [h('div', { class: `rz ${k}`, title: '끌어서 크기 바꾸기' }), x, y]);
  const el = h('div', { class: 'tw', hidden: '' }, head, sc, ...grips.map(([g]) => g));
  const atBottom = () => sc.scrollHeight - sc.scrollTop - sc.clientHeight < 24;
  // Ctrl+휠은 페이지 확대 대신 출력 글자 크기 (사용자 2026-11-26) — 9~24px, 닫았다 열어도 그 크기. 휠 한 칸(약 100)에 1px, 터치패드 핀치의 잘게 오는 값은 모아서 센다
  let size = 12, acc = 0;
  sc.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    acc += e.deltaMode ? e.deltaY * 40 : e.deltaY;
    if (Math.abs(acc) < 40) return;
    const stick = atBottom();
    size = Math.min(24, Math.max(9, size - Math.sign(acc))); acc = 0;
    sc.style.fontSize = `${size}px`;
    if (stick) sc.scrollTop = sc.scrollHeight;
  }, { passive: false });

  function reset(at = 0) {
    for (const c of chunks) c.node.remove();
    chunks = []; chars = 0; lo = hi = partAt = at; part = ''; live.data = '';
  }
  function add(text, start, front = false) {
    const node = document.createTextNode(termText(text)), c = { start, node, n: node.data.length };
    if (front) { chunks.unshift(c); pre.prepend(node); } else { chunks.push(c); pre.insertBefore(node, live); }
    chars += c.n;
  }
  function paintBody() {
    more.hidden = lo <= 0;
    more.textContent = chars >= MAX_BACK ? '… 앞부분은 출력 파일에' : '… 위로 올리면 앞부분을 더 받습니다';
    empty.hidden = !!(chars || live.data || lo > 0);
  }
  /** 뒤 조각 — 새 출력이 있었으면 true */
  async function pull() {
    if (!t || busy) return false;
    busy = true;
    const want = t.id;
    try {
      const r = await rpc('session.bgTail', { id: sid, task: want, from: hi });
      if (t?.id !== want) return false;
      if (r.start > hi) reset(r.start);
      if (!r.text) return false;
      hi = r.end;
      const stick = atBottom(), all = part + r.text;
      const k = all.length > KEEP ? all.length : all.lastIndexOf('\n') + 1; // 줄 없이 긴 꼬리(\r 진행 막대)는 그대로 조각으로
      if (k) { add(all.slice(0, k), partAt); partAt += bytes(all.slice(0, k)); }
      part = all.slice(k); live.data = termText(part);
      if (stick) {
        while (chunks.length > 1 && chars > KEEP) { const c = chunks.shift(); c.node.remove(); chars -= c.n; }
        lo = chunks[0]?.start ?? partAt;
      }
      paintBody();
      if (stick) sc.scrollTop = sc.scrollHeight;
      return true;
    } catch { return false; } finally { busy = false; }
  }
  /** 앞 조각 — 맨 위 가까이 올렸을 때. 보던 자리가 밀리지 않게 늘어난 높이만큼 내린다 */
  function back() {
    if (!t || older || lo <= 0 || chars >= MAX_BACK) return;
    older = true;
    const want = t.id, end = lo;
    rpc('session.bgTail', { id: sid, task: want, before: end }).then((r) => {
      if (t?.id !== want || lo !== end || r.start >= end) return;
      const h0 = sc.scrollHeight;
      add(r.text, r.start, true); lo = r.start;
      paintBody();
      sc.scrollTop += sc.scrollHeight - h0;
    }, () => {}).finally(() => { older = false; });
  }

  const run = () => t.endedAt === undefined;
  function paintSt() {
    const end = t.stoppedBy === 'user' ? '중지함' : t.code != null ? `끝남 · code ${t.code}` : t.signal ? `끝남 · ${t.signal}` : '끝남';
    st.className = `st${run() ? ' run' : ''}`;
    st.textContent = run() ? `실행 중 · ${o.ago(t.startedAt)}` : end;
  }
  // 머리는 이름·상태·접기·닫기만 (사용자 2026-11-25 — 중지는 목록에서, 접기는 11-26)
  function paintHead() {
    paintSt();
    const tip = folded ? '펼치기' : '접기';
    head.replaceChildren(h('span', { class: 'term' }, o.icon('term')), h('span', { class: 't', title: `${t.command}\n${t.output}` }, t.description || t.command), st,
      h('span', { class: 'act' }, h('button', { class: 'fold', title: tip, 'aria-label': tip, onclick: () => fold(!folded) }, folded ? '□' : '−'),
        h('button', { class: 'x', title: '닫기', 'aria-label': '닫기', onclick: close }, '✕')));
  }
  function poll() {
    clearTimeout(timer); timer = null;
    if (!t || !run()) return;
    timer = setTimeout(async () => {
      wait = (await pull()) ? 250 : Math.min(wait * 2, 1000);
      if (t) { paintSt(); poll(); }
    }, wait);
  }

  // 머리를 끌면 옮기고 오른쪽 면·아래 면·오른쪽 아래 모서리를 끌면 크기를 바꾼다 (사용자 2026-11-26). 닫았다 열어도 그 자리·그 크기.
  // 창은 입력창 오른쪽 위에 붙어 있다 — 크기를 바꾼 만큼 옮겨 왼쪽 위 모서리를 제자리에 둔다. 머리는 화면 밖으로 나가지 않는다
  const MIN_W = 320, MIN_H = 120;
  let dx = 0, dy = 0, w = 0, ht = 0; // w·ht 가 0 이면 CSS 기본 크기
  const place = () => {
    el.style.translate = dx || dy ? `${dx}px ${dy}px` : '';
    el.style.width = w ? `${w}px` : ''; el.style.height = ht ? `${ht}px` : '';
  };
  function grab(handle, cls, move) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a')) return;
      e.preventDefault();
      const s = { r: el.getBoundingClientRect(), dx, dy, x: e.clientX, y: e.clientY, stick: atBottom() };
      const mv = (ev) => { move(ev.clientX - s.x, ev.clientY - s.y, s); place(); if (s.stick) sc.scrollTop = sc.scrollHeight; };
      const up = () => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); el.classList.remove(cls); };
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
      el.classList.add(cls);
    });
  }
  grab(head, 'drag', (mx, my, { r, dx: x0, dy: y0 }) => {
    dx = x0 + Math.min(Math.max(mx, -r.left), innerWidth - r.right);
    dy = y0 + Math.min(Math.max(my, -r.top), innerHeight - r.top - head.offsetHeight);
  });
  for (const [g, x, y] of grips) grab(g, `size-${g.classList[1]}`, (mx, my, { r, dx: x0, dy: y0 }) => {
    if (x) { w = Math.round(Math.min(Math.max(r.width + mx, MIN_W), innerWidth - r.left)); dx = x0 + w - r.width; }
    if (y) { ht = Math.round(Math.min(Math.max(r.height + my, MIN_H), innerHeight - r.top)); dy = y0 + ht - r.height; }
  });

  // − 로 접으면 머리 줄만 남는다 (사용자 2026-11-26). 창은 아래가 붙어 있으므로 줄어든 높이만큼 위로 옮겨 머리를 제자리에 둔다.
  // 펼치면 맨 아래(최신 출력)로 — 접힌 동안(display none)은 스크롤 자리가 남지 않는다. 펼쳤을 때 아래가 화면 밖이면 올린다
  let folded = false, foldH = 0;
  function fold(on) {
    if (on === folded) return;
    const h0 = el.getBoundingClientRect().height;
    folded = on; el.classList.toggle('min', on);
    if (on) { foldH = h0 - el.getBoundingClientRect().height; dy -= foldH; } else dy += foldH;
    place();
    if (!on) {
      const over = el.getBoundingClientRect().bottom - innerHeight;
      if (over > 0) { dy -= over; place(); }
      sc.scrollTop = sc.scrollHeight;
    }
    if (t) paintHead();
  }

  function open(task, session) {
    const same = t?.id === task.id && sid === session;
    t = task; sid = session;
    if (!same) { reset(); paintBody(); }
    el.hidden = false;
    fold(false);
    // 브라우저 창 크기가 바뀌어 화면 밖이면 처음 자리·크기로
    const r = el.getBoundingClientRect();
    if (r.left < 0 || r.right > innerWidth || r.top < 0 || r.top + head.offsetHeight > innerHeight) { dx = dy = w = ht = 0; place(); }
    paintHead();
    wait = 250;
    pull().then(() => { if (!same) sc.scrollTop = sc.scrollHeight; });
    poll();
  }
  function close() { t = null; clearTimeout(timer); timer = null; reset(); el.hidden = true; }
  function sync(tasks, session) {
    if (!t) return;
    const now = session === sid ? tasks.find((x) => x.id === t.id) : null;
    if (!now) return close();
    const ended = run() && now.endedAt !== undefined;
    t = now; paintHead();
    if (ended) { // 남은 출력을 끝까지 — 도는 중인 받기가 있으면 끝나기를 기다린다
      clearTimeout(timer); timer = null;
      (async () => { while (busy) await new Promise((r) => setTimeout(r, 50)); while (t && (await pull())); })();
    }
  }
  return { el, open, close, sync, get task() { return t?.id ?? null; } };
}
