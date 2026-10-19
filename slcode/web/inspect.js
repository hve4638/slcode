// inspect 모달 (ticket slcode-inspect-proxy, 사용자 결정 2026-10-18) — 턴 마지막 응답 아래 inspect 버튼이 연다.
// 왼쪽은 그 턴 동안 나간 API 호출 카드, 오른쪽은 고른 호출의 탭 요약 | request | response | raw.
// 메시지 호출(요청 본문에 messages 가 있는 Anthropic, input 이 있는 OpenAI Responses — codex, ticket slcode-inspect-codex)이 아니면 요약과 raw 만 — 모르는 경로도 raw 는 늘 보인다.
// codex 의 WebSocket 호출(method WS)은 보낸 메시지 하나와 받은 이벤트들이고, 증분 요청은 core 가 다시 만든 전체 요청(reqFull)으로 그린다 (raw 는 보낸 그대로).
// 원본은 카드를 고를 때 받는다 — 요청 하나가 수 MB 다.

const CTX_DEFAULT = 200000; // 컨텍스트 창을 모르는 호출(부수 호출 등)의 막대 끝
const FREE_KEY = 'slcode.inspect.free'; // request 막대에 남은 공간을 보일지 — 브라우저에 기억한다
const CATS = { system: 'system', tools: 'tools', user: 'user', assistant: 'assistant', other: '기타' };
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);
const num = (n) => (n == null ? null : Number(n).toLocaleString());
const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const parse = (t) => { try { return JSON.parse(t); } catch { return null; } };
const hdr = (o, k) => { const v = o?.[k]; return Array.isArray(v) ? v.join(', ') : v; };
const heads = (o) => Object.entries(o ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n');
const ok = (c) => !c.error && c.status != null && c.status < 400;

/** 응답 본문을 메시지 하나로 — SSE(와 WebSocket 이벤트)면 message_start 에 블록·delta 를 이어 붙이고, 아니면 JSON 그대로. compact 된 호출은 이미 메시지 하나의 JSON.
 *  OpenAI Responses 는 response.created 에 output_item.done 의 항목을 모으고 끝 이벤트의 response 로 덮는다 (src/inspectDb.ts sseMessage 와 같은 규칙) */
export function responseOf(rec) {
  if (rec.compacted) { const m = parse(rec.resBody); if (m) return m; }
  if (rec.method !== 'WS' && !String(hdr(rec.resHeaders, 'content-type') ?? '').includes('event-stream')) return parse(rec.resBody);
  let msg = null, limits = null;
  const json = [];
  for (const chunk of rec.resBody.split(/\r?\n\r?\n/)) {
    const ev = parse(chunk.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join('\n'));
    if (!ev) continue;
    if (ev.type === 'codex.rate_limits') limits = ev;
    else if (ev.type === 'response.created' || ev.type === 'response.in_progress') msg = { ...ev.response, output: msg?.output ?? [] };
    else if (ev.type === 'response.output_item.done') { msg ??= { output: [] }; msg.output[ev.output_index ?? msg.output.length] = ev.item; }
    else if (ev.type === 'response.completed' || ev.type === 'response.incomplete' || ev.type === 'response.failed') msg = { ...msg, ...ev.response, output: ev.response?.output?.length ? ev.response.output : msg?.output ?? [] };
    else if (ev.type === 'message_start') msg = { ...ev.message, content: [] };
    else if (ev.type === 'error') msg = { ...msg, error: ev.error };
    else if (!msg) continue;
    else if (ev.type === 'content_block_start') msg.content[ev.index] = { ...ev.content_block };
    else if (ev.type === 'content_block_delta') {
      const b = msg.content[ev.index], d = ev.delta;
      if (!b) continue;
      if (d.type === 'text_delta') b.text = (b.text ?? '') + d.text;
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
      else if (d.type === 'input_json_delta') json[ev.index] = (json[ev.index] ?? '') + d.partial_json;
      else if (d.type === 'citations_delta') (b.citations ??= []).push(d.citation);
    } else if (ev.type === 'content_block_stop' && json[ev.index] && msg.content[ev.index]) msg.content[ev.index].input = parse(json[ev.index]) ?? json[ev.index];
    else if (ev.type === 'message_delta') { Object.assign(msg, ev.delta); msg.usage = { ...msg.usage, ...ev.usage }; }
  }
  if (msg && limits) msg.codex_rate_limits = { plan_type: limits.plan_type, ...limits.rate_limits, credits: limits.credits };
  return msg;
}

/** h: app.js 의 요소 생성기, rpc: transport.request, ctxMax: 지금 세션의 컨텍스트 창 크기(session.status, 모르면 null), copyBtn(text): 복사 아이콘 버튼 */
export function inspectDialog(h, rpc, ctxMax, copyBtn) {
  const title = h('h2', {}, 'inspect');
  const list = h('div', { class: 'ilist' });
  const tabs = h('div', { class: 'itabs' });
  const pane = h('div', { class: 'ipane' });
  const dlg = h('dialog', { class: 'inspect' },
    h('header', {}, title, h('button', { class: 'ghost x', title: '닫기', 'aria-label': '닫기', onclick: () => dlg.close() }, '✕')),
    h('div', { class: 'ibody' }, list, h('div', { class: 'idetail' }, tabs, pane)));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // 바깥(backdrop)을 누르면 닫는다
  const dim = (t) => h('div', { class: 'dim' }, t);
  const errEl = (t) => h('div', { class: 'err' }, t);
  let sid = null, tab = '요약', gen = 0, showFree = localStorage.getItem(FREE_KEY) !== 'hide';
  const recs = new Map();

  async function open(id, end) {
    sid = id; recs.clear(); const my = ++gen;
    title.textContent = 'inspect';
    list.replaceChildren(dim('불러오는 중…')); tabs.replaceChildren(); pane.replaceChildren();
    dlg.showModal();
    try {
      const { calls } = await rpc('session.inspectTurn', { id, end });
      if (my !== gen) return;
      title.textContent = `inspect · 호출 ${calls.length}개`;
      if (!calls.length) { list.replaceChildren(dim('이 턴에 기록된 호출이 없습니다. inspect 가 꺼져 있던 턴입니다.')); return; }
      const cards = calls.map((c) => card(c));
      list.replaceChildren(...cards);
      const first = cards.find((b) => !b.disabled);
      if (first) first.click();
    } catch (e) { if (my === gen) list.replaceChildren(errEl(e.message)); }
  }

  function card(c) {
    const path = c.path.split('?')[0];
    const st = c.dropped ? h('span', { class: 'st' }, '지움') : ok(c) ? h('span', { class: 'st ok' }, `${c.status} 성공`) : h('span', { class: 'st bad', title: c.error ?? '' }, `${c.status ?? ''} 실패`.trim());
    const b = h('button', { class: 'icard', title: c.dropped ? '전체 상한(10GB)을 넘어 지운 호출입니다' : c.path, disabled: c.dropped ? '' : null },
      h('div', { class: 'top' }, h('span', { class: 'path' }, `${c.method} ${path}`), st),
      c.model ? h('div', { class: 'model' }, c.model) : null,
      h('div', { class: 'bot' }, h('span', {}, stamp(c.at)), h('span', {}, `${(c.ms / 1000).toFixed(1)}s ↑${kb(c.reqBytes)} ↓${kb(c.resBytes)}`)),
      c.error ? h('div', { class: 'cerr' }, c.error) : null);
    b.onclick = () => select(c, b);
    return b;
  }

  async function select(c, b) {
    for (const x of list.children) x.classList.toggle('sel', x === b);
    const my = ++gen;
    pane.replaceChildren(dim('불러오는 중…')); tabs.replaceChildren();
    let rec = recs.get(c.n);
    if (!rec) {
      try { rec = await rpc('session.inspectCall', { id: sid, n: c.n }); } catch (e) { if (my === gen) pane.replaceChildren(errEl(e.message)); return; }
      recs.set(c.n, rec);
    }
    if (my !== gen) return;
    const req = parse(rec.reqFull ?? rec.reqBody);
    const oa = Array.isArray(req?.input) && !Array.isArray(req?.messages);
    const isMsg = Array.isArray(req?.messages) || oa;
    const v = { rec, req: isMsg ? req : null, res: isMsg ? responseOf(rec) : null, oa };
    const views = { 요약: summary, ...(isMsg ? { request, response } : {}), raw };
    if (!views[tab]) tab = '요약';
    const show = (name) => { tab = name; for (const t of tabs.children) t.setAttribute('aria-pressed', String(t.textContent === name)); pane.replaceChildren(...views[name](v).filter((x) => x != null)); pane.scrollTop = 0; };
    tabs.replaceChildren(...Object.keys(views).map((name) => h('button', { class: 'tab', onclick: () => show(name) }, name)));
    show(tab);
  }

  // ---- 요약 — 요청·응답 본문과 헤더에서 뽑은 값. 없는 값은 줄을 뺀다 (모델·max_tokens·temperature·thinking·stream 은 '보내지 않음' 으로 남긴다)
  const kv = (rows) => h('dl', { class: 'kv' }, ...rows.filter(([, val]) => val != null && val !== '').flatMap(([k, val]) => [h('dt', {}, k), h('dd', {}, val)]));
  const sec = (name, ...kids) => h('section', {}, h('h4', {}, name), ...kids);
  const jsonShort = (x) => (typeof x === 'object' ? JSON.stringify(x) : String(x));
  function summary({ rec, req, res, oa }) {
    const out = [sec('호출', kv([
      ['요청', `${rec.method} ${rec.path}`], ['상태', rec.status != null ? `${rec.status}${ok(rec) ? ' 성공' : ' 실패'}` : '응답 없음'], ['오류', rec.error],
      ['시각', stamp(rec.at)], ['소요', `${(rec.ms / 1000).toFixed(2)}s`], ['보낸 크기', kb(rec.reqBytes)], ['받은 크기', kb(rec.resBytes)],
      ['content-type', hdr(rec.resHeaders, 'content-type')], ['request-id', hdr(rec.resHeaders, 'request-id')],
    ]))];
    if (oa) out.push(...oaSummary(rec, req, res));
    else if (req) {
      const roles = {};
      for (const m of req.messages) roles[m.role] = (roles[m.role] ?? 0) + 1;
      const th = req.thinking;
      const known = new Set(['model', 'max_tokens', 'temperature', 'top_p', 'top_k', 'thinking', 'stream', 'tool_choice', 'system', 'tools', 'messages', 'stop_sequences']);
      out.push(sec('요청', kv([
        ['모델', req.model ?? '보내지 않음'], ['max_tokens', num(req.max_tokens) ?? '보내지 않음'], ['temperature', req.temperature ?? '보내지 않음'],
        ['top_p', req.top_p], ['top_k', req.top_k], ['thinking', th ? [th.type, th.budget_tokens != null ? `budget ${num(th.budget_tokens)}` : null, th.display].filter(Boolean).join(' · ') : '보내지 않음'],
        ['stream', req.stream != null ? String(req.stream) : '보내지 않음'], ['tool_choice', req.tool_choice && jsonShort(req.tool_choice)], ['stop_sequences', req.stop_sequences && jsonShort(req.stop_sequences)],
        ['system', Array.isArray(req.system) ? `블록 ${req.system.length}개` : req.system ? '문자열' : null], ['tools', req.tools ? `${req.tools.length}개` : null],
        ['messages', `${req.messages.length}개 (${Object.entries(roles).map(([r, n]) => `${r} ${n}`).join(' · ')})`],
        ...Object.keys(req).filter((k) => !known.has(k)).map((k) => [k, jsonShort(req[k])]),
        ['요청 분류', hdr(rec.reqHeaders, 'x-claude-code-request-class')], ['anthropic-beta', hdr(rec.reqHeaders, 'anthropic-beta')?.split(',').join('\n')],
      ])));
    }
    if (res && !oa) {
      const u = res.usage ?? {};
      const blocks = {};
      for (const b of (res.content ?? []).filter(Boolean)) blocks[b.type] = (blocks[b.type] ?? 0) + 1;
      const cw = u.cache_creation;
      out.push(sec('응답', kv([
        ['id', res.id], ['모델', res.model], ['stop_reason', res.stop_reason], ['stop_sequence', res.stop_sequence],
        ['블록', Object.entries(blocks).map(([t, n]) => `${t} ${n}`).join(' · ')], ['오류', res.error && `${res.error.type}: ${res.error.message}`],
      ])), sec('토큰', kv([
        ['입력', num(u.input_tokens)], ['캐시 읽기', num(u.cache_read_input_tokens)],
        ['캐시 쓰기', num(u.cache_creation_input_tokens) && `${num(u.cache_creation_input_tokens)}${cw ? ` (5분 ${num(cw.ephemeral_5m_input_tokens ?? 0)} · 1시간 ${num(cw.ephemeral_1h_input_tokens ?? 0)})` : ''}`],
        ['입력 합계', u.input_tokens != null ? num((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)) : null],
        ['출력', num(u.output_tokens) && `${num(u.output_tokens)}${u.output_tokens_details?.thinking_tokens ? ` (thinking ${num(u.output_tokens_details.thinking_tokens)})` : ''}`], ['service_tier', u.service_tier],
      ])));
    }
    // 플랜 리밋 — reset 은 시각, utilization 은 % 로. codex(ChatGPT 로그인)는 x-codex-primary·secondary-* (reset-at 은 초 단위 시각, used-percent 는 %)
    const LIMIT = /^(anthropic-ratelimit-|x-codex-(?=primary|secondary|credits))/;
    const limits = Object.keys(rec.resHeaders ?? {}).filter((k) => LIMIT.test(k)).sort();
    if (limits.length) out.push(sec('rate limit', kv(limits.map((k) => {
      const val = hdr(rec.resHeaders, k), name = k.replace(LIMIT, '');
      return [name, /reset(-at)?$/.test(name) && /^\d+$/.test(val) ? stamp(Number(val) * 1000) : /utilization$/.test(name) && !isNaN(val) ? `${Math.round(Number(val) * 100)}%` : /percent$/.test(name) && !isNaN(val) ? `${val}%` : val];
    }))));
    return out;
  }

  // OpenAI Responses (codex) — input 은 항목 배열(message·function_call·reasoning…), 토큰은 input_tokens 가 캐시 읽기를 포함한다
  const kindOf = (it) => (it?.type === 'message' || !it?.type ? it?.role ?? 'message' : it.type);
  function oaSummary(rec, req, res) {
    const out = [];
    const counts = {};
    for (const it of req.input) counts[kindOf(it)] = (counts[kindOf(it)] ?? 0) + 1;
    const sent = rec.reqFull ? parse(rec.reqBody) : null;
    const r = req.reasoning;
    const known = new Set(['type', 'model', 'instructions', 'input', 'tools', 'reasoning', 'stream', 'store', 'tool_choice', 'parallel_tool_calls', 'include', 'prompt_cache_key', 'previous_response_id', 'text', 'client_metadata']);
    out.push(sec('요청', kv([
      ['모델', req.model ?? '보내지 않음'], ['reasoning', r ? [r.effort, r.summary && `summary ${r.summary}`].filter(Boolean).join(' · ') : '보내지 않음'],
      ['stream', req.stream != null ? String(req.stream) : '보내지 않음'], ['store', req.store != null ? String(req.store) : null],
      ['tool_choice', req.tool_choice && jsonShort(req.tool_choice)], ['parallel_tool_calls', req.parallel_tool_calls != null ? String(req.parallel_tool_calls) : null],
      ['instructions', typeof req.instructions === 'string' ? `${num(req.instructions.length)}자` : null], ['tools', req.tools ? `${req.tools.length}개` : null],
      ['input', `${req.input.length}개 (${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' · ')})`],
      ['보낸 input', sent ? `${(sent.input ?? []).length}개 (WebSocket 증분, 앞 응답 ${sent.previous_response_id} 에 이어서)` : null],
      ['previous_response_id', !sent ? req.previous_response_id : null], ['prompt_cache_key', req.prompt_cache_key], ['include', req.include && jsonShort(req.include)], ['text', req.text && jsonShort(req.text)],
      ...Object.keys(req).filter((k) => !known.has(k)).map((k) => [k, jsonShort(req[k])]),
    ])));
    if (res) {
      const u = res.usage ?? {};
      const items = {};
      for (const it of (res.output ?? []).filter(Boolean)) items[kindOf(it)] = (items[kindOf(it)] ?? 0) + 1;
      out.push(sec('응답', kv([
        ['id', res.id], ['모델', res.model], ['status', res.status], ['출력', Object.entries(items).map(([k, n]) => `${k} ${n}`).join(' · ')],
        ['incomplete', res.incomplete_details?.reason], ['오류', res.error && (res.error.message ?? jsonShort(res.error))], ['service_tier', res.service_tier],
      ])), sec('토큰', kv([
        ['입력 합계', num(u.input_tokens)], ['캐시 읽기', num(u.input_tokens_details?.cached_tokens)],
        ['출력', num(u.output_tokens) && `${num(u.output_tokens)}${u.output_tokens_details?.reasoning_tokens ? ` (reasoning ${num(u.output_tokens_details.reasoning_tokens)})` : ''}`],
        ['합계', num(u.total_tokens)],
      ])));
      // codex 의 사용량 한도 (ChatGPT 로그인 — codex.rate_limits 이벤트)
      const rl = res.codex_rate_limits;
      const win = (w) => w && `${w.used_percent}% 사용 · ${w.window_minutes >= 1440 ? `${w.window_minutes / 1440}일` : `${w.window_minutes / 60}시간`} 창 · ${w.reset_at ? `${stamp(w.reset_at * 1000)} 리셋` : ''}`;
      if (rl) out.push(sec('rate limit', kv([['plan', rl.plan_type], ['primary', win(rl.primary)], ['secondary', win(rl.secondary)], ['limit_reached', rl.limit_reached ? 'true' : null],
        ['credits', rl.credits && (rl.credits.unlimited ? 'unlimited' : rl.credits.has_credits ? rl.credits.balance : null)]])));
    }
    return out;
  }

  // ---- request — 컨텍스트 구성 막대 + role 별 카드. 구간 길이는 JSON 길이 비율을 응답의 입력 토큰 합에 맞춘 추정
  function request({ rec, req, res, oa }) {
    const segs = [];
    const cardsEl = h('div', { class: 'cards' });
    const add = (cat, label, x, el) => { segs.push({ cat, label, size: JSON.stringify(x).length, el }); cardsEl.append(el); };
    const toolCard = (tools) => mcard('tools', 'tools', `${tools.length}개`, tools.map((t) =>
      h('details', { class: 'tool' }, h('summary', {}, h('b', {}, t.name ?? t.type), ' ', h('span', { class: 'dim' }, String(t.description ?? t.type ?? '').split('\n')[0])), h('pre', {}, JSON.stringify(t, null, 2)))));
    // OpenAI: instructions 는 system 칸, developer 메시지도 system, 도구 결과(*_output)는 Anthropic 의 tool_result 처럼 user, 모델이 낸 항목(호출·reasoning)은 assistant
    if (oa) {
      if (typeof req.instructions === 'string' && req.instructions) add('system', 'instructions', req.instructions, mcard('system', 'instructions', `${num(req.instructions.length)}자`, [blockEl({ type: 'input_text', text: req.instructions })]));
      if (req.tools?.length) add('tools', `tools ${req.tools.length}개`, req.tools, toolCard(req.tools));
      req.input.forEach((it, i) => {
        const k = kindOf(it);
        // codex 0.159 는 도구 목록을 input 의 additional_tools 항목으로 보낸다 (맨 위 tools 없이, 2026-10-19 실측)
        const cat = it?.type === 'message' || !it?.type ? (k === 'developer' || k === 'system' ? 'system' : CATS[k] && k !== 'tools' ? k : 'other') : it.type === 'additional_tools' ? 'tools' : /_output$/.test(it.type) ? 'user' : 'assistant';
        const parts = it?.type === 'message' || !it?.type ? (typeof it?.content === 'string' ? [{ type: 'input_text', text: it.content }] : it?.content ?? []) : [it];
        add(cat, `#${i + 1} ${k}`, it, mcard(cat, `#${i + 1} ${k}`, parts.length > 1 ? `블록 ${parts.length}개` : '', parts.map(blockEl)));
      });
    } else if (req.system?.length) {
      const sys = typeof req.system === 'string' ? [{ type: 'text', text: req.system }] : req.system;
      add('system', 'system', req.system, mcard('system', 'system', `블록 ${sys.length}개`, sys.map(blockEl)));
    }
    if (!oa && req.tools?.length) add('tools', `tools ${req.tools.length}개`, req.tools, toolCard(req.tools));
    if (!oa) req.messages.forEach((m, i) => {
      const cat = CATS[m.role] && m.role !== 'tools' ? m.role : 'other';
      const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [];
      add(cat, `#${i + 1} ${m.role}`, m, mcard(cat, `#${i + 1} ${m.role}`, content.length > 1 ? `블록 ${content.length}개` : '', content.map(blockEl)));
    });
    const u = res?.usage;
    const chars = segs.reduce((s, x) => s + x.size, 0) || 1;
    const total = u?.input_tokens != null ? u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : Math.round(chars / 3.5);
    // 컨텍스트 창은 메인 요청만 안다 — Claude 는 request-class 헤더, codex 는 도구가 있는 요청(메인·서브 에이전트)
    const main = oa ? !!req.tools?.length || req.input.some((it) => it?.type === 'additional_tools') : hdr(rec.reqHeaders, 'x-claude-code-request-class') === 'main';
    const max = Math.max(total, (main && ctxMax()) || CTX_DEFAULT);
    const tok = (x) => Math.round((x.size / chars) * total);
    // 막대는 위에 고정된다 — 카드가 막대 바로 아래에 오게 스크롤한다
    const flash = (el) => { pane.scrollTo({ top: el.offsetTop - wrap.offsetHeight - 8, behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); };
    const sums = {};
    for (const x of segs) sums[x.cat] = (sums[x.cat] ?? 0) + tok(x);
    // 남은 공간을 숨기면 막대가 쓴 만큼만 채운다 (사용자 2026-10-18). % 는 지금 막대의 끝 기준 — 보이면 컨텍스트 창, 숨기면 쓴 합계
    const wrap = h('div', { class: 'cbarwrap' });
    const draw = () => {
      const free = showFree && max > total, base = free ? max : total || 1;
      const pct = (n) => { const p = (n / base) * 100; return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`; };
      wrap.replaceChildren(h('div', { class: 'cbar' },
        ...segs.map((x) => h('span', { class: `seg k-${x.cat}`, style: `flex-grow:${tok(x)}`, title: `${x.label} · 약 ${num(tok(x))} 토큰 (${pct(tok(x))})`, onclick: () => flash(x.el) })),
        free ? h('span', { class: 'seg k-free', style: `flex-grow:${max - total}`, title: `남은 공간 · ${num(max - total)} 토큰 (${pct(max - total)})` }) : null),
      h('div', { class: 'legend' },
        ...Object.entries(sums).map(([cat, n]) => h('span', {}, h('i', { class: `seg k-${cat}` }), `${CATS[cat]} ${num(n)} (${pct(n)})`)),
        free ? h('span', {}, h('i', { class: 'seg k-free' }), `남은 공간 ${num(max - total)} (${pct(max - total)})`) : null,
        h('span', { class: 'dim' }, `합계 ${num(total)} / ${num(max)} 토큰${u?.input_tokens != null ? '' : ' (응답이 없어 길이로 추정)'}`),
        max > total ? h('button', { class: 'ghost freebtn', onclick: () => { showFree = !showFree; localStorage.setItem(FREE_KEY, showFree ? 'show' : 'hide'); draw(); } }, showFree ? '남은 공간 숨기기' : '남은 공간 보기') : null));
    };
    draw();
    const sent = rec.reqFull ? parse(rec.reqBody) : null;
    return [wrap, sent ? dim(`WebSocket 증분 요청입니다. 실제로 보낸 input 은 마지막 ${(sent.input ?? []).length}개이고, 앞부분은 같은 연결의 앞 요청과 응답으로 다시 만든 것입니다.`) : null, cardsEl];
  }

  // ---- response — 응답 블록 카드와 usage
  function response({ res, oa }) {
    if (!res) return [dim('응답 본문을 읽지 못했습니다. raw 탭에서 원문을 보세요.')];
    const out = [];
    if (oa) {
      const u = res.usage;
      if (res.error) out.push(h('div', { class: 'mcard bad' }, h('div', { class: 'mh' }, '오류'), h('pre', {}, res.error.message ?? JSON.stringify(res.error, null, 2))));
      out.push(mcard('assistant', 'output', [res.status, res.incomplete_details?.reason, u && `↑${num(u.input_tokens)} ↓${num(u.output_tokens)}`].filter(Boolean).join(' · '), (res.output ?? []).filter(Boolean).map(blockEl)));
      return out;
    }
    if (res.error) out.push(h('div', { class: 'mcard bad' }, h('div', { class: 'mh' }, '오류'), h('pre', {}, `${res.error.type}: ${res.error.message}`)));
    const u = res.usage;
    if (res.content) out.push(mcard('assistant', 'assistant', [res.stop_reason, u && `↑${num((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))} ↓${num(u.output_tokens)}`].filter(Boolean).join(' · '), res.content.filter(Boolean).map(blockEl)));
    return out;
  }

  // ---- raw — HTTP 요청·응답 전문. 응답 본문은 기록할 때 압축을 푼 것이다. compact 된 호출(보관 기간·용량 상한을 넘은 뒤)은 원본이 없어 다시 조립한 본문을 보인다
  function raw({ rec }) {
    const re = rec.compacted ? ' (재구성)' : '';
    // WebSocket 호출의 헤더는 연결을 연 업그레이드 요청·101 응답의 것이고, 본문은 보낸 메시지·받은 이벤트다
    const ws = rec.method === 'WS';
    return [
      rec.compacted ? dim('raw 삭제됨') : null,
      ws ? dim('WebSocket 메시지입니다. 헤더는 연결을 연 업그레이드 요청과 응답의 것입니다.') : null,
      h('section', {}, h('h4', {}, `요청${re}`), !rec.compacted && rec.reqHeaders?.['content-encoding'] ? dim(`본문은 ${rec.reqHeaders['content-encoding']} 압축을 푼 것입니다.`) : null,
        h('pre', { class: 'raw' }, `${ws ? 'GET' : rec.method} ${rec.path} HTTP/1.1\n${heads(rec.reqHeaders)}${rec.reqBody ? `\n\n${rec.reqBody}` : ''}`)),
      h('section', {}, h('h4', {}, `응답${re}`), !rec.compacted && rec.resHeaders?.['content-encoding'] ? dim(`본문은 ${rec.resHeaders['content-encoding']} 압축을 푼 것입니다.`) : null,
        h('pre', { class: 'raw' }, `HTTP/1.1 ${rec.status ?? '—'}${rec.error ? ` (${rec.error})` : ''}\n${heads(rec.resHeaders)}${rec.resBody ? `\n\n${rec.resBody}` : ''}`)),
    ];
  }

  function mcard(cat, name, note, kids) {
    return h('div', { class: `mcard k-${cat}` }, h('div', { class: 'mh' }, h('b', {}, name), note ? h('span', { class: 'dim' }, note) : null), ...kids);
  }
  // 블록 머리 줄 — type 라벨(끌어 선택해도 본문만 잡히게 선택 불가)과 cache 배지, 오른쪽 끝에 본문 복사 (사용자 2026-10-18)
  function blockEl(b) {
    if (!b || typeof b !== 'object') return h('div', { class: 'blk' }, h('div', { class: 'txt' }, String(b ?? '')));
    const cache = b.cache_control ? h('span', { class: 'badge' }, `cache ${b.cache_control.ttl ?? b.cache_control.type}`) : null;
    const media = (s) => `[${s?.media_type ?? s?.type ?? '?'}${s?.data ? ` · ${kb(Math.round(s.data.length * 0.75))}` : s?.url ? ` · ${s.url}` : ''}]`;
    const blk = (cls, label, copy, ...body) => h('div', { class: `blk${cls}` }, h('div', { class: 'bh' }, ...label, cache, h('span', { class: 'gap' }), copyBtn(copy)), ...body);
    const json = (x) => JSON.stringify(x, null, 2);
    switch (b.type) {
      case 'text': return blk('', ['text'], b.text, h('div', { class: 'txt' }, b.text));
      case 'thinking': return blk('', ['thinking'], b.thinking ?? '', h('div', { class: 'txt dim' }, b.thinking || '(내용 없음)'));
      case 'redacted_thinking': return blk('', ['redacted_thinking'], b.data ?? '', h('div', { class: 'txt dim' }, '(가려진 생각)'));
      case 'tool_use': case 'server_tool_use': return blk('', [`${b.type} · `, h('b', {}, b.name), h('span', { class: 'dim' }, ` ${b.id ?? ''}`)], json(b.input), h('pre', {}, json(b.input)));
      case 'tool_result': {
        const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c?.text ?? json(c)).join('\n\n');
        return blk(b.is_error ? ' bad' : '', [`tool_result${b.is_error ? ' · 오류' : ''}`, h('span', { class: 'dim' }, ` ${b.tool_use_id ?? ''}`)], text,
          ...(typeof b.content === 'string' ? [h('div', { class: 'txt' }, b.content)] : (b.content ?? []).map(blockEl)));
      }
      case 'image': case 'document': return blk('', [b.type], json(b), h('div', { class: 'txt dim' }, media(b.source)));
      // OpenAI Responses (codex) — 메시지 안의 조각과 input·output 항목
      case 'input_text': case 'output_text': return blk('', [b.type], b.text ?? '', h('div', { class: 'txt' }, b.text ?? ''));
      case 'refusal': return blk(' bad', ['refusal'], b.refusal ?? '', h('div', { class: 'txt' }, b.refusal ?? ''));
      case 'input_image': return blk('', ['input_image'], json(b), h('div', { class: 'txt dim' }, `[${String(b.image_url ?? '').startsWith('data:') ? `${String(b.image_url).slice(5).split(';')[0]} · ${kb(Math.round(String(b.image_url).length * 0.75))}` : b.image_url ?? b.file_id ?? '?'}]`));
      case 'message': return blk('', [`message · ${b.role ?? ''}`], json(b), ...(typeof b.content === 'string' ? [h('div', { class: 'txt' }, b.content)] : (b.content ?? []).map(blockEl)));
      case 'reasoning': {
        const text = (b.summary ?? []).map((x) => x?.text ?? '').join('\n\n');
        return blk('', ['reasoning', h('span', { class: 'dim' }, b.encrypted_content ? ` · 암호화된 추론 ${kb(b.encrypted_content.length)}` : '')], text, h('div', { class: 'txt dim' }, text || '(요약 없음)'));
      }
      case 'function_call': {
        const args = parse(b.arguments);
        return blk('', ['function_call · ', h('b', {}, b.name), h('span', { class: 'dim' }, ` ${b.call_id ?? ''}`)], args ? json(args) : String(b.arguments ?? ''), h('pre', {}, args ? json(args) : String(b.arguments ?? '')));
      }
      case 'custom_tool_call': return blk('', ['custom_tool_call · ', h('b', {}, b.name), h('span', { class: 'dim' }, ` ${b.call_id ?? ''}`)], String(b.input ?? ''), h('pre', {}, String(b.input ?? '')));
      case 'additional_tools': {
        const tools = Array.isArray(b.tools) ? b.tools : [];
        const tool = (t) => h('details', { class: 'tool' }, h('summary', {}, h('b', {}, t.name ?? t.type), ' ', h('span', { class: 'dim' }, t.type === 'namespace' ? `도구 ${(t.tools ?? []).length}개` : String(t.description ?? t.type ?? '').split('\n')[0])),
          ...(t.type === 'namespace' ? (t.tools ?? []).map(tool) : [h('pre', {}, json(t))]));
        return blk('', [`additional_tools · ${b.role ?? ''}`], json(tools), ...tools.map(tool));
      }
      case 'function_call_output': case 'custom_tool_call_output': {
        const out = typeof b.output === 'string' ? b.output : Array.isArray(b.output) ? b.output.map((c) => c?.text ?? json(c)).join('\n\n') : json(b.output);
        return blk('', [b.type, h('span', { class: 'dim' }, ` ${b.call_id ?? ''}`)], out, h('div', { class: 'txt' }, out));
      }
      default: return blk('', [b.type ?? '?'], json(b), h('pre', {}, json(b)));
    }
  }

  return { el: dlg, open };
}
