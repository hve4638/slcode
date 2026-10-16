// 화면 설정 — 테마·context 경고 (ticket slcode-web-settings, 사용자 확정 2026-10-16. 글꼴 고르기는 사용자가 뺐다).
// 값은 상태 폴더에 입구마다 한 벌: 브라우저로 연 slcode 와 superlite 안의 slcode 탭이 따로 쓴다. 어느 벌인지는 serve 가 연결의 입구로 정하므로
// 이 파일은 모른다. serve 가 읽고 쓰고(settings.get·set), 파일이 바뀌면 같은 입구의 떠 있는 화면 모두에 settings.changed.
// 브라우저 저장소(localStorage)엔 두지 않는다. 고르면 바로 저장되고 모든 화면이 settings.changed 로 바뀐다 — 저장 버튼이 없다.
// 색 묶음은 style.css 의 [data-theme] 가, 목록과 이름은 여기가 정한다.

export const THEMES = [
  { id: 'system', label: '시스템' }, { id: 'light', label: '라이트' }, { id: 'dark', label: '다크' },
  { id: 'superlite', label: 'Superlite' }, { id: 'dimmed', label: 'Dimmed' }, { id: 'nord', label: 'Nord' }, { id: 'mocha', label: 'Mocha' }, { id: 'black', label: 'Black' },
  { id: 'solarized', label: 'Solarized' }, { id: 'paper', label: 'Paper' },
];
/** serve 의 DEFAULT_SETTINGS 와 같다 — 옛 serve(settings.get 이 없다)에 붙었을 때 이것으로 그린다 */
export const DEFAULTS = { theme: 'system', context: { warn: true, yellow: 30, red: 50 } };

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

  // 테마 — 견본마다 자기 data-theme 로 그 테마 색을 그린다. 시스템은 라이트·다크 반씩
  const swatch = (id) => h('span', { class: 'sw', 'data-theme': id }, h('span', { class: 'bar' }), h('span', { class: 'ln' }), h('span', { class: 'ln short' }), h('span', { class: 'dot' }));
  const themes = h('div', { class: 'themes' }, ...THEMES.map((t) => h('button', { class: 'theme', 'data-id': t.id, onclick: () => save({ theme: t.id }) },
    t.id === 'system' ? h('span', { class: 'split' }, swatch('light'), swatch('dark')) : swatch(t.id), h('span', { class: 'name' }, t.label))));

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

  // 세션 종료 — 맨 아래 줄, 왼쪽 이름 · 오른쪽 끝 빨간 '종료' (context 경고 줄과 같은 꼴). 누르면 확인 창을 한 번 더 (사용자 2026-10-16). 끝난 세션이면 숨긴다(endable)
  const confirmEnd = h('dialog', { class: 'confirm' }, h('p', {}, '세션을 종료할까요?'), h('div', { class: 'btns' },
    h('button', { onclick: () => confirmEnd.close() }, '취소'),
    h('button', { class: 'danger solid', onclick: () => { confirmEnd.close(); dlg.close(); end(); } }, '종료')));
  confirmEnd.addEventListener('click', (e) => { if (e.target === confirmEnd) confirmEnd.close(); });
  const endRow = h('section', { class: 'end' }, h('div', { class: 'row' }, h('h3', {}, '세션 종료'), h('button', { class: 'danger solid', onclick: () => confirmEnd.showModal() }, '종료')));

  const sec = (title, ...kids) => h('section', {}, h('h3', {}, title), ...kids);
  const dlg = h('dialog', { class: 'settings' },
    h('header', {}, h('h2', {}, '설정'), close),
    h('div', { class: 'body' },
      sec('테마', themes),
      h('section', {}, h('label', { class: 'switch' }, h('h3', {}, 'context 경고'), warn), ctxBody),
      endRow,
      err),
    confirmEnd);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // 바깥(배경) 클릭

  function update(s) {
    for (const b of themes.children) b.setAttribute('aria-checked', String(b.dataset.id === known(s.theme)));
    warn.checked = s.context.warn; ctxBody.classList.toggle('off', !s.context.warn); lo.disabled = hi.disabled = !s.context.warn;
    // 손잡이를 잡고 끌고 있으면 그 값을 그대로 둔다
    if (!range.matches(':active')) { lo.value = s.context.yellow; hi.value = s.context.red; paintRange(); }
  }
  update(DEFAULTS);
  return { el: dlg, open: () => dlg.showModal(), update, endable: (on) => { endRow.hidden = !on; } };
}
