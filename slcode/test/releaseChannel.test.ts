// 릴리스 채널 (ticket slcode-prerelease-channels) — release.yml 이 쓰는 scripts/release-channel.sh 의 태그 → 채널
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stepRun } from '../scripts/workflowStep.mjs';

const script = fileURLToPath(new URL('../scripts/release-channel.sh', import.meta.url));
const channel = (tag: string) => {
  const r = spawnSync('bash', [script, tag], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n').join(' ') : null;
};

test('release-channel: 꼬리 없는 태그는 stable, 시험판은 prerelease, unstable·experimental 은 빠른 경로', () => {
  assert.equal(channel('v0.5.11'), 'channel=stable prerelease=false fast=false');
  assert.equal(channel('v0.6.0-beta.1'), 'channel=beta prerelease=true fast=false');
  assert.equal(channel('v0.6.0-unstable.12'), 'channel=unstable prerelease=true fast=true');
  assert.equal(channel('v1.0.0-experimental.3'), 'channel=experimental prerelease=true fast=true');
});

test('release-channel: 모르는 채널·번호 없는 꼬리·v 없는 태그는 실패', () => {
  for (const t of ['v0.6.0-rc.1', 'v0.6.0-beta', 'v0.6.0-beta.1.2', '0.6.0', 'v0.6']) assert.equal(channel(t), null, t);
});

// publish job 의 셸 (SHA256SUMS.txt → release 공개) 을 release.yml 에서 그대로 꺼내 가짜 gh 로 돌린다 (ticket slcode-release-check-script)

const publish = (env: { TAG: string; FAST: string; PRERELEASE: string }, existing = false) => {
  const d = mkdtempSync(join(tmpdir(), 'slcode-publish-'));
  try {
    const ver = env.TAG.slice(1);
    for (const p of ['linux-x64', 'linux-arm64', 'win-x64']) writeFileSync(join(d, `slcode-${ver}-${p}.zip`), p);
    writeFileSync(join(d, 'gh'), `#!/bin/sh\n[ "$1 $2" != "release view" ] || exit ${existing ? 0 : 1}\nprintf '[%s]' "$@" >> "$GH_LOG"; echo >> "$GH_LOG"\n`);
    chmodSync(join(d, 'gh'), 0o755);
    const script = stepRun('SHA256SUMS.txt') + stepRun('release 공개');
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: d, encoding: 'utf8', env: { ...env, PATH: `${d}:${process.env.PATH}`, GH_LOG: join(d, 'gh.log') } });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(d, 'gh.log'), 'utf8').trim();
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};
const zips = (v: string, plats: string[]) => plats.map((p) => `[slcode-${v}-${p}.zip]`).join('');

test('release 공개: 정식 태그는 세 플랫폼을 prerelease 없이, 시험판은 --prerelease, 빠른 경로는 linux-x64 만', () => {
  const all = ['linux-x64', 'linux-arm64', 'win-x64'];
  assert.equal(publish({ TAG: 'v0.5.12', FAST: 'false', PRERELEASE: 'false' }),
    `[release][create][v0.5.12]${zips('0.5.12', all)}[SHA256SUMS.txt][--verify-tag][--title][slcode v0.5.12][--notes][slcode v0.5.12 바이너리 (linux-x64, linux-arm64, win-x64)]`);
  assert.equal(publish({ TAG: 'v0.6.0-beta.1', FAST: 'false', PRERELEASE: 'true' }),
    `[release][create][v0.6.0-beta.1]${zips('0.6.0-beta.1', all)}[SHA256SUMS.txt][--verify-tag][--prerelease][--title][slcode v0.6.0-beta.1][--notes][slcode v0.6.0-beta.1 바이너리 (linux-x64, linux-arm64, win-x64)]`);
  assert.equal(publish({ TAG: 'v0.6.0-unstable.2', FAST: 'true', PRERELEASE: 'true' }),
    `[release][create][v0.6.0-unstable.2]${zips('0.6.0-unstable.2', ['linux-x64'])}[SHA256SUMS.txt][--verify-tag][--prerelease][--title][slcode v0.6.0-unstable.2][--notes][slcode v0.6.0-unstable.2 바이너리 (linux-x64)]`);
});

test('release 공개: 태그에 release 가 이미 있으면 자산만 덮어쓴다', () => {
  assert.equal(publish({ TAG: 'v0.5.12', FAST: 'false', PRERELEASE: 'false' }, true),
    `[release][upload][v0.5.12]${zips('0.5.12', ['linux-x64', 'linux-arm64', 'win-x64'])}[SHA256SUMS.txt][--clobber]`);
});
