// 시작 화면 (ticket slcode-session-profile, 사용자 2026-10-30) — 동사 없는 `slcode`. 가운데 new session, 아래 왼쪽은 지금 폴더의 세션, 오른쪽은 모든 폴더의 세션.
// 목록은 마지막 활동 순 — 꺼진 세션은 꺼진 지 얼마나 됐는지, 떠 있는 세션은 초록 점으로 열려 있다고만(누르지 못한다). 왼쪽의 꺼진 세션을 누르면 이어서 연다.
// 오른쪽은 아직 누르지 못한다. 프로필은 세션에 들어가 대화 화면 가운데에서 고른다 — 프로필 설정은 나중에 이 화면의 설정에 둔다(사용자).
// 웹(entry.ts 가 세션을 띄우기 전에 서빙)과 superlite 카드(views/session.js 가 플러그인 문서에 그린다)가 같은 화면을 쓴다. <html data-start> 가 입구:
// web 이면 같은 출처의 api/<동작> 에 POST, card 면 카드에 {type: 'slcode.start.<동작>', id} 를 보내고 {re: id, result|error} 를 받는다.
// 동작은 list({cwd, here, all} — startPage.ts StartList), go({new: true} | {resume: <id>}), 에이전트 플러그인 관리의 plugins.list·check·set·export (serve.pluginMethod).

const root = document.getElementById('start');
const html = document.documentElement;
const mode = html.dataset.start === 'card' ? 'card' : 'web';

let seq = 0;
const waits = new Map();
// 1단 카드는 플러그인이 같은 문서에 둔 함수로 보내고 답은 같은 창의 message 로 받는다. 옛 플러그인의 iframe 카드는 parent 와 주고받는다 (ticket slcode-card-iframe-flatten)
const cardHost = globalThis.slcodeCardHost;
const cardSource = cardHost ? window : parent;
addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== cardSource || !waits.has(d?.re)) return;
  const w = waits.get(d.re); waits.delete(d.re);
  if (d.error !== undefined) w.reject(new Error(d.error)); else w.resolve(d.result);
});
function call(action, args = {}) {
  if (mode === 'card') return new Promise((resolve, reject) => { const id = ++seq; waits.set(id, { resolve, reject }); const m = { type: `slcode.start.${action}`, id, ...args }; if (cardHost) cardHost(m); else parent.postMessage(m, '*'); });
  return fetch(`api/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
    .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`); return j; });
}

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f); else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  n.append(...kids.flat().filter((k) => k != null && k !== false));
  return n;
};

/** 꺼진 지 얼마나 — 1분 안은 방금 */
function ago(t) {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}일 전` : `${Math.floor(d / 30)}달 전`;
}
const base = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

const RECENT = 6; // 목록마다 처음에 이만큼 — 나머지는 '모두 보기'
const state = { list: null, open: { here: false, all: false }, error: null, busy: null, plugins: null };

async function load() {
  try { state.list = await call('list'); state.error = null; }
  catch (e) { state.error = `세션 목록을 읽지 못했습니다: ${e.message}`; }
  draw();
}

/** what: {new: true} | {resume: <id>} */
async function go(what, label) {
  if (state.busy) return;
  state.busy = label; state.error = null; draw();
  try {
    await call('go', what);
    // 웹은 세션이 뜨면 같은 주소가 대화 화면이 된다 — 진입 프로세스가 그동안의 연결을 쥐고 있다가 넘긴다. 카드는 카드가 화면을 바꾼다
    if (mode === 'web') location.reload();
  } catch (e) { state.busy = null; state.error = e.message; draw(); }
}

// 디자인 (사용자 2026-10-30 "버튼이 너무 동글다·줄 너비가 안 맞다·제목이 못생겼다" → 서브에이전트·GPT 안을 합침): 줄마다 씌운 상자를 걷고 얇은 구분선만,
// 채운 색은 new session 하나 — vscode 버튼처럼 모서리 2px·28px 높이·보통 굵기. 기본 색 묶음(system·light·dark)의 파랑은 옅어서 이 버튼만
// VS Code 의 button.background·hoverBackground(Light·Dark Modern)를 쓴다 (사용자 "더 vscode 다운 색"). 다른 테마는 그 테마의 강조색. 줄은 2열 grid — 제목과 오른쪽 끝의 상태(꺼진 때·열려 있음), 아래 줄에 폴더·벤더. 상태를 같은 칸에 두어 제목 시작선이 맞는다.
// 목록은 grid 라 div(누르지 못하는 줄)와 button(누르는 줄)이 같은 폭으로 늘어난다. 좁은 카드는 container query 로 한 열
const STYLE = `
#start{container-type:inline-size}
.st,.st *{box-sizing:border-box}
.st{max-width:880px;margin:0 auto;padding:14vh 32px 48px;font:14px/1.5 var(--acf-sans);color:var(--acf-fg)}
.st h1{margin:0;text-align:center;font-size:28px;font-weight:300;letter-spacing:.02em}
.st .go{display:block;margin:40px auto 64px;height:28px;padding:0 14px;border:1px solid var(--acf-accent);border-radius:2px;background:var(--acf-accent);color:var(--acf-on-accent);font:400 13px var(--acf-sans);cursor:pointer}
.st .go:hover{filter:brightness(1.08)}
html:not([data-theme*="-"]) .st .go{border-color:light-dark(#005fb8,#0078d4);background:light-dark(#005fb8,#0078d4)}
html:not([data-theme*="-"]) .st .go:hover{filter:none;border-color:light-dark(#0258a8,#026ec1);background:light-dark(#0258a8,#026ec1)}
.st .go:focus-visible{outline:2px solid var(--acf-accent);outline-offset:2px}
.st .go[disabled]{opacity:.5;cursor:default;filter:none}
.st .busy{text-align:center;color:var(--acf-muted);font-size:12px;margin:-48px 0 32px}
.st .cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:48px;row-gap:32px;align-items:start}
.st h2{display:flex;min-width:0;margin:0 0 6px;padding:0 10px 8px;border-bottom:1px solid var(--acf-line);font-size:13px;font-weight:600;line-height:20px;white-space:nowrap}
.st h2 .pa{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--acf-muted);font-weight:400}
.st h2 .nm{flex:none}
.st .list{display:grid;gap:2px}
.st .rs{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;padding:6px 10px;border:0;border-radius:2px;background:none;color:inherit;font:inherit;text-align:left}
.st .rs .t{line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st .rs .w{line-height:20px;color:var(--acf-muted);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.st .rs .on{display:flex;align-items:center;gap:6px;color:var(--acf-ok)}
.st .rs .on::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.st .rs .m{grid-column:1 / -1;color:var(--acf-muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st button.rs{cursor:pointer}
.st button.rs:hover{background:var(--acf-soft)}
.st button.rs:focus-visible{outline:2px solid var(--acf-accent);outline-offset:-2px}
.st button.rs[disabled]{opacity:.5;cursor:default;background:none}
.st .more{margin-top:4px;padding:4px 10px;border:0;border-radius:2px;background:none;color:var(--acf-muted);font:inherit;font-size:12px;cursor:pointer}
.st .more:hover{background:var(--acf-soft);color:var(--acf-fg)}
.st .none{padding:6px 10px;color:var(--acf-muted);font-size:12px}
.st .err{color:var(--acf-err);white-space:pre-wrap;margin-top:16px;text-align:center}
.st .more.plug{display:block;margin:40px auto 0}
.st.pl{max-width:1040px;padding-top:16px}
.st.pl .phead{display:flex;align-items:center;gap:6px;padding-bottom:10px;border-bottom:1px solid var(--acf-line)}
.st.pl .phead .more{margin:0;padding:0 8px;font-size:18px;line-height:28px}
.st.pl .pdetail{overflow:visible}
.st.pl .apply{background:var(--acf-bg)}
.st.pl h1{margin:0;font-size:15px;font-weight:600;text-align:left;letter-spacing:0}
@container (max-width:640px){
  .st{padding:32px 16px 24px}
  .st h1{font-size:22px}
  .st .go{margin:20px auto 32px}
  .st .busy{margin:-24px 0 16px}
  .st .cols{grid-template-columns:minmax(0,1fr);row-gap:28px}
}
`;

/** 제목 자리의 경로 — 상위는 흐리게 '…/<바로 위>/' 로 줄이고(넘치면 그쪽만 잘린다) 마지막 폴더만 진하게. 전체는 h2 의 title 로 */
function pathHead(p) {
  const s = p.split(/[\\/]/).filter(Boolean);
  const name = s.pop() ?? p;
  const parent = s.length > 1 ? `…/${s.at(-1)}/` : s.length ? `/${s[0]}/` : '/';
  return [el('span', { class: 'pa' }, parent), el('span', { class: 'nm' }, name)];
}
/** 세션 한 줄 — 제목 | 상태(꺼진 지 얼마 · 열려 있음) / 폴더·벤더. pick 이면 꺼진 세션을 눌러 이어서 연다(왼쪽), 아니면 보이기만(오른쪽·떠 있는 세션) */
function row(s, pick, where) {
  const kids = [
    el('span', { class: 't' }, s.title ?? s.id),
    s.live ? el('span', { class: 'w on' }, '열려 있음') : el('span', { class: 'w' }, ago(s.at)),
    el('span', { class: 'm' }, ...(where ? [base(s.cwd), ' · '] : []), s.vendor),
  ];
  if (!pick || s.live) return el('div', { class: 'rs', title: s.live ? '열려 있는 세션' : s.cwd }, ...kids);
  return el('button', { class: 'rs', disabled: !!state.busy, title: `${s.id} 이어서 열기`, on: { click: () => void go({ resume: s.id }, s.title ?? s.id) } }, ...kids);
}
function column(key, head, full, rows, pick, where) {
  const shown = state.open[key] ? rows : rows.slice(0, RECENT);
  return el('section', {},
    el('h2', { title: full }, head),
    shown.length ? el('div', { class: 'list' }, shown.map((s) => row(s, pick, where))) : el('div', { class: 'none' }, '세션이 없습니다'),
    rows.length > shown.length ? el('button', { class: 'more', on: { click: () => { state.open[key] = true; draw(); } } }, `모두 보기 (${rows.length})`) : null);
}

/** 에이전트 플러그인 관리 (ticket slcode-agent-plugin-ui) — slcode 의 유일한 입구 (ticket slcode-agent-plugin-export-action, 사용자 2026-11-01: 세션 화면에는 두지 않는다).
 *  웹은 모듈을 누를 때 읽고, 카드(srcdoc)는 import 가 닿지 않아 startPageHtml 이 넣어 둔 globalThis.slcodePlugins 를 쓴다. 요청은 call — 카드는 slcode.start.plugins.* 로 중계 */
async function openPlugins() {
  const { pluginsPanel } = globalThis.slcodePlugins ?? await import('./plugins.js');
  state.plugins = pluginsPanel(call);
  draw();
  state.plugins.load();
}

function draw() {
  const l = state.list;
  if (state.plugins) {
    root.replaceChildren(el('style', {}, STYLE), el('div', { class: 'st pl' },
      el('div', { class: 'phead' }, el('button', { class: 'more', title: '시작 화면', on: { click: () => { state.plugins = null; draw(); } } }, '‹'), el('h1', {}, '에이전트 플러그인')),
      state.plugins.el));
    return;
  }
  root.replaceChildren(el('style', {}, STYLE), el('div', { class: 'st' },
    el('h1', {}, 'slcode'),
    el('button', { class: 'go', disabled: !!state.busy, on: { click: () => void go({ new: true }, 'new session') } }, 'new session'),
    state.busy ? el('div', { class: 'busy' }, `${state.busy} — 여는 중…`) : null,
    l ? el('div', { class: 'cols' }, column('here', pathHead(l.cwd), l.cwd, l.here, true, false), column('all', 'all sessions', null, l.all, false, true)) : null,
    state.error ? el('div', { class: 'err' }, state.error) : null,
    el('button', { class: 'more plug', on: { click: () => void openPlugins() } }, '에이전트 플러그인')));
}

draw();
void load();
