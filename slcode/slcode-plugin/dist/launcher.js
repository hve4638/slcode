// export 훅 명령이 부르는 고정 런처 (ticket slcode-plugin-split, 착수 결정 2026-10-31) — 상태 폴더 agent-plugins/bin/hook(Windows 는 hook.cmd).
// slcode-plugin 은 쓰는 쪽이 넣어 간다(slcode 의 zip, superlite-for-agents). 한 머신에 판이 다른 사본이 여럿이고 같은 상태 폴더를 쓴다.
// 훅 명령에 사본의 node·hookMain.js 경로를 박으면 export 한 사본에 따라 명령이 바뀌고(Codex 는 신뢰를 다시 묻는다), 그 node 가 바뀌면(superlite 의 node 교체) 훅이 깨진다.
// 그래서 명령은 이 런처를 부르고, 런처의 내용(어느 node·hookMain.js 로 갈지)은 사본이 돌 때마다 맞춘다: 없거나, 가리키는 파일이 없거나, 자기 판이 더 새것이면 다시 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hookLaunch } from './agentHooks.js';
export const PLUGIN_VERSION = createRequire(import.meta.url)('../package.json').version;
const WIN = process.platform === 'win32';
const MARK = /^(?:#|@rem) slcode-plugin (\S+)\r?$/m;
export const launcherPath = (agentDir) => path.join(agentDir, 'bin', WIN ? 'hook.cmd' : 'hook');
function newer(a, b) {
    const n = (v) => v.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
    const [x, y] = [n(a), n(b)];
    for (let i = 0; i < 3; i++)
        if (x[i] !== y[i])
            return x[i] > y[i];
    return false;
}
/** 런처를 맞추고 그 경로를 돌려준다. 다른 사본이 쓴 것이 살아 있고 그 판이 이 판보다 낮지 않으면 그대로 둔다 */
export function ensureLauncher(agentDir) {
    const file = launcherPath(agentDir);
    const [node, main] = hookLaunch();
    let cur = '';
    try {
        cur = fs.readFileSync(file, 'utf8');
    }
    catch { }
    if (cur) {
        const ver = MARK.exec(cur)?.[1] ?? '0.0.0';
        const targets = [...cur.matchAll(WIN ? /"([^"]+)"/g : /'((?:[^']|'\\'')+)'/g)].map((x) => x[1].replaceAll("'\\''", "'"));
        const alive = targets.length >= 2 && targets.slice(0, 2).every((t) => fs.existsSync(t));
        if (alive && !newer(PLUGIN_VERSION, ver))
            return file;
    }
    const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
    const text = WIN
        ? `@echo off\r\n@rem slcode-plugin ${PLUGIN_VERSION}\r\n@rem export 한 에이전트 플러그인의 훅 명령이 부른다 — slcode-plugin 사본이 돌 때 새 판으로 다시 쓴다\r\n"${node}" "${main}" %*\r\n`
        : `#!/bin/sh\n# slcode-plugin ${PLUGIN_VERSION}\n# export 한 에이전트 플러그인의 훅 명령이 부른다 — slcode-plugin 사본이 돌 때 새 판으로 다시 쓴다\nexec ${q(node)} ${q(main)} "$@"\n`;
    if (text === cur)
        return file;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o755 });
    fs.renameSync(tmp, file);
    return file;
}
