// slcode-plugin 분리 (ticket slcode-plugin-split) — 단독 명령, 상태 폴더 형식 판, export 훅 명령의 고정 런처, 커밋한 dist 가 소스와 같은지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addPlugin, agentPaths, readConfig, STATE_FORMAT, writeConfig } from '../src/agentPlugins.ts';
import { hookLaunch } from '../src/agentHooks.ts';
import { ensureLauncher, launcherPath, PLUGIN_VERSION } from '../src/launcher.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-split-${p}-`));
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}
const plugin = (name: string, files: Record<string, string> = {}) => {
  const src = tmp(name);
  write(src, { 'slcode-plugin.json': JSON.stringify({ name, version: '1.0.0', parts: { main: {} } }), 'main/instructions/a.md': 'hi', ...files });
  return src;
};
const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/cli.ts'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

test('단독 명령: add·list·remove 를 --dir 또는 $SLCODE_DIR 의 상태 폴더에, 틀린 인자는 usage 로 2', () => {
  const dir = tmp('state');
  const src = plugin('solo');
  const add = cli(['add', src, '--dir', dir]);
  assert.equal(add.status, 0, add.stderr);
  assert.equal(JSON.parse(add.stdout).name, 'solo');
  const list = cli(['list', '--json'], { SLCODE_DIR: dir });
  assert.deepEqual(JSON.parse(list.stdout).map((r: { name: string }) => r.name), ['solo'], 'SLCODE_DIR 가 기본 상태 폴더');
  assert.equal(readConfig(agentPaths(dir)).format, STATE_FORMAT, '쓸 때 형식 판을 적는다');
  const bad = cli(['set', 'solo', '--dir', dir]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^usage: slcode-plugin set <name>/);
  assert.equal(cli(['remove', 'solo', '--dir', dir]).status, 0);
  assert.equal(cli(['--version']).stdout.trim(), PLUGIN_VERSION);
});

test('형식 판: 이 사본보다 높은 형식의 상태 폴더에는 쓰지 않는다 — 읽기(list)는 된다', async () => {
  const dir = tmp('state');
  await addPlugin(plugin('a'), dir);
  const ap = agentPaths(dir);
  const c = readConfig(ap);
  fs.writeFileSync(ap.config, JSON.stringify({ ...c, format: STATE_FORMAT + 1, future: { x: 1 } }));
  await assert.rejects(addPlugin(plugin('b'), dir), /is format 2 — this slcode-plugin .* knows up to 1/);
  assert.equal(readConfig(ap).plugins.b, undefined);
  assert.deepEqual(JSON.parse(cli(['list', '--json', '--dir', dir]).stdout).map((r: { name: string }) => r.name), ['a']);
  // 같은 형식이면 모르는 칸(다른 사본이 더한 것)을 남긴다
  fs.writeFileSync(ap.config, JSON.stringify({ ...c, future: { x: 1 }, plugins: { a: { ...c.plugins.a, extra: 7 } } }));
  await addPlugin(plugin('b'), dir);
  writeConfig(ap, readConfig(ap));
  const after = readConfig(ap) as unknown as { future: unknown; plugins: Record<string, { extra?: number }> };
  assert.deepEqual(after.future, { x: 1 });
  assert.equal(after.plugins.a.extra, 7);
});

test('런처: 없으면 이 사본의 node·hookMain 으로 쓰고, 살아 있는 새 판은 남기고, 옛 판·가리키는 파일이 없는 것은 다시 쓴다', () => {
  const agentDir = path.join(tmp('state'), 'agent-plugins');
  const file = ensureLauncher(agentDir);
  assert.equal(file, launcherPath(agentDir));
  const [node, main] = hookLaunch();
  const mine = fs.readFileSync(file, 'utf8');
  assert.ok(mine.includes(`# slcode-plugin ${PLUGIN_VERSION}\n`) && mine.includes(`exec '${node}' '${main}' "$@"`), mine);
  assert.equal(fs.statSync(file).mode & 0o111, 0o111);
  const other = (ver: string, target: string) => fs.writeFileSync(file, `#!/bin/sh\n# slcode-plugin ${ver}\nexec '${node}' '${target}' "$@"\n`);
  other('99.0.0', main);
  ensureLauncher(agentDir);
  assert.match(fs.readFileSync(file, 'utf8'), /slcode-plugin 99\.0\.0/, '더 새 판이 살아 있으면 남긴다');
  other('99.0.0', '/nonexistent/hookMain.js');
  ensureLauncher(agentDir);
  assert.equal(fs.readFileSync(file, 'utf8'), mine, '가리키는 파일이 없으면 이 사본으로');
  other('0.0.1', main);
  ensureLauncher(agentDir);
  assert.equal(fs.readFileSync(file, 'utf8'), mine, '옛 판이면 이 사본으로');
});

test('export 판의 js/ts 훅 명령은 상태 폴더의 런처를 부른다 — 사본이 바뀌어도 명령 문자열은 같다', async () => {
  const dir = tmp('state');
  const bin = tmp('bin');
  for (const h of ['claude', 'codex']) { fs.writeFileSync(path.join(bin, h), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, h), 0o755); }
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp('home') };
  await addPlugin(plugin('g', {
    'main/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'g.ts' }] }),
    'main/g.ts': "import { slcode } from 'slcode/api'; slcode.on('Stop', () => {}); slcode.run();",
  }), dir);
  const r = cli(['export', 'g', '--to', 'claude', '--json', '--dir', dir], env);
  assert.equal(r.status, 0, r.stderr);
  const hooks = JSON.parse(fs.readFileSync(path.join(agentPaths(dir).export, 'claude', 'g', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const launcher = launcherPath(agentPaths(dir).dir);
  assert.equal(hooks.Stop[0].hooks[0].command, `${launcher} claude "\${CLAUDE_PLUGIN_ROOT}" Stop`);
  assert.ok(fs.existsSync(launcher));
});

test('커밋한 dist 가 src 를 빌드한 것과 같다 (superlite-for-agents 는 dist 를 넣어 간다)', () => {
  const out = tmp('dist');
  const tsc = path.join(ROOT, '..', 'node_modules', 'typescript', 'bin', 'tsc');
  execFileSync(process.execPath, [tsc, '-p', path.join(ROOT, 'tsconfig.json'), '--outDir', out], { cwd: ROOT });
  const list = (d: string) => fs.readdirSync(d).sort();
  assert.deepEqual(list(path.join(ROOT, 'dist')), list(out), 'dist 파일 목록 — pnpm build 뒤 커밋');
  for (const f of list(out)) assert.equal(fs.readFileSync(path.join(ROOT, 'dist', f), 'utf8'), fs.readFileSync(path.join(out, f), 'utf8'), `dist/${f} 가 낡았다 — pnpm build 뒤 커밋`);
});
