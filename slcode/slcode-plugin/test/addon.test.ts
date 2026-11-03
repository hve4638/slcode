// 애드온 형식 (ticket slcode-plugin-addon, 사용자 결정·받아들인 제안 2026-11-03) — 베이스에 합쳐 빌드, 베이스 이름 아래 스킬·지시문, when.part 사슬,
// add 거절(베이스 없음·판 조건·이름 겹침), 따로 제거·--cascade, 베이스 갱신 때 맞지 않는 애드온만 빠짐, 값과 프로필, export 판, 옛 사본이 보는 plugins 칸
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADDON_MANIFEST, MANIFEST, readManifest, versionHolds } from '../src/agentFormat.ts';
import { addPlugin, agentPaths, currentBuilds, listPlugins, loadSessionPlugins, orphanAddons, readConfig, reloadSessionPlugins, removePlugin, scriptWarnings, setPlugin, writeConfig } from '../src/agentPlugins.ts';
import { exportBuild } from '../src/agentExport.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-addon-${p}-`));
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}
type Spec = { name: string; version?: string; addon?: { base: string; version: string }; parts: Record<string, object>; options?: object; env?: object };
/** part 마다 지시문·skill 을 둔 원본 폴더 */
function source(spec: Spec, extra: Record<string, string> = {}): string {
  const src = tmp('src');
  write(src, {
    [spec.addon ? ADDON_MANIFEST : MANIFEST]: JSON.stringify({ version: '1.0.0', ...spec }),
    ...Object.fromEntries(Object.keys(spec.parts).flatMap((p) => [[`${p}/instructions/${p}.md`, `${p} rule`], [`${p}/skills/${p}-skill/SKILL.md`, `---\nname: ${p}-skill\ndescription: ${p}\n---\nbody`]])),
    ...extra,
  });
  return src;
}
const BASE: Spec = { name: 'superlite', version: '0.4.0', parts: { main: { required: true } } };
const ORCH: Spec = { name: 'orchestration', version: '0.5.0', addon: { base: 'superlite', version: '^0.4.0' }, parts: { orch: { when: { part: { main: true }, param: { ROLE: true } } } } };
const DEEP: Spec = { name: 'deep', version: '0.1.0', addon: { base: 'orchestration', version: '>=0.5.0' }, parts: { leaf: { when: { part: { orch: true } } } } };
const on = (s: { values: string }) => s.values.split(',').filter((x) => x.endsWith('=1')).map((x) => x.slice(5, -2)).sort();
async function installed(...specs: Spec[]) {
  const dir = tmp('state');
  for (const s of specs) await addPlugin(source(s), dir);
  return { dir, ap: agentPaths(dir) };
}

test('manifest: 애드온은 slcode-addon.json 에 적는다 — slcode-plugin.json 의 addon 칸, 두 파일 함께, 빠진 칸, 조건 문법 오류는 거부한다', () => {
  const dirOf = (files: Record<string, string>) => { const d = tmp('m'); write(d, files); return d; };
  const a = JSON.stringify({ name: 'a', addon: { base: 'b', version: '^1.0.0' }, parts: {} });
  assert.deepEqual(readManifest(dirOf({ [ADDON_MANIFEST]: a })).addon, { base: 'b', version: '^1.0.0' });
  assert.throws(() => readManifest(dirOf({ [MANIFEST]: a })), /an addon goes in slcode-addon\.json/);
  assert.throws(() => readManifest(dirOf({ [MANIFEST]: a, [ADDON_MANIFEST]: a })), /keep one/);
  assert.throws(() => readManifest(dirOf({ [ADDON_MANIFEST]: JSON.stringify({ name: 'a' }) })), /slcode-addon\.json: addon must be/);
  for (const addon of [true, {}, { base: 'b' }, { version: '1.0.0' }, { base: 'b', version: 'latest' }, { base: 'b', version: '^1' }, { base: '../b', version: '1.0.0' }]) {
    assert.throws(() => readManifest(dirOf({ [ADDON_MANIFEST]: JSON.stringify({ name: 'a', addon }) })), /slcode-addon\.json: addon/, JSON.stringify(addon));
  }
  assert.throws(() => readManifest(dirOf({})), /no slcode-plugin\.json/);
});

test('판 조건: ^ ~ 비교 정확 판 * 와 공백 AND, 읽지 못하는 판은 맞지 않는다', () => {
  const table: [string, string, boolean][] = [
    ['0.4.0', '^0.4.0', true], ['0.4.9', '^0.4.0', true], ['0.5.0', '^0.4.0', false], ['0.3.9', '^0.4.0', false],
    ['1.9.0', '^1.2.0', true], ['2.0.0', '^1.2.0', false], ['1.1.9', '^1.2.0', false], ['0.0.3', '^0.0.3', true], ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true], ['1.3.0', '~1.2.3', false], ['1.2.2', '~1.2.3', false],
    ['1.2.3', '1.2.3', true], ['1.2.4', '1.2.3', false], ['1.2.3', '=1.2.3', true],
    ['2.0.0', '>=1.0.0', true], ['1.0.0', '>1.0.0', false], ['1.0.0', '<=1.0.0', true], ['1.0.0', '<1.0.0', false],
    ['1.5.0', '>=1.0.0 <2.0.0', true], ['2.0.0', '>=1.0.0 <2.0.0', false], ['9.9.9', '*', true],
    ['1.0.0-rc.1', '>=1.0.0', false], ['1.0.0-rc.1', '<1.0.0', true], ['1.0.0+build', '1.0.0', true],
    ['abc', '*', false], ['1.0', '^1.0.0', false],
  ];
  for (const [v, r, want] of table) assert.equal(versionHolds(v, r), want, `${v} ${r}`);
});

test('add 거절: 베이스 없음, 판 조건이 맞지 않음, 사슬의 베이스 없음, 플러그인과 애드온의 이름 충돌. 거절하면 상태가 그대로다', async () => {
  const empty = tmp('state');
  await assert.rejects(addPlugin(source(ORCH), empty), /needs base superlite, which is not installed/);
  assert.deepEqual(readConfig(agentPaths(empty)).addons, undefined);
  const { dir, ap } = await installed(BASE);
  await assert.rejects(addPlugin(source({ ...ORCH, addon: { base: 'superlite', version: '^0.5.0' } }), dir), /needs superlite \^0\.5\.0, installed 0\.4\.0/);
  await assert.rejects(addPlugin(source(DEEP), dir), /needs base orchestration/);
  assert.ok(!fs.existsSync(path.join(ap.addons, 'orchestration')), '거절이면 복사하지 않는다');
  await addPlugin(source(ORCH), dir);
  await assert.rejects(addPlugin(source({ name: 'orchestration', parts: { x: {} } }), dir), /is installed as an addon of superlite/);
  await assert.rejects(addPlugin(source({ name: 'superlite', addon: { base: 'orchestration', version: '*' }, parts: { x: {} } }), dir), /is installed as a plugin/);
  await assert.rejects(addPlugin(source({ ...ORCH, addon: { base: 'deep', version: '*' } }), (await addPlugin(source(DEEP), dir), dir)), /cycle/);
});

test('이름 겹침: part·옵션·skill·명령이 베이스나 다른 애드온과 같으면 add 를 거절한다', async () => {
  const spec: Spec = { ...BASE, parts: { main: { required: true } }, options: { mode: { type: 'string', default: 'a' } } };
  const { dir } = await installed(spec, ORCH);
  const addon = (name: string, parts: Record<string, object>, extra = {}, options?: object) => source({ name, addon: { base: 'superlite', version: '*' }, parts, ...(options ? { options } : {}) }, extra);
  await assert.rejects(addPlugin(addon('x', { main: {} }), dir), /main is already a part or option of superlite/, '베이스 part');
  await assert.rejects(addPlugin(addon('x', { orch: {} }), dir), /orch is already a part or option/, '다른 애드온 part');
  await assert.rejects(addPlugin(addon('x', { mode: {} }), dir), /mode is already a part or option/, 'part 와 옵션');
  await assert.rejects(addPlugin(addon('x', { p: {} }, {}, { mode: { type: 'boolean' } }), dir), /mode is already/, '옵션');
  await assert.rejects(addPlugin(addon('x', { p: {} }, { 'p/skills/main-skill/SKILL.md': 'body' }), dir), /skill main-skill has the same name as skill main-skill of superlite/, '베이스 skill');
  await assert.rejects(addPlugin(addon('x', { p: {} }, { 'p/skills/orch-skill/SKILL.md': 'body' }), dir), /of orchestration/, '다른 애드온 skill');
  await assert.rejects(addPlugin(addon('x', { p: {} }, { 'p/commands/main-skill/COMMAND.ts': 'x' }), dir), /command main-skill has the same name as skill main-skill/, '명령과 skill');
  assert.deepEqual(listPlugins(dir)[0].addons.map((a) => a.name), ['orchestration'], '거절한 것은 남지 않는다');
});

test('when.part: 애드온은 베이스 사슬의 part 를 보고, 자기 밖 형제 애드온은 볼 수 없고, 베이스는 애드온 쪽 part 를 볼 수 없다', async () => {
  const { dir } = await installed(BASE, ORCH);
  await assert.rejects(addPlugin(source({ name: 'x', addon: { base: 'superlite', version: '*' }, parts: { p: { when: { part: { orch: true } } } } }), dir), /part p when part orch is not a part of this addon or its base/, '형제');
  await assert.rejects(addPlugin(source({ name: 'x', addon: { base: 'superlite', version: '*' }, parts: { p: { when: { part: { nope: true } } } } }), dir), /when part nope/, '없는 이름');
  await assert.rejects(addPlugin(source({ name: 'x', addon: { base: 'superlite', version: '*' }, parts: { p: { when: { part: { p: true } } } } }), dir), /refers to itself/, '자기 참조');
  await assert.rejects(addPlugin(source({ name: 'superlite', version: '0.4.1', parts: { main: { required: true, when: { part: { orch: true } } } } }), dir), /is not a part of this plugin/, '베이스 → 애드온');
});

test('세션에 싣기: 스킬·지시문이 베이스 이름 아래, when.part 사슬이 베이스까지, 경로 변수는 합친 폴더, 애드온의 애드온도 맨 아래 베이스 이름', async () => {
  const dir = tmp('state');
  await addPlugin(source({ ...BASE, parts: { main: { required: true } }, env: { FROM_BASE: '1' } }), dir);
  await addPlugin(source({ ...ORCH, env: { FROM_ADDON: '1' } }, {
    'orch/bin/orch-tool': '#!/bin/sh\necho orch',
    'orch/instructions/path.md': 'run ${CLAUDE_PLUGIN_ROOT}/bin/orch-tool',
    'orch/.mcp.json': JSON.stringify({ mcpServers: { orchsrv: { command: '${CLAUDE_PLUGIN_ROOT}/bin/orch-tool' } } }),
  }), dir);
  const deep = await addPlugin(source(DEEP), dir);
  assert.equal(deep.base, 'superlite', '합쳐진 플러그인은 맨 아래 베이스');
  const sdir = tmp('s');
  const s = loadSessionPlugins(sdir, {}, {}, dir, 'claude', undefined, { ROLE: 'w' });
  assert.deepEqual(s.loaded.map((l) => [l.name, l.version]), [['superlite', '0.4.0']], '플러그인은 베이스 하나, 판은 베이스 판');
  assert.deepEqual(on(s.loaded[0]), ['leaf', 'main', 'orch']);
  const root = path.join(sdir, 'agent-plugins', 'superlite');
  for (const k of ['main-skill', 'orch-skill', 'leaf-skill']) assert.ok(fs.existsSync(path.join(root, 'skills', k, 'SKILL.md')), k);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8')).name, 'superlite');
  assert.ok(fs.existsSync(path.join(root, 'bin/orch-tool')), '애드온 파일이 플러그인 폴더에');
  assert.equal(s.append, `main rule\n\norch rule\n\nrun ${root}/bin/orch-tool\n\nleaf rule`, '지시문은 베이스 다음 애드온 순서, 경로 변수는 세션 링크');
  assert.deepEqual([s.env.FROM_BASE, s.env.FROM_ADDON], ['1', '1']);
  assert.deepEqual(s.notes, []);
  // 조건이 거짓이면 사슬 끝까지 꺼진다
  assert.deepEqual(on(loadSessionPlugins(tmp('s'), {}, {}, dir).loaded[0]), ['main'], 'param 없음 — orch 와 그에 걸린 leaf 가 꺼진다');
  await setPlugin('superlite', ['orch=off'], dir);
  assert.deepEqual(on(loadSessionPlugins(tmp('s'), {}, {}, dir, 'claude', undefined, { ROLE: 'w' }).loaded[0]), ['main'], '베이스 이름으로 part 를 끄면 leaf 도 꺼진다');
  await setPlugin('superlite', ['orch=on'], dir);
  // Codex — MCP 이름과 skill root 가 베이스 이름 기준, 경로 변수는 빌드 폴더
  const cx = loadSessionPlugins(tmp('cx'), {}, {}, dir, 'codex', undefined, { ROLE: 'w' });
  assert.deepEqual(on(cx.loaded[0]), ['leaf', 'main', 'orch']);
  const croot = cx.loaded[0].codex!.root;
  assert.ok(fs.existsSync(path.join(croot, 'skills/leaf-skill/SKILL.md')));
  assert.ok(cx.codex.args.some((a) => a.startsWith('mcp_servers.plugin_superlite_orchsrv=') && a.includes(`${croot}/bin/orch-tool`)), cx.codex.args.join(' '));
  assert.ok(cx.append.includes(`run ${croot}/bin/orch-tool`));
});

test('빌드 식별자: 애드온 add·remove·내용 변경이 베이스 빌드를 바꾼다. 애드온이 없으면 애드온 전과 같고, 같은 원본을 다시 add 하면 아무것도 하지 않는다', async () => {
  const dir = tmp('state');
  const b0 = await addPlugin(source(BASE), dir);
  const src = source(ORCH);
  const a1 = await addPlugin(src, dir);
  assert.equal(a1.changed, true);
  assert.notEqual(a1.build, b0.build, 'add 하면 베이스를 다시 빌드한다');
  assert.equal(readConfig(agentPaths(dir)).plugins.superlite.builds.claude, a1.build);
  assert.equal((await addPlugin(src, dir)).changed, false);
  fs.writeFileSync(path.join(src, 'orch/instructions/orch.md'), 'orch rule 2');
  const a2 = await addPlugin(src, dir);
  assert.notEqual(a2.build, a1.build, '애드온 내용이 해시에 든다');
  const v1 = source({ ...ORCH, version: '0.5.1' });
  assert.notEqual((await addPlugin(v1, dir)).build, a2.build, '판도 manifest 내용으로 든다');
  await removePlugin('orchestration', dir);
  assert.equal(readConfig(agentPaths(dir)).plugins.superlite.builds.claude, b0.build, '제거하면 베이스만의 식별자로 돌아간다');
  assert.equal(currentBuilds({}, dir).superlite, b0.build);
});

test('제거: 애드온만 지우면 베이스가 남고, 의존이 있으면 거절, --cascade 면 함께 지운다', async () => {
  const { dir, ap } = await installed(BASE, ORCH, DEEP);
  await assert.rejects(removePlugin('superlite', dir), /orchestration, deep depend on superlite: remove them first or use --cascade/);
  await assert.rejects(removePlugin('orchestration', dir), /deep depend on orchestration/);
  assert.deepEqual(listPlugins(dir)[0].addons.map((a) => [a.name, a.on]), [['orchestration', true], ['deep', true]], '거절이면 그대로');
  assert.deepEqual(await removePlugin('deep', dir), { name: 'deep', removed: true });
  assert.deepEqual(listPlugins(dir).map((r) => [r.name, r.addons.map((a) => a.name)]), [['superlite', ['orchestration']]], '애드온만 빠지고 베이스는 남는다');
  assert.ok(!fs.existsSync(path.join(ap.addons, 'deep')));
  await addPlugin(source(DEEP), dir);
  assert.deepEqual(await removePlugin('orchestration', dir, {}, true), { name: 'orchestration', removed: true, addons: ['deep'] }, '애드온의 --cascade');
  assert.deepEqual(listPlugins(dir)[0].addons, []);
  assert.deepEqual(on(loadSessionPlugins(tmp('s'), {}, {}, dir).loaded[0]), ['main']);
  await addPlugin(source(ORCH), dir);
  await addPlugin(source(DEEP), dir);
  const r = await removePlugin('superlite', dir, {}, true);
  assert.deepEqual(r, { name: 'superlite', removed: true, addons: ['orchestration', 'deep'] }, '베이스의 --cascade');
  assert.deepEqual(readConfig(ap).addons, {});
  assert.deepEqual(listPlugins(dir), []);
  assert.deepEqual(await removePlugin('none', dir), { name: 'none', removed: false }, '없어도 성공');
});

test('베이스 갱신: 판이 맞지 않게 되면 베이스는 갱신하고 그 애드온과 의존 애드온만 빠지며, 목록·add 결과·세션 알림에 사유가 보인다. 판이 맞으면 돌아온다', async () => {
  const { dir } = await installed(BASE, ORCH, DEEP);
  const r = await addPlugin(source({ ...BASE, version: '0.5.0' }), dir);
  assert.equal(r.version, '0.5.0', '베이스는 갱신');
  assert.deepEqual(r.leftOut, ['superlite: addon orchestration left out: needs superlite ^0.4.0, installed 0.5.0', 'superlite: addon deep left out: base addon orchestration is left out']);
  const row = listPlugins(dir)[0];
  assert.equal(row.version, '0.5.0');
  assert.deepEqual(row.addons.map((a) => [a.name, a.on]), [['orchestration', false], ['deep', false]]);
  assert.deepEqual(row.parts.map((p) => p.name), ['main'], '빠진 애드온의 part 는 보이지 않는다');
  const sdir = tmp('s');
  const s = loadSessionPlugins(sdir, {}, {}, dir, 'claude', undefined, { ROLE: 'w' });
  assert.deepEqual(s.notes, r.leftOut, '세션 알림');
  assert.equal(s.append, 'main rule');
  assert.ok(!fs.existsSync(path.join(sdir, 'agent-plugins/superlite/skills/orch-skill')));
  assert.deepEqual(reloadSessionPlugins(sdir, s.loaded, {}, {}, dir, 'claude', undefined, { ROLE: 'w' }).notes, r.leftOut, '다시 싣기도 알린다');
  await addPlugin(source({ ...ORCH, version: '0.6.0', addon: { base: 'superlite', version: '^0.5.0' } }), dir);
  const back = listPlugins(dir)[0].addons;
  assert.deepEqual(back.map((a) => [a.name, a.on, a.why]), [['orchestration', true, null], ['deep', true, null]], '애드온을 새 판으로 바꾸면 의존 애드온도 돌아온다');
  await addPlugin(source({ ...BASE, version: '0.5.1', parts: { main: { required: true }, orch: {} } }), dir);
  assert.match(listPlugins(dir)[0].addons[0].why!, /orch is already a part or option of superlite/, '베이스가 겹치는 part 를 새로 가져도 베이스는 갱신하고 애드온만 뺀다');
});

test('값: part 는 베이스 이름으로 set, 애드온 이름으로는 안내 오류. 값은 애드온 칸에 두어 빠졌다 돌아와도 남고, 제거하면 프로필 값과 함께 사라진다', async () => {
  const spec: Spec = { ...ORCH, parts: { orch: {} }, options: { level: { type: 'number', default: 1 } } };
  const { dir, ap } = await installed(BASE, spec);
  await assert.rejects(setPlugin('orchestration', ['orch=off'], dir), /orchestration is an addon of superlite: slcode plugin set superlite/);
  const r = await setPlugin('superlite', ['orch=off', 'level=7'], dir);
  assert.match(r.values, /part\.orch=0/);
  assert.match(r.values, /opt\.level=7/);
  assert.deepEqual(readConfig(ap).addons!.orchestration.values, { parts: { orch: false }, options: { level: 7 } });
  assert.deepEqual(readConfig(ap).plugins.superlite.values, { parts: {}, options: {} }, '베이스 칸에 넣지 않는다');
  assert.deepEqual(listPlugins(dir)[0].parts.map((p) => [p.name, p.on, p.addon]), [['main', true, null], ['orch', false, 'orchestration']]);
  await assert.rejects(setPlugin('superlite', ['nope=on'], dir), /no part or option named nope/);
  // 베이스 판이 달라져 빠졌다 돌아와도 값이 남는다
  await addPlugin(source({ ...BASE, version: '0.9.0' }), dir);
  await assert.rejects(setPlugin('superlite', ['orch=on'], dir), /no part or option/, '빠진 동안에는 그 part 가 없다');
  await addPlugin(source(BASE), dir);
  assert.deepEqual(listPlugins(dir)[0].parts.find((p) => p.name === 'orch')?.on, false);
  // 프로필·세션 층도 베이스 이름 아래로 애드온 part 를 고른다
  const layer = { plugins: { superlite: { parts: { orch: true }, options: { level: 9 } } }, rest: true };
  assert.deepEqual(on(loadSessionPlugins(tmp('s'), {}, {}, dir, 'claude', layer).loaded[0]), ['main', 'orch']);
  assert.deepEqual(on(loadSessionPlugins(tmp('s'), {}, { superlite: { parts: { orch: true } } }, dir).loaded[0]), ['main', 'orch']);
  assert.deepEqual(loadSessionPlugins(tmp('s'), {}, {}, dir, 'claude', { plugins: { superlite: { on: false } }, rest: true }).loaded, [], '베이스를 안 실으면 애드온도 안 실린다');
  // 제거하면 프로필에 남은 값도 지운다
  const c = readConfig(ap);
  c.profiles = { p1: { plugins: { superlite: { on: true, parts: { orch: true, main: true }, options: { level: 9 } } }, rest: true } };
  writeConfig(ap, c);
  await removePlugin('orchestration', dir);
  assert.deepEqual((readConfig(ap).profiles!.p1 as any).plugins.superlite, { on: true, parts: { main: true }, options: {} });
  await addPlugin(source(spec), dir);
  assert.deepEqual(listPlugins(dir)[0].options.map((o) => o.value), [1], '다시 설치하면 옛 값이 돌아오지 않는다');
  assert.deepEqual(listPlugins(dir)[0].parts.find((p) => p.name === 'orch')?.on, true);
});

test('실행 중 세션: 애드온을 add 하면 다시 실을 것으로 보이고 다시 싣기가 스킬을 바꾼다. 지시문은 새 세션부터(later)', async () => {
  const { dir } = await installed(BASE);
  const sdir = tmp('s');
  const s = loadSessionPlugins(sdir, {}, {}, dir);
  assert.equal(currentBuilds({}, dir).superlite, s.loaded[0].build);
  await addPlugin(source({ ...ORCH, parts: { orch: {} } }), dir);
  assert.notEqual(currentBuilds({}, dir).superlite, s.loaded[0].build);
  const r = reloadSessionPlugins(sdir, s.loaded, {}, {}, dir);
  assert.deepEqual(r.later, [{ name: 'superlite', what: ['instructions'] }]);
  assert.deepEqual(r.removed, []);
  assert.ok(fs.existsSync(path.join(sdir, 'agent-plugins/superlite/skills/orch-skill/SKILL.md')), '링크가 합친 빌드로');
  await removePlugin('orchestration', dir);
  assert.equal(reloadSessionPlugins(sdir, r.loaded, {}, {}, dir).removed.length, 0, '애드온 제거는 베이스를 떼지 않는다');
  assert.ok(!fs.existsSync(path.join(sdir, 'agent-plugins/superlite/skills/orch-skill')));
});

test('export 판: 애드온이 베이스 이름 아래에 들어가고, 애드온 이름으로는 export 하지 않으며, 조건 사유도 합친 part 로 적는다', async () => {
  const dir = tmp('state');
  await addPlugin(source(BASE), dir);
  await addPlugin(source({ ...ORCH, parts: { orch: { when: { part: { main: true } } }, byParam: { when: { param: { ROLE: true } } } } }, { 'orch/instructions/path.md': 'run ${CLAUDE_PLUGIN_ROOT}/bin/t', 'orch/bin/t': 'x' }), dir);
  const ap = agentPaths(dir);
  for (const h of ['claude', 'codex'] as const) {
    const ex = exportBuild(ap, 'superlite', readConfig(ap).plugins.superlite, h, {});
    assert.equal(path.basename(ex.plugin), 'superlite');
    assert.ok(fs.existsSync(path.join(ex.plugin, 'skills/orch-skill/SKILL.md')), h);
    assert.ok(fs.existsSync(path.join(ex.plugin, 'bin/t')), h);
    assert.ok(!fs.existsSync(path.join(ex.plugin, 'skills/byParam-skill')), h);
    assert.ok(ex.report.excluded.includes('byParam: part condition param ROLE (slcode session params only)'), `${h}: ${ex.report.excluded}`);
    const ctx = JSON.parse(fs.readFileSync(path.join(ex.plugin, 'hooks/slcode-instructions.json'), 'utf8')).hookSpecificOutput.additionalContext as string;
    assert.ok(ctx.includes('orch rule') && ctx.includes(`run ${path.join(ap.export, h, 'superlite')}/bin/t`), ctx);
    assert.equal(ex.report.version, '0.4.0', '판은 베이스 판');
  }
  // 옛 사본이 같은 식별자 아래에 베이스만으로 만든 Codex 판은 다시 쓰지 않는다
  const e = readConfig(ap).plugins.superlite;
  const made = exportBuild(ap, 'superlite', e, 'codex', {});
  const report = path.join(path.dirname(made.plugin), 'report.json');
  const { source: _s, ...oldReport } = JSON.parse(fs.readFileSync(report, 'utf8'));
  fs.writeFileSync(report, JSON.stringify(oldReport));
  fs.rmSync(path.join(made.plugin, 'skills/orch-skill'), { recursive: true });
  assert.ok(fs.existsSync(path.join(exportBuild(ap, 'superlite', e, 'codex', {}).plugin, 'skills/orch-skill/SKILL.md')));
  await assert.rejects(import('../src/agentPlugins.ts').then((x) => x.exportPlugin('orchestration', ['claude'], false, dir, {})), /orchestration is an addon of superlite: slcode plugin export superlite/);
});

test('js/ts 훅: 애드온 part 의 스크립트를 묶고, tsc 검사는 애드온 폴더의 원본을 본다', async () => {
  const { dir } = await installed(BASE);
  const r = await addPlugin(source({ name: 'hk', addon: { base: 'superlite', version: '*' }, parts: { hk: {} } }, {
    'hk/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'hooks/p.ts' }] }),
    'hk/hooks/p.ts': `import { slcode } from 'slcode/api';\nslcode.on('UserPromptSubmit', (hook) => { hook.context('from addon'); });\nslcode.run();`,
  }), dir);
  const rep = listPlugins(dir)[0].reports.claude!;
  assert.deepEqual(rep.scripts!.built, ['hk/hooks/p.ts']);
  assert.deepEqual(rep.scripts!.failed, []);
  assert.equal(rep.name, 'superlite');
  const warns = await scriptWarnings('superlite', r.build!, dir);
  assert.ok(!warns.some((w) => /Cannot find|ENOENT|not found/i.test(w)), warns.join('\n'));
});

test('옛 사본과 공존: 애드온은 plugins 칸에 없다. 옛 사본이 베이스를 지우면 고아로 남아 목록에 보이고, 베이스를 다시 add 하면 돌아온다', async () => {
  const { dir, ap } = await installed(BASE, ORCH);
  const c = readConfig(ap);
  assert.deepEqual(Object.keys(c.plugins), ['superlite'], '옛 사본은 plugins 만 돈다');
  assert.equal(c.format, 1, 'STATE_FORMAT 그대로');
  assert.ok(fs.existsSync(path.join(ap.installed, 'superlite')));
  assert.ok(!fs.existsSync(path.join(ap.installed, 'orchestration')), '옛 사본이 읽는 installed 에 두지 않는다');
  // 옛 사본의 remove 흉내 — plugins 항목과 installed 만 지운다
  delete c.plugins.superlite; writeConfig(ap, c); fs.rmSync(path.join(ap.installed, 'superlite'), { recursive: true });
  assert.deepEqual(orphanAddons(dir), [{ name: 'orchestration', version: '0.5.0', base: 'superlite' }]);
  assert.deepEqual(listPlugins(dir), []);
  assert.deepEqual(loadSessionPlugins(tmp('s'), {}, {}, dir).loaded, []);
  await addPlugin(source(BASE), dir);
  assert.deepEqual(listPlugins(dir)[0].addons.map((a) => a.on), [true]);
  assert.deepEqual(orphanAddons(dir), []);
  assert.deepEqual((await removePlugin('orchestration', dir)).removed, true);
});
