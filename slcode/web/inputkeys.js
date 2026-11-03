// 입력창 history (ticket slcode-input-history-arrows, 사용자 2026-11-03) — 위·아래 키로 이 세션의 지난 입력을 불러온다. 화면은 모르고 입력칸과 콜백만 본다.
// 넘어가는 조건은 ticket 의 규칙이다: 빈 입력, 커서 맨 처음(위)·맨 끝(아래), 또는 넘어간 직후(nav). 글자 입력·커서 이동을 하면 nav 가 풀린다.
// Claude Code 2.1.316 은 첫·마지막 화면 줄이면 넘어가고 여러 줄 기록은 줄을 지나는데, 이 조건만 따르지 않는다 (사용자 결정).
// 나머지는 Claude Code 실측대로: 위로 가면 글 끝·아래로 가면 글 맨 앞에 커서, 맨 아래는 쓰던 초안, 고친 내용은 전송 전까지 그 항목에 남는다.
const MODIFIER = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

/** set(text): 입력칸 글을 바꾼다. paint(pos, total): 표시를 고친다 — pos 가 null 이면 숨긴다 */
export function inputHistory(input, set, paint) {
  let items = []; // { seq, text, local? } — seq 순. local 은 Esc 두 번으로 지운 글 (서버 기록에 없다)
  let cur = null; // 보고 있는 항목의 seq, null 이면 초안 자리
  let nav = false, draft = '';
  const edits = new Map(); // seq → 고친 글
  const repaint = () => { if (nav && cur !== null) paint(items.findIndex((x) => x.seq === cur) + 1, items.length); else paint(null, items.length); };
  const leave = () => {
    if (cur === null) { draft = input.value; return; }
    const it = items.find((x) => x.seq === cur);
    if (it && input.value !== it.text) edits.set(cur, input.value); else edits.delete(cur);
  };
  function move(dir) {
    const i = cur === null ? items.length : items.findIndex((x) => x.seq === cur), j = i + dir;
    if (j < 0 || j > items.length) return;
    leave();
    cur = j === items.length ? null : items[j].seq;
    nav = true;
    set(cur === null ? draft : edits.get(cur) ?? items[j].text);
    const at = dir < 0 ? input.value.length : 0;
    input.setSelectionRange(at, at);
    input.scrollTop = dir < 0 ? input.scrollHeight : 0;
    repaint();
  }
  return {
    get nav() { return nav; },
    /** 키 하나 — 입력창 history 가 받았으면 true (기본 동작을 막는다) */
    key(e) {
      if (MODIFIER.has(e.key)) return false;
      const arrow = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!arrow || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) { this.unpin(); return false; }
      const v = input.value, a = input.selectionStart, b = input.selectionEnd;
      if (!nav && v && !(a === b && a === (arrow < 0 ? 0 : v.length))) {
        // 첫 줄에서 위·마지막 줄에서 아래를 누르면 커서는 끝으로 가야 다음 누름이 기록으로 넘어간다. Linux·macOS Chromium 은 스스로 그렇게 하지만 Windows(WebView2 포함)는 제자리다
        if (a === b) setTimeout(() => { if (input.selectionStart === a && input.selectionEnd === a && input.value === v) { const at = arrow < 0 ? 0 : v.length; input.setSelectionRange(at, at); } });
        return false;
      }
      if (!nav && arrow > 0 && cur === null) return false; // 아래로 갈 곳이 없다 — 커서는 이미 끝이다
      if (!items.length) return false;
      move(arrow);
      return true;
    },
    /** 넘어간 직후 상태를 푼다 — 다음부터 커서 규칙이 다시 적용된다 */
    unpin() { if (nav) { nav = false; repaint(); } },
    /** 서버 기록으로 맞춘다 — 그 뒤에 온 실시간 항목과 지운 글은 남긴다 */
    seed(list) {
      const max = list.length ? list[list.length - 1].seq : -1;
      items = [...list, ...items.filter((x) => x.local || x.seq > max)].sort((p, q) => p.seq - q.seq);
      repaint();
    },
    add(seq, text) { if (text && !items.some((x) => x.seq === seq)) { items.push({ seq, text }); items.sort((p, q) => p.seq - q.seq); repaint(); } },
    /** Esc 두 번으로 지운 글 — after 는 지금까지 본 마지막 seq (그 뒤에 선다) */
    addCleared(after, text) { if (text && !items.some((x) => x.text === text)) { let seq = after + 0.5; while (items.some((x) => x.seq === seq)) seq += 0.001; items.push({ seq, text, local: true }); items.sort((p, q) => p.seq - q.seq); } },
    /** 대화 되돌리기 — from 부터 at 앞까지의 입력을 뺀다 */
    cut(from, at) {
      items = items.filter((x) => x.local || x.seq < from || x.seq >= at);
      if (cur !== null && !items.some((x) => x.seq === cur)) { cur = null; nav = false; }
      for (const k of edits.keys()) if (!items.some((x) => x.seq === k)) edits.delete(k);
      repaint();
    },
    /** 보냈거나 지웠다 — 맨 아래 빈 자리로, 고친 내용은 버린다 */
    reset() { cur = null; nav = false; draft = ''; edits.clear(); repaint(); },
  };
}

/** Esc 두 번 판정 (Claude Code 실측: 700ms 열림, 900ms 안 열림). 같은 상태에서 눌렀을 때만 두 번으로 친다 */
export const ESC_MS = 800;
export function escGate(ms = ESC_MS) {
  let at = -Infinity, was = null;
  return {
    /** now: 지금 시각, kind: 'text'|'empty' — 두 번째 누름이면 true */
    press(now, kind) { const twice = kind === was && now - at <= ms; at = twice ? -Infinity : now; was = twice ? null : kind; return twice; },
    reset() { at = -Infinity; was = null; },
  };
}
