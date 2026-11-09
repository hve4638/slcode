// 에이전트 프런트 — 한 프런트 두 모드. 이 파일은 core 프로토콜(protocol.ts)만 알고 superlite 유무를 모른다.
// 웹 모드(index.html, WsTransport)와 superlite 카드 모드(후속 agent-plugin-card)가 같은 mountAgentFront 를 쓴다.
// 화면 하나 = 세션 하나 (사용자 결정 2026-09-25/26): 세션 id 는 opts.sessionId(웹 주소 /s/<id>), 없으면 서버에 server.info 로 묻는다. 서버 하나는 메인 세션과 그 자손을 다룬다 (ticket slcode-web-session-url).
// 세션 목록·새 세션은 이 화면에 없다 — 새 세션은 새 `slcode` 명령(또는 superlite 의 새 카드).
// transport = { request(method, params), onEvent(fn), onStatus(fn) } (rpc.js 표면).
import { renderMarkdown } from './markdown.js';
import { DEFAULTS, applySettings, closeOnBackdrop, ctxLevel, settingsDialog } from './settings.js';
import { inspectDialog } from './inspect.js';
import { activityPanel } from './activity.js';
import { escGate, inputHistory } from './inputkeys.js';
import { rewindPicker } from './rewind.js';

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
  // 웹은 한 문서에 세션 화면을 여러 개 두고 안 보는 화면을 inert 로 숨긴다 (index.html, ticket slcode-web-session-url). document 에 건 처리는 숨은 화면이면 넘긴다
  const behind = () => !!root.closest('[inert]');
  // 헤더 왼쪽은 세션 이름 — 없으면 SLCode, 더블클릭·옆 연필로 고친다(session.rename). superlite 카드 제목도 이 이름을 따른다.
  // id 는 오른쪽 '세션' 칸(올리면 복사 버튼, 사용자 2026-10-09), 경로는 작성창 위 폴더의 복사 버튼 (사용자 2026-10-07, 자리는 2026-10-13)
  const DEFAULT_NAME = 'SLCode';
  const title = h('span', { class: 'title' }, DEFAULT_NAME);
  const setTitle = (t) => { title.textContent = t || DEFAULT_NAME; };
  const nameRow = h('div', { class: 'name-row' }, title); // 연필 버튼은 iconBtn 정의 뒤에 붙인다
  const pill = h('span', { class: 'pill starting' }, STATE_LABEL.starting);
  // 오른쪽 사이드바는 기본으로 닫혀 있고 헤더 오른쪽 끝 버튼으로 연다. 연 상태는 브라우저에 기억한다 (사용자 2026-10-13).
  // 좁으면(820px 이하) 본문 위에 겹쳐 여는데 이건 기억하지 않는다 — 카드가 다시 로드될 때마다 피드를 덮지 않게. 본문을 누르면 닫힌다
  const SIDE_KEY = 'slcode.side';
  // 화면 상태(사이드바 열림·inspect 남은 공간)의 저장소 — 웹은 브라우저 localStorage. 카드는 opts.store: sandbox 화면엔 저장소가 없어
  // 플러그인이 superlite 저장소(세션 머신)에 대신 둔다 (card.html, ticket slcode-card-svc-token-dead·slcode-plugin-v2)
  // sandbox 안(출처 없음)에서 opts.store 없이 뜨면 localStorage 가 SecurityError — 기억하지 않고 기본값으로
  const store = opts.store ?? { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const sideBtn = h('button', { class: 'ico side-tg', title: '사이드바', 'aria-label': '사이드바', onclick: () => {
    if (root.clientWidth <= 820) el.classList.toggle('peek');
    else store.set(SIDE_KEY, el.classList.toggle('side-open') ? 'open' : 'closed');
  } });
  if (store.get(SIDE_KEY) === 'open') el.classList.add('side-open');
  // 설정 — 헤더 오른쪽, 사이드바 버튼 왼쪽 (ticket slcode-web-settings). 같은 입구(브라우저·superlite 탭)의 다른 화면에서 바꿔도 settings.changed 로 온다
  // 바꾼 화면은 응답으로 바로 그린다 — 다른 화면은 settings.changed 로 (serve 의 파일 감시가 늦거나 못 걸려도 여기는 바로)
  // 세션 종료 (사용자 2026-10-11) — 카드는 두고 세션만 끈다(카드를 제거하면 세션도 끝난다). 꺼진 세션은 resume 으로 다시 띄운다.
  // 자리는 설정 창 맨 아래 줄의 빨간 '종료', 누르면 확인 창을 한 번 더 (사용자 2026-10-16 — 전엔 헤더 사이드바 버튼 옆)
  const endSession = () => { if (current) rpc('session.close', { id: current }).catch((e) => push(h('div', { class: 'meta err' }, e.message))); };
  const settingsUi = settingsDialog(h, (patch) => rpc('settings.set', { settings: patch }).then(setSettings), endSession, (m, p) => rpc(m, p));
  const gearBtn = h('button', { class: 'ico gear', title: '설정', 'aria-label': '설정', onclick: () => settingsUi.open() });
  // 업데이트 — 헤더 오른쪽, 설정 버튼 왼쪽 (ticket slcode-core-serve-split 2단계, 사용자 2026-10-19). 누를 때만 새 버전을 확인한다(폴링 없음).
  // 새 버전이 있으면 'restart required' — 누르면 serve 를 바꾼다. 웹은 serve 가 확인하고 같은 주소로 다시 붙은 뒤 새로고침된다(아래 onStatus 의 serve.info),
  // 카드는 플러그인이 확인하고 새 카드로 옮긴다 (serve 의 stdio 로 보내면 그 카드를 띄운 모든 브라우저의 플러그인이 받는다)
  const page = document.documentElement.dataset; // serve 가 넣는다: version·build·kind
  const viaHost = page.kind === 'superlite';
  let hostSeq = 0;
  const hostWait = new Map();
  // 카드 화면이 플러그인에 보내는 길. 1단 카드는 같은 문서의 플러그인 함수(opts.host)이고 답은 같은 창의 message 로 온다. 옛 플러그인의 iframe 카드는 parent 와 주고받는다 (ticket slcode-card-iframe-flatten)
  const hostPost = opts.host ?? ((m) => window.parent.postMessage(m, '*'));
  const hostSource = opts.host ? window : window.parent;
  window.addEventListener('message', (e) => { const w = e.source === hostSource && hostWait.get(e.data?.re); if (w) { hostWait.delete(e.data.re); w(e.data); } });
  const askHost = (type, ms, extra = {}) => new Promise((resolve, reject) => {
    const id = ++hostSeq;
    const t = setTimeout(() => { hostWait.delete(id); reject(new Error('플러그인이 답하지 않습니다')); }, ms);
    hostWait.set(id, (d) => { clearTimeout(t); d.error ? reject(new Error(d.error)) : resolve(d.result); });
    hostPost({ ...extra, type, id, version: page.version, build: page.build });
  });
  let update = null; // 찾은 새 버전 — 있으면 버튼이 restart required
  const updBtn = h('button', { class: 'upd', onclick: () => void (update ? restart() : checkUpdate()) }, '업데이트');
  const paintUpd = (text = update ? 'restart required' : '업데이트', title = update ? `slcode ${page.version ?? '?'} → ${update.version}` : '새 버전 확인') => {
    updBtn.textContent = text; updBtn.title = title; updBtn.classList.toggle('hot', !!update);
  };
  const flashUpd = (text, title) => { paintUpd(text, title ?? text); setTimeout(() => { if (!updBtn.disabled) paintUpd(); }, 2500); };
  async function checkUpdate() {
    updBtn.disabled = true; paintUpd('확인 중…');
    let r;
    try { r = viaHost ? await askHost('slcode.update', 120000) : await rpc('update.run'); } catch (e) { r = { status: 'failed', reason: e.message }; }
    updBtn.disabled = false;
    if (r.status === 'restart-required') { update = r; paintUpd(); }
    else if (r.status === 'latest') flashUpd('최신 버전입니다');
    else flashUpd('확인 실패', r.reason);
  }
  async function restart() {
    updBtn.disabled = true; paintUpd('재시작 중…');
    try { await (viaHost ? askHost('slcode.restart', 15000) : rpc('serve.restart')); }
    catch (e) { updBtn.disabled = false; flashUpd('재시작 실패', e.message); return; }
    if (viaHost) { updBtn.disabled = false; paintUpd(); } // 새 카드가 열렸다 — 옮겨지면 이 화면은 플러그인이 덮는다
  }
  paintUpd();
  let settings = DEFAULTS;
  const setSettings = (s) => { settings = s; applySettings(s); settingsUi.update(s); renderStat(); };
  const feed = h('div', { class: 'feed' });
  const liveCol = h('div', { class: 'col' });
  let col = liveCol; // 옛 턴을 그릴 땐 임시 div 로 바꿨다가 앞에 붙인다
  const older = h('div', { class: 'col older' }), sentinel = h('div');
  const hero = h('div', { class: 'hero', hidden: '' }); // 첫 메시지 전 시작 프로필 고르기 (paintHero)
  feed.append(sentinel, older, hero, liveCol);
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
      addChip({ name: f.name || `clipboard.${mediaType.split('/')[1]}`, mediaType, data: dataUrl.split(',')[1], dataUrl });
    }
    canSend();
  }
  function addChip(att) {
    pendingFiles.push(att);
    const chip = h('span', { class: 'chip' }, att.mediaType.startsWith('image/') ? h('img', { src: att.dataUrl }) : null, att.name, h('a', { onclick: () => { pendingFiles.splice(pendingFiles.indexOf(att), 1); chip.remove(); canSend(); } }, '×'));
    chips.append(chip);
  }
  // 대기에서 꺼낸 글·첨부를 입력창 앞에 (ticket slcode-queued-message-bubble, 사용자 결정 2026-11-08) — 말풍선을 눌렀을 때, 중단(Esc)으로 거둬졌을 때
  function restoreInput(text, attachments = []) {
    if (text) setInputText(input.value ? `${text}\n${input.value}` : text);
    for (const a of attachments) addChip({ ...a, dataUrl: `data:${a.mediaType};base64,${a.data}` });
    canSend(); saveDraft(true);
  }
  // 모델 선택 — 작성창의 알약 버튼 + popover 메뉴 (네이티브 popover 라 바깥 클릭·Esc 로 닫힌다). 목록은 session.models, 고르면 session.setModel (다음 턴부터).
  // 위쪽엔 계열마다 버전이 가장 높은 것만, 나머지는 '더 많은 모델' 아래. 계열 = 표시 이름에서 버전 숫자를 뗀 것 ("Fable 5.1"→Fable, "GPT-5.6 Sol"→GPT Sol),
  // 버전 숫자가 없는 항목(Default, Opus (1M context))은 아래로. 벤더가 늘어도(Codex 등) 한 목록에 섞인다 (사용자 2026-09-27)
  // 메뉴 맨 위는 벤더 토글, 목록 아래는 effort 슬라이더 — 작성창의 effort 버튼은 없앴고 알약이 'Opus 5.5 · high' 로 effort 를 함께 보인다 (ticket slcode-vendor-model-picker, 사용자 2026-10-23)
  const modelLbl = h('span', {}, '');
  const modelBtn = h('button', { class: 'ghost pill-btn model', style: 'display:none' }, modelLbl);
  const modelMenu = h('div', { class: 'menu acf-models', popover: '' });
  modelBtn.popoverTargetElement = modelMenu; // id 로 잇지 않는다 — 웹은 한 문서에 세션 화면이 여러 개다 (ticket slcode-web-session-url)
  let modelName = '', effortNow = null;
  const paintModel = () => { modelLbl.textContent = effortNow ? `${modelName} · ${effortNow}` : modelName; };
  // 벤더 토글 — 첫 메시지 전에만 바꾼다(session.setVendor: 같은 세션 id 로 core 를 새 벤더로 다시 띄운다). 그 뒤엔 지금 벤더만 칠한 채 흐리게 둔다
  const vendorSeg = h('div', { class: 'vendor' });
  let turned = false, switching = null; // turned: 이 세션에 첫 메시지가 들어갔다, switching: 바꾸는 중인 벤더
  function paintVendor() {
    const cur = switching ?? info?.vendor ?? 'claude', locked = turned || !!switching;
    vendorSeg.classList.toggle('locked', locked);
    vendorSeg.title = turned ? '첫 메시지 뒤에는 벤더를 바꿀 수 없습니다' : switching ? `${switching} 로 바꾸는 중…` : '';
    vendorSeg.replaceChildren(...['claude', 'codex'].map((v) => h('button', { class: 'seg', 'aria-pressed': String(v === cur), 'aria-disabled': String(locked), onclick: () => switchVendor(v) }, v)));
  }
  function switchVendor(v) {
    if (turned || switching || !current || v === (info?.vendor ?? 'claude')) return;
    switching = v; paintVendor();
    modelMenu.replaceChildren(vendorSeg, h('div', { class: 'note' }, `${v} 로 바꾸는 중…`));
    // 응답 뒤 core 가 바뀐다 — 그 사이 보낸 요청은 serve 의 중계가 새 core 에 다시 보낸다. 모델 목록은 새 벤더가 뜬 뒤에 온다
    rpc('session.setVendor', { id: current, vendor: v })
      .then(() => { loadStatus(); loadCommands(); loadMcp(); loadPlugins(); return loadModels(); })
      .catch((e) => { push(h('div', { class: 'meta err' }, e.message)); return loadModels(); })
      .finally(() => { switching = null; paintVendor(); });
  }
  // 시작 프로필 — 첫 메시지 전에 채팅창 가운데에서 고른다 (ticket slcode-session-profile, 사용자 2026-10-30). session.setProfile 은 setVendor 처럼 같은 세션 id 로
  // core 를 그 프로필로 다시 띄운다. 첫 메시지 뒤엔 감춘다 — 지금 프로필은 사이드바 "에이전트 플러그인" 칸에 남는다. 옛 core(session.profiles 없음)면 보이지 않는다
  let profiles = null, profSwitching = null, backing = false;
  async function loadProfiles() {
    if (!current || turned) { paintHero(); return; }
    try { profiles = await rpc('session.profiles', { id: current }); } catch { profiles = null; }
    paintHero();
  }
  function paintHero() {
    const back = !!info?.fromStart; // 시작 화면(동사 없는 slcode)에서 연 새 세션 — 첫 메시지 전엔 돌아갈 수 있다
    hero.hidden = turned || !!info?.locked || (!profiles && !back); // 입력 제어 중인 팀원은 리더가 정한다 — core 도 setProfile 을 거절한다
    if (hero.hidden) return;
    const cur = profSwitching ?? profiles?.current;
    hero.replaceChildren(
      ...(back ? [h('button', { class: 'ghost hero-back', disabled: backing || profSwitching ? '' : null, onclick: () => void backToStart() }, backing ? '시작 화면으로 돌아가는 중…' : '← 시작 화면')] : []),
      ...(profiles ? [h('div', { class: 'hero-h' }, '프로필'),
      h('div', { class: 'hero-seg' }, ...profiles.profiles.map((p) => h('button', { class: 'seg', 'aria-pressed': String(p.name === cur), disabled: profSwitching ? '' : null, title: p.summary, onclick: () => switchProfile(p.name) }, p.name))),
      h('div', { class: 'hero-sum' }, profSwitching ? `${profSwitching} 로 바꾸는 중…` : profiles.profiles.find((p) => p.name === cur)?.summary ?? ''),
      h('div', { class: 'hero-note' }, '첫 메시지를 보내기 전에만 바꿀 수 있습니다')] : []));
  }
  // 시작 화면으로 — 이 빈 세션은 닫고 지운다. 카드는 플러그인이 같은 카드에 시작 화면을 다시 그리고, 웹은 진입 프로세스가 같은 주소에 시작 화면을 다시 연다
  async function backToStart() {
    if (backing || turned || !current) return;
    backing = true; paintHero();
    try {
      if (viaHost) { await askHost('slcode.back', 30000, { session: current, cwd: info?.cwd }); return; }
      await rpc('start.back');
      for (let t = Date.now(); Date.now() - t < 30000; await new Promise((r) => setTimeout(r, 300))) {
        const page = await fetch('./', { cache: 'no-store' }).then((r) => r.text(), () => '');
        if (page.includes('data-start=')) { location.reload(); return; }
      }
      throw new Error('시작 화면이 열리지 않았습니다');
    } catch (e) { backing = false; paintHero(); push(h('div', { class: 'meta err' }, e.message)); }
  }
  function switchProfile(name) {
    if (turned || profSwitching || backing || !current || !profiles || name === profiles.current) return;
    profSwitching = name; paintHero();
    // 응답 뒤 core 가 바뀐다 — 그 사이 보낸 요청은 serve 의 중계가 새 core 에 다시 보낸다
    rpc('session.setProfile', { id: current, profile: name })
      .then(() => { loadStatus(); loadCommands(); loadMcp(); loadPlugins(); return loadModels(); })
      .catch((e) => { push(h('div', { class: 'meta err' }, e.message)); })
      .finally(() => { profSwitching = null; void loadProfiles(); });
  }
  // 권한 모드 — effort 옆 알약 + 메뉴 (session.setMode, 즉시). 현재 값은 info.permissionMode (session.changed 로 갱신)
  const REVIEW = { approved: '허용', denied: '거부', timedOut: '시간 초과', aborted: '중단' };
  const RISK = { low: '낮음', medium: '보통', high: '높음', critical: '심각' };
  const MODES = [['default', '승인 요청', 'hand'], ['auto', '자동 승인', 'shieldCheck'], ['bypassPermissions', '전체 액세스', 'shieldAlert']];
  const modeLbl = h('span', {}, '');
  const modeIco = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); modeIco.setAttribute('viewBox', '0 0 24 24');
  const modeBtn = h('button', { class: 'ghost pill-btn mode' }, modeLbl);
  const modeMenu = h('div', { class: 'menu acf-mode', popover: '' });
  modeBtn.popoverTargetElement = modeMenu;
  // 모드별 색(auto 노랑·bypass 빨강, 2026-10-09)은 뺐다 (사용자 2026-10-13). 메뉴는 승인 요청·자동 승인·전체 액세스 셋, 설명 없이 모드별 아이콘만 — 알약도 같은 아이콘 (사용자 2026-10-24) — 이름만 화면용이고 값은 그대로,
  // 옛 acceptEdits·plan 세션은 core 가 resume 때 auto 로 고쳐 쓴다 (ticket slcode-permission-modes-three)
  const modeName = (v) => MODES.find(([m]) => m === v)?.[1] ?? v;
  const paintMode = (v) => { modeLbl.textContent = modeName(v); modeIco.innerHTML = ICONS[MODES.find(([m]) => m === v)?.[2] ?? 'shieldCheck']; };
  function renderMode() {
    const cur = info?.permissionMode ?? ready?.permissionMode ?? 'default';
    paintMode(cur);
    modeMenu.replaceChildren(...MODES.map(([v, label, ico]) => h('button', { class: 'item', 'aria-checked': String(v === cur), onclick: () => { modeMenu.hidePopover(); paintMode(v); rpc('session.setMode', { id: current, mode: v }).catch((e) => { push(h('div', { class: 'meta err' }, e.message)); renderMode(); }); } }, icon(ico), h('span', {}, label))));
  }
  // start: 버튼 왼쪽 끝에 맞춘다 — 왼쪽 아래 권한 모드 메뉴가 오른쪽 끝에 맞추면 화면 왼쪽 밖으로 나간다
  const anchor = (menu, btn, start = false) => () => { if (menu.matches(':popover-open')) { const r = btn.getBoundingClientRect(); menu.style.left = `${start ? r.left : r.right - menu.offsetWidth}px`; menu.style.bottom = `${innerHeight - r.top + 6}px`; } };
  modelMenu.ontoggle = anchor(modelMenu, modelBtn); modeMenu.ontoggle = anchor(modeMenu, modeBtn, true);
  // 슬래시 명령 자동완성 — 입력이 `/` 로 시작하면 입력창 위에 목록. ↑↓ 고르고 Tab·Enter 로 넣는다. 목록은 session.commands (2026-09-30)
  // 에이전트 플러그인 명령(kind 'command', ticket slcode-agent-plugin-command)은 '명령' 표지를 단다. 이름 뒤에 공백을 치면 인자 단계 — 맨 위에 argumentHint,
  // 그 아래 session.completeCommand 의 후보(50ms 간격, 입력이 바뀐 뒤 온 답·밀린 답은 버리고, 100ms 넘게 걸린 답이면 메뉴를 닫는다). 고르면 커서가 있는 낱말을 바꾼다
  let commands = [], slashSel = 0;
  let argRes = null, argSeq = 0, argTimer = null;
  const COMPLETE_LATE_MS = 100;
  const slashMenu = h('div', { class: 'menu slash', popover: 'manual' });
  // 플러그인 접두(core:)는 생략해도 된다: 짧은 이름으로도 맞추고, 짧은 이름이 정확히 같은 것을 앞에 둔다 (사용자 2026-09-30)
  const shortOf = (name) => name.slice(name.indexOf(':') + 1);
  function slashItems() {
    if (argRes) return argRes.items;
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
  /** 입력의 첫 낱말이 플러그인 명령이고 그 뒤에 공백이 있으면 그 명령 — 전체 이름이거나, 짧은 이름으로 맞는 것이 그것 하나뿐일 때 (core 의 판정과 같다) */
  function argCommand(text) {
    const m = /^\/(\S+)\s/.exec(text); if (!m) return null;
    const tok = m[1].toLowerCase();
    const hits = commands.filter((c) => c.name.toLowerCase() === tok || (!tok.includes(':') && shortOf(c.name.toLowerCase()) === tok));
    return hits.length === 1 && hits[0].kind === 'command' ? hits[0] : null;
  }
  function argQuery() {
    clearTimeout(argTimer);
    const text = input.value, cursor = input.selectionStart ?? text.length;
    const c = argCommand(text);
    if (!c) { argRes = null; return; }
    if (argRes?.cmd !== c) argRes = { cmd: c, hint: c.argumentHint, items: [], start: cursor, end: cursor };
    const seq = ++argSeq;
    argTimer = setTimeout(async () => {
      const t0 = performance.now();
      const r = await rpc('session.completeCommand', { id: current, text, cursor }).catch(() => null);
      if (seq !== argSeq || input.value !== text || !r || r.stale || !argRes) return;
      const late = performance.now() - t0 > COMPLETE_LATE_MS; // 늦은 답은 쓰지 않고 메뉴를 닫는다 (사용자 2026-11-02)
      argRes = { cmd: c, hint: r.hint, items: late ? [] : r.items.map((x) => ({ ...x, arg: true })), start: r.start, end: r.end };
      slashSel = 0; slashDraw();
    }, 50);
  }
  function slashDraw() {
    const items = slashItems();
    const hint = argRes ? h('div', { class: 'item argh' }, h('span', { class: 'name' }, `/${argRes.cmd.name}`, argRes.hint ? h('span', { class: 'hint' }, ` ${argRes.hint}`) : null), h('span', { class: 'desc' }, argRes.cmd.description)) : null;
    // complete 가 있는 명령은 후보가 없으면(다 적었거나 맞는 것이 없다) 힌트 줄도 닫는다 — 힌트만 남기는 것은 complete 가 없는 명령 (사용자 2026-11-02)
    if (!items.length && !(hint && argRes.hint && !argRes.cmd.complete)) { if (slashMenu.matches(':popover-open')) slashMenu.hidePopover(); return; }
    slashSel = Math.min(slashSel, Math.max(0, items.length - 1));
    slashMenu.replaceChildren(...(hint ? [hint] : []), ...items.map((c, i) => h('button', { class: 'item', 'aria-selected': String(i === slashSel), onmousedown: (e) => { e.preventDefault(); slashPick(c); } },
      c.arg ? h('span', { class: 'name' }, c.label ?? c.value) : h('span', { class: 'name' }, `/${c.name}`, c.argumentHint ? h('span', { class: 'hint' }, ` ${c.argumentHint}`) : null),
      c.kind === 'command' ? h('span', { class: 'tag' }, '명령') : null, h('span', { class: 'desc' }, c.description ?? ''))));
    if (!slashMenu.matches(':popover-open')) slashMenu.showPopover();
    const r = input.getBoundingClientRect(); slashMenu.style.left = `${r.left}px`; slashMenu.style.bottom = `${innerHeight - r.top + 12}px`; slashMenu.style.width = `${r.width}px`;
  }
  function slashPick(c) {
    if (c.arg) {
      const t = input.value, { start, end } = argRes, tail = t.slice(end);
      input.value = `${t.slice(0, start)}${c.value}${tail.startsWith(' ') ? '' : ' '}${tail}`;
      const at = start + c.value.length + 1; input.setSelectionRange(at, at);
    } else input.value = `/${c.name} `;
    input.focus(); argQuery(); slashDraw();
  }
  // /fork 는 화면이 처리한다 (복제, ticket slcode-session-fork) — 벤더에 같은 이름이 있으면 가린다
  const FORK_CMD = { name: 'fork', description: '이 세션을 복제해 새 세션으로 엽니다 (끝난 턴까지, 같은 폴더)' };
  async function loadCommands() { try { commands = [FORK_CMD, ...(await rpc('session.commands', { id: current })).filter((c) => c.name !== 'fork')]; } catch { commands = [FORK_CMD]; } }
  // 작성창 = 입력칸 위, 아래 한 줄: 왼쪽 끝 첨부·권한 모드, 오른쪽 모델(effort 포함)·보내기 (Codex Desktop 꼴, 사용자 2026-10-13). 상자 밖 아래에 폴더·repo·리밋·context·비용 한 줄(stat)
  const stat = h('div', { class: 'stat' });
  // 입력 큐 (ticket slcode-agent-plugin-command, 사용자 2026-11-02) — 턴 중에 친 명령과 그 뒤 메시지는 피드에 섞지 않고 입력창 바로 위에 보통 내 메시지와 같은 말풍선으로 순서대로 붙여 둔다. 처리되면 여기서 빠지고 피드에 보통 줄로 들어간다
  // 턴 중 보통 메시지도 여기 (ticket slcode-queued-message-bubble, 사용자 결정 2026-11-08) — 누르면 대기에서 빼서 입력창으로. 이미 읽히기 시작했으면 곧 피드로 옮겨 가므로 그대로 둔다
  const queueTray = h('div', { class: 'queue', hidden: '' });
  const paintQueue = (items) => {
    const stick = atBottom();
    queueTray.hidden = !items.length;
    placeBusy();
    if (stick) feed.scrollTop = feed.scrollHeight;
    queueTray.replaceChildren(...items.map((q) => h('div', { class: 'user' }, h('div', { class: 'bubble', title: '눌러서 입력창으로 꺼내기', onclick: () => unqueue(q) }, q.text || `첨부 ${q.attachments}개`))));
  };
  const unqueue = (q) => {
    if (!current || !q.id) return; // 옛 core 의 항목엔 id 가 없다
    rpc('session.unqueue', { id: current, item: q.id }).then((r) => restoreInput(r.text, r.attachments), () => {});
  };
  // 입력 상자 위 테두리의 '기록 4/5' (Claude Code 실측과 같은 자리)
  const inputHint = h('div', { class: 'input-hint', hidden: '' });
  // 입력칸 글 바꾸기 — 브라우저 편집 명령으로 바꿔야 Ctrl+Z 로 돌아온다 (사용자 2026-11-03). value 대입은 되돌리기 이력을 지운다
  const setInputText = (text) => {
    input.focus({ preventScroll: true });
    if (input.value === text) return;
    input.select();
    const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
    if (!ok || input.value !== text) { input.value = text; input.oninput(); }
  };
  const hist = inputHistory(input, setInputText, (pos, total) => { inputHint.textContent = pos === null ? '' : `기록 ${pos}/${total}`; inputHint.hidden = pos === null; });
  // 팀원 세션 (ticket slcode-team-agent, 사용자 2026-11-08) — kidAsks: 리더의 입력창 위 "팀원" 승인 줄, lockOver: 입력 제어 중인 팀원의 흐린 입력 상자 위 자물쇠 (paintLock·paintKids).
  // kidAsks 는 composer 밖(dock 위)에 둔다 — 리더 자신의 승인 카드가 composer 를 가려도 남는다
  const kidAsks = h('div', { class: 'kid-asks', hidden: '' });
  const lockOver = h('div', { class: 'lockover', hidden: '' });
  const box = h('div', { class: 'box' }, inputHint, chips, input, h('div', { class: 'row' }, addBtn, modeBtn, modeMenu, h('span', { class: 'gap' }), modelBtn, modelMenu, stopBtn, sendBtn), slashMenu, filePick, lockOver);
  const composer = h('div', { class: 'composer' }, queueTray, box, stat);
  const side = h('aside', { class: 'side' });
  const dock = h('div', { class: 'dock' });
  // 실행 중 표시 — 피드 맨 끝(내 요청 바로 아래)에 한 줄: 맥동 점 · 지금 하는 일 · 경과. state 가 running 일 때만, 새 항목이 와도 늘 마지막 (사용자 2026-09-30)
  // claude·codex 의 줄과 같은 꼴: ✻ 작업 중… (1m 8s · effort · esc 중단). 글리프는 claude 처럼 돌아간다
  const SPIN = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
  const busyGlyph = h('i', {}, SPIN[0]), busyWhat = h('span', { class: 'what' }), busyInfo = h('span', { class: 'info' });
  const busy = h('div', { class: 'busy', hidden: '' }, busyGlyph, busyWhat, busyInfo);
  // busySince 는 서버 시각(e.at) — 브라우저 시계와 어긋나면 음수로 시작해서, 실시간 이벤트가 올 때마다 재는 skew 로 보정한다 (2026-10-01 -2s 지적)
  let busySince = 0, busyTimer = null, busyTick = 0, skew = 0;
  // 자리: 보통은 피드 끝. 큐가 있으면 큐 바로 위 — 출력이 나오는 자리(그 위 피드의 끝)를 보인다 (사용자 2026-11-02)
  const placeBusy = () => { if (queueTray.hidden) col.append(busy); else queueTray.before(busy); };
  const setBusy = (what) => { if (what && !replaying) busyWhat.textContent = `${what}…`; };
  const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
  const busyRefresh = () => { busyGlyph.textContent = SPIN[busyTick++ % SPIN.length]; busyInfo.textContent = `(${[fmtDur(Math.max(0, Date.now() - skew - busySince)), effortNow ? `effort ${effortNow}` : null, 'esc 중단'].filter(Boolean).join(' · ')})`; };
  function showBusy(on) {
    busy.hidden = !on;
    if (on) { placeBusy(); if (follow) feed.scrollTop = feed.scrollHeight; }
    if (on && !busyTimer) { busySince = busySince || Date.now(); busyRefresh(); busyTimer = setInterval(busyRefresh, 200); }
    if (!on && busyTimer) { clearInterval(busyTimer); busyTimer = null; busySince = 0; }
  } // 승인·질문 카드는 입력창 자리에 뜬다 — 피드에는 호출 표식만 (사용자 2026-09-30)
  // 여는 동안의 단계·경과 — 헤더 상태 칸 옆(사이드바와 무관), 화면이 다 그려지면 사라진다 (ticket slcode-boot-progress, 사용자 2026-10-17).
  // 그리기(0.1초 안팎)는 따로 안 보인다 — 칠할 틈을 주려고 쉬면 그 사이 온 실시간 이벤트가 기록보다 먼저 그려진다.
  // 그 뒤의 '시작 중' 은 첫 메시지 전 Claude Code 상태(init 이 첫 프롬프트 뒤에 온다, 실측)라 단계에 넣지 않는다
  const bootEl = h('span', { class: 'boot', hidden: '' });
  let bootStage = null, bootSince = 0, bootTimer = null;
  const bootPaint = () => { bootEl.hidden = !bootStage; bootEl.textContent = bootStage ? `${bootStage}… (${fmtDur(Date.now() - bootSince)})` : ''; };
  function boot(stage) {
    if (stage && !bootStage) { bootSince = Date.now(); bootTimer = setInterval(bootPaint, 500); }
    if (!stage) { clearInterval(bootTimer); bootTimer = null; }
    bootStage = stage; bootPaint();
  }
  boot('connecting');
  // 맨 위 헤더 = 세션 이름·상태 … 설정·사이드바 버튼, 폭이 좁아도 늘 보인다 (사용자 2026-10-13). 전엔 왼쪽 레일이라 1100px 아래에서 숨었다
  // 관련 세션 메뉴 — 헤더의 세션 이름 옆, 가족이 있을 때만 (ticket slcode-web-session-url, 사용자 2026-11-05: 사이드바는 기본으로 닫혀 있어 어느 화면에서든 보이는 헤더로). 채우는 쪽은 paintFamily
  const famMenu = h('div', { class: 'menu fam-menu', popover: '' });
  const famBtn = h('button', { class: 'fam-chip', hidden: '' });
  famBtn.popoverTargetElement = famMenu;
  famMenu.ontoggle = () => { if (famMenu.matches(':popover-open')) { const r = famBtn.getBoundingClientRect(); famMenu.style.left = `${r.left}px`; famMenu.style.top = `${r.bottom + 6}px`; opts.preload?.(family.sessions.filter((x) => x.live && x.id !== current).map((x) => x.id)); } };
  const center = h('div', { class: 'main' }, feed, kidAsks, dock, composer);
  center.addEventListener('pointerdown', () => el.classList.remove('peek'));
  el.append(
    h('header', { class: 'hdr' }, nameRow, famBtn, famMenu, pill, bootEl, h('span', { class: 'gap' }), updBtn, gearBtn, sideBtn),
    center,
    side,
    settingsUi.el,
  );
  root.append(el);

  const rpc = (m, p) => transport.request(m, p);
  // 활동 기록 (ticket slcode-activity-state) — 사이드바 칸과 모달, 이 화면의 사람 행동 신호
  const act = activityPanel(h, rpc, { getId: () => current, root: el, feed, input });
  el.append(act.dialog);
  let family = null, refused = null; // 같은 가족의 세션(serve.sessions), 주소가 가리켰지만 열지 못한 세션
  let current = null, lastSeq = 0, curSeq = 0, replaying = false, info = null, ready = null, connected = false, exitNote = null;
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
  // MCP 의 지금 상태 — session.ready 의 mcp 는 기동 때 것이라 실패 사유가 없다. failed 가 있을 때만 묻는다 (폴링 없음, ticket slcode-mcp-failed-path)
  let mcp = null, mcpBusy = null; // mcp: session.mcp·mcpReconnect 결과, 없으면 ready.mcp 를 그린다. mcpBusy: 다시 연결 중인 서버 이름
  // 에이전트 플러그인 (ticket slcode-agent-plugin) — 실은 빌드와 지금 설정의 빌드가 다르면 다시 싣기를 켠다. attach·turn.end 때 묻는다 (폴링 없음)
  let plugs = null, plugBusy = false; // plugs: session.plugins 결과
  async function loadPlugins() { if (!current) return; try { plugs = await rpc('session.plugins', { id: current }); } catch { plugs = null; } renderSide(); }
  async function reloadPlugins() {
    if (plugBusy || !current) return;
    plugBusy = true; renderSide();
    try { await rpc('session.reloadPlugins', { id: current }); } // 결과는 plugins.reloaded 이벤트로, 턴 중이면 pending 으로 기다린다
    catch (e) { push(h('div', { class: 'meta err' }, e.message)); }
    plugBusy = false; loadPlugins();
  }
  const LATER = { instructions: '지시문', env: 'env', 'session.json': 'session.json', mcp: 'MCP', bin: 'bin', installed: '새로 설치함' };
  async function loadMcp() { if (!current || !ready?.mcp?.some((m) => m.status === 'failed')) return; try { mcp = await rpc('session.mcp', { id: current }); } catch { return; } renderSide(); }
  async function retryMcp(name) {
    if (mcpBusy) return;
    mcpBusy = name; renderSide();
    try { mcp = await rpc('session.mcpReconnect', { id: current, name }); }
    catch (e) { mcp = (mcp ?? ready.mcp).map((m) => (m.name === name ? { ...m, error: e.message } : m)); }
    mcpBusy = null; renderSide();
  }

  // 따라가기 — 바닥에 있을 때만 새 항목을 따라 내려간다. 부드러운 스크롤 도중엔 위치 측정이 틀리므로(2026-09-30 실측) 값을 재지 않고 플래그를 든다:
  // 사용자가 스크롤하면 그때 바닥 여부를 재고, 보내기·바닥 도달 때 켠다
  let follow = true;
  // 맨 아래로 버튼 (ticket slcode-scroll-nav, 사용자 2026-10-23) — 따라가기가 꺼진 동안 피드 아래 가운데(작성창·승인 카드 바로 위)에 뜬다.
  // 그 사이 실시간으로 새로 시작한 답변 말풍선(서브에이전트 안은 빼고)을 세어 '새 메시지 N' 알약으로. 알림은 이 화면 안에서만 (superlite 알림으로 보내지 않는다)
  // 바닥으로는 즉시 간다 — 부드러운 스크롤 도중의 onscroll 이 follow 를 꺼서 버튼이 깜빡이고, 그 사이 온 항목을 따라가지 않는다
  let unread = 0;
  const jumpLbl = h('span', { class: 'n' });
  const jumpBtn = h('button', { title: '맨 아래로', 'aria-label': '맨 아래로', onclick: () => toBottom() }, jumpLbl); // 화살표는 icon 정의 뒤에 붙인다
  feed.append(h('div', { class: 'jump' }, jumpBtn));
  const paintJump = () => { if (follow) unread = 0; jumpBtn.classList.toggle('on', !follow); jumpBtn.classList.toggle('hot', unread > 0); jumpLbl.textContent = unread ? `새 메시지 ${unread}` : ''; };
  // 끄는 것은 위로 갈 때만 — 바닥으로 부드럽게 내려가는 도중의 위치(큰 도구 카드가 붙은 직후 등)로 끄면 버튼이 깜빡이고 그 사이 온 답변을 '새 메시지' 로 센다 (2026-10-23 실측)
  let lastTop = 0;
  feed.onscroll = () => {
    if (!feed.clientHeight) return; // 숨은 카드(display:none) — 높이가 모두 0 이라 바닥으로 읽혀 올려 둔 자리의 따라가기가 켜진다
    if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80) follow = true; else if (feed.scrollTop < lastTop) follow = false;
    lastTop = feed.scrollTop; paintJump();
  };
  const toBottom = () => { follow = true; jump(feed.scrollHeight); paintJump(); };
  const atBottom = () => follow;
  function push(node, sc = main) { const stick = atBottom(); node.dataset.seq = curSeq; (sc.col ?? col).append(node); if (!busy.hidden && !replaying) placeBusy(); if (stick && !replaying) feed.scrollTop = feed.scrollHeight; return node; }
  function endText(sc = main) { if (sc.textEl) { sc.textEl.classList.remove('streaming'); sc.textEl.append(sc.acts = acts(iconBtn('copy', '복사', copyOf(sc.textBuf)))); } sc.textEl = null; sc.textBuf = ''; sc.thinkEl = null; sc.thinkBuf = ''; }
  // 훅 실행 하나 — 아무 일도 안 했으면 흔적 없음. 알림(message)은 대상 아래 제 줄(응답처럼), 추가 컨텍스트는 대상 아래 '겹 +N'(누르면 펼침),
  // 도구 훅의 block·ask·allow·updateInput 은 카드 표시 + 카드 안 사유, 실패·경고는 빨간 줄. 플러그인·이벤트·파일·시간은 title(호버)로만.
  // 대상: 도구 이벤트는 그 도구 카드, UserPromptSubmit·턴 안의 SessionStart(/clear) 는 이 턴의 내 요청, 나머지는 피드 끝 (Claude TUI 의 '⎿ … says:' 자리)
  // 세션을 열 때 돈 SessionStart(턴 밖, ticket slcode-session-open-notice 사용자 2026-11-01)는 피드 끝 — 첫 메시지 전에는 프로필 고르기 바로 아래에 대화 너비로,
  // 첫 메시지 뒤에는 대화 첫 줄로 남는다. 턴 없이 core 가 다시 뜨면(session.opened — 첫 메시지 전 프로필·벤더 바꾸기, 보내지 않고 닫았다 다시 열기) 앞서 그린 것은 지운다
  function hookRun(ev) {
    const who = `${ev.plugin} · ${ev.event} · ${ev.src.split('/').pop()} · ${ev.ms}ms`;
    const opening = ev.event === 'SessionStart' && !main.inTurn;
    const mark = (n) => { if (opening && n) (main.openNodes ??= []).push(n); return n; };
    if (ev.outcome !== 'ok') mark(push(h('div', { class: 'meta err', title: who }, `${ev.plugin} 훅 실패: ${ev.outcome === 'timeout' ? '시간 초과' : (ev.error ?? '').split('\n')[0]}`)));
    for (const w of ev.warnings) mark(push(h('div', { class: 'meta err', title: who }, `${ev.plugin} 훅: ${w}`)));
    const fx = ev.effects;
    const card = ev.toolUseId ? tools.get(ev.toolUseId) : null;
    const anchor = card ?? (/^(UserPromptSubmit|SessionStart)$/.test(ev.event) && !opening && main.turnEl?.isConnected ? main.turnEl : null);
    // message 마다 한 줄 — 아이콘·색(tone)은 플러그인이 목록 안에서 고른 것(ticket slcode-session-open-notice, 사용자 2026-11-02 옅은 배경). messages 가 없는 옛 기록은 message 한 줄
    const note = () => { for (const m of ev.messages ?? (ev.message ? [{ text: ev.message }] : [])) mark(hookAfter(anchor, h('div', { class: `hk-note${m.tone ? ` t-${m.tone}` : ''}`, title: who }, h('span', { class: 'ic' }, icon(NOTE_ICONS[m.icon] ?? 'bell')), h('span', { class: 't' }, m.text)))); };
    if (opening) note(); // 열 때는 알림 줄이 먼저, 추가 컨텍스트(겹 +N)는 그 아래
    if (fx?.context.length) mark(hookContext(anchor, fx.context, ev.event, who));
    if (card && fx) {
      const marks = [...new Set([...fx.block.map(() => 'block'), ...fx.ask.map(() => 'ask'), ...fx.allow.map(() => 'allow'), ...(fx.updateInput ? ['updateInput'] : []), ...fx.stop.map(() => 'stop')])];
      const why = [...fx.ask, ...fx.allow, ...fx.stop].filter(Boolean); // block 사유는 도구 결과(오류)에 이미 나온다
      if (marks.length) card.querySelector('summary').append(h('span', { class: `hk-mark${fx.block.length ? ' block' : ''}`, title: who }, marks.join(', ')));
      if (why.length) card._detail.append(h('div', { class: 'hk-why', title: who }, why.join('\n')));
    } else if (fx && (fx.block.length || fx.stop.length)) mark(push(h('div', { class: 'meta', title: who }, [...fx.block, ...fx.stop].filter(Boolean).join(' · ') || (fx.block.length ? 'block' : 'stop'))));
    if (!opening) note();
  }
  // 에이전트 플러그인 명령 (ticket slcode-agent-plugin-command) — 친 명령은 보통 내 메시지와 같은 말풍선(사용자 2026-11-02), 그 아래 알림 줄과 보관한 컨텍스트(겹 +N, 펼치면 글).
  // 보관분을 붙인 턴(attached)은 그 턴의 내 요청 아래 겹 +N 에 '/명령' 출처로 더한다. 실패·경고는 빨간 줄, 실패(outcome 이 ok 가 아닌 것)는 말풍선도 흐리게 (ticket slcode-command-failed-dimmed)
  function commandRun(ev) {
    if (ev.phase === 'attached') { if (main.turnEl?.isConnected) for (const x of ev.items) hookContext(main.turnEl, [x.text], `/${x.name}`, `${x.plugin} · /${x.name}`); return; }
    const who = `${ev.plugin} · /${ev.name} · ${ev.ms}ms`;
    const line = push(h('div', { class: `user${ev.outcome !== 'ok' ? ' failed' : ''}` }, h('div', { class: 'bubble', title: who }, `/${ev.name}${ev.args ? ` ${ev.args}` : ''}`)));
    if (ev.outcome !== 'ok') push(h('div', { class: 'meta err', title: who }, `/${ev.name} 실패: ${ev.outcome === 'timeout' ? '시간 초과' : (ev.error ?? '').split('\n')[0]}`));
    for (const w of ev.warnings) push(h('div', { class: 'meta err', title: who }, `/${ev.name}: ${w}`));
    for (const m of ev.messages ?? []) hookAfter(line, h('div', { class: `hk-note${m.tone ? ` t-${m.tone}` : ''}`, title: who }, h('span', { class: 'ic' }, icon(NOTE_ICONS[m.icon] ?? 'bell')), h('span', { class: 't' }, m.text)));
    if (ev.context.length) hookContext(line, ev.context, `/${ev.name} · 다음 메시지에 붙음`, who);
    if (ev.cleared) push(h('div', { class: 'meta', title: who }, `/${ev.name} 이 보관한 컨텍스트를 지웠습니다`));
  }
  /** 대상(과 그 뒤에 이미 붙은 훅 줄들) 바로 뒤에 둔다 — 대상이 없으면 피드 끝 */
  function hookAfter(anchor, node) {
    if (!anchor) return push(node);
    let at = anchor; while (at.nextElementSibling?.matches('.hk-note, .hk-ctx')) at = at.nextElementSibling;
    node.dataset.seq = curSeq; at.after(node); return node;
  }
  /** 추가 컨텍스트 — 대상 아래 '겹 +N' 한 줄, 같은 대상이면 개수만 는다. 펼치면 '추가 컨텍스트' 제목 + 글 + from <이벤트> */
  function hookContext(anchor, texts, event, who) {
    const inUser = anchor?.matches('.user');
    let box = inUser ? anchor.querySelector(':scope > .hk-ctx') : anchor?.nextElementSibling?.matches('.hk-ctx') ? anchor.nextElementSibling : null;
    if (!box) {
      const n = h('span', { class: 'n' }), body = h('div', { class: 'body', hidden: '' }, h('div', { class: 'hd' }, '추가 컨텍스트'));
      const btn = h('button', { class: 'tg', type: 'button' }, h('span', { class: 'ic' }, icon('layers')), n);
      btn.onclick = () => { body.hidden = !body.hidden; btn.classList.toggle('on', !body.hidden); };
      box = h('div', { class: `hk-ctx${inUser ? '' : ' left'}` }, btn, body); box._n = n; box._body = body; box._count = 0;
      if (inUser) anchor.append(box); else hookAfter(anchor, box);
    }
    for (const t of texts) box._body.append(h('div', { class: 'it' }, h('div', { class: 'tx' }, t), h('div', { class: 'from', title: who }, `from ${event}`)));
    box._count += texts.length; box._n.textContent = `+${box._count}`;
    box.querySelector('.tg').title = `추가 컨텍스트 ${box._count}개`;
    return box;
  }
  // 답변 시작으로 (ticket slcode-scroll-nav, 사용자 2026-10-24) — 턴의 마지막 말풍선 아이콘 줄(복사 옆)에만, 누르면 그 턴의 응답 첫 항목
  // (내 요청 바로 아래 — 글·생각·도구 카드 무엇이든)이 화면 맨 위로. 턴 안에서 도구 사이로 쪼개진 마지막 말풍선의 처음이 아니다.
  // 말풍선마다 두는 안은 프로토타입으로 비교하고 뺐다. 즉시 간다 — 부드럽게 올라가는 도중 앞 턴이 붙으면 엉뚱한 곳에 멈춘다
  const toTop = (node) => jump(feed.scrollTop + node.getBoundingClientRect().top - feed.getBoundingClientRect().top - 12);
  const startBtn = (node) => iconBtn('top', '답변 시작으로', () => toTop(node));
  // 말풍선 아래 아이콘 줄 (ChatGPT 꼴, 사용자 2026-09-27) — 복사, (사용자 턴엔) 돌아가기 = claude 의 Esc-Esc: 답변만 / 코드만 / 둘 다
  /* 아이콘(ICONS)은 Lucide(https://lucide.dev)의 것이거나 그 꼴을 따른 것이다. 일부(plus·copy·chevron 등)는 Lucide 가 Feather 에서 가져온 것이다.
   *
   * ISC License
   *
   * Copyright (c) 2026 Lucide Icons and Contributors
   *
   * Permission to use, copy, modify, and/or distribute this software for any
   * purpose with or without fee is hereby granted, provided that the above
   * copyright notice and this permission notice appear in all copies.
   *
   * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
   * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
   * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
   * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
   * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
   * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
   * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
   *
   * The MIT License (MIT) (for the icons derived from the Feather project)
   *
   * Copyright (c) 2013-present Cole Bemis
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */
  const ICONS = {
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    up: '<path d="M12 19V5"/><path d="M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/>',
    top: '<path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    panel: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    // 권한 모드 — lucide hand·shield-check·shield-alert (사용자 2026-10-24)
    hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    shieldCheck: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    shieldAlert: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    // 상태 아이콘 — claude 상태줄의 📁🌿⌛📦·비용(작성창 아래)·💻(사이드바 위) 자리, 외곽선만 — lucide 꼴
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    fork: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
    hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    cpu: '<rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
    coin: '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', // 입력 제어 중인 팀원의 자물쇠 (ticket slcode-team-agent)
    download: '<path d="M12 4v12"/><path d="M6 11l6 6 6-6"/><path d="M5 20h14"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    inspect: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
    rewind: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    retry: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    // 훅 — 알림(bell)·추가 컨텍스트(layers: 대화에 쌓인 한 겹), lucide (ticket slcode-agent-plugin-hooks, 사용자 2026-10-30)
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    // 훅 알림이 고를 수 있는 아이콘(NOTE_ICONS) — lucide flag·info·triangle-alert·circle-check·star·zap·shield (ticket slcode-session-open-notice, 사용자 2026-11-02)
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    triangleAlert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    circleCheck: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  };
  /** hook.message() 의 icon(slcode-plugin hookApi.MESSAGE_ICONS) → ICONS 이름 */
  const NOTE_ICONS = { bell: 'bell', flag: 'flag', info: 'info', alert: 'triangleAlert', check: 'circleCheck', star: 'star', zap: 'zap', shield: 'shield' };
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
  sendBtn.append(icon('up')); addBtn.append(icon('plus')); stopBtn.append(icon('stop')); modelBtn.append(icon('chevron')); modeBtn.prepend(modeIco); modeBtn.append(icon('chevron')); sideBtn.append(icon('panel')); gearBtn.append(icon('gear')); jumpBtn.prepend(icon('down'));
  // 보낼 게 없거나(빈 입력·첨부 없음) 세션이 끝났으면 보내기 버튼을 비활성처럼 (사용자 2026-09-27)
  // 실행 중엔 보내기 자리에 중단 (사용자 2026-10-09) — 입력이나 첨부가 생기면 다시 보내기, 작업 중에도 보낼 수 있으므로
  const canSend = () => {
    const empty = !input.value.trim() && !pendingFiles.length;
    sendBtn.disabled = !current || input.disabled || empty;
    const stop = busyNow && empty;
    stopBtn.style.display = stop ? '' : 'none'; sendBtn.style.display = stop ? 'none' : '';
  };
  // 클립보드 API 는 https·localhost 에서만 있고 iframe 은 clipboard-write 권한도 필요하다 — 없으면 execCommand 로 (http://IP 로 열 때, 2026-09-27)
  // 모달(showModal) 안에서는 바깥이 inert 라 textarea 를 그 dialog 안에 둔다 (inspect 모달의 블록 복사)
  async function copyText(text, host = document.body) {
    try { if (navigator.clipboard) { await navigator.clipboard.writeText(text); return true; } } catch {}
    const ta = h('textarea', { style: 'position:fixed;top:0;left:0;opacity:0' }); ta.value = text; host.append(ta); ta.select();
    try { return document.execCommand('copy'); } finally { ta.remove(); }
  }
  const copyOf = (text) => async (e) => { const b = e.currentTarget; const ok = await copyText(text, b.closest('dialog') ?? document.body); b.replaceChildren(ok ? icon('check') : '✗'); setTimeout(() => b.replaceChildren(icon('copy')), 1200); };
  const runRewind = (seq, text, conversation, files) => rpc('session.rewind', { id: current, seq, conversation, files }).then(() => { if (conversation) { hist.reset(); input.value = text; input.oninput(); input.focus(); } });
  function rewindBtn(seq, text) {
    const row = acts(iconBtn('copy', '복사', copyOf(text)), iconBtn('rewind', '이 턴부터 되돌리기', () => ask()));
    function ask() {
      const orig = [...row.children]; // 취소는 원래 버튼을 되돌린다 — 새 줄의 버튼을 옮겨 오면 그 버튼은 떨어진 줄을 고쳐 먹통이 된다
      const go = (conversation, files) => runRewind(seq, text, conversation, files).catch((e) => push(h('div', { class: 'meta err' }, e.message)));
      row.replaceChildren(h('span', { class: 'q' }, '이 턴부터 되돌리기:'),
        h('button', { class: 'ghost', onclick: () => go(true, false) }, '답변만'), h('button', { class: 'ghost', onclick: () => go(false, true) }, '코드만'),
        h('button', { class: 'ghost', onclick: () => go(true, true) }, '둘 다'), h('button', { class: 'ghost', onclick: () => row.replaceChildren(...orig) }, '취소'));
    }
    return row;
  }
  // inspect (ticket slcode-inspect-proxy, 사용자 결정 2026-10-18) — 턴 마지막 응답 아래 '복사' 옆 버튼이 그 턴 동안 나간 API 호출 모달(inspect.js)을 연다.
  // 버튼은 inspect 를 한 번이라도 켠 세션에서만 보인다 (.inspectable). 응답 글이 없는 턴(오류·중단)은 버튼만 한 줄로
  const inspectUi = inspectDialog(h, rpc, () => status?.context?.max ?? null, (text) => iconBtn('copy', '복사', copyOf(text)), store);
  el.append(inspectUi.el);
  // 복제 (ticket slcode-session-fork, 사용자 결정 2026-11-07) — 응답 아래 버튼은 그 응답까지, /fork 는 끝난 턴까지 전체. 복제본은 같은 폴더의 별도 세션이고
  // 만들면 그리로 간다: 카드는 플러그인이 이 카드 옆에 그 카드를 연다(slcode.goto), 웹은 serve 가 띄운 복제본 화면으로
  let forking = false;
  async function fork(seq) {
    if (forking || !current) return;
    forking = true;
    const note = push(h('div', { class: 'notice' }, '복제 중…'));
    try {
      const { id } = await rpc('serve.fork', { id: current, ...(seq != null ? { seq } : {}) });
      if (viaHost) hostPost({ type: 'slcode.goto', target: id });
      else if (opts.navigate) { await loadFamily(); opts.navigate(id); } else location.assign(`s/${encodeURIComponent(id)}`);
    } catch (e) { push(h('div', { class: 'meta err' }, `복제하지 못했습니다: ${e.message}`)); }
    finally { note.remove(); forking = false; }
  }
  const forkBtn = (endSeq) => iconBtn('fork', '이 응답까지 복제', () => fork(endSeq));
  const inspectBtn = (endSeq) => { const b = iconBtn('inspect', '이 턴의 API 호출 보기', () => inspectUi.open(current, endSeq)); b.classList.add('insp'); return b; };
  const syncInspect = () => el.classList.toggle('inspectable', info?.inspect != null);
  // 사이드바 inspect 토글의 확인 창 (사용자 2026-10-19, ticket slcode-inspect-default-on) — 켜고 끄면 벤더를 다시 띄워 다음 호출의 캐시가 깨질 수 있다
  let inspectTo = false;
  const inspectMsg = h('p', {});
  const confirmInspect = h('dialog', { class: 'confirm' }, inspectMsg, h('div', { class: 'btns' },
    h('button', { onclick: () => confirmInspect.close() }, '취소'),
    h('button', { class: 'primary', onclick: () => {
      confirmInspect.close();
      rpc('session.setInspect', { id: current, on: inspectTo }).catch((e) => { push(h('div', { class: 'meta err' }, e.message)); renderSide(); });
    } }, '계속')));
  closeOnBackdrop(confirmInspect);
  el.append(confirmInspect);
  const askInspect = (on) => {
    inspectTo = on;
    inspectMsg.textContent = info?.vendor === 'codex'
      ? `inspect 를 ${on ? '켜면' : '끄면'} Codex 를 같은 대화로 다시 띄웁니다. 이 세션에서 '이번 세션만 허용' 한 승인은 사라집니다.`
      : `inspect 를 ${on ? '켜면' : '끄면'} Claude 를 같은 대화로 다시 띄웁니다. 다음 호출에서 프롬프트 캐시가 깨져 비용이 더 들 수 있고, 이 세션에서 '이번 세션만 허용' 한 승인 규칙은 사라집니다.`;
    confirmInspect.showModal();
  };
  // 메시지 턴 — 내부적으로는 사용자 턴이지만 화면은 사용자 말풍선이 아니라 왼쪽의 봉투 카드 (프로토타입, 사용자 2026-09-27).
  // 본문은 src/mail.ts formatMail 꼴 (MAIL_RE 는 그 정규식의 사본): <slcode-message id from name kind at [via] [re]>\n본문\n</slcode-message> 를 빈 줄로 이은 것.
  // via 는 실제로 넘긴 쪽 — outside 면 "세션 밖에서 보냄", 세션 id 면 "실제 발신" (ticket slcode-p2p-messaging, 2026-10-19).
  // 2026-10-19 전의 턴은 옛 머리말 "[mail <id> from <세션 id> (<제목>) at <iso> kind=<kind> re=<id>]\n답장: …" (OLD_HEAD)
  const MAIL_RE = /<slcode-message ([^>]*)>\n([\s\S]*?)\n<\/slcode-message>/g;
  const OLD_HEAD = /^\[mail (\S+) from (\S+)(?: \((.*?)\))? at (\S+) kind=(\S+)(?: re=(\S+))?\]\n(?:답장: [^\n]*\n)?/;
  const unattr = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  function mailParts(text) {
    const parts = [...text.matchAll(MAIL_RE)].map((m) => {
      const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], unattr(x[2])]));
      return { from: a.name || a.from || '?', at: a.at || '', kind: a.kind || 'message', via: a.via || '', body: m[2].replaceAll('<\\/slcode-message', '</slcode-message') };
    });
    if (parts.length) return parts;
    return text.split(/\n\n(?=\[mail )/).map((chunk) => { const m = chunk.match(OLD_HEAD); return m ? { from: m[3] || m[2], at: m[4], kind: m[5], via: '', body: chunk.slice(m[0].length) } : { from: '?', at: '', kind: 'message', via: '', body: chunk }; });
  }
  function mailCard(text, seq) {
    const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
    return h('div', { class: 'mail' }, ...mailParts(text).map((m) => h('div', { class: 'envelope' },
      h('div', { class: 'head' }, icon('mail'), h('span', { class: 'from' }, m.from), m.kind !== 'message' ? h('span', { class: 'kind' }, m.kind) : null,
        m.via ? h('span', { class: 'via' }, m.via === 'outside' ? '세션 밖에서 보냄' : `실제 발신 ${m.via}`) : null, h('span', { class: 'at' }, when(m.at))),
      h('div', { class: 'body' }, m.body))), rewindBtn(seq, text));
  }
  function setState(state) {
    pill.className = `pill ${state}`; pill.textContent = STATE_LABEL[state] ?? state;
    busyNow = state === 'running' || state === 'requires_action';
    showBusy(state === 'running');
    if (busyNow && picker.el.isConnected) showDock(); // 메시지 턴 등이 시작됐다 — session.rewind 는 idle 에서만 된다
    input.disabled = state === 'exited' || !!info?.locked; settingsUi.endable(state !== 'exited'); canSend();
    if (state !== 'exited' && exitNote) { exitNote.remove(); exitNote = null; }
    if (opts.onState) opts.onState(state);
    renderSide();
  }

  function render(e, live = false) {
    if (!replaying) { if (e.seq <= lastSeq) return; lastSeq = e.seq; }
    if (live && e.at) skew = Date.now() - e.at;
    curSeq = e.seq;
    const ev = e.ev;
    switch (ev.kind) {
      case 'turn.start': if (!turned) { turned = true; paintVendor(); paintHero(); } main.inTurn = true; main.openNodes = []; // 열 때 알림이 대화 기록으로 남는다
        if (!replaying) busySince = e.at || Date.now(); setBusy('작업 중');
        endText(); main.acts = null; // 이 턴 마지막 응답의 아이콘 줄 — turn.end 가 inspect 버튼을 붙인다
        // main.turnEl: 이 턴의 내 요청(메시지 카드) — 그 바로 다음 항목이 '답변 시작으로' 가 가는 곳 (실행 중 줄은 늘 맨 끝으로 옮겨지므로 사이에 끼지 않는다)
        if (live && !ev.origin) hist.add(e.seq, ev.text);
        if (ev.origin === 'mail') { outlineAdd(e.seq, ev, main.turnEl = push(mailCard(ev.text, e.seq))); break; }
        outlineAdd(e.seq, ev, main.turnEl = push(h('div', { class: 'user' }, h('div', { class: 'bubble' }, ev.origin ? h('span', { class: 'origin' }, ev.origin) : null,
          ev.attachments?.length ? h('div', { class: 'chips' }, ...ev.attachments.map((a) => { const local = sentFiles.get(a.name); return h('span', { class: 'chip' }, local ? h('img', { src: local }) : null, a.name); })) : null,
          ev.text), rewindBtn(e.seq, ev.text))));
        break;
      case 'text.delta': {
        const sc = scopeOf(ev.parent);
        if (!ev.parent) setBusy('작성 중');
        if (!sc.textEl) {
          if (live && !ev.parent && !follow) { unread++; paintJump(); }
          sc.textEl = push(h('div', { class: 'assistant streaming' }), sc); sc.textBuf = '';
        }
        sc.textBuf += ev.text;
        const stick = atBottom();
        sc.textEl.innerHTML = renderMarkdown(sc.textBuf, info?.cwd ?? ready?.cwd);
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
        endText(); main.inTurn = false;
        if (live) { tally(ev); loadStatus(); loadPlugins(); } // 기록의 턴은 replayHistory 가 센다 — 열 때 턴마다 status 를 부르지 않게
        // 실패한 턴은 빨간 오류 블록 — 벤더 문구, 인증 실패면 로그인 안내 한 줄. API 를 쓰지 못한 턴(통계 0)은 통계 줄을 뺀다 (ticket slcode-auth-error-shown-as-answer)
        const failed = !ev.ok && !ev.interrupted;
        if (failed) push(h('div', { class: 'errblock' }, h('div', { class: 'msg' }, h('b', {}, '오류'), ` · ${ev.error ?? ''}`),
          ev.errorKind === 'auth' ? h('div', { class: 'hint' }, 'CLI 에서 로그인하세요.') : null));
        const u = ev.usage;
        const parts = [];
        if (ev.interrupted) parts.push('중단됨');
        if (!failed || (u && u.input + u.output + u.cacheRead + u.cacheWrite > 0)) {
          if (ev.durationMs != null) parts.push(`${(ev.durationMs / 1000).toFixed(1)}s`);
          if (u) parts.push(`↑${fmtTok(u.input + u.cacheRead + u.cacheWrite)} ↓${fmtTok(u.output)}`);
          if (e.at) parts.push(new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); // 끝난 시각 — claude 의 "done 오후 9:14" 자리 (사용자 2026-10-15)
        }
        const fb = ev.uuid ? forkBtn(e.seq) : null; // 벤더 지점이 없는 턴(벤더가 뜨기 전에 실패 등)은 복제할 자리가 없다
        if (main.acts) main.acts.append(startBtn(main.turnEl?.nextElementSibling ?? main.acts.parentNode), ...(fb ? [fb] : []), inspectBtn(e.seq)); else push(h('div', { class: 'acts solo' }, ...(fb ? [fb] : []), inspectBtn(e.seq)));
        if (parts.length) push(h('div', { class: `meta${ev.interrupted ? ' err' : ''}` }, parts.join(' · ')));
        if (!replaying) renderSide();
        break;
      }
      case 'session.state': setState(ev.state); if (live) act.refresh(); break;
      // 마지막 턴 뒤의 열 때 알림(main.openNodes)은 다시 열리면 지운다 — 기록을 다시 그릴 때(앞 페이지 포함)도 같은 규칙
      case 'session.opened': main.inTurn = false; for (const n of main.openNodes ?? []) n.remove(); main.openNodes = []; break;
      case 'session.ready': ready = ev; mcp = null; renderMode(); renderSide(); if (live) loadMcp(); break;
      case 'plugins.reloaded': {
        endText();
        push(h('div', { class: 'notice' }, ['에이전트 플러그인 다시 실음', ...ev.plugins.map((p) => `${p.name} ${p.version}`), ev.removed.length ? `뗌 ${ev.removed.join(', ')}` : null].filter(Boolean).join(' · ')));
        if (ev.later.length) push(h('div', { class: 'meta' }, `새 세션부터 적용: ${ev.later.map((l) => `${l.name} ${l.what.map((w) => LATER[w] ?? w).join('·')}`).join(', ')}`));
        if (live && ready) { ready = { ...ready, plugins: ev.sdk.plugins, slashCommands: ev.sdk.commands, agents: ev.sdk.agents, mcp: ev.sdk.mcp }; mcp = null; renderSide(); }
        if (live) loadCommands(); // 다시 실은 플러그인의 명령
        break;
      }
      case 'session.imported': // 표지는 옮겨 온 대화 뒤에 선다 (사용자 2026-10-15: 짧게). slcode 복제본의 표지는 복제 지점 (ticket slcode-session-fork)
        push(ev.fork && info?.parent?.kind === 'fork' ? forkMark(info.parent.id) : h('div', { class: 'notice' }, `imported from ${ev.vendor} (${ev.vendorSessionId.slice(0, 8)})`)); break;
      case 'context.compacted': endText(); push(h('div', { class: 'notice' }, `컨텍스트 압축${ev.preTokens ? ` · ${fmtTok(ev.preTokens)}` : ''}`)); break;
      case 'hook': if (live) { hooks++; lastHook = `${ev.event} ${ev.phase}`; } break;
      case 'agent.hook': { // 에이전트 플러그인 js/ts 훅 (ticket slcode-agent-plugin-hooks) — 한 일이 있을 때만 그린다 (사용자 2026-10-30, 프로토타입 D)
        const who = (x) => `${ev.plugin} · ${x}`;
        if (ev.phase === 'ready') { for (const x of ev.errors) push(h('div', { class: 'meta err', title: who('스크립트') }, `${ev.plugin} 훅: ${x}`)); break; }
        if (ev.phase === 'warn') { push(h('div', { class: 'meta err' }, `${ev.plugin} 훅: ${ev.text}`)); break; }
        hookRun(ev);
        break;
      }
      case 'agent.command': endText(); commandRun(ev); if (live && ev.phase !== 'attached') hist.add(e.seq, `/${ev.name}${ev.args ? ` ${ev.args}` : ''}`); break;
      case 'error': endText(); push(h('div', { class: 'meta err' }, ev.message)); break;
      case 'review': {
        endText();
        const what = [`AI 검토 ${REVIEW[ev.decision] ?? ev.decision}`, ev.risk && `위험 ${RISK[ev.risk] ?? ev.risk}`, ev.action, ev.rationale].filter(Boolean).join(' · ');
        push(h('div', { class: ev.decision === 'approved' ? 'notice' : 'meta err' }, what));
        break;
      }
      // 종료 줄은 꺼진 동안만 — 기록을 다시 그릴 땐 빼고, 세션이 다시 살아나면(setState) 지운다 (사용자 2026-10-11)
      case 'session.exit': endText(); if (live) exitNote = push(h('div', { class: 'meta' }, `세션 종료: ${ev.reason}`)); break;
      case 'turn.rewound': {
        endText();
        if (ev.conversation) { // 코드만 되돌리면 대화는 그대로다 — 벤더 쪽 대화도 남아 있다 (Claude Code 실측 2026-11-03)
          for (const n of [...col.children, ...(replaying ? [] : older.children)]) if (Number(n.dataset.seq) >= ev.seq) n.remove();
          if (!replaying) backlog = backlog.filter((b) => b.seq < ev.seq);
          outlineCut(ev.seq, e.seq);
          hist.cut(ev.seq, e.seq);
          for (const [k, sc] of subs) if (!sc.col.isConnected) subs.delete(k);
          for (const [k, t] of tasks) if (!t.card.isConnected) tasks.delete(k);
        }
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
    // 칩 줄 없이 — 승인은 도구 이름, 질문은 서브에이전트 출처가 있을 때만 머리 줄 (사용자 2026-11-08)
    const card = h('div', { class: isQ ? 'card ask' : 'card' }, !isQ || from ? h('div', { class: 'head' }, isQ ? null : h('span', {}, req.name), from) : null);
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
    for (const c of cards.values()) c._mark?.classList.toggle('docked', c === next); // 떠 있는 카드의 피드 호출 표식은 숨긴다
    dock.replaceChildren(next ?? '');
    composer.hidden = !!next;
    if (next) { next.classList.add('live'); if (hadFocus) next.focus({ preventScroll: true }); }
    else if (hadFocus) input.focus();
  }
  function buildApproval(card, req) {
    const arg = toolArg(req.name, req.input);
    if (arg) card.append(h('pre', {}, arg));
    if (!(req.input && typeof req.input === 'object' && Object.keys(req.input).length === 1 && arg)) card.append(h('details', { class: 'chev in' }, h('summary', {}, '입력'), h('pre', {}, JSON.stringify(req.input, null, 2))));
    // 거절(Esc·버튼)은 Claude Code 처럼 턴도 끝낸다 (ticket slcode-question-esc-chat, 사용자 2026-11-08)
    const decide = (decision, remember) => rpc('session.approve', { id: current, requestId: req.requestId, decision, remember, ...(decision === 'deny' ? { interrupt: true } : {}) });
    card.tabIndex = 0;
    card.onkeydown = (e) => { if (e.target !== card) return; if (e.key === 'Enter') { e.preventDefault(); decide('allow', e.shiftKey); } else if (e.key === 'Escape') { e.preventDefault(); decide('deny', false); } };
    card.append(h('div', { class: 'btns' },
      h('button', { class: 'primary', title: 'Enter', onclick: () => decide('allow', false) }, '허용'),
      h('button', { title: 'Shift+Enter', onclick: () => decide('allow', true) }, '세션 동안 허용'),
      h('button', { class: 'danger', title: 'Esc', onclick: () => decide('deny', false) }, '거절'),
    ));
  }
  // 질문 카드 — Claude Code TUI 를 따른다 (사용자 2026-09-28): 질문마다 탭, 마지막 탭은 제출(답변 검토), 'Chat about this' 는 선택지 목록 맨 아래 구분선 밑 항목 (사용자 2026-11-08).
  // 질문이 하나면 탭 없이 헤더 칩만, 단일 선택은 고르는 즉시 제출.
  function buildQuestion(card, req) {
    const qs = req.input?.questions ?? [];
    const state = qs.map(() => ({ picked: new Set(), other: '', otherSet: false, cur: 0 })); // otherSet — 단일 선택에서 직접 입력을 Enter 로 확정했다
    const answerOf = (qi) => { const a = [...state[qi].picked]; if (state[qi].other.trim()) a.push(state[qi].other.trim()); return a; };
    const multi = qs.length > 1;
    let tab = 0; // 0..qs.length-1 질문, qs.length = 제출
    const done = () => { card.classList.remove('live'); };
    const send = () => {
      const answers = {};
      qs.forEach((q, qi) => { answers[q.question] = answerOf(qi).join(', '); });
      rpc('session.approve', { id: current, requestId: req.requestId, decision: 'allow', updatedInput: { ...req.input, answers } }); done();
    };
    // Esc — Claude Code 의 cancel: 질문을 닫고 턴을 끝낸다. 대기는 cancelled('취소됨'), 모델이 받는 글은 각 벤더의 중단 기록과 같다 (ticket slcode-question-esc-chat, 실측 2026-11-08)
    const cancel = () => { rpc('session.interrupt', { id: current }); done(); };
    // 'Chat about this' — Claude Code 와 같은 피드백으로 deny 한다 (cli 2.1.319 Oht): 모델이 무엇을 명확히 할지 먼저 묻고 기다린다. 거절 앞말은 Claude 어댑터가 붙인다
    const chat = () => {
      if (card.classList.contains('resolved')) return;
      // 원본의 답 (2.1.319 실측): 다중 선택은 고른 순서 + 직접 입력(Enter 전이어도), 단일 선택은 Enter 로 확정한 직접 입력, 아니면 고른 선택지
      const told = (q, qi) => { const st = state[qi]; return q.multiSelect ? answerOf(qi).join(', ') : st.otherSet && st.other.trim() ? st.other.trim() : [...st.picked][0] ?? ''; };
      const asked = qs.map((q, qi) => `- "${q.question}"\n  ${told(q, qi) ? `Answer: ${told(q, qi)}` : '(No answer provided)'}`).join('\n');
      const message = `The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n${asked}`;
      rpc('session.approve', { id: current, requestId: req.requestId, decision: 'deny', message }); done();
    };
    const strip = h('div', { class: 'tabs' });
    const panel = h('div', { class: 'panel' });
    const show = (i) => { tab = Math.max(0, Math.min(i, multi ? qs.length : 0)); draw(); };
    let items = []; // 현재 패널에서 ↑↓ 로 오가는 것들 — 선택지 label 들 + 직접 입력 + Chat about this
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
      const opts = (q.options ?? []).map((o, oi) => {
        const inp = h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name, value: o.label, tabindex: -1, checked: st.picked.has(o.label) ? '' : null });
        inp.onchange = () => {
          if (q.multiSelect) { if (inp.checked) st.picked.add(o.label); else st.picked.delete(o.label); }
          else { st.picked = new Set([o.label]); st.otherSet = false; if (!multi) return send(); show(qi + 1); }
        };
        return h('label', {}, inp, h('span', { class: 'n' }, `${oi + 1}.`), h('span', {}, h('div', {}, o.label), o.description ? h('div', { class: 'd' }, o.description) : null));
      });
      const other = h('input', { type: 'text', placeholder: '직접 입력', value: st.other });
      other.oninput = () => { st.other = other.value; };
      other.onkeydown = (e) => {
        if (e.key === 'Escape' || (e.key === 'ArrowUp' && !other.value)) { e.preventDefault(); card.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); st.cur = opts.length + 1; mark(qi); card.focus(); } // 아래의 Chat about this 로
        else if (e.key === 'Enter' && other.value.trim()) { e.preventDefault(); st.otherSet = true; if (!multi) send(); else show(qi + 1); }
      };
      other.onfocus = () => { st.cur = opts.length; mark(qi); };
      const talk = h('div', { class: 'talk', onclick: chat }, 'Chat about this');
      items = [...opts, other, talk]; mark(qi);
      const pane = h('div', { class: 'q' }, h('div', { class: 'qt' }, q.question), ...opts, other, h('div', { class: 'sep' }), talk);
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
    // 키보드 — 카드 자체에 포커스가 있을 때: ←→ 탭, ↑↓ 선택지, Enter 고르기·제출(Chat about this 면 채팅으로), Esc 질문 취소·턴 종료 (TUI 와 같게)
    card.tabIndex = 0; card.classList.add('live');
    card.onkeydown = (e) => {
      if (e.target !== card) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') { if (multi) show(tab + (k === 'ArrowRight' ? 1 : -1)); }
      else if (k === 'ArrowUp' || k === 'ArrowDown') { if (tab < qs.length && items.length) { const st = state[tab]; st.cur = Math.max(0, Math.min(items.length - 1, st.cur + (k === 'ArrowDown' ? 1 : -1))); mark(tab); items[st.cur].scrollIntoView({ block: 'nearest' }); } }
      else if (k === 'Enter') { if (tab >= qs.length) return void send(); const el = items[state[tab].cur]; if (!el) return; if (el.tagName === 'LABEL') { const inp = el.querySelector('input'); if (inp.type === 'checkbox') inp.checked = !inp.checked; else inp.checked = true; inp.dispatchEvent(new Event('change')); } else if (el.tagName === 'INPUT') el.focus(); else el.click(); }
      else if (k === 'Escape') cancel();
      else if (k === 'Tab') return; // 브라우저 기본 포커스 이동
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { const el = items.find((x) => x.tagName === 'INPUT'); if (el) { el.focus(); return; } } // 글자를 치면 직접 입력으로
      else return;
      e.preventDefault();
    };
    draw();
    card.append(strip, panel);
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
  // 작성창 아래 한 줄 — 📁폴더 🌿repo(브랜치) ⌛플랜 리밋(5h·1w 막대·남은 시간) 📦ctx 누적 비용, 묶음 사이는 · 없이 간격만. 사이드바 위에서 옮겼다 (사용자 2026-10-13, 짧은 꼴은 2026-10-14).
  // 폴더는 올리면 전체 경로 복사, repo 는 git 안일 때만. 모르는 리밋·context 는 뺀다. 리밋 막대는 세로 기둥으로 쓴 양을 채우고, % 는 올리면 작은 툴팁으로 (사용자 2026-09-30, 세로는 2026-10-14)
  function renderStat() {
    const cwd = info?.cwd ?? ready?.cwd ?? '';
    const lim = (label, w) => w && h('span', { class: 'lim' + (w.pct >= 90 ? ' hot' : '') }, h('span', {}, label),
      h('span', { class: 'track' }, h('span', { class: 'bar' }, h('i', { style: `height:${Math.min(100, w.pct ?? 0)}%` })), h('span', { class: 'v' }, w.pct != null ? `${Math.round(w.pct)}%` : '—')),
      h('span', {}, fmtReset(w.resetsAt)));
    const grp = (name, ...kids) => h('span', { class: 'grp' }, icon(name), ...kids);
    const lims = [lim('5h', status?.limits?.fiveHour), lim('1w', status?.limits?.sevenDay)].filter(Boolean);
    const ctx = status?.context;
    // 비용에 올리면 총 소모 토큰 — 리밋처럼 작은 툴팁 (사용자 2026-10-13). 입력 = 캐시 읽기 + 캐시 쓰기 + 그 외.
    // Codex 의 input 은 캐시 읽기를 이미 포함한다 (OpenAI 계열 usage), Claude 의 input 은 캐시를 뺀 나머지다
    const other = (info?.vendor ?? ready?.vendor) === 'codex' ? Math.max(0, usage.input - usage.cacheRead) : usage.input;
    const kv = (k, n, sub) => [h('span', { class: sub ? 'sub' : '' }, k), h('span', {}, fmtTok(n))];
    const tok = h('span', { class: 'v tok' }, kv('입력', other + usage.cacheRead + usage.cacheWrite), kv('캐시 읽기', usage.cacheRead, true), kv('캐시 쓰기', usage.cacheWrite, true), kv('그 외', other, true), kv('출력', usage.output));
    // 줄 끝에 있으면 툴팁이 화면 오른쪽 밖으로 나간다 — 올릴 때 재서 안쪽으로 민다
    const fit = () => { tok.style.left = ''; const over = tok.getBoundingClientRect().right - (document.documentElement.clientWidth - 8); if (over > 0) tok.style.left = `${-over}px`; };
    stat.replaceChildren(...[
      cwd && h('span', { class: 'grp where' }, icon('folder'), h('span', { class: 'name', title: cwd }, cwd.split('/').filter(Boolean).pop() ?? cwd), iconBtn('copy', '전체 경로 복사', copyOf(cwd))),
      status?.repo && h('span', { class: 'grp where' }, icon('branch'), h('span', { class: 'name' }, status.repo, status.branch ? h('span', { class: 'dim' }, ` (${status.branch})`) : '')),
      lims.length && grp('hourglass', ...lims),
      ctx && grp('box', h('span', { title: `${fmtTok(ctx.tokens)} / ${fmtTok(ctx.max)}` }, 'ctx ', h('b', { class: ctxLevel(ctx.pct, settings.context) }, `${Math.round(ctx.pct)}%`))),
      h('span', { class: 'grp cost', onmouseenter: fit }, icon('coin'), h('span', {}, usage.turns && !costKnown ? '—' : usage.cost ? `$${usage.cost.toFixed(2)}` : '$0'), tok), // 턴이 있는데 비용을 모르면(가격표에 없는 Codex 모델) —
    ].filter(Boolean));
  }
  // ---- 같은 가족의 세션 (ticket slcode-web-session-url) — 웹은 링크(같은 탭, Ctrl+클릭은 새 탭), 카드는 플러그인에 그 카드로 옮겨 달라고 한다
  const famName = (s) => s.title || s.id;
  const famGo = (s, cls, ...kids) => h('a', { class: cls, href: viaHost ? '#' : `s/${encodeURIComponent(s.id)}`, onclick: (e) => {
    if (!viaHost && (!opts.navigate || e.ctrlKey || e.metaKey || e.shiftKey)) return; // 새 탭·새 창은 브라우저 몫
    e.preventDefault();
    if (famMenu.matches(':popover-open')) famMenu.hidePopover();
    if (viaHost) hostPost({ type: 'slcode.goto', target: s.id }); else opts.navigate(s.id);
  } }, ...kids);
  function famRows() {
    const depth = new Map();
    return family.sessions.map((s) => {
      const d = depth.has(s.parent?.id) ? depth.get(s.parent.id) + 1 : 0;
      depth.set(s.id, d);
      return famGo(s, `fam-row${s.id === current ? ' cur' : ''}${s.live ? '' : ' off'}`,
        h('span', { class: 'fam-indent', style: `width:${d * 14}px` }),
        h('span', { class: 'fam-name' }, famName(s)),
        s.id === family.main ? h('span', { class: 'fam-tag' }, '메인') : s.parent ? h('span', { class: 'fam-tag' }, s.parent.kind === 'fork' ? '복제' : '팀원') : null,
        s.live ? null : h('span', { class: 'fam-tag' }, '꺼짐'));
    });
  }
  // 복제본의 복제 지점 표지 (ticket slcode-session-fork, 사용자 2026-11-08) — forked from <원본 이름> (<원본 id>), id 는 가족 메뉴와 같은 링크.
  // 이름은 가족 목록에서 — 목록이 표지보다 늦게 오면 받은 뒤 다시 그린다. 이름이 없는 세션은 id 만
  const forkMarks = new Set();
  function paintForkMark(el) {
    const title = family?.sessions.find((s) => s.id === el._pid)?.title;
    el.replaceChildren('forked from ', ...(title ? [`${title} (`] : []), famGo({ id: el._pid }, 'fork-src', el._pid), ...(title ? [')'] : []));
  }
  function forkMark(pid) { const el = h('div', { class: 'notice' }); el._pid = pid; paintForkMark(el); forkMarks.add(el); return el; }
  function paintFamily() {
    for (const el of forkMarks) paintForkMark(el);
    const many = (family?.sessions.length ?? 0) > 1;
    famBtn.hidden = !many;
    if (many) { famBtn.textContent = `세션 ${family.sessions.length} ▾`; famBtn.title = '관련 세션'; famMenu.replaceChildren(...famRows()); }
  }
  async function loadFamily() {
    let r;
    try { r = await rpc('serve.sessions'); } catch { return; }
    if (JSON.stringify(r) === JSON.stringify(family)) return;
    family = r; paintFamily(); paintLock();
    if (refused && r.sessions.some((s) => s.id === refused && s.live)) location.reload(); // 안내를 보던 세션이 다시 켜졌다
  }
  setInterval(() => { if (connected && !document.hidden && !behind()) void loadFamily(); }, 5000);
  // ---- 팀원 세션 (ticket slcode-team-agent, 사용자 2026-11-08) — 입력 제어 중인 팀원: 입력 상자는 흐리고 가운데 자물쇠만 눌린다. 어느 세션이 쥐었는지는 세션 메뉴에서 본다
  //      (입력창 위의 리더 줄은 사용자가 뺐다 — "another session" 은 자물쇠에만).
  // 자물쇠 → 확인 창 → 끊기(session.unlock, 일방향 — 되돌리는 버튼은 없다). 끊은 뒤와 입력 제어가 없는 팀원은 보통 세션처럼 보인다. 승인 카드는 잠금 중에도 눌린다(입력창 자리에 뜬다).
  // 웹·카드·1단 카드가 이 화면을 같이 쓴다
  const confirmCut = h('dialog', { class: 'confirm cut' },
    h('h2', {}, 'Cut from another session?'),
    h('p', {}, '이 세션을 직접 다루게 됩니다. 되돌릴 수 없습니다.'),
    h('ul', {}, h('li', {}, 'another session 은 이 세션에 더 이상 지시하지 못합니다.'), h('li', {}, '이 세션의 답과 질문은 another session 에 가지 않습니다.'), h('li', {}, '메시지는 계속 주고받을 수 있습니다.')),
    h('div', { class: 'btns' },
      h('button', { onclick: () => confirmCut.close() }, '취소'),
      h('button', { class: 'danger', onclick: () => {
        confirmCut.close();
        rpc('session.unlock', { id: current }).catch((e) => push(h('div', { class: 'meta err' }, e.message)));
      } }, '끊기')));
  closeOnBackdrop(confirmCut);
  el.append(confirmCut);
  lockOver.append(h('button', { title: 'Cut from another session', onclick: () => confirmCut.showModal() }, icon('lock'), h('span', {}, 'Controlled by another session')));
  function paintLock() {
    const locked = !!info?.locked;
    composer.classList.toggle('locked', locked);
    for (const b of [addBtn, modeBtn, modelBtn, stopBtn]) b.disabled = locked;
    input.disabled = info?.state === 'exited' || locked;
    lockOver.hidden = !locked;
    canSend(); paintHero();
  }
  // 리더: 팀원의 대기 승인 (사용자 결정 3) — 입력창 위에 "팀원 <이름>" 한 줄씩. 도구 승인은 여기서 [허용]·[거부], 질문은 부모 모델이 답하므로 [열기] 만
  function paintKids(list) {
    const rows = [];
    for (const k of list ?? []) for (const req of k.pending) {
      const isQ = req.name === 'AskUserQuestion';
      const row = h('div', { class: 'kid-ask' });
      const decide = (decision) => () => {
        for (const b of row.querySelectorAll('button')) b.disabled = true;
        rpc('session.childApprove', { id: current, child: k.id, requestId: req.requestId, decision }).catch((e) => { for (const b of row.querySelectorAll('button')) b.disabled = false; push(h('div', { class: 'meta err' }, e.message)); });
      };
      row.append(h('span', { class: 'kind' }, isQ ? '질문' : '승인'), h('span', { class: 'who' }, `팀원 ${famName(k)}`),
        h('span', { class: 'what' }, isQ ? '부모 모델이 답합니다' : `${req.name} ${toolArg(req.name, req.input)}`), h('span', { class: 'gap' }),
        ...(isQ ? [] : [h('button', { class: 'primary', onclick: decide('allow') }, '허용'), h('button', { onclick: decide('deny') }, '거부')]),
        famGo(k, 'kid-open', '열기'));
      rows.push(row);
    }
    kidAsks.hidden = !rows.length;
    kidAsks.replaceChildren(...rows);
  }
  const loadKids = () => rpc('session.children', { id: current }).then((r) => paintKids(r.children), () => paintKids([])); // 옛 core 엔 없다

  /** 주소가 가리키는 세션을 열 수 없다 — 그 세션을 열지 않고 사유와 메인 세션 링크를 보인다. 다른 세션으로 말없이 옮기지 않는다 */
  function refuseSession(id, me) {
    setState('exited');
    if (!me) pill.textContent = '열 수 없음'; // 그 세션이 끝난 것이 아니다
    if (refused === id) return; // 다시 붙을 때마다 쌓이지 않게
    refused = id;
    const main = family.sessions.find((s) => s.id === family.main);
    push(h('div', { class: 'meta err fam-refused' }, me ? `꺼진 세션입니다: ${famName(me)}` : `이 화면에서 열 수 없는 세션입니다: ${id}`, ' ', main ? famGo(main, 'fam-back', `메인 세션 열기 (${famName(main)})`) : null));
  }

  function renderSide() {
    renderStat(); // 남은 시간도 사이드바를 다시 그릴 때 같이 다시 잰다
    side.innerHTML = '';
    // claude 상태줄과 같은 줄거리 중 💻모델 (폴더·repo·리밋·context·비용은 작성창 아래). 값은 SDK 가 주는 때(attach·turn.end)만 갱신 (사용자 2026-09-30)
    const row = (name, ...kids) => h('div', { class: 'row' }, icon(name), ...kids);
    side.append(h('div', { class: 'top' },
      row('cpu', h('span', {}, modelName || ready?.model || '—')),
    ));
    const kv = (rows) => h('div', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('span', { class: 'k' }, k), h('span', { class: 'v' }, v ?? '—')]));
    const sec = (key, label, body, extra) => {
      const d = h('details', { class: 'sec', open: folded.has(key) ? null : '' }, h('summary', {}, h('h4', {}, label), extra ?? '', icon('chevron')), h('div', { class: 'body' }, body));
      d.addEventListener('toggle', () => { if (d.open) folded.delete(key); else folded.add(key); });
      return d;
    };
    // 활동 기록 — 모델 줄 아래, 기본으로 펼친다 (ticket slcode-activity-state). 칸 안은 activity.js 가 따로 다시 그린다
    side.append(sec('activity', '활동 기록', act.body, act.more));
    if (tasks.size) side.append(h('div', { class: 'tasks' }, h('h4', {}, `에이전트 ${tasks.size}`), ...[...tasks.values()].map(({ card, ev }) => {
      const u = ev.usage;
      return h('a', { onclick: () => { card.open = true; card.scrollIntoView({ block: 'center' }); } },
        h('span', { class: 'dot' }), h('span', { class: 'name' }, ev.agentType ?? 'task'), h('span', { class: 'desc' }, ev.description),
        h('span', { class: 'dim' }, [u ? `${(u.durationMs / 1000).toFixed(0)}s · ${fmtTok(u.tokens)}` : null, ev.lastTool].filter(Boolean).join(' · ')),
        ev.summary ? h('span', { class: 'sum' }, ev.summary) : null);
    })));
    side.append(sec('session', '세션', kv([
      ['상태', STATE_LABEL[info?.state] ?? ''], ['id', current ? h('span', { class: 'idv' }, current, iconBtn('copy', '세션 id 복사', copyOf(current))) : null],['벤더 세션', info?.vendorSessionId ?? ready?.vendorSessionId], ['권한 모드', modeName(info?.permissionMode ?? ready?.permissionMode)],
      ['연결', connected ? '연결됨' : '끊김'], ['raw', info?.raw ? '켬' : '끔'],
      // inspect 토글 — 켜고 끄면 벤더(claude·codex)를 같은 대화로 다시 띄운다 (idle 일 때만). 값은 session.changed 로 온다
      ...(info ? [['inspect', h('button', { class: 'ghost', title: `켜거나 끄면 ${info.vendor} 를 같은 대화로 다시 띄웁니다 (대기 중일 때만)`, disabled: info.state === 'idle' || info.state === 'starting' ? null : '',
        onclick: () => askInspect(!info.inspect) }, info.inspect ? '켬' : '끔')]] : []),
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
    // failed 는 사유(있으면)와 다시 연결 버튼 — 다시 연결은 그 서버 하나만, 세션·대화는 그대로
    const mcpItem = (m) => m.status !== 'failed' ? `${m.name} (${m.status})` : h('div', { class: 'mcpf' },
      h('span', { class: 'nm' }, `${m.name} (${mcpBusy === m.name ? '다시 연결 중' : 'failed'})`),
      h('button', { class: 'ico', title: '다시 연결', 'aria-label': '다시 연결', disabled: mcpBusy ? '' : null, onclick: () => retryMcp(m.name) }, icon('retry')),
      m.error ? h('div', { class: 'why' }, m.error) : null);
    // 에이전트 플러그인 — 실은 것과 지금 설정이 다르면 다시 싣기 (다음 턴 전에 적용, 지시문은 새 세션부터)
    // 시작 프로필(ticket slcode-session-profile)은 default 가 아닐 때만 맨 위 줄로 — 실은 플러그인이 없어도(bare) 칸을 보인다. 옛 core 는 profile 이 없다
    const profile = plugs?.profile && plugs.profile !== 'default' ? plugs.profile : null;
    if (plugs && (plugs.plugins.length || plugs.added.length || profile)) {
      const stale = plugs.plugins.some((p) => p.current !== p.build);
      side.append(sec('agentPlugins', '에이전트 플러그인', h('div', { class: 'plugs' },
        kv([...(profile ? [['프로필', profile]] : []), ...plugs.plugins.map((p) => [h('span', { title: p.values }, `${p.name} ${p.version}`), p.current == null ? '지워짐' : p.current === p.build ? '최신' : '설정 바뀜']),
          ...plugs.added.map((n) => [n, '새 세션부터'])]),
        plugs.plugins.length || plugs.added.length ? h('button', { disabled: !stale || plugBusy || plugs.pending ? '' : null, title: ready?.vendor === 'codex' ? '바뀐 skill 을 이 세션에 다시 싣습니다. MCP·지시문·bin·env 는 새 세션부터 적용됩니다' : '바뀐 part·옵션을 이 세션에 다시 싣습니다. 지시문은 새 세션부터 적용됩니다', onclick: reloadPlugins },
          plugs.pending ? '턴이 끝나면 다시 싣습니다' : plugBusy ? '다시 싣는 중…' : '다시 싣기') : null)));
    }
    side.append(sec('loaded', '로드됨', ready
      ? h('div', {}, list('tools', '도구', ready.tools), list('skills', '스킬', ready.skills), list('plugins', '플러그인', ready.plugins, (p) => p.name), list('mcp', 'MCP', mcp ?? ready.mcp, mcpItem), list('slash', '슬래시 명령', ready.slashCommands), list('agents', '에이전트', ready.agents))
      : h('div', { class: 'empty' }, '첫 턴 뒤')));
    side.append(sec('hooks', '훅', kv([['실행', String(hooks)], ['마지막', lastHook || '—']])));
  }

  // ---- 이력: 마지막 몇 턴만 먼저 그리고, 위로 올리면 앞 턴을 붙인다 (사용자 2026-10-04, 이력 2759건에 1.2s)
  // 옛 턴은 화면만 만든다 — 사용량·훅·상태는 미리 센다. 연속된 delta 는 한 조각으로 합친다 (조각마다 마크다운 전체를 다시 그렸다)
  // 기록은 서버에서 페이지로 받는다 (ticket slcode-history-paging, 사용자 2026-10-17): 처음엔 끝 PAGE 개(그릴 것 + 버퍼), 그 뒤로는 미리 받은 버퍼가
  // 화면 두 번 분량 아래로 줄면 그 앞 페이지를 받아 둔다. 합계는 서버 요약으로. 옛 core 는 limit 을 모르고 전체를 보낸다 (summary 없음)
  const CHUNK = 300; // ponytail: 이벤트 수로 자른다, 턴 하나가 아주 길면 그 턴은 통째로
  const PAGE = CHUNK * 2;
  let backlog = [];
  let more = false, oldest = 0, fetching = null; // more: 서버에 앞 기록이 더 있다, oldest: 받은 것 중 가장 앞 seq, fetching: 받는 중인 약속
  // 끝에서 CHUNK 개 안의 가장 앞 자름 지점, 없으면 그 너머의 첫 지점, 그것도 없으면 전부
  function pickCut(a) {
    let cut = 0;
    for (let i = a.length - 1, n = 0; i >= 0; i--, n++) { if (cuts.has(a[i].seq)) cut = i; if (n >= CHUNK && cut) break; }
    return cut;
  }
  const cuts = new Set(); // 자를 수 있는 turn.start 의 seq — 열린 도구·승인·서브에이전트가 없을 때만 (작업 중에 보낸 메시지는 앞 턴 카드를 이어 쓴다)
  // 받은 기록(전체 또는 자름 지점에서 시작하는 한 페이지)을 그릴 단위로 — 되돌린 턴을 빼고 delta 를 합치고 자름 지점을 모은다
  function prepare(history) {
    const evs = [];
    let exited = false; // 종료 뒤의 오류는 같이 죽은 벤더의 종료 코드(exit 143) — 옛 기록에 남아 있어 뺀다 (사용자 2026-10-11)
    for (const e of history) {
      const k = e.ev.kind, last = evs[evs.length - 1];
      if (k === 'session.exit') exited = true; else if (k !== 'session.state' && k !== 'error') exited = false;
      if (k === 'error' && exited) continue;
      // 되돌린 턴은 미리 뺀다. 끝 이벤트는 화면을 안 만들고 앞 카드를 갱신하므로 남긴다 (되살아난 승인 카드가 대기로 남았다)
      if (k === 'turn.rewound' && e.ev.conversation) { const keep = evs.filter((x) => x.seq < e.ev.seq || x.ev.kind === 'tool.end' || x.ev.kind === 'approval.resolved'); evs.length = 0; evs.push(...keep); }
      if ((k === 'text.delta' || k === 'thinking.delta') && last?.ev.kind === k && last.ev.parent === e.ev.parent) { evs[evs.length - 1] = { ...e, ev: { ...e.ev, text: last.ev.text + e.ev.text } }; continue; }
      evs.push(e);
    }
    const open = new Set();
    for (const { seq, ev } of evs) {
      if (ev.kind === 'turn.start' && !open.size) cuts.add(seq);
      else if (ev.kind === 'session.exit') open.clear(); // 서버 historyPage 와 같은 규칙
      else if (ev.kind === 'tool.start') open.add(ev.toolUseId);
      else if (ev.kind === 'tool.end') open.delete(ev.toolUseId);
      else if (ev.kind === 'approval.requested') open.add(ev.requestId);
      else if (ev.kind === 'approval.resolved') open.delete(ev.requestId);
      else if (ev.kind === 'task') open[ev.phase === 'ended' ? 'delete' : 'add'](ev.taskId);
    }
    return evs;
  }
  function replayHistory(history, summary) {
    const evs = prepare(history);
    const cut = lastSeq ? 0 : pickCut(evs); // 재접속(since)이면 새 것만 오므로 전부 그린다
    backlog = backlog.concat(evs.slice(0, cut));
    if (!summary) for (const e of history) { // 되돌려져 안 그리는 턴도 사용량엔 든다
      if (e.ev.kind === 'turn.end') tally(e.ev);
      else if (e.ev.kind === 'hook') { hooks++; lastHook = `${e.ev.event} ${e.ev.phase}`; }
      else if (e.ev.kind === 'session.ready') { ready = e.ev; }
    }
    for (const e of evs.slice(cut)) render(e);
    if (summary?.turns || history.some((e) => e.ev.kind === 'turn.start')) { turned = true; paintVendor(); paintHero(); } // 되돌린 턴·그리지 않은 앞 페이지도 첫 메시지다
    if (summary) { // 서버가 센 기록 전체 — 그린 페이지의 session.ready 보다 뒤의 것(되돌린 턴 안)일 수 있어 그린 뒤에
      const u = summary.usage;
      Object.assign(usage, { turns: summary.turns, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: summary.costUsd ?? 0 });
      costKnown = summary.costUsd != null; costLast = summary.lastCostUsd ?? 0; costBase = (summary.costUsd ?? 0) - costLast;
      hooks = summary.hooks; lastHook = summary.lastHook ?? '';
      if (summary.ready) ready = summary.ready;
    }
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
    renderSide(); rearm(); prefetch();
  }
  // 버퍼가 화면 두 번 분량 아래면 그 앞 페이지를 받아 둔다 — 위로 올리는 동안 기다리지 않게. 받은 뒤 표지가 보이고 있으면 rearm 이 바로 붙인다
  // 받는 중이면 그 약속을 돌려준다 — 요청 목록의 옛 요청 이동(loadUntil)이 기다린다
  function prefetch() {
    if (!more || fetching || backlog.length >= PAGE || !current) return fetching;
    return fetching = (async () => {
      try {
        const r = await rpc('session.history', { id: current, before: oldest, limit: PAGE });
        more = r.more;
        if (r.history.length) { oldest = r.history[0].seq; backlog = prepare(r.history).concat(backlog); }
      } catch (e) { if (e.code !== 'closed') more = false; return; } // 끊김이면 재접속의 attach 가 다시 부른다. 그 밖의 실패는 다시 불러도 같으니 멈춘다
      finally { fetching = null; }
      rearm(); prefetch();
    })();
  }
  // 맨 위 표지가 보이면 앞 턴을 붙인다. 붙인 뒤에도 계속 보이면 교차 상태가 안 바뀌어 콜백이 없으므로 다시 건다
  const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) requestAnimationFrame(loadOlder); }, { root: feed, rootMargin: '600px 0px 0px 0px' });
  const rearm = () => { io.unobserve(sentinel); if (backlog.length) io.observe(sentinel); };

  // ---- 지난 요청 목록 (ticket slcode-prompt-outline, chatgpt.com 의 prompt navigator 참조) — 대화 열 왼쪽 여백에 사용자 요청을 줄마다 하나씩.
  // 목록은 서버가 attach 때 기록 전체에서 준다(prompts) — 아직 받지 않은 옛 요청도 보이고, 누르면 그 자리까지 앞 기록을 이어 그린 뒤 옮긴다.
  // 옛 core 는 prompts 가 없다 — 그린 요청만 모인다. 지금 항목 = 화면 위 35% 선을 마지막으로 지난 요청(지금 읽는 답의 질문), 바닥이면 마지막 요청
  const outline = []; // { seq, origin, text, files, node } — seq 순
  const outlineAt = new Map();
  let outlineCur = -1, navTok = 0;
  // 접기 — 처음엔 접혀 제목줄만 보인다(대화 옆이 어수선하다). 펼침은 이 화면에서만 — 저장하지 않는다 (사용자 결정)
  const navCount = h('span', {});
  const navHead = h('button', { class: 'head', 'aria-expanded': 'false', onclick: () => setFolded(!nav.classList.contains('folded')) }, navCount, icon('chevron'));
  const navList = h('div', { class: 'list', role: 'list' });
  const nav = h('nav', { class: 'outline folded', 'aria-label': '지난 요청', hidden: '' }, navHead, navList);
  function setFolded(on) {
    nav.classList.toggle('folded', on); navHead.setAttribute('aria-expanded', String(!on));
    if (!on) centerCur(true);
  }
  center.append(nav);
  const promptHead = (it) => {
    if (it.origin === 'mail') { const m = mailParts(it.text)[0]; return { mail: true, text: `${m.from}: ${m.body.trim().split('\n')[0]}` }; }
    const line = it.text.trim().split('\n').find((l) => l.trim()) ?? '';
    if (!line && it.files.length) return { files: true, text: `첨부 ${it.files.length}개 · ${it.files[0]}` };
    return { text: line, slash: /^\/\S+/.exec(line)?.[0] };
  };
  function itemEl(it, i) {
    const p = promptHead(it);
    const b = h('button', { class: `oitem${p.files ? ' files' : ''}`, role: 'listitem', tabindex: -1, title: it.text.trim().slice(0, 200) || it.files.join(', '), onclick: () => goPrompt(it.seq) },
      p.mail ? icon('mail') : null,
      p.slash ? h('span', { class: 'slash' }, p.slash) : null, h('span', { class: 't' }, p.slash ? p.text.slice(p.slash.length) : p.text));
    b.dataset.i = i;
    return b;
  }
  function outlineDraw() {
    navCount.textContent = `기록 · ${outline.length}`;
    navList.replaceChildren(...outline.map(itemEl));
    outlineCur = -1; outlineLayout(); spy(true);
  }
  let drawQueued = false;
  const outlineRedraw = () => { if (!drawQueued) { drawQueued = true; requestAnimationFrame(() => { drawQueued = false; outlineDraw(); }); } };
  function outlineSeed(list) { outline.length = 0; outlineAt.clear(); for (const p of list) { const it = { ...p, node: null }; outline.push(it); outlineAt.set(p.seq, it); } outlineRedraw(); }
  function outlineAdd(seq, ev, node) {
    let it = outlineAt.get(seq);
    if (!it) {
      it = { seq, origin: ev.origin, text: ev.text, files: ev.attachments?.map((a) => a.name) ?? [], node: null };
      outlineAt.set(seq, it);
      let i = outline.length; while (i > 0 && outline[i - 1].seq > seq) i--;
      outline.splice(i, 0, it); outlineRedraw();
    }
    it.node = node;
  }
  // 되돌리기 — from 부터 그 이벤트(at) 앞까지의 요청을 뺀다. 기록을 다시 그릴 땐 되돌림 뒤의 요청이 목록에 이미 있다
  function outlineCut(from, at) {
    const n = outline.length;
    for (let i = n - 1; i >= 0; i--) if (outline[i].seq >= from && outline[i].seq < at) { outlineAt.delete(outline[i].seq); outline.splice(i, 1); }
    if (outline.length !== n) outlineRedraw();
  }
  // 자리는 실제 왼쪽 여백으로 — 사이드바가 열리거나 카드가 좁아 여백이 232px 미만이면 감춘다(사용자 결정: 좁은 화면의 막대·헤더 버튼 안 기각). 요청이 셋 미만이어도 감춘다
  function outlineLayout() {
    const g = (feed.clientWidth - liveCol.offsetWidth) / 2;
    nav.hidden = outline.length < 3 || g < 232;
    if (nav.hidden) return;
    const w = Math.min(280, g - 32);
    nav.style.width = `${w}px`; nav.style.left = `${g - 24 - w}px`; nav.style.setProperty('--h', `${feed.clientHeight - 48}px`);
  }
  // 따라가는 중이면 바닥을 다시 맞춘다 (ticket slcode-scroll-follow-fixes) — 입력창·큐가 늘어 피드가 줄 때, 숨었던 카드가 다시 보일 때. 숨은 동안(display:none)은 레이아웃이 없어 바닥으로 내리기가 먹지 않아 그 사이 출력만큼 위에 남는다
  new ResizeObserver(() => { outlineLayout(); if (follow) jump(feed.scrollHeight); }).observe(feed);
  // 실제 카드(별도 프로세스 iframe)는 숨을 때 크기 변화가 전달되지 않아 돌아와도 ResizeObserver 가 오지 않는다 — 보일 때 오는 IntersectionObserver 로 맞춘다 (2026-11-03 실측)
  new IntersectionObserver((es) => { if (follow && es.at(-1).isIntersecting) jump(feed.scrollHeight); }).observe(feed);
  // 지금 항목이 목록 가운데 오게 — 포인터가 목록 위에 있으면 옮기지 않는다(고르려는 항목이 손 밑에서 도망가지 않게). scrollIntoView 는 카드 iframe 의 바깥까지 굴린다
  function centerCur(force = false) {
    const b = navList.children[outlineCur];
    if (!b || (!force && nav.matches(':hover'))) return;
    navList.scrollTop = b.offsetTop - (navList.clientHeight - b.offsetHeight) / 2;
  }
  // 이분 탐색 — 그린 요청은 목록의 끝쪽 연속 구간이다(앞 기록은 이어 붙인다)
  function spy(force = false) {
    let cur = outline.length - 1;
    if (!follow) {
      const line = feed.getBoundingClientRect().top + feed.clientHeight * 0.35;
      let lo = outline.findIndex((it) => it.node?.isConnected), hi = outline.length - 1;
      if (lo < 0) cur = -1;
      else if (outline[lo].node.getBoundingClientRect().top > line) cur = lo;
      else { while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (outline[mid].node.getBoundingClientRect().top <= line) lo = mid; else hi = mid - 1; } cur = lo; }
    }
    if (cur === outlineCur) return;
    navList.children[outlineCur]?.classList.remove('cur'); navList.children[outlineCur]?.removeAttribute('aria-current'); navList.children[outlineCur]?.setAttribute('tabindex', '-1');
    outlineCur = cur;
    const b = navList.children[cur];
    if (b) { b.classList.add('cur'); b.setAttribute('aria-current', 'location'); b.setAttribute('tabindex', '0'); }
    centerCur(force);
  }
  let spyQueued = false;
  feed.addEventListener('scroll', () => { if (!spyQueued) { spyQueued = true; requestAnimationFrame(() => { spyQueued = false; spy(); }); } }, { passive: true });
  navList.addEventListener('keydown', (e) => {
    const i = Number(e.target.dataset?.i); if (Number.isNaN(i)) return;
    const to = { ArrowUp: i - 1, ArrowDown: i + 1, Home: 0, End: outline.length - 1 }[e.key];
    if (e.key === 'Escape') { e.preventDefault(); input.focus(); return; }
    if (to === undefined) return;
    e.preventDefault(); const b = navList.children[Math.max(0, Math.min(outline.length - 1, to))]; b?.focus(); b && (navList.scrollTop = b.offsetTop - (navList.clientHeight - b.offsetHeight) / 2);
  });
  // 그린 적 없는 요청이면 그 자리까지 앞 기록을 이어 그린다 — 구간을 띄엄띄엄 두면 위로 올리기·되돌리기·미리 받기가 끊긴 구간을 다뤄야 한다
  async function loadUntil(it, tok) {
    while (!it.node?.isConnected && tok === navTok) {
      if (backlog.length) { loadOlder(); await new Promise(requestAnimationFrame); }
      else if (more) { await prefetch(); if (!backlog.length) return; }
      else return;
    }
  }
  // 바로 옮기고 그 말풍선 테두리를 잠깐 빛낸다 — 부드러운 스크롤은 먼 요청일수록 오래 굴러 도착 자리를 놓친다
  async function goPrompt(seq) {
    const it = outlineAt.get(seq), tok = ++navTok;
    if (!it) return;
    const b = navList.children[outline.indexOf(it)];
    if (!it.node?.isConnected) { b?.classList.add('loading'); await loadUntil(it, tok); b?.classList.remove('loading'); }
    if (tok !== navTok || !it.node?.isConnected) return;
    jump(feed.scrollTop + it.node.getBoundingClientRect().top - feed.getBoundingClientRect().top - 12);
    const hit = it.node.querySelector('.bubble, .envelope') ?? it.node;
    hit.classList.remove('hit'); void hit.offsetWidth; hit.classList.add('hit');
  }

  // 입력창 history 는 이 세션의 사람 입력만 (사용자 2026-11-03) — 메시지 턴은 빼고, 되돌린 턴은 서버가 뺀다. 옛 core 면 비어 있다
  const loadInputHistory = () => rpc('session.prompts', { id: current }).then((list) => hist.seed(list.filter((p) => !p.origin && p.text).map((p) => ({ seq: p.seq, text: p.text }))), () => {});
  // ---- attach · 재접속
  async function attach(id) {
    current = id; renderSide();
    let r;
    const first = !lastSeq; // 처음이면 끝 한 페이지, 재접속이면 끊긴 동안의 것 전부
    try { r = await rpc('session.attach', first ? { id, limit: PAGE } : { id, since: lastSeq }); }
    catch (e) {
      if (e.code === 'no_session') { push(h('div', { class: 'meta err' }, `세션 없음: ${id}`)); setState('exited'); return; }
      else throw e;
    }
    if (first && r.summary) { more = !!r.more; oldest = r.history[0]?.seq ?? 0; }
    if (first && r.prompts) outlineSeed(r.prompts);
    info = r.info; setTitle(info.title); syncInspect(); paintLock(); loadKids();
    if (r.draft && !input.value) { input.value = r.draft; input.oninput(); } // 다시 로드된 화면 — 쓰던 글을 되살린다 (치던 중이면 그대로)
    replayHistory(r.history, first ? r.summary : null);
    loadInputHistory();
    paintQueue(r.queue ?? []);
    for (const p of r.pending) renderCard(p);
    setState(info.state);
    loadModels(); loadStatus(); loadCommands(); loadMcp(); loadPlugins(); loadProfiles(); renderMode(); prefetch(); act.refresh();
    if (opts.onAttach) opts.onAttach(id, info);
  }
  transport.onEvent((m) => {
    if (m.event === 'session.event' && m.params.id === current) render(m.params, true);
    else if (m.event === 'session.changed' && m.params.id === current) { info = m.params; setTitle(info.title); syncInspect(); renderMode(); renderSide(); paintVendor(); paintLock(); }
    else if (m.event === 'session.children' && m.params.id === current) paintKids(m.params.children);
    else if (m.event === 'session.queue' && m.params.id === current) paintQueue(m.params.items);
    else if (m.event === 'session.restored' && m.params.id === current) restoreInput(m.params.text, m.params.attachments);
    else if (m.event === 'core.replaced') loadCommands(); // 옛 core 에서 받은 명령 목록을 새 core 의 것으로 — serve 가 다시 붙은 뒤에 알린다
    else if (m.event === 'session.closed' && m.params.id === current) paintQueue([]); // 큐는 메모리에만 있어 함께 사라진다. 나머지는 session.exit 이벤트가 이미 그렸다
    else if (m.event === 'settings.changed') setSettings(m.params);
  });
  transport.onStatus(async (s) => {
    connected = s.connected;
    if (s.connected) {
      rpc('settings.get').then(setSettings, () => {}); // 옛 serve 엔 없다 — 기본값으로 그린다
      // 다시 붙은 serve 가 이 페이지를 낸 serve 와 다르면(serve 교체) 새 웹으로 다시 로드한다 — 초안은 core 가 들고 있다. 옛 serve 엔 serve.info 가 없다
      rpc('serve.info').then((si) => {
        if (page.build && (si.version !== page.version || String(si.build) !== page.build)) { (opts.reload ?? (() => location.reload()))(); return; }
        if (si.update && !update) { update = si.update; paintUpd(); }
        settingsUi.inspectBlocked(si.inspectBlocked);
      }, () => {});
      boot('loading history');
      try {
        const si = await rpc('server.info');
        settingsUi.version(document.documentElement.dataset.version, si.version);
        const id = opts.sessionId ?? current ?? si.session;
        await loadFamily();
        if (page.kind === 'web' && family) {
          const me = family.sessions.find((s) => s.id === id);
          if (!me?.live) { refuseSession(id, me); return; }
        }
        await attach(id);
        paintFamily();
      } catch (e) { push(h('div', { class: 'meta err' }, e.message)); }
      finally { boot(null); }
    }
    else {
      boot(null);
      pill.className = 'pill disconnected'; pill.textContent = s.fatal ? `인증 실패` : STATE_LABEL.disconnected; renderSide();
      // 알약엔 '인증 실패' 한마디뿐이라 고칠 길은 피드에 남긴다 (사용자 2026-10-09, 그땐 좁은 화면에서 알약이 숨었다). fatal 은 재접속하지 않아 한 번만 온다
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
    // 지금 모델 찾기는 core 의 effortMisfit 과 같다 — 모르면(첫 턴 전) default
    const cur = r.current == null ? r.models.find((m) => m.value === 'default')
      : r.models.find((m) => m.value === r.current) ?? r.models.find((m) => m.value !== 'default' && base(m.resolvedModel) === base(r.current));
    modelName = cur?.displayName ?? r.current ?? '모델'; effortNow = r.effort; paintModel(); renderSide(); // 상단 요약의 모델 이름
    modelBtn.style.display = r.models.length ? '' : 'none';
    // effort 슬라이더 — 단계는 고른 모델의 efforts(core 가 준다: Claude 는 supportedEffortLevels, 없으면 CLAUDE_EFFORTS · Codex 는 모델의 목록). 비었으면 없다
    // ChatGPT 꼴 (사용자 2026-09-27): 위에 단계 이름, 아래 range 한 칸 = 한 단계. 놓으면 session.setEffort (다음 턴부터)
    const efforts = cur?.efforts ?? [];
    let effortBox = null;
    if (efforts.length) {
      const span = Math.max(1, efforts.length - 1);
      const idx = Math.max(0, efforts.indexOf(r.effort));
      const lbl = h('div', { class: 'lbl' }, efforts[idx] ?? '');
      const range = h('input', { type: 'range', min: 0, max: efforts.length - 1, step: 1, value: idx, style: `--n:${efforts.length}` });
      const paint = () => { lbl.textContent = efforts[range.value]; range.style.setProperty('--p', `calc(16px + ${range.value / span} * (100% - 32px))`); };
      range.oninput = paint; paint();
      range.onchange = () => { effortNow = efforts[range.value]; paintModel(); return rpc('session.setEffort', { id: current, effort: efforts[range.value] }).then(loadModels).catch((e) => push(h('div', { class: 'meta err' }, e.message))); };
      effortBox = h('div', { class: 'effort' }, lbl, h('div', { class: 'track' }, range, ...efforts.map((_, i) => h('i', { style: `left: calc(16px + ${i / span} * (100% - 32px) - 2px)` }))));
    }
    const VER = /-?\b(\d+(?:\.\d+)*)\b/;
    const ver = (m) => { const v = m.displayName.match(VER)?.[1]; return v ? v.split('.').map(Number) : []; };
    const fam = (m) => m.displayName.replace(VER, '').replace(/\s+/g, ' ').trim();
    const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d > 0; } return false; };
    const best = new Map();
    for (const m of r.models) { if (!ver(m).length) continue; const f = fam(m); if (!best.has(f) || newer(ver(m), ver(best.get(f)))) best.set(f, m); }
    const top = r.models.filter((m) => best.get(fam(m)) === m), rest = r.models.filter((m) => !top.includes(m));
    // 골라도 메뉴는 열어 둔다 — 이어서 effort 를 고를 수 있게. 닫기는 바깥 클릭·Esc (사용자 2026-10-24)
    const item = (m) => h('button', { class: 'item', 'aria-checked': String(m === cur), onclick: (e) => { for (const b of modelMenu.querySelectorAll('.item[aria-checked]')) b.setAttribute('aria-checked', String(b === e.currentTarget)); modelName = m.displayName; paintModel(); renderSide(); rpc('session.setModel', { id: current, model: m.value }).then(loadModels).catch((e) => push(h('div', { class: 'meta err' }, e.message))); } }, m.displayName);
    const more = h('div', { class: 'more' }, ...rest.map(item));
    if (modelMenu.querySelector('.more.open')) more.classList.add('open'); // 다시 그려도 펼친 채로
    paintVendor();
    modelMenu.replaceChildren(vendorSeg, ...top.map(item), h('button', { class: 'item toggle', onclick: () => more.classList.toggle('open') }, '더 많은 모델'), more, effortBox ?? '');
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
    if (t === '/fork' && !pendingFiles.length) { input.value = ''; input.style.height = ''; canSend(); hist.reset(); saveDraft(true); void fork(null); return; }
    const attachments = pendingFiles.splice(0).map(({ dataUrl, ...a }) => { if (a.mediaType.startsWith('image/')) sentFiles.set(a.name, dataUrl); return a; });
    chips.innerHTML = '';
    input.value = ''; input.style.height = ''; canSend(); argRes = null; argSeq++; hist.reset();
    rpc('session.send', { id: current, text: t, ...(attachments.length ? { attachments } : {}) }).catch((e) => push(h('div', { class: 'meta err' }, e.message)));
    saveDraft(true);
    toBottom();
  }
  // 바깥(superlite 카드)이 탭을 다시 보일 때 입력창으로 — focus() 는 직전 커서·선택을 그대로 둔다 (사용자 2026-10-04)
  window.addEventListener('message', (e) => { if (e.data?.type === 'slcode.focus' && !input.disabled) input.focus(); });
  // 답변 속 링크·이미지(data-open, ticket slcode-append-system-prompt). superlite 카드면 링크는 superlite 가 연다 — 웹 주소는 URL 탭, 파일은 에디터
  // (main.js 의 open 동사). 브라우저로 연 웹은 그대로 새 탭. 이미지는 어디서든 보기 화면으로 (ChatGPT 꼴, 사용자 2026-10-17)
  const inCard = window.parent !== window;
  const openLink = (a) => { if (inCard) hostPost({ type: 'slcode.open', target: a.dataset.open }); else window.open(a.href, '_blank', 'noopener'); };
  // 다운로드 — 카드의 로컬 파일은 superlite download 동사(Download 뷰 대기열, 앱 웹뷰에선 브라우저 다운로드가 안 될 수 있다). 그 밖은 브라우저 다운로드:
  // 로컬 파일은 같은 출처라 바로, 웹 이미지는 받아서 — 그 사이트가 막으면(CORS) 링크처럼 연다
  async function download(a) {
    const target = a.dataset.open, local = !/^https?:/.test(target);
    if (local && inCard) { hostPost({ type: 'slcode.download', target }); return; }
    let url = a.href, blob = null;
    if (!local) {
      try { const r = await fetch(url); if (r.ok) url = blob = URL.createObjectURL(await r.blob()); } catch {}
      if (!blob) { openLink(a); return; }
    }
    const d = h('a', { href: url, download: target.split(/[\\/]/).pop().split(/[?#]/)[0] || 'image' });
    document.body.append(d); d.click(); d.remove();
    if (blob) setTimeout(() => URL.revokeObjectURL(blob), 1000);
  }
  const viewImg = h('img', { alt: '' });
  let viewing = null;
  const viewer = h('dialog', { class: 'imgview' }, h('div', { class: 'bar' }, iconBtn('download', '다운로드', () => viewing && download(viewing)), iconBtn('x', '닫기', () => viewer.close())), viewImg);
  closeOnBackdrop(viewer); // 이미지 밖(배경)을 누르면 닫는다, Esc 는 dialog 가
  el.append(viewer);
  el.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-open]');
    if (!a || e.button !== 0) return;
    const img = a.querySelector('img');
    if (img) { e.preventDefault(); viewing = a; viewImg.src = img.src; viewImg.alt = img.alt; viewer.showModal(); return; }
    if (inCard) { e.preventDefault(); openLink(a); }
  });
  // 링크 대상 팝오버 (ticket slcode-link-hover-target, 사용자 2026-11-09) — 0.3초 머물면 링크 위에 data-to(절대 경로·줄 번호, URL 전체)를 줄바꿈해 다 보인다, 위에 자리가 없으면 아래.
  // 카드에는 주소가 없어 상태 표시줄에도 안 뜬다. 보기만 해서 마우스를 받지 않는다. 누르거나 스크롤하면(따라가기 포함) 닫는다
  const tip = h('div', { class: 'linktip', popover: 'manual' });
  el.append(tip);
  let tipFor = null, tipTimer = 0;
  const hideTip = () => { clearTimeout(tipTimer); tipFor = null; if (tip.matches(':popover-open')) tip.hidePopover(); };
  const showTip = (a) => {
    if (!a.isConnected) return;
    tip.textContent = a.dataset.to; tip.showPopover();
    const r = (a.querySelector('img') ?? a).getBoundingClientRect(), up = r.top - tip.offsetHeight - 6;
    tip.style.left = `${Math.min(Math.max(8, r.left), innerWidth - tip.offsetWidth - 8)}px`;
    tip.style.top = `${up >= 4 ? up : r.bottom + 6}px`;
  };
  el.addEventListener('mouseover', (e) => {
    const a = e.target.closest?.('a[data-to]');
    if (a === tipFor) return;
    hideTip();
    if (a) { tipFor = a; tipTimer = setTimeout(() => showTip(a), 300); }
  });
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('mousedown', hideTip); // 누르면 열리거나(새 탭·에디터) 이미지 보기가 뜬다
  el.addEventListener('scroll', hideTip, true);
  input.onpaste = (e) => { const fs = [...e.clipboardData.files]; if (fs.length) { e.preventDefault(); addFiles(fs); } };
  el.ondragover = (e) => e.preventDefault();
  el.ondrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); };
  input.onkeydown = (e) => {
    if (slashMenu.matches(':popover-open')) {
      const items = slashItems();
      if (items.length && e.key === 'ArrowDown') { e.preventDefault(); slashSel = (slashSel + 1) % items.length; slashDraw(); return; }
      if (items.length && e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel + items.length - 1) % items.length; slashDraw(); return; }
      // 인자 단계: Tab 은 고른 후보를 넣고, Enter 는 커서 낱말이 아직 그 후보와 다를 때만 넣는다(같으면 보낸다)
      if (argRes) {
        const cur = input.value.slice(argRes.start, argRes.end), pick = items[slashSel];
        if (pick && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing && cur !== pick.value))) { e.preventDefault(); slashPick(pick); return; }
      } else
      // Enter: 친 것이 전체 이름이거나 유일한 짧은 이름이면 그대로 보낸다, 아니면 고른 항목을 넣는다
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.isComposing && resolveSlash(input.value.trim()) === input.value.trim() && !commands.some((c) => c.name.toLowerCase() === input.value.trim().slice(1).toLowerCase()))) { e.preventDefault(); slashPick(items[slashSel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); slashMenu.hidePopover(); return; }
    }
    if (hist.key(e)) { e.preventDefault(); argRes = null; argSeq++; if (slashMenu.matches(':popover-open')) slashMenu.hidePopover(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (slashMenu.matches(':popover-open')) slashMenu.hidePopover(); send(); } else if (e.key === 'Escape' && !busy.hidden && current) { e.preventDefault(); esc.reset(); rpc('session.interrupt', { id: current }); } else if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); onEscape(); } };
  // 높이를 재려고 잠깐 기본 높이로 줄이면 그동안 피드가 늘어 scrollTop 이 그 높이의 바닥으로 깎인 채 남는다 — 재고 나서 자리를 되돌린다 (ticket slcode-scroll-follow-fixes)
  // 불러온 글로 `/` 메뉴를 열지 않는다 — 위·아래 키를 메뉴가 가져가 다음 기록으로 못 간다. 글을 고치면(nav 풀림) 다시 연다
  input.oninput = () => { const top = feed.scrollTop; input.style.height = ''; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; jump(follow ? feed.scrollHeight : top); canSend(); if (!hist.nav) { slashSel = 0; argQuery(); slashDraw(); } saveDraft(); };
  input.addEventListener('mousedown', () => hist.unpin());
  // Esc 두 번 (ticket slcode-rewind-esc-picker, 사용자 2026-11-03, Claude Code 2.1.316 실측) — 글이 있으면 비운다(지운 글은 기록에 남고 Ctrl+Z 로 돌아온다). 첫 번째 누름의 안내 문구는 두지 않는다 (사용자 2026-11-03).
  // 빈 입력이면 되돌리기 창을 연다. 턴 중 Esc 는 위에서 중단만 하고 판정을 지운다 — 두 번 눌러도 창은 열리지 않는다 (session.rewind 는 idle 에서만 된다)
  const esc = escGate();
  const picker = rewindPicker(h, { rpc, getId: () => current, close: () => showDock(), run: runRewind,
    head: (t) => promptHead(t).text + (t.origin !== 'mail' && /\S\s*\n\s*\S/.test(t.text) ? '…' : '') });
  async function openRewind() {
    try { if (!await picker.load()) return; } catch (e) { push(h('div', { class: 'meta err' }, e.message)); return; }
    if (busyNow || composer.hidden || input.value) return; // 받는 사이 턴이 시작됐거나 승인 카드가 올라왔거나 글을 쳤다
    dock.replaceChildren(picker.el); composer.hidden = true; picker.paint();
  }
  function onEscape() {
    if (!current || busyNow) return;
    const text = input.value;
    if (!esc.press(performance.now(), text ? 'text' : 'empty')) return;
    if (!text) { void openRewind(); return; }
    hist.addCleared(lastSeq, text);
    setInputText('');
    hist.reset();
  }
  // 어디서 쳐도 입력창으로 (ticket slcode-input-type-anywhere, 사용자 2026-11-02 — chatgpt.com 실측을 따른다). 포커스가 입력창 밖(대화·헤더·사이드바·버튼)이면
  // 글자 키와 붙여넣기는 포커스만 입력창으로 옮겨 브라우저 기본 동작이 그 자리에 넣게 한다 — focus() 는 직전 커서·선택을 그대로 둔다.
  // Space·Enter·화살표·Ctrl 조합(복사 등)은 넘기지 않는다. 다른 입력 요소·dialog·메뉴가 키를 받는 중이거나 승인 카드가 입력창 자리를 차지하면 그대로 둔다.
  // superlite 우선 단축키는 카드 문서의 전달 스크립트가 window capture 에서 먼저 받아 전파를 끊으므로 여기 오지 않는다
  const typingIn = (t) => t instanceof Element && t.closest('input, textarea, select, [contenteditable]:not([contenteditable=false]), dialog, [popover]');
  const canTake = () => !input.disabled && !composer.hidden && !el.querySelector('.menu:popover-open:not(.slash)');
  document.addEventListener('keydown', (e) => { if (!behind() && e.key !== 'Escape' && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) esc.reset(); }, true);
  // 승인·질문 카드가 입력창 자리에 떠 있으면 키는 그 카드로 — 포커스가 카드 밖이어도 ↑↓·Enter·Esc·글자가 카드에 간다 (ticket slcode-question-esc-chat, 사용자 2026-11-08)
  const liveCard = () => (composer.hidden ? dock.querySelector('.card.live') : null);
  document.addEventListener('keydown', (e) => {
    const card = liveCard();
    if (behind() || e.defaultPrevented || e.isComposing || !card || dock.contains(e.target) || typingIn(e.target) || el.querySelector('.menu:popover-open')) return;
    if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key) || ((e.ctrlKey || e.metaKey) && !e.getModifierState('AltGraph'))) return; // 복사 등 단축키는 그대로
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('a, button, summary, [tabindex]')) return; // 누른 버튼·접기의 Enter 는 그 자리에서
    card.focus({ preventScroll: true });
    const fwd = new KeyboardEvent('keydown', { key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, bubbles: true, cancelable: true });
    card.dispatchEvent(fwd);
    if (fwd.defaultPrevented) e.preventDefault(); // 글자는 막지 않는다 — 카드가 직접 입력으로 포커스를 옮겨 그 자리에 들어간다
  });
  document.addEventListener('keydown', (e) => {
    if (behind() || e.defaultPrevented || e.isComposing || typingIn(e.target) || !canTake()) return;
    if (e.key === 'Escape') { onEscape(); return; }
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    const char = e.key.length === 1 && e.key !== ' ' && (!mod || e.getModifierState('AltGraph'));
    const paste = ((e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyV') || (e.shiftKey && !mod && e.key === 'Insert');
    if (char || paste) input.focus({ preventScroll: true });
  });
  // 빈 곳·글자 위를 누르면 입력창으로 — IME 가 첫 글자부터 켜진다 (chatgpt.com 과 같게, 사용자 2026-11-02). 누를 거리(버튼·링크·접기)와 끌어서 고른 글은 그대로.
  // 이렇게 옮긴 포커스는 치기 전까지 커서를 숨긴다(parked) — 입력창을 누르지 않았는데 커서가 깜빡이면 거기 포커스를 둔 것처럼 보인다 (사용자 2026-11-02)
  el.addEventListener('click', (e) => {
    if (e.button !== 0 || e.defaultPrevented || !getSelection().isCollapsed) return;
    if (typingIn(e.target) || e.target.closest('a, button, label, summary, [tabindex], [role=button]')) return;
    const card = liveCard(); // 카드가 떠 있으면 빈 곳을 눌러도 카드로 (사용자 2026-11-08)
    if (card) { card.focus({ preventScroll: true }); return; }
    if (!canTake()) return;
    input.focus({ preventScroll: true });
    input.classList.add('parked');
  });
  for (const t of ['keydown', 'input', 'mousedown', 'blur']) input.addEventListener(t, () => input.classList.remove('parked'));
  renderSide();
  return {
    rpc, get sessionId() { return current; },
    /** 숨겨 둔 화면이 다시 보인다 — 사이드바는 열림 기억을 따르고, 목록을 새로 받고(숨은 동안은 받지 않는다), 입력창으로 */
    shown() {
      el.classList.toggle('side-open', store.get(SIDE_KEY) === 'open');
      void loadFamily();
      if (!input.disabled) input.focus({ preventScroll: true });
    },
  };
}
