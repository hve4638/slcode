// 세션 구성 (ticket slcode-sidebar-revamp, 사용자 결정 2026-11-26) — 사이드바의 한 줄을 누르면 뜨는 창. 이 세션의 모델이 무엇을 받는지와 각 기능이 어디서 왔는지를 보인다.
// 위의 세 탭: 지시문(system prompt 조각, 보내는 순서대로) | AGENTS.md(첫 메시지에 붙는 CLAUDE.md 같은 지시 파일, 사용자 2026-11-26 — 벤더 중립 이름) | 기능(스킬·도구·서브에이전트·훅·플러그인).
// 왼쪽은 목록, 오른쪽은 고른 줄의 정보. 줄 끝의 출처를 누르면 그 출처의 것만 남는다(플러그인이 무엇을 넣었나도 이것으로).
// system prompt 글은 session.promptPreview (core 가 Claude Code 를 가짜 API 에 한 번 돌려 받는다 — 몇 초, 요금 없음), 출처·지시 파일은 session.sources, 파일 원문은 file.get, 스킬 하위 파일은 file.list.
// Claude Code 내장 스킬·도구·서브에이전트는 원문이 Claude Code 안에 있어 이름만, 한 줄로 접는다. 쓰는 프롬프트 고르기·에이전트 플러그인 다시 싣기·MCP 다시 연결은 그 줄의 정보에 app.js 가 만든 조각(parts)을 넣는다.
import { closeOnBackdrop } from './settings.js';
import { translateButton } from './translate.js';

const TABS = [['prompt', '지시문'], ['memory', 'AGENTS.md'], ['feat', '기능']];
const ORIGIN = { builtin: 'Claude Code', user: '사용자', project: '프로젝트', local: '프로젝트 local', managed: '관리 정책', slcode: 'slcode', claudeai: 'claude.ai 커넥터', other: '출처 모름' };
// 첫 메시지에서 Claude Code 가 쓰는 안내 문단의 이름 — 모르는 문단은 첫 문장이 이름 (Claude Code 2.1.322 기준)
const CTX_NAMES = [[/^Attribution for git commits/, '커밋 표기 안내'], [/^The following deferred tools/, '나중에 불러오는 도구'], [/^The following MCP servers are configured but failed/, '연결 실패한 MCP'],
  [/^Available agent types/, '서브에이전트 목록'], [/^The following skills are available/, '스킬 목록'], [/^While bypass permissions mode/, '권한 우회 모드 안내'], [/^Today's date is/, '오늘 날짜']];
const BUILTIN_STYLES = ['Explanatory', 'Learning']; // Claude Code 에 들어 있는 output style — 플러그인 것은 '<플러그인>:<이름>'
const HOOK_FROM = { user: '사용자', project: '프로젝트', local: '프로젝트 local' };
const tagOf = (source, plugin) => (source === 'plugin' ? `플러그인 ${plugin ?? ''}`.trim() : source === 'agent' ? `에이전트 플러그인 ${plugin ?? ''}`.trim() : ORIGIN[source] ?? source);
const kchars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k자` : `${n}자`);
const fmtSize = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);
const utf8 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
const mcpOf = (t) => /^mcp__(.+?)__/.exec(t)?.[1];

/** h: app.js 의 요소 생성기, rpc: transport.request,
 *  get(): { id, ready, vendor, key, mcp, agentPlugins, translator, parts: { prompt(), plugins(), mcp(name) } } — key 가 바뀌면(세션·모델) 받은 것을 버린다. parts 는 Node 또는 null */
export function previewDialog(h, rpc, get) {
  let tab = 'prompt', filter = null, key = null, prompt = null, src = null; // prompt·src(session.sources): { loading } | { error } | 결과
  const sel = new Map(); // 탭 → 고른 줄의 k
  const files = new Map(); // 파일 경로 → { loading } | { error } | { text } | { binary } (file.get)
  const dirs = new Map(); // 폴더 → { loading } | { error } | { files, truncated } (file.list)
  const pick = new Map(); // 스킬 이름 → 고른 하위 파일(상대 경로)
  const tabs = h('div', { class: 'tabs' }), list = h('div', { class: 'pvl' }), info = h('div', { class: 'pvb' });
  const dialog = h('dialog', { class: 'pvd' },
    h('header', {}, h('h2', {}, '세션 구성'), tabs, h('button', { class: 'ghost x', title: '닫기', 'aria-label': '닫기', onclick: () => dialog.close() }, '✕')),
    h('div', { class: 'pvc' }, list, info));
  closeOnBackdrop(dialog);

  function load(which) {
    const { id } = get();
    if (!id) return;
    const k = key;
    const set = (v) => { if (key !== k) return; if (which === 'prompt') prompt = v; else src = v; paint(); };
    set({ loading: true });
    rpc(which === 'prompt' ? 'session.promptPreview' : 'session.sources', { id }).then(set, (e) => set({ error: e.message }));
  }
  /** 받은 것이 있으면 그것, 없으면 받기 시작하고 { loading } */
  function cached(map, k, method) {
    const v = map.get(k);
    if (v) return v;
    const kk = key;
    map.set(k, { loading: true });
    rpc(method, { path: k }).then((r) => (method === 'file.list' ? r : /^text\/|json|xml|javascript/.test(r.mediaType) ? { text: utf8(r.data) } : { binary: `${r.mediaType} · ${fmtSize(r.size)}` }), (e) => ({ error: e.message }))
      .then((x) => { if (key === kk) { map.set(k, x); paint(); } });
    return { loading: true };
  }

  const empty = (t, err) => h('div', { class: `empty${err ? ' err' : ''}` }, t);
  const kv = (rows) => h('div', { class: 'kv' }, ...rows.filter(([, v]) => v != null).flatMap(([k, v]) => [h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)]));
  // 글 상자 — superlite 카드로 열었으면(translator 가 있으면) 오른쪽 위에 대화와 같은 번역 단추 (사용자 2026-11-26)
  const pre = (t) => {
    const p = h('pre', {}, t);
    const tr = get().translator;
    return tr ? h('div', { class: 'tx' }, p, translateButton({ text: t, body: p, translate: tr.translate })) : p;
  };
  const wait = (v, f, msg = '불러오는 중…') => (!v || v.loading ? [empty(msg)] : v.error ? [empty(`받지 못했습니다: ${v.error}`, true)] : f(v));
  const fileBody = (p) => { const v = cached(files, p, 'file.get'); return v.loading ? empty('불러오는 중…') : v.error ? empty(`받지 못했습니다: ${v.error}`, true) : v.binary ? empty(`글이 아닌 파일 (${v.binary})`) : pre(v.text); };
  const names = (l) => h('div', { class: 'names' }, ...l.map((n) => h('div', {}, n)));
  const home = (p) => p.replace(/^\/(root|home\/[^/]+)(?=\/)/, '~');
  // 목록 한 줄: { k, nm, tag?, side?, bad?, info: () => Node[] }, 묶음 이름은 { sec }, 그 밖의 Node 는 그대로
  const it = (k, nm, tag, infoOf, more = {}) => ({ k, nm, tag, info: infoOf, ...more });

  // 출처 꼬리표 — Claude Code 플러그인 이름이 에이전트 플러그인이면 그쪽으로. 플러그인 MCP 는 이름이 plugin:<플러그인>:<서버>
  const plugTag = (g, name) => tagOf(g.agentPlugins.includes(name) ? 'agent' : 'plugin', name);
  const mcpTag = (g, m) => { const pl = /^plugin:([^:]+):/.exec(m.name)?.[1]; return m.source === 'plugin' && pl ? plugTag(g, pl) : m.source ? tagOf(m.source) : null; };

  /** 첫 메시지(context) 글 하나를 줄로 — Claude Code 가 안내를 빈 줄로 이어 붙이므로 문단에서 자른다: '# 머리글', 첫 줄이 ':' 로 끝나는 안내('The following skills …:'),
   *  MCP 안내 안의 '## 서버', 글 끝의 한 줄 문단('Today's date …'). 머리글 바로 뒤의 안내 문단은 머리글에 붙인다. CLAUDE.md 를 담은 글은 AGENTS.md 탭이 보이므로 뺀다 */
  function ctxSplit(t) {
    const body = t.replace(/^<system-reminder>\n?/, '').replace(/\n?<\/system-reminder>\s*$/, '');
    if (/^Contents of /m.test(body)) return [];
    const paras = body.split(/\n{2,}/), out = [];
    const name = (l) => { const known = CTX_NAMES.find(([re]) => re.test(l))?.[1]; if (known) return known; const s = l.replace(/^#+ /, '').replace(/:$/, ''); const one = s.split(/(?<=\.) /)[0].replace(/\.$/, ''); return one.length > 60 ? `${one.slice(0, 59)}…` : one; };
    let fence = false;
    paras.forEach((para, k) => {
      const first = para.split('\n')[0], cur = out.at(-1);
      const head = !fence && (/^# \S/.test(first) || (cur?.mcp && /^## \S/.test(first))
        || (/:$/.test(first) && !(cur && cur.lines.length === 1 && /^#[^\n]*$/.test(cur.lines[0])))
        || (k === paras.length - 1 && !para.includes('\n') && cur));
      if (head || !cur) out.push({ nm: /^## /.test(first) && cur?.mcp ? `MCP 안내: ${first.slice(3).trim()}` : name(first), lines: [para], mcp: /^# MCP Server Instructions/.test(first) || (cur?.mcp && /^## /.test(first)), server: /^## /.test(first) && cur?.mcp ? first.slice(3).trim() : null });
      else cur.lines.push(para);
      for (const l of para.split('\n')) if (/^```/.test(l)) fence = !fence;
    });
    return out.map((x) => ({ nm: x.nm, text: x.lines.join('\n\n'), server: x.server }));
  }
  // 첫 메시지 줄의 출처 — output style 은 이름 앞의 플러그인, MCP 안내는 그 서버의 출처, 나머지는 Claude Code 가 쓴 글
  function ctxTag(g, x) {
    if (x.server) { const m = g.mcp.find((y) => y.name === x.server); return m ? mcpTag(g, m) : ORIGIN.other; }
    const style = /^Output Style: (.+)$/.exec(x.nm)?.[1];
    if (!style) return ORIGIN.builtin;
    if (style.includes(':')) return plugTag(g, style.split(':')[0]);
    if (BUILTIN_STYLES.includes(style)) return ORIGIN.builtin;
    const f = styleFile(style);
    return f ? tagOf(f.source) : ORIGIN.other;
  }
  // 설정 폴더의 output style 파일 — 같은 이름이면 프로젝트 것이 이긴다
  const styleFile = (name) => (src?.styles ? ['project', 'user'].map((k) => src.styles.find((y) => y.source === k && y.name === name)).find(Boolean) ?? null : null);

  /** 지시문 — system prompt 조각, 그 뒤 첫 메시지에 Claude Code 가 붙인 글 */
  function promptItems(g) {
    const { vendor } = g;
    const label = (b) => ({ vendor: vendor === 'codex' ? 'Codex 기본' : 'Claude Code 기본', prompt: `프로필 프롬프트 ${b.name ?? ''}${b.version ? ` v${b.version}` : ''}`, slcode: 'slcode 지시', team: '팀 지시', plugin: '에이전트 플러그인 지시문' }[b.source] ?? b.source);
    const tag = (b) => ({ vendor: vendor === 'codex' ? 'Codex' : 'Claude Code', prompt: '프로필', slcode: 'slcode', team: 'slcode', plugin: '에이전트 플러그인' }[b.source]);
    // 벤더 글은 잇닿은 것을 한 줄로 — 과금 표지·정체성 한 줄·정적·동적 블록은 누구 세션이든 같다
    const merge = (blocks) => blocks.reduce((a, b) => { const l = a.at(-1); if (l?.source === 'vendor' && b.source === 'vendor' && l.text != null && b.text != null) l.text += `\n\n${b.text}`; else a.push({ ...b }); return a; }, []);
    // 조각 하나를 맨 윗단 머리글(# …, 코드 울타리 안은 빼고)마다 한 줄로 — 첫 머리글 앞의 글은 머리글이 있으면 '첫머리', 없으면 조각 이름
    const split = (b) => {
      if (b.text == null) return [{ nm: label(b), text: null }];
      const parts = [{ nm: null, lines: [] }];
      let fence = false;
      for (const l of b.text.split('\n')) {
        if (/^```/.test(l)) fence = !fence;
        else if (!fence && /^# \S/.test(l)) parts.push({ nm: l.slice(2).trim(), lines: [] });
        parts.at(-1).lines.push(l);
      }
      return parts.map((x) => ({ nm: x.nm ?? (parts.length > 1 ? '첫머리' : label(b)), text: x.lines.join('\n').replace(/^\n+|\n+$/g, '') })).filter((x) => x.text.trim());
    };
    const out = [{ sec: 'system prompt' }, ...wait(prompt, (p) => {
      const bs = merge(p.blocks);
      const ctx = p.context.flatMap((t, i) => ctxSplit(t).map((x, j) => {
        const f = styleFile(/^Output Style: (.+)$/.exec(x.nm)?.[1]);
        return it(`c${i}.${j}`, x.nm, ctxTag(g, x), () => [f ? kv([['위치', h('code', {}, f.path)]]) : null, pre(x.text)], { side: kchars(x.text.length) });
      }));
      // 프로필 프롬프트를 쓰는 세션이면 그 첫 줄의 정보에 새 판 적용·바꾸기(app.js 의 조각) — 무엇을 쓰는지는 꼬리표가 보인다, 벤더 기본이면 두지 않는다 (사용자 2026-11-26)
      return [...bs.flatMap((b, i) => split(b).map((x, j) => it(b.source === 'prompt' && j === 0 ? 'sp' : `b${i}.${j}`, x.nm, tag(b), () => [
        b.source === 'prompt' && j === 0 ? g.parts.prompt() : null,
        x.text == null ? empty('Codex 가 넣는 기본 지시문은 볼 수 없습니다') : pre(x.text)], { side: x.text == null ? null : kchars(x.text.length) }))),
        ...(ctx.length ? [{ sec: '첫 메시지' }, ...ctx] : [])];
    }, vendor === 'codex' ? '불러오는 중…' : '불러오는 중… Claude Code 를 한 번 돌려 받습니다 (요금 없음)')];
    return out;
  }

  /** AGENTS.md — Claude Code 가 첫 메시지에 원문 그대로 붙이는 지시 파일(CLAUDE.md, @ 로 부른 파일), 붙는 순서대로 */
  function memoryItems(g) {
    if (g.vendor === 'codex') return [empty('Codex 세션은 지시 파일 목록을 보이지 않습니다')];
    return wait(src, (s) => (!s.memory.length ? [empty(g.ready ? '없음' : '첫 턴 뒤')]
      : s.memory.map((m) => it(`m${m.path}`, m.path.split('/').pop(), tagOf(m.source), () => [kv([['위치', h('code', {}, m.path)], ['출처', tagOf(m.source)]]), fileBody(m.path)],
        { side: home(dirOf(m.path)) }))));
  }

  /** 기능 — 스킬·도구·서브에이전트·훅·플러그인. 이름은 session.ready, 출처는 session.sources */
  function featItems(g) {
    const { ready } = g;
    if (!ready) return [empty('첫 턴 뒤')];
    if (!src || src.loading || src.error) return wait(src, () => []);
    const s = src, sup = s.supported;
    const fold = (k, what, l, note) => it(k, `Claude Code 내장 ${what}`, 'Claude Code', () => [empty(note), names(l)], { side: String(l.length) });
    const out = [{ sec: `스킬 ${ready.skills.length}` }];
    if (!sup) out.push(...ready.skills.map((n) => it(`s${n}`, n, null, () => [empty('Codex 세션은 스킬의 출처를 보이지 않습니다')])));
    else {
      out.push(...s.skills.filter((k) => k.source !== 'builtin').map((k) => it(`s${k.name}`, k.name, tagOf(k.source, k.plugin), () => {
        if (!k.path) return [kv([['출처', tagOf(k.source, k.plugin)]]), empty('SKILL.md 를 찾지 못했습니다')];
        const dir = dirOf(k.path), d = cached(dirs, dir, 'file.list'), cur = pick.get(k.name) ?? 'SKILL.md';
        return [kv([['출처', tagOf(k.source, k.plugin)], ['위치', h('code', {}, dir)]]),
          d.loading ? empty('불러오는 중…') : d.error ? empty(`받지 못했습니다: ${d.error}`, true)
            : h('div', { class: 'files' }, ...d.files.map((f) => h('button', { class: 'it', 'aria-current': String(f.path === cur), onclick: () => { pick.set(k.name, f.path); paint(); } }, h('span', { class: 'nm' }, f.path), h('span', { class: 'sz' }, fmtSize(f.size)))),
              d.truncated ? empty('파일이 많아 앞의 것만 보입니다') : null),
          fileBody(`${dir}/${cur}`)];
      })));
      const bi = s.skills.filter((k) => k.source === 'builtin').map((k) => k.name);
      if (bi.length) out.push(fold('sb', '스킬', bi, '원문은 Claude Code 안에 있어 볼 수 없습니다.'));
    }
    // 도구 — MCP 서버마다 한 줄(그 서버의 도구는 정보에), 나머지는 내장 한 줄
    out.push({ sec: `도구 ${ready.tools.length}` });
    for (const m of g.mcp) {
      const own = ready.tools.filter((t) => mcpOf(t) === m.name);
      out.push(it(`t${m.name}`, `MCP ${m.name}`, mcpTag(g, m), () => [g.parts.mcp(m.name), own.length ? kv([['도구', own.map((t) => t.replace(/^mcp__.+?__/, '')).join('\n')]]) : null],
        { side: own.length ? String(own.length) : null, bad: m.status === 'failed' ? 'failed' : null }));
    }
    const bt = ready.tools.filter((t) => !mcpOf(t));
    if (bt.length) out.push(fold('tb', '도구', bt, 'Claude Code 안에 들어 있는 도구입니다.'));
    // 서브에이전트 — Task 도구가 부르는 것
    if (ready.agents.length) {
      out.push({ sec: `서브에이전트 ${ready.agents.length}` });
      if (!sup) out.push(...ready.agents.map((n) => it(`a${n}`, n, null, () => [])));
      else {
        out.push(...s.agents.filter((a) => a.source !== 'builtin').map((a) => it(`a${a.name}`, a.name, tagOf(a.source, a.plugin),
          () => [kv([['출처', tagOf(a.source, a.plugin)], ['위치', a.path ? h('code', {}, a.path) : null]]), a.path ? fileBody(a.path) : null])));
        const ba = s.agents.filter((a) => a.source === 'builtin').map((a) => a.name);
        if (ba.length) out.push(fold('ab', '서브에이전트', ba, 'Claude Code 안에 들어 있는 서브에이전트입니다.'));
      }
    }
    // 훅
    if (!sup) out.push({ sec: '훅' }, empty('Codex 세션은 훅 목록을 보이지 않습니다'));
    else if (s.hooks.length) out.push({ sec: `훅 ${s.hooks.length}` }, ...s.hooks.map((x, i) => {
      const from = HOOK_FROM[x.source] ?? tagOf(x.source, x.name);
      return it(`h${i}`, x.matcher ? `${x.event} · ${x.matcher}` : x.event, from, () => [kv([['이벤트', x.event], ['matcher', x.matcher], ['출처', from]]), pre(x.what)]);
    }));
    // 플러그인 — 출처 자체. 그 플러그인이 넣은 것만 보기로 이어진다
    const plug = ready.plugins.map((p) => ({ ...p, name: p.name.replace(/@inline$/, '') }));
    if (plug.length) out.push({ sec: `플러그인 ${plug.length}` }, ...plug.map((p) => {
      const agent = g.agentPlugins.includes(p.name), inside = p.path === 'builtin', by = tagOf(agent ? 'agent' : 'plugin', p.name);
      return it(`g${p.name}`, p.name, inside ? 'Claude Code' : null, () => [
        kv([['종류', inside ? 'Claude Code 내장 플러그인' : agent ? 'slcode 에이전트 플러그인' : 'Claude Code 플러그인'], ['위치', inside ? null : h('code', {}, p.path ?? p.source)]]),
        agent ? g.parts.plugins() : null,
        inside ? null : h('button', { class: 'by', onclick: () => { filter = by; paint(); } }, '이 플러그인이 넣은 것만 보기')]);
    }));
    return out;
  }

  function paint() {
    const g = get();
    if (g.key !== key) { key = g.key; prompt = null; src = null; filter = null; sel.clear(); files.clear(); dirs.clear(); pick.clear(); }
    if (!dialog.open) return;
    if (tab === 'prompt' && !prompt) load('prompt');
    if (!src) load('src');
    tabs.replaceChildren(...TABS.map(([k, t]) => h('button', { 'aria-current': String(tab === k), onclick: () => { tab = k; paint(); } }, t)));
    // 거르면 출처가 다른 줄과, 줄이 없어진 묶음 이름을 뺀다
    const all = (tab === 'prompt' ? promptItems(g) : tab === 'memory' ? memoryItems(g) : featItems(g)).filter((x) => x && (x.k == null || !filter || x.tag === filter));
    const shown = filter ? all.filter((x, i) => !x.sec || (all[i + 1] && !all[i + 1].sec)) : all;
    const rows = shown.filter((x) => x.k != null);
    const cur = rows.find((x) => x.k === sel.get(tab)) ?? rows[0]; // 고른 것이 없으면 첫 줄
    list.replaceChildren(...[
      filter ? h('div', { class: 'filter' }, h('span', {}, `출처: ${filter}`), h('button', { class: 'ghost', title: '거르기 풀기', 'aria-label': '거르기 풀기', onclick: () => { filter = null; paint(); } }, '✕')) : null,
      ...shown.map((x) => (x.sec ? h('div', { class: 'gl' }, x.sec) : x.k == null ? x
        : h('button', { class: 'it', 'aria-current': String(x === cur), onclick: () => { sel.set(tab, x.k); paint(); } },
          h('span', { class: 'nm' }, x.nm), x.side ? h('span', { class: 'sz' }, x.side) : null, x.bad ? h('span', { class: 'bad' }, x.bad) : null,
          x.tag ? h('span', { class: 'tag', title: '이 출처만 보기', onclick: (e) => { e.stopPropagation(); filter = x.tag; paint(); } }, x.tag) : null))),
      filter && !rows.length ? empty('이 탭에는 이 출처의 것이 없습니다') : null].filter(Boolean));
    info.replaceChildren(...(cur ? [h('h3', {}, cur.nm), ...cur.info()] : []).filter(Boolean));
  }

  /** which 를 주면 그 탭으로, k 를 주면 목록에서 그 줄을 고른다 */
  const open = (which, k) => { if (which) tab = which; if (k) sel.set(tab, k); filter = null; if (!dialog.open) dialog.showModal(); paint(); };
  /** 새 벤더 프로세스·다시 싣기 — 받은 것을 버리고 보이면 다시 받는다 */
  const reset = () => { prompt = null; src = null; files.clear(); dirs.clear(); paint(); };
  return { dialog, open, paint, reset };
}
