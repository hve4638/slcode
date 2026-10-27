// 에이전트 플러그인 (agentFormat·agentBuild·agentPlugins, ticket slcode-agent-plugin) — 원본 형식, 설치 멱등, 호환 등급, 설정 층, Claude 빌드, 세션 링크·다시 싣기, 정리.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseManifest, resolveValues, valuesString, type Manifest } from '../src/agentFormat.ts';
import { addPlugin, agentPaths, currentBuilds, gcBuilds, listPlugins, loadSessionPlugins, readConfig, reloadSessionPlugins, removePlugin, setPlugin } from '../src/agentPlugins.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-ap-${p}-`));
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}
const MANIFEST = { name: 'core', version: '0.1.0', options: { proactive: { type: 'boolean', default: false, label: '적극적인 개입' } }, parts: { base: { required: true }, useterminal: {}, ponytail: { default: false } }, env: { CORE_X: '1' } };
/** 여러 part·필수 part·옵션·지시문(if)·skill·MCP·bin·훅·raw 를 가진 원본 */
function source(manifest: object = MANIFEST, extra: Record<string, string> = {}): string {
  const src = tmp('src');
  write(src, {
    'slcode-plugin.json': JSON.stringify(manifest),
    'base/skills/hello/SKILL.md': '---\ndescription: say hello\n---\nHello from ${CLAUDE_PLUGIN_ROOT}',
    'base/.mcp.json': JSON.stringify({ mcpServers: { echo: { command: 'base-echo' }, shared: { command: 'base' } } }),
    'base/bin/core-hi': '#!/bin/sh\necho hi\n',
    'base/hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo base' }] }] } }),
    'base/instructions/base.md': 'Base rule. root=${CLAUDE_PLUGIN_ROOT}',
    'base/scripts/run.sh': 'echo base',
    'base/notes.txt': 'unknown file',
    'useterminal/instructions/hint.md': '---\nif: "!proactive"\n---\nHint only.',
    'useterminal/instructions/proactive.md': '---\nif: proactive\n---\nBe proactive.',
    'useterminal/.mcp.json': JSON.stringify({ shared: { command: 'useterminal' } }),
    'useterminal/hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo ut' }] }], Notification: [] } }),
    'useterminal/scripts/run.sh': 'echo useterminal',
    'ponytail/skills/ponytail/SKILL.md': '---\nname: ponytail\nmodel: haiku\n---\nPonytail.',
    ...extra,
  });
  fs.chmodSync(path.join(src, 'base/bin/core-hi'), 0o755);
  return src;
}

test('manifest: 이름·part·옵션 꼴을 본다 — part 와 옵션 이름이 겹치면 오류, default 없는 part 는 켜짐, 필수 part 는 늘 켜짐', () => {
  assert.throws(() => parseManifest('{ broken'), /not JSON/);
  assert.throws(() => parseManifest('{"version":"1"}'), /name/);
  assert.throws(() => parseManifest(JSON.stringify({ name: 'x', parts: { a: {} }, options: { a: { type: 'boolean' } } })), /both a part and an option/);
  assert.throws(() => parseManifest(JSON.stringify({ name: 'x', options: { a: { type: 'boolean', default: 'yes' } } })), /default must be a boolean/);
  assert.throws(() => parseManifest(JSON.stringify({ name: '../x' })), /name/);
  const m = parseManifest(JSON.stringify(MANIFEST));
  assert.deepEqual(m.parts, { base: { required: true, default: true }, useterminal: { required: false, default: true }, ponytail: { required: false, default: false } });
  assert.equal(m.options.proactive.default, false);
});

test('설정 값: 기본값 < 기본 설정 < 프로필 < 세션 — 뒤가 이기고, 모르는 키·꼴이 틀린 값·필수 part 끄기는 건너뛴다. 설정 문자열은 키 순서', () => {
  const m = parseManifest(JSON.stringify(MANIFEST)) as Manifest;
  const r = resolveValues(m, [{ parts: { ponytail: true, base: false, gone: true } }, { options: { proactive: 'yes' as unknown as boolean } }, { parts: { useterminal: false }, options: { proactive: true } }]);
  assert.deepEqual(r, { parts: { base: true, useterminal: false, ponytail: true }, options: { proactive: true } });
  assert.equal(valuesString(r), 'opt.proactive=true,part.base=1,part.ponytail=1,part.useterminal=0');
});

test('add: 원본을 복사하고 기본 설정으로 빌드한다. 같은 내용이면 아무것도 하지 않는다(멱등). 새 판이면 맞는 설정만 남긴다. manifest 가 없으면 거부', async () => {
  const dir = tmp('state'), src = source();
  const ap = agentPaths(dir);
  await assert.rejects(addPlugin(tmp('empty'), dir), /no slcode-plugin.json/);
  const a = await addPlugin(src, dir);
  assert.equal(a.changed, true);
  const snap = () => JSON.stringify({ c: readConfig(ap), b: fs.readdirSync(ap.build).sort(), i: fs.readdirSync(path.join(ap.installed, 'core')).sort() });
  const before = snap();
  const b = await addPlugin(src, dir);
  assert.equal(b.changed, false);
  assert.equal(b.build, a.build);
  assert.equal(snap(), before, '두 번째 add 는 상태를 바꾸지 않는다');
  await setPlugin('core', ['ponytail=on', 'proactive=true'], dir);
  // 새 판 — 옵션 proactive 가 사라졌다
  write(src, { 'slcode-plugin.json': JSON.stringify({ ...MANIFEST, version: '0.2.0', options: {} }) });
  const c = await addPlugin(src, dir);
  assert.equal(c.changed, true);
  assert.deepEqual(readConfig(ap).plugins.core.values, { parts: { ponytail: true }, options: {} });
  assert.ok(fs.existsSync(path.join(ap.installed, 'core/base/notes.txt')), 'part 폴더는 통째로 복사한다');
});

test('호환 등급: skill·MCP·지시문·bin·env 만이면 full, 훅·raw·Claude 전용 skill 필드가 있으면 partial 과 하네스별 빠지는 것', async () => {
  const dir = tmp('state');
  const full = tmp('full');
  write(full, { 'slcode-plugin.json': JSON.stringify({ name: 'lite', parts: { a: {} } }), 'a/skills/s/SKILL.md': '---\nname: s\ndescription: d\nwhen_to_use: w\n---\nbody', 'a/.mcp.json': '{"x":{"command":"y"}}', 'a/instructions/i.md': 'i', 'a/bin/t': 't' });
  assert.equal((await addPlugin(full, dir)).grade, 'full');
  const p = await addPlugin(source(MANIFEST, { 'base/raw/pi/extensions/x.ts': '', 'base/raw/claude/agents/a.md': 'agent' }), dir);
  assert.equal(p.grade, 'partial');
  assert.deepEqual(p.lost.claude, ['base/raw/pi']);
  assert.ok(p.lost.codex.includes('base/hooks/hooks.json') && p.lost.codex.includes('base/raw/claude') && p.lost.codex.includes('ponytail/skills/ponytail: model'));
  assert.ok(p.lost.gpt.includes('useterminal/hooks/hooks.json: Notification'), 'GPT 하네스가 받지 않는 훅 이벤트');
  assert.ok(!p.lost.gpt.includes('base/hooks/hooks.json'), 'GPT 하네스는 훅을 받는다');
  const rows = listPlugins(dir);
  assert.deepEqual(rows.map((r) => [r.name, r.grade]), [['lite', 'full'], ['core', 'partial']]);
});

test('Claude 빌드: 켠 part 를 parts 순서로 — 훅은 이벤트별로 잇고, MCP 는 서버별로 뒤가 이기고, 겹친 경로는 뒤의 것, 지시문은 if 로 고른다. raw/claude 는 겹치고 plugin.json 의 이름·판은 manifest', async () => {
  const dir = tmp('state');
  const src = source(MANIFEST, {
    'base/raw/claude/.claude-plugin/plugin.json': JSON.stringify({ name: 'other', version: '9', description: 'kept' }),
    'base/raw/claude/agents/helper.md': 'agent',
    'base/raw/claude/session.json': JSON.stringify({ outputStyle: 'x' }),
    'ponytail/.mcp.json': '{ broken',
  });
  const a = await addPlugin(src, dir);
  const ap = agentPaths(dir);
  let out = path.join(ap.build, a.build!), plugin = path.join(out, 'claude/core');
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(report.parts, ['base', 'useterminal'], 'ponytail 은 기본 꺼짐');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, 'hooks/hooks.json'), 'utf8')).hooks.SessionStart.map((h: any) => h.hooks[0].command), ['echo base', 'echo ut']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, '.mcp.json'), 'utf8')).mcpServers, { echo: { command: 'base-echo' }, shared: { command: 'useterminal' } });
  assert.ok(report.overridden.includes('.mcp.json shared (base → useterminal)') && report.overridden.includes('scripts/run.sh (base → useterminal)'));
  assert.equal(fs.readFileSync(path.join(plugin, 'scripts/run.sh'), 'utf8'), 'echo useterminal');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin/plugin.json'), 'utf8')), { name: 'core', version: '0.1.0', description: 'kept' });
  assert.ok(fs.existsSync(path.join(plugin, 'agents/helper.md')) && fs.existsSync(path.join(plugin, 'skills/hello/SKILL.md')));
  assert.ok(fs.statSync(path.join(plugin, 'bin/core-hi')).mode & 0o100, 'bin 의 실행 비트');
  assert.ok(!fs.existsSync(path.join(plugin, 'instructions')) && !fs.existsSync(path.join(plugin, 'raw')) && !fs.existsSync(path.join(plugin, 'session.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'session.json'), 'utf8')), { outputStyle: 'x' });
  assert.equal(fs.readFileSync(path.join(out, 'instructions.md'), 'utf8'), 'Base rule. root=${CLAUDE_PLUGIN_ROOT}\n\nHint only.');
  assert.deepEqual(report.instructions.skipped, ['useterminal/instructions/proactive.md: if: proactive']);
  // 옵션·part 를 바꾸면 새 식별자의 빌드 — 지시문과 깨진 파일 보고가 바뀐다
  const s = await setPlugin('core', ['proactive=true', 'ponytail=on', 'useterminal=off'], dir);
  assert.notEqual(s.build, a.build);
  out = path.join(ap.build, s.build);
  assert.equal(fs.readFileSync(path.join(out, 'instructions.md'), 'utf8'), 'Base rule. root=${CLAUDE_PLUGIN_ROOT}');
  const r2 = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(r2.dropped, ['ponytail/.mcp.json']);
  assert.ok(fs.existsSync(path.join(out, 'claude/core/skills/ponytail/SKILL.md')));
  await assert.rejects(setPlugin('core', ['base=off'], dir), /required/);
  await assert.rejects(setPlugin('core', ['proactive=maybe'], dir), /true\|false/);
  await assert.rejects(setPlugin('core', ['nope=on'], dir), /no part or option/);
  await assert.rejects(setPlugin('ghost', ['a=on'], dir), /no agent plugin ghost/);
});

test('세션에 싣기: 링크를 걸고 지시문(경로 변수는 링크·데이터 폴더로)·env·session.json 을 낸다. 세션 값이 기본 설정 위에 덮인다', async () => {
  const dir = tmp('state'), sdir = tmp('session');
  await addPlugin(source(MANIFEST, { 'base/raw/claude/session.json': '{"a":1}' }), dir);
  const env = { HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg' };
  const s = loadSessionPlugins(sdir, env, { core: { options: { proactive: true } } }, dir);
  const link = path.join(sdir, 'agent-plugins/core');
  assert.deepEqual(s.plugins, [{ type: 'local', path: link }]);
  assert.ok(fs.existsSync(path.join(link, 'skills/hello/SKILL.md')), '링크가 빌드를 가리킨다');
  assert.equal(s.append, `Base rule. root=${link}\n\nBe proactive.`);
  assert.deepEqual(s.env, { CORE_X: '1' });
  assert.deepEqual(s.settings, { a: 1 });
  assert.deepEqual(s.notes, []);
  // 깨진 설치는 빼고 사유만
  fs.rmSync(path.join(agentPaths(dir).installed, 'core/slcode-plugin.json'));
  const broken = loadSessionPlugins(tmp('session'), env, {}, dir);
  assert.deepEqual(broken.plugins, []);
  assert.match(broken.notes[0], /^core: no slcode-plugin.json/);
});

test('다시 싣기: 링크를 지금 설정의 빌드로 바꾸고, 지시문·env 가 바뀌었거나 새로 설치한 것은 새 세션부터로, 지운 것은 링크를 뗀다', async () => {
  const dir = tmp('state'), sdir = tmp('session');
  await addPlugin(source(), dir);
  const env = { HOME: '/h' };
  const s = loadSessionPlugins(sdir, env, {}, dir);
  const link = path.join(sdir, 'agent-plugins/core');
  assert.ok(!fs.existsSync(path.join(link, 'skills/ponytail')));
  assert.deepEqual(currentBuilds({}, dir), { core: s.loaded[0].build }, '그대로면 다시 실을 것이 없다');
  await setPlugin('core', ['ponytail=on'], dir);
  assert.notEqual(currentBuilds({}, dir).core, s.loaded[0].build);
  let r = reloadSessionPlugins(sdir, s.loaded, env, {}, dir);
  assert.ok(fs.existsSync(path.join(link, 'skills/ponytail/SKILL.md')), '링크가 새 빌드로');
  assert.deepEqual(r.later, [], 'part 만 바뀌었다');
  assert.equal(r.loaded[0].build, currentBuilds({}, dir).core);
  await setPlugin('core', ['proactive=true'], dir);
  const lite = tmp('lite');
  write(lite, { 'slcode-plugin.json': JSON.stringify({ name: 'lite', parts: { a: {} } }) });
  await addPlugin(lite, dir);
  r = reloadSessionPlugins(sdir, r.loaded, env, {}, dir);
  assert.deepEqual(r.later, [{ name: 'core', what: ['instructions'] }, { name: 'lite', what: ['installed'] }]);
  assert.equal(r.loaded[0].instructions, s.loaded[0].instructions, '실은 지시문은 그대로 기억한다');
  await removePlugin('core', dir);
  r = reloadSessionPlugins(sdir, r.loaded, env, {}, dir);
  assert.deepEqual(r.removed, ['core']);
  assert.ok(!fs.existsSync(link));
});

test('remove 는 흔적 없이(그 플러그인의 빌드는 유예 없이 지운다, 없어도 성공), 정리는 config·세션 링크가 가리키지 않는 빌드만 지운다', async () => {
  const dir = tmp('state'), sdir = path.join(dir, 'sessions', '-x', 'abcd1234');
  const ap = agentPaths(dir);
  await addPlugin(source(), dir);
  const s = loadSessionPlugins(sdir, {}, {}, dir);
  const first = s.loaded[0].build;
  const set = await setPlugin('core', ['ponytail=on'], dir);
  assert.deepEqual(gcBuilds(dir, 0), [], '세션이 쓰는 빌드와 마지막 빌드는 남는다');
  fs.rmSync(path.join(sdir, 'agent-plugins'), { recursive: true });
  assert.deepEqual(gcBuilds(dir, 0), [first]);
  assert.deepEqual(fs.readdirSync(ap.build), [set.build]);
  assert.deepEqual(await removePlugin('core', dir), { name: 'core', removed: true }); // 지운 플러그인의 빌드는 유예 없이
  assert.deepEqual(readConfig(ap).plugins, {});
  assert.deepEqual(fs.readdirSync(ap.installed), []);
  assert.deepEqual(fs.readdirSync(ap.build), []);
  assert.deepEqual(await removePlugin('core', dir), { name: 'core', removed: false });
});
