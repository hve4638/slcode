// system prompt 편집 창 (ticket slcode-profile-system-prompt, 사용자 2026-11-17) — 프로필마다 Claude Code 의 기본 프롬프트를 블록 단위로 끄고·고치고·나누고, 사이에 글을 더한다.
// 시작 화면(start.js)에서만 연다. "기본 시스템 프롬프트 가져오기" 를 눌러야 블록이 채워진다 — 설치된 Claude Code 가 지금 보내는 글을 그때 받아 온다(prompt.fetch, 요금 없음).
// 꼴은 테두리 없는 펼친 목록: 블록마다 설명·상태·동작·크기·스위치(맨 오른쪽) 한 줄, 글은 누르면 그 자리에서 고친다(고치기가 기본). 나누기는 블록의 버튼을 눌러 켠 뒤 줄을 눌러 그 줄부터 나눈다.
// 저장되는 것은 블록 해시와 켬·끔·설명·직접 쓴 글뿐이다 — 받은 원문은 서버로 돌려보내 해시만 재게 한다(prompt.save). 정체성 한 줄·Claude Code 가 늘 붙이는 글·slcode 지시는 읽기 전용.
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
// 가져올 때의 모델 — 모델마다 붙는 문단이 다르다. 빈 값은 Claude Code 의 기본 모델
const MODELS = [['', '기본 모델'], ['sonnet', 'sonnet'], ['opus', 'opus'], ['haiku', 'haiku'], ['fable', 'fable']];
const tok = (s) => Math.max(1, Math.round(s.length * 0.34)); // 영어 글의 어림 — 화면의 크기 표시용

/** call(method, params) → Promise */
export function promptPanel(call) {
  const root = el('div', { class: 'spanel' });
  let profiles = null, profile = null, model = '', view = null, items = [], busy = null, error = null, saved = null, cutting = null, as = '';
  const cur = (it) => (it.kind === 'piece' ? it.edit ?? it.text : it.text);
  const sent = (it) => (it.kind === 'heading' || !it.off) && cur(it).trim() !== '';

  async function load() {
    try {
      profiles = (await call('prompt.profiles')).profiles;
      profile ??= (profiles.find((p) => !p.builtin) ?? profiles[0]).name;
      error = null;
    } catch (e) { error = `프로필을 읽지 못했습니다: ${e.message}`; }
    draw();
  }
  async function fetchPrompt() {
    busy = '가져오는 중…'; error = null; saved = null; draw();
    try {
      view = await call('prompt.fetch', { profile, model });
      items = view.items.map((it) => ({ ...it }));
      cutting = null; as = '';
    } catch (e) { error = `가져오지 못했습니다: ${e.message}`; }
    busy = null; draw();
  }
  async function save() {
    const builtin = profiles.find((p) => p.name === profile)?.builtin;
    if (builtin && !as.trim()) { error = `${profile} 은 기본 제공 프로필이라 고칠 수 없습니다. 새 프로필 이름을 적어 주세요.`; draw(); return; }
    busy = '저장하는 중…'; error = null; draw();
    try {
      const out = items.map((it) => (it.kind === 'heading' ? { kind: 'heading', text: it.text }
        : it.kind === 'added' ? { kind: 'added', text: it.text, note: it.note, off: !!it.off }
          : { kind: 'piece', text: it.text, note: it.note, off: !!it.off, edit: it.edit ?? null, user: !!it.user }));
      const r = await call('prompt.save', { profile, items: out, ...(builtin ? { as: as.trim() } : {}) });
      profile = r.name; as = ''; saved = `${r.name} 에 저장했습니다. 이 프로필로 띄우는 새 세션부터 적용됩니다.`;
      profiles = (await call('prompt.profiles')).profiles;
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
      ? el('input', { class: 'ttl', value: it.note ?? '', placeholder: '설명 쓰기', title: '설명', oninput: (e) => { it.note = e.target.value || undefined; } })
      : el('div', { class: 'ttl' }, it.note);
    const act = (label, title, onclick, more = {}) => el('button', { class: 'act', title, onclick, ...more }, label);
    const bar = el('div', { class: 'bar' },
      title,
      it.off ? el('span', { class: 'pst' }, '꺼짐') : null,
      it.kind === 'added' ? el('span', { class: 'pst' }, '더함') : null,
      it.kind === 'piece' && it.edit != null ? el('span', { class: 'pst' }, '고침') : null,
      it.kind === 'added' ? [act('위로', '한 칸 위로', () => move(it, -1)), act('아래로', '한 칸 아래로', () => move(it, 1))] : null,
      mergeable ? act('합치기', '위 블록과 합친다', () => merge(it)) : null,
      it.kind === 'piece' && it.edit == null && it.text.includes('\n') ? act(cutting === it ? '나눌 줄을 누른다 · 취소' : '나누기', '나눌 줄을 고른다', () => { cutting = cutting === it ? null : it; draw(); }, { class: 'act keep', 'aria-pressed': String(cutting === it) }) : null,
      it.kind === 'piece' && it.edit != null ? act('원문으로', '고친 글을 버리고 받은 글로', () => { delete it.edit; draw(); }) : null,
      it.kind === 'added' ? act('지우기', '이 블록을 지운다', () => { items.splice(items.indexOf(it), 1); draw(); }) : null,
      el('span', { class: 'sz' }, `~${tok(cur(it))}t`),
      el('button', { class: `sw${it.off ? '' : ' on'}`, role: 'switch', 'aria-checked': String(!it.off), title: it.off ? '꺼짐 — 보내지 않는다' : '켜짐', onclick: () => { it.off = !it.off; draw(); } }));
    const body = cutting === it
      ? el('div', { class: 'txt cut' }, it.text.split('\n').map((l, k) => el('div', { class: `ln${k && l !== '' ? ' can' : ''}`, onclick: k && l !== '' ? () => split(it, k) : null }, l || ' ')))
      : el('textarea', {
        rows: 1, spellcheck: 'false', placeholder: '여기에 지침을 쓴다',
        oninput: (e) => { const v = e.target.value; if (it.kind === 'added') it.text = v; else if (v === it.text) delete it.edit; else it.edit = v; fit(e.target); sum(); },
        onchange: () => draw(), // 고침 표시·버튼은 글에서 나갈 때 맞춘다 — 치는 동안 다시 그리면 커서를 잃는다
      }, cur(it));
    return el('div', { class: `blk${it.off ? ' off' : ''}${it.kind === 'added' ? ' mine' : ''}${cutting === it ? ' cutting' : ''}`, 'data-i': String(i) }, bar, body);
  }
  const fixed = (name, why, text) => el('div', { class: 'blk ro' }, el('div', { class: 'bar' }, el('div', { class: 'ttl' }, name), el('span', { class: 'pst', title: why }, '읽기 전용'), el('span', { class: 'sz' }, `~${tok(text)}t`), el('span', { class: 'sw none' })), el('div', { class: 'txt' }, text));
  const ins = (at) => el('div', { class: `ins${items[at]?.kind === 'heading' || items[at - 1]?.kind === 'heading' ? ' bare' : ''}` }, el('button', { onclick: () => add(at) }, '+ 여기에 블록 추가'));

  let sumEl = null;
  function sum() {
    if (!sumEl || !view) return;
    const base = view.items.reduce((n, it) => n + tok(it.text), 0), now = items.filter(sent).reduce((n, it) => n + tok(cur(it)), 0);
    sumEl.textContent = `보내는 양 ~${now.toLocaleString()}t · 기본 ~${base.toLocaleString()}t`;
  }
  function draw() {
    const sc = scroller(), top = sc?.scrollTop ?? 0;
    const row = profiles?.find((p) => p.name === profile);
    sumEl = el('span', { class: 'sum' });
    const head = el('div', { class: 'head' },
      el('label', {}, '프로필 ', el('select', { disabled: !!busy, onchange: (e) => { profile = e.target.value; view = null; items = []; saved = null; error = null; draw(); } },
        (profiles ?? []).map((p) => el('option', { value: p.name, selected: p.name === profile }, `${p.name}${p.edited ? ' · 고침' : ''}`)))),
      el('span', { class: 'grow' }), sumEl,
      el('select', { disabled: !!busy, title: '가져올 때 쓸 모델 — 모델마다 붙는 문단이 다르다', onchange: (e) => { model = e.target.value; } }, MODELS.map(([v, n]) => el('option', { value: v, selected: v === model }, n))),
      el('button', { disabled: !!busy || !profile, onclick: () => void fetchPrompt() }, busy === '가져오는 중…' ? busy : view ? '다시 가져오기' : '기본 시스템 프롬프트 가져오기'));
    const body = el('div', { class: 'body' });
    if (!view) {
      body.append(el('div', { class: 'empty' },
        el('p', {}, row?.edited ? '이 프로필에는 저장한 프롬프트 설정이 있습니다.' : '아직 가져온 프롬프트가 없습니다.'),
        el('p', {}, '"기본 시스템 프롬프트 가져오기" 를 누르면 설치된 Claude Code 가 지금 보내는 프롬프트를 받아 옵니다. 요금은 나지 않습니다.')));
    } else {
      body.append(fixed('정체성 한 줄', 'Claude Code 가 정한다', view.identity));
      items.forEach((it, i) => {
        body.append(ins(i));
        body.append(it.kind === 'heading' ? el('div', { class: 'hd', title: '이 절의 블록이 하나라도 나가면 제목 줄도 나간다' }, it.text) : card(it, i));
      });
      body.append(ins(items.length));
      if (view.tail) body.append(fixed('Claude Code 가 늘 붙이는 글', 'Claude Code 가 늘 뒤에 붙인다', view.tail));
      body.append(fixed('slcode 지시 — 표시·메시징·팀원', 'slcode 가 맨 끝에 붙인다. 팀 지시와 에이전트 플러그인의 지시문이 이 뒤에 온다', view.slcode));
    }
    const foot = el('div', { class: 'foot' },
      error ? el('span', { class: 'err' }, error) : saved ? el('span', { class: 'ok' }, saved) : null,
      el('span', { class: 'grow' }),
      view && row?.builtin ? el('input', { class: 'as', value: as, placeholder: '새 프로필 이름', title: `${profile} 은 기본 제공 프로필이라 새 프로필로 저장한다`, oninput: (e) => { as = e.target.value; } }) : null,
      el('button', { class: 'primary', disabled: !!busy || !view, onclick: () => void save() }, busy === '저장하는 중…' ? busy : '저장'));
    root.replaceChildren(head, body, foot);
    body.querySelectorAll('textarea').forEach(fit);
    if (sc) sc.scrollTop = top;
    sum();
  }
  draw();
  return { el: root, load };
}
