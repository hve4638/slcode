// 프로바이더 관리 (ticket slcode-custom-provider, 사용자 결정 2026-11-25: 안 B) — 시작 화면(start.js)의 "프로바이더" 단추와 대화 화면 모델 메뉴의 "프로바이더 관리"(app.js)가 연다.
// 꼴은 프로필 관리(profiles.js, style.css .prpanel)와 같다: 왼쪽 목록, 오른쪽 탭 "일반 · 모델 · 세부". 바꾸면 바로 저장한다(provider.save — 준 칸만 바뀐다).
// 새 프로바이더는 템플릿을 고르는 창에서 만든다. 키는 화면에 오지 않는다(hasKey·keyTail) — 칸을 비워 두면 지금 키가 남는다.
// 요청은 call(method, params) — 시작 화면은 api/·`slcode start-call`, 대화 화면은 serve 가 답한다 (providerMethods.ts).

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'disabled' || k === 'value' || k === 'checked') n[k] = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));
  return n;
};
const ENGINE = { claude: 'Claude Code', codex: 'Codex' };
const FORMAT = { claude: 'Anthropic Messages', codex: 'OpenAI Responses' };
const TIERS = [['opus', 'opus'], ['sonnet', 'sonnet'], ['haiku', 'haiku'], ['subagent', 'subagent']];
const FEATURES = [
  ['thinking', 'thinking'],
  ['effort', 'effort'],
  ['betas', 'tool search·beta 기능', 'claude'],
];

// 아이콘 — Lucide(ISC) 의 것, 고지는 app.js 의 ICONS 위에 있다. 모듈마다 따로 실려 app.js 의 것을 가져오지 못한다 (prompt.js 와 같다).
// +·× 를 글자로 쓰지 않는다 — 글자는 글꼴마다 앉는 높이가 달라 한글 옆에서 어긋난다(Windows 에서 + 가 내려앉았다, 사용자 2026-11-26)
const ICONS = {
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
};
const icon = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name]; return s; };

/** 이름 뒤 목적격 조사 — 한글은 받침으로, 숫자는 읽는 소리로, 그 밖(영문 이름)은 '를' (ticket slcode-provider-panel-slow) */
function objectJosa(name) {
  const c = name.trim().slice(-1), code = c.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? '을' : '를';
  if (/\d/.test(c)) return '0136780'.includes(c) ? '을' : '를'; // 영·일·삼·육·칠·팔 은 받침
  return '를';
}

export function providersPanel(call) {
  const root = el('div', { class: 'prpanel prv' }), body = el('div', { class: 'prbody' });
  root.append(body);
  const status = el('span', { class: 'pstat' });
  const S = { rows: null, keys: [], templates: {}, sel: null, tab: 'general', error: null, fetched: null, fetching: false, fetchErr: null, q: '' };
  let queue = Promise.resolve();

  async function load() {
    try {
      const r = await call('provider.list');
      S.rows = r.providers; S.keys = r.keys ?? []; S.templates = r.templates; S.error = null;
    } catch (e) { S.error = `프로바이더를 읽지 못했습니다: ${e.message}`; }
    draw();
  }
  /** 목록의 그 id 를 답으로 받은 것으로 바꾼다 (없으면 붙인다) — 고친 뒤 목록을 다시 읽지 않고 답으로 고친다 */
  const upsert = (list, it) => (list.some((x) => x.id === it.id) ? list.map((x) => (x.id === it.id ? it : x)) : [...list, it]);
  const put = (row) => { S.rows = upsert(S.rows, row); };
  /** 고치는 요청 하나 — 화면을 먼저 바꿔 그리고 보낸 뒤, 답(저장된 프로바이더)으로 그 줄을 바꾼다. 목록을 다시 읽지 않는다: 카드 시작 화면은
   *  요청마다 slcode 프로세스를 띄워 요청 하나가 사람이 느낄 만큼 걸린다 (ticket slcode-provider-panel-slow). 실패하면 목록을 다시 읽어 되돌린다.
   *  요청은 차례로. patch 가 함수면 지금 값(먼저 바꾼 것까지 든)으로 만든다 — 모델을 연달아 체크해도 앞의 것을 덮지 않게.
   *  먼저 그리기는 다음 차례로 미룬다 — 칸을 떠나며 저장할 때 새로 누른 칸에 포커스가 간 뒤 그려야 draw 가 그 칸을 이어 준다 */
  function save(p, patch) {
    const now = S.rows.find((x) => x.id === p.id) ?? p, change = typeof patch === 'function' ? patch(now) : patch;
    put({ ...now, ...change }); setTimeout(draw);
    queue = queue.then(async () => {
      try { put((await call('provider.save', { provider: { id: p.id, ...change } })).provider); S.error = null; draw(); }
      catch (e) { await load(); S.error = e.message; drawStatus(); }
    });
    return queue;
  }
  const row = ({ cls = '', label, desc, ctl }) => el('div', { class: `row ${cls}` }, el('div', { class: 'tx' }, el('div', { class: 'nm' }, el('span', {}, label)), desc ? el('div', { class: 'desc' }, desc) : null), ctl);
  const sw = (on, onclick, label) => el('button', { class: `sw${on ? ' on' : ''}`, role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, onclick });
  /** 칸 하나 — 바뀐 값을 칸을 떠날 때(또는 Enter) 저장 */
  const field = (value, onSave, attrs = {}) => {
    const i = el('input', { class: 'val', value: value ?? '', ...attrs });
    const done = () => { if (i.value !== (value ?? '')) onSave(i.value); };
    i.addEventListener('change', done);
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
    return i;
  };
  const tplOf = (p) => S.templates[p.template] ?? S.templates.custom ?? { name: p.template, features: {} };

  // ---------- 탭: 일반 ----------
  function generalTab(p) {
    const t = tplOf(p);
    return el('div', { class: 'pane' },
      el('section', {}, el('h3', {}, '연결'),
        row({ label: '벤더', ctl: el('div', { class: 'seg' }, ['claude', 'codex'].map((v) => {
          const ok = typeof t[v] === 'string';
          return el('button', { 'aria-pressed': String(p.vendor === v), disabled: !ok, title: ok ? '' : `${t.name} 는 ${FORMAT[v]} 주소가 없습니다`,
            onclick: () => { if (p.vendor !== v) void save(p, { vendor: v, ...(t[v] ? { baseUrl: t[v] } : {}) }); } }, ENGINE[v]);
        })) }),
        el('div', { class: 'grp' }, row({ label: '주소', desc: el('span', { class: 'mono' }, `${p.baseUrl.replace(/\/+$/, '')}${p.vendor === 'claude' ? '/v1/messages' : '/responses'}`) /* 실제로 보내는 주소 — /v1 을 두 번 붙이는 실수가 보인다 */, ctl: field(p.baseUrl, (v) => save(p, { baseUrl: v.trim() }), { class: 'val wide mono', spellcheck: 'false', 'data-f': 'baseUrl' }) })),
        el('div', { class: 'grp' }, row({ label: '키', ctl: keyCtl(p) })),
        t.note ? el('p', { class: 'note' }, t.note) : null));
  }
  // ---------- 탭: 모델 ---------- 모델 목록과 모델마다의 토큰 한도 (사용자 2026-11-27 — 일반에서 따로 뗐다)
  const modelsTab = (p) => el('div', { class: 'pane' }, el('section', {}, modelsBox(p)));
  /** 키 칸 — 직접 넣거나(칸), 키 관리의 키를 고른다(칸 옆 네모 열쇠 단추). 키 관리의 키를 쓰면 칸은 그 이름을 보이며 잠긴다(회색) — × 로 비워야 직접 넣는다 (사용자 2026-11-26) */
  function keyCtl(p) {
    const ref = p.keyRef ? S.keys.find((k) => k.id === p.keyRef) : null;
    return el('div', { class: 'keyctl' },
      el('div', { class: 'kfield' },
        ref ? el('input', { class: 'val wide ref', disabled: true, value: `${ref.name}${ref.tail ? ` ••••${ref.tail}` : ''}`, title: '키 관리의 키 — × 로 풀면 직접 넣을 수 있습니다' })
          : field('', (v) => save(p, { key: v.trim() }), { class: 'val wide mono', 'data-f': 'key', type: 'password', autocomplete: 'off', placeholder: p.hasKey ? `••••${p.keyTail ?? ''}` : '' }),
        p.hasKey ? el('button', { class: 'tbtn ico kclr', title: '키 지우기', 'aria-label': '키 지우기', onclick: () => void save(p, { key: '' }) }, icon('x')) : null),
      el('button', { class: 'kbtn', title: '키 관리', 'aria-label': '키 관리', 'aria-pressed': String(!!ref), onclick: () => keysDialog(p) }, icon('key')));
  }
  function modelsBox(p) {
    const t = tplOf(p);
    const add = (m) => { m = m.trim(); if (m) void save(p, (now) => ({ models: now.models.includes(m) ? now.models : [...now.models, m] })); };
    const input = el('input', { class: 'val wide mono', spellcheck: 'false', 'data-f': 'model', onkeydown: (e) => { if (e.key === 'Enter') { add(e.target.value); e.target.value = ''; } } });
    const fetchBtn = t.list === 'none' ? null : el('button', { class: 'btn', disabled: S.fetching, onclick: async () => {
      S.fetching = true; S.fetchErr = null; draw();
      try { S.fetched = (await call('provider.models', { provider: { id: p.id } })).models; } catch (e) { S.fetched = null; S.fetchErr = e.message; }
      S.fetching = false; draw();
    } }, S.fetching ? '받는 중…' : '목록 받기');
    const list = S.fetched ? el('div', { class: 'fetch' },
      el('input', { class: 'val wide pq', 'data-f': 'q', placeholder: `검색 (${S.fetched.length}개)`, value: S.q, oninput: (e) => { S.q = e.target.value; draw(); } }),
      el('div', { class: 'opts' }, S.fetched.filter((m) => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(S.q.toLowerCase())).slice(0, 200).map((m) =>
        el('label', {}, el('input', { type: 'checkbox', checked: p.models.includes(m.id), onchange: (e) => { const on = e.target.checked; void save(p, (now) => ({ models: on ? [...now.models.filter((x) => x !== m.id), m.id] : now.models.filter((x) => x !== m.id),
          ...(on && m.context && !now.limits?.[m.id]?.context ? { limits: { ...now.limits, [m.id]: { ...now.limits?.[m.id], context: m.context } } } : {}) })); } }),
          el('span', { class: 'mono' }, m.id), m.name && m.name !== m.id ? el('span', { class: 'meta' }, m.name) : null, m.context ? el('span', { class: 'meta ctx' }, `${Math.round(m.context / 1000)}k`) : null)))) : null;
    // 모델마다의 토큰 한도 (ticket slcode-provider-token-limits, 사용자 결정 2026-11-27) — 비우면 벤더 기본. 출력 한도는 Claude 엔진만(Codex 는 설정이 없다)
    const claude = p.vendor === 'claude';
    const limit = (m, k) => field(p.limits?.[m]?.[k] ?? '', (v) => {
      v = v.replace(/[\s,_]/g, '');
      if (v && !/^[1-9]\d*$/.test(v)) { S.error = '토큰 수는 숫자로 넣어 주세요'; draw(); return; }
      void save(p, (now) => { const cur = { ...now.limits?.[m] }; if (v) cur[k] = Number(v); else delete cur[k]; return { limits: { ...now.limits, [m]: cur } }; });
    }, { class: 'val num mono', 'data-f': `limit:${m}:${k}`, inputmode: 'numeric', placeholder: '자동', 'aria-label': `${m} ${k === 'context' ? '컨텍스트 크기' : '최대 출력 토큰'}` });
    return el('div', { class: 'models' },
      p.models.length ? el('div', { class: `mlist${claude ? '' : ' nout'}` },
        el('div', { class: 'mhead' }, el('span', {}, '모델'), el('span', {}, '컨텍스트 크기'), claude ? el('span', {}, '최대 출력') : null, el('span', {})),
        p.models.map((m, i) => el('div', { class: 'mrow' },
          el('span', { class: 'mname' }, el('span', { class: 'mono' }, m), i === 0 ? el('span', { class: 'meta' }, '기본') : null),
          limit(m, 'context'), claude ? limit(m, 'output') : null,
          el('button', { class: 'tbtn ico', title: '빼기', 'aria-label': '빼기', onclick: () => void save(p, (now) => ({ models: now.models.filter((x) => x !== m) })) }, icon('x'))))) : el('div', { class: 'chips' }, el('span', { class: 'desc' }, '모델이 없습니다')),
      p.models.length ? el('p', { class: 'note' }, claude
        ? '비워 두면 Claude Code 가 모르는 모델을 컨텍스트 200000, 출력 32000 토큰으로 봅니다. 실제 크기가 더 작으면 자동 압축 전에 요청이 넘칩니다.'
        : '비워 두면 Codex 가 모르는 모델을 컨텍스트 약 258000 토큰으로 봅니다. 실제 크기가 더 작으면 자동 압축 전에 요청이 넘칩니다.') : null,
      el('div', { class: 'addrow' }, input, fetchBtn),
      S.fetchErr ? el('p', { class: 'note err' }, `목록을 받지 못했습니다: ${S.fetchErr}`) : null,
      list);
  }

  // ---------- 탭: 세부 ----------
  function detailTab(p) {
    const headers = Object.entries(p.headers);
    const setHeaders = (list) => save(p, { headers: Object.fromEntries(list.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])) });
    const envText = Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join('\n');
    const envBox = el('textarea', { class: 'val env mono', 'data-f': 'env', rows: 3, spellcheck: 'false', placeholder: p.vendor === 'claude' ? 'API_TIMEOUT_MS=3000000' : 'NAME=VALUE' }, envText);
    envBox.addEventListener('change', () => void save(p, { env: Object.fromEntries(envBox.value.split('\n').map((l) => l.trim()).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)])) }));
    return el('div', { class: 'pane' },
      p.vendor === 'claude' ? el('section', {}, el('h3', {}, '키 전달'),
        row({ label: '헤더', ctl: el('select', { class: 'val', onchange: (e) => void save(p, { auth: e.target.value }) },
          el('option', { value: 'bearer', selected: p.auth === 'bearer' }, 'Authorization: Bearer'), el('option', { value: 'x-api-key', selected: p.auth === 'x-api-key' }, 'x-api-key')) })) : null,
      el('section', {}, el('h3', {}, '추가 헤더'),
        headers.map(([k, v], i) => el('div', { class: 'grp' }, el('div', { class: 'row kv' },
          field(k, (nk) => setHeaders(headers.map((h, j) => (j === i ? [nk, h[1]] : h))), { class: 'val mono', 'data-f': `hk:${i}` }),
          field(v, (nv) => setHeaders(headers.map((h, j) => (j === i ? [h[0], nv] : h))), { class: 'val wide mono', 'data-f': `hv:${i}` }),
          el('button', { class: 'tbtn ico', title: '빼기', 'aria-label': '빼기', onclick: () => void setHeaders(headers.filter((_, j) => j !== i)) }, icon('x'))))),
        el('button', { class: 'add', onclick: () => headerDialog(p) }, icon('plus'), '헤더')),
      p.vendor === 'claude' ? el('section', {}, el('h3', {}, '등급별 모델'),
        TIERS.map(([k, label]) => el('div', { class: 'grp' }, row({ label, ctl: field(p.tiers[k] ?? '', (v) => save(p, (now) => ({ tiers: { ...now.tiers, [k]: v.trim() } })), { class: 'val wide mono', 'data-f': `tier:${k}`, placeholder: '고른 모델' }) })))) : null,
      el('section', {}, el('h3', {}, '기능'),
        FEATURES.filter(([, , only]) => !only || only === p.vendor).map(([k, label]) => el('div', { class: 'grp' }, row({ label, ctl: sw(p.features[k], () => void save(p, (now) => ({ features: { ...now.features, [k]: !now.features[k] } })), label) })))),
      el('section', {}, el('h3', {}, '추가 env'), envBox));
  }

  // ---------- 대화상자 ----------
  let dlg = null;
  function showDialog(...kids) { dlg?.remove(); dlg = el('dialog', {}, ...kids); root.append(dlg); dlg.showModal(); return dlg; }
  const cancel = () => el('button', { class: 'btn', onclick: () => dlg.close() }, '취소');
  /** 대화상자의 요청 — 답이 오면 닫고 after(답)로 S 를 고쳐 그린다 */
  async function submit(err, method, params, after) {
    try { const r = await call(method, params); dlg.close(); after(r); draw(); } catch (e) { err.textContent = e.message; }
  }
  /** 새 프로바이더 — 카드를 누르면 그 템플릿 값으로 바로 만들고 일반 탭을 연다. 이름·벤더·주소·키는 거기서 고친다 (사용자 2026-11-26). 직접 만들기가 맨 앞 */
  function newDialog() {
    const err = el('div', { class: 'err' });
    let busy = false; // 빠르게 두 번 눌러도 하나만 만든다 (사용자 2026-11-26) — 실패하면 다시 누를 수 있다
    const create = (k) => {
      if (busy) return; busy = true;
      const t = S.templates[k], vendor = typeof t.claude === 'string' ? 'claude' : 'codex';
      void submit(err, 'provider.save', { provider: { template: k, name: k === 'custom' ? '새 프로바이더' : t.name, vendor, baseUrl: t[vendor], key: t.key ?? '', headers: t.headers ?? {}, models: t.models ?? [], tiers: t.tiers ?? {}, features: t.features } },
        (r) => { put(r.provider); S.sel = r.provider.id; S.tab = 'general'; S.fetched = null; }).finally(() => { busy = false; });
    };
    const card = (k) => el('button', { class: 'tcard', onclick: () => create(k) }, el('span', { class: 'nm' }, S.templates[k].name));
    showDialog(el('h4', {}, '새 프로바이더'),
      S.templates.custom ? el('button', { class: 'tcard own', onclick: () => create('custom') }, el('span', { class: 'plus', 'aria-hidden': 'true' }), el('span', { class: 'nm' }, S.templates.custom.name)) : null,
      el('div', { class: 'tlabel' }, '템플릿'),
      el('div', { class: 'tgrid' }, Object.keys(S.templates).filter((k) => k !== 'custom').map((k) => card(k))),
      err, el('div', { class: 'acts' }, cancel()));
    dlg.classList.add('wide');
  }
  function headerDialog(p) {
    let k = '', v = ''; const err = el('div', { class: 'err' });
    const ok = () => { if (!k.trim()) { err.textContent = '헤더 이름을 넣습니다.'; return; } void submit(err, 'provider.save', { provider: { id: p.id, headers: { ...p.headers, [k.trim()]: v } } }, (r) => put(r.provider)); };
    showDialog(el('h4', {}, '추가 헤더'),
      el('label', {}, '이름', el('input', { class: 'mono', oninput: (e) => { k = e.target.value; } })),
      el('label', {}, '값', el('input', { class: 'mono', oninput: (e) => { v = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') ok(); } })),
      err, el('div', { class: 'acts' }, cancel(), el('button', { class: 'btn solid', onclick: ok }, '넣기')));
    dlg.querySelector('input').focus();
  }
  /** 키 관리 — 키를 추가·고치기·지우기, 눌러서 이 프로바이더에 쓴다. 추가하면 바로 이 프로바이더에 쓴다. 쓰는 프로바이더가 있는 키는 지우지 못한다.
   *  쓰는 프로바이더는 S.rows 의 keyRef 로 센다 — 키의 used 는 목록을 읽을 때의 것이라 그 뒤 고친 것이 빠진다 */
  function keysDialog(p) {
    const err = el('div', { class: 'err' });
    const use = (k) => void submit(err, 'provider.save', { provider: { id: p.id, keyRef: k.id } }, (r) => put(r.provider));
    const item = (k) => {
      const used = S.rows.filter((x) => x.keyRef === k.id), mine = p.keyRef === k.id, others = used.filter((u) => u.id !== p.id);
      const box = el('div', { class: `kitem${mine ? ' on' : ''}` },
        el('button', { class: 'kpick', disabled: mine, title: mine ? '쓰는 중' : '이 프로바이더에 쓰기', onclick: () => use(k) },
          el('span', { class: 'nm' }, k.name), k.tail ? el('span', { class: 'mono tail' }, `••••${k.tail}`) : null,
          others.length ? el('span', { class: 'used', title: others.map((u) => u.name).join(', ') }, others.length === 1 ? others[0].name : `${others[0].name} 외 ${others.length - 1}`) : null),
        el('button', { class: 'tbtn ico', title: '값 바꾸기', 'aria-label': '값 바꾸기', onclick: () => edit() }, icon('pencil')),
        el('button', { class: 'tbtn ico kdel', title: used.length ? `${used.map((u) => u.name).join(', ')} 가 씁니다` : '지우기', 'aria-label': '지우기', disabled: used.length > 0,
          onclick: () => void call('provider.keyRemove', { id: k.id }).then(() => { S.keys = S.keys.filter((x) => x.id !== k.id); redraw(); }, (e) => { err.textContent = e.message; }) }, icon('trash')));
      const edit = () => {
        const inp = el('input', { class: 'mono', type: 'password', autocomplete: 'off', placeholder: '새 값', onkeydown: (e) => {
          if (e.key === 'Enter' && inp.value.trim()) void call('provider.keySave', { key: { id: k.id, value: inp.value } }).then((r) => { S.keys = upsert(S.keys, r.key); redraw(); draw(); }, (x) => { err.textContent = x.message; });
          else if (e.key === 'Escape') { e.preventDefault(); redraw(); } } });
        box.replaceChildren(el('span', { class: 'nm' }, k.name), inp); inp.focus();
      };
      return box;
    };
    const list = el('div', { class: 'klist' });
    const redraw = () => { p = S.rows.find((x) => x.id === p.id) ?? p; list.replaceChildren(...(S.keys.length ? S.keys.map(item) : [el('p', {}, '키가 없습니다')])); };
    showDialog(el('h4', {}, '키'), list, err,
      el('div', { class: 'acts' }, el('button', { class: 'btn', onclick: () => addKeyDialog(p) }, icon('plus'), '추가'), el('span', { class: 'grow' }), el('button', { class: 'btn', onclick: () => dlg.close() }, '닫기')));
    dlg.classList.add('wide');
    redraw();
  }
  /** 키 추가 — 키 창에서 연다. 넣으면 키 창으로 돌아가 목록에 보인다 (쓰려면 거기서 누른다), 취소도 키 창으로 */
  function addKeyDialog(p) {
    let name = '', value = ''; const err = el('div', { class: 'err' });
    const ok = () => {
      if (!name.trim() || !value.trim()) { err.textContent = '이름과 값을 넣습니다.'; return; }
      void call('provider.keySave', { key: { name, value } }).then((r) => { S.keys = upsert(S.keys, r.key); keysDialog(p); }, (e) => { err.textContent = e.message; });
    };
    showDialog(el('h4', {}, '키 추가'),
      el('label', {}, '이름', el('input', { oninput: (e) => { name = e.target.value; } })),
      el('label', {}, '값', el('input', { class: 'mono', type: 'password', autocomplete: 'off', oninput: (e) => { value = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') ok(); } })),
      err, el('div', { class: 'acts' }, el('button', { class: 'btn', onclick: () => keysDialog(p) }, '취소'), el('button', { class: 'btn solid', onclick: ok }, '추가')));
    dlg.querySelector('input').focus();
  }
  function removeDialog(p) {
    const err = el('div', { class: 'err' });
    showDialog(el('h4', {}, `${p.name}${objectJosa(p.name)} 지울까요?`),
      el('p', {}, '이 프로바이더로 만든 세션은 열리지 않습니다.'),
      err, el('div', { class: 'acts' }, cancel(), el('button', { class: 'btn danger', onclick: () => void submit(err, 'provider.remove', { id: p.id }, () => { S.rows = S.rows.filter((x) => x.id !== p.id); }) }, '지우기')));
  }

  /** 머리 — 이름(올리면 연필, 눌러 그 자리에서 고친다: Enter·밖을 누르면 저장, Esc 는 그대로), 템플릿 이름, 맨 오른쪽 지우기 (사용자 2026-11-26) */
  function head(p) {
    const name = el('h2', { title: p.name }, p.name);
    const edit = () => {
      const inp = el('input', { class: 'name-edit', value: p.name, spellcheck: 'false' });
      let done = false;
      const finish = (keep) => { if (done) return; done = true; const v = inp.value.trim(); if (keep && v && v !== p.name) void save(p, { name: v }); else draw(); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); });
      inp.addEventListener('blur', () => finish(true));
      box.replaceChildren(inp); inp.focus(); inp.select();
    };
    const box = el('div', { class: 'nmbox' }, name, el('button', { class: 'ico ed', title: '이름 바꾸기', 'aria-label': '이름 바꾸기', onclick: edit }, icon('pencil')));
    return el('div', { class: 'phd' }, box,
      p.template !== 'custom' && tplOf(p).name !== p.name ? el('span', { class: 'lock' }, tplOf(p).name) : null,
      el('span', { class: 'grow' }),
      el('button', { class: 'ico del', title: '지우기', 'aria-label': '지우기', onclick: () => removeDialog(p) }, icon('trash')));
  }

  // ---------- 그리기 ----------
  function drawStatus() {
    status.className = `pstat${S.error ? ' err' : ''}`;
    status.textContent = S.error ?? ''; // 고친 것은 바로 저장된다 — 저장 알림·안내 없이 오류만 (사용자 2026-11-26)
  }
  function draw() {
    drawStatus();
    if (!S.rows) { body.replaceChildren(el('div', { class: 'none' }, S.error ? '' : '읽는 중…')); return; }
    if (!S.rows.some((x) => x.id === S.sel)) S.sel = S.rows[0]?.id ?? null;
    const p = S.rows.find((x) => x.id === S.sel);
    // 다시 그려도 입력 중인 칸은 이어진다(data-f 로 찾는다) — 저장 답이 와서 다시 그릴 때 다음 칸에 넣던 글자·포커스가 날아가지 않게
    const f = body.contains(document.activeElement) ? document.activeElement : null;
    body.replaceChildren(
      el('div', { class: 'plist' },
        S.rows.map((x) => el('button', { class: 'pitem', 'aria-current': String(x === p), onclick: () => { S.sel = x.id; S.error = null; S.fetched = null; S.fetchErr = null; S.q = ''; draw(); } },
          el('span', { class: 'nm' }, x.name), el('span', { class: 'kind' }, ENGINE[x.vendor]))),
        el('button', { class: 'add', onclick: () => newDialog() }, icon('plus'), '새 프로바이더')),
      p ? el('div', { class: 'pdetail' },
        head(p),
        el('div', { class: 'tabs', role: 'tablist' }, [['general', '일반'], ['models', '모델'], ['detail', '세부']].map(([k, label]) => el('button', { class: 'tab', role: 'tab', 'aria-selected': String(S.tab === k), onclick: () => { S.tab = k; draw(); } }, label))),
        ({ general: generalTab, models: modelsTab, detail: detailTab }[S.tab] ?? generalTab)(p))
        : el('div', { class: 'pdetail' }, el('div', { class: 'none' }, 'OpenRouter 같은 제3자 프로바이더나 Ollama 같은 로컬 모델을 추가하면 모델 메뉴의 custom 칸에서 고를 수 있습니다.'),
          el('button', { class: 'btn solid', onclick: () => newDialog() }, icon('plus'), '새 프로바이더')));
    const n = f?.dataset.f ? body.querySelector(`[data-f="${CSS.escape(f.dataset.f)}"]`) : null;
    if (n) { n.value = f.value; n.focus(); n.setSelectionRange?.(f.selectionStart, f.selectionEnd); }
  }
  draw();
  return { el: root, status, load };
}
