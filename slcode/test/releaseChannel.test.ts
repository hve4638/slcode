// 릴리스 채널 (ticket slcode-prerelease-channels) — release.yml 이 쓰는 scripts/release-channel.sh 의 태그 → 채널
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
