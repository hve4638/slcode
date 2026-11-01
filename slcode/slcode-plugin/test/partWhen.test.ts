// part 조건 when (ticket slcode-agent-plugin-part-when, 사용자 결정 2026-11-02) — manifest 꼴, 조건 판단(true·값·목록, 이름 여럿은 모두),
// 사용자 on/off 가 먼저이고 조건은 켠 part 를 거르기만, 필수 part 도 조건이 거짓이면 꺼짐, 인자 값은 빌드 식별자에 들어가지 않음,
// 세션에 싣기·다시 싣기·currentBuilds 가 같은 인자를 봄, 기본 빌드·export 판은 조건 part 를 뺌, js/ts 훅의 hook.session.params(읽기 전용)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseManifest, resolveValues, userValues, valuesString, whenHolds, whenText } from '../src/agentFormat.ts';
import { addPlugin, agentPaths, currentBuilds, listPlugins, loadSessionPlugins, readConfig, reloadSessionPlugins, setPlugin } from '../src/agentPlugins.ts';
import { exportBuild } from '../src/agentExport.ts';
import { HookRunner } from '../src/hookRunner.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-pw-${p}-`));
function write(root: string, files: Record<string, string>) {
  for (const [rel, body] of Object.entries(files)) { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); }
}
/** sfa 플러그인 꼴 — main 은 필수, orchestration 은 ORCH_ROLE 이 있을 때만 */
const SFA = { name: 'superlite', version: '0.3.2', parts: { main: { required: true }, orchestration: { when: { param: { ORCH_ROLE: true } } } } };
function source(manifest: object = SFA): string {
  const src = tmp('src');
  write(src, {
    'slcode-plugin.json': JSON.stringify(manifest),
    'main/instructions/main.md': 'main rule',
    'orchestration/instructions/orch.md': 'orchestration rule',
    'orchestration/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'command', event: 'SessionStart', command: 'echo "$SLCODE_PARAM_ORCH_ROLE"', compat: 'claude' }] }),
  });
  return src;
}

test('manifest: when 은 {param: {NAME: true | "값" | ["값", …]}} 만 — 그 밖은 add 를 거부한다', () => {
  const m = (when: unknown) => parseManifest(JSON.stringify({ name: 'p', parts: { a: { when } } }));
  assert.deepEqual(m({ param: { ORCH_ROLE: true, KIND: 'x', MODE: ['a', 'b'] } }).parts.a.when, { param: { ORCH_ROLE: true, KIND: 'x', MODE: ['a', 'b'] } });
  assert.equal(parseManifest(JSON.stringify({ name: 'p', parts: { a: {} } })).parts.a.when, undefined);
  for (const bad of [true, 'ORCH_ROLE', {}, { param: {} }, { env: { A: true } }, { param: { A: true }, env: {} }, { param: { 'A-B': true } }, { param: { '1A': true } },
    { param: { A: false } }, { param: { A: 1 } }, { param: { A: [] } }, { param: { A: ['x', 2] } }, { param: { A: null } }]) {
    assert.throws(() => m(bad), /when/, JSON.stringify(bad));
  }
});

test('조건: true 는 있고 비어 있지 않음, 문자열은 같음, 목록은 그중 하나, 이름 여럿은 모두. 글은 목록·화면용', () => {
  const w = { param: { ROLE: ['worker', 'lead'] as string[], BRANCH: true as const } };
  assert.equal(whenHolds(w, { ROLE: 'worker', BRANCH: 'feat/x' }), true);
  assert.equal(whenHolds(w, { ROLE: 'lead', BRANCH: 'b' }), true);
  assert.equal(whenHolds(w, { ROLE: 'other', BRANCH: 'b' }), false);
  assert.equal(whenHolds(w, { ROLE: 'worker', BRANCH: '' }), false, '빈 값은 없는 것');
  assert.equal(whenHolds(w, { ROLE: 'worker' }), false, '모두 참이어야');
  assert.equal(whenHolds({ param: { ROLE: 'worker' } }, { ROLE: 'Worker' }), false, '대소문자까지 같아야');
  assert.equal(whenHolds({ param: { toString: true } }, {}), false, 'Object 의 키를 값으로 읽지 않는다');
  assert.equal(whenText(w), 'param ROLE=worker|lead param BRANCH');
  assert.equal(whenText({ param: { ROLE: 'worker' } }), 'param ROLE=worker');
});

test('값: 사용자 on/off 가 먼저 — 조건은 켠 part 만 거르고, 필수 part 도 조건이 거짓이면 꺼진다. 인자 값은 설정 문자열에 들어가지 않는다', () => {
  const m = parseManifest(JSON.stringify({ name: 'p', parts: { main: { required: true }, orch: { when: { param: { ROLE: true } } }, must: { required: true, when: { param: { ROLE: 'lead' } } }, off: { default: false, when: { param: { ROLE: true } } } } }));
  assert.deepEqual(resolveValues(m, []).parts, { main: true, orch: false, must: false, off: false }, '인자 없음 — 조건 part 는 꺼짐');
  assert.deepEqual(resolveValues(m, [], { ROLE: 'worker' }).parts, { main: true, orch: true, must: false, off: false }, '끈 part(off)는 조건이 참이어도 꺼짐');
  assert.deepEqual(resolveValues(m, [{ parts: { orch: false } }], { ROLE: 'lead' }).parts, { main: true, orch: false, must: true, off: false }, '사용자가 끄면 꺼짐, 필수+조건은 참이면 켜짐');
  assert.deepEqual(resolveValues(m, [{ parts: { off: true, must: false } }], { ROLE: 'lead' }).parts, { main: true, orch: true, must: true, off: true }, '필수 part 는 끌 수 없다');
  assert.deepEqual(userValues(m, []).parts, { main: true, orch: true, must: true, off: false }, 'userValues 는 조건을 보지 않는다');
  assert.equal(valuesString(resolveValues(m, [], { ROLE: 'worker' })), valuesString(resolveValues(m, [], { ROLE: 'lead2' })), '값이 달라도 켜진 part 가 같으면 같은 설정 문자열');
  assert.equal(valuesString(resolveValues(m, [])), valuesString(resolveValues(m, [{ parts: { orch: false } }], { ROLE: 'worker' })), '조건으로 꺼진 것과 사용자가 끈 것은 같은 빌드');
});

test('세션에 싣기: 인자가 맞는 세션만 조건 part 를 싣는다 — 기본 빌드·목록·export 판은 인자가 없는 것으로, currentBuilds·다시 싣기는 같은 인자로', async () => {
  const dir = tmp('state');
  const add = await addPlugin(source(), dir);
  const ap = agentPaths(dir);
  const report = (id: string) => JSON.parse(fs.readFileSync(path.join(ap.build, id, 'report.json'), 'utf8'));
  assert.deepEqual(report(add.build!).parts, ['main'], '기본 빌드(add)는 인자가 없어 조건 part 를 뺀다');
  const row = listPlugins(dir)[0];
  assert.deepEqual(row.parts.map((p) => [p.name, p.on, p.when]), [['main', true, null], ['orchestration', true, 'param ORCH_ROLE']], '목록의 on 은 사용자 설정, when 은 조건 글');

  const plain = tmp('plain'), worker = tmp('worker'), lead = tmp('lead');
  const p0 = loadSessionPlugins(plain, {}, {}, dir);
  const pw = loadSessionPlugins(worker, {}, {}, dir, 'claude', undefined, { ORCH_ROLE: 'worker' });
  const pl = loadSessionPlugins(lead, {}, {}, dir, 'claude', undefined, { ORCH_ROLE: 'lead', OTHER: 'x' });
  assert.equal(p0.append, 'main rule');
  assert.equal(pw.append, 'main rule\n\norchestration rule');
  assert.equal(p0.loaded[0].values, 'part.main=1,part.orchestration=0');
  assert.equal(pw.loaded[0].values, 'part.main=1,part.orchestration=1');
  assert.equal(p0.loaded[0].build, add.build, '인자 없는 세션은 기본 빌드를 다시 쓴다');
  assert.notEqual(pw.loaded[0].build, p0.loaded[0].build);
  assert.equal(pl.loaded[0].build, pw.loaded[0].build, '인자 값이 달라도 켜진 part 가 같으면 같은 빌드');
  assert.ok(fs.existsSync(path.join(worker, 'agent-plugins', 'superlite', 'hooks', 'hooks.json')), '조건 part 의 훅이 실렸다');
  assert.ok(!fs.existsSync(path.join(plain, 'agent-plugins', 'superlite', 'hooks', 'hooks.json')));
  const cx = loadSessionPlugins(tmp('codex'), {}, {}, dir, 'codex', undefined, { ORCH_ROLE: 'worker' });
  assert.equal(cx.loaded[0].values, 'part.main=1,part.orchestration=1', 'Codex 세션도 같은 조건');

  // currentBuilds·다시 싣기 — 같은 인자를 주면 다시 실을 것이 없다(인자를 빠뜨리면 다른 빌드로 보인다)
  assert.equal(currentBuilds({}, dir, 'claude', undefined, { ORCH_ROLE: 'worker' }).superlite, pw.loaded[0].build);
  assert.equal(currentBuilds({}, dir).superlite, p0.loaded[0].build);
  const r = reloadSessionPlugins(worker, pw.loaded, {}, {}, dir, 'claude', undefined, { ORCH_ROLE: 'worker' });
  assert.deepEqual([r.loaded[0].build, r.later], [pw.loaded[0].build, []]);

  // 사용자가 끄면 인자가 맞아도 꺼진다
  await setPlugin('superlite', ['orchestration=off'], dir);
  assert.equal(loadSessionPlugins(tmp('off'), {}, {}, dir, 'claude', undefined, { ORCH_ROLE: 'worker' }).loaded[0].values, 'part.main=1,part.orchestration=0');
  assert.deepEqual(listPlugins(dir)[0].parts.map((p) => p.on), [true, false]);
  assert.deepEqual(exportBuild(ap, 'superlite', readConfig(ap).plugins.superlite, 'claude', {}).report.excluded, [], '끈 조건 part 는 export excluded 에 적지 않는다');
  await setPlugin('superlite', ['orchestration=on'], dir);

  // export 판 — 기본 빌드라 조건 part 가 빠지고 excluded 에 적힌다
  for (const h of ['claude', 'codex'] as const) {
    const ex = exportBuild(ap, 'superlite', readConfig(ap).plugins.superlite, h, {});
    assert.ok(ex.report.excluded.includes('orchestration: part condition param ORCH_ROLE (slcode session params only)'), `${h}: ${ex.report.excluded}`);
    assert.equal(ex.report.values, 'part.main=1,part.orchestration=0');
  }
});

test('js/ts 훅: hook.session.params 는 세션 인자의 읽기 전용 사본 — 쓰면 그 콜백만 실패하고 다음 콜백은 원래 값, 주지 않으면 {}', async () => {
  const dir = tmp('state'), sdir = tmp('session');
  const src = tmp('hsrc');
  write(src, {
    'slcode-plugin.json': JSON.stringify({ name: 'ph', version: '1.0.0', parts: { main: {} } }),
    'main/hooks/hooks.json': JSON.stringify({ hooks: [{ type: 'script', file: 'hooks/p.ts' }] }),
    'main/hooks/p.ts': `import { slcode } from 'slcode/api';
      slcode.on('UserPromptSubmit', (hook) => {
        if (hook.prompt === 'write') (hook.session.params as any).ORCH_ROLE = 'lead';
        hook.context(JSON.stringify(hook.session.params));
      });
      slcode.run();`,
  });
  const build = (await addPlugin(src, dir)).build!;
  const events: any[] = [];
  const fireWith = async (params: Record<string, string> | undefined, prompts: string[]) => {
    const r = new HookRunner({ sessionDir: sdir, buildDir: agentPaths(dir).build, sessionId: 's1', ...(params ? { params } : {}), emit: (e) => events.push(e) });
    r.load([{ name: 'ph', build }] as any);
    const hooks = r.sdkHooks() as Record<string, { hooks: ((i: unknown) => Promise<any>)[] }[]>;
    try {
      const out: any[] = [];
      for (const prompt of prompts) out.push(await hooks.UserPromptSubmit[0].hooks[0]({ hook_event_name: 'UserPromptSubmit', session_id: 'v', cwd: sdir, transcript_path: '', prompt }));
      return out;
    } finally { await r.close(); }
  };
  const [a, b, c] = await fireWith({ ORCH_ROLE: 'worker' }, ['one', 'write', 'two']);
  assert.equal(a.hookSpecificOutput.additionalContext, '{"ORCH_ROLE":"worker"}');
  assert.equal(b.hookSpecificOutput?.additionalContext, undefined, '쓰기는 그 콜백의 실패로');
  assert.match(JSON.stringify(events), /read.only|Cannot assign|TypeError/i);
  assert.equal(c.hookSpecificOutput.additionalContext, '{"ORCH_ROLE":"worker"}', '다음 콜백은 원래 값');
  const [d] = await fireWith(undefined, ['one']);
  assert.equal(d.hookSpecificOutput.additionalContext, '{}');
});
