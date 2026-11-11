// export 한 Claude·Codex 의 js/ts 훅 (ticket slcode-agent-plugin-script-portable) — slcode/api 계약의 목록 모드, export hooks.json 항목, Codex 출력 변환,
// 훅 명령 → 세션 중간 프로세스(상태 파일·모듈 변수·동시 호출·SessionEnd 종료·직접 실행), tsc 하네스 검사. 하네스(claude·codex)는 띄우지 않고 훅 입력을 직접 넣는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addPlugin, agentPaths } from '../src/agentPlugins.ts';
import { codexGaps, exportHookEntries, hookLaunch, unionMatcher, type ScriptEntry } from '../src/agentHooks.ts';
import { brokerSocket, EXPORT_SCRIPTS_DIR, toCodex } from '../src/hookBroker.ts';
import { apiDts, checkScripts, TS_VERSION } from '../src/scriptCheck.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'src/hookMain.ts');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-hp-${p}-`));
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}
async function install(dir: string, name: string, files: Record<string, string>) {
  const src = tmp(name);
  write(src, { 'slcode-plugin.json': JSON.stringify({ name, version: '1.0.0', parts: { main: {} } }), ...files });
  const id = (await addPlugin(src, dir)).build!;
  const out = path.join(agentPaths(dir).build, id);
  return { out, report: JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8')), scripts: fs.existsSync(path.join(out, 'scripts.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'scripts.json'), 'utf8')) as ScriptEntry[] : [] };
}

const GUARD = `
import { slcode } from 'slcode/api';
let calls = 0;
slcode.on('PreToolUse', { matcher: 'Bash' }, (h: any) => {
  calls++;
  h.state.n = (h.state.n ?? 0) + 1;
  if (h.tool.input.command.includes('rm -rf')) return h.block('no rm');
  h.context(\`n=\${h.state.n} calls=\${calls}\`);
});
slcode.on('PreToolUse', { matcher: 'Edit' }, (h: any) => { h.ask('sure?'); h.message(\`edit \${h.tool.name}\`); });
slcode.on('SessionStart', { matcher: 'startup' }, (h: any) => { h.context(\`hello \${slcode.vars.harness}\`); });
slcode.run();
`;

const both = <T>(regs: T) => ({ claude: regs, codex: regs });

test('목록 모드: 등록을 scripts.json 에 적는다 — 옛 꼴(default 함수)·싣다가 던지는 것은 빼고, slcode.run() 없음·잘못된 등록은 경고', async () => {
  const dir = tmp('state');
  const { report, scripts } = await install(dir, 'p', {
    'main/hooks/hooks.json': JSON.stringify({ hooks: ['g.ts', 'old.ts', 'throw.ts', 'norun.ts', 'bad.ts', 'vars.ts'].map((f) => ({ type: 'script', file: f })) }),
    'main/g.ts': GUARD,
    'main/old.ts': "export default (s: any) => s.on('Stop', () => {});",
    'main/throw.ts': "import { slcode } from 'slcode/api'; slcode.on('Stop', () => {}); throw new Error('top boom');",
    'main/norun.ts': "import { slcode } from 'slcode/api'; slcode.on('Stop', () => {});",
    'main/bad.ts': "import { slcode } from 'slcode/api'; slcode.on('ProToolUse' as any, () => {}); slcode.on('Stop', () => {}); slcode.on('Stop', { matcher: 'x' } as any, () => {}); slcode.run();",
    'main/vars.ts': "import { slcode } from 'slcode/api'; if (slcode.vars.harness === 'codex') slcode.on('Stop', () => {}); else slcode.on('PreCompact', () => {}); try { (slcode.vars as any).harness = 'x'; } catch {} slcode.on('SessionEnd', { timeout: slcode.vars.harness === 'x' ? 99 : 10 }, () => {}); slcode.run();",
  });
  assert.deepEqual(scripts.map((s) => s.src), ['main/g.ts', 'main/norun.ts', 'main/bad.ts', 'main/vars.ts']);
  assert.deepEqual(scripts[3].regs, {
    claude: [{ event: 'PreCompact', matcher: null, timeout: 10, failClosed: false }, { event: 'SessionEnd', matcher: null, timeout: 10, failClosed: false }],
    codex: [{ event: 'Stop', matcher: null, timeout: 10, failClosed: false }, { event: 'SessionEnd', matcher: null, timeout: 10, failClosed: false }],
  }, '하네스마다 그 slcode.vars.harness 로 실어 등록을 모은다, vars 는 바꿀 수 없다');
  assert.deepEqual(scripts[0].regs!.claude!.map((r) => `${r.event} ${r.matcher}`), ['PreToolUse Bash', 'PreToolUse Edit', 'SessionStart startup']);
  assert.deepEqual(scripts[2].regs!.claude!.map((r) => `${r.event} ${r.matcher}`), ['Stop null', 'Stop null'], '모르는 이벤트만 빼고, matcher 를 보지 않는 이벤트의 matcher 는 무시한다');
  assert.ok(report.scripts.failed.some((f: string) => /^main\/old\.ts: default export 함수 꼴은 더 받지 않습니다/.test(f)), report.scripts.failed.join('\n'));
  assert.ok(report.scripts.failed.some((f: string) => /^main\/throw\.ts: top boom/.test(f)));
  assert.ok(report.scripts.warnings.some((w: string) => /^main\/norun\.ts: slcode\.run\(\) 을 부르지 않았습니다/.test(w)));
  assert.ok(report.scripts.warnings.some((w: string) => /^main\/bad\.ts: on\(ProToolUse\) — 모르는 이벤트/.test(w)));
  assert.ok(report.scripts.warnings.some((w: string) => /^main\/bad\.ts: on\(Stop\) — Stop 는 matcher 를 보지 않습니다/.test(w)));
});

test('export hooks.json 항목: 이벤트마다 command 하나·matcher 합집합·SessionEnd 는 늘·명령 문자열은 빌드와 무관. Codex 차이 보고', () => {
  assert.equal(unionMatcher(['Bash', 'Edit|Write', 'Bash']), 'Bash|Edit|Write');
  assert.equal(unionMatcher(['Bash', null]), null);
  assert.equal(unionMatcher(['Bash', 'mcp__.*']), '^(?:Bash)$|(?:mcp__.*)');
  const scripts: ScriptEntry[] = [
    { src: 'main/a.ts', js: 'scripts/0.mjs', regs: both([{ event: 'PreToolUse', matcher: 'Bash', timeout: 10, failClosed: false }, { event: 'Stop', matcher: null, timeout: 30, failClosed: false }]) },
    { src: 'main/b.ts', js: 'scripts/1.mjs', regs: both([{ event: 'PreToolUse', matcher: 'Read|Edit', timeout: 2, failClosed: false }]) },
  ];
  const launch = ['/opt/sl/runtime/node', '/opt/sl/dist/hookMain.js'];
  const c = exportHookEntries(scripts, 'claude', launch) as Record<string, any[]>;
  assert.deepEqual(Object.keys(c), ['PreToolUse', 'Stop', 'SessionEnd']);
  assert.equal(c.PreToolUse[0].matcher, 'Bash|Read|Edit');
  assert.deepEqual(c.PreToolUse[0].hooks, [{ type: 'command', command: '/opt/sl/runtime/node /opt/sl/dist/hookMain.js claude "${CLAUDE_PLUGIN_ROOT}" PreToolUse', timeout: 15 }]);
  // PATH 의 slcode 가 아니라 이 node·hookMain 의 절대 경로 — 터미널의 rc 가 옛 slcode 를 앞에 둬도 (ticket slcode-session-path-rc-override)
  assert.deepEqual(hookLaunch(), [process.execPath, path.resolve(import.meta.dirname, '..', 'src', 'hookMain.ts')]);
  assert.match((exportHookEntries(scripts, 'claude', ['/a b/node', '/x']) as any).Stop[0].hooks[0].command, /^"\/a b\/node" \/x claude/);
  assert.equal(c.Stop[0].matcher, undefined, 'Stop 은 matcher 를 보지 않는다');
  assert.equal(c.Stop[0].hooks[0].timeout, 35);
  const x = exportHookEntries(scripts, 'codex', launch) as Record<string, any[]>;
  assert.match(x.PreToolUse[0].hooks[0].command, / codex "\$\{CLAUDE_PLUGIN_ROOT\}" PreToolUse$/);
  assert.equal(x.SessionEnd[0].hooks[0].timeout, 3, 'Codex 의 SessionEnd 는 3초까지');
  const gaps = codexGaps(scripts);
  assert.ok(gaps.some((g) => /main\/b\.ts: PreToolUse Read\|Edit — Codex 에는 Read 도구가 없습니다$/.test(g)), gaps.join('\n'));
  assert.ok(gaps.some((g) => /apply_patch/.test(g)));
});

test('Codex 출력: PreToolUse 의 ask·stop 은 빼고 알린다, updatedInput 은 allow 와 함께, 그 밖은 그대로', () => {
  let r = toCodex('PreToolUse', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'sure?', additionalContext: 'c' }, continue: false, stopReason: 's' });
  assert.deepEqual(r.out, { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'c' } });
  assert.equal(r.warnings.length, 2);
  r = toCodex('PreToolUse', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } });
  assert.deepEqual(r.out, {}, 'hookEventName 만 남으면 칸째 뺀다');
  r = toCodex('PreToolUse', { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'ls' } } });
  assert.equal((r.out.hookSpecificOutput as any).permissionDecision, 'allow');
  r = toCodex('Stop', { decision: 'block', reason: 'go on' });
  assert.deepEqual(r, { out: { decision: 'block', reason: 'go on' }, warnings: [] });
  assert.equal(toCodex('SubagentStart', { continue: false }).warnings.length, 1);
});

/** 훅 명령 한 번 — 하네스처럼 stdin 에 입력을 넣고 stdout 을 받는다 */
function hook(harness: string, root: string, event: string, input: Record<string, unknown>, env: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', MAIN, harness, root, event], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (code) => { try { assert.equal(code, 0); resolve(JSON.parse(out)); } catch (e) { reject(new Error(`${e} — ${out}`)); } });
    p.stdin.end(JSON.stringify({ hook_event_name: event, cwd: ROOT, transcript_path: '', ...input }));
  });
}
/** 세션 빌드의 스크립트를 export 플러그인 폴더 꼴로 옮긴다 (연결 전 — agentExport 가 할 일) */
function exportRoot(out: string, name: string) {
  const root = tmp('export');
  fs.mkdirSync(path.join(root, EXPORT_SCRIPTS_DIR), { recursive: true });
  fs.cpSync(path.join(out, 'scripts'), path.join(root, EXPORT_SCRIPTS_DIR, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(out, 'scripts.json'), path.join(root, EXPORT_SCRIPTS_DIR, 'scripts.json'));
  write(root, { '.claude-plugin/plugin.json': JSON.stringify({ name, version: '1.0.0' }) });
  return root;
}
const install0 = path.dirname(MAIN); // hookMain 의 install() 과 같은 값 (src 는 실제 경로)

test('훅 명령 → 중간 프로세스: 상태 파일·모듈 변수가 세션 동안 남고, 동시 호출을 차례로, Codex 별칭·출력, SessionEnd 에 끝난다', async () => {
  const dir = tmp('state'), data = tmp('data');
  const { out } = await install(dir, 'guard', { 'main/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'g.ts' }] }), 'main/g.ts': GUARD });
  const root = exportRoot(out, 'guard');
  const sid = `s-${process.pid}-${Date.now()}`;
  const env = { CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: root };
  const sock = brokerSocket('claude', sid, fs.realpathSync(install0));
  try {
    let o = await hook('claude', root, 'SessionStart', { session_id: sid, source: 'startup' }, env);
    assert.deepEqual(o, { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hello claude' } });
    assert.ok(fs.existsSync(sock), '첫 훅이 중간 프로세스를 띄웠다');
    const bash = (cmd: string, id: string) => hook('claude', root, 'PreToolUse', { session_id: sid, tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: id }, env);
    const many = await Promise.all([1, 2, 3, 4, 5].map((i) => bash(`echo ${i}`, `t${i}`)));
    assert.deepEqual(many.map((m) => m.hookSpecificOutput.additionalContext).sort(), ['n=1 calls=1', 'n=2 calls=2', 'n=3 calls=3', 'n=4 calls=4', 'n=5 calls=5'], '한 worker 가 차례로 — 상태·모듈 변수가 겹치지 않는다');
    o = await bash('rm -rf /', 't6');
    assert.deepEqual(o.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no rm' });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, '.slcode/state', `${sid}.json`), 'utf8')), { n: 6 }, '데이터 폴더의 .slcode/state/<session_id>.json');
    o = await hook('claude', root, 'PreToolUse', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: 'a' }, tool_use_id: 't7' }, env);
    assert.deepEqual(o, { systemMessage: 'edit Edit', hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'sure?' } });
    assert.deepEqual(await hook('claude', root, 'SessionEnd', { session_id: sid, reason: 'other' }, env), {});
    for (const t0 = Date.now(); fs.existsSync(sock) && Date.now() - t0 < 5000;) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!fs.existsSync(sock), 'SessionEnd 뒤 중간 프로세스가 끝나고 소켓을 지웠다');
  } finally { if (fs.existsSync(sock)) await hook('claude', root, 'SessionEnd', { session_id: sid, reason: 'other' }, env); }

  // Codex — 같은 플러그인 폴더, 다른 세션. apply_patch 는 Edit matcher 로 맞고, ask 는 빼고 알린다
  const csid = `${sid}-codex`, cenv = { PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: root };
  try {
    const o = await hook('codex', root, 'PreToolUse', { session_id: csid, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch' }, tool_use_id: 'c1' }, cenv);
    assert.deepEqual(o, { systemMessage: 'edit apply_patch\n[slcode] Codex 는 PreToolUse 의 ask() 를 받지 않아 뺐습니다 — 평소의 승인 절차를 따릅니다' });
    const b = await hook('codex', root, 'PreToolUse', { session_id: csid, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'c2' }, cenv);
    assert.equal(b.hookSpecificOutput.additionalContext, 'n=1 calls=1', '세션마다 상태와 모듈이 따로');
    const s = await hook('codex', root, 'SessionStart', { session_id: csid, source: 'startup' }, cenv);
    assert.equal(s.hookSpecificOutput.additionalContext, 'hello codex', 'slcode.vars.harness 는 그 하네스');
  } finally { await hook('codex', root, 'SessionEnd', { session_id: csid, reason: 'other' }, cenv); }

  // session_id 가 없으면 중간 프로세스 없이 직접 돈다
  const o = await hook('claude', root, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'x' }, env);
  assert.match(o.systemMessage, /세션 중간 프로세스에 닿지 않아 이 훅을 따로 돌렸습니다/);
  assert.match(o.hookSpecificOutput.additionalContext, /^n=1 calls=1$/);
});

test('tsc 검사: 하네스별 slcode/api 타입 — Codex 에 없는 ask, Stop 의 context, 모르는 이벤트, matcher 를 보지 않는 이벤트의 matcher, 목록 밖의 message 아이콘을 경고. 훅 API 밖의 진단은 버린다', async () => {
  const stateDir = tmp('ts');
  // 받지 않게 node_modules 의 같은 판을 받아 둔 자리에 놓는다
  const have = path.join(ROOT, '..', 'node_modules/typescript'); // slcode 의 devDependencies
  assert.equal(JSON.parse(fs.readFileSync(path.join(have, 'package.json'), 'utf8')).version, TS_VERSION, 'devDependencies 의 typescript 와 같은 판');
  fs.mkdirSync(path.join(stateDir, 'typescript', TS_VERSION), { recursive: true });
  fs.symlinkSync(have, path.join(stateDir, 'typescript', TS_VERSION, 'package'));
  const src = tmp('src');
  write(src, {
    'a.ts': "import { slcode } from 'slcode/api'; import fs from 'node:fs';\nslcode.on('PreToolUse', (h) => { h.ask('x'); h.context(String(fs)); });\nslcode.on('Stop', (h) => h.context('no'));\nslcode.run();\n",
    'b.js': "import { slcode } from 'slcode/api';\nslcode.on('ProToolUse', () => {});\nslcode.run();\n",
    'c.ts': "import { slcode } from 'slcode/api';\nslcode.on('UserPromptSubmit', { matcher: 'x' }, () => {});\nslcode.on('PreToolUse', { matcher: 'Bash' }, () => {});\nslcode.run();\n",
    'd.ts': "import { slcode } from 'slcode/api';\nslcode.on('SessionStart', (h) => { h.message('ok', { icon: 'flag', tone: 'warn' }); });\nslcode.on('SessionStart', (h) => { h.message('bad', { icon: 'nope' }); });\nslcode.run();\n",
  });
  const r = await checkScripts([path.join(src, 'a.ts'), path.join(src, 'b.js'), path.join(src, 'c.ts'), path.join(src, 'd.ts')], ['claude', 'codex'], stateDir, src);
  assert.equal(r.skipped, null);
  assert.deepEqual(r.warnings.claude!.map((w) => w.split(': ')[0]), ['a.ts:3', 'b.js:2', 'c.ts:2', 'd.ts:3'], 'matcher 는 matcher 를 보는 이벤트에서만');
  assert.deepEqual(r.warnings.codex!.map((w) => w.split(': ')[0]), ['a.ts:2', 'a.ts:3', 'b.js:2', 'c.ts:2', 'd.ts:3']);
  assert.match(r.warnings.claude!.at(-1)!, /'"nope"' is not assignable to type 'SlcodeHookIcon'/, '목록 밖의 아이콘');
  assert.match(r.warnings.codex![0], /Property 'ask' does not exist on type 'SlcodeHook<"PreToolUse">'/);
  assert.match(apiDts('codex'), /PreToolUse: 'block' \| 'allow' \| 'updateInput' \| 'context' \| 'message';/);
});
