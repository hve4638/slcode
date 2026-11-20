// 번역 단추 (ticket slcode-thinking-translate, 사용자 2026-11-20) — 글 블록에 붙는 늘 반투명한 아이콘. 누르면 translate(글) 이 돌려준
// {source, translation}[] 의 짝마다 원문 아래에 번역을 끼워 보이고, 다시 누르면 원문만 보인다. Ctrl(⌘)+클릭은 캐시를 쓰지 않고 다시 번역한다 (사용자 2026-11-21).
// translate 는 superlite 카드의 플러그인 화면이 건네는 translator 의 것이다(views/session.js — 설정 › AI Model 의 모델에 묻고 캐시한다). 브라우저로 연 slcode 에는 없어서 단추를 만들지 않는다.
// 블록 종류를 모른다 — 생각 블록 밖(system prompt 편집 창 등)에도 같은 단추를 붙인다.

// lucide languages
const ICON = '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>';
const TITLE = '한국어로 번역 (Ctrl+클릭: 캐시 없이 다시)';

const el = (tag, cls, text) => { const e = document.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** text: 원문, body: 번역을 그릴 요소(원문으로 돌아갈 때 textContent = text), translate(text, {fresh}) → 짝 목록, before: 그리기 전에 부른다(접힌 블록 펼치기 등),
 *  keep(단추, fn): 글을 바꾸는 동안 단추 자리를 화면에 지킨다 (사용자 2026-11-21 — 대화 피드는 app.js keepAt). 없으면 그냥 바꾼다 */
export function translateButton({ text, body, translate, before, keep = (_, fn) => fn() }) {
  const b = el('button', 'trbtn');
  b.type = 'button';
  b.title = TITLE; b.setAttribute('aria-label', TITLE);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.innerHTML = ICON;
  b.append(svg);
  let shown = false;
  const mark = (state, title) => { b.classList.toggle('on', state === 'on'); b.classList.toggle('busy', state === 'busy'); b.classList.toggle('err', state === 'err'); b.title = title; b.setAttribute('aria-label', title); };
  b.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation(); // summary 안에 있으면 블록을 접고 펴지 않게
    if (b.classList.contains('busy')) return;
    const fresh = e.ctrlKey || e.metaKey;
    if (shown && !fresh) { shown = false; keep(b, () => { body.textContent = text; }); mark('', TITLE); return; }
    keep(b, () => { before?.(); body.textContent = text; });
    mark('busy', '번역하는 중');
    try {
      const pairs = await translate(text.trim(), { fresh });
      keep(b, () => body.replaceChildren(...pairs.map((p) => { const d = el('div', 'trpair'); d.append(el('div', 'src', p.source), el('div', 'tl', p.translation)); return d; })));
      shown = true; mark('on', '원문만 보기 (Ctrl+클릭: 캐시 없이 다시)');
    } catch (err) {
      keep(b, () => body.append(el('div', 'trerr', `번역하지 못했습니다: ${err?.message ?? err}`)));
      mark('err', TITLE);
    }
  });
  return b;
}
