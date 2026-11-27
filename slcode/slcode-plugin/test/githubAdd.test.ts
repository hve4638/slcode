// GitHub 주소로 add·update (githubFetch·agentPlugins, ticket slcode-plugin-manager-add) — 네트워크 대신 GIT_CONFIG_* 의 url.insteadOf 로 https://github.com/ 을 로컬 저장소 폴더로 돌린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { githubSource } from '../src/githubFetch.ts';
import { addPlugin, agentPaths, readConfig, updatePlugin } from '../src/agentPlugins.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-gh-${p}-`));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}
const manifest = (name: string, version: string) => JSON.stringify({ name, version, parts: { base: {} } });

/** <hosts>/<owner>/<repo> 에 저장소를 만들고, https://github.com/ 이 hosts 를 가리키는 env */
function hosted(files: Record<string, string>) {
  const hosts = tmp('hosts');
  const repo = path.join(hosts, 'me', 'tool.git'); // clone 주소는 늘 .git 으로 끝난다
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, files);
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'one');
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${hosts}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' };
  return { repo, env, commit: (more: Record<string, string>) => { write(repo, more); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'more'); } };
}

test('githubSource: 저장소·.git·/tree/<ref>/<하위 폴더> 를 읽고, 그 밖은 null(폴더 경로)', () => {
  assert.deepEqual(githubSource('https://github.com/me/tool'), { repo: 'https://github.com/me/tool.git', ref: null, subdir: null });
  assert.deepEqual(githubSource(' https://github.com/me/tool.git/ '), { repo: 'https://github.com/me/tool.git', ref: null, subdir: null });
  assert.deepEqual(githubSource('https://github.com/me/tool/tree/v1/plugins/a'), { repo: 'https://github.com/me/tool.git', ref: 'v1', subdir: 'plugins/a' });
  assert.equal(githubSource('/home/me/tool'), null);
  assert.equal(githubSource('https://gitlab.com/me/tool'), null);
  assert.equal(githubSource('https://github.com/me'), null);
});

test('주소로 add 하면 받아 설치하고 source 에 주소를 적는다 — update 는 다시 받아 바뀐 것만 다시 빌드한다', async () => {
  const h = hosted({ 'slcode-plugin.json': manifest('tool', '0.1.0'), 'base/instructions/a.md': 'one' });
  const dir = tmp('state');
  const url = 'https://github.com/me/tool';
  const r = await addPlugin(url, dir, h.env);
  assert.equal(r.name, 'tool'); assert.equal(r.changed, true);
  const ap = agentPaths(dir);
  assert.equal(readConfig(ap).plugins.tool.source, url);
  assert.equal(fs.readFileSync(path.join(ap.installed, 'tool/base/instructions/a.md'), 'utf8'), 'one');
  assert.deepEqual(fs.readdirSync(path.join(ap.dir, 'fetch')), [], '받은 폴더는 지운다');
  assert.equal(fs.existsSync(path.join(ap.installed, 'tool/.git')), false, '.git 은 설치본에 들어가지 않는다');

  assert.equal((await updatePlugin('tool', dir, h.env)).changed, false);
  h.commit({ 'slcode-plugin.json': manifest('tool', '0.2.0'), 'base/instructions/a.md': 'two' });
  const u = await updatePlugin('tool', dir, h.env);
  assert.equal(u.changed, true); assert.equal(u.version, '0.2.0');
  assert.equal(fs.readFileSync(path.join(ap.installed, 'tool/base/instructions/a.md'), 'utf8'), 'two');
});

test('하위 폴더·브랜치 — /tree/<ref>/<폴더> 의 플러그인을 받는다. 없는 폴더·저장소는 사유와 함께 던진다', async () => {
  const h = hosted({ 'README.md': 'x', 'plugins/a/slcode-plugin.json': manifest('a', '1.0.0'), 'plugins/a/base/instructions/x.md': 'x' });
  git(h.repo, 'branch', 'rel');
  const dir = tmp('state');
  assert.equal((await addPlugin('https://github.com/me/tool/tree/rel/plugins/a', dir, h.env)).name, 'a');
  await assert.rejects(addPlugin('https://github.com/me/tool/tree/rel/plugins/b', dir, h.env), /no folder plugins\/b in https:\/\/github\.com\/me\/tool\.git \(rel\)/);
  await assert.rejects(addPlugin('https://github.com/me/tool/tree/rel/../..', dir, h.env), /no folder/);
  await assert.rejects(addPlugin('https://github.com/me/nope', dir, h.env), /cannot fetch https:\/\/github\.com\/me\/nope\.git: .+/);
  await assert.rejects(addPlugin('https://github.com/me/tool', dir, h.env), /no slcode-plugin\.json/, '저장소 맨 위에 manifest 가 없다');
  assert.deepEqual(fs.readdirSync(path.join(agentPaths(dir).dir, 'fetch')), [], '실패해도 받은 폴더는 지운다');
});

test('폴더로 설치한 것의 update 는 그 폴더에서 다시 복사한다 — 다른 출처로 다시 add 하면 update 는 그 출처를 따른다', async () => {
  const src = tmp('src');
  write(src, { 'slcode-plugin.json': manifest('tool', '0.1.0'), 'base/instructions/a.md': 'one' });
  const dir = tmp('state');
  await addPlugin(src, dir);
  write(src, { 'base/instructions/a.md': 'edited' });
  assert.equal((await updatePlugin('tool', dir)).changed, true);
  assert.equal(fs.readFileSync(path.join(agentPaths(dir).installed, 'tool/base/instructions/a.md'), 'utf8'), 'edited');

  const h = hosted({ 'slcode-plugin.json': manifest('tool', '0.1.0'), 'base/instructions/a.md': 'edited' });
  assert.equal((await addPlugin('https://github.com/me/tool', dir, h.env)).changed, false);
  assert.equal(readConfig(agentPaths(dir)).plugins.tool.source, 'https://github.com/me/tool', '내용이 같아도 출처는 고쳐 적는다');

  await assert.rejects(updatePlugin('nope', dir), /no agent plugin nope/);
});

test('update: 출처가 다른 플러그인을 담게 되면 설치하지 않고 던진다', async () => {
  const src = tmp('src');
  write(src, { 'slcode-plugin.json': manifest('tool', '0.1.0'), 'base/instructions/a.md': 'one' });
  const dir = tmp('state');
  await addPlugin(src, dir);
  write(src, { 'slcode-plugin.json': manifest('renamed', '0.1.0') });
  await assert.rejects(updatePlugin('tool', dir), /now holds renamed, not tool/);
  assert.equal(readConfig(agentPaths(dir)).plugins.renamed, undefined);
});

test('update: 원본 폴더가 사라졌으면 그 폴더 경로로 던진다', async () => {
  const src = tmp('src');
  write(src, { 'slcode-plugin.json': manifest('tool', '0.1.0'), 'base/instructions/a.md': 'one' });
  const dir = tmp('state');
  await addPlugin(src, dir);
  fs.rmSync(src, { recursive: true });
  await assert.rejects(updatePlugin('tool', dir), new RegExp(`no folder ${src}`));
});
