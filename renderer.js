// slcode 플러그인 renderer (새 방식 apiVersion 2, ticket slcode-plugin-v2) — 창마다 보이지 않는 sandbox iframe 하나에서 돈다.
// 팔레트 명령, 액티비티바 "slcode" 사이드바와 살아 있는 세션 수 배지, 카드 열기·닫기 요청(main 의 셸 동사·승인 알림·다른 플러그인의 close 가 cards 인터페이스로 부른다).
// 카드 화면·사이드바와는 메모리를 함께 쓰지 않는다 — 화면이 post 로 보낸 {type} 을 받고 views.post 로 돌려준다:
//   카드 → tab(이 창의 탭 id 를 알림)·count(목록 다시 세기)·moveOut(핸드오프 — 옛 카드를 옮겨진 카드로)
//   사이드바 → refresh·open·forceClose
//   카드로 → revive(닫힌 세션의 카드를 다시 띄움)·close(세션 종료)·closing·closed·moveOut, 사이드바로 → rows

const VIEW = 'session';
const SIDEBAR = 'sessions';
const DEFAULT_NAME = 'SLCode'; // 이름 없는 세션의 카드 제목 (slcode 웹의 기본 이름과 같다)
const PICK_NAME = 'Resume'; // 고르기 전 resume 카드의 제목 — deck 에서 이름 없는 세션 카드와 갈리게

/** @param {import('@superlite/plugin').RendererApi} api */
export function activate(api) {
  const newKey = () => 's' + Math.random().toString(36).slice(2, 8);
  const host = (method, ...args) => api.main.call('host', method, ...args);
  const fail = (e) => void api.notify('error', `slcode: ${e?.message ?? e}`);
  /** 카드 key → 이 창의 탭 id — 카드 화면이 mount 때 알린다. 승인 알림을 그 카드의 알림 센터에 넣는 데 쓴다 */
  const tabs = new Map();
  /** 세션 id → 그 세션을 띄운 카드의 key (카드 화면이 storage 'owners' 에 남긴다) — 같은 세션을 다시 열면 그 카드를 활성화 */
  const keyOf = async (id) => { const o = ((await api.storage.get('owners')) ?? {})[id]; return typeof o === 'string' ? o : o?.key ?? null; }; // 객체 꼴은 잠시 쓰던 형식

  /** 카드 열기 — 있는 세션이면 그 카드를 활성화, 없으면 새 카드(spawn 이면 새 세션, id 면 resume, pick 이면 꺼진 세션 고르기).
   *  tmux(요청자 터미널)가 있으면 그 deck 끝에 붙이고 같은 key 로 한 번 더 열어 그 카드로 포커스를 옮긴다 (사용자 2026-10-07) */
  async function open({ key, id = null, spawn, pick, title, tmux } = {}) {
    if (!key && id) key = await keyOf(id);
    key ??= newKey();
    const state = pick ? { key, id: null, pick } : spawn ? { key, id: null, spawn } : { key, id };
    const at = { as: 'card', key, title: title ?? (pick ? PICK_NAME : DEFAULT_NAME), preserve: true };
    await api.views.open(VIEW, state, tmux ? { ...at, opener: tmux, end: true } : at);
    if (tmux) await api.views.open(VIEW, undefined, at);
    if (id) void api.views.post({ type: 'revive', key }); // 닫힌 세션의 카드가 남아 있다 — 활성화만 하면 "세션이 닫혔습니다" 그대로라 다시 띄운다
  }

  // main 이 부른다 — scope own 이라 이 플러그인의 main 만
  api.expose('cards', {
    open,
    /** 승인 알림 — main 이 그 카드의 메인 창 하나를 골라 부른다. 이 창에 그 카드가 있으면 카드 알림 센터에 */
    notify({ key, id, message }) {
      const tab = tabs.get(key);
      api.notify('warning', message, { label: '열기', run: () => void open({ key, id }).catch(fail) }, tab ? { card: tab } : undefined);
    },
    /** 다른 플러그인의 close (main.js close) — 이 창에 그 세션의 카드가 있으면 card.close 닫기 요청([D]·삭제/거부 알림)을 걸고 true.
     *  없거나 이미 닫힌 탭(tabs 는 지우지 않는다)이면 false — main 이 다음 창에 묻는다 */
    async closeCard({ id }) {
      const tab = tabs.get(await keyOf(id));
      if (!tab) return false;
      try { await api.verbs.run('card.close', [tab]); return true; } catch { return false; }
    },
  }, { scope: 'own' });

  // ---- 사이드바: 세션 목록 (slcode list — 살아 있는 세션만, 사용자 2026-10-04). 목록은 여기서 세어 배지와 사이드바 화면에 같이 준다
  // ponytail: 활성화·카드 기동/종료·카드 제거·사이드바 새로고침 때만 다시 센다. 터미널에서 띄우거나 끈 세션은 그 다음 계기까지 늦다
  api.sidebar.register(SIDEBAR, { icon: 'hubot', title: 'slcode', view: SIDEBAR });
  async function count() {
    try {
      const rows = await host('list', false);
      void api.sidebar.setBadge(SIDEBAR, rows.length || null);
      void api.views.post({ type: 'rows', rows });
    } catch (e) { void api.views.post({ type: 'rows', error: String(e?.message ?? e) }); }
  }
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
      case 'tab': if (from.tabId) tabs.set(m.key, from.tabId); return;
      case 'count': case 'refresh': void count(); return;
      case 'open': void open({ id: m.id ?? null }).catch(fail); return;
      case 'forceClose': void forceClose(m.id); return;
      case 'moveOut': void api.views.post({ type: 'moveOut', key: m.from }); return;
    }
  });
  // 카드 제거 — 코어가 owned 서비스를 끝낸다. 끝나는 세션은 프로세스가 내려가야(SIGTERM 3초 뒤 SIGKILL) 목록에서 빠진다 — 그 뒤에 다시 센다
  api.events.on({ kind: 'card.removed', pred: (ev) => ev.pluginId === 'slcode' }, () => { for (const ms of [1000, 4000]) setTimeout(count, ms); });

  // ---- 팔레트
  api.commands.register({ id: 'new', title: 'slcode: New session (card)', run: () => void open().catch(fail) });
  api.commands.register({
    id: 'close', title: 'slcode: Close session (active card)', run: async () => {
      const a = await api.views.active();
      if (!a || a.viewId !== VIEW) { void api.notify('info', 'slcode: 열린 세션 카드가 없습니다'); return; }
      void api.views.post({ type: 'close' }, a.tabId);
    },
  });
}
