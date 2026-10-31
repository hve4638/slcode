// 에이전트 플러그인 export (agentExport, ticket slcode-agent-plugin-export) — 하네스 CLI 는 가짜(부른 인자만 적는다). 실제 claude·codex 등록은 격리 HOME 데모에서 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addPlugin, agentPaths, exportPlugin, gcBuilds, listPlugins, readConfig, removePlugin, setPlugin } from 'slcode-plugin/agentPlugins';
import { pluginMethod } from '../src/serve.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-ax-${p}-`));
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

function source(): string {
  const src = tmp('src');
  write(src, {
    'slcode-plugin.json': JSON.stringify({ name: 'core', version: '0.1.0', options: { proactive: { type: 'boolean', default: false } }, parts: { base: { required: true }, extra: {} }, env: { CORE_X: '1' } }),
    'base/skills/hello/SKILL.md': '---\ndescription: say hello\ndisable-model-invocation: true\n---\nHello from ${CLAUDE_PLUGIN_ROOT}',
    'base/.mcp.json': JSON.stringify({ mcpServers: { echo: { command: '${CLAUDE_PLUGIN_ROOT}/bin/core-hi', args: ['${CLAUDE_PLUGIN_DATA}'] } } }),
    'base/bin/core-hi': '#!/bin/sh\necho hi\n',
    'base/instructions/base.md': 'Base rule. root=${CLAUDE_PLUGIN_ROOT} data=${CLAUDE_PLUGIN_DATA}',
    'base/hooks/hooks.json': JSON.stringify({ hooks: [
      { type: 'command', event: 'SessionStart', command: 'echo guide', compat: 'claude' },
      { type: 'command', event: 'PreToolUse', command: '[ "${slcode.vars.harness}" = claude ] || exit 0; echo status ${slcode.vars.harness}', compat: 'claude', timeout: 5 },
      { type: 'command', event: 'Notification', command: 'echo n', compat: 'claude' },
      { type: 'command', event: 'SessionEnd', command: 'echo bye', compat: 'claude', timeout: 5 },
      { type: 'script', file: 'hooks/guard.ts' },
    ] }),
    'base/hooks/guard.ts': "import { slcode } from 'slcode/api'; slcode.on('PreToolUse', { matcher: 'Read|Bash' }, (h) => h.block('no')); slcode.run();\n",
    'extra/instructions/extra.md': '---\nif: proactive\n---\nBe proactive.',
  });
  fs.chmodSync(path.join(src, 'base/bin/core-hi'), 0o755);
  return src;
}

/** 가짜 claude·codex — 부른 인자를 log 에 한 줄씩. FAKE_FAIL=<하네스> 면 그 하네스는 실패 */
function fakeEnv() {
  const bin = tmp('bin'), log = path.join(bin, 'calls.log'), home = tmp('home');
  for (const h of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, h), `#!/bin/sh\necho "${h} $*" >> ${log}\n[ "$FAKE_FAIL" = ${h} ] && { echo "boom" >&2; exit 1; }\nexit 0\n`);
    fs.chmodSync(path.join(bin, h), 0o755);
  }
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude') } as NodeJS.ProcessEnv;
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const clear = () => fs.rmSync(log, { force: true });
  return { env, calls, clear };
}

test('Claude export: 디렉터리 마켓플레이스 slcode 에 링크로 등록 — 지시문은 SessionStart 훅의 additionalContext(맨 앞), ${slcode.vars.harness} 는 claude, js/ts 훅은 slcode-hooks/ 와 command 로, 옮길 수 없는 것은 excluded', async () => {
  const dir = tmp('state'), f = fakeEnv();
  await addPlugin(source(), dir, f.env);
  const [r] = await exportPlugin('core', ['claude'], false, dir, f.env);
  const ap = agentPaths(dir);
  const link = path.join(ap.export, 'claude', 'core');
  assert.equal(r.link, link);
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(ap.build, r.build!, 'export', 'claude', 'core')));
  assert.deepEqual(read(path.join(ap.export, 'claude/.claude-plugin/marketplace.json')).plugins, [{ name: 'core', source: './core' }]);
  assert.deepEqual(f.calls(), [`claude plugin marketplace add ${path.join(ap.export, 'claude')}`, 'claude plugin install core@slcode']);
  const hooks = read(path.join(link, 'hooks/hooks.json')).hooks;
  assert.equal(hooks.SessionStart[0].hooks[0].command, 'cat "${CLAUDE_PLUGIN_ROOT}/hooks/slcode-instructions.json"');
  assert.equal(hooks.SessionStart[0].hooks[0].additionalContextLimit, undefined);
  assert.equal(hooks.SessionStart[1].hooks[0].command, 'echo guide');
  assert.equal(hooks.PreToolUse[0].hooks[0].command, '[ "claude" = claude ] || exit 0; echo status claude');
  assert.equal(hooks.SessionEnd[0].hooks[0].timeout, 5);
  const ctx = read(path.join(link, 'hooks/slcode-instructions.json')).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'SessionStart');
  assert.equal(ctx.additionalContext, `Base rule. root=${link} data=${path.join(f.env.CLAUDE_CONFIG_DIR!, 'plugins/data/core-slcode')}`);
  // js/ts 훅 (slcode-agent-plugin-script-portable) — 묶은 스크립트를 slcode-hooks/ 에, 그것을 돌리는 command 를 이벤트 끝에(SessionEnd 는 늘)
  assert.deepEqual(read(path.join(link, 'slcode-hooks/scripts.json')).map((s: any) => s.src), ['base/hooks/guard.ts']);
  assert.ok(fs.existsSync(path.join(link, 'slcode-hooks/scripts/0.mjs')));
  const pre = hooks.PreToolUse.at(-1);
  assert.equal(pre.matcher, 'Read|Bash');
  assert.match(pre.hooks[0].command, / claude "\$\{CLAUDE_PLUGIN_ROOT\}" PreToolUse$/);
  assert.match(hooks.SessionEnd.at(-1).hooks[0].command, / claude "\$\{CLAUDE_PLUGIN_ROOT\}" SessionEnd$/);
  assert.ok(!r.excluded.some((x) => /js\/ts/.test(x)), r.excluded.join('\n'));
  assert.ok(r.excluded.some((x) => x.startsWith('env: CORE_X')));
  // 세션 빌드는 지시문 훅이 없다 — 세션은 systemPrompt 로 넘긴다
  assert.equal(read(path.join(ap.build, r.build!, 'claude/core/hooks/hooks.json')).hooks.SessionStart.length, 1);
  assert.deepEqual(listPlugins(dir)[0].exports, ['claude']);
});

test('Codex export (restricted): 경로 변수는 export 링크·data 로, MCP 는 plugin_<p>_<s>, 훅은 Codex 가 받는 이벤트의 command 와 js/ts(harness=codex), 지시문 훅은 한도 없이 — bin·env·없는 이벤트·Codex 차이는 excluded', async () => {
  const dir = tmp('state'), f = fakeEnv();
  await addPlugin(source(), dir, f.env);
  const [r] = await exportPlugin('core', ['codex'], false, dir, f.env);
  const ap = agentPaths(dir);
  const link = path.join(ap.export, 'codex', 'core');
  assert.deepEqual(f.calls(), [`codex plugin marketplace add ${path.join(ap.export, 'codex')}`, 'codex plugin add core@slcode']);
  assert.deepEqual(read(path.join(ap.export, 'codex/.agents/plugins/marketplace.json')), { name: 'slcode', plugins: [{ name: 'core', source: { source: 'local', path: './core' } }] });
  assert.equal(read(path.join(link, '.codex-plugin/plugin.json')).name, 'core');
  assert.match(fs.readFileSync(path.join(link, 'skills/hello/SKILL.md'), 'utf8'), new RegExp(`Hello from ${link}`));
  assert.match(fs.readFileSync(path.join(link, 'skills/hello/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  assert.deepEqual(read(path.join(link, '.mcp.json')).mcpServers, { plugin_core_echo: { command: `${link}/bin/core-hi`, args: [path.join(ap.data, 'core')] } });
  const hooks = read(path.join(link, 'hooks/hooks.json')).hooks;
  assert.deepEqual(hooks.SessionStart[0].hooks[0], { type: 'command', command: 'cat "${CLAUDE_PLUGIN_ROOT}/hooks/slcode-instructions.json"', timeout: 5, additionalContextLimit: 0 });
  assert.equal(hooks.PreToolUse[0].hooks[0].command, '[ "codex" = claude ] || exit 0; echo status codex');
  assert.equal(hooks.Notification, undefined);
  assert.equal(hooks.SessionEnd[0].hooks[0].timeout, 3, 'Codex 는 SessionEnd timeout 을 3초로 줄이며 경고한다');
  assert.match(read(path.join(link, 'hooks/slcode-instructions.json')).hookSpecificOutput.additionalContext, new RegExp(`root=${link} data=${path.join(ap.data, 'core')}`));
  // js/ts 훅 — Claude 빌드의 묶은 스크립트, 명령의 플러그인 폴더는 export 링크, SessionEnd 는 3초, Codex 차이는 excluded 에
  assert.deepEqual(read(path.join(link, 'slcode-hooks/scripts.json')).map((s: any) => s.src), ['base/hooks/guard.ts']);
  assert.ok(hooks.PreToolUse.at(-1).hooks[0].command.endsWith(` codex "${link}" PreToolUse`), hooks.PreToolUse.at(-1).hooks[0].command);
  assert.deepEqual(hooks.SessionEnd.at(-1).hooks[0].timeout, 3);
  assert.ok(!r.excluded.some((x) => /: js\/ts hook /.test(x)), 'js/ts 훅은 싣는다');
  for (const want of [/Notification/, /guard\.ts: PreToolUse Read\|Bash — Codex 에는 Read 도구가 없습니다/, /^bin\//, /^env: CORE_X/]) assert.ok(r.excluded.some((x) => want.test(x)), `${want}\n${r.excluded.join('\n')}`);
  assert.ok(!r.excluded.some((x) => x.endsWith('/hooks/hooks.json')), 'command 훅은 싣는다');
});

test('리빌드(set·새 판) 때 export 링크를 새 빌드로 — Claude 는 CLI 를 부르지 않고, Codex 는 plugin add 로 복사본을 다시 쓴다. 정리는 export 빌드를 남긴다', async () => {
  const dir = tmp('state'), f = fakeEnv();
  await addPlugin(source(), dir, f.env);
  const first = await exportPlugin('core', ['claude', 'codex'], false, dir, f.env);
  f.clear();
  const s = await setPlugin('core', ['proactive=true'], dir, f.env);
  assert.deepEqual(f.calls(), ['codex plugin add core@slcode']);
  const ap = agentPaths(dir);
  const after = Object.fromEntries(s.exports!.map((x) => [x.harness, x]));
  assert.notEqual(after.claude.build, first[0].build);
  assert.match(read(path.join(ap.export, 'claude/core/hooks/slcode-instructions.json')).hookSpecificOutput.additionalContext, /Be proactive\./);
  assert.match(read(path.join(ap.export, 'codex/core/hooks/slcode-instructions.json')).hookSpecificOutput.additionalContext, /Be proactive\./);
  // 링크가 가리키는 빌드는 유예 없이 정리해도 남는다
  gcBuilds(dir, 0);
  assert.ok(fs.existsSync(path.join(ap.export, 'claude/core/hooks/hooks.json')));
  assert.ok(fs.existsSync(path.join(ap.export, 'codex/core/.codex-plugin/plugin.json')));
  // 새 판 add 도 같다 — export 목록은 이어진다
  const src2 = source();
  write(src2, { 'slcode-plugin.json': JSON.stringify({ name: 'core', version: '0.2.0', parts: { base: { required: true } } }) });
  f.clear();
  const a = await addPlugin(src2, dir, f.env);
  assert.deepEqual(a.exports!.map((x) => x.harness), ['claude', 'codex']);
  assert.equal(read(path.join(ap.export, 'codex/core/.codex-plugin/plugin.json')).version, '0.2.0');
  assert.deepEqual(f.calls(), ['codex plugin add core@slcode']);
});

test('해제: --remove 는 하네스에서 지우고 링크를 뗀다(마지막이면 마켓플레이스도), remove 는 export 도 해제한다', async () => {
  const dir = tmp('state'), f = fakeEnv();
  const ap = agentPaths(dir);
  await addPlugin(source(), dir, f.env);
  const src2 = source();
  write(src2, { 'slcode-plugin.json': JSON.stringify({ name: 'other', parts: { base: { required: true } } }) });
  await addPlugin(src2, dir, f.env);
  await exportPlugin('core', ['claude'], false, dir, f.env);
  await exportPlugin('other', ['claude'], false, dir, f.env);
  assert.deepEqual(read(path.join(ap.export, 'claude/.claude-plugin/marketplace.json')).plugins.map((p: { name: string }) => p.name), ['core', 'other']);
  f.clear();
  const [r] = await exportPlugin('core', ['claude'], true, dir, f.env);
  assert.equal(r.removed, true);
  assert.deepEqual(f.calls(), ['claude plugin uninstall core@slcode']);
  assert.ok(!fs.existsSync(path.join(ap.export, 'claude/core')));
  assert.deepEqual(read(path.join(ap.export, 'claude/.claude-plugin/marketplace.json')).plugins.map((p: { name: string }) => p.name), ['other']);
  assert.equal(readConfig(ap).plugins.core.exports, undefined);
  // 하지 않은 export 의 해제는 아무것도 하지 않는다
  f.clear();
  assert.equal((await exportPlugin('core', ['codex'], true, dir, f.env))[0].removed, false);
  assert.deepEqual(f.calls(), []);
  // remove 는 export 까지 — 마지막이면 마켓플레이스도 지운다
  const rm = await removePlugin('other', dir, f.env);
  assert.deepEqual(rm.exports!.map((x) => x.harness), ['claude']);
  assert.deepEqual(f.calls(), ['claude plugin uninstall other@slcode', 'claude plugin marketplace remove slcode']);
  assert.ok(!fs.existsSync(path.join(ap.export, 'claude')));
});

test('등록 실패 — 링크·마켓플레이스를 되돌리고 config 에 적지 않는다. 대상 하네스 이름이 틀리면 거부', async () => {
  const dir = tmp('state'), f = fakeEnv();
  const ap = agentPaths(dir);
  await addPlugin(source(), dir, f.env);
  await assert.rejects(exportPlugin('core', ['codex'], false, dir, { ...f.env, FAKE_FAIL: 'codex' }), /codex plugin marketplace add .*boom/);
  assert.ok(!fs.existsSync(path.join(ap.export, 'codex/core')));
  assert.deepEqual(read(path.join(ap.export, 'codex/.agents/plugins/marketplace.json')).plugins, []);
  assert.equal(readConfig(ap).plugins.core.exports, undefined);
  await assert.rejects(exportPlugin('core', ['pi'], false, dir, f.env), /export target must be claude or codex/);
  await assert.rejects(exportPlugin('nope', ['claude'], false, dir, f.env), /no agent plugin nope/);
});

test('관리 화면 요청 (ticket slcode-agent-plugin-ui): list 는 export 판 보고(exported)까지, set·export 는 slcode plugin 을 자식으로 — 여럿을 한 번에 바꾸고, 실패는 CLI 의 오류 문구', async () => {
  const dir = tmp('state'), f = fakeEnv();
  await addPlugin(source(), dir, f.env);
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  Object.assign(process.env, { PATH: f.env.PATH, HOME: f.env.HOME, CLAUDE_CONFIG_DIR: f.env.CLAUDE_CONFIG_DIR }); // 자식 CLI 는 serve 의 env 를 받는다
  try {
    const ex = (await pluginMethod(dir, 'plugins.export', { name: 'core', to: 'codex' })) as { results: { harness: string; build: string }[] };
    assert.equal(ex.results[0].harness, 'codex');
    let row = ((await pluginMethod(dir, 'plugins.list', {})) as { plugins: ReturnType<typeof listPlugins> }).plugins[0];
    assert.deepEqual(row.exports, ['codex']);
    assert.ok(row.exported.codex?.excluded.some((x) => x.startsWith('bin/')));
    const r = (await pluginMethod(dir, 'plugins.set', { name: 'core', set: ['extra=off', 'proactive=true'] })) as { values: string; build: string; exports: { build: string }[]; warnings: string[] };
    assert.match(r.values, /opt\.proactive=true.*part\.extra=0/);
    assert.equal(r.exports[0].build, listPlugins(dir)[0].reports.codex?.build); // export 판도 새 빌드로
    assert.deepEqual(r.warnings, []); // 이 훅은 경고가 없다 — 있으면 stderr 의 줄이 여기로
    await assert.rejects(pluginMethod(dir, 'plugins.set', { name: 'core', set: ['base=off'] }), /part base is required/);
    await assert.rejects(pluginMethod(dir, 'plugins.set', { name: 'core', set: [] }), /plugins.set \{name, set/);
    assert.deepEqual(((await pluginMethod(dir, 'plugins.export', { name: 'core', to: 'codex', remove: true })) as { results: { removed: boolean }[] }).results[0].removed, true);
    row = listPlugins(dir)[0];
    assert.deepEqual([row.exports, row.exported], [[], {}]);
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
