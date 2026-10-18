// 화면 설정 — 테마·context 경고 (ticket slcode-web-settings, 사용자 확정 2026-10-16)·새 세션 inspect (ticket slcode-inspect-default-on, 2026-10-19). 상태 폴더에 입구(SettingsKind)마다 파일 하나:
// 브라우저로 연 slcode(web)와 superlite 안의 slcode 탭(superlite)은 완전히 따로 쓰고, 같은 입구끼리는 같은 $SLCODE_DIR 의 모든 serve
// (떠 있는 세션·새 세션)가 같이 읽고 쓴다. 브라우저 localStorage 엔 두지 않는다 (sandbox 카드에서 SecurityError, 브라우저·카드마다 갈라진다).
// 테마 id 의 목록은 웹(web/settings.js)이 정한다 — 여기서는 꼴만 맞추고, 모르는 id 는 웹이 기본값으로 읽는다.
import fs from 'node:fs';
import path from 'node:path';
import { FILES, type Settings, type SettingsKind, type SettingsPatch } from './protocol.js';

/** 기본값 — 두 입구 같다. context 경계 30·50 은 사용자 결정 (2026-10-16), inspect 기본 끔은 2026-10-19 */
export const DEFAULT_SETTINGS: Settings = { theme: 'system', context: { warn: true, yellow: 30, red: 50 }, inspect: false };

/** 꼴이 맞는 값만 남기고 나머지는 base 의 값 — 손으로 고친 파일·옛 버전 파일. 두 경계는 0~100 정수이고 yellow ≤ red */
export function normalizeSettings(v: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const c = (o.context && typeof o.context === 'object' ? o.context : {}) as Record<string, unknown>;
  const id = (x: unknown, d: string) => (typeof x === 'string' && x.length > 0 && x.length <= 64 ? x : d);
  const pct = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(100, Math.max(0, Math.round(x))) : d);
  const yellow = pct(c.yellow, base.context.yellow), red = pct(c.red, base.context.red);
  return {
    theme: id(o.theme, base.theme),
    context: { warn: typeof c.warn === 'boolean' ? c.warn : base.context.warn, yellow: Math.min(yellow, red), red: Math.max(yellow, red) },
    inspect: typeof o.inspect === 'boolean' ? o.inspect : base.inspect,
  };
}

const fileOf = (dir: string, kind: SettingsKind) => path.join(dir, kind === 'web' ? FILES.settingsWeb : FILES.settingsSuperlite);

/** 없거나 읽을 수 없으면 기본값 */
export function readSettings(dir: string, kind: SettingsKind): Settings {
  try { return normalizeSettings(JSON.parse(fs.readFileSync(fileOf(dir, kind), 'utf8'))); } catch { return { ...DEFAULT_SETTINGS, context: { ...DEFAULT_SETTINGS.context } }; }
}

/** 지금 파일에 patch 를 겹쳐 쓴다 (context 는 항목별로). 임시 파일 + rename — 감시하는 다른 serve 가 반쯤 쓴 파일을 읽지 않게 */
export function writeSettings(dir: string, kind: SettingsKind, patch: SettingsPatch | undefined): Settings {
  const cur = readSettings(dir, kind);
  const next = normalizeSettings({ ...cur, ...patch, context: { ...cur.context, ...patch?.context } }, cur);
  const tmp = `${fileOf(dir, kind)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, fileOf(dir, kind));
  return next;
}

/** 파일이 바뀌면(어느 프로세스가 썼든, 손으로 고쳤든) 새 값으로 onChange. 내용이 같으면 부르지 않는다.
 *  파일이 아니라 폴더를 본다 — rename 으로 바뀐 파일은 파일 감시가 놓친다.
 *  감시를 못 걸면 pollMs 마다 파일 상태를 본다 — inotify 감시 한도는 머신의 다른 프로그램과 나눠 쓰고, 바닥나면 ENOSPC (2026-10-16 실측) */
export function watchSettings(dir: string, kind: SettingsKind, onChange: (s: Settings) => void, pollMs = 1000): () => void {
  const file = fileOf(dir, kind);
  let last = JSON.stringify(readSettings(dir, kind)), t: NodeJS.Timeout | undefined;
  const check = () => { const s = readSettings(dir, kind), j = JSON.stringify(s); if (j !== last) { last = j; onChange(s); } };
  const poll = () => { fs.watchFile(file, { interval: pollMs }, check); return () => fs.unwatchFile(file, check); };
  let stop: () => void;
  try {
    const w = fs.watch(dir, (_e, name) => { if (name && name !== path.basename(file)) return; clearTimeout(t); t = setTimeout(check, 30); });
    stop = () => w.close();
    w.on('error', () => { w.close(); stop = poll(); });
  } catch { stop = poll(); }
  return () => { clearTimeout(t); stop(); };
}
