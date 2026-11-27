// 에이전트 플러그인 관리 (ticket slcode-agent-plugin-ui) — `slcode plugin list` 가 보이는 것: 플러그인마다 호환 등급과 하네스별 빠지는 것, part 켜고 끄기(필수 part 는 잠금),
// 옵션 값, export(claude·codex, 해제 포함), 하네스별 마지막 빌드의 report.json, js/ts 훅·명령의 tsc 경고. 바꾸는 것은 plugins.set·export 가 `slcode plugin set·export` 로 한다.
// 시작 화면(start.js)에서만 연다 — 세션 화면에는 입구가 없다 (ticket slcode-agent-plugin-export-action, 사용자 2026-11-01: export 는 다른 하네스로 내보내는 일이라
// slcode 세션 사용자의 관심사가 아니다). 웹은 시작 화면 서버의 api/, superlite 카드는 카드가 `slcode start-page --call` 로 중계한다 — call(method, params) 만 다르다.
// 요소 도우미·스타일(style.css .ppanel)은 이 파일의 것.

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') n[k] = v;
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  n.append(...kids.flat().filter((x) => x != null && x !== false));
  return n;
};
const plus = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = '<path d="M12 5v14"/><path d="M5 12h14"/>'; return s; };
/** 추가·업데이트 오류(slcode-plugin 의 영어 error: 줄)를 한 줄 한국어로 — 모르는 오류는 원문 그대로 (ticket slcode-plugin-manager-add, 사용자 2026-11-27 문구) */
function human(msg) {
  if (/^cannot fetch: git is not installed/.test(msg)) return 'GitHub 에서 받으려면 이 PC 에 git 이 있어야 합니다.';
  if (/^cannot fetch .*(not found|could not read Username|Authentication failed|terminal prompts disabled)/i.test(msg)) return '저장소를 받지 못했습니다. 주소를 확인해 주세요. 비공개 저장소는 이 PC 의 git 에 로그인해 두어야 받을 수 있습니다.';
  if (/^no slcode-plugin\.json in .*\/agent-plugins\/fetch\//.test(msg)) return 'slcode-plugin.json 이 없습니다. 저장소 안의 폴더라면 주소 끝에 /tree/<브랜치>/<폴더> 를 붙입니다.';
  if (/^no slcode-plugin\.json in /.test(msg)) return '이 폴더에 slcode-plugin.json 이 없습니다.';
  const nf = /^no folder (.+?)(?: in https:\/\/\S+)?$/.exec(msg);
  if (nf) return `${nf[1]} 폴더가 없습니다.`;
  if (/^plugins\.add \{source/.test(msg)) return '폴더는 / 나 ~ 로 시작하는 경로로 넣어 주세요.';
  return msg;
}
const HARNESS = { claude: 'Claude', codex: 'Codex' };
const SHOWN = ['claude', 'codex']; // slcode 가 띄우는 하네스 — gpt 하네스는 아직 없다

/** call(method, params) → Promise. onChange 는 설정을 바꾼 뒤 (대화 화면이 사이드바의 다시 싣기 상태를 다시 묻는다) */
export function pluginsPanel(call, { onChange } = {}) {
  const root = el('div', { class: 'ppanel' });
  let rows = null, error = null, sel = null; // sel: 오른쪽에 보이는 플러그인 이름
  /** 추가 화면 (ticket slcode-plugin-manager-add, 사용자 2026-11-27 시안 C: 목록의 "플러그인 추가" 가 오른쪽을 추가 화면으로) — draft 는 넣은 값(실패해도 남긴다) */
  const add = { open: false, draft: '', busy: false, err: null };
  /** 플러그인별 화면 상태 — busy(하는 중인 일), err, notes(마지막 export 결과·set 경고), check(tsc 경고: null 이면 확인 중),
   *  pending(아직 적용하지 않은 바꿈 — 'part 이름' | 'opt 이름' → 값. 적용을 눌러야 plugin set 을 한 번 돌린다, 사용자 2026-10-31: 바꿀 때마다 빌드·export·검사가 돌아 느렸다) */
  const st = new Map();
  /** up: 마지막 업데이트·다시 add 의 결과 { msg, ok } — 출처 줄 끝에 */
  const of = (name) => { if (!st.has(name)) st.set(name, { busy: null, err: null, notes: [], check: undefined, open: new Set(), pending: new Map(), up: null }); return st.get(name); };

  async function load() {
    try { rows = (await call('plugins.list')).plugins; error = null; }
    catch (e) { error = `플러그인 목록을 읽지 못했습니다: ${e.message}`; }
    draw();
    for (const r of rows ?? []) if (hasScripts(r) && of(r.name).check === undefined) check(r.name);
  }
  // 훅 스크립트나 명령 파일(ticket slcode-agent-plugin-command)이 있으면 tsc 경고 칸을 둔다 — plugins.check 가 둘 다 본다
  const count = (x) => (x ? x.built.length + x.failed.length : 0);
  const hasScripts = (r) => !!(count(r.reports.claude?.scripts) + count(r.reports.claude?.commands));
  async function check(name) {
    const s = of(name);
    s.check = null; draw();
    try { s.check = (await call('plugins.check', { name })).warnings; } catch (e) { s.check = [`확인하지 못했습니다: ${e.message}`]; }
    draw();
  }
  async function act(name, label, fn) {
    const s = of(name);
    if (s.busy) return;
    s.busy = label; s.err = null; draw();
    try { await fn(s); } catch (e) { s.err = human(e.message); }
    s.busy = null;
    await load();
  }
  const apply = (name) => act(name, '적용하는 중', async (s) => {
    const r = await call('plugins.set', { name, set: [...s.pending].map(([k, v]) => `${k}=${v}`) });
    s.pending.clear();
    s.notes = (r.exports ?? []).flatMap((x) => x.notes);
    if (r.warnings.length || s.check !== undefined) s.check = r.warnings.filter((l) => !/: js\/ts hooks$/.test(l));
    onChange?.();
  });
  /** add·update 결과를 그 플러그인 칸에 — 판이 바뀌면 옛 판 → 새 판, 내용만 바뀌면 업데이트했습니다, 같으면 바뀐 것 없음, 처음 설치면 없음(목록에 보인다). old 는 그 전의 판(없으면 처음). 경고는 적용(set) 뒤와 같은 자리 */
  function landed(s, r, old, fresh) {
    s.up = !r.changed ? { msg: fresh ? '이미 설치되어 있고 바뀐 것이 없습니다' : '바뀐 것이 없습니다' }
      : old && old !== r.version ? { msg: `${old} → ${r.version}`, ok: true } : old ? { msg: '업데이트했습니다', ok: true } : null;
    s.notes = [...(r.leftOut ?? []), ...(r.exports ?? []).flatMap((x) => x.notes)];
    if (r.warnings?.length) s.check = r.warnings.filter((l) => !/: js\/ts hooks$/.test(l));
    onChange?.();
  }
  const update = (r) => act(r.name, '업데이트하는 중', async (s) => { s.up = null; landed(s, await call('plugins.update', { name: r.name }), r.version, false); });
  async function submit() {
    const source = add.draft.trim();
    if (!source || add.busy) return;
    add.busy = true; add.err = null; draw();
    try {
      const r = await call('plugins.add', { source });
      const name = r.base ?? r.name; // 애드온이면 합쳐진 플러그인을 연다
      landed(of(name), r, rows?.find((x) => x.name === r.name)?.version ?? null, true);
      Object.assign(add, { open: false, draft: '', busy: false });
      sel = name;
      await load();
    } catch (e) { add.busy = false; add.err = human(e.message); draw(); }
  }
  const exp = (name, h, remove) => act(name, remove ? `${HARNESS[h]} export 해제 중` : `${HARNESS[h]} 에 export 하는 중`, async (s) => {
    const r = (await call('plugins.export', { name, to: h, remove })).results[0];
    s.notes = r.notes.filter((n) => n !== 'not exported');
  });
  /** export·해제 확인 — 하네스 설정에 쓰고 지우는 일이라 스위치가 아니라 단추 + 이 확인을 거친다 (사용자 2026-11-01, 0.5.1 데모에서 part 대신 export 스위치를 눌러 해제됐다).
   *  카드 iframe 은 sandbox 라 confirm() 이 막혀 <dialog> 로 */
  const ask = el('dialog', { class: 'pconfirm' });
  function confirmExport(r, h, remove) {
    const H = HARNESS[h];
    ask.replaceChildren(el('h4', {}, remove ? `${r.name} 를 터미널 ${H} 에서 해제할까요?` : `${r.name} 를 터미널 ${H} 에 export 할까요?`),
      el('div', { class: 'acts' },
        el('button', { onclick: () => ask.close() }, '취소'),
        el('button', { class: remove ? 'danger' : 'solid', onclick: () => { ask.close(); exp(r.name, h, remove); } }, remove ? '해제' : 'export')));
    ask.showModal();
  }

  // 꼴 (사용자 2026-10-31): 왼쪽은 플러그인 목록(이름·판·등급·export), 오른쪽은 고른 플러그인의 자세한 내용. 좁으면 목록이 위로
  function draw() {
    if (rows && !rows.some((r) => r.name === sel)) sel = rows[0]?.name ?? null;
    const showAdd = add.open || (rows && !rows.length); // 빈 목록이면 처음부터 추가 화면
    const cur = showAdd ? null : rows?.find((r) => r.name === sel);
    root.replaceChildren(...[
      el('nav', { class: 'plist' }, ...(rows ?? []).map((r) => el('button', { class: 'pitem', 'aria-current': !showAdd && r.name === sel ? 'true' : null, onclick: () => { sel = r.name; add.open = false; draw(); } },
        el('span', { class: 'nm' }, r.name), el('span', { class: `grade ${r.grade}` }, r.grade),
        el('span', { class: 'sub' }, [r.version, r.exports.length ? `export ${r.exports.map((h) => HARNESS[h]).join('·')}` : null].filter(Boolean).join(' · ')))),
        rows && !rows.length ? el('p', { class: 'none' }, '설치한 플러그인이 없습니다') : null,
        !rows && !error ? el('p', { class: 'none' }, '읽는 중…') : null,
        rows ? el('button', { class: 'add', 'aria-current': showAdd ? 'true' : null, onclick: () => { add.open = true; draw(); } }, plus(), '플러그인 추가') : null),
      el('div', { class: 'pdetail' },
        showAdd ? null : el('p', { class: 'note' }, '바꾼 설정은 새 세션부터 적용됩니다.'),
        error ? el('p', { class: 'err' }, error) : null,
        showAdd ? addForm() : null,
        cur ? plugin(cur) : null,
        cur ? applyBar(cur.name) : null),
      ask].filter(Boolean));
  }
  /** 추가 화면 — 칸 하나와 추가 단추. 실패 사유는 칸 아래 */
  function addForm() {
    const btn = el('button', { class: 'solid', disabled: add.busy || !add.draft.trim(), onclick: () => void submit() }, add.busy ? '추가하는 중…' : '추가');
    const inp = el('input', { placeholder: '폴더 경로 또는 GitHub 주소', 'aria-label': '폴더 경로 또는 GitHub 주소', spellcheck: 'false', value: add.draft, disabled: add.busy,
      oninput: () => { add.draft = inp.value; btn.disabled = !add.draft.trim(); }, onkeydown: (e) => { if (e.key === 'Enter') void submit(); } });
    if (!add.busy) queueMicrotask(() => { if (inp.isConnected) { inp.focus(); inp.setSelectionRange(add.draft.length, add.draft.length); } });
    return el('section', { class: 'addform' }, el('h3', {}, '플러그인 추가'), el('div', { class: 'row' }, inp, btn), add.err ? el('p', { class: 'err' }, add.err) : null);
  }

  /** 적용 막대 — 바꾼 것이 있을 때만 보인다. 바꿀 때는 화면을 다시 그리지 않고 이것만 바꾼다(다시 그리면 입력칸을 떠나며 누른 다음 스위치의 클릭이 사라진다) */
  let bar = null;
  function applyBar(name) {
    const s = of(name);
    const count = el('span', { class: 'sub' });
    bar = el('div', { class: 'apply' }, count,
      el('button', { disabled: !!s.busy, onclick: () => { s.pending.clear(); draw(); } }, '되돌리기'),
      el('button', { class: 'solid', disabled: !!s.busy, onclick: () => apply(name) }, '적용'));
    bar.paint = () => { bar.hidden = !s.pending.size; count.textContent = `바꾼 항목 ${s.pending.size}`; };
    bar.paint();
    return bar;
  }

  /** 펼침 상태를 다시 그려도 남긴다 */
  const fold = (s, key, summary, ...body) => {
    const d = el('details', { open: s.open.has(key) }, el('summary', {}, summary), ...body);
    d.addEventListener('toggle', () => { if (d.open) s.open.add(key); else s.open.delete(key); });
    return d;
  };
  const sw = (on, disabled, onchange, label) => el('input', { type: 'checkbox', role: 'switch', checked: on, disabled, 'aria-label': label, onchange });
  const line = (name, sub, control, cls) => el('div', { class: `ln${cls ? ` ${cls}` : ''}` }, el('span', { class: 'nm' }, name, sub ? el('span', { class: 'sub' }, sub) : null), control);

  /** part 줄들 — 조건 when part 의 대상이 꺼지면(사슬 포함) 그 줄은 비활성으로 보인다 (사용자 2026-11-03, ticket slcode-agent-plugin-part-when-part). 스위치 값은 사용자 설정 그대로라
   *  대상을 다시 켜면 돌아온다. 아직 적용하지 않은 바꿈까지 본다 — 다시 그리면 다음 스위치의 클릭이 사라지므로(applyBar) 줄의 모양만 바꾼다. param·env 는 세션마다 달라 여기서 보지 않는다 */
  function partLines(r, s, off) {
    const spec = new Map(r.parts.map((p) => [p.name, p]));
    const switched = (p) => (s.pending.has(p.name) ? s.pending.get(p.name) === 'on' : p.on);
    const alive = (p) => switched(p) && p.needs.every((t) => alive(spec.get(t)));
    const lines = r.parts.map((p) => line(p.name, [p.required ? '필수' : null, p.addon ? `애드온 ${p.addon}` : null, p.when ? `조건 ${p.when}` : null].filter(Boolean).join(' · ') || null, // 조건은 세션마다 본다 — 스위치는 사용자 설정 (ticket slcode-agent-plugin-part-when)
      sw(switched(p), off || p.required, (e) => stage(s, p.name, e.target.checked ? 'on' : 'off', p.on ? 'on' : 'off', e.target), p.name), s.pending.has(p.name) ? 'changed' : null));
    s.paintParts = () => r.parts.forEach((p, i) => {
      const blocked = !p.needs.every((t) => alive(spec.get(t)));
      lines[i].classList.toggle('blocked', blocked);
      lines[i].querySelector('input').disabled = off || p.required || blocked;
    });
    s.paintParts();
    return lines;
  }

  function plugin(r) {
    const s = of(r.name);
    const off = !!s.busy;
    const lost = SHOWN.filter((h) => r.lost[h]?.length);
    return el('section', { class: 'plug' },
      el('header', {}, el('h3', {}, r.name), el('span', { class: 'ver' }, r.version),
        el('span', { class: `grade ${r.grade}` }, r.grade),
        s.busy ? el('span', { class: 'busy' }, `${s.busy}…`) : null),
      // 출처와 업데이트 (ticket slcode-plugin-manager-add) — 주소면 다시 받고 폴더면 다시 복사한다
      el('div', { class: 'src' }, el('span', {}, '출처'), el('code', { title: r.source }, r.source),
        s.up?.msg ? el('span', { class: s.up.ok ? 'ok' : null }, s.up.msg) : null,
        el('button', { disabled: off, onclick: () => update(r) }, '업데이트')),
      lost.length ? el('div', { class: 'lost' }, ...lost.map((h) => fold(s, `lost.${h}`, `${HARNESS[h]} 에서 빠지는 것 ${r.lost[h].length}`, el('ul', {}, ...r.lost[h].map((x) => el('li', {}, x)))))) : null,
      r.parts.length ? el('div', { class: 'grp' }, el('h4', {}, 'part'), ...partLines(r, s, off)) : null,
      // 애드온 (ticket slcode-plugin-addon) — 켜고 끄는 단위가 아니라 스위치가 없다. part 는 위 목록에 함께 있다. 빠진 것은 사유를 보인다
      r.addons.length ? el('div', { class: 'grp' }, el('h4', {}, '애드온'), ...r.addons.map((a) => line(a.name, a.on ? a.version : `${a.version} · 빠짐: ${a.why}`, null, a.on ? null : 'blocked'))) : null,
      r.options.length ? el('div', { class: 'grp' }, el('h4', {}, '옵션'), ...r.options.map((o) => option(r, o, off))) : null,
      hasScripts(r) ? el('div', { class: 'grp' }, el('h4', {}, 'js/ts 훅·명령'),
        s.check == null ? el('p', { class: 'note' }, '확인하는 중…') : s.check.length ? el('ul', { class: 'warns' }, ...s.check.map((x) => el('li', {}, x.trim()))) : el('p', { class: 'note' }, '경고 없음')) : null,
      el('div', { class: 'grp' }, el('h4', {}, '마지막 빌드'),
        ...SHOWN.map((h) => r.reports[h] ? fold(s, `rep.${h}`, el('span', {}, `${HARNESS[h]} `, el('code', {}, r.reports[h].build.slice(0, 12)), ' report.json'), el('pre', {}, JSON.stringify(r.reports[h], null, 2)))
          : el('div', { class: 'none' }, `${HARNESS[h]} 빌드 없음`))),
      // 터미널 하네스로 export (사용자 2026-11-01, 프로토타입 E1) — part·옵션과 다른 일이라 맨 아래 따로, 적용 막대와 상관없이 확인하면 바로 반영
      el('div', { class: 'grp exp' }, el('h4', {}, '터미널로 export'),
        ...SHOWN.map((h) => { const on = r.exports.includes(h); return line(HARNESS[h], h === 'codex' ? el('span', { class: 'restricted' }, 'restricted') : null,
          el('span', { class: 'ctl' }, on ? el('span', { class: 'st on' }, 'export 됨') : null,
            el('button', { class: on ? 'danger' : 'solid', disabled: off, onclick: () => confirmExport(r, h, on) }, on ? 'export 해제' : `${HARNESS[h]} 로 export`))); }),
        r.exports.includes('codex') ? el('p', { class: 'note' }, 'codex 의 훅 검토에서 Trust all and continue 를 골라야 지시문과 훅이 돕니다.') : null,
        r.exports.includes('claude') ? el('p', { class: 'note' }, '열려 있는 claude 는 /reload-plugins 로 다시 싣습니다.') : null,
        ...r.exports.map((h) => r.exported[h]?.excluded.length ? fold(s, `exc.${h}`, `${HARNESS[h]} export 에서 빠지는 것 ${r.exported[h].excluded.length}`, el('ul', {}, ...r.exported[h].excluded.map((x) => el('li', {}, x)))) : null)),
      s.notes.length ? el('ul', { class: 'warns' }, ...s.notes.map((x) => el('li', {}, x))) : null,
      s.err ? el('p', { class: 'err' }, s.err) : null);
  }

  /** 적용 전 바꿈에 넣는다 — 저장된 값으로 돌아오면 뺀다. ctl 은 바꾼 입력 요소 (그 줄의 표시만 바꾼다) */
  function stage(s, key, v, saved, ctl) {
    if (v === saved) s.pending.delete(key); else s.pending.set(key, v);
    ctl.closest('.ln')?.classList.toggle('changed', s.pending.has(key));
    s.paintParts?.();
    bar?.paint();
  }

  /** 옵션 한 줄 — boolean 은 스위치, 나머지는 입력칸(Enter·포커스를 뗄 때 바꿈에 넣는다) */
  function option(r, o, off) {
    const s = of(r.name);
    const name = o.label ?? o.name, sub = o.label ? o.name : null;
    const saved = String(o.value ?? '');
    const v = s.pending.has(o.name) ? s.pending.get(o.name) : saved;
    const cls = s.pending.has(o.name) ? 'changed' : null;
    if (o.type === 'boolean') return line(name, sub, sw(v === 'true', off, (e) => stage(s, o.name, String(e.target.checked), saved, e.target), name), cls);
    const input = el('input', { type: o.type === 'number' ? 'number' : 'text', value: v, placeholder: `기본값 ${o.default}`, disabled: off, 'aria-label': name,
      onkeydown: (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = saved; stage(s, o.name, saved, saved, input); input.blur(); } },
      oninput: () => stage(s, o.name, input.value, saved, input) });
    return line(name, sub, input, cls);
  }

  draw();
  return { el: root, load };
}
