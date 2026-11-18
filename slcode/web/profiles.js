// 프로필 관리 (ticket slcode-profile-manager, 사용자 2026-11-18) — 시작 화면(start.js)의 "프로필" 단추로 연다. 지금까지 CLI(slcode profile add·set·remove·rename)로만 하던 일을 화면에서 한다.
// 꼴 (사용자가 Fable·GPT astra 안 중 고름, ws docs/ticket/slcode-profile-manager/TICKET.md): 왼쪽 프로필 목록, 오른쪽 위 탭 "일반 · Claude 가 읽는 것 · 에이전트 플러그인 · system prompt".
// 줄은 이름 + 회색 설명 한 줄, 스위치는 system prompt 편집 창과 같은 무채색 꼴로 줄 맨 오른쪽. 플러그인 탭은 늘어나는 목록을 위해 검색·걸러 보기와 안쪽 두 칸(목록 / 고른 플러그인의 part·옵션)을 둔다.
// 바꾸면 바로 저장한다(profile.set — config.json 만 고쳐 빠르다). "따름" 으로 되돌리기는 unset 이다. 기본 제공 프로필은 잠기고 "복제해서 고치기" 길을 보인다.
// 요청은 call(method, params) — 웹은 시작 화면 서버의 api/, superlite 카드는 카드가 `slcode start-call` 로 중계한다. 요소 도우미·스타일(style.css .prpanel)은 이 파일의 것.

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'disabled' || k === 'value') n[k] = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));
  return n;
};

// Claude 로드 설정 — 묶음마다 [출처, 그 출처의 CLAUDE.md]. 설명은 켰을 때 읽는 것. key 는 profile set 의 claude.<key>
const CLAUDE = [
  [{ k: 'user', key: 'user', label: '사용자 설정', path: '~/.claude', desc: 'CLAUDE.md, skill, Claude 플러그인, MCP 서버, 훅, 권한 규칙, claude.ai 커넥터' },
    { k: 'userMd', key: 'user-md', label: '사용자 CLAUDE.md', desc: '~/.claude 의 CLAUDE.md 와 rules', off: '사용자 설정이 꺼져 있어 읽지 않습니다' }],
  [{ k: 'project', key: 'project', label: '프로젝트 설정', path: '.claude/', desc: '작업 폴더의 .claude/ 설정, skill, .mcp.json, CLAUDE.md' },
    { k: 'projectMd', key: 'project-md', label: '프로젝트 CLAUDE.md', desc: '작업 폴더와 위 폴더의 CLAUDE.md, CLAUDE.local.md', off: '프로젝트 설정이 꺼져 있어 읽지 않습니다' }],
  [{ k: 'builtinSkills', key: 'builtin-skills', label: 'Claude Code 기본 skill', desc: 'Claude Code 에 들어 있는 skill' }],
];
const TABS = [['general', '일반'], ['claude', 'Claude 가 읽는 것'], ['plugins', '에이전트 플러그인'], ['prompt', 'system prompt']];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const onOff = (b) => (b ? 'on' : 'off');

const plugOn = (p, n) => p.plugins[n]?.on ?? p.rest;
const setCount = (v = {}) => Object.keys(v.parts ?? {}).length + Object.keys(v.options ?? {}).length;
const isSet = (v) => v?.on !== undefined || setCount(v) > 0;
function claudeLine(c) {
  const a = [c.user ? `사용자 설정${c.userMd ? '' : ' (CLAUDE.md 제외)'}` : null, c.project ? `프로젝트 설정${c.projectMd ? '' : ' (CLAUDE.md 제외)'}` : null, c.builtinSkills ? '기본 skill' : null].filter(Boolean);
  return a.length ? a.join(', ') : '읽지 않음';
}
/** 저장된 블록 설정(systemPrompt.ts PromptSpec)의 한 줄 — 원문은 저장하지 않아 수만 센다 */
function promptLine(sp) {
  const off = sp?.pieces?.filter((x) => x.off).length ?? 0, edit = sp?.pieces?.filter((x) => x.text != null).length ?? 0, add = sp?.added?.length ?? 0;
  const a = [off ? `블록 ${off}개 끔` : null, edit ? `${edit}개 고침` : null, add ? `${add}개 더함` : null].filter(Boolean);
  return a.length ? a.join(' · ') : '기본 프롬프트 그대로';
}

/** call(method, params) → Promise. openPrompt(name) 은 system prompt 편집 창을 그 프로필로 연다(start.js) */
export function profilesPanel(call, { openPrompt } = {}) {
  // 대화상자는 root 에 두고 그리기는 body 만 바꾼다 — 저장이 끝나 다시 그려도 열린 창이 닫히지 않는다
  const root = el('div', { class: 'prpanel' }), body = el('div', { class: 'prbody' });
  root.append(body);
  const status = el('span', { class: 'pstat' });
  const S = { rows: null, plugins: [], sel: null, tab: 'general', plug: null, q: '', filter: 'all', error: null, saved: false };
  let savedTimer, queue = Promise.resolve();

  async function load() {
    try {
      const r = await call('profile.list');
      S.rows = r.profiles; S.plugins = r.plugins; S.error = null;
      if (!S.rows.some((x) => x.name === S.sel)) S.sel = (S.rows.find((x) => !x.builtin) ?? S.rows[0]).name;
    } catch (e) { S.error = `프로필을 읽지 못했습니다: ${e.message}`; }
    draw();
  }
  /** 고치는 요청 하나 → 목록을 다시 읽는다. 요청은 차례로 보낸다 — 저장 중에 누른 것도 버리지 않는다. 저장 알림·오류는 머리줄 고정 자리에만 (본문이 밀리지 않게) */
  function change(method, params, after) {
    queue = queue.then(async () => {
      let err = null;
      try { const r = await call(method, params); after?.(r); S.saved = true; clearTimeout(savedTimer); savedTimer = setTimeout(() => { S.saved = false; drawStatus(); }, 2200); }
      catch (e) { err = e.message; S.saved = false; }
      await load();
      if (err) { S.error = err; drawStatus(); } // load 가 성공하면 오류를 지우므로 그 뒤에 둔다 — 값은 저장된 것으로 돌아가고 사유가 남는다
    });
    return queue;
  }
  const set = (r, keyValue) => change('profile.set', { name: r.name, set: [keyValue] });
  const unset = (r, key) => change('profile.set', { name: r.name, unset: [key] });

  const sw = (on, disabled, onclick, label) => el('button', { class: `sw${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, disabled, onclick });
  const row = ({ cls = '', label, meta, path, desc, ctl }) => el('div', { class: `row ${cls}` },
    el('div', { class: 'tx' },
      el('div', { class: 'nm' }, el('span', {}, label), path ? el('span', { class: 'path' }, path) : null, meta ? el('span', { class: 'meta' }, meta) : null),
      desc ? el('div', { class: 'desc' }, desc) : null),
    ctl);
  const act = (text, onclick, keep) => el('button', { class: `tbtn act${keep ? ' keep' : ''}`, onclick }, text);
  const go = (tab) => { S.tab = tab; draw(); };
  const onCount = (p) => S.plugins.filter((x) => plugOn(p, x.name)).length;

  // ---------- 탭: 일반 ----------
  function generalTab(r) {
    const open = (tab) => act('열기 ›', () => go(tab), true);
    return el('div', { class: 'pane' },
      el('section', {}, el('h3', {}, '이 프로필이 싣는 것'),
        el('div', { class: 'grp' }, row({ label: 'Claude 가 읽는 것', desc: claudeLine(r.profile.claude), ctl: open('claude') })),
        el('div', { class: 'grp' }, row({ label: '에이전트 플러그인', desc: S.plugins.length ? `${S.plugins.length}개 중 ${onCount(r.profile)}개 실음` : '설치한 플러그인이 없습니다', ctl: open('plugins') })),
        el('div', { class: 'grp' }, row({ label: 'system prompt', desc: promptLine(r.profile.claude.systemPrompt), ctl: open('prompt') }))),
      r.builtin ? null : el('section', {}, el('h3', {}, '관리'),
        el('div', { class: 'grp' }, row({ label: '이름', desc: '이름을 바꾸면 옛 이름으로 띄운 세션도 새 이름을 따릅니다', ctl: el('button', { class: 'btn', onclick: () => renameDialog(r) }, '이름 바꾸기') })),
        el('div', { class: 'grp' }, row({ label: '복제', desc: '같은 설정으로 새 프로필을 만듭니다', ctl: el('button', { class: 'btn', onclick: () => newDialog(r.name) }, '복제') })),
        el('div', { class: 'grp' }, row({ label: '지우기', desc: '이 프로필을 쓰던 세션은 다음에 열 때 default 로 뜹니다', ctl: el('button', { class: 'btn danger', onclick: () => removeDialog(r) }, '지우기') }))));
  }

  // ---------- 탭: Claude 가 읽는 것 ----------
  function claudeTab(r) {
    const c = r.profile.claude;
    return el('div', { class: 'pane' },
      CLAUDE.map(([par, child], i) => el('div', { class: i ? 'grp' : '' },
        row({ label: par.label, path: par.path, desc: par.desc, ctl: sw(c[par.k], r.builtin, () => set(r, `claude.${par.key}=${onOff(!c[par.k])}`), par.label) }),
        // 출처가 꺼지면 CLAUDE.md 스위치는 꺼진 꼴로 잠근다 — 저장된 값은 그대로 두고 실제로 적용되는 상태를 보인다
        child ? row({ cls: `child${c[par.k] ? '' : ' dim'}`, label: child.label, desc: c[par.k] ? child.desc : child.off,
          ctl: sw(c[par.k] && c[child.k], r.builtin || !c[par.k], () => set(r, `claude.${child.key}=${onOff(!c[child.k])}`), child.label) }) : null)));
  }

  // ---------- 탭: 에이전트 플러그인 (안쪽 목록 + 상세) ----------
  function pluginsTab(r) {
    const p = r.profile;
    if (!S.plugins.length) return el('div', { class: 'pane' }, el('div', { class: 'none' }, '설치한 에이전트 플러그인이 없습니다.'));
    const q = S.q.trim().toLowerCase();
    const FILTERS = [['all', '전체', () => true], ['on', '싣는 것', (x) => plugOn(p, x.name)], ['set', '이 프로필이 정한 것', (x) => isSet(p.plugins[x.name])]];
    const pass = FILTERS.find((f) => f[0] === S.filter)[2];
    const list = S.plugins.filter((x) => pass(x) && (!q || x.name.toLowerCase().includes(q)));
    const x = list.find((y) => y.name === S.plug) ?? list[0];
    return el('div', { class: 'pane wide' },
      row({ label: '나머지 플러그인', desc: '아래에서 따로 정하지 않은 플러그인과 나중에 설치하는 플러그인', ctl: sw(p.rest, r.builtin, () => set(r, `other-plugins=${onOff(!p.rest)}`), '나머지 플러그인') }),
      el('div', { class: 'pbar' },
        el('input', { class: 'pq', type: 'search', placeholder: '플러그인 찾기', value: S.q, 'aria-label': '플러그인 찾기', oninput: (e) => { S.q = e.target.value; S.refocus = true; draw(); } }),
        FILTERS.map(([k, label, f]) => el('button', { class: 'tbtn', 'aria-pressed': String(S.filter === k), onclick: () => { S.filter = k; draw(); } }, label, el('span', { class: 'n' }, String(S.plugins.filter(f).length))))),
      el('div', { class: 'pcols' },
        el('div', { class: 'plugs' },
          list.length ? list.map((y) => {
            const on = plugOn(p, y.name);
            return el('div', { class: `plug${on ? '' : ' off'}`, 'aria-current': String(y === x), onclick: () => { S.plug = y.name; draw(); } },
              el('span', { class: 'nm' }, y.name), isSet(p.plugins[y.name]) ? el('span', { class: 'mark' }, '정함') : null,
              sw(on, r.builtin, (e) => { e.stopPropagation(); S.plug = y.name; void set(r, `${y.name}=${onOff(!on)}`); }, y.name));
          }) : el('div', { class: 'none' }, '맞는 플러그인이 없습니다')),
        x ? pluginDetail(r, x) : el('div', { class: 'pd' })));
  }
  function pluginDetail(r, x) {
    const p = r.profile, v = p.plugins[x.name] ?? {}, on = plugOn(p, x.name);
    const back = (text, key) => (r.builtin ? null : [' · ', act(text, () => unset(r, key))]);
    const by = (has, key) => (has ? ['이 프로필이 정함', back('플러그인 설정 따르기', key)] : '플러그인 설정을 따름');
    const opt = (o) => {
      const cur = v.options?.[o.name], plugin = o.value ?? o.default, key = `${x.name}.${o.name}`;
      if (o.type === 'boolean') return sw(cur ?? plugin, r.builtin, () => set(r, `${key}=${(cur ?? plugin) ? 'false' : 'true'}`), o.name);
      // 비우면 값을 지워 플러그인 설정을 따른다
      return el('input', { class: 'val', value: cur ?? '', placeholder: `${plugin === '' ? '없음' : plugin} (플러그인 설정)`, disabled: r.builtin, 'aria-label': o.name,
        onchange: (e) => { const t = e.target.value.trim(); void (t === '' ? (cur === undefined ? null : unset(r, key)) : set(r, `${key}=${t}`)); } });
    };
    return el('div', { class: 'pd' },
      row({ label: x.name, meta: x.version,
        desc: [on ? '싣습니다' : '싣지 않습니다', ' · ', v.on === undefined ? '나머지 플러그인을 따름' : ['이 프로필이 정함', back('나머지를 따르기', x.name)]] }),
      !on ? el('div', { class: 'none' }, 'part·옵션은 실을 때만 적용됩니다')
        : !(x.parts.length + x.options.length) ? el('div', { class: 'none' }, '정할 part·옵션이 없습니다')
          : [x.parts.length ? [el('h4', {}, 'part'), x.parts.map((pt) => {
            const cur = v.parts?.[pt.name], plugin = pt.on ?? pt.default;
            return row({ cls: 'sub', label: pt.name, desc: pt.required ? '필수' : by(cur !== undefined, `${x.name}.${pt.name}`),
              ctl: sw(pt.required || (cur ?? plugin), r.builtin || pt.required, () => set(r, `${x.name}.${pt.name}=${onOff(!(cur ?? plugin))}`), pt.name) });
          })] : null,
          x.options.length ? [el('h4', {}, '옵션'), x.options.map((o) => row({ cls: 'sub', label: o.label ?? o.name, meta: o.label ? o.name : null,
            desc: by(v.options?.[o.name] !== undefined, `${x.name}.${o.name}`), ctl: opt(o) }))] : null]);
  }

  // ---------- 탭: system prompt ----------
  function promptTab(r) {
    return el('div', { class: 'pane' },
      row({ label: promptLine(r.profile.claude.systemPrompt),
        ctl: el('button', { class: 'btn', onclick: () => openPrompt?.(r.name) }, '편집') }));
  }

  // ---------- 대화상자 ----------
  let dlg = null;
  function showDialog(...kids) { dlg?.remove(); dlg = el('dialog', {}, ...kids); root.append(dlg); dlg.showModal(); return dlg; }
  const cancel = () => el('button', { class: 'btn', onclick: () => dlg.close() }, '취소');
  const nameError = (name, self) => (!NAME.test(name) ? '영문·숫자로 시작하고 영문·숫자·. _ - 만 씁니다.' : name !== self && S.rows.some((x) => x.name === name) ? `${name} 이 이미 있습니다.` : null);
  /** 대화상자의 확인 — 요청이 실패하면 창을 닫지 않고 사유를 보인다 */
  async function submit(err, method, params, after) {
    try { const r = await call(method, params); dlg.close(); after(r); await load(); } catch (e) { err.textContent = e.message; }
  }
  function newDialog(from) {
    let name = '', src = from; const err = el('div', { class: 'err' });
    const ok = () => { const why = nameError(name); if (why) { err.textContent = why; return; } void submit(err, 'profile.add', { name, from: src }, () => { S.sel = name; S.tab = 'general'; }); };
    showDialog(el('h4', {}, '새 프로필'),
      el('label', {}, '이름', el('input', { oninput: (e) => { name = e.target.value.trim(); }, onkeydown: (e) => { if (e.key === 'Enter') ok(); } })),
      el('label', {}, '복사할 프로필', el('select', { onchange: (e) => { src = e.target.value; } }, S.rows.map((p) => el('option', { value: p.name, selected: p.name === from }, p.name)))),
      err, el('div', { class: 'acts' }, cancel(), el('button', { class: 'btn solid', onclick: ok }, '만들기')));
    dlg.querySelector('input').focus();
  }
  function renameDialog(r) {
    let name = r.name; const err = el('div', { class: 'err' });
    const ok = () => { if (name === r.name) { dlg.close(); return; } const why = nameError(name, r.name); if (why) { err.textContent = why; return; } void submit(err, 'profile.rename', { from: r.name, to: name }, () => { S.sel = name; }); };
    showDialog(el('h4', {}, `${r.name} 이름 바꾸기`),
      el('label', {}, '새 이름', el('input', { value: r.name, oninput: (e) => { name = e.target.value.trim(); }, onkeydown: (e) => { if (e.key === 'Enter') ok(); } })),
      el('p', {}, `${r.name} 으로 띄운 세션과 --profile ${r.name} 도 새 이름을 따릅니다.`),
      err, el('div', { class: 'acts' }, cancel(), el('button', { class: 'btn solid', onclick: ok }, '바꾸기')));
    dlg.querySelector('input').select();
  }
  function removeDialog(r) {
    const err = el('div', { class: 'err' });
    showDialog(el('h4', {}, `${r.name} 을 지울까요?`),
      el('p', {}, '이 프로필을 쓰던 세션은 다음에 열 때 default 로 뜹니다.'),
      err, el('div', { class: 'acts' }, cancel(), el('button', { class: 'btn danger', onclick: () => void submit(err, 'profile.remove', { name: r.name }, () => { S.sel = null; }) }, '지우기')));
  }

  // ---------- 그리기 ----------
  function drawStatus() {
    const r = S.rows?.find((x) => x.name === S.sel);
    status.className = `pstat${S.error ? ' err' : S.saved ? ' ok' : ''}`;
    status.textContent = S.error ?? (S.saved ? '저장했습니다' : r && !r.builtin ? '바꾸면 바로 저장되고 새 세션부터 적용됩니다' : '');
  }
  function draw() {
    drawStatus();
    if (!S.rows) { body.replaceChildren(el('div', { class: 'none' }, S.error ? '' : '읽는 중…')); return; }
    const r = S.rows.find((x) => x.name === S.sel) ?? S.rows[0];
    body.replaceChildren(
      el('div', { class: 'plist' },
        S.rows.map((p) => el('button', { class: 'pitem', 'aria-current': String(p === r), onclick: () => { S.sel = p.name; S.error = null; draw(); } },
          el('span', { class: 'nm' }, p.name), p.builtin ? el('span', { class: 'kind' }, '기본 제공') : null)),
        el('button', { class: 'add', onclick: () => newDialog(r.name) }, '+ 새 프로필')),
      el('div', { class: 'pdetail' },
        el('div', { class: 'phd' }, el('h2', { title: r.name }, r.name),
          r.builtin ? [el('span', { class: 'lock' }, '기본 제공'), el('span', { class: 'grow' }), el('button', { class: 'btn solid', onclick: () => newDialog(r.name) }, '복제해서 고치기')] : null),
        el('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, label]) => el('button', { class: 'tab', role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => go(k) },
          label, k === 'plugins' && S.plugins.length ? el('span', { class: 'n' }, `${onCount(r.profile)}/${S.plugins.length}`) : null))),
        { general: generalTab, claude: claudeTab, plugins: pluginsTab, prompt: promptTab }[S.tab](r)));
    if (S.refocus) { S.refocus = false; const i = body.querySelector('.pq'); i?.focus(); i?.setSelectionRange(S.q.length, S.q.length); }
  }
  draw();
  return { el: root, status, load, /** system prompt 편집 창에서 돌아올 때 — 그 탭으로 */ show: (name, tab) => { if (name) S.sel = name; if (tab) S.tab = tab; return load(); } };
}
