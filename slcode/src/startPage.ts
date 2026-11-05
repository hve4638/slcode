// 시작 화면 (web/start.html·start.js, ticket slcode-session-profile, 사용자 2026-10-30) — 동사 없는 `slcode`. 프로그램의 첫 화면 자리다: 가운데 new session,
// 아래 왼쪽은 지금 폴더의 세션, 오른쪽은 모든 폴더의 세션(마지막 활동 순, 꺼진 세션 위주 — 떠 있는 세션은 열려 있다고만). 프로필은 세션에 들어가 대화 화면
// 가운데에서 고르고, 프로필 설정은 나중에 이 화면의 설정에 둔다(사용자). 대시보드도 나중에 여기서 들어간다.
// 웹은 진입 프로세스(entry.ts)가 세션을 띄우기 전에 이 핸들러로 그 포트에서 서빙하고, 고르면 새 세션을 또는 그 세션을 이어서 띄운다.
// 카드는 superlite 플러그인이 `slcode start-page` 의 html(css·모듈을 넣은 것)을 카드 문서에 그리고, 목록은 플러그인이 `start-page --json` 으로 받는다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { summarize } from './activity.js';
import { EventLog } from './eventLog.js';
import { closedTime, sockAlive } from './live.js';
import { corePaths } from './paths.js';
import { loopbackAllowed, pluginMethod, PLUGIN_METHODS, WEB_DIR, withPageAttrs } from './serve.js';
import type { SettingsKind } from './protocol.js';

/** at 은 마지막 활동 — 꺼진 세션은 꺼진 시각, 떠 있는 세션은 활동 기록의 마지막 상태 변화(없으면 마지막 턴) */
export type StartSession = { id: string; title: string | null; vendor: string; cwd: string; live: boolean; at: number };
export type StartList = { cwd: string; here: StartSession[]; all: StartSession[] };

/** 화면이 그리는 것 — 그 폴더의 세션(here)과 모든 세션(all), 마지막 활동 순(최근 먼저) */
export async function startList(dir: string, cwd: string): Promise<StartList> {
  const sessionsDir = corePaths(dir).sessionsDir;
  const metas = EventLog.list(sessionsDir);
  const rows = await Promise.all(metas.map(async (m): Promise<StartSession> => {
    const log = new EventLog(sessionsDir, m);
    const live = await sockAlive(log.sockPath);
    const at = live ? Math.max(summarize(log.dir)?.stateSince ?? 0, m.updatedAt ?? m.createdAt) : closedTime(m);
    return { id: m.id, title: m.title ?? null, vendor: m.vendor ?? 'claude', cwd: m.cwd, live, at };
  }));
  const all = rows.sort((a, b) => b.at - a.at);
  return { cwd, here: all.filter((r) => r.cwd === cwd), all };
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** start.html 에 테마·입구(data-start: web|card)·폴더를 넣는다. inline 이면 style.css·plugins.js·start.js 를 넣어 주소 없이 돈다 (카드 문서, 옛 플러그인은 iframe srcdoc).
 *  plugins.js 는 import 가 닿지 않아 export 를 떼고 globalThis.slcodePlugins 로 건넨다 — start.js 의 openPlugins 가 그것을 먼저 본다 */
export function startPageHtml(dir: string, kind: SettingsKind, cwd: string | null, inline: boolean): string {
  const read = (f: string) => fs.readFileSync(path.join(WEB_DIR, f), 'utf8');
  let html = withPageAttrs(read('start.html'), dir, kind).replace('<html lang="ko"', `<html lang="ko" data-start="${inline ? 'card' : 'web'}"${cwd ? ` data-cwd="${attr(cwd)}"` : ''}`);
  if (inline) {
    // 스크립트 안의 </script 는 html 을 끊는다 — 모듈 글에는 없지만 막아 둔다
    html = html.replace('<link rel="stylesheet" href="./style.css">', () => `<style>${read('style.css')}</style>`)
      .replace('<script type="module" src="./start.js"></script>', () => [
        `${read('plugins.js').replace('export function pluginsPanel', 'function pluginsPanel')}\nglobalThis.slcodePlugins = { pluginsPanel };`, read('start.js'),
      ].map((js) => `<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>`).join('\n'));
  }
  return html;
}

export type StartChoice = { new: true } | { resume: string };
/** 웹 입구의 시작 화면 서버 — 진입 프로세스가 고르기 전의 연결을 넘긴다. 루프백 웹만 (토큰이 없다 — 출처 검사로 같은 PC 의 다른 사이트를 막는다).
 *  go 가 오면 chosen 이 새 세션이나 그 세션(이어서)으로 풀린다. 응답은 모두 연결을 닫는다 — 고른 뒤 새로 고친 화면이 새 연결로 세션 serve 에 닿게 */
export function startServer(dir: string, cwd: string): { server: http.Server; chosen: Promise<StartChoice> } {
  let choose!: (c: StartChoice) => void;
  const chosen = new Promise<StartChoice>((r) => (choose = r));
  let picked = false;
  const server = http.createServer((req, res) => {
    const send = (code: number, type: string, body: string) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache', connection: 'close' }); res.end(body); };
    const json = (code: number, o: unknown) => send(code, 'application/json', JSON.stringify(o));
    if (!loopbackAllowed(req)) { send(403, 'text/plain', 'forbidden'); return; }
    const url = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET') {
      if (url.startsWith('/s/')) { res.writeHead(302, { location: '/', connection: 'close' }); res.end(); return; } // 세션 주소를 연 탭이 시작 화면으로 돌아왔다 (ticket slcode-web-session-url)
      if (url === '/' || url === '/index.html') { send(200, 'text/html; charset=utf-8', startPageHtml(dir, 'web', cwd, false)); return; }
      const f = url.slice(1);
      if (f === 'style.css' || f === 'start.js' || f === 'plugins.js') { send(200, f.endsWith('.css') ? 'text/css' : 'text/javascript', fs.readFileSync(path.join(WEB_DIR, f), 'utf8')); return; }
      send(404, 'text/plain', 'not found'); return;
    }
    if (req.method !== 'POST' || !url.startsWith('/api/')) { send(404, 'text/plain', 'not found'); return; }
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const a = body ? JSON.parse(body) : {};
        const action = url.slice(5);
        if ((PLUGIN_METHODS as readonly string[]).includes(action)) { json(200, await pluginMethod(dir, action as (typeof PLUGIN_METHODS)[number], a)); return; } // 에이전트 플러그인 관리 (ticket slcode-agent-plugin-ui)
        switch (action) {
          case 'list': json(200, await startList(dir, cwd)); return;
          case 'go': {
            if (picked) { json(200, {}); return; } // 두 번 눌러도 한 세션
            if (typeof a.resume === 'string') {
              // 이 폴더의 꺼진 세션만 — 떠 있는 세션은 그 화면이 따로 있다
              const m = (await startList(dir, cwd)).here.find((x) => x.id === a.resume && !x.live);
              if (!m) { json(400, { error: `no closed session ${a.resume} in ${cwd}` }); return; }
              picked = true; choose({ resume: m.id }); json(200, {}); return;
            }
            if (a.new !== true) { json(400, { error: 'go {new: true} or {resume: <id>}' }); return; }
            picked = true; choose({ new: true }); json(200, {}); return;
          }
        }
        json(404, { error: 'unknown action' });
      } catch (e) { json(400, { error: (e as Error).message }); }
    });
  });
  return { server, chosen };
}
