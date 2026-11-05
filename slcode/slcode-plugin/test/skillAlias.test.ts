// skill 별칭 (ticket slcode-plugin-skill-alias, 사용자 결정 2026-11-05) — 원본 SKILL.md 의 aliases 로 선언하고 빌드 결과에만 사본을 만든다. 항상 모델에게서 숨긴다. 겹치면 add 가 거부한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addPlugin, agentPaths, readConfig, setPlugin } from '../src/agentPlugins.ts';
import { exportBuild, exportLink } from '../src/agentExport.ts';
import { parseAliases } from '../src/agentFormat.ts';
import { aliasSkillText, buildClaude } from '../src/agentBuild.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-alias-${p}-`));
function source(files: Record<string, string>, parts: Record<string, unknown> = { main: {} }, name = 'probe', manifest = 'slcode-plugin.json', extra: Record<string, unknown> = {}) {
  const src = tmp(name);
  for (const [rel, body] of Object.entries({ [manifest]: JSON.stringify({ name, version: '1.0.0', parts, ...extra }), ...files })) {
    const f = path.join(src, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return src;
}
const BRIEF = '---\nname: brief\ndescription: 짧게 요약한다\naliases: [b, br]\n---\n# 요약\n본문 ${CLAUDE_PLUGIN_ROOT}\n';
const built = (dir: string, h: 'claude' | 'codex', name = 'probe') => path.join(agentPaths(dir).build, readConfig(agentPaths(dir)).plugins[name].builds[h]!, h);
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');

test('aliases 는 흐름 목록·값 하나·블록 목록을 읽는다', () => {
  const head = (s: string) => `---\nname: x\n${s}\ndescription: y\n---\nz`;
  assert.deepEqual(parseAliases(head('aliases: [b, "ut", \'c\']')), ['b', 'ut', 'c']);
  assert.deepEqual(parseAliases(head('aliases: b')), ['b']);
  assert.deepEqual(parseAliases(head('aliases:\n  - b\n  - ut')), ['b', 'ut']);
  assert.deepEqual(parseAliases(head('aliases:\n- b')), ['b']);
  assert.deepEqual(parseAliases(head('aliases: []')), []);
  assert.deepEqual(parseAliases('본문의\naliases: [b]\n'), []);
  assert.deepEqual(parseAliases(head('other: 1')), []);
});

test('별칭의 SKILL.md: name·[원본] 설명·숨김을 넣고 aliases 를 뺀다. 다른 칸과 본문은 그대로', () => {
  assert.equal(aliasSkillText(BRIEF.replace('aliases:', 'argument-hint: <글>\naliases:'), 'b', 'brief'), '---\nname: b\ndescription: "[brief] 짧게 요약한다"\ndisable-model-invocation: true\nargument-hint: <글>\n---\n# 요약\n본문 ${CLAUDE_PLUGIN_ROOT}\n');
  assert.equal(aliasSkillText('---\ndescription: |\n  둘째\n  줄\naliases:\n  - b\nmodel: haiku\ndisable-model-invocation: false\n---\n본문', 'b', 'x'), '---\nname: b\ndescription: "[x] 둘째\\n줄"\ndisable-model-invocation: true\nmodel: haiku\n---\n본문');
  assert.match(aliasSkillText('---\naliases: [b]\n---\n# 제목\n본문', 'b', 'x'), /description: "\[x\] 제목"/, '설명이 없으면 Codex 빌드처럼 본문 첫 줄');
});

test('Claude·Codex 빌드: 별칭 폴더에 보조 파일까지 사본을 만들고 원본 재빌드가 바로 반영된다. 호환 등급은 그대로다', async () => {
  const dir = tmp('state');
  const files = { 'main/skills/brief/SKILL.md': BRIEF, 'main/skills/brief/scripts/run.sh': '#!/bin/sh\n' };
  const src = source(files);
  fs.chmodSync(path.join(src, 'main/skills/brief/scripts/run.sh'), 0o755);
  const r = await addPlugin(src, dir);
  assert.equal(r.grade, 'full', 'aliases 는 빠지는 것이 아니다');
  const c = built(dir, 'claude');
  assert.match(read(c, 'probe/skills/b/SKILL.md'), /^---\nname: b\ndescription: "\[brief\] 짧게 요약한다"\ndisable-model-invocation: true\n/);
  assert.match(read(c, 'probe/skills/br/SKILL.md'), /^---\nname: br\n/);
  assert.ok(fs.statSync(path.join(c, 'probe/skills/b/scripts/run.sh')).mode & 0o100, '실행 비트');
  assert.doesNotMatch(read(c, 'probe/skills/brief/SKILL.md'), /disable-model-invocation/, '원본은 모델에게 보인다');
  const x = built(dir, 'codex');
  assert.match(read(x, 'skills/b/SKILL.md'), /^---\nname: "b"\ndescription: "\[brief\] 짧게 요약한다"\n---\n/);
  assert.equal(read(x, 'skills/b/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  assert.ok(fs.existsSync(path.join(x, 'skills/b/scripts/run.sh')));
  assert.ok(!fs.existsSync(path.join(x, 'skills/brief/agents/openai.yaml')), '원본은 숨기지 않는다');
  assert.ok(read(x, 'skills/b/SKILL.md').includes(path.join(x)), 'Codex 경로 변수도 바꾼다');

  fs.writeFileSync(path.join(src, 'main/skills/brief/SKILL.md'), BRIEF.replace('본문', '고친 본문'));
  await addPlugin(src, dir);
  assert.match(read(built(dir, 'claude'), 'probe/skills/b/SKILL.md'), /고친 본문/);
  assert.match(read(built(dir, 'codex'), 'skills/b/SKILL.md'), /고친 본문/);
});

test('원본의 agents/openai.yaml 이 있어도 Codex 별칭은 숨긴다', async () => {
  const dir = tmp('state');
  await addPlugin(source({ 'main/skills/brief/SKILL.md': BRIEF, 'main/skills/brief/agents/openai.yaml': 'interface:\n  display_name: x\n' }), dir);
  assert.equal(read(built(dir, 'codex'), 'skills/b/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  assert.match(read(built(dir, 'codex'), 'skills/brief/agents/openai.yaml'), /display_name/);
});

test('part: 끄면 별칭도 빠지고, 뒤 part 가 원본을 덮으면 뒤의 것의 별칭과 내용을 쓴다', async () => {
  const dir = tmp('state');
  await addPlugin(source({ 'main/skills/keep/SKILL.md': '---\ndescription: k\n---\nk', 'extra/skills/brief/SKILL.md': BRIEF }, { main: {}, extra: {} }), dir);
  assert.ok(fs.existsSync(path.join(built(dir, 'claude'), 'probe/skills/b/SKILL.md')));
  await setPlugin('probe', ['extra=off'], dir);
  assert.ok(!fs.existsSync(path.join(built(dir, 'claude'), 'probe/skills/b')), 'Claude');
  assert.ok(!fs.existsSync(path.join(built(dir, 'codex'), 'skills/b')), 'Codex');

  const dir2 = tmp('state');
  await addPlugin(source({ 'a/skills/brief/SKILL.md': BRIEF, 'z/skills/brief/SKILL.md': BRIEF.replace('본문', '뒤 본문') }, { a: {}, z: {} }), dir2);
  assert.match(read(built(dir2, 'claude'), 'probe/skills/b/SKILL.md'), /뒤 본문/, '같은 폴더를 덮는 같은 별칭은 겹침이 아니다');
  assert.match(read(built(dir2, 'codex'), 'skills/b/SKILL.md'), /뒤 본문/);
});

test('raw/claude 의 skill 별칭은 Claude 빌드에만 생긴다', async () => {
  const dir = tmp('state');
  await addPlugin(source({ 'main/raw/claude/skills/brief/SKILL.md': BRIEF }), dir);
  assert.ok(fs.existsSync(path.join(built(dir, 'claude'), 'probe/skills/b/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(built(dir, 'codex'), 'skills/b')));
});

test('export 판도 같은 규칙이다 — Claude 는 숨김 표시, Codex 는 openai.yaml 과 export 링크 경로', async () => {
  const dir = tmp('state');
  await addPlugin(source({ 'main/skills/brief/SKILL.md': BRIEF }), dir);
  const ap = agentPaths(dir), e = readConfig(ap).plugins.probe;
  const c = exportBuild(ap, 'probe', e, 'claude', {});
  assert.match(read(c.plugin, 'skills/b/SKILL.md'), /name: b\n.*\ndisable-model-invocation: true/);
  assert.deepEqual(c.report.excluded, []);
  const x = exportBuild(ap, 'probe', e, 'codex', {});
  assert.match(read(x.plugin, 'skills/b/SKILL.md'), /^---\nname: "b"/);
  assert.equal(read(x.plugin, 'skills/b/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  assert.ok(read(x.plugin, 'skills/b/SKILL.md').includes(exportLink(ap, 'codex', 'probe')));
  assert.deepEqual(x.report.excluded, []);
});

test('add 거부: 자기 자신·skill·다른 별칭·명령·내장 명령·이름 규칙·연쇄. 켜지 않은 part 도 본다', async () => {
  const bad = async (files: Record<string, string>, re: RegExp, parts?: Record<string, unknown>) => {
    const dir = tmp('state');
    await assert.rejects(addPlugin(source(files, parts), dir), re);
    assert.equal(readConfig(agentPaths(dir)).plugins.probe, undefined, '설치하지 않는다');
  };
  const skill = (aliases: string, name = '') => `---\n${name ? `name: ${name}\n` : ''}description: x\naliases: ${aliases}\n---\nx`;
  await bad({ 'main/skills/brief/SKILL.md': skill('[brief]') }, /alias brief refers to the skill itself/);
  await bad({ 'main/skills/brief/SKILL.md': skill('[other]'), 'main/skills/other/SKILL.md': '---\ndescription: y\n---\ny' }, /alias other has the same name as skill other \(part main\)/);
  await bad({ 'main/skills/brief/SKILL.md': skill('[named]'), 'main/skills/x/SKILL.md': '---\nname: named\n---\ny' }, /same name as skill named/, );
  await bad({ 'main/skills/a/SKILL.md': skill('[b]'), 'main/skills/c/SKILL.md': skill('[b]') }, /alias b is also an alias of skill a/);
  await bad({ 'main/skills/a/SKILL.md': skill('[b]'), 'main/skills/b/SKILL.md': skill('[c]') }, /alias b has the same name as skill b/, ); // 연쇄 a → b → c
  await bad({ 'main/skills/a/SKILL.md': skill('[rl]'), 'main/commands/rl/COMMAND.ts': `import { slcode } from 'slcode/api'; slcode.command({ description: 'x', run() {} });` }, /command rl has the same name as skill rl/);
  await bad({ 'main/skills/a/SKILL.md': skill('[init]') }, /alias init has the same name as the Claude built-in command \/init/);
  await bad({ 'main/skills/a/SKILL.md': skill('[reset]') }, /built-in command \/reset/);
  await bad({ 'main/skills/a/SKILL.md': skill('[Bad_Name]') }, /alias Bad_Name must match/);
  await bad({ 'main/skills/a/SKILL.md': skill('[../evil]') }, /alias \.\.\/evil must match/);
  await bad({ 'main/skills/a/SKILL.md': skill('b, c') }, /must match/, );
  await bad({ 'main/skills/a/SKILL.md': skill('[b]'), 'off/skills/b/SKILL.md': '---\ndescription: y\n---\ny' }, /same name as skill b \(part off\)/, { main: {}, off: { default: false } });
});

test('add 검사를 거치지 않은 옛 사본의 원본: 빌드는 위험한 이름·겹친 경로를 만들지 않고 report 에 남긴다', () => {
  const src = source({ 'main/skills/a/SKILL.md': '---\naliases: [../../evil, keep, ok]\n---\na', 'main/skills/keep/SKILL.md': '---\ndescription: 진짜\n---\n진짜' });
  const out = tmp('out');
  const m = { name: 'probe', version: '1.0.0', options: {}, parts: { main: { required: false, default: true } }, env: {} };
  const report = buildClaude(src, m, { parts: { main: true }, options: {} }, 'id', out);
  assert.deepEqual(report.dropped, ['skills/a: alias ../../evil (bad name)', 'skills/a: alias keep (name is taken)']);
  assert.match(read(out, 'claude/probe/skills/keep/SKILL.md'), /진짜/, '진짜 skill 을 덮지 않는다');
  assert.ok(fs.existsSync(path.join(out, 'claude/probe/skills/ok/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(out, 'claude/evil')));
});

test('애드온: 별칭이 베이스의 skill·별칭과 겹치면 거부하고, 합치면 베이스 이름 아래에 들어간다', async () => {
  const dir = tmp('state');
  await addPlugin(source({ 'main/skills/brief/SKILL.md': BRIEF }, { main: {} }, 'base'), dir);
  const addon = (skill: string) => source({ 'more/skills/extra/SKILL.md': skill }, { more: {} }, 'plus', 'slcode-addon.json', { addon: { base: 'base', version: '*' } });
  await assert.rejects(addPlugin(addon('---\naliases: [brief]\n---\nx'), dir), /skill brief has the same name as skill brief of base/);
  await assert.rejects(addPlugin(addon('---\naliases: [b]\n---\nx'), dir), /skill b has the same name as skill b of base/);
  await addPlugin(addon('---\ndescription: x\naliases: [ex]\n---\nx'), dir);
  assert.match(read(built(dir, 'claude', 'base'), 'base/skills/ex/SKILL.md'), /name: ex/);
});
