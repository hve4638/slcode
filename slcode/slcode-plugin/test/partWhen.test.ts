// part 조건 when (ticket slcode-agent-plugin-part-when, 사용자 결정 2026-11-02) — manifest 꼴, 조건 판단(true·값·목록, 이름 여럿은 모두),
// part·env 조건 (ticket slcode-agent-plugin-part-when-part) 은 파일 아래쪽 테스트가 본다
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

test('manifest: when 의 param 은 NAME: true | "값" | ["값", …] 만 — 그 밖은 add 를 거부한다', () => {
  const m = (when: unknown) => parseManifest(JSON.stringify({ name: 'p', parts: { a: { when } } }));
  assert.deepEqual(m({ param: { ORCH_ROLE: true, KIND: 'x', MODE: ['a', 'b'] } }).parts.a.when, { param: { ORCH_ROLE: true, KIND: 'x', MODE: ['a', 'b'] } });
  assert.equal(parseManifest(JSON.stringify({ name: 'p', parts: { a: {} } })).parts.a.when, undefined);
  for (const bad of [true, 'ORCH_ROLE', {}, { param: {} }, { other: { A: true } }, { param: { A: true }, env: {} }, { param: { 'A-B': true } }, { param: { '1A': true } },
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

// ---- part·env 조건 (ticket slcode-agent-plugin-part-when-part, 사용자 확정 2026-11-03)
const parsed = (parts: object, env?: object) => parseManifest(JSON.stringify({ name: 'p', parts, ...(env ? { env } : {}) }));

test('manifest: part 는 이름 → true 만, env 는 param 과 같은 꼴, 셋 중 하나 이상. 이름이 틀리거나 빈 칸은 거부한다', () => {
  const when = { part: { main: true }, param: { ROLE: true }, env: { FLAG: '1', KIND: ['a', 'b'], ANY: true } };
  assert.deepEqual(parsed({ main: {}, x: { when } }).parts.x.when, when);
  assert.deepEqual(parsed({ main: {}, x: { when: { part: { main: true } } } }).parts.x.when, { part: { main: true } }, 'part 만');
  assert.deepEqual(parsed({ x: { when: { env: { A: true } } } }).parts.x.when, { env: { A: true } }, 'env 만');
  for (const bad of [{ part: {} }, { env: {} }, { part: { main: false } }, { part: { main: 'on' } }, { part: { main: ['a'] } }, { part: { main: true }, other: {} }, { part: true }, { part: { main: true }, env: {} },
    { env: { 'A-B': true } }, { env: { '1A': 'x' } }, { env: { A: false } }, { env: { A: 1 } }, { env: { A: [] } }, { env: { A: ['x', 2] } }, { env: { A: null } }]) {
    assert.throws(() => parsed({ main: {}, x: { when: bad } }), /when/, JSON.stringify(bad));
  }
});

test('manifest: 없는 part 이름·자기 참조·순환은 거부하고, 사슬과 뒤에 적은 part 를 보는 조건은 받는다', async () => {
  assert.throws(() => parsed({ a: { when: { part: { nope: true } } } }), /part a when part nope is not a part of this plugin/);
  assert.throws(() => parsed({ a: { when: { part: { constructor: true } } } }), /is not a part/, 'Object 의 키를 part 로 읽지 않는다');
  assert.throws(() => parsed({ a: { when: { part: { a: true } } } }), /part a when part a refers to itself/);
  assert.throws(() => parsed({ a: { when: { part: { b: true } } }, b: { when: { part: { a: true } } } }), /cycle: a -> b -> a/);
  assert.throws(() => parsed({ x: { when: { part: { a: true } } }, a: { when: { part: { b: true } } }, b: { when: { part: { c: true } } }, c: { when: { part: { a: true } } } }), /cycle: a -> b -> c -> a/);
  assert.doesNotThrow(() => parsed({ a: { when: { part: { b: true, c: true } } }, b: { when: { part: { c: true } } }, c: {} }), '순환이 아닌 다이아몬드');
  await assert.rejects(addPlugin(source({ name: 'bad', parts: { main: { when: { part: { nope: true } } } } }), tmp('state')), /is not a part/, 'add 가 거부한다');
});

test('조건: env 는 param 과 같은 규칙, 세 칸과 이름 모두 참이어야 참. 글은 part·param·env 순서', () => {
  const w = { part: { main: true as const }, param: { ROLE: true as const }, env: { FLAG: '1', KIND: ['a', 'b'] as string[] } };
  const on = (x: string) => x === 'main';
  const env = { FLAG: '1', KIND: 'b' };
  assert.equal(whenHolds(w, { ROLE: 'x' }, env, on), true);
  assert.equal(whenHolds(w, { ROLE: 'x' }, env, () => false), false, 'part 거짓');
  assert.equal(whenHolds(w, {}, env, on), false, 'param 거짓');
  assert.equal(whenHolds(w, { ROLE: 'x' }, { FLAG: '2', KIND: 'b' }, on), false, 'env 값 다름');
  assert.equal(whenHolds(w, { ROLE: 'x' }, { FLAG: '1', KIND: 'c' }, on), false, 'env 목록 밖');
  assert.equal(whenHolds(w, { ROLE: 'x' }, { FLAG: '1' }, on), false, 'env 이름 하나 없음');
  assert.equal(whenHolds({ env: { A: true } }, {}, { A: '' }), false, '빈 env 는 없는 것');
  assert.equal(whenHolds({ env: { A: true } }, {}, { A: undefined }), false);
  assert.equal(whenHolds({ env: { toString: true } }, {}, {}), false, 'Object 의 키를 값으로 읽지 않는다');
  assert.equal(whenHolds({ env: { A: true } }, { A: '1' }, {}), false, 'param 값을 env 로 보지 않는다');
  assert.equal(whenHolds({ param: { A: true } }, {}, { A: '1' }), false, 'env 값을 param 으로 보지 않는다');
  assert.equal(whenText(w), 'part main param ROLE env FLAG=1 env KIND=a|b');
});

test('값: 활성화는 최종 상태 — 사용자 on/off 와 대상의 when 까지 반영하고, 사슬은 manifest 순서와 상관없다. env 값은 설정 문자열에 들어가지 않는다', () => {
  const m = parsed({ top: { when: { part: { mid: true } } }, mid: { when: { part: { base: true }, param: { ROLE: true } } }, base: { when: { env: { FLAG: true } } }, plain: {} });
  const P = { ROLE: 'x' }, E = { FLAG: '1' };
  assert.deepEqual(resolveValues(m, [], P, E).parts, { top: true, mid: true, base: true, plain: true }, '사슬 전부 참 — 뒤에 적은 base 를 먼저 판단');
  assert.deepEqual(resolveValues(m, [], {}, E).parts, { top: false, mid: false, base: true, plain: true }, 'mid 의 param 거짓이 top 으로 이어진다');
  assert.deepEqual(resolveValues(m, [], P, {}).parts, { top: false, mid: false, base: false, plain: true }, 'base 의 env 거짓이 끝까지 이어진다');
  assert.deepEqual(resolveValues(m, [{ parts: { base: false } }], P, E).parts, { top: false, mid: false, base: false, plain: true }, '사용자가 끈 대상은 꺼진 것');
  assert.deepEqual(resolveValues(m, [{ parts: { top: false } }], P, E).parts, { top: false, mid: true, base: true, plain: true }, '사용자가 끈 part 는 조건이 참이어도 꺼짐');
  const req = parsed({ a: { default: false }, must: { required: true, when: { part: { a: true } } } });
  assert.deepEqual(resolveValues(req, []).parts, { a: false, must: false }, '필수 part 도 조건이 거짓이면 꺼진다');
  assert.deepEqual(resolveValues(req, [{ parts: { a: true } }]).parts, { a: true, must: true });
  assert.equal(valuesString(resolveValues(m, [], P, { FLAG: '1' })), valuesString(resolveValues(m, [], P, { FLAG: 'other', SECRET: 's' })), 'env 값이 달라도 켜진 part 가 같으면 같은 문자열');
  assert.doesNotMatch(valuesString(resolveValues(m, [], P, { FLAG: 'secret-value' })), /secret-value/);
});

const AND = { name: 'andp', version: '1.0.0', env: { FROM_MANIFEST: '1' }, parts: {
  main: { required: true },
  full: { when: { part: { main: true }, param: { ROLE: true }, env: { SOME_FLAG: '1' } } },
  chained: { when: { part: { full: true } } },
  byManifest: { when: { env: { FROM_MANIFEST: true } } },
  byPart: { when: { part: { main: true } } },
} };
function sourceOf(manifest: { parts: object }): string {
  const src = tmp('src');
  write(src, { 'slcode-plugin.json': JSON.stringify(manifest), ...Object.fromEntries(Object.keys(manifest.parts).map((p) => [`${p}/instructions/${p}.md`, `${p} rule`])) });
  return src;
}

test('세션에 싣기: part·param·env AND 와 사슬. 다시 싣기·currentBuilds 가 같은 env 를 보고, manifest env 는 조건에 걸리지 않는다', async () => {
  const dir = tmp('state');
  await addPlugin(sourceOf(AND), dir);
  const load = (params: Record<string, string>, env: NodeJS.ProcessEnv, sdir = tmp('s')) => loadSessionPlugins(sdir, env, {}, dir, 'claude', undefined, params);
  const on = (s: { loaded: { values: string }[] }) => s.loaded[0].values.split(',').filter((x) => x.endsWith('=1')).map((x) => x.slice(5, -2));
  const P = { ROLE: 'w' }, E = { SOME_FLAG: '1' };
  assert.deepEqual(on(load(P, E)), ['byPart', 'chained', 'full', 'main'], '모두 참');
  assert.deepEqual(on(load({}, E)), ['byPart', 'main'], 'param 없음 — full 과 사슬이 꺼진다');
  assert.deepEqual(on(load(P, {})), ['byPart', 'main'], 'env 없음');
  assert.deepEqual(on(load(P, { SOME_FLAG: '2' })), ['byPart', 'main'], 'env 값 다름');
  assert.ok(load(P, E).append.includes('chained rule'), '사슬 끝 part 의 지시문이 실렸다');

  const m = load({}, {});
  assert.equal(m.env.FROM_MANIFEST, '1', 'manifest env 는 그대로 세션에 간다');
  assert.ok(!on(m).includes('byManifest'), 'manifest env 는 조건에 걸리지 않는다');
  assert.ok(on(load({}, { FROM_MANIFEST: 'shell' })).includes('byManifest'), '받은 env 에 있으면 걸린다');

  const sdir = tmp('s');
  const s = load(P, E, sdir);
  assert.equal(currentBuilds({}, dir, 'claude', undefined, P, E).andp, s.loaded[0].build, 'currentBuilds 도 같은 env');
  assert.notEqual(currentBuilds({}, dir, 'claude', undefined, P).andp, s.loaded[0].build, 'env 를 빠뜨리면 다른 빌드');
  const r = reloadSessionPlugins(sdir, s.loaded, E, {}, dir, 'claude', undefined, P);
  assert.deepEqual([r.loaded[0].build, r.later], [s.loaded[0].build, []], '다시 싣기도 같은 빌드');
  const cx = loadSessionPlugins(tmp('cx'), E, {}, dir, 'codex', undefined, P);
  assert.deepEqual(on(cx), ['byPart', 'chained', 'full', 'main'], 'Codex 세션도 같은 조건');
  assert.equal(load(P, { SOME_FLAG: '1', OTHER: 'x' }).loaded[0].build, s.loaded[0].build, '조건 밖 env 는 빌드 id 를 바꾸지 않는다');
});

test('export 판: param·env 는 없는 것으로 보고, part 조건만 있고 대상이 켜진 part 는 남는다. 제외 목록은 실제로 빠진 part 만, 사유를 구분해 적는다', async () => {
  const dir = tmp('state');
  await addPlugin(sourceOf({ name: 'exp', version: '1.0.0', parts: {
    main: { required: true },
    keep: { when: { part: { main: true } } },
    keep2: { when: { part: { keep: true } } },
    byParam: { when: { param: { ROLE: true } } },
    byEnv: { when: { env: { FLAG: '1' } } },
    both: { when: { param: { ROLE: true }, env: { FLAG: true } } },
    onParam: { when: { part: { byParam: true } } },
    mixed: { when: { part: { byEnv: true }, param: { ROLE: true } } },
    onUserOff: { when: { part: { opt: true } } },
    opt: { default: false },
  } }), dir);
  const ap = agentPaths(dir);
  for (const h of ['claude', 'codex'] as const) {
    const ex = exportBuild(ap, 'exp', readConfig(ap).plugins.exp, h, { FLAG: '1' });
    assert.equal(ex.report.values, 'part.both=0,part.byEnv=0,part.byParam=0,part.keep2=1,part.keep=1,part.main=1,part.mixed=0,part.onParam=0,part.onUserOff=0,part.opt=0', `${h}: 셸 env 가 있어도 export 판은 보지 않는다`);
    assert.deepEqual(ex.report.excluded.filter((x) => x.includes('part condition')), [
      'byParam: part condition param ROLE (slcode session params only)',
      'byEnv: part condition env FLAG=1 (slcode session env only)',
      'both: part condition param ROLE env FLAG (slcode session params and env only)',
      'onParam: part condition part byParam (part byParam is off)',
      'mixed: part condition part byEnv param ROLE (slcode session params only, part byEnv is off)',
      'onUserOff: part condition part opt (part opt is off)',
    ], h);
  }
  const mixed = listPlugins(dir)[0].parts.find((p) => p.name === 'mixed');
  assert.equal(mixed?.when, 'part byEnv param ROLE', '목록·관리 화면의 조건 글');
  assert.deepEqual(mixed?.needs, ['byEnv'], '관리 화면이 비활성 표시에 쓰는 대상 part');
  assert.deepEqual(listPlugins(dir)[0].parts.find((p) => p.name === 'byParam')?.needs, [], 'part 조건이 없으면 비어 있다');
  await setPlugin('exp', ['opt=on'], dir);
  const after = exportBuild(ap, 'exp', readConfig(ap).plugins.exp, 'claude', {});
  assert.ok(!after.report.excluded.some((x) => x.startsWith('onUserOff:')), '대상을 켜면 export 판에 남고 제외 목록에서 사라진다');
  assert.match(after.report.values, /part\.onUserOff=1/);
});
