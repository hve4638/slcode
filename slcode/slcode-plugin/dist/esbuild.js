// esbuild 를 처음 필요할 때 받는다 (ticket slcode-plugin-split, 사용자 결정 2026-10-31) — js/ts 훅이 있는 플러그인을 빌드할 때만 쓴다(agentHooks.bundle).
// slcode·slcode-plugin 어느 쪽에도 넣지 않는다. 그 플랫폼의 바이너리 패키지 하나와 JS 래퍼를 npm 레지스트리에서 받는다(버전·무결성 고정, 무결성은 pnpm-lock.yaml 의 것).
// 찾는 순서: 이 패키지에서 import 할 수 있는 같은 판 esbuild(개발 checkout) → 캐시(상태 폴더 agent-plugins/tools/, slcode 와 함께 쓴다) → 받기.
// 빌드는 동기라(ensureBuild) 받기는 따로 띄운 node 가 한다. 받지 못하면 던진다 — 부른 쪽이 그 스크립트만 빼고 사유를 남긴다.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchTarball, placeDir, REGISTRY, untar } from './npmFetch.js';
export const ESBUILD_VERSION = '0.28.2';
const INTEGRITY = {
    esbuild: 'sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==',
    'linux-x64': 'sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==',
    'linux-arm64': 'sha512-pW4AC0P3it8c7do9MVM4p51FzHzdM/TZrerurgRcHJ2WTa1VQ1CIq18xncfpBJw4ojkiZZrKW2yIBWBP92j6Ug==',
    'darwin-x64': 'sha512-uq6suIWYP37qzGddBKPw5QEQPi6HiLGsO7UmkpfyaYNQ3D+rN6w6WfwH+nuqcGXWvawGwxOEroO4YGnFh95azw==',
    'darwin-arm64': 'sha512-n4KqkOQrraxHJcgjM1RvwbigfQKIKJVpM7xp+KsxiyUSrRdIXnt73VhrPAx0fV44hgfmIVKjxMN9J1t5jySVkw==',
    'win32-x64': 'sha512-5ebpxr3nWMzrL/rnUI755Jkuee0bHL/Gq0WTF9lvcpv73wAp5eu8MfBUgWK9bhWvZjj7yX8etf/8tI8Ney695g==',
    'win32-arm64': 'sha512-PIhhEkE9uPBleRBrQEJpUn7MBnibZzbGzYWPmY3x+YoVg/95zbjB4CxPPOQ8l5tYYM4mMaCthF8/1DIfBQQyWQ==',
};
const FETCH_MS = 150_000;
/** 받기에 실패하면 이만큼은 다시 받지 않는다 — 오프라인에서 빌드마다 기다리지 않게. 사유는 <캐시>.failed 에 */
const RETRY_MS = 5 * 60_000;
const SELF = fileURLToPath(import.meta.url);
const platform = () => `${process.platform}-${process.arch}`;
/** 캐시 안의 그 판·플랫폼 폴더 — esbuild/ 는 JS 래퍼 패키지, bin/ 은 바이너리 */
const cacheOf = (tools, plat) => path.join(tools, `esbuild-${ESBUILD_VERSION}-${plat}`);
const binOf = (dir, plat) => path.join(dir, 'bin', plat.startsWith('win32') ? 'esbuild.exe' : 'esbuild');
/** 받아 둔 래퍼를 그 바이너리로 — 래퍼는 실릴 때 ESBUILD_BINARY_PATH 를 읽고, buildSync 는 처음 부를 때 worker 스레드에서 래퍼를 다시 싣는다(그때의 env 사본).
 *  그래서 싣는 동안과 buildSync 동안만 env 에 둔다 — 세션 프로세스의 자식(벤더·도구)에 새지 않게 */
function loadCached(dir, plat) {
    const withPath = (fn) => {
        const prev = process.env.ESBUILD_BINARY_PATH;
        process.env.ESBUILD_BINARY_PATH = binOf(dir, plat);
        try {
            return fn();
        }
        finally {
            if (prev === undefined)
                delete process.env.ESBUILD_BINARY_PATH;
            else
                process.env.ESBUILD_BINARY_PATH = prev;
        }
    };
    const main = path.join(dir, 'esbuild', 'lib', 'main.js');
    const real = withPath(() => createRequire(main)(main));
    return { buildSync: (opts) => withPath(() => real.buildSync(opts)) };
}
let loaded = null;
/** esbuild — tools 는 캐시 폴더. 받지 못하면 사유를 던진다 (실패 뒤 RETRY_MS 동안은 받지 않고 같은 사유) */
export function loadEsbuild(tools) {
    if (loaded)
        return loaded;
    const req = createRequire(import.meta.url);
    try {
        if (req('esbuild/package.json').version === ESBUILD_VERSION)
            return (loaded = req('esbuild'));
    }
    catch { }
    const plat = platform();
    if (!INTEGRITY[plat])
        throw new Error(`esbuild ${ESBUILD_VERSION}: no prebuilt binary for ${plat}`);
    const dir = cacheOf(tools, plat);
    if (!fs.existsSync(binOf(dir, plat))) {
        const failed = `${dir}.failed`;
        try {
            if (Date.now() - fs.statSync(failed).mtimeMs < RETRY_MS)
                throw new Error(fs.readFileSync(failed, 'utf8'));
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
        const p = spawnSync(process.execPath, [...process.execArgv, SELF, '--fetch', dir, plat], { encoding: 'utf8', timeout: FETCH_MS, windowsHide: true });
        if (!fs.existsSync(binOf(dir, plat))) {
            const why = `could not get esbuild ${ESBUILD_VERSION}: ${p.error?.message ?? ((p.stderr || '').trim().split('\n').pop() || `exit ${p.status}`)}`;
            try {
                fs.mkdirSync(tools, { recursive: true });
                fs.writeFileSync(failed, why);
            }
            catch { }
            throw new Error(why);
        }
        fs.rmSync(failed, { force: true });
    }
    return (loaded = loadCached(dir, plat));
}
/** 받기 (따로 띄운 node) — 래퍼와 그 플랫폼 패키지를 받아 dir 에 놓는다 */
async function fetchTo(dir, plat) {
    const wrapper = await fetchTarball(`${REGISTRY}/esbuild/-/esbuild-${ESBUILD_VERSION}.tgz`, INTEGRITY.esbuild);
    const bin = await fetchTarball(`${REGISTRY}/@esbuild/${plat}/-/${plat}-${ESBUILD_VERSION}.tgz`, INTEGRITY[plat]);
    await placeDir(dir, async (tmp) => {
        untar(wrapper, path.join(tmp, 'w'));
        fs.renameSync(path.join(tmp, 'w', 'package'), path.join(tmp, 'esbuild'));
        untar(bin, path.join(tmp, 'b'));
        const exe = plat.startsWith('win32') ? 'esbuild.exe' : path.join('bin', 'esbuild');
        fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
        fs.renameSync(path.join(tmp, 'b', 'package', exe), binOf(tmp, plat));
        fs.rmSync(path.join(tmp, 'w'), { recursive: true, force: true });
        fs.rmSync(path.join(tmp, 'b'), { recursive: true, force: true });
    });
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF && process.argv[2] === '--fetch' && process.argv[3] && INTEGRITY[process.argv[4]]) {
    fetchTo(process.argv[3], process.argv[4]).catch((e) => { console.error(e.message); process.exit(1); });
}
