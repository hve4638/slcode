// 세션 PATH (ticket slcode-session-bin-path, 사용자 2026-10-24) — 벤더 env 의 PATH 맨 앞에 core 를 띄운 설치 폴더의 bin/.
// 살아 있는 세션은 dist 를 복사한 임시 설치 폴더(bin/slcode 를 둔다)에서 가짜 codex(test/fixtures/fake-codex.mjs)로 띄워 받은 env 를 본다 — 먼저 pnpm build
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withBinPath } from '../src/core.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
/** bin/ 에 런처(names)를 둔 설치 폴더 */
function pkgWith(...names: string[]) {
  const pkg = tmp('slcode-pkg-');
  fs.mkdirSync(path.join(pkg, 'bin'));
  for (const n of names) fs.writeFileSync(path.join(pkg, 'bin', n), '', { mode: 0o755 });
  return pkg;
}

test('withBinPath: PATH 맨 앞에 <pkg>/bin, 런처가 없으면 그대로', () => {
  const pkg = pkgWith('slcode');
  const bin = path.join(pkg, 'bin');
  assert.equal(withBinPath({ PATH: '/usr/bin:/bin', X: '1' }, pkg, 'linux').PATH, `${bin}:/usr/bin:/bin`);
  assert.equal(withBinPath({ X: '1' }, pkg, 'linux').PATH, bin, 'PATH 가 없으면 bin 하나');
  assert.equal(withBinPath({ PATH: '/usr/bin', X: '1' }, pkg, 'linux').X, '1', '다른 변수는 그대로');
  const src = tmp('slcode-src-'); // 소스 체크아웃의 dist — bin/ 이 없다
  assert.deepEqual(withBinPath({ PATH: '/usr/bin' }, src, 'linux'), { PATH: '/usr/bin' });
  assert.deepEqual(withBinPath({ PATH: '/usr/bin' }, pkgWith('slcode.cmd'), 'linux'), { PATH: '/usr/bin' }, 'Linux 는 bin/slcode 를 본다');
});

test('withBinPath: Windows 는 bin/slcode.cmd 를 보고, 구분자 ; 로 있는 PATH 이름(Path)에 넣는다', () => {
  const pkg = pkgWith('slcode.cmd');
  const bin = path.join(pkg, 'bin');
  assert.deepEqual(withBinPath({ Path: 'C:\\Windows;C:\\bin' }, pkg, 'win32'), { Path: `${bin};C:\\Windows;C:\\bin` });
  assert.deepEqual(withBinPath({ PATH: 'C:\\Windows' }, pkgWith('slcode'), 'win32'), { PATH: 'C:\\Windows' }, 'slcode.cmd 가 없으면 그대로');
});

test('살아 있는 세션: 벤더가 받은 PATH 맨 앞이 설치 폴더의 bin, SLCODE_SESSION_ID 도 함께', { skip: process.platform === 'win32' }, async () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'dist', 'cli.js')), 'pnpm build 먼저');
  // 설치 폴더 흉내 — dist·package.json 복사, node_modules·web 은 링크, bin/slcode 런처
  const pkg = pkgWith('slcode');
  fs.cpSync(path.join(ROOT, 'dist'), path.join(pkg, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(pkg, 'package.json'));
  for (const d of ['node_modules', 'web']) fs.symlinkSync(path.join(ROOT, d), path.join(pkg, d));
  const dir = tmp('slcode-dir-'), work = tmp('slcode-work-'), envFile = path.join(tmp('slcode-env-'), 'env.json');
  const child = spawn(process.execPath, [path.join(pkg, 'dist', 'cli.js'), 'new', work, '--vendor', 'codex', '--no-web'], {
    env: { ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION_ID: undefined, SUPERLITE_SOCK: undefined, SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, FAKE_CODEX_ENV: envFile, PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = new Promise((r) => child.on('exit', r));
  let err = ''; child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => { err += d; });
  try {
    const t0 = Date.now(); while (!fs.existsSync(envFile) && child.exitCode === null && Date.now() - t0 < 15000) await sleep(50);
    assert.ok(fs.existsSync(envFile), err);
    const got = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(got.PATH, `${path.join(pkg, 'bin')}:/usr/bin:/bin`);
    assert.match(got.SLCODE_SESSION_ID, /^[0-9a-f]{8}$/);
  } finally {
    if (child.exitCode === null) child.kill('SIGINT');
    await exit;
  }
});
