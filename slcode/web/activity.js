// 활동 기록 (ticket slcode-activity-state, 사용자 결정 2026-10-25~27 — /tmp 프로토타입으로 정함).
// 이 화면은 사람 행동을 약한·강한 신호로 갈라 core 에 알리고(session.signal), core 가 판정한 결과(session.activity)를 그린다.
//   사이드바 "활동 기록" 칸: 지금 상태 한 줄 + 최근 1시간 띠(활성·AFK·세션 꺼짐 셋). 판정 과정(남은 시간·남은 신호 수)은 보이지 않는다.
//   "자세히": 모달 — 전체(달력)·날짜별(하루 한 줄)·일별(여러 줄). 머리글 알약으로 오간다.
// 신호 (사용자 2026-10-25). 마우스 움직임·포커스는 세지 않는다. 같은 종류가 2초 안에 몰린 것은 하나:
//   약한 신호 — 키, 클릭, 스크롤
//   강한 신호 — 입력창에 1초 넘게 입력, Esc, 복사, 글자 선택, 버튼·링크·접기 클릭, 한 묶음 스크롤이 화면 60% 넘게, 스크롤이 응답 시작 근처에서 멈춤.
//   그 행동의 약한 신호 뒤에(또는 같은 순간에) 낸다. 보냄·답변은 core 가 직접 적는다.
//   스크롤은 바퀴·터치·키·스크롤바를 잡은 뒤에만 — 새 답변을 따라 내려가는 화면 스스로의 스크롤은 신호가 아니다
import { closeOnBackdrop } from './settings.js';

const pad = (n) => String(n).padStart(2, '0');


const M = 60e3, HOUR = 60 * M;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const LBL = { waiting: '응답 대기', asking: '질문 상태', active: '확인 중', afk: 'AFK', exited: '세션 꺼짐' };
const COARSE = { waiting: 'on', asking: 'on', active: 'on', afk: 'afk', exited: 'off' };
const CL = { on: '활성', afk: 'AFK', off: '세션 꺼짐' };
const EASE = 'cubic-bezier(.2,.7,.2,1)';

const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (t, n) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mday = (t) => { const d = new Date(t); return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`; };
function fmtLong(ms) {
  if (ms < 60e3) return `${Math.max(0, Math.floor(ms / 1000))}초`;
  const m = Math.floor(ms / 60e3), d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && `${d}일`, hh && `${hh}시간`, (mm || (!d && !hh)) && `${mm}분`].filter(Boolean).join(' ');
}
// 구간 끝이 그날 자정이면 00:00 대신 24:00
const hhmmEnd = (t, day) => (t >= day.e ? '24:00' : hhmm(t));
// 구간 길이 — 양 끝을 hhmm 처럼 분 단위로 버린 뒤 잰다. 00:00~08:48 은 늘 8시간 48분
const fmtSpan = (f, t) => fmtLong(Math.floor(t / M) * M - Math.floor(f / M) * M);

// ---- 자료 — 열 때 한 번, 날마다 잘라 둔다
function prep(w, now) {
  const days = [], idx = new Map();
  for (let d = dayStart(w.start); d <= dayStart(now); d = addDays(d, 1)) {
    idx.set(d, days.length);
    days.push({ d, e: addDays(d, 1), segs: [], agent: [], user: [], points: [], sum: { waiting: 0, asking: 0, active: 0, afk: 0, exited: 0 } });
  }
  const spread = (key, x) => {
    for (let d = dayStart(x.from); d < x.to && idx.has(d); d = addDays(d, 1)) {
      const day = days[idx.get(d)], from = Math.max(x.from, day.d), to = Math.min(x.to, day.e, now);
      if (to > from) day[key].push({ ...x, from, to });
    }
  };
  for (const x of w.segs) spread('segs', x);
  for (const x of w.agent) spread('agent', x);
  for (const x of w.user) spread('user', x);
  for (const p of w.points) { const i = idx.get(dayStart(p.t)); if (i != null) days[i].points.push(p); }
  const total = { waiting: 0, asking: 0, active: 0, afk: 0, exited: 0 };
  for (const day of days) {
    day.segs.sort((a, b) => a.from - b.from);
    for (const s of day.segs) { day.sum[s.cls] += s.to - s.from; total[s.cls] += s.to - s.from; }
    day.on = day.sum.waiting + day.sum.asking + day.sum.active;
    day.coarse = [];
    for (const s of day.segs) {
      const c = COARSE[s.cls], l = day.coarse.at(-1);
      if (l && l.cls === c && s.from - l.to < 1000) l.to = Math.max(l.to, s.to); else day.coarse.push({ from: s.from, to: s.to, cls: c });
    }
  }
  return { days, start: w.start, now, total };
}
const level = (on) => (on <= 0 ? 0 : on < HOUR ? 1 : on < 2.5 * HOUR ? 2 : on < 4.5 * HOUR ? 3 : 4);
const dayLine = (day) => `${mday(day.d)} · 활성 ${fmtLong(day.on)} · AFK ${fmtLong(day.sum.afk)}${day.sum.exited ? ` · 세션 꺼짐 ${fmtLong(day.sum.exited)}` : ''}`;


// ---- 신호
function watchSignals({ root, feed, input, emit, groupMs = 2000, typeMs = 1000, farRatio = 0.6 }) {
  const groups = {};
  function hit(kind) {
    const t = Date.now(), g = groups[kind];
    if (g && t - g.last <= groupMs) { g.last = t; return g; }
    emit('weak', kind);
    return (groups[kind] = { from: t, last: t, strong: false });
  }
  function strong(g, what) { if (g.strong) return; g.strong = true; emit('strong', what); }

  document.addEventListener('keydown', (e) => {
    const g = hit('key');
    if (e.key === 'Escape') strong(g, 'esc');
    else if ((e.ctrlKey || e.metaKey) && e.key === 'c') strong(g, 'copy');
    else if (e.target === input && Date.now() - g.from >= typeMs) strong(g, 'type');
  }, true);
  root.addEventListener('click', (e) => {
    const g = hit('click');
    if (e.target.closest('button, a, summary, select, [role=button]')) strong(g, 'button');
  }, true);
  root.addEventListener('mouseup', () => {
    const s = getSelection();
    if (s && !s.isCollapsed && root.contains(s.anchorNode)) strong(hit('click'), 'select');
  });

  // 사람이 움직인 스크롤만 — 바퀴·터치·스크롤바(피드를 누름)·키 뒤 1초 안
  let handAt = 0;
  const hand = () => { handAt = Date.now(); };
  for (const ev of ['wheel', 'touchmove', 'pointerdown']) feed.addEventListener(ev, hand, { passive: true });
  document.addEventListener('keydown', hand, true);
  const nearStart = () => {
    // 응답의 시작 = 내 요청 말풍선 바로 다음 항목. 그 머리가 화면 위쪽 1/4 안에 들어왔는가
    const top = feed.getBoundingClientRect().top, hgt = feed.clientHeight;
    return [...feed.querySelectorAll('.user')].some((u) => { const n = u.nextElementSibling; if (!n) return false; const y = n.getBoundingClientRect().top - top; return y >= -hgt * 0.05 && y <= hgt * 0.25; });
  };
  feed.addEventListener('scroll', () => {
    if (Date.now() - handAt > 1000) return;
    const g = hit('scroll');
    g.top0 ??= feed.scrollTop;
    if (Math.abs(feed.scrollTop - g.top0) >= feed.clientHeight * farRatio) strong(g, 'scroll-far');
    clearTimeout(g.end);
    g.end = setTimeout(() => { if (nearStart()) strong(g, 'scroll-start'); }, 250);
  }, { passive: true });
}

// ---- 판정 결과 → 그릴 구간
/** 한 줄 구간 — 응답 대기·세션 꺼짐(에이전트) + 사람 구간. 질문 상태 동안의 확인 중은 질문 상태로 */
function merged(r) {
  const out = r.agent.filter((s) => s.state === 'running' || s.state === 'exited').map((s) => ({ from: s.from, to: s.to, cls: s.state === 'running' ? 'waiting' : 'exited' }));
  const asks = r.agent.filter((s) => s.state === 'asking');
  let k = 0; // 둘 다 시각순
  for (const u of r.user) {
    while (k < asks.length && asks[k].to <= u.from) k++;
    const inAsk = k < asks.length && u.from >= asks[k].from;
    out.push({ from: u.from, to: u.to, cls: inAsk && u.label === 'active' ? 'asking' : u.label });
  }
  return out.sort((a, b) => a.from - b.from);
}
const busy = (a) => a.state === 'running' || a.state === 'asking' || a.state === 'exited';
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간 ${m % 60}분`;
}
/** 지금 상태 한 줄 — {cls, main, since, sub} */
function nowText(c) {
  if (!c) return null;
  if (c.label === 'waiting') return { cls: 'waiting', main: LBL.waiting, since: c.since };
  if (c.agent === 'exited') return { cls: 'exited', main: LBL.exited, since: c.agentSince };
  if (c.agent === 'asking') return c.label === 'afk' ? { cls: 'afk', main: 'AFK', since: c.since, sub: '질문 대기 중' } : { cls: 'asking', main: LBL.asking, since: c.agentSince };
  return { cls: c.label, main: LBL[c.label], since: c.since };
}

/** 사이드바 칸과 모달. getId: 지금 세션 id. body·more 는 사이드바를 다시 그려도 같은 노드다 — app.js 가 섹션에 끼운다 */
export function activityPanel(h, rpc, { getId, root, feed, input }) {
  const body = h('div', { class: 'act-rec' });
  const modal = activityModal(h);
  // 머리글 안의 버튼 — 누르면 섹션이 접히지 않게 기본 동작을 막는다
  const more = h('button', { class: 'act-more', type: 'button', onclick: (e) => { e.preventDefault(); e.stopPropagation(); void openModal(); } }, '자세히');
  let res = null, skew = 0; // res: 최근 1시간 판정, skew: core 시계 - 이 화면 시계
  const coreNow = () => Date.now() + skew;
  const WIN = 60 * M;

  function paint() {
    const c = nowText(res?.current);
    const now = coreNow();
    const line = c
      ? h('div', { class: 'act-now' }, h('span', { class: `act-dot st-${c.cls}` }), h('b', {}, c.main), h('span', { class: 'act-dim' }, fmtDur(now - c.since)), c.sub ? h('span', { class: 'act-dim' }, c.sub) : null)
      : h('div', { class: 'act-now' }, h('span', { class: 'act-dim' }, '—'));
    body.replaceChildren(line, strip(now));
  }
  function strip(now) {
    const a = now - WIN;
    const pos = (t) => `${Math.max(0, (t - a) / WIN) * 100}%`;
    const wid = (f, t) => `${(Math.max(0, Math.min(t, now) - Math.max(f, a)) / WIN) * 100}%`;
    // 끝이 마지막 판정 시각이면 아직 이어지는 구간 — 지금까지 늘린다
    const end = (t) => (res && t >= res.now ? now : t);
    // 활성·AFK·세션 꺼짐 셋으로 (사용자 2026-10-27) — 이어진 같은 색은 한 구간으로
    const coarse = [];
    for (const x of res ? merged(res) : []) {
      const c = COARSE[x.cls], l = coarse.at(-1), to = end(x.to);
      if (l && l.cls === c && x.from - l.to < 1000) l.to = Math.max(l.to, to); else coarse.push({ from: x.from, to, cls: c });
    }
    const segs = coarse.filter((x) => x.to > a).map((x) => h('i', { class: `st-${x.cls}`, style: `left:${pos(x.from)};width:${wid(x.from, x.to)}`, title: `${CL[x.cls]} ${hhmm(x.from)}~${hhmm(Math.min(x.to, now))}` }));
    const ticks = [...(res?.points ?? []).filter((p) => p.t > a).map((p) => h('b', { style: `left:${pos(p.t)}`, title: `${p.kind === 'sent' ? '요청 보냄' : '질문 답변함'} ${hhmm(p.t)}` })),
      ...(res?.peeks ?? []).filter((p) => p.t > a).map((p) => h('b', { class: 'peek', style: `left:${pos(p.t)}`, title: `잠깐 확인 ${hhmm(p.t)}` }))];
    return h('div', { class: 'act-strip' }, h('div', { class: 'lane' }, ...segs, ...ticks), h('div', { class: 'ax' }, h('span', {}, '1시간 전'), h('span', {}, '지금')));
  }

  let loading = null;
  function refresh() {
    const id = getId();
    if (!id || loading) return loading;
    return (loading = rpc('session.activity', { id, from: coreNow() - WIN })
      .then((r) => { skew = r.now - Date.now(); res = r; paint(); }, () => {})
      .finally(() => { loading = null; }));
  }
  let soon = null;
  const refreshSoon = () => { clearTimeout(soon); soon = setTimeout(refresh, 800); };
  async function openModal() {
    const id = getId();
    if (!id) return;
    const r = await rpc('session.activity', { id });
    modal.open({ start: r.start ?? r.now, segs: merged(r), agent: r.agent.filter(busy), user: r.user, points: r.points }, r.now);
  }

  watchSignals({ root, feed, input, emit: (strength, what) => {
    const id = getId();
    if (!id) return;
    rpc('session.signal', { id, strength, what }).catch(() => {});
    refreshSoon(); // AFK 에서 돌아왔으면 곧 보인다
  } });
  paint();
  setInterval(paint, 1000); // 지속 시간과 띠 끝 — 판정은 아래 주기로 받는다
  setInterval(refresh, 30000);
  return { body, more, dialog: modal.dlg, refresh };
}

/** 모달 "활동 기록" — 전체(달력)·날짜별(하루 한 줄)·일별(여러 줄, 끌어 옮기고 바퀴로 확대). w = {start, segs, agent, user, points} */
function activityModal(h) {
  const INFO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
  // ⓘ — 올리거나 포커스하면 설명이 뜬다
  const info = (text) => { const el = h('span', { class: 'info', tabindex: '0', role: 'img', 'aria-label': text, title: text }); el.innerHTML = INFO; return el; };
  const sw = (c) => h('i', { class: `swc st-${c}` });

  const body = h('div', { class: 'body' }), views = h('nav', { class: 'views', 'aria-label': '보기' });
  const dlg = h('dialog', { class: 'settings act-dlg' },
    h('header', {}, h('h2', {}, '활동 기록'), views, h('button', { class: 'ghost x', title: '닫기', 'aria-label': '닫기', onclick: () => dlg.close() }, '✕')), body);
  closeOnBackdrop(dlg);
  let D, V = { view: 'days' };
  // 세션은 대개 며칠이라 날짜별(오늘)부터 연다 (사용자 2026-10-27)
  function open(w, now) { D = prep(w, now); dlg.showModal(); showDays(D.days.length - 1); }
  const VIEWS = [['all', '전체', (i) => showAll(i)], ['days', '날짜별', (i) => showDays(i)], ['day', '일별', (i) => showDay(i)]];
  function setViews() {
    // 고른 날은 화면을 옮겨도 그대로다 — 날짜별에서 ↑↓ 로 바꾼 날도 누를 때 읽는다
    views.replaceChildren(...VIEWS.map(([k, label, go]) => h('button', { type: 'button', class: V.view === k ? 'on' : '', 'aria-pressed': String(V.view === k), onclick: V.view === k ? null : () => go(V.di ?? D.days.length - 1) }, label)));
  }
  const fadeIn = (el, delay = 0) => el.animate([{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], { duration: 160, delay, easing: EASE, fill: 'backwards' });
  const pulse = (el) => el?.animate([{ boxShadow: '0 0 0 2px color-mix(in srgb, var(--acf-accent) 40%, transparent)' }, { boxShadow: '0 0 0 2px transparent' }], { duration: 700, easing: 'ease-out' });

  // ---- 전체 — 달력
  function showAll(focus) {
    V = { view: 'all', di: focus };
    setViews();
    const t = D.total, on = t.waiting + t.asking + t.active;
    const summary = h('section', { class: 'sum' },
      h('div', { class: 'big' },
        h('div', {}, h('span', { class: 'k' }, '시작'), h('b', {}, `${new Date(D.start).getFullYear()}년 ${mday(D.start)} ${hhmm(D.start)}`)),
        h('div', {}, h('span', { class: 'k' }, '전체 시간'), h('b', {}, fmtLong(on + t.afk))),
        h('div', {}, h('span', { class: 'k' }, '작업 시간', info('AFK 제외 시간')), h('b', {}, fmtLong(on)))),
      h('div', { class: 'brk' }, ['waiting', 'asking', 'active', 'afk', 'exited'].map((c) => h('span', {}, sw(c), `${LBL[c]} ${fmtLong(t[c])}`))),
      h('div', { class: 'brk' }, `일한 날 ${D.days.filter((d) => d.on > 0).length}일 / ${D.days.length}일`));

    const sun = addDays(D.days[0].d, -new Date(D.days[0].d).getDay());
    const at = (day) => { const n = Math.round((day.d - sun) / 864e5); return [Math.floor(n / 7), n % 7]; };
    const cells = [], months = [];
    let lastMon = -1;
    D.days.forEach((day, i) => {
      const [col, row] = at(day), mon = new Date(day.d).getMonth();
      if (mon !== lastMon) {
        // 앞 글자와 세 칸 안이면 앞 것을 지운다 (GitHub 처럼 첫 달이 짧으면 이름을 생략)
        if (months.length && col - months.at(-1).col < 3) months.pop();
        months.push({ col, el: h('span', { style: `grid-column:${col + 1}` }, `${mon + 1}월`) }); lastMon = mon;
      }
      cells.push(h('button', { type: 'button', class: `c l${level(day.on)}${i === D.days.length - 1 ? ' today' : ''}`, style: `grid-column:${col + 1};grid-row:${row + 1}`, 'data-i': String(i), 'aria-label': dayLine(day) }));
    });
    const cols = at(D.days.at(-1))[0] + 1;
    const grid = h('div', { class: 'hm-grid', style: `grid-template-columns:repeat(${cols}, var(--cell))` }, cells);
    const read = h('p', { class: 'readout' }, dayLine(D.days.at(-1)));
    const legend = h('div', { class: 'hm-leg' }, h('span', {}, '적음'), [0, 1, 2, 3, 4].map((l) => h('i', { class: `c l${l}` })), h('span', {}, '많음 · 활성 시간'));
    const scroller = h('div', { class: 'hm-scroll' },
      h('div', { class: 'hm' },
        h('div', { class: 'hm-mon', style: `grid-template-columns:repeat(${cols}, var(--cell))` }, months.map((m) => m.el)),
        h('div', { class: 'hm-wd' }, WD.map((d, i) => h('span', {}, i % 2 ? d : ''))),
        grid));
    grid.onmouseover = grid.onfocusin = (e) => { const c = e.target.closest('.c'); if (c) read.textContent = dayLine(D.days[Number(c.dataset.i)]); };
    grid.onclick = (e) => { const c = e.target.closest('.c'); if (c) showDays(Number(c.dataset.i), c.getBoundingClientRect(), getComputedStyle(c).backgroundColor); };
    body.replaceChildren(h('div', { class: 'v-all' }, summary, h('section', {}, scroller, legend, read)));
    scroller.scrollLeft = scroller.scrollWidth; // GitHub 처럼 최근이 보이게
    fadeIn(body.firstChild);
    if (focus != null) { const c = grid.querySelector(`[data-i="${focus}"]`); c.scrollIntoView({ block: 'nearest', inline: 'nearest' }); pulse(c); read.textContent = dayLine(D.days[focus]); }
  }

  // ---- 날짜별 — 하루 한 줄을 위아래로
  function bar(day, cls = 'bar') {
    const pct = (x) => `${((x - day.d) / (day.e - day.d)) * 100}%`;
    return h('div', { class: cls }, day.coarse.map((s) => h('i', { class: `st-${s.cls}`, style: `left:${pct(s.from)};width:calc(${pct(s.to)} - ${pct(s.from)})` })), h('div', { class: 'gl' }));
  }
  /** 바퀴 굴림을 부드럽게 따라간다. 멈춘 뒤 줄에 맞추지는 않는다 (사용자 2026-10-27) */
  function glide(el) {
    let target = el.scrollTop, raf = 0;
    const max = () => el.scrollHeight - el.clientHeight;
    const step = () => {
      const d = target - el.scrollTop;
      if (Math.abs(d) < 1) { el.scrollTop = target; raf = 0; return; }
      el.scrollTop += Math.sign(d) * Math.max(1, Math.abs(d) * 0.16);
      raf = requestAnimationFrame(step);
    };
    const go = (t) => { target = Math.max(0, Math.min(max(), t)); if (!raf) raf = requestAnimationFrame(step); };
    const center = (row) => row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      go(target + (e.deltaMode === 1 ? e.deltaY * 34 : e.deltaY));
    }, { passive: false });
    el.addEventListener('scroll', () => { if (!raf) target = el.scrollTop; }, { passive: true }); // 스크롤바를 끌었을 때
    return { go, to: (row) => go(center(row)), jump: (row) => { target = Math.max(0, Math.min(max(), center(row))); el.scrollTop = target; } };
  }
  function showDays(i, fromRect, fromColor) {
    V = { view: 'days', di: i };
    setViews();
    const ax = h('div', { class: 'd-ax' }, h('span'), h('div', { class: 'ax' }, [0, 3, 6, 9, 12, 15, 18, 21, 24].map((x) => h('span', { style: `left:${(x / 24) * 100}%` }, String(x)))), h('span', { class: 'k' }, '활성'));
    // 달마다 묶는다 — 달 머리글은 그 달이 보이는 동안만 위에 붙는다
    const kids = [ax], rows = [];
    let lastMon = -1, group = null;
    D.days.forEach((day, k) => {
      const dt = new Date(day.d);
      if (dt.getMonth() !== lastMon) { group = h('div', { class: 'd-month' }, h('div', { class: 'd-mon' }, `${dt.getFullYear()}년 ${dt.getMonth() + 1}월`)); kids.push(group); lastMon = dt.getMonth(); }
      const row = h('div', { class: `d-row${day.on ? '' : ' rest'}${k === D.days.length - 1 ? ' today' : ''}`, 'data-i': String(k), tabindex: '-1' },
        h('span', { class: 'dl' }, `${dt.getDate()}일 (${WD[dt.getDay()]})`, k === D.days.length - 1 ? h('em', {}, '오늘') : null),
        bar(day), h('span', { class: 'tot' }, day.on ? fmtLong(day.on) : '—'));
      group.append(row); rows.push(row);
    });
    const list = h('div', { class: 'd-list' }, kids);
    const read = h('p', { class: 'readout' });
    const legend = h('div', { class: 'brk' }, ['on', 'afk', 'off'].map((c) => h('span', {}, sw(c), CL[c])), h('span', {}, '| 빈칸: 기록 없음'));
    body.replaceChildren(h('div', { class: 'v-days' }, list, h('div', { class: 'foot' }, legend, read)));
    const g = glide(list);
    let sel = rows[i];
    const select = (row, ease = true) => {
      sel?.classList.remove('sel'); sel = row; sel.classList.add('sel');
      V.di = Number(row.dataset.i); read.textContent = dayLine(D.days[V.di]);
      ease ? g.to(row) : g.jump(row);
    };
    select(rows[i], false);
    list.onmousemove = (e) => {
      const row = e.target.closest('.d-row'); if (!row) return;
      const day = D.days[Number(row.dataset.i)], b = row.querySelector('.bar').getBoundingClientRect();
      const t = day.d + ((e.clientX - b.left) / b.width) * (day.e - day.d);
      const s = e.clientX >= b.left && e.clientX <= b.right ? day.coarse.find((x) => t >= x.from && t < x.to) : null;
      read.textContent = s ? `${mday(day.d)} ${hhmm(s.from)}~${hhmmEnd(s.to, day)} · ${CL[s.cls]} ${fmtSpan(s.from, s.to)}` : dayLine(day);
    };
    list.onclick = (e) => { const row = e.target.closest('.d-row'); if (row) showDay(Number(row.dataset.i), row.querySelector('.bar').getBoundingClientRect()); };
    list.onkeydown = (e) => {
      const k = rows.indexOf(sel);
      if (e.key === 'ArrowDown' && k < rows.length - 1) { e.preventDefault(); select(rows[k + 1]); }
      else if (e.key === 'ArrowUp' && k > 0) { e.preventDefault(); select(rows[k - 1]); }
      else if (e.key === 'Enter') { e.preventDefault(); showDay(V.di, sel.querySelector('.bar').getBoundingClientRect()); }
    };
    list.tabIndex = 0; list.focus({ preventScroll: true });

    if (fromRect) {
      // 달력 칸이 그날의 줄로 늘어난다 — 칸 색으로 덮인 줄이 제자리로 가며 덮개가 걷힌다
      const target = sel.querySelector('.bar'), to = target.getBoundingClientRect();
      const ghost = h('div', { class: 'act-ghost', style: `left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px` }, bar(D.days[i]), h('i', { class: 'cover', style: `background:${fromColor}` }));
      dlg.append(ghost);
      target.style.visibility = 'hidden';
      const dur = 300;
      ghost.animate([{ transform: `translate(${fromRect.left - to.left}px, ${fromRect.top - to.top}px) scale(${fromRect.width / to.width}, ${fromRect.height / to.height})` }, { transform: 'none' }], { duration: dur, easing: EASE, fill: 'both' });
      ghost.lastChild.animate([{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: dur, fill: 'both' });
      list.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 60, easing: 'ease-out', fill: 'backwards' });
      setTimeout(() => { target.style.visibility = ''; ghost.remove(); }, dur + 20);
    } else { fadeIn(list); pulse(sel); }
  }

  // ---- 하루 — 여러 줄로 자세히
  function showDay(i, fromRect) {
    V = { view: 'day', di: i };
    setViews();
    const day = D.days[i];
    // 보이는 범위 — 처음엔 그날 활성 구간 앞뒤 30분(시 단위로 맞춤). 바퀴로 확대·축소(최대 0~24시), 끌어서 좌우로 옮긴다 (사용자 2026-10-27)
    const ons = day.segs.filter((s) => COARSE[s.cls] === 'on');
    let from0 = day.d, to0 = day.e;
    if (ons.length) {
      from0 = Math.max(day.d, Math.floor((ons[0].from - 30 * M - day.d) / HOUR) * HOUR + day.d);
      to0 = Math.min(day.e, Math.ceil((ons.at(-1).to + 30 * M - day.d) / HOUR) * HOUR + day.d);
      if (to0 - from0 < 3 * HOUR) to0 = Math.min(day.e, from0 + 3 * HOUR);
    }
    const DAYW = day.e - day.d;
    // 구간은 그날 전체(0~24시)를 기준으로 한 번만 그린다. 범위가 바뀌면 트랙의 폭과 위치만 바꾼다
    const dp = (t) => `${((t - day.d) / DAYW) * 100}%`;
    const seg = (s, cls, label) => h('div', { class: `seg st-${cls}`, style: `left:${dp(s.from)};width:calc(${dp(s.to)} - ${dp(s.from)})` }, cls !== 'exited' ? h('span', {}, label) : null);
    const agentCls = { running: 'waiting', asking: 'asking', exited: 'exited' };
    const nowLine = () => (D.now >= day.d && D.now < day.e ? h('div', { class: 'now', style: `left:${dp(D.now)}` }) : null);
    const track = (kids) => h('div', { class: 'trk' }, kids, nowLine());
    const tracks = [
      track(day.agent.map((a) => seg(a, agentCls[a.state], LBL[agentCls[a.state]]))),
      track(day.user.map((u) => seg(u, u.label, LBL[u.label]))),
      track(day.points.map((p) => h('div', { class: `tp ${p.kind}`, style: `left:${dp(p.t)}` }))),
    ];
    const axTrk = h('div', { class: 'trk' });
    tracks.push(axTrk);
    const hov = h('div', { class: 'hov', hidden: '' });
    const tl = h('div', { class: 'd-tl' },
      h('span', { class: 'nm' }, '에이전트'), h('div', { class: 'lane' }, tracks[0]),
      h('span', { class: 'nm' }, '사람'), h('div', { class: 'lane' }, tracks[1]),
      h('span', { class: 'nm' }, '요청·답변'), h('div', { class: 'lane pts' }, tracks[2]),
      h('span'), h('div', { class: 'ax' }, axTrk),
      h('div', { class: 'hov-wrap' }, hov));

    const btn = (label, ok, fn) => h('button', { type: 'button', class: 'dnav', disabled: ok ? null : '', onclick: fn }, label);
    const nav = h('div', { class: 'd-nav' },
      btn('‹ 이전 날', i > 0, () => showDay(i - 1)), h('b', {}, mday(day.d)), btn('다음 날 ›', i < D.days.length - 1, () => showDay(i + 1)));
    const s = day.sum, nS = day.points.filter((p) => p.kind === 'sent').length;
    const sums = h('div', { class: 'big' },
      h('div', {}, h('span', { class: 'k' }, '활성'), h('b', {}, fmtLong(day.on))),
      h('div', {}, h('span', { class: 'k' }, 'AFK'), h('b', {}, fmtLong(s.afk))),
      h('div', {}, h('span', { class: 'k' }, '세션 꺼짐'), h('b', {}, fmtLong(s.exited))),
      h('div', {}, h('span', { class: 'k' }, '요청 · 답변'), h('b', {}, `${nS}번 · ${day.points.length - nS}번`)));
    // 활성의 나눔만 시간을 붙인다 — AFK·세션 꺼짐 시간은 바로 위에 있다
    const brk = h('div', { class: 'brk' }, ['waiting', 'asking', 'active'].map((c) => h('span', {}, sw(c), `${LBL[c]} ${fmtLong(s[c])}`)), ['afk', 'exited'].map((c) => h('span', {}, sw(c), LBL[c])), h('span', {}, '| 눈금: 요청 보냄(검정)·질문 답변함(노랑)'));
    const read = h('p', { class: 'readout' }, day.on ? '' : '이날은 활성 시간이 없습니다.');
    body.replaceChildren(h('div', { class: 'v-day' }, nav, h('section', { class: 'sum' }, sums, brk), tl, read));

    // ---- 보기 조작 — 지금 범위(cur)가 목표(tgt)를 부드럽게 따라간다
    const MINW = 20 * M;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const cur = { from: from0, w: to0 - from0 }, tgt = { ...cur };
    const clamp = (v) => { v.w = Math.min(DAYW, Math.max(MINW, v.w)); v.from = Math.min(day.e - v.w, Math.max(day.d, v.from)); };
    const laneW = () => tl.querySelector('.lane').clientWidth;
    const STEPS = [10 * M, 15 * M, 30 * M, HOUR, 2 * HOUR, 3 * HOUR];
    let step = 0, mouseX = null, raf = 0, vel = 0, drag = null;
    const apply = () => {
      const width = `${(DAYW / cur.w) * 100}%`, shift = `translateX(${(-(cur.from - day.d) / DAYW) * 100}%)`;
      for (const t of tracks) { t.style.width = width; t.style.transform = shift; }
      // 눈금 간격은 보이는 폭에 맞춰 바꾼다 — 바뀔 때만 다시 만든다
      const st = STEPS.find((x) => cur.w / x <= 9) ?? STEPS.at(-1);
      if (st !== step) {
        step = st;
        const ticks = [];
        for (let t = day.d; t <= day.e; t += st) ticks.push(h('span', { style: `left:${dp(t)}` }, t >= day.e ? '24:00' : hhmm(t)));
        axTrk.replaceChildren(...ticks);
      }
      if (mouseX != null) readAt(mouseX);
    };
    const frame = () => {
      if (!drag && vel) {
        // 놓은 뒤 관성 — 끝에 닿으면 멈춘다
        tgt.from += vel * 16; vel *= 0.9;
        const before = tgt.from; clamp(tgt);
        if (Math.abs(vel) * 16 < cur.w / 4000 || tgt.from !== before) vel = 0;
      }
      const k = reduce ? 1 : 0.2;
      cur.from += (tgt.from - cur.from) * k; cur.w += (tgt.w - cur.w) * k;
      const done = !vel && Math.abs(tgt.from - cur.from) < cur.w / 5000 && Math.abs(tgt.w - cur.w) < cur.w / 5000;
      if (done) Object.assign(cur, tgt);
      apply();
      raf = done ? 0 : requestAnimationFrame(frame);
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };
    tl.addEventListener('wheel', (e) => {
      const lane = tl.querySelector('.lane').getBoundingClientRect();
      e.preventDefault(); vel = 0;
      const unit = e.deltaMode === 1 ? 34 : 1;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) tgt.from += (e.deltaX * unit / lane.width) * tgt.w; // 트랙패드 좌우 밀기
      else {
        // 바퀴 아래 = 넓게, 위 = 좁게. 마우스 아래 시각이 제자리에 남는다
        const x = Math.min(1, Math.max(0, (e.clientX - lane.left) / lane.width));
        const at = cur.from + x * cur.w;
        tgt.w *= Math.exp(e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0015));
        clamp(tgt);
        tgt.from = at - x * tgt.w;
      }
      clamp(tgt); kick();
    }, { passive: false });
    tl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !e.target.closest('.lane, .ax')) return;
      e.preventDefault(); tl.setPointerCapture(e.pointerId); tl.classList.add('dragging');
      tgt.w = cur.w; vel = 0;
      drag = { x: e.clientX, from: cur.from, samples: [[performance.now(), cur.from]] };
    });
    tl.addEventListener('pointermove', (e) => {
      mouseX = e.clientX;
      if (!drag) { readAt(e.clientX); return; }
      tgt.from = drag.from - ((e.clientX - drag.x) / laneW()) * cur.w; clamp(tgt);
      cur.from = tgt.from; apply();
      const n = performance.now(); drag.samples.push([n, cur.from]);
      while (drag.samples.length > 2 && n - drag.samples[0][0] > 80) drag.samples.shift();
    });
    const endDrag = () => {
      if (!drag) return;
      const [t0, f0] = drag.samples[0], [t1, f1] = drag.samples.at(-1);
      vel = t1 - t0 > 0 && performance.now() - t1 < 60 ? (f1 - f0) / (t1 - t0) : 0;
      drag = null; tl.classList.remove('dragging'); kick();
    };
    tl.addEventListener('pointerup', endDrag);
    tl.addEventListener('pointercancel', endDrag);
    tl.addEventListener('pointerleave', () => { if (!drag) { mouseX = null; hov.hidden = true; } });

    function readAt(clientX) {
      const lane = tl.querySelector('.lane').getBoundingClientRect();
      const x = (clientX - lane.left) / lane.width;
      if (x < 0 || x > 1) { hov.hidden = true; return; }
      const t = cur.from + x * cur.w;
      hov.hidden = false; hov.style.left = `${x * 100}%`;
      const a = day.agent.find((v) => t >= v.from && t < v.to), u = day.user.find((v) => t >= v.from && t < v.to);
      const p = day.points.find((q) => Math.abs(q.t - t) < cur.w / lane.width * 3);
      const part = (name, v, cls) => (v ? `${name} ${LBL[cls]} ${hhmm(v.from)}~${hhmmEnd(v.to, day)} (${fmtSpan(v.from, v.to)})` : null);
      read.textContent = [hhmm(t), p && (p.kind === 'sent' ? `요청 보냄 ${hhmm(p.t)}` : `질문 답변함 ${hhmm(p.t)}`),
        part('에이전트', a, a && agentCls[a.state]), part('사람', u, u?.label), !a && !u && (t > D.now ? '아직 오지 않은 시각' : '기록 없음')].filter(Boolean).join(' · ');
    }
    apply();

    if (fromRect) {
      // 날짜 줄이 여러 줄로 펼쳐진다 — 줄 자리에서 절반쯤 온 데서 시작해 짧게 (사용자 2026-10-27: 과하지 않게)
      const box = tl.getBoundingClientRect(), k = 0.5, mid = (a, b) => b + (a - b) * k;
      tl.animate([{ transformOrigin: 'top left', transform: `translate(${(fromRect.left - box.left) * k}px, ${(fromRect.top - box.top) * k}px) scale(${mid(fromRect.width / box.width, 1)}, ${mid(fromRect.height / box.height, 1)})`, opacity: 0.3 }, { transformOrigin: 'top left', transform: 'none', opacity: 1 }], { duration: 240, easing: EASE });
      for (const el of [nav, body.querySelector('.sum'), read]) fadeIn(el, 80);
    } else fadeIn(body.firstChild);
  }
  return { dlg, open };
}
