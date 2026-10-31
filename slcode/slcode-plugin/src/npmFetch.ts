// npm 레지스트리에서 패키지 tarball 을 받아 푼다 — typescript(scriptCheck)·esbuild(esbuild.ts)를 처음 필요할 때 받는 데 쓴다. 버전·무결성은 부르는 쪽이 고정한다.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';

export const REGISTRY = 'https://registry.npmjs.org';
const FETCH_MS = 60_000;

/** ustar 를 dest 에 푼다 — 일반 파일만 (npm 패키지 tarball). mode 의 실행 비트를 남긴다 */
export function untar(buf: Buffer, dest: string) {
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const mode = parseInt(str(100, 8).trim() || '644', 8);
    const name = [str(345, 155), str(0, 100)].filter(Boolean).join('/');
    const type = String.fromCharCode(h[156]);
    off += 512;
    if ((type === '0' || type === '\0') && name && !name.split('/').includes('..')) {
      const to = path.join(dest, name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, buf.subarray(off, off + size), { mode: mode & 0o111 ? 0o755 : 0o644 });
    }
    off += Math.ceil(size / 512) * 512;
  }
}

/** tarball 을 받아 무결성(sha512-…)을 대조한 뒤 푼 내용(tar) — 맞지 않으면 던진다 */
export async function fetchTarball(url: string, integrity: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tgz = Buffer.from(await res.arrayBuffer());
  if (`sha512-${createHash('sha512').update(tgz).digest('base64')}` !== integrity) throw new Error(`${url}: integrity mismatch`);
  return zlib.gunzipSync(tgz);
}

/** dir 을 fill 로 채운다 — 옆 임시 폴더에 만든 뒤 rename. 동시에 받았으면 먼저 놓인 것을 쓴다 */
export async function placeDir(dir: string, fill: (tmp: string) => Promise<void>) {
  const tmp = path.join(path.dirname(dir), `.tmp-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tmp, { recursive: true });
  try { await fill(tmp); } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  try { fs.renameSync(tmp, dir); } catch { fs.rmSync(tmp, { recursive: true, force: true }); }
}
