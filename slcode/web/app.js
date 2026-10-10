// 에이전트 프런트 — 한 프런트 두 모드. 이 파일은 core 프로토콜(protocol.ts)만 알고 superlite 유무를 모른다.
// 웹 모드(index.html, WsTransport)와 superlite 카드 모드(후속 agent-plugin-card)가 같은 mountAgentFront 를 쓴다.
// 화면 하나 = 세션 하나 (사용자 결정 2026-09-25/26): 세션 id 는 opts.sessionId, 없으면 서버에 server.info 로 묻는다 (slcode 서버 하나 = 세션 하나).
// 세션 목록·새 세션은 이 화면에 없다 — 새 세션은 새 `slcode` 명령(또는 superlite 의 새 카드).
// transport = { request(method, params), onEvent(fn), onStatus(fn) } (rpc.js 표면).
import { renderMarkdown } from './markdown.js';

const STATE_LABEL = { starting: '시작 중', idle: '대기', running: '실행 중', requires_action: '응답 필요', exited: '종료', disconnected: '연결 끊김' };
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k.startsWith('on')) el[k] = v; else if (v !== null && v !== undefined) el.setAttribute(k, v); }
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const short = (s, n = 120) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** 도구 입력 한 줄 요약 — Bash 는 명령, 파일 도구는 경로 */
function toolArg(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return input.command;
  if (input.file_path) return input.file_path;
  if (input.pattern) return input.pattern;
  if (input.description) return input.description;
  if (Array.isArray(input.questions)) return input.questions.map((q) => q?.question).filter(Boolean).join(' · ');
  const keys = Object.keys(input);
  return keys.length ? `${keys[0]}: ${short(JSON.stringify(input[keys[0]]), 80)}` : '';
}

export function mountAgentFront(root, transport, opts = {}) {
  root.innerHTML = '';
  const el = h('div', { class: 'acf' });
  // 왼쪽 상단은 세션 이름 — 없으면 SLCode, 더블클릭·옆 연필로 고친다(session.rename). superlite 카드 제목도 이 이름을 따른다.
  // id 는 오른쪽 '세션' 칸(올리면 복사 버튼, 사용자 2026-10-09), 경로는 오른쪽 폴더 줄의 복사 버튼 (사용자 2026-10-07)
  const DEFAULT_NAME = 'SLCode';
  const title = h('span', { class: 'title' }, DEFAULT_NAME);
  const setTitle = (t) => { title.textContent = t || DEFAULT_NAME; };
  const nameRow = h('div', { class: 'name-row' }, title); // 연필 버튼은 iconBtn 정의 뒤에 붙인다
  const pill = h('span', { class: 'pill starting' }, STATE_LABEL.starting);
  const feed = h('div', { class: 'feed' });
  const liveCol = h('div', { class: 'col' });
  let col = liveCol; // 옛 턴을 그릴 땐 임시 div 로 바꿨다가 앞에 붙인다
  const older = h('div', { class: 'col older' }), sentinel = h('div');
  feed.append(sentinel, older, liveCol);
  const input = h('textarea', { rows: 1 });
  const sendBtn = h('button', { class: 'send primary', title: '전송', disabled: '', onclick: () => send() });
  const stopBtn = h('button', { class: 'stop primary', title: '중단', onclick: () => current && rpc('session.interrupt', { id: current }) });
  stopBtn.style.display = 'none';
  let busyNow = false; // running·requires_action — 보내기 자리에 중단 (canSend 가 바꾼다)
  // 첨부: 붙여넣기·끌어놓기·+ 버튼 → 칩으로 쌓였다가 전송에 실린다. 이미지·PDF·텍스트류만 (그 밖은 core 가 본문에 UTF-8 로 풀어 넣으므로 막는다)
  const chips = h('div', { class: 'chips' });
  const pendingFiles = [];
  const filePick = h('input', { type: 'file', multiple: '', hidden: '' });
  filePick.onchange = () => { addFiles(filePick.files); filePick.value = ''; };
  const addBtn = h('button', { class: 'ghost add', title: '파일 첨부', onclick: () => filePick.click() });
  async function addFiles(files) {
    for (const f of files) {
      const mediaType = f.type || 'text/plain';
      if (!/^image\/(png|jpeg|gif|webp)$|^application\/pdf$|^text\/|json$|xml$|javascript$/.test(mediaType)) { push(h('div', { class: 'meta err' }, `${f.name}: 이미지·PDF·텍스트만`)); continue; }
      const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
      const att = { name: f.name || `clipboard.${mediaType.split('/')[1]}`, mediaType, data: dataUrl.split(',')[1], dataUrl };
      pendingFiles.push(att);
      const chip = h('span', { class: 'chip' }, mediaType.startsWith('image/') ? h('img', { src: dataUrl }) : null, att.name, h('a', { onclick: () => { pendingFiles.splice(pendingFiles.indexOf(att), 1); chip.remove(); canSend(); } }, '×'));
      chips.append(chip);
    }
    canSend();
  }
  // 모델 선택 — 작성창의 알약 버튼 + popover 메뉴 (네이티브 popover 라 바깥 클릭·Esc 로 닫힌다). 목록은 session.models, 고르면 session.setModel (다음 턴부터).
  // 위쪽엔 계열마다 버전이 가장 높은 것만, 나머지는 '더 많은 모델' 아래. 계열 = 표시 이름에서 버전 숫자를 뗀 것 ("Fable 5.1"→Fable, "GPT-5.6 Sol"→GPT Sol),
  // 버전 숫자가 없는 항목(Default, Opus (1M context))은 아래로. 벤더가 늘어도(Codex 등) 한 목록에 섞인다 (사용자 2026-09-27)
  const modelLbl = h('span', {}, '');
  const modelBtn = h('button', { class: 'ghost pill-btn model', popovertarget: 'acf-models', style: 'display:none' }, modelLbl);
  const modelMenu = h('div', { class: 'menu', id: 'acf-models', popover: '' });
  // effort — 모델 옆 알약 + 메뉴 (session.setEffort, 다음 턴부터). 목록은 지금 모델의 efforts, 없으면 다섯 단계 전부
  const effortLbl = h('span', {}, '');
  const effortBtn = h('button', { class: 'ghost pill-btn effort', popovertarget: 'acf-effort', style: 'display:none' }, effortLbl);
  const effortMenu = h('div', { class: 'menu', id: 'acf-effort', popover: '' });
  // 권한 모드 — effort 옆 알약 + 메뉴 (session.setMode, 즉시). 현재 값은 info.permissionMode (session.changed 로 갱신)
  const REVIEW = { approved: '허용', denied: '거부', timedOut: '시간 초과', aborted: '중단' };
  const RISK = { low: '낮음', medium: '보통', high: '높음', critical: '심각' };
  const MODES = [['default', 'default', '도구마다 승인'], ['acceptEdits', 'acceptEdits', '파일 수정은 승인 없이'], ['auto', 'auto', 'AI 가 대신 승인'], ['bypassPermissions', 'bypass', '승인 없음']];
  const modeLbl = h('span', {}, '');
  const modeBtn = h('button', { class: 'ghost pill-btn mode', popovertarget: 'acf-mode' }, modeLbl);
  const modeMenu = h('div', { class: 'menu', id: 'acf-mode', popover: '' });
  // auto 는 노랑, bypass 는 빨강 — Claude Code 의 상태 줄 색 (사용자 2026-10-09). plan 은 메뉴에서 뺐다(쓸 일이 없다) — 와이어는 옛 세션을 위해 계속 받는다
  const paintMode = (v) => { modeLbl.textContent = MODES.find(([m]) => m === v)?.[1] ?? v; modeBtn.classList.toggle('auto', v === 'auto'); modeBtn.classList.toggle('bypass', v === 'bypassPermissions'); };
  function renderMode() {
    const cur = info?.permissionMode ?? ready?.permissionMode ?? 'default';
    paintMode(cur);
    modeMenu.replaceChildren(...MODES.map(([v, label, desc]) => h('button', { class: 'item', 'aria-checked': String(v === cur), onclick: () => { modeMenu.hidePopover(); paintMode(v); rpc('session.setMode', { id: current, mode: v }).catch((e) => { push(h('div', { class: 'meta err' }, e.message)); renderMode(); }); } }, h('span', { class: `m-${v}` }, label), h('span', { class: 'desc' }, desc))));
  }
  const anchor = (menu, btn) => () => { if (menu.matches(':popover-open')) { const r = btn.getBoundingClientRect(); menu.style.left = `${r.right - menu.offsetWidth}px`; menu.style.bottom = `${innerHeight - r.top + 6}px`; } };
  modelMenu.ontoggle = anchor(modelMenu, modelBtn); effortMenu.ontoggle = anchor(effortMenu, effortBtn); modeMenu.ontoggle = anchor(modeMenu, modeBtn);
  // 슬래시 명령 자동완성 — 입력이 `/` 로 시작하면 입력창 위에 목록. ↑↓ 고르고 Tab·Enter 로 넣는다. 목록은 session.commands (2026-09-30)
  let commands = [], slashSel = 0;
  const slashMenu = h('div', { class: 'menu slash', id: 'acf-slash', popover: 'manual' });
  // 플러그인 접두(core:)는 생략해도 된다: 짧은 이름으로도 맞추고, 짧은 이름이 정확히 같은 것을 앞에 둔다 (사용자 2026-09-30)
  const shortOf = (name) => name.slice(name.indexOf(':') + 1);
  function slashItems() {
    const t = input.value; if (!t.startsWith('/') || /\s/.test(t)) return [];
    const q = t.slice(1).toLowerCase();
    const rank = (c) => { const n = c.name.toLowerCase(), sh = shortOf(n); return n === q || sh === q ? 0 : n.startsWith(q) ? 1 : sh.startsWith(q) ? 2 : 9; };
    return commands.map((c) => [rank(c), c]).filter(([r]) => r < 9).sort((a, b) => a[0] - b[0]).map(([, c]) => c).slice(0, 12);
  }
  /** 보낼 때 첫 토큰이 접두 없는 짧은 이름이고 한 명령에만 맞으면 전체 이름으로 바꾼다. 둘 이상이면(같은 스킬이 두 플러그인에) 그대로 둔다 */
  function resolveSlash(text) {
    const m = text.match(/^\/(\S+)([\s\S]*)$/); if (!m) return text;
    const tok = m[1].toLowerCase();
    if (commands.some((c) => c.name.toLowerCase() === tok)) return text;
    const hits = commands.filter((c) => shortOf(c.name.toLowerCase()) === tok);
    return hits.length === 1 ? `/${hits[0].name}${m[2]}` : text;
  }
  function slashDraw() {
    const items = slashItems();
    if (!items.length) { if (slashMenu.matches(':popover-open')) slashMenu.hidePopover(); return; }
    slashSel = Math.min(slashSel, items.length - 1);
    slashMenu.replaceChildren(...items.map((c, i) => h('button', { class: 'item', 'aria-selected': String(i === slashSel), onmousedown: (e) => { e.preventDefault(); slashPick(c); } },
      h('span', { class: 'name' }, `/${c.name}`, c.argumentHint ? h('span', { class: 'hint' }, ` ${c.argumentHint}`) : null), h('span', { class: 'desc' }, c.description))));
    if (!slashMenu.matches(':popover-open')) slashMenu.showPopover();
    const r = input.getBoundingClientRect(); slashMenu.style.left = `${r.left}px`; slashMenu.style.bottom = `${innerHeight - r.top + 12}px`; slashMenu.style.width = `${r.width}px`;
  }
  function slashPick(c) { input.value = `/${c.name} `; input.focus(); slashDraw(); }
  async function loadCommands() { try { commands = await rpc('session.commands', { id: current }); } catch { commands = []; } }
  const composer = h('div', { class: 'composer' }, h('div', { class: 'box' }, chips, h('div', { class: 'row' }, addBtn, input, stopBtn, sendBtn), h('div', { class: 'tools' }, modeBtn, modeMenu, effortBtn, effortMenu, modelBtn, modelMenu), slashMenu, filePick));
  const side = h('aside', { class: 'side' });
  const dock = h('div', { class: 'dock' });
  // 실행 중 표시 — 피드 맨 끝(내 요청 바로 아래)에 한 줄: 맥동 점 · 지금 하는 일 · 경과. state 가 running 일 때만, 새 항목이 와도 늘 마지막 (사용자 2026-09-30)
  // claude·codex 의 줄과 같은 꼴: ✻ 작업 중… (1m 8s · effort · esc 중단). 글리프는 claude 처럼 돌아간다
  const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const busyGlyph = h('i', {}, SPIN[0]), busyWhat = h('span', { class: 'what' }), busyInfo = h('span', { class: 'info' });
  const busy = h('div', { class: 'busy', hidden: '' }, busyGlyph, busyWhat, busyInfo);
  // busySince 는 서버 시각(e.at) — 브라우저 시계와 어긋나면 음수로 시작해서, 실시간 이벤트가 올 때마다 재는 skew 로 보정한다 (2026-10-01 -2s 지적)
  let busySince = 0, busyTimer = null, busyTick = 0, skew = 0;
  const setBusy = (what) => { if (what && !replaying) busyWhat.textContent = `${what}…`; };
  const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
  const busyRefresh = () => { busyGlyph.textContent = SPIN[busyTick++ % SPIN.length]; busyInfo.textContent = `(${[fmtDur(Math.max(0, Date.now() - skew - busySince)), effortLbl.textContent !== 'effort' ? `effort ${effortLbl.textContent}` : null, 'esc 중단'].filter(Boolean).join(' · ')})`; };
  function showBusy(on) {
    busy.hidden = !on;
    if (on) { col.append(busy); if (follow) feed.scrollTop = feed.scrollHeight; }
    if (on && !busyTimer) { busySince = busySince || Date.now(); busyRefresh(); busyTimer = setInterval(busyRefresh, 200); }
    if (!on && busyTimer) { clearInterval(busyTimer); busyTimer = null; busySince = 0; }
  } // 승인·질문 카드는 입력창 자리에 뜬다 — 피드에는 호출 표식만 (사용자 2026-09-30)
  // 상단 바 없음 — 세션 이름·cwd·상태는 왼쪽 여백, 세션 정보는 오른쪽 여백 (사용자 2026-09-27). ponytail: 좁은 화면 대응 없음, 모바일이 필요하면 미디어 쿼리로
  el.append(
    h('aside', { class: 'left' }, nameRow, pill),
    h('div', { class: 'main' }, feed, dock, composer),
    side,
  );
  root.append(el);

  const rpc = (m, p) => transport.request(m, p);
  let current = null, lastSeq = 0, curSeq = 0, replaying = false, info = null, ready = null, connected = false;
  // 스트리밍 상태는 범위마다 — 본문(main)과 서브에이전트(부모 tool_use id)마다 따로 (2026-09-30, 작업 카드)
  let main = { col: null, textEl: null, textBuf: '', thinkEl: null, thinkBuf: '' };
  const subs = new Map(); // parent toolUseId → scope
  const tasks = new Map(); // taskId → { card, ev } 실행 중인 서브에이전트 — 사이드바 목록 (claude 의 실행 중 에이전트 표시, 사용자 2026-09-30)
  // 부모 tool_use 의 카드가 있으면 그 안에 상태 줄 + 중첩 피드를 만들어 범위로 쓴다 (task 이벤트보다 하위 이벤트가 먼저 와도 된다)
  function scopeOf(parent) {
    if (!parent) return main;
    let sc = subs.get(parent);
    if (!sc) { const d = tools.get(parent); if (!d) return main; d._task = h('div', { class: 'tstat' }); const sub = h('div', { class: 'sub' }); d._detail.append(d._task, sub); sc = { col: sub, textEl: null, textBuf: '', thinkEl: null, thinkBuf: '' }; subs.set(parent, sc); }
    return sc;
  }
  const tools = new Map(), cards = new Map(), toolParent = new Map(); // toolParent: 서브에이전트 안 도구 → 부모 Agent 도구 (승인 카드 출처)
  const sentFiles = new Map(); // 이름 → dataUrl: 이 화면에서 보낸 이미지의 미리보기 (로그엔 이름만 남는다)
  const usage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let costBase = 0, costLast = 0, costKnown = false; // SDK total_cost_usd 는 프로세스 누계 — --resume 뒤 0 부터 다시 시작하므로 줄어드는 경계에서 기준선에 합친다
  let hooks = 0, lastHook = '';
  let status = null; // session.status — 브랜치·플랜 리밋. attach 와 turn.end 때 한 번씩 (폴링 없음)
  function tally(ev) { // 사용량 누계 — 옛 턴은 그리기 전에 미리 센다
    usage.turns++;
    if (ev.usage) { usage.input += ev.usage.input; usage.output += ev.usage.output; usage.cacheRead += ev.usage.cacheRead; usage.cacheWrite += ev.usage.cacheWrite; }
    if (ev.costUsd != null) { costKnown = true; if (ev.costUsd < costLast) costBase += costLast; costLast = ev.costUsd; usage.cost = costBase + costLast; }
  }
  async function loadStatus() { if (!current) return; try { status = await rpc('session.status', { id: current }); } catch { status = null; } renderSide(); }

  // 따라가기 — 바닥에 있을 때만 새 항목을 따라 내려간다. 부드러운 스크롤 도중엔 위치 측정이 틀리므로(2026-09-30 실측) 값을 재지 않고 플래그를 든다:
  // 사용자가 스크롤하면 그때 바닥 여부를 재고, 보내기·바닥 도달 때 켠다
  let follow = true;
  feed.onscroll = () => { follow = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80; };
  const toBottom = () => { follow = true; feed.scrollTop = feed.scrollHeight; };
  const atBottom = () => follow;
  function push(node, sc = main) { const stick = atBottom(); node.dataset.seq = curSeq; (sc.col ?? col).append(node); if (!busy.hidden && !replaying) col.append(busy); if (stick && !replaying) feed.scrollTop = feed.scrollHeight; return node; }
  function endText(sc = main) { if (sc.textEl) { sc.textEl.classList.remove('streaming'); sc.textEl.append(acts(iconBtn('copy', '복사', copyOf(sc.textBuf)))); } sc.textEl = null; sc.textBuf = ''; sc.thinkEl = null; sc.thinkBuf = ''; }
  // 말풍선 아래 아이콘 줄 (ChatGPT 꼴, 사용자 2026-09-27) — 복사, (사용자 턴엔) 돌아가기 = claude 의 Esc-Esc: 답변만 / 코드만 / 둘 다
  const ICONS = {
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    up: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    // 사이드바 상단 요약 아이콘 (claude 상태줄의 📁🌿⌛📦💻 자리, 외곽선만) — lucide 꼴
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
    coin: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
    rewind: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  };
  const icon = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = ICONS[name]; return s; };
  const iconBtn = (name, title, onclick) => h('button', { class: 'ico', title, 'aria-label': title, onclick }, icon(name));
  const acts = (...btns) => h('div', { class: 'acts' }, ...btns);
  function editName() {
    if (!current) return;
    const inp = h('input', { class: 'title-edit', value: info?.title ?? '', placeholder: DEFAULT_NAME });
    nameRow.replaceChildren(inp); inp.focus(); inp.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      nameRow.replaceChildren(title, pencil);
      const v = inp.value.trim() || null;
      if (!save || v === (info?.title ?? null)) return;
      setTitle(v);
      try { await rpc('session.rename', { id: current, title: v }); } catch { setTitle(info?.title); } // 확정은 session.changed 가 준다
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void finish(true); } else if (e.key === 'Escape') void finish(false); });
    inp.addEventListener('blur', () => void finish(true));
  }
  const pencil = iconBtn('pencil', '이름 바꾸기', editName);
  title.addEventListener('dblclick', editName);
  nameRow.append(pencil);
  sendBtn.append(icon('up')); addBtn.append(icon('plus')); stopBtn.append(icon('stop')); modelBtn.append(icon('chevron')); effortBtn.append(icon('chevron')); modeBtn.append(icon('chevron'));
  // 보낼 게 없거나(빈 입력·첨부 없음) 세션이 끝났으면 보내기 버튼을 비활성처럼 (사용자 2026-09-27)
  // 실행 중엔 보내기 자리에 중단 (사용자 2026-10-09) — 입력이나 첨부가 생기면 다시 보내기, 작업 중에도 보낼 수 있으므로
  const canSend = () => {
    const empty = !input.value.trim() && !pendingFiles.length;
    sendBtn.disabled = !current || input.disabled || empty;
    const stop = busyNow && empty;
    stopBtn.style.display = stop ? '' : 'none'; sendBtn.style.display = stop ? 'none' : '';
  };
  // 클립보드 API 는 https·localhost 에서만 있고 iframe 은 clipboard-write 권한도 필요하다 — 없으면 execCommand 로 (http://IP 로 열 때, 2026-09-27)
  async function copyText(text) {
    try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; } } catch {}
    const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
    try { return document.execCommand('copy'); } finally { ta.remove(); }
  }
  const copyOf = (text) => async (e) => { const b = e.currentTarget; const ok = await copyText(text); b.replaceChildren(ok ? icon('check') : '✗'); setTimeout(() => b.replaceChildren(icon('copy')), 1200); };
  function rewindBtn(seq, text) {
    const row = acts(iconBtn('copy', '복사', copyOf(text)), iconBtn('rewind', '이 턴부터 되돌리기', () => ask()));
    function ask() {
      const orig = [...row.children]; // 취소는 원래 버튼을 되돌린다 — 새 줄의 버튼을 옮겨 오면 그 버튼은 떨어진 줄을 고쳐 먹통이 된다
      const go = (conversation, files) => rpc('session.rewind', { id: current, seq, conversation, files }).then(() => { if (conversation) { input.value = text; input.oninput(); input.focus(); } }).catch((e) => push(h('div', { class: 'meta err' }, e.message)));
      row.replaceChildren(h('span', { class: 'q' }, '이 턴부터 되돌리기:'),
        h('button', { class: 'ghost', onclick: () => go(true, false) }, '답변만'), h('button', { class: 'ghost', onclick: () => go(false, true) }, '코드만'),
        h('button', { class: 'ghost', onclick: () => go(true, true) }, '둘 다'), h('button', { class: 'ghost', onclick: () => row.replaceChildren(...orig) }, '취소'));
    }
    return row;
  }
  // 우편 턴 — 내부적으로는 사용자 턴이지만 화면은 사용자 말풍선이 아니라 왼쪽의 봉투 카드 (프로토타입, 사용자 2026-09-27).
  // 본문은 src/mail.ts formatMail 이 만든 꼴 (MAIL_HEAD 는 그 정규식의 사본): "[mail <id> from <세션 id> (<제목>) at <iso> kind=<kind> re=<id>]\n답장: …\n<본문>" 을 빈 줄로 이은 것
  const MAIL_HEAD = /^\[mail (\S+) from (\S+)(?: \((.*?)\))? at (\S+) kind=(\S+)(?: re=(\S+))?\]\n(?:답장: [^\n]*\n)?/;
  function mailCard(text, seq) {
    const parts = text.split(/\n\n(?=\[mail )/).map((chunk) => { const m = chunk.match(MAIL_HEAD); return m ? { id: m[1], from: m[3] || m[2], at: m[4], kind: m[5], body: chunk.slice(m[0].length) } : { id: '', from: '?', at: '', kind: 'message', body: chunk }; });
    const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    return h('div', { class: 'mail' }, ...parts.map((m) => h('div', { class: 'envelope' },
      h('div', { class: 'head' }, icon('mail'), h('span', { class: 'from' }, m.from), m.kind !== 'message' ? h('span', { class: 'kind' }, m.kind) : null, h('span', { class: 'at' }, when(m.at))),
      h('div', { class: 'body' }, m.body))), rewindBtn(seq, text));
  }
  function setState(state) {
    pill.className = `pill ${state}`; pill.textContent = STATE_LABEL[state] ?? state;
    busyNow = state === 'running' || state === 'requires_action';
    showBusy(state === 'running');
    input.disabled = state === 'exited'; canSend();
    if (opts.onState) opts.onState(state);
    renderSide();
  }

  function render(e, live = false) {
    if (!replaying) { if (e.seq <= lastSeq) return; lastSeq = e.seq; }
    if (live && e.at) skew = Date.now() - e.at;
    curSeq = e.seq;
    const ev = e.ev;
    switch (ev.kind) {
      case 'turn.start': if (!replaying) busySince = e.at || Date.now(); setBusy('작업 중');
        endText();
        if (ev.origin === 'mail') { push(mailCard(ev.text, e.seq)); break; }
        push(h('div', { class: 'user' }, h('div', { class: 'bubble' }, ev.origin ? h('span', { class: 'origin' }, ev.origin) : null,
          ev.attachments?.length ? h('div', { class: 'chips' }, ...ev.attachments.map((a) => { const local = sentFiles.get(a.name); return h('span', { class: 'chip' }, local ? h('img', { src: local }) : null, a.name); })) : null,
          ev.text), rewindBtn(e.seq, ev.text)));
        break;
      case 'text.delta': {
        const sc = scopeOf(ev.parent);
        if (!ev.parent) setBusy('작성 중');
        if (!sc.textEl) { sc.textEl = push(h('div', { class: 'assistant streaming' }), sc); sc.textBuf = ''; }
        sc.textBuf += ev.text;
        const stick = atBottom();
        sc.textEl.innerHTML = renderMarkdown(sc.textBuf);
        if (stick) feed.scrollTop = feed.scrollHeight;
        break;
      }
      case 'thinking.delta': {
        if (!ev.parent) setBusy('생각 중');
        // 접힌 상태에선 summary 에 본문 첫 줄이 … 로 잘려 보이고, 펼치면 '생각' 라벨 + 전문 (사용자 2026-09-27)
        const sc = scopeOf(ev.parent);
        if (!sc.thinkEl) { const t = h('div', { class: 't' }); const pre = h('span', { class: 'pre' }); sc.thinkEl = push(h('details', { class: 'thinking chev' }, h('summary', {}, pre), t), sc); sc.thinkEl._t = t; sc.thinkEl._pre = pre; sc.thinkBuf = ''; }
        sc.thinkBuf += ev.text; sc.thinkEl._t.textContent = sc.thinkBuf; sc.thinkEl._pre.textContent = sc.thinkBuf.trimStart().split('\n')[0];
        break;
      }
      case 'tool.start': {
        const sc = scopeOf(ev.parent);
        if (!ev.parent) setBusy(ev.name === 'Agent' ? '에이전트 실행 중' : `${ev.name} 실행 중`);
        endText(sc);
        const detail = h('div', { class: 'detail' }, h('div', { class: 'lbl' }, '입력'), h('pre', {}, JSON.stringify(ev.input, null, 2)));
        const d = push(h('details', { class: 'tool running' }, h('summary', {}, h('span', { class: 'dot' }), h('span', { class: 'name' }, ev.name), h('span', { class: 'arg' }, toolArg(ev.name, ev.input))), detail), sc);
        d._detail = detail; tools.set(ev.toolUseId, d);
        if (ev.parent) toolParent.set(ev.toolUseId, ev.parent);
        break;
      }
      case 'task': {
        // 서브에이전트 작업 — 띄운 Agent 도구 카드 안에 상태 줄 + 중첩 피드. 도구 카드가 없으면(백그라운드 등) 독립 카드
        let d = ev.toolUseId && tools.get(ev.toolUseId);
        if (!d) {
          const detail = h('div', { class: 'detail' });
          d = push(h('details', { class: 'tool running' }, h('summary', {}, h('span', { class: 'dot' }), h('span', { class: 'name' }, ev.agentType ?? 'task'), h('span', { class: 'arg' }, ev.description)), detail));
          d._detail = detail; if (ev.toolUseId) tools.set(ev.toolUseId, d);
        }
        if (ev.toolUseId) scopeOf(ev.toolUseId); else if (!d._task) { d._task = h('div', { class: 'tstat' }); d._detail.append(d._task); }
        const u = ev.usage;
        if (ev.agentType) d._agent = ev.agentType; // ended 알림엔 종류·설명이 비어 온다 (2026-09-30 실측)
        const stat = [d._agent, ev.background ? '백그라운드' : null, u ? `${fmtTok(u.tokens)} · 도구 ${u.toolUses} · ${(u.durationMs / 1000).toFixed(0)}s` : null, ev.phase === 'progress' ? ev.lastTool : null].filter(Boolean).join(' · ');
        d._task.replaceChildren(h('span', { class: 'dim' }, stat), ...(ev.summary ? [h('div', { class: 'sum' }, ev.summary)] : [])); // replaceChildren 은 null 을 글자로 넣는다 (B 워커 지적 2026-09-30)
        if (ev.phase === 'ended') { const sc = ev.toolUseId && subs.get(ev.toolUseId); if (sc) endText(sc); tasks.delete(ev.taskId); }
        else { const prev = tasks.get(ev.taskId)?.ev; tasks.set(ev.taskId, { card: d, ev: { ...prev, ...ev, agentType: d._agent ?? null, description: prev?.description || ev.description, summary: ev.summary ?? (ev.phase === 'progress' ? ev.description : null) } }); } // progress 의 description 은 지금 하는 일 — 요약 자리에
        if (!replaying) renderSide();
        break;
      }
      case 'tool.end': {
        const d = tools.get(ev.toolUseId);
        if (!ev.parent) setBusy('작업 중');
        if (d) { d.classList.remove('running'); d.classList.add(ev.ok ? 'ok' : 'err'); d._detail.append(h('div', { class: 'lbl' }, ev.ok ? '결과' : '오류'), h('pre', {}, ev.summary || '—')); }
        break;
      }
      case 'approval.requested': endText(); renderCard(ev); break;
      case 'approval.resolved': resolveCard(ev.requestId, ev.decision); break;
      case 'turn.end': {
        endText();
        if (!replaying) { tally(ev); loadStatus(); }
        const parts = [];
        if (ev.interrupted) parts.push('중단됨'); else if (!ev.ok) parts.push(`오류: ${ev.error}`);
        if (ev.durationMs != null) parts.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
        if (ev.usage) parts.push(`↑${fmtTok(ev.usage.input + ev.usage.cacheRead + ev.usage.cacheWrite)} ↓${fmtTok(ev.usage.output)}`);
        push(h('div', { class: `meta${ev.ok ? '' : ' err'}` }, parts.join(' · ')));
        if (!replaying) renderSide();
        break;
      }
      case 'session.state': setState(ev.state); break;
      case 'session.ready': ready = ev; renderMode(); renderSide(); break;
      case 'session.imported': push(h('div', { class: 'notice' }, `${ev.vendor} ${ev.fork ? `세션 ${ev.vendorSessionId.slice(0, 8)} 에서 복제한` : '에서 가져온'} 세션 · 이전 대화는 ${ev.vendor} 기록에만 있다`)); break;
      case 'context.compacted': endText(); push(h('div', { class: 'notice' }, `컨텍스트 압축${ev.preTokens ? ` · ${fmtTok(ev.preTokens)}` : ''}`)); break;
      case 'hook': if (!replaying) { hooks++; lastHook = `${ev.event} ${ev.phase}`; } break;
      case 'error': endText(); push(h('div', { class: 'meta err' }, ev.message)); break;
      case 'review': {
        endText();
        const what = [`AI 검토 ${REVIEW[ev.decision] ?? ev.decision}`, ev.risk && `위험 ${RISK[ev.risk] ?? ev.risk}`, ev.action, ev.rationale].filter(Boolean).join(' · ');
        push(h('div', { class: ev.decision === 'approved' ? 'notice' : 'meta err' }, what));
        break;
      }
      case 'session.exit': endText(); push(h('div', { class: 'meta' }, `세션 종료: ${ev.reason}`)); break;
      case 'turn.rewound': {
        endText();
        for (const n of [...col.children, ...(replaying ? [] : older.children)]) if (Number(n.dataset.seq) >= ev.seq) n.remove();
        if (!replaying) backlog = backlog.filter((b) => b.seq < ev.seq);
        for (const [k, sc] of subs) if (!sc.col.isConnected) subs.delete(k);
        for (const [k, t] of tasks) if (!t.card.isConnected) tasks.delete(k);
        // 답변 되돌리기는 화면에서 보이므로 안내가 없다. 파일 되돌리기만 결과를 남긴다 (사용자 2026-09-30)
        if (ev.files) push(h('div', { class: 'notice' }, `되돌림 · 파일${ev.filesChanged?.length ? ` ${ev.filesChanged.length}개` : ''}`));
        break;
      }
    }
  }

  // ---- 승인·질문 카드
  function renderCard(req) {
    if (cards.has(req.requestId)) return cards.get(req.requestId);
    const isQ = req.name === 'AskUserQuestion';
    // 서브에이전트가 낸 요청이면 어느 에이전트인지 — SDK 승인 콜백엔 부모가 없어 앞선 tool.start 의 parent 로 맞춘다 (2026-09-30)
    const parentCard = req.toolUseId && toolParent.has(req.toolUseId) ? tools.get(toolParent.get(req.toolUseId)) : null;
    const from = parentCard ? h('span', { class: 'from' }, `${parentCard._agent ?? 'Agent'} 서브에이전트`) : null;
    const card = h('div', { class: isQ ? 'card ask' : 'card' }, h('div', { class: 'head' }, h('span', { class: 'kind' }, isQ ? '질문' : '승인'), h('span', {}, isQ ? '' : req.name), from));
    if (isQ) buildQuestion(card, req); else buildApproval(card, req);
    cards.set(req.requestId, card);
    const mark = push(h('div', { class: `mark pending${isQ ? ' ask' : ''}`, onclick: () => showDock(card) }, h('span', { class: 'kind' }, isQ ? '질문' : '승인'), h('span', { class: 'what' }, `${parentCard ? `${parentCard._agent ?? 'Agent'} · ` : ''}${isQ ? `${req.input?.questions?.length ?? 1}개` : `${req.name} ${toolArg(req.name, req.input)}`}`), h('span', { class: 'res' })));
    card._mark = mark;
    if (replaying) return card;
    showDock();
    if (opts.onApproval) opts.onApproval(req);
    renderSide();
    return card;
  }
  /** 입력창 자리에 대기 카드 하나를 올린다 — 지정한 카드 또는 가장 오래된 대기. 대기가 없으면 입력창으로 돌아간다 */
  function showDock(card) {
    const next = card && !card.classList.contains('resolved') ? card : [...cards.values()].find((c) => !c.classList.contains('resolved'));
    const hadFocus = document.activeElement === input || document.activeElement === document.body || dock.contains(document.activeElement);
    dock.replaceChildren(next ?? '');
    composer.hidden = !!next;
    if (next) { next.classList.add('live'); if (hadFocus) next.focus({ preventScroll: true }); }
    else if (hadFocus) input.focus();
  }
  function buildApproval(card, req) {
    const arg = toolArg(req.name, req.input);
    if (arg) card.append(h('pre', {}, arg));
    if (!(req.input && typeof req.input === 'object' && Object.keys(req.input).length === 1 && arg)) card.append(h('details', { class: 'chev in' }, h('summary', {}, '입력'), h('pre', {}, JSON.stringify(req.input, null, 2))));
    const decide = (decision, remember) => rpc('session.approve', { id: current, requestId: req.requestId, decision, remember });
    card.tabIndex = 0;
    card.onkeydown = (e) => { if (e.target !== card) return; if (e.key === 'Enter') { e.preventDefault(); decide('allow', e.shiftKey); } else if (e.key === 'Escape') { e.preventDefault(); decide('deny', false); } };
    card.append(h('div', { class: 'btns' },
      h('button', { class: 'primary', title: 'Enter', onclick: () => decide('allow', false) }, '허용'),
      h('button', { title: 'Shift+Enter', onclick: () => decide('allow', true) }, '세션 동안 허용'),
      h('button', { class: 'danger', title: 'Esc', onclick: () => decide('deny', false) }, '거절'),
    ));
  }
  // 질문 카드 — Claude Code TUI 를 따른다 (사용자 2026-09-28): 질문마다 탭, 마지막 탭은 제출(답변 검토), '채팅으로 답하기' 는 아래 구분선 밑에 따로.
  // 질문이 하나면 탭 없이 헤더 칩만, 단일 선택은 고르는 즉시 제출.
  function buildQuestion(card, req) {
    const qs = req.input?.questions ?? [];
    const state = qs.map(() => ({ picked: new Set(), other: '', cur: 0 }));
    const answerOf = (qi) => { const a = [...state[qi].picked]; if (state[qi].other.trim()) a.push(state[qi].other.trim()); return a; };
    const multi = qs.length > 1;
    let tab = 0; // 0..qs.length-1 질문, qs.length = 제출
    const done = () => { card.classList.remove('live'); };
    const send = () => {
      const answers = {};
      qs.forEach((q, qi) => { answers[q.question] = answerOf(qi).join(', '); });
      rpc('session.approve', { id: current, requestId: req.requestId, decision: 'allow', updatedInput: { ...req.input, answers } }); done();
    };
    // 'Chat about this' — Claude Code 와 같은 피드백으로 deny 한다 (cli 2.1.283 nYe): 모델이 무엇을 명확히 할지 먼저 묻고 기다린다
    const dismiss = () => {
      const asked = qs.map((q, qi) => `- "${q.question}"\n  ${answerOf(qi).length ? `Answer: ${answerOf(qi).join(', ')}` : '(No answer provided)'}`).join('\n');
      const message = `The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n${asked}`;
      rpc('session.approve', { id: current, requestId: req.requestId, decision: 'deny', message }); done();
    };
    const strip = h('div', { class: 'tabs' });
    const panel = h('div', { class: 'panel' });
    const show = (i) => { tab = Math.max(0, Math.min(i, multi ? qs.length : 0)); draw(); };
    let items = []; // 현재 패널에서 ↑↓ 로 오가는 것들 — 선택지 label 들 + 직접 입력
    function draw() {
      strip.innerHTML = '';
      if (multi) {
        qs.forEach((q, qi) => strip.append(h('button', { class: `tab${tab === qi ? ' on' : ''}${answerOf(qi).length ? ' done' : ''}`, tabindex: -1, onclick: () => show(qi) }, h('i'), q.header || `질문 ${qi + 1}`)));
        strip.append(h('button', { class: `tab submit${tab === qs.length ? ' on' : ''}`, tabindex: -1, onclick: () => show(qs.length) }, '제출'));
      } else if (qs[0]?.header) strip.append(h('span', { class: 'tab on' }, qs[0].header));
      panel.innerHTML = '';
      if (tab < qs.length) panel.append(questionPane(tab)); else { items = []; panel.append(reviewPane()); }
      if (document.activeElement !== card && !panel.contains(document.activeElement)) card.focus({ preventScroll: true });
    }
    const mark = (qi) => items.forEach((el, i) => el.classList.toggle('cur', i === state[qi].cur));
    function questionPane(qi) {
      const q = qs[qi], st = state[qi];
      const name = `q${req.requestId}-${qi}`;
      const opts = (q.options ?? []).map((o) => {
        const inp = h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name, value: o.label, tabindex: -1, checked: st.picked.has(o.label) ? '' : null });
        inp.onchange = () => {
          if (q.multiSelect) { if (inp.checked) st.picked.add(o.label); else st.picked.delete(o.label); }
          else { st.picked = new Set([o.label]); if (!multi) return send(); show(qi + 1); }
        };
        return h('label', {}, inp, h('span', {}, h('div', {}, o.label), o.description ? h('div', { class: 'd' }, o.description) : null));
      });
      const other = h('input', { type: 'text', placeholder: '직접 입력', value: st.other });
      other.oninput = () => { st.other = other.value; };
      other.onkeydown = (e) => {
        if (e.key === 'Escape' || (e.key === 'ArrowUp' && !other.value)) { e.preventDefault(); card.focus(); }
        else if (e.key === 'Enter' && other.value.trim()) { e.preventDefault(); if (!multi) send(); else show(qi + 1); }
      };
      other.onfocus = () => { st.cur = opts.length; mark(qi); };
      items = [...opts, other]; mark(qi);
      const pane = h('div', { class: 'q' }, h('div', { class: 'qt' }, q.question), ...opts, other);
      if (!multi && q.multiSelect) pane.append(h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => { if (answerOf(0).length) send(); } }, '답변')));
      else if (!multi) pane.append(h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => { if (other.value.trim()) send(); } }, '답변')));
      else if (q.multiSelect) pane.append(h('div', { class: 'btns' }, h('button', { onclick: () => show(qi + 1) }, '다음')));
      return pane;
    }
    function reviewPane() {
      const missing = qs.filter((_, qi) => !answerOf(qi).length).length;
      return h('div', { class: 'review' },
        h('div', { class: 'qt' }, '답변 검토'),
        missing ? h('div', { class: 'warn' }, `답하지 않은 질문 ${missing}개`) : null,
        h('ul', {}, ...qs.map((q, qi) => h('li', {}, h('div', {}, q.question), h('div', { class: answerOf(qi).length ? 'a' : 'a none' }, answerOf(qi).join(', ') || '—')))),
        h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: send }, '제출'), h('button', { onclick: () => show(0) }, '처음')),
      );
    }
    // 키보드 — 카드 자체에 포커스가 있을 때: ←→ 탭, ↑↓ 선택지, Enter 고르기·제출, Esc 채팅으로 (TUI 와 같게)
    card.tabIndex = 0; card.classList.add('live');
    card.onkeydown = (e) => {
      if (e.target !== card) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') { if (multi) show(tab + (k === 'ArrowRight' ? 1 : -1)); }
      else if (k === 'ArrowUp' || k === 'ArrowDown') { if (tab < qs.length && items.length) { const st = state[tab]; st.cur = Math.max(0, Math.min(items.length - 1, st.cur + (k === 'ArrowDown' ? 1 : -1))); mark(tab); items[st.cur].scrollIntoView({ block: 'nearest' }); } }
      else if (k === 'Enter') { if (tab >= qs.length) return void send(); const el = items[state[tab].cur]; if (!el) return; if (el.tagName === 'LABEL') { const inp = el.querySelector('input'); if (inp.type === 'checkbox') inp.checked = !inp.checked; else inp.checked = true; inp.dispatchEvent(new Event('change')); } else el.focus(); }
      else if (k === 'Escape') dismiss();
      else if (k === 'Tab') return; // 브라우저 기본 포커스 이동
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { const el = items[items.length - 1]; if (el?.tagName === 'INPUT') { el.focus(); return; } } // 글자를 치면 직접 입력으로
      else return;
      e.preventDefault();
    };
    draw();
    card.append(strip, panel, h('div', { class: 'chat' }, h('button', { class: 'ghost', tabindex: -1, onclick: dismiss }, '채팅으로 답하기')));
  }
  function resolveCard(requestId, decision) {
    const card = cards.get(requestId);
    if (!card) return;
    card.classList.add('resolved'); card.classList.remove('live'); card.removeAttribute('tabindex');
    card.querySelector('.btns')?.remove();
    card.querySelectorAll('input').forEach((i) => (i.disabled = true));
    const res = (card.classList.contains('ask') ? { allow: '답변함', deny: '채팅으로', cancelled: '취소됨' } : { allow: '허용됨', deny: '거절됨', cancelled: '취소됨' })[decision] ?? decision;
    if (card._mark) { card._mark.classList.remove('pending'); card._mark.classList.add(decision); card._mark.querySelector('.res').textContent = res; card._mark.onclick = null; }
    if (dock.contains(card)) showDock();
    renderSide();
  }

  // ---- 사이드바 — 맨 위는 늘 보이는 요약(폴더·브랜치·리밋·비용), 아래는 섹션마다 접히는 카드로 기본 접힘. 다시 그려도 접힘은 남긴다 (사용자 2026-09-28 A안, 2026-09-29 기본 접힘)
  const folded = new Set(['session', 'pending', 'usage', 'loaded', 'hooks']);
  const fmtReset = (iso) => { // 남은 기간 — claude 상태줄과 같은 꼴 (55m · 4h55m · 2d10h)
    if (!iso) return '';
    const m = Math.max(0, Math.round((new Date(iso) - Date.now()) / 6e4));
    return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(m / 1440)}d${Math.floor((m % 1440) / 60)}h`;
  };
  function renderSide() {
    side.innerHTML = '';
    const lim = (label, w) => h('div', { class: 'lim' + (w?.pct >= 90 ? ' hot' : '') }, h('span', { class: 'k' }, label),
      h('div', { class: 'bar' }, h('i', { style: `width:${Math.min(100, w?.pct ?? 0)}%` })),
      h('span', { class: 'v' }, w?.pct != null ? `${Math.round(w.pct)}%` : '—'), h('span', { class: 'r' }, fmtReset(w?.resetsAt)));
    // claude 상태줄과 같은 줄거리: 📁폴더 · 🌿repo(브랜치) · ⌛5h·1w · 📦context · 💻모델 · 비용. 값은 SDK 가 주는 때(attach·turn.end)만 갱신 (사용자 2026-09-30)
    const cwd = info?.cwd ?? ready?.cwd ?? '';
    const row = (name, ...kids) => h('div', { class: 'row' }, icon(name), ...kids);
    const ctx = status?.context;
    side.append(h('div', { class: 'top' },
      row('folder', h('span', { class: 'name', title: cwd }, cwd ? cwd.split('/').filter(Boolean).pop() ?? cwd : '—'), cwd ? iconBtn('copy', '전체 경로 복사', copyOf(cwd)) : ''),
      row('branch', status?.repo ? h('span', { class: 'name' }, status.repo, status.branch ? h('span', { class: 'dim' }, ` (${status.branch})`) : '') : h('span', { class: 'dim' }, '—')),
      row('hourglass', h('div', { class: 'lims' }, lim('5h', status?.limits?.fiveHour), lim('1w', status?.limits?.sevenDay))),
      row('box', h('span', { title: ctx ? `${fmtTok(ctx.tokens)} / ${fmtTok(ctx.max)}` : null }, 'context ', h('b', { class: ctx?.pct >= 80 ? 'hot' : '' }, ctx ? `${Math.round(ctx.pct)}%` : '—'))),
      row('cpu', h('span', {}, modelLbl.textContent || ready?.model || '—'), h('span', { class: 'cost' }, usage.turns && !costKnown ? '—' : usage.cost ? `$${usage.cost.toFixed(2)}` : '$0')), // 턴이 있는데 비용을 모르면(가격표에 없는 Codex 모델) —
    ));
    const kv = (rows) => h('div', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('span', { class: 'k' }, k), h('span', { class: 'v' }, v ?? '—')]));
    const sec = (key, label, body, extra) => {
      const d = h('details', { class: 'sec', open: folded.has(key) ? null : '' }, h('summary', {}, h('h4', {}, label), extra ?? '', icon('chevron')), h('div', { class: 'body' }, body));
      d.addEventListener('toggle', () => { if (d.open) folded.delete(key); else folded.add(key); });
      return d;
    };
    if (tasks.size) side.append(h('div', { class: 'tasks' }, h('h4', {}, `에이전트 ${tasks.size}`), ...[...tasks.values()].map(({ card, ev }) => {
      const u = ev.usage;
      return h('a', { onclick: () => { card.open = true; card.scrollIntoView({ block: 'center' }); } },
        h('span', { class: 'dot' }), h('span', { class: 'name' }, ev.agentType ?? 'task'), h('span', { class: 'desc' }, ev.description),
        h('span', { class: 'dim' }, [u ? `${(u.durationMs / 1000).toFixed(0)}s · ${fmtTok(u.tokens)}` : null, ev.lastTool].filter(Boolean).join(' · ')),
        ev.summary ? h('span', { class: 'sum' }, ev.summary) : null);
    })));
    side.append(sec('session', '세션', kv([
      ['상태', STATE_LABEL[info?.state] ?? ''], ['id', current ? h('span', { class: 'idv' }, current, iconBtn('copy', '세션 id 복사', copyOf(current))) : null],['벤더 세션', info?.vendorSessionId ?? ready?.vendorSessionId], ['권한 모드', ready?.permissionMode ?? info?.permissionMode],
      ['연결', connected ? '연결됨' : '끊김'], ['raw', info?.raw ? '켬' : '끔'],
    ])));
    const pend = [...cards.entries()].filter(([, c]) => !c.classList.contains('resolved'));
    side.append(sec('pending', '대기 중', pend.length
      ? h('div', { class: 'pend' }, ...pend.map(([, c]) => h('a', { onclick: () => showDock(c) }, `${c._mark.querySelector('.kind').textContent} · ${c._mark.querySelector('.what').textContent}`)))
      : h('div', { class: 'empty' }, '없음'), pend.length ? h('span', { class: 'badge' }, String(pend.length)) : ''));
    side.append(sec('usage', '사용량', kv([
      ['턴', String(usage.turns)], ['입력', fmtTok(usage.input)], ['캐시 읽기', fmtTok(usage.cacheRead)], ['캐시 쓰기', fmtTok(usage.cacheWrite)], ['출력', fmtTok(usage.output)],
    ])));
    const list = (key, label, items, f = (x) => x) => {
      const d = h('details', { class: 'list', open: folded.has(`+${key}`) ? '' : null }, h('summary', {}, label, h('span', { class: 'n' }, String(items.length))), h('ul', {}, ...items.map((x) => h('li', {}, f(x)))));
      d.addEventListener('toggle', () => { if (d.open) folded.add(`+${key}`); else folded.delete(`+${key}`); }); // 목록은 기본 접힘
      return d;
    };
    side.append(sec('loaded', '로드됨', ready
      ? h('div', {}, list('tools', '도구', ready.tools), list('skills', '스킬', ready.skills), list('plugins', '플러그인', ready.plugins, (p) => p.name), list('mcp', 'MCP', ready.mcp, (m) => `${m.name} (${m.status})`), list('slash', '슬래시 명령', ready.slashCommands), list('agents', '에이전트', ready.agents))
      : h('div', { class: 'empty' }, '첫 턴 뒤')));
    side.append(sec('hooks', '훅', kv([['실행', String(hooks)], ['마지막', lastHook || '—']])));
  }

  // ---- 이력: 마지막 몇 턴만 먼저 그리고, 위로 올리면 앞 턴을 붙인다 (사용자 2026-10-04, 이력 2759건에 1.2s)
  // 옛 턴은 화면만 만든다 — 사용량·훅·상태는 미리 센다. 연속된 delta 는 한 조각으로 합친다 (조각마다 마크다운 전체를 다시 그렸다)
  const CHUNK = 300; // ponytail: 이벤트 수로 자른다, 턴 하나가 아주 길면 그 턴은 통째로
  let backlog = [];
  // 끝에서 CHUNK 개 안의 가장 앞 자름 지점, 없으면 그 너머의 첫 지점, 그것도 없으면 전부
  function pickCut(a) {
    let cut = 0;
    for (let i = a.length - 1, n = 0; i >= 0; i--, n++) { if (cuts.has(a[i].seq)) cut = i; if (n >= CHUNK && cut) break; }
    return cut;
  }
  const cuts = new Set(); // 자를 수 있는 turn.start 의 seq — 열린 도구·승인·서브에이전트가 없을 때만 (작업 중에 보낸 메시지는 앞 턴 카드를 이어 쓴다)
  function replayHistory(history) {
    const evs = [];
    for (const e of history) {
      const k = e.ev.kind, last = evs[evs.length - 1];
      // 되돌린 턴은 미리 뺀다. 끝 이벤트는 화면을 안 만들고 앞 카드를 갱신하므로 남긴다 (되살아난 승인 카드가 대기로 남았다)
      if (k === 'turn.rewound') { const keep = evs.filter((x) => x.seq < e.ev.seq || x.ev.kind === 'tool.end' || x.ev.kind === 'approval.resolved'); evs.length = 0; evs.push(...keep); }
      if ((k === 'text.delta' || k === 'thinking.delta') && last?.ev.kind === k && last.ev.parent === e.ev.parent) { evs[evs.length - 1] = { ...e, ev: { ...e.ev, text: last.ev.text + e.ev.text } }; continue; }
      evs.push(e);
    }
    const open = new Set();
    for (const { seq, ev } of evs) {
      if (ev.kind === 'turn.start' && !open.size) cuts.add(seq);
      else if (ev.kind === 'tool.start') open.add(ev.toolUseId);
      else if (ev.kind === 'tool.end') open.delete(ev.toolUseId);
      else if (ev.kind === 'approval.requested') open.add(ev.requestId);
      else if (ev.kind === 'approval.resolved') open.delete(ev.requestId);
      else if (ev.kind === 'task') open[ev.phase === 'ended' ? 'delete' : 'add'](ev.taskId);
    }
    const cut = lastSeq ? 0 : pickCut(evs); // 재접속(since)이면 새 것만 오므로 전부 그린다
    backlog = backlog.concat(evs.slice(0, cut));
    const shown = new Set(evs.slice(cut).map((e) => e.seq)); // 되돌려져 안 그리는 턴도 사용량엔 든다
    for (const e of history) {
      if (shown.has(e.seq)) continue;
      if (e.ev.kind === 'turn.end') tally(e.ev);
      else if (e.ev.kind === 'hook') { hooks++; lastHook = `${e.ev.event} ${e.ev.phase}`; }
      else if (e.ev.kind === 'session.ready') { ready = e.ev; }
    }
    for (const e of evs.slice(cut)) render(e);
    lastSeq = Math.max(lastSeq, history.at(-1)?.seq ?? 0);
    if (follow) jump(feed.scrollHeight);
    rearm();
  }
  // 위치 잡기는 즉시 — smooth 애니메이션 도중의 onscroll 이 follow 를 끈다 (로드 직후 보낸 답이 바닥을 안 따라갔다)
  const jump = (y) => feed.scrollTo({ top: y, behavior: 'instant' });
  function loadOlder() {
    if (!backlog.length) return;
    const cut = pickCut(backlog);
    const evs = backlog.slice(cut); backlog = backlog.slice(0, cut);
    const box = h('div'), saved = main, h0 = feed.scrollHeight;
    replaying = true; col = box; main = { col: null, textEl: null, textBuf: '', thinkEl: null, thinkBuf: '' };
    try { for (const e of evs) if (!['session.state', 'session.ready', 'hook'].includes(e.ev.kind)) render(e); endText(); }
    finally { replaying = false; col = liveCol; main = saved; }
    older.prepend(...box.children);
    jump(feed.scrollTop + feed.scrollHeight - h0); // 보던 자리 유지
    renderSide(); rearm();
  }
  // 맨 위 표지가 보이면 앞 턴을 붙인다. 붙인 뒤에도 계속 보이면 교차 상태가 안 바뀌어 콜백이 없으므로 다시 건다
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) requestAnimationFrame(loadOlder); }, { root: feed, rootMargin: '600px 0px 0px 0px' });
  const rearm = () => { io.unobserve(sentinel); if (backlog.length) io.observe(sentinel); };

  // ---- attach · 재접속
  async function attach(id) {
    current = id; renderSide();
    let r;
    try { r = await rpc('session.attach', { id, since: lastSeq }); }
    catch (e) {
      if (e.code === 'not_live') { push(h('div', { class: 'notice' }, '세션 복원')); await rpc('session.create', { id }); r = await rpc('session.attach', { id, since: lastSeq }); }
      else if (e.code === 'no_session') { push(h('div', { class: 'meta err' }, `세션 없음: ${id}`)); setState('exited'); return; }
      else throw e;
    }
    info = r.info; setTitle(info.title);
    if (r.draft && !input.value) { input.value = r.draft; input.oninput(); } // 다시 로드된 화면 — 쓰던 글을 되살린다 (치던 중이면 그대로)
    replayHistory(r.history);
    for (const p of r.pending) renderCard(p);
    setState(info.state);
    loadModels(); loadStatus(); loadCommands(); renderMode();
    if (opts.onAttach) opts.onAttach(id, info);
  }
  transport.onEvent((m) => {
    if (m.event === 'session.event' && m.params.id === current) render(m.params, true);
    else if (m.event === 'session.changed' && m.params.id === current) { info = m.params; setTitle(info.title); renderMode(); renderSide(); }
    else if (m.event === 'session.closed' && m.params.id === current) { /* session.exit 이벤트가 이미 그렸다 */ }
  });
  transport.onStatus(async (s) => {
    connected = s.connected;
    if (s.connected) {
      try {
        const id = opts.sessionId ?? current ?? (await rpc('server.info')).session;
        await attach(id);
      } catch (e) { push(h('div', { class: 'meta err' }, e.message)); }
    }
    else {
      pill.className = 'pill disconnected'; pill.textContent = s.fatal ? `인증 실패` : STATE_LABEL.disconnected; renderSide();
      // 좁은 화면에선 알약이 숨으므로 피드에도 남긴다 (사용자 2026-10-09). fatal 은 재접속하지 않아 한 번만 온다
      if (s.fatal) push(h('div', { class: 'meta err' }, '인증 실패: 토큰(?token=)이 붙은 주소로 다시 여세요'));
    }
  });

  // 벤더 목록은 프로세스 시작 때 한 번 고정된다. 때때로 버전 없는 5개짜리 축약 목록이 온다 (SDK 0.3.282 실측, 원인 미상) — 그 꼴도 그대로 보인다
  async function loadModels() {
    // 옛 core(재기동 전) 는 session.models 가 없어 에러가 온다 — 빈 알약을 남기지 말고 숨긴다 (2026-09-27 실측)
    let r; try { r = await rpc('session.models', { id: current }); } catch { modelBtn.style.display = 'none'; return; }
    // 세션 모델이 [1m](1M 컨텍스트) 변형이면 CLI 가 버전 없는 5개 목록(Fable / Sonnet / Opus (1M context) …)을 준다 (2026-09-27 실측).
    // 표시 이름에 숫자가 없으면 모델 id 에서 버전을 뽑아 첫 단어 뒤에 붙인다: claude-fable-5-1 → Fable 5.1, claude-haiku-4-5-20251001 → Haiku 4.5
    const base = (v) => (v ?? '').replace(/\[.*\]$/, '');
    for (const m of r.models) {
      if (m.value === 'default' || /\d/.test(m.displayName.replace(/\(.*?\)/g, ''))) continue; // 괄호 안 '1M' 은 버전이 아니다
      const nums = base(m.resolvedModel).split('-').filter((p) => /^\d+$/.test(p) && p.length < 8);
      if (nums.length) m.displayName = m.displayName.replace(/^(\S+)/, `$1 ${nums.join('.')}`);
    }
    const cur = r.models.find((m) => m.value === r.current) ?? r.models.find((m) => m.value !== 'default' && base(m.resolvedModel) === base(r.current));
    modelLbl.textContent = cur?.displayName ?? r.current ?? '모델'; renderSide(); // 상단 요약의 모델 이름
    modelBtn.style.display = r.models.length ? '' : 'none';
    const efforts = cur?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'];
    effortLbl.textContent = r.effort ?? 'effort';
    effortBtn.style.display = r.models.length ? '' : 'none';
    // ChatGPT 꼴 슬라이더 (사용자 2026-09-27): 위에 단계 이름, 아래 range 한 칸 = 한 단계. 놓으면 session.setEffort
    const idx = Math.max(0, efforts.indexOf(r.effort));
    const lbl = h('div', { class: 'lbl' }, efforts[idx] ?? '');
    const range = h('input', { type: 'range', min: 0, max: efforts.length - 1, step: 1, value: idx, style: `--n:${efforts.length}` });
    const paint = () => { lbl.textContent = efforts[range.value]; range.style.setProperty('--p', `calc(16px + ${range.value / (efforts.length - 1)} * (100% - 32px))`); };
    range.oninput = paint; paint();
    range.onchange = () => { effortLbl.textContent = efforts[range.value]; renderSide(); return rpc('session.setEffort', { id: current, effort: efforts[range.value] }).then(loadModels).catch((e) => push(h('div', { class: 'meta err' }, e.message))); };
    effortMenu.replaceChildren(lbl, h('div', { class: 'track' }, range, ...efforts.map((_, i) => h('i', { style: `left: calc(16px + ${i / (efforts.length - 1)} * (100% - 32px) - 2px)` }))));
    const VER = /-?\b(\d+(?:\.\d+)*)\b/;
    const ver = (m) => { const v = m.displayName.match(VER)?.[1]; return v ? v.split('.').map(Number) : []; };
    const fam = (m) => m.displayName.replace(VER, '').replace(/\s+/g, ' ').trim();
    const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d > 0; } return false; };
    const best = new Map();
    for (const m of r.models) { if (!ver(m).length) continue; const f = fam(m); if (!best.has(f) || newer(ver(m), ver(best.get(f)))) best.set(f, m); }
    const top = r.models.filter((m) => best.get(fam(m)) === m), rest = r.models.filter((m) => !top.includes(m));
    const item = (m) => h('button', { class: 'item', 'aria-checked': String(m === cur), onclick: () => { modelMenu.hidePopover(); modelLbl.textContent = m.displayName; renderSide(); rpc('session.setModel', { id: current, model: m.value }).then(loadModels).catch((e) => push(h('div', { class: 'meta err' }, e.message))); } }, m.displayName);
    const more = h('div', { class: 'more' }, ...rest.map(item));
    modelMenu.replaceChildren(...top.map(item), h('button', { class: 'item toggle', onclick: () => more.classList.toggle('open') }, '더 많은 모델'), more);
  }

  // ---- 작성창
  // 입력 초안은 slcode 서버에 맡긴다 — 카드 iframe 이 다시 로드돼도(연결 끊김·relay 재기동) attach 의 draft 로 돌아온다
  // (ticket slcode-card-periodic-reload, 사용자 2026-10-10). 옛 서버는 메서드가 없어 실패한다 — 무시
  let draftTimer = null;
  function saveDraft(now = false) {
    clearTimeout(draftTimer);
    const go = () => { if (current) rpc('session.setDraft', { id: current, text: input.value }).catch(() => {}); };
    if (now) go(); else draftTimer = setTimeout(go, 300);
  }
  function send() {
    const t = resolveSlash(input.value.trim()); if ((!t && !pendingFiles.length) || !current) return;
    const attachments = pendingFiles.splice(0).map(({ dataUrl, ...a }) => { if (a.mediaType.startsWith('image/')) sentFiles.set(a.name, dataUrl); return a; });
    chips.innerHTML = '';
    input.value = ''; input.style.height = ''; canSend();
    rpc('session.send', { id: current, text: t, ...(attachments.length ? { attachments } : {}) }).catch((e) => push(h('div', { class: 'meta err' }, e.message)));
    saveDraft(true);
    toBottom();
  }
  // 바깥(superlite 카드)이 탭을 다시 보일 때 입력창으로 — focus() 는 직전 커서·선택을 그대로 둔다 (사용자 2026-10-04)
  window.addEventListener('message', (e) => { if (e.data?.type === 'slcode.focus' && !input.disabled) input.focus(); });
  input.onpaste = (e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); addFiles(fs); } };
  el.ondragover = (e) => e.preventDefault();
  el.ondrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); };
  input.onkeydown = (e) => {
    if (slashMenu.matches(':popover-open')) {
      const items = slashItems();
      if (e.key === 'ArrowDown') { e.preventDefault(); slashSel = (slashSel + 1) % items.length; slashDraw(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel + items.length - 1) % items.length; slashDraw(); return; }
      // Enter: 친 것이 전체 이름이거나 유일한 짧은 이름이면 그대로 보낸다, 아니면 고른 항목을 넣는다
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing && resolveSlash(input.value.trim()) === input.value.trim() && !commands.some((c) => c.name.toLowerCase() === input.value.trim().slice(1).toLowerCase()))) { e.preventDefault(); slashPick(items[slashSel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); slashMenu.hidePopover(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (slashMenu.matches(':popover-open')) slashMenu.hidePopover(); send(); } else if (e.key === 'Escape' && !busy.hidden && current) { e.preventDefault(); rpc('session.interrupt', { id: current }); } };
  input.oninput = () => { input.style.height = ''; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; canSend(); slashSel = 0; slashDraw(); saveDraft(); };
  renderSide();
  return { rpc, get sessionId() { return current; } };
}
