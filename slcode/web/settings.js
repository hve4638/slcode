// 화면 설정 — 테마·context 경고 (ticket slcode-web-settings, 사용자 확정 2026-10-16. 글꼴 고르기는 사용자가 뺐다)·새 세션 inspect (ticket slcode-inspect-default-on).
// 값은 상태 폴더에 입구마다 한 벌: 브라우저로 연 slcode 와 superlite 안의 slcode 탭이 따로 쓴다. 어느 벌인지는 serve 가 연결의 입구로 정하므로
// 이 파일은 모른다. serve 가 읽고 쓰고(settings.get·set), 파일이 바뀌면 같은 입구의 떠 있는 화면 모두에 settings.changed.
// 브라우저 저장소(localStorage)엔 두지 않는다. 고르면 바로 저장되고 모든 화면이 settings.changed 로 바뀐다 — 저장 버튼이 없다.
// 색 묶음은 style.css 의 [data-theme] 가, 목록과 이름은 여기가 정한다.

// 색 묶음은 라이트·다크를 따로 고른다: Graphite (light)·Graphite (dark) (사용자 2026-10-16). mode 는 설정 창의 분류 —
// 'auto'(시스템 라이트·다크를 따른다)는 라이트·다크 두 분류에 다 맨 앞, 라이트·다크로 가르기 애매한 것은 'other'(기타).
// Graphite·Clay·Cobalt·Slate 는 ChatGPT·Claude·Gemini·GitHub 의 색이다 — 다른 회사 상표를 테마 이름에 쓰지 않고(AI 셋은 벤더·모델 고르기와도
// 헷갈린다), 이름만 바꿨다. Superlite 는 VS Code Modern 의 짝 (사용자 2026-10-16)
const PALETTES = [['graphite', 'Graphite'], ['clay', 'Clay'], ['cobalt', 'Cobalt'], ['superlite', 'Superlite'], ['slate', 'Slate'], ['catppuccin', 'Catppuccin'], ['solarized', 'Solarized', ['light']]]; // 셋째 값이 있으면 그 모드만 — Solarized 다크는 대비가 낮아 뺐다
export const THEMES = [
  { id: 'system', label: '시스템', mode: 'auto' },
  ...['light', 'dark'].flatMap((m) => [{ id: m, label: `기본 (${m})`, mode: m }, ...PALETTES.filter(([, , only]) => !only || only.includes(m)).map(([id, name]) => ({ id: `${id}-${m}`, label: `${name} (${m})`, mode: m }))]),
];
const CATS = [['light', '라이트'], ['dark', '다크'], ['other', '기타']];
/** serve 의 DEFAULT_SETTINGS 와 같다 — 옛 serve(settings.get 이 없다)에 붙었을 때 이것으로 그린다 */
export const DEFAULTS = { theme: 'system', context: { warn: true, yellow: 30, red: 50 }, inspect: false };

const known = (id) => (THEMES.some((x) => x.id === id) ? id : 'system');

/** 문서에 입힌다 — <html data-theme>. 모르는 id(손으로 고친 파일·새 버전이 쓴 값)는 system */
export function applySettings(s) { document.documentElement.dataset.theme = known(s.theme); }

/** ctx % 의 색 단계 — 화면에 보이는 정수로 잰다 (19.6% 는 20% 로 보이므로 20 의 색). 경고를 껐으면 '' */
export function ctxLevel(pct, c) {
  if (!c.warn) return '';
  const p = Math.round(pct);
  return p < c.yellow ? 'ok' : p < c.red ? 'warn' : 'err';
}

/** 설정 창 — <dialog>. set(patch) 는 settings.set 을 부르고, 바뀐 값은 settings.changed 로 와서 update 가 다시 그린다.
 *  end 는 세션 종료 (확인 창에서 '종료'를 눌렀을 때). h 는 app.js 의 요소 도우미 */
export function settingsDialog(h, set, end) {
  const close = h('button', { class: 'ghost x', title: '닫기', 'aria-label': '닫기', onclick: () => dlg.close() }, '✕');
  const err = h('div', { class: 'meta err', hidden: '' });
  const save = (patch) => set(patch).then(() => { err.hidden = true; }, (e) => { err.textContent = `저장하지 못했습니다: ${e.message}`; err.hidden = false; });

  // 테마 — 위의 분류(라이트·다크·기타)를 누르면 그 분류의 테마만. 테마가 없는 분류는 보이지 않는다.
  // 견본마다 자기 data-theme 로 그 테마 색을 그린다. 시스템은 라이트·다크 반씩
  const swatch = (id) => h('span', { class: 'sw', 'data-theme': id }, h('span', { class: 'bar' }), h('span', { class: 'ln' }), h('span', { class: 'ln short' }), h('span', { class: 'dot' }));
  const card = (t) => h('button', { class: 'theme', 'data-id': t.id, onclick: () => save({ theme: t.id }) },
    t.mode === 'auto' ? h('span', { class: 'split' }, swatch('light'), swatch('dark')) : swatch(t.id), h('span', { class: 'name' }, t.label));
  const themes = h('div', { class: 'themes' });
  const catBtns = CATS.filter(([c]) => THEMES.some((t) => t.mode === c)).map(([c, label]) => h('button', { class: 'cat', 'data-cat': c, onclick: () => showCat(c) }, label));
  const cats = h('div', { class: 'cats' }, ...catBtns);
  let cur = DEFAULTS.theme;
  const mark = () => { for (const b of themes.children) b.setAttribute('aria-checked', String(b.dataset.id === cur)); };
  function showCat(c) {
    for (const b of catBtns) b.setAttribute('aria-pressed', String(b.dataset.cat === c));
    themes.replaceChildren(...THEMES.filter((t) => t.mode === c || (t.mode === 'auto' && c !== 'other')).map(card));
    mark();
  }
  /** 창을 열 때의 분류 — 지금 테마가 든 곳. 시스템을 따르는 테마면 지금 시스템 쪽 */
  const catOf = (id) => { const m = THEMES.find((t) => t.id === id).mode; return m !== 'auto' ? m : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; };

  // context 경고 — 켜기·끄기 + 손잡이 두 개 (첫째 ≤ 둘째). 꺼도 경계 값은 남는다. 손잡이는 놓을 때 저장하고, 끌고 있는 동안엔 이 창만 따라간다.
  // 경계 % 는 손잡이에 올리거나 잡거나 키보드로 고를 때만 그 위에 (사용자 2026-10-16 — 설명·범례 줄은 두지 않는다)
  const warn = h('input', { type: 'checkbox', role: 'switch', onchange: () => save({ context: { warn: warn.checked } }) });
  const lo = h('input', { type: 'range', class: 'lo', min: 0, max: 100, step: 1, 'aria-label': '노랑 시작' });
  const hi = h('input', { type: 'range', class: 'hi', min: 0, max: 100, step: 1, 'aria-label': '빨강 시작' });
  const tipLo = h('span', { class: 'tip lo' }), tipHi = h('span', { class: 'tip hi' });
  const range = h('div', { class: 'dual' }, lo, hi, tipLo, tipHi);
  function paintRange() {
    const y = +lo.value, r = +hi.value;
    range.style.setProperty('--y', `${y}%`); range.style.setProperty('--r', `${r}%`);
    tipLo.textContent = `${y}%`; tipHi.textContent = `${r}%`;
    // 두 손잡이가 겹치면 움직일 수 있는 쪽을 위로 — 오른쪽 끝이면 노랑(왼쪽으로), 아니면 빨강(오른쪽으로)
    lo.style.zIndex = y === r && y > 50 ? 2 : 1;
  }
  lo.oninput = () => { if (+lo.value > +hi.value) lo.value = hi.value; paintRange(); };
  hi.oninput = () => { if (+hi.value < +lo.value) hi.value = lo.value; paintRange(); };
  lo.onchange = hi.onchange = () => save({ context: { yellow: +lo.value, red: +hi.value } });
  const ctxBody = h('div', { class: 'ctxbody' }, range);

  // 새 세션 inspect (사용자 2026-10-19) — 이 입구에서 여는 새 Claude 세션의 시작값. 떠 있는 세션은 사이드바의 inspect 로 켜고 끈다.
  // 내부 플래그가 듣지 않는 SDK 로 기록돼 있으면(serve.info inspectBlocked) 끄고 사유를 보인다
  const insp = h('input', { type: 'checkbox', role: 'switch', onchange: () => save({ inspect: insp.checked }) });
  const inspNote = h('p', { class: 'note' }, '새로 여는 Claude 세션이 API 요청·응답을 세션 폴더에 기록합니다. 지금 세션은 사이드바에서 켜고 끕니다.');
  let inspBlocked = null;

  // 세션 종료 — 맨 아래 줄, 왼쪽 이름 · 오른쪽 끝 빨간 '종료' (context 경고 줄과 같은 꼴). 누르면 확인 창을 한 번 더 (사용자 2026-10-16). 끝난 세션이면 숨긴다(endable)
  const confirmEnd = h('dialog', { class: 'confirm' }, h('p', {}, '세션을 종료할까요?'), h('div', { class: 'btns' },
    h('button', { onclick: () => confirmEnd.close() }, '취소'),
    h('button', { class: 'danger solid', onclick: () => { confirmEnd.close(); dlg.close(); end(); } }, '종료')));
  confirmEnd.addEventListener('click', (e) => { if (e.target === confirmEnd) confirmEnd.close(); });
  const endRow = h('section', { class: 'end' }, h('div', { class: 'row' }, h('h3', {}, '세션 종료'), h('button', { class: 'danger solid', onclick: () => confirmEnd.showModal() }, '종료')));

  // 버전 — 맨 아래 오른쪽 구석에 흐리게 (사용자 2026-10-18, ticket slcode-web-version-display). 화면(serve)과 세션(core)이 같으면 하나, 다르면 core 를 괄호로 (사용자 2026-10-18 — '화면·세션' 이름은 뺐다).
  // 업데이트는 떠 있는 core 를 두므로 다시 연 카드가 옛 세션에 붙으면 갈린다. 벤더(Claude Code·Codex) 버전과 디스크 최신 안내는 두지 않는다 (사용자 결정)
  const ver = h('div', { class: 'ver' });
  const sec = (title, ...kids) => h('section', {}, h('h3', {}, title), ...kids);
  const dlg = h('dialog', { class: 'settings' },
    h('header', {}, h('h2', {}, '설정'), close),
    h('div', { class: 'body' },
      sec('테마', cats, themes),
      h('section', {}, h('label', { class: 'switch' }, h('h3', {}, 'context 경고'), warn), ctxBody),
      h('section', {}, h('label', { class: 'switch' }, h('h3', {}, '새 세션 inspect'), insp), inspNote),
      endRow,
      err,
      ver),
    confirmEnd);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // 바깥(배경) 클릭

  function update(s) {
    cur = known(s.theme); mark();
    warn.checked = s.context.warn; ctxBody.classList.toggle('off', !s.context.warn); lo.disabled = hi.disabled = !s.context.warn;
    insp.checked = !!s.inspect && !inspBlocked;
    // 손잡이를 잡고 끌고 있으면 그 값을 그대로 둔다
    if (!range.matches(':active')) { lo.value = s.context.yellow; hi.value = s.context.red; paintRange(); }
  }
  update(DEFAULTS);
  /** screen 은 index.html 의 data-version(serve 가 넣는다 — 디스크의 웹을 그대로 보내는 0.1.8 이하 serve 엔 없다), core 는 server.info.version */
  const version = (screen, core) => { ver.textContent = !screen || screen === core ? `slcode ${core}` : `slcode ${screen} (core ${core})`; };
  /** sdk 는 내부 플래그가 듣지 않는다고 기록된 Agent SDK 버전 (없으면 null) */
  const inspectBlocked = (sdk) => {
    inspBlocked = sdk ?? null;
    insp.disabled = !!inspBlocked;
    if (inspBlocked) { insp.checked = false; inspNote.textContent = `이 Claude Code(Agent SDK ${inspBlocked})는 inspect proxy 를 1st party 로 보지 않아 프롬프트 캐시 등 일부 기능이 꺼집니다. 그래서 이 버전에서는 inspect 를 켜지 않습니다.`; }
  };
  return { el: dlg, open: () => { showCat(catOf(cur)); dlg.showModal(); }, update, endable: (on) => { endRow.hidden = !on; }, version, inspectBlocked };
}
