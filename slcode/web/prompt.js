// system prompt 편집 창 (ticket slcode-profile-system-prompt, 사용자 2026-11-17 → slcode-prompt-library 2026-11-18) — 목록의 프롬프트 하나를 블록 단위로 끄고·고치고·나누고, 사이에 글을 더한다.
// 시작 화면(start.js)에서 프로필 화면의 system prompt 탭의 "편집" 으로 연다. 왼쪽 사이드바가 프롬프트 목록이다(고르기·새로 만들기, 항목의 ⋯ 메뉴로 이름 바꾸기·복제·삭제, 사용자 2026-11-20·21: 목록을 프로필 탭에 따로 두지 않는다).
// 사이드바 맨 위는 "벤더 기본" — 고칠 것이 없어 설명 한 줄만 보인다(사용자 2026-11-21). 목록이 비어 있으면 처음 열 때 default 를 만들어 Claude 원본을 가져온다.
// 열면 고른 프롬프트의 최신 판을 바로 보인다(prompt.get) — 원본은 판에 저장되어 있다.
// 판이 없는 프롬프트는 가운데에 "직접 쓰기"·"가져오기" 만 보인다(사용자 2026-11-21). 직접 쓰기는 빈 블록 하나로 시작해 원본 없이 더한 블록만으로 저장한다.
// 가져오기는 대화상자에서 벤더·모델·"slcode 권장 설정" 을 골라 설치된 Claude Code 가 지금 보내는 글을 받는다(prompt.fetch, 요금 없음) — 받은 원본은 곧바로 새 판이 된다.
// 저장(prompt.save)도 새 판이다. 글 속 <memory>·<config>·<cwd>·<home> 은 세션마다 그 세션의 값으로 바뀌는 자리표시다.
// 꼴은 테두리 없는 펼친 목록: 블록마다 설명·상태·동작·크기·스위치(맨 오른쪽) 한 줄, 글은 누르면 그 자리에서 고친다(고치기가 기본). 나누기는 블록의 버튼을 눌러 켠 뒤 줄을 눌러 그 줄부터 나눈다.
// 설정은 블록 해시와 켬·끔·설명·직접 쓴 글로 저장한다 — 화면의 글을 서버로 돌려보내 해시를 재게 한다. 정체성 한 줄·Claude Code 가 늘 붙이는 글·slcode 지시는 읽기 전용.
// 웹은 시작 화면 서버의 api/, superlite 카드는 카드가 `slcode start-call` 로 중계한다 — call(method, params) 만 다르다. 요소 도우미·스타일(style.css .spanel)은 이 파일의 것.

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'disabled' || k === 'value') n[k] = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((x) => x != null && x !== false));
  return n;
};
// 가져올 때의 모델 — 모델마다 붙는 문단이 다르다. 빈 값은 Claude Code 의 기본 모델. 벤더는 지금 Claude 하나
const MODELS = [['', '기본 모델'], ['sonnet', 'sonnet'], ['opus', 'opus'], ['haiku', 'haiku'], ['fable', 'fable']];
const tok = (s) => Math.max(1, Math.round(s.length * 0.34)); // 영어 글의 어림 — 화면의 크기 표시용

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// ⋯ 메뉴의 아이콘 — Lucide(ISC) 의 것, 고지는 app.js 의 ICONS 위에 있다. 모듈마다 따로 실려 app.js 의 것을 가져오지 못한다
const ICONS = {
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  // lucide languages — 대화의 번역 단추(translate.js)와 같은 것
  languages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
};
const icon = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = ICONS[name]; return s; };

/** call(method, params) → Promise. name 은 처음 열 프롬프트(null 은 벤더 기본) — 프로필 화면의 system prompt 탭이 준다 */
/** translator 는 블록 번역 {translate(text, {fresh}) → {source, translation}[]} — superlite 카드에서만 온다(start.js). 없으면 번역 단추가 없다 */
export function promptPanel(call, { name: first, translator = null } = {}) {
  const root = el('div', { class: 'spanel' }), name = el('span', { class: 'pname' });
  let prompt = first ?? null, list = [], vendorBy = [], made = false, view = null, items = [], busy = null, error = null, saved = null, cutting = null;
  const cur = (it) => (it.kind === 'piece' ? it.edit ?? it.text : it.text);
  const sent = (it) => (it.kind === 'heading' || !it.off) && cur(it).trim() !== '';

  let base = ''; // 보인 판의 블록 — 고쳤는지 견준다
  const show = (v) => {
    view = v; items = v.items.map((it) => ({ ...it })); base = JSON.stringify(items); cutting = null;
  };
  const dirty = () => !!view && JSON.stringify(items) !== base;
  /** 되돌리기 (사용자 2026-11-21 — 블록마다의 고침 표시·원문으로 대신 저장 옆에 하나) — 저장하지 않은 편집을 모두 버리고 보인 판으로. 번역은 그대로 */
  let revertBtn = null;
  function revert() { items = view.items.map((it) => ({ ...it })); cutting = null; draw(); }
  /** 저장하지 않은 편집이 있으면 버릴지 묻고 go (사용자 2026-11-21) — 다른 프롬프트 열기·만들기·복제·프로필 화면으로 */
  function leave(go) {
    if (!dirty()) { go(); return; }
    showDialog(el('h4', {}, '저장하지 않은 편집을 버릴까요?'),
      el('div', { class: 'acts' }, cancel(), el('button', { class: 'danger', onclick: () => { dlg.close(); go(); } }, '버리기')));
  }
  /** 목록과 고른 프롬프트를 함께 읽는다. 고른 것이 목록에 없으면(지워짐) 벤더 기본을 보인다 */
  async function load() {
    const want = prompt;
    try {
      const [l, p, v] = await Promise.all([call('prompt.list'), call('profile.list'), prompt ? call('prompt.get', { name: prompt }).catch(() => null) : null]);
      if (want !== prompt) return; // 읽는 동안 다른 것을 골랐다 — 그쪽 load 가 그린다
      list = l.prompts; vendorBy = p.profiles.filter((r) => !r.profile.claude.prompt).map((r) => r.name);
      const first = !made; made = true;
      if (!list.length && first) return makeDefault();
      if (v && view?.name === v.name && view.version === v.version) view = v; // 같은 판이면 고친 것을 둔다(목록만 새로 — 이름 바꾸기·다른 프롬프트 삭제)
      else if (v) show(v); else { view = null; items = []; prompt = null; }
      error = null;
    } catch (e) { error = `프롬프트를 읽지 못했습니다: ${e.message}`; }
    draw();
  }
  /** 목록이 비었으면 처음 열 때 한 번 — default 를 만들고 Claude 원본을 가져온다(블록 나누기·기본 끔은 prompt.fetch 몫, 사용자 2026-11-19).
   *  가져오기에 실패해도 default 는 남기고 오류를 보인다. 지워서 목록이 빈 것은 다시 만들지 않는다 */
  async function makeDefault() {
    busy = '가져오는 중…'; prompt = 'default'; draw();
    let err = null;
    try {
      await call('prompt.create', { name: 'default' });
      await call('prompt.fetch', { name: 'default' }).catch((e) => { err = `default 를 가져오지 못했습니다: ${e.message}`; });
    } catch (e) { err = e.message; prompt = null; }
    busy = null;
    await load();
    if (err) { error = err; draw(); }
  }
  /** 사이드바에서 고른다 — 저장하지 않은 편집은 버린다(묻는 것은 leave) */
  function open(n) { prompt = n; view = null; items = []; saved = null; error = null; cutting = null; draw(); return load(); }
  /** 가져오기 대화상자 — 벤더(Claude 하나)·모델·권장 설정(처음 가져올 때 쓸모 적은 블록을 끈다, 끄면 모두 켠 채). 실패하면 창을 닫지 않고 사유를 보인다 */
  function fetchDialog() {
    let model = '', recommended = true;
    const err = el('div', { class: 'err' });
    const go = el('button', { class: 'primary', onclick: async () => {
      busy = '가져오는 중…'; go.disabled = true; go.textContent = busy; err.textContent = ''; error = null; saved = null;
      try { show(await call('prompt.fetch', { name: prompt, model, recommended })); dlg.close(); }
      catch (e) { err.textContent = `가져오지 못했습니다: ${e.message}`; go.disabled = false; go.textContent = '가져오기'; }
      busy = null; draw();
    } }, '가져오기');
    showDialog(el('h4', {}, '프롬프트 가져오기'),
      el('label', {}, '벤더', el('select', {}, el('option', { value: 'claude' }, 'Claude'))),
      el('label', {}, '모델', el('select', { onchange: (e) => { model = e.target.value; } }, MODELS.map(([v, n]) => el('option', { value: v }, n)))),
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: true, onchange: (e) => { recommended = e.target.checked; } }), '가능하다면 slcode 권장 프리셋 적용'),
      err, el('div', { class: 'acts' }, cancel(), go));
  }
  /** 직접 쓰기 — 빈 블록 하나로 시작한다. 저장하기 전에는 되돌리기로 처음 화면에 돌아간다 */
  function write() { items = [{ kind: 'added', block: 0, gap: 1, text: '' }]; draw(); root.querySelector('[data-i="0"] textarea')?.focus(); }
  /** 설명은 판과 따로 저장한다 — 판이 오르지 않는다 */
  async function describe(text) {
    const n = prompt;
    try {
      const r = await call('prompt.describe', { name: n, description: text });
      if (view?.name === n) view.description = r.description;
      const x = list.find((y) => y.name === n); if (x) x.description = r.description;
    } catch (e) { error = `설명을 저장하지 못했습니다: ${e.message}`; draw(); }
  }
  async function save() {
    busy = '저장하는 중…'; error = null; draw();
    try {
      const out = items.map((it) => (it.kind === 'heading' ? { kind: 'heading', text: it.text }
        : it.kind === 'added' ? { kind: 'added', text: it.text, note: it.note, off: !!it.off }
          : { kind: 'piece', text: it.text, note: it.note, off: !!it.off, edit: it.edit ?? null, user: !!it.user }));
      show(await call('prompt.save', { name: prompt, base: view.version, items: out }));
      saved = '저장했습니다';
    } catch (e) { error = `저장하지 못했습니다: ${e.message}`; }
    busy = null; draw();
  }

  function split(it, line) {
    const lines = it.text.split('\n'), i = items.indexOf(it);
    let k = line; while (k > 0 && lines[k - 1] === '') k--; // 앞 블록 끝의 빈 줄은 사이 간격으로
    const mk = (text, gap) => ({ kind: 'piece', block: it.block, gap, text, known: 'profile', user: true, ...(it.off ? { off: true } : {}) });
    items.splice(i, 1, { ...mk(lines.slice(0, k).join('\n'), it.gap), ...(it.note ? { note: it.note } : {}) }, mk(lines.slice(line).join('\n'), line - k));
    cutting = null; draw();
  }
  function merge(it) {
    const i = items.indexOf(it), prev = items[i - 1];
    items.splice(i - 1, 2, { kind: 'piece', block: it.block, gap: prev.gap, text: `${prev.text}${'\n'.repeat(it.gap + 1)}${it.text}`, known: 'profile', user: true, ...(prev.note ? { note: prev.note } : {}), ...(prev.off && it.off ? { off: true } : {}) });
    draw();
  }
  function add(at) {
    const it = { kind: 'added', block: items[at - 1]?.block ?? 0, gap: 1, text: '' };
    items.splice(at, 0, it); draw();
    root.querySelector(`[data-i="${at}"] textarea`)?.focus();
  }
  function move(it, d) {
    const i = items.indexOf(it), j = i + d;
    if (j < 0 || j >= items.length) return;
    items.splice(i, 1); items.splice(j, 0, it);
    it.block = items[j - 1]?.block ?? 0;
    draw();
  }
  /** 이 창을 스크롤하는 조상 — 웹은 문서, 카드는 카드 문서의 스크롤 칸. 다시 그려도 보던 자리를 지킨다 */
  const scroller = () => {
    for (let n = root.parentNode; n; n = n.parentNode ?? n.host) if (n.nodeType === 1 && /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight) return n;
    return document.scrollingElement;
  };
  const fit = (t) => { t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; };

  function card(it, i) {
    const mergeable = it.kind === 'piece' && items[i - 1]?.kind === 'piece' && items[i - 1].block === it.block && (it.user || items[i - 1].user) && it.edit == null && items[i - 1].edit == null;
    const title = it.kind === 'added' || it.user || !it.note
      ? el('input', { class: 'ttl', value: it.note ?? '', placeholder: '설명 쓰기', title: '설명', oninput: (e) => { it.note = e.target.value || undefined; if (revertBtn) revertBtn.disabled = !!busy || !dirty(); } })
      : el('div', { class: 'ttl' }, it.note);
    const act = (label, title, onclick, more = {}) => el('button', { class: 'act', title, onclick, ...more }, label);
    const bar = el('div', { class: 'bar' },
      title,
      it.off ? el('span', { class: 'pst' }, '꺼짐') : null,
      it.kind === 'added' && view.original ? el('span', { class: 'pst' }, '더함') : null, // 직접 쓴 판은 블록이 모두 더한 것이라 표시하지 않는다
      it.kind === 'added' ? [act('위로', '한 칸 위로', () => move(it, -1)), act('아래로', '한 칸 아래로', () => move(it, 1))] : null,
      mergeable ? act('합치기', '위 블록과 합친다', () => merge(it)) : null,
      it.kind === 'piece' && it.edit == null && it.text.includes('\n') ? act(cutting === it ? '나눌 줄을 누른다 · 취소' : '나누기', '나눌 줄을 고른다', () => { cutting = cutting === it ? null : it; draw(); }, { class: 'act keep', 'aria-pressed': String(cutting === it) }) : null,
      it.kind === 'added' ? act('지우기', '이 블록을 지운다', () => { items.splice(items.indexOf(it), 1); draw(); }) : null,
      el('span', { class: 'sz' }, `~${tok(cur(it))}t`),
      el('button', { class: `sw${it.off ? '' : ' on'}`, role: 'switch', 'aria-checked': String(!it.off), title: it.off ? '꺼짐 — 보내지 않는다' : '켜짐', onclick: () => { it.off = !it.off; draw(); } }));
    const tk = it.kind === 'piece' ? `p:${it.text}` : it, tb = cutting === it ? null : trButton(tk, () => cur(it));
    if (tb) title.after(tb);
    const body = cutting === it
      ? el('div', { class: 'txt cut' }, it.text.split('\n').map((l, k) => el('div', { class: `ln${k && l !== '' ? ' can' : ''}`, onclick: k && l !== '' ? () => split(it, k) : null }, l || ' ')))
      : el('textarea', {
        rows: 1, spellcheck: 'false', placeholder: '여기에 지침을 쓴다',
        oninput: (e) => { const v = e.target.value; if (it.kind === 'added') it.text = v; else if (v === it.text) delete it.edit; else it.edit = v; fit(e.target); sum(); if (tb) trMark(tb, tk, v); if (revertBtn) revertBtn.disabled = !!busy || !dirty(); },
        onchange: () => draw(), // 고침 표시·버튼은 글에서 나갈 때 맞춘다 — 치는 동안 다시 그리면 커서를 잃는다
      }, cur(it));
    const blk = el('div', { class: `blk${it.off ? ' off' : ''}${it.kind === 'added' ? ' mine' : ''}${cutting === it ? ' cutting' : ''}`, 'data-i': String(i) }, bar, body);
    const box = tb && trBox(tk); if (box) blk.append(box);
    return blk;
  }
  const fixed = (name, why, text) => {
    const tk = `f:${name}`, tb = trButton(tk, () => text);
    const bar = el('div', { class: 'bar' }, el('div', { class: 'ttl' }, name), tb, el('span', { class: 'pst', title: why }, '읽기 전용'), el('span', { class: 'sz' }, `~${tok(text)}t`), el('span', { class: 'sw none' }));
    return el('div', { class: 'blk ro' }, bar, el('div', { class: 'txt' }, text), tb ? trBox(tk) : null);
  };
  // 블록 번역 (ticket slcode-prompt-block-translate, 사용자 2026-11-21) — 꼴은 대화의 생각 블록 번역 단추(translate.js 의 .trbtn: 반투명 아이콘, 번역 중 빛, 켜지면 파랑)와 같다.
  // 번역은 글 칸 아래 따로 둔 회색 칸(.trv)에 문단마다 보이고, 원문은 그대로 고칠 수 있다. 번역한 뒤 원문을 고치면 단추가 노랑(drift)이 되고, 누르면 지금 글로 다시 번역한다.
  // 상태는 블록마다 trs 에 둔다 — 받은 블록은 받은 글로 잡아 다시 그리거나 저장해도 남는다(더한 블록은 그 블록, 읽기 전용은 이름). Ctrl(⌘)+클릭은 캐시 없이 다시
  const trs = new Map();
  const TR_TITLE = { '': '한국어로 번역 (Ctrl+클릭: 캐시 없이 다시)', on: '번역 숨기기 (Ctrl+클릭: 캐시 없이 다시)', drift: '원문이 바뀌었습니다. 눌러 다시 번역', busy: '번역하는 중', err: '번역하지 못했습니다. 눌러 다시' };
  function trMark(b, tk, text) {
    const t = trs.get(tk), st = !t ? '' : t.busy ? 'busy' : t.error ? 'err' : t.src !== text ? 'drift' : 'on';
    for (const c of ['on', 'drift', 'busy', 'err']) b.classList.toggle(c, c === st);
    b.title = TR_TITLE[st]; b.setAttribute('aria-label', TR_TITLE[st]);
  }
  function trButton(tk, text) {
    if (!translator || !text().trim()) return null;
    const b = el('button', { class: 'trbtn', type: 'button', onclick: async (e) => {
      const t = trs.get(tk), now = text(), fresh = e.ctrlKey || e.metaKey;
      if (t?.busy) return;
      if (t && !t.error && t.src === now && !fresh) { trs.delete(tk); draw(); return; }
      trs.set(tk, { ...t, busy: true }); trMark(b, tk, now);
      try { trs.set(tk, { src: now, pairs: await translator.translate(now.trim(), { fresh }) }); }
      catch (err) { trs.set(tk, { src: now, error: err?.message ?? String(err) }); }
      draw();
    } }, icon('languages'));
    trMark(b, tk, text());
    return b;
  }
  const trBox = (tk) => {
    const t = trs.get(tk);
    if (!t || (!t.pairs && !t.error)) return null;
    return el('div', { class: 'trv' }, t.error ? el('div', { class: 'trerr' }, `번역하지 못했습니다: ${t.error}`) : t.pairs.map((p) => el('div', { class: 'trpair' }, el('div', { class: 'tl' }, p.translation))));
  };
  const ins = (at) => el('div', { class: `ins${items[at]?.kind === 'heading' || items[at - 1]?.kind === 'heading' ? ' bare' : ''}` }, el('button', { onclick: () => add(at) }, '+ 여기에 블록 추가'));
  /** 마지막 블록 아래 — 늘 보인다 (사용자 2026-11-21) */
  const insEnd = () => el('div', { class: 'ins end' }, el('button', { onclick: () => add(items.length) }, '+ 블록 추가'));

  let sumEl = null;
  function sum() {
    if (!sumEl || !items.length) return;
    const base = view.items.reduce((n, it) => n + tok(it.text), 0), now = items.filter(sent).reduce((n, it) => n + tok(cur(it)), 0);
    sumEl.textContent = view.original ? `보내는 양 ~${now.toLocaleString()}t · 기본 ~${base.toLocaleString()}t` : `보내는 양 ~${now.toLocaleString()}t`;
  }
  let dlg = null;
  function showDialog(...kids) { dlg?.remove(); dlg = el('dialog', {}, ...kids); root.append(dlg); dlg.showModal(); return dlg; }
  const cancel = () => el('button', { onclick: () => dlg.close() }, '취소');
  /** 확인 단추 — 실패하면 창을 닫지 않고 사유를 보인다 */
  const okBtn = (err, label, cls, run) => el('button', { class: cls, onclick: async () => { try { await run(); dlg.close(); } catch (e) { err.textContent = e.message; } } }, label);
  /** 이름 하나를 묻는 대화상자 — run(이름) 이 실패하면 창을 닫지 않고 사유를 보인다 */
  function nameDialog(title, value, label, run) {
    let n = value; const err = el('div', { class: 'err' });
    const ok = okBtn(err, label, 'primary', async () => {
      if (!NAME.test(n)) throw new Error('영문·숫자로 시작하고 영문·숫자·. _ - 만 씁니다.');
      await run(n);
    });
    showDialog(el('h4', {}, title),
      el('label', {}, '이름', el('input', { value, oninput: (e) => { n = e.target.value.trim(); }, onkeydown: (e) => { if (e.key === 'Enter') ok.click(); } })),
      err, el('div', { class: 'acts' }, cancel(), ok));
    dlg.querySelector('input').select();
  }
  /** 목록에 없는 이름 — base, base-2, base-3 … */
  const free = (base) => { let n = base; for (let i = 2; list.some((x) => x.name === n); i++) n = `${base}-${i}`; return n; };
  const newDialog = () => nameDialog('새 시스템 프롬프트', '', '만들기', async (n) => { await call('prompt.create', { name: n }); await open(n); });
  // 벤더 기본의 복제 — 새 프롬프트를 만들고 가져오기 대화상자를 연다
  const copyVendorDialog = () => nameDialog('벤더 기본 복제', free('claude'), '복제', async (n) => { await call('prompt.create', { name: n }); await open(n); fetchDialog(); });
  const copyDialog = (x) => nameDialog(`${x.name} 복제`, free(`${x.name}-copy`), '복제', async (n) => { await call('prompt.copy', { name: x.name, to: n }); await open(n); });
  const renameDialog = (x) => nameDialog(`${x.name} 이름 바꾸기`, x.name, '바꾸기', async (n) => {
    if (n === x.name) return;
    await call('prompt.rename', { name: x.name, to: n });
    if (prompt === x.name) { prompt = n; if (view) view.name = n; }
    await load();
  });
  function removeDialog(x) {
    const err = el('div', { class: 'err' });
    showDialog(el('h4', {}, `${x.name} 을 삭제할까요?`),
      el('p', {}, '이 프롬프트를 쓰던 세션은 다음에 열 때 벤더 기본으로 뜹니다.'),
      err, el('div', { class: 'acts' }, cancel(), okBtn(err, '삭제', 'danger', async () => { await call('prompt.remove', { name: x.name }); await open(prompt === x.name ? null : prompt); })));
  }
  /** 사이드바 항목의 ⋯ 메뉴 — 사이드바의 스크롤 칸에 잘리지 않게 창에 고정해 단추 아래에 띄운다. 바깥을 누르거나 스크롤하면 닫는다 */
  let menu = null, menuBtn = null;
  function closeMenu() { menu?.remove(); menuBtn?.classList.remove('open'); menu = menuBtn = null; document.removeEventListener('click', closeMenu); document.removeEventListener('scroll', closeMenu, true); }
  function openMenu(btn, items) {
    const was = menuBtn === btn; closeMenu();
    if (was) return;
    const r = btn.getBoundingClientRect();
    menu = el('div', { class: 'pmenu', role: 'menu', style: `top:${r.bottom + 4}px;left:${r.right}px` },
      items.map(([ic, label, run, why, cls]) => el('button', { role: 'menuitem', class: cls ?? null, disabled: !!why, title: why ?? null, onclick: () => { closeMenu(); run(); } }, icon(ic), label)));
    menuBtn = btn; btn.classList.add('open'); root.append(menu);
    setTimeout(() => { document.addEventListener('click', closeMenu); document.addEventListener('scroll', closeMenu, true); });
  }
  const more = (items) => el('button', { class: 'more', title: '더 보기', 'aria-label': '더 보기', onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, items); } }, icon('more'));
  const item = (current, onclick, nm, sub, items) => el('div', { class: 'prow', 'aria-current': String(current) },
    el('button', { class: 'pitem', onclick: () => { if (!current) onclick(); } }, el('span', { class: 'nm' }, nm), sub ? el('span', { class: 'sub' }, sub) : null),
    more(items));
  const side = () => el('div', { class: 'side' },
    item(!prompt, () => leave(() => void open(null)), '벤더 기본', vendorBy.join(', '), [['copy', '복제', () => leave(copyVendorDialog)]]),
    list.map((x) => item(x.name === prompt, () => leave(() => void open(x.name)), x.name, x.usedBy.join(', '), [
      ['pencil', '이름 바꾸기', () => renameDialog(x)],
      ['copy', '복제', () => leave(() => copyDialog(x))],
      ['trash', '삭제', () => removeDialog(x), x.usedBy.length ? `${x.usedBy.join(', ')} 프로필이 쓰고 있어 삭제할 수 없습니다` : null, 'danger']])),
    el('button', { class: 'add', onclick: () => leave(newDialog) }, '+ 새 시스템 프롬프트'));

  /** 창을 다시 그린다 — 열린 대화상자는 그대로 둔다(읽는 중에 연 대화상자가 닫히지 않게) */
  const paint = (...kids) => { closeMenu(); for (const c of [...root.children]) if (c !== dlg) c.remove(); root.prepend(...kids); };
  function draw() {
    const sc = scroller(), top = sc?.scrollTop ?? 0;
    sumEl = el('span', { class: 'sum' });
    name.textContent = prompt ?? '벤더 기본';
    if (!prompt) { paint(side(), el('div', { class: 'main' }, el('div', { class: 'empty' }, el('p', {}, error ?? '벤더의 기본 프롬프트가 사용됩니다.')))); return; }
    const has = !!view?.original;
    const head = el('div', { class: 'head' },
      view ? el('input', { class: 'desc', value: view.description, placeholder: '설명', 'aria-label': '설명', onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); }, onchange: (e) => void describe(e.target.value) }) : el('span', { class: 'grow' }),
      sumEl);
    const body = el('div', { class: 'body' });
    if (!has && !items.length) {
      body.append(el('div', { class: 'empty start' }, busy ? el('p', {}, busy) : [
        el('button', { disabled: !view, onclick: write }, '직접 쓰기'),
        el('button', { disabled: !view, onclick: fetchDialog }, '가져오기')]));
    } else {
      if (has) body.append(fixed('정체성 한 줄', 'Claude Code 가 정한다', view.identity));
      items.forEach((it, i) => {
        body.append(ins(i));
        body.append(it.kind === 'heading' ? el('div', { class: 'hd', title: '이 절의 블록이 하나라도 나가면 제목 줄도 나간다' }, it.text) : card(it, i));
      });
      body.append(insEnd());
      if (view.tail) body.append(fixed('Claude Code 가 늘 붙이는 글', 'Claude Code 가 늘 뒤에 붙인다', view.tail));
      body.append(fixed('slcode 지시 — 표시·메시징·팀원', 'slcode 가 맨 끝에 붙인다. 팀 지시와 에이전트 플러그인의 지시문이 이 뒤에 온다', view.slcode));
    }
    const foot = el('div', { class: 'foot' },
      error ? el('span', { class: 'err' }, error) : saved ? el('span', { class: 'ok' }, saved) : null,
      el('span', { class: 'grow' }),
      revertBtn = el('button', { disabled: !!busy || !dirty(), onclick: revert }, '되돌리기'),
      el('button', { class: 'primary', disabled: !!busy || !(has || items.length), onclick: () => void save() }, busy === '저장하는 중…' ? busy : '저장'));
    paint(side(), el('div', { class: 'main' }, head, body, foot));
    body.querySelectorAll('textarea').forEach(fit);
    if (sc) sc.scrollTop = top;
    sum();
  }
  draw();
  // name 은 창 머리의 프롬프트 이름 — 사이드바에서 고르면 바뀐다
  return { el: root, name, load, leave };
}
