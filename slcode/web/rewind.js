// 되돌리기 창 (ticket slcode-rewind-esc-picker, 사용자 2026-11-03) — Esc 두 번으로 입력창 자리에 뜬다. 꼴과 키는 Claude Code 2.1.316 의 Rewind 실측을 따른다:
// 목록(오래된 요청이 위, 맨 아래 '지금' 에서 시작, ↑↓·j/k·Home/End, 끝에서 돌지 않음) → Enter → 확인 단계(요청 전문, dry-run 결과, ↑↓ 는 돈다, 숫자는 바로 실행, Esc·취소는 목록으로).
// 요약 2종은 slcode 에 대응 기능이 없어 뺐다. 파일 수치는 벤더 dry-run 이 누계만 주므로 목록은 이름만, 수치는 확인 단계에만 보인다.
const base = (p) => p.split(/[\\/]/).pop();
export const editsLabel = (edits) => (!edits.length ? '코드 변경 없음' : edits.length === 1 ? base(edits[0]) : `파일 ${edits.length}개 변경`);
export const ago = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return '방금 전';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
};
/** 확인 단계의 코드 한 줄 — Claude Code 의 'The code will be restored -2 in b.txt' */
export function codeLine(f) {
  if (!f?.changed.length) return '코드는 그대로입니다.';
  const nums = [f.insertions ? `+${f.insertions}` : '', f.deletions ? `-${f.deletions}` : ''].filter(Boolean).join(' ');
  const where = f.changed.length === 1 ? base(f.changed[0]) : `파일 ${f.changed.length}개`;
  return `코드는 ${where}${nums ? ` ${nums}` : ''} 만큼 되돌아갑니다.`;
}
/** preview → 고를 수 있는 동작. 코드가 바뀌면 셋, 안 바뀌면 대화만 — 맨 뒤는 늘 취소 */
export function optionsOf(p) {
  const code = !!p.files?.changed.length, convo = p.conversation, out = [];
  if (code && convo) out.push({ label: '코드와 대화 되돌리기', conversation: true, files: true });
  if (convo) out.push({ label: '대화만 되돌리기', conversation: true, files: false });
  if (code) out.push({ label: '코드만 되돌리기', conversation: false, files: true });
  out.push({ label: '취소', cancel: true });
  return out;
}

/** deps: rpc·getId, close()(창을 내린다), run(seq, text, conversation, files)(되돌리기 실행, Promise), head(turn)(목록 줄) */
export function rewindPicker(h, deps) {
  const el = h('div', { class: 'rewind', tabindex: -1 });
  let turns = [], sel = 0, confirm = null, token = 0;
  const fail = (e) => { el.replaceChildren(h('div', { class: 'title' }, '되돌리기'), h('div', { class: 'err' }, e.message), h('div', { class: 'keys' }, 'Esc 닫기')); confirm = { failed: true, options: [], sel: 0 }; };

  function paintList() {
    const more = [h('div', { class: 'more up' }), h('div', { class: 'more down' })];
    const rows = h('div', { class: 'rows' }, ...turns.map((t, i) => h('button', { class: 'pt', 'aria-selected': String(i === sel), tabindex: -1, onclick: () => { sel = i; choose(); } },
      h('span', { class: 'mk' }, i === sel ? '›' : ''), h('span', { class: 'tx' }, h('span', { class: 't' }, deps.head(t)), h('span', { class: 'f' }, editsLabel(t.edits))))),
      h('button', { class: 'pt now', 'aria-selected': String(sel === turns.length), tabindex: -1, onclick: () => deps.close() }, h('span', { class: 'mk' }, sel === turns.length ? '›' : ''), h('span', { class: 'tx' }, h('span', { class: 't' }, '(지금)'))));
    // 줄이 넘치면 위아래로 가려진 수를 보인다 — scrollIntoView 는 카드 iframe 의 바깥까지 굴린다
    const count = () => {
      const all = [...rows.children], top = rows.scrollTop, bot = top + rows.clientHeight;
      const up = all.filter((r) => r.offsetTop + r.offsetHeight <= top + 1).length, dn = all.filter((r) => r.offsetTop >= bot - 1).length;
      more[0].textContent = up ? `↑ ${up}개 더` : ''; more[1].textContent = dn ? `↓ ${dn}개 더` : '';
    };
    rows.onscroll = count;
    el.replaceChildren(h('div', { class: 'title' }, '되돌리기'), h('div', { class: 'sub' }, '코드와 대화를 이 요청을 보내기 전으로 되돌립니다'), more[0], rows, more[1], h('div', { class: 'keys' }, '↑↓ 고르기 · Enter 계속 · Esc 취소'));
    const cur = rows.children[sel];
    if (cur.offsetTop < rows.scrollTop) rows.scrollTop = cur.offsetTop;
    else if (cur.offsetTop + cur.offsetHeight > rows.scrollTop + rows.clientHeight) rows.scrollTop = cur.offsetTop + cur.offsetHeight - rows.clientHeight;
    count();
    el.focus({ preventScroll: true }); // 줄을 눌러 고른 뒤에도 키를 받는다 — 눌린 줄은 다시 그릴 때 사라진다
  }
  function paintConfirm() {
    const c = confirm, t = c.turn, o = c.options[c.sel];
    const lines = c.preview ? [
      h('div', {}, o?.conversation ? '이 요청과 그 뒤의 대화가 사라집니다.' : '대화는 그대로입니다.'),
      h('div', {}, o?.files ? codeLine(c.preview.files) : '코드는 그대로입니다.'),
    ] : [];
    el.replaceChildren(...[h('div', { class: 'title' }, '되돌리기'), h('div', { class: 'sub' }, '이 요청을 보내기 전으로 되돌립니다:'),
      h('blockquote', {}, h('div', { class: 'q' }, t.text || t.files.join(', ')), h('div', { class: 'at' }, ago(Date.now() - t.at))),
      c.busy ? h('div', { class: 'wait' }, c.busy) : h('div', { class: 'effects' }, ...lines),
      c.preview?.error ? h('div', { class: 'err' }, c.preview.error) : null,
      c.busy ? null : h('div', { class: 'opts' }, ...c.options.map((x, i) => h('button', { class: 'pt opt', 'aria-selected': String(i === c.sel), tabindex: -1, onclick: () => { c.sel = i; act(); } }, h('span', { class: 'mk' }, i === c.sel ? '›' : ''), h('span', { class: 't' }, `${i + 1}. ${x.label}`)))),
      c.preview?.files?.changed.length && o?.files ? h('div', { class: 'warn' }, '파일은 통째로 되돌아가므로 그 뒤의 다른 변경도 사라집니다. Bash 로 바꾼 다른 파일은 되돌아가지 않습니다.') : null,
      c.busy ? null : h('div', { class: 'keys' }, '↑↓ 고르기 · Enter 실행 · 숫자 바로 실행 · Esc 뒤로')].filter(Boolean));
    el.focus({ preventScroll: true });
  }
  async function choose() {
    if (sel === turns.length) { deps.close(); return; }
    const turn = turns[sel], mine = ++token;
    confirm = { turn, options: [], sel: 0, preview: null, busy: '확인 중…' };
    paintConfirm();
    let preview;
    try { preview = await deps.rpc('session.rewindPreview', { id: deps.getId(), seq: turn.seq }); }
    catch (e) { preview = { conversation: false, files: null, error: e.message }; }
    if (mine !== token || !confirm) return;
    confirm.preview = preview; confirm.options = optionsOf(preview); confirm.busy = null;
    paintConfirm();
  }
  async function act() {
    const c = confirm, o = c?.options[c.sel];
    if (!o || c.busy) return;
    if (o.cancel) { back(); return; }
    c.busy = '되돌리는 중…'; paintConfirm();
    try { await deps.run(c.turn.seq, c.turn.text, o.conversation, o.files); deps.close(); }
    catch (e) { fail(e); }
  }
  const back = () => { token++; confirm = null; paintList(); };
  el.onkeydown = (e) => {
    const k = e.key;
    if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (k !== 'Tab') e.stopPropagation();
    if (confirm) {
      const n = confirm.options.length;
      if (k === 'Escape') { e.preventDefault(); if (confirm.failed) deps.close(); else back(); }
      else if (confirm.busy) e.preventDefault();
      else if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); if (n) { confirm.sel = (confirm.sel + 1) % n; paintConfirm(); } }
      else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); if (n) { confirm.sel = (confirm.sel + n - 1) % n; paintConfirm(); } }
      else if (k === 'Enter') { e.preventDefault(); void act(); }
      else if (/^[1-9]$/.test(k) && Number(k) <= n) { e.preventDefault(); confirm.sel = Number(k) - 1; void act(); }
      return;
    }
    const last = turns.length;
    if (k === 'Escape') { e.preventDefault(); deps.close(); }
    else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); sel = Math.max(0, sel - 1); paintList(); }
    else if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); sel = Math.min(last, sel + 1); paintList(); }
    else if (k === 'Home') { e.preventDefault(); sel = 0; paintList(); }
    else if (k === 'End') { e.preventDefault(); sel = last; paintList(); }
    else if (k === 'Enter') { e.preventDefault(); void choose(); }
  };
  return {
    el,
    /** 목록을 받아 그린다 — 되돌릴 턴이 없으면 false (Claude Code 도 빈 세션에선 열지 않는다) */
    async load() {
      token++;
      const list = await deps.rpc('session.prompts', { id: deps.getId() });
      turns = list.filter((t) => !t.command);
      if (!turns.length) return false;
      sel = turns.length; confirm = null;
      return true;
    },
    paint() { paintList(); },
  };
}
