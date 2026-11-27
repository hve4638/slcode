// GitHub 저장소 주소로 플러그인 원본을 받는다 (ticket slcode-plugin-manager-add, 사용자 2026-11-26: URL 은 GitHub 저장소) — PC 의 git 으로 얕게 clone 한다. 새 의존성은 넣지 않는다.
// 비밀번호를 묻지 않는다(GIT_TERMINAL_PROMPT=0) — 비공개 저장소는 사용자의 git 인증 설정이 있을 때만 받아진다. env 는 그대로 git 에 넘긴다(시험은 GIT_CONFIG_* 의 url.insteadOf 로 로컬 저장소를 가리킨다).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const CLONE_MS = 120_000;
const RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/;
/** https://github.com/<owner>/<repo>[.git][/tree/<ref>[/<하위 폴더>]] — 아니면 null(폴더 경로). ref 는 /tree/ 뒤 첫 마디뿐이라 / 가 든 브랜치 이름은 받지 못한다 */
export function githubSource(s) {
    const m = RE.exec(s.trim());
    if (!m)
        return null;
    return { repo: `https://github.com/${m[1]}/${m[2]}.git`, ref: m[3] ? decodeURIComponent(m[3]) : null, subdir: m[4] ? decodeURIComponent(m[4]) : null };
}
/** into 에 clone 하고 플러그인 폴더를 돌려준다 — 실패면 git 의 fatal 줄로 던진다. into 는 부른 쪽이 지운다 */
export async function fetchGithub(src, into, env = process.env) {
    fs.mkdirSync(path.dirname(into), { recursive: true });
    const args = ['clone', '--depth', '1', '--quiet', ...(src.ref ? ['--branch', src.ref] : []), '--', src.repo, into];
    await new Promise((resolve, reject) => {
        const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
        let err = '';
        child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
        const timer = setTimeout(() => child.kill('SIGKILL'), CLONE_MS);
        child.once('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'cannot fetch: git is not installed' : `cannot fetch: ${e.message}`)); });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (code === 0)
                return resolve();
            const line = err.split('\n').map((l) => l.trim()).find((l) => l.startsWith('fatal:'))?.slice(6).trim();
            reject(new Error(`cannot fetch ${src.repo}: ${signal ? `timed out after ${CLONE_MS / 1000}s` : line || err.trim() || `git exited ${code}`}`));
        });
    });
    if (!src.subdir)
        return into;
    const dir = path.resolve(into, src.subdir);
    if (path.relative(into, dir).startsWith('..') || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`no folder ${src.subdir} in ${src.repo}${src.ref ? ` (${src.ref})` : ''}`);
    return dir;
}
