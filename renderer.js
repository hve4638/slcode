// slcode 플러그인 renderer (새 방식 apiVersion 2, ticket slcode-plugin-v2) — 창마다 보이지 않는 sandbox iframe 하나에서 돈다.
// 팔레트 명령, 액티비티바 "slcode" 사이드바와 살아 있는 세션 수 배지, 카드 열기·닫기 요청(main 의 셸 동사·다른 플러그인의 close 가 cards 인터페이스로 부른다).
// 카드 화면·사이드바와는 메모리를 함께 쓰지 않는다 — 화면이 post 로 보낸 {type} 을 받고 views.post 로 돌려준다:
//   카드 → tab(이 창의 탭 id 를 알림)·count(목록 다시 세기)·moveOut(핸드오프 — 옛 카드를 옮겨진 카드로)
//   사이드바 → refresh·open(id 또는 spawn {cwd}, 둘 다 없으면 시작 화면)·forceClose·goTo(다른 superlite 세션 탭의 카드로 {id, root})
//   카드 → goto(같은 가족의 세션 카드로 {id})
//   카드로 → revive(닫힌 세션의 카드를 다시 띄움)·close(세션 종료)·closing·closed·moveOut·seen(사이드바가 눌러 앞에 보였다), 사이드바로 → rows

const VIEW = 'session';
const SIDEBAR = 'sessions';
const DEFAULT_NAME = 'SLCode'; // 이름 없는 세션의 카드 제목 (slcode 웹의 기본 이름과 같다)
const PICK_NAME = 'Resume'; // 고르기 전 resume 카드의 제목 — deck 에서 이름 없는 세션 카드와 갈리게
const START_NAME = 'Start'; // 시작 화면 카드의 제목 (views/session.js 와 같다)

/** @param {import('@superlite/plugin').RendererApi} api */
export function activate(api) {
  const newKey = () => 's' + Math.random().toString(36).slice(2, 8);
  const host = (method, ...args) => api.main.call('host', method, ...args);
  const fail = (e) => void api.notify('error', `slcode: ${e?.message ?? e}`);
  /** 카드 key → 이 창의 탭 id — 카드 화면이 mount 때 알린다. 다른 플러그인의 close 가 그 카드에 닫기 요청을 거는 데 쓴다 */
  const tabs = new Map();
  /** 세션 id → 그 세션을 띄운 카드의 key (카드 화면이 storage 'owners' 에 남긴다) — 같은 세션을 다시 열면 그 카드를 활성화 */
  const keyOf = async (id) => { const o = ((await api.storage.get('owners')) ?? {})[id]; return typeof o === 'string' ? o : o?.key ?? null; }; // 객체 꼴은 잠시 쓰던 형식

  /** 카드 열기 — 있는 세션이면 그 카드를 활성화, 없으면 새 카드(spawn 이면 새 세션, id 면 resume, pick 이면 꺼진 세션 고르기, start 면 그 폴더의 시작 화면).
   *  tmux(요청자 터미널)가 있으면 새 카드는 그 deck 끝에 조용히 붙이고 포커스는 옮기지 않는다 (ticket slcode-new-card-no-focus, 사용자 2026-10-25 —
   *  orchestrate 가 워커 카드를 열 때마다 보던 카드에서 포커스가 빠져서. 2026-10-07 의 "그 카드로 포커스" 를 뒤집음). focus(사람이 친 slcode new)면
   *  superlite focus — 사용자가 그 순간 요청자 터미널을 보고 있을 때만 새 카드를 보인다 */
  async function open({ key, id = null, spawn, pick, start, title, tmux, focus, seen, opener, reveal } = {}) {
    if (!key && id) key = await keyOf(id);
    key ??= newKey();
    const state = pick ? { key, id: null, pick } : start ? { key, id: null, start } : spawn ? { key, id: null, spawn } : { key, id, ...(seen ? { seen: true } : {}) };
    const at = { as: 'card', key, title: title ?? (pick ? PICK_NAME : start ? START_NAME : DEFAULT_NAME), preserve: true };
    await api.views.open(VIEW, state, { ...(tmux ? { ...at, opener: tmux, end: true, ...(focus ? { focus: true } : {}) } : at), ...(opener ? { opener, focus: true } : {}), ...(reveal ? { reveal: true } : {}) });
    if (id) void api.views.post({ type: 'revive', key }); // 닫힌 세션의 카드가 남아 있다 — 활성화만 하면 "세션이 닫혔습니다" 그대로라 다시 띄운다
  }

  /** 폴더를 고르지 않은 새 세션(사이드바 머리 +, 팔레트) — slcode new 는 폴더를 꼭 받으므로 지금 superlite 세션의 워크스페이스 폴더로 시작 화면 카드를 연다.
   *  slcode.start 동사와 같은 카드지만 main 동사는 창의 verbs.run 으로 닿지 않고, renderer API 에 root 가 없어 그 세션의 셸에 묻는다(proc 의 기본 cwd 가 root).
   *  마지막 줄만 — 로그인 셸의 프로필이 stdout 에 무언가 찍을 수 있다 */
  async function openStart() {
    const r = await api.proc.run((await api.platform()).os === 'windows' ? 'cd' : 'pwd');
    const root = r.stdout.trim().split(/\r?\n/).pop();
    if (r.code !== 0 || !root) throw new Error(r.stderr.trim() || `exit ${r.code}`);
    await open({ start: root });
  }

  // main 이 부른다 — scope own 이라 이 플러그인의 main 만
  api.expose('cards', {
    open,
    /** 다른 플러그인의 close (main.js close) — 이 창에 그 세션의 카드가 있으면 card.close 닫기 요청([D]·삭제/거부 알림)을 걸고 true.
     *  없거나 이미 닫힌 탭(tabs 는 지우지 않는다)이면 false — main 이 다음 창에 묻는다 */
    async closeCard({ id }) {
      const tab = tabs.get(await keyOf(id));
      if (!tab) return false;
      try { await api.verbs.run('card.close', [tab]); return true; } catch { return false; }
    },
  }, { scope: 'own' });

  // ---- 사이드바: 세션 목록 (slcode list — 살아 있는 세션만, 사용자 2026-10-04). 목록은 여기서 세어 배지와 사이드바 화면에 같이 준다
  // 활성화·카드 기동/종료·카드 제거 때, 그리고 사이드바가 보이는 동안 몇 초마다(화면의 refresh) 다시 센다 (ticket slcode-sidebar-orca)
  api.sidebar.register(SIDEBAR, { icon: 'hubot', title: 'slcode', view: SIDEBAR });
  async function count() {
    try {
      const [{ rows: all, now }, at] = await Promise.all([host('sidebar'), placement()]);
      const rows = at ? all.filter((r) => at.has(r.id)).map((r) => ({ ...r, at: at.get(r.id) })) : all;
      void api.sidebar.setBadge(SIDEBAR, rows.length || null);
      void api.views.post({ type: 'rows', rows, now });
    } catch (e) { void api.views.post({ type: 'rows', error: String(e?.message ?? e) }); }
  }
  /** 세션 id → 카드가 있는 곳: 'here'(지금 보는 superlite 세션 탭) 또는 그 카드를 띄운 superlite 세션의 워크스페이스 폴더. 카드가 없는 세션
   *  (superlite 밖에서 띄운 것)은 빠진다 — superlite 가 관리하는 세션이 아니다 (ticket slcode-sidebar-orca, 사용자 2026-10-28).
   *  창 쪽 services.list 는 활성 세션의 서비스만, main 의 cards 는 이 머신 전부를 준다. owner(카드 id) → 세션 id 는 카드 화면이 storage 'cards' 에 남긴다 */
  async function placement() {
    try {
      const [mine, every, cards] = await Promise.all([api.services.list(), host('cards'), api.storage.get('cards')]);
      const here = new Set(mine.filter((x) => x.plugin === 'slcode' && x.service === VIEW && x.owner).map((x) => x.owner));
      const root = new Map(every.map((x) => [x.owner, x.root]));
      const at = new Map();
      for (const [id, o] of Object.entries(cards ?? {})) if (here.has(o)) at.set(id, 'here'); else if (root.has(o) && !at.has(id)) at.set(id, root.get(o));
      return at;
    } catch { return null; } // 모르면 전부 지금 탭의 것처럼 보인다
  }
  /** 다른 superlite 세션 탭의 카드로 — 그 워크스페이스 폴더를 연다(열린 탭이 있으면 그 탭으로 옮기고, 없으면 새 탭). 옮긴 뒤 그 카드를 앞으로.
   *  새 탭이면 그 세션에 붙을 때까지(활성 세션의 services.list 에 그 카드가 보일 때까지) 기다린다 (사용자 2026-10-28) */
  async function goTo(id, root) {
    await api.verbs.run('open', [root]);
    const owner = ((await api.storage.get('cards')) ?? {})[id];
    for (let i = 0; i < 40; i++) {
      if ((await api.services.list().catch(() => [])).some((x) => x.owner === owner)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await openFromSidebar(id, 12);
    void count();
  }
  /** 사이드바에서 누름 — 그 카드로 간다. 카드가 실제로 앞에 보였으면(지금 보는 카드가 그것) "봤다" 를 카드에 알린다. 다른 superlite 세션 탭에
   *  있는 카드는 그 탭 안에서만 앞에 놓여 화면이 옮겨 가지 않으므로 초록으로 남는다. 카드가 없던 세션은 새 카드가 붙은 뒤 스스로 알린다 */
  async function openFromSidebar(id, tries = 1, at = {}) {
    const key = await keyOf(id);
    await open({ id, ...at, ...(key ? {} : { seen: true }) });
    if (!key) return;
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise((r) => setTimeout(r, 250));
      const a = await api.views.active().catch(() => null);
      if (a?.viewId === VIEW && a.state?.key === key) { seenOnMount.set(key, Date.now() + 5e3); void api.views.post({ type: 'seen', key }); return; }
    }
  }
  /** 카드 key → 만료 시각 — 앞에 보인 카드가 이제 막 mount 되는 중이면(숨긴 deck 을 다시 연 경우) 위의 seen 을 못 듣는다. 곧 오는 tab 인사에 다시 보낸다 */
  const seenOnMount = new Map();
  void count();
  /** 사이드바 강제 종료 (사용자 2026-10-11) — kill 로 끊긴 카드는 session.closed 를 못 받아 다시 붙으면 세션이 되살아난다. 그동안
   *  이 창의 그 세션 카드에 closing 을 알려 막고, 끝나면 닫힌 카드로 둔다 */
  async function forceClose(id) {
    void api.views.post({ type: 'closing', id, on: true });
    try { await host('forceClose', id); void api.views.post({ type: 'closed', id }); } catch (e) { fail(e); }
    finally { void api.views.post({ type: 'closing', id, on: false }); void count(); }
  }

  api.views.onMessage((m, from) => {
    switch (m?.type) {
      case 'tab':
        if (from.tabId) tabs.set(m.key, from.tabId);
        if (seenOnMount.get(m.key) > Date.now()) void api.views.post({ type: 'seen', key: m.key });
        seenOnMount.delete(m.key);
        return;
      case 'count': case 'refresh': void count(); return;
      case 'open': void (m.id ? openFromSidebar(m.id) : m.spawn?.cwd ? open({ spawn: { cwd: m.spawn.cwd } }) : openStart()).catch(fail); return;
      case 'forceClose': void forceClose(m.id); return;
      case 'goTo': void goTo(m.id, m.root).catch(fail); return;
      // 카드 화면의 관련 세션 링크 (ticket slcode-web-session-url) — 사용자가 누른 동작이라 다른 superlite 세션 탭의 카드면 그 탭으로 옮긴다(reveal). 카드가 없으면 누른 카드 옆에
      case 'goto': void openFromSidebar(m.id, 4, { opener: from.tabId, reveal: true }).catch(fail); return;
      case 'moveOut': void api.views.post({ type: 'moveOut', key: m.from }); return;
    }
  });
  // 카드 제거 — 코어가 owned 서비스를 끝낸다. 끝나는 세션은 프로세스가 내려가야(SIGTERM 3초 뒤 SIGKILL) 목록에서 빠진다 — 그 뒤에 다시 센다
  api.events.on({ kind: 'card.removed', pred: (ev) => ev.pluginId === 'slcode' }, () => { for (const ms of [1000, 4000]) setTimeout(count, ms); });

  // ---- 팔레트
  api.commands.register({ id: 'new', title: 'slcode: New session (card)', run: () => void openStart().catch(fail) });
  api.commands.register({
    id: 'close', title: 'slcode: Close session (active card)', run: async () => {
      const a = await api.views.active();
      if (!a || a.viewId !== VIEW) { void api.notify('info', 'slcode: 열린 세션 카드가 없습니다'); return; }
      void api.views.post({ type: 'close' }, a.tabId);
    },
  });
}
