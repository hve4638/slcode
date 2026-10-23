// 새 세션의 effort·첫 프롬프트 (ticket slcode-new-effort-prompt, 사용자 결정 2026-10-23) — 이름 오타는 거절, 모델에 없는 값은 알린 뒤 벤더 기본,
// `--` 뒤는 첫 프롬프트, 이어받는 세션에 주면 거절. 살아 있는 세션은 가짜 codex(test/fixtures/fake-codex.mjs, fake-model 의 efforts 는 low·high)로 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import { effortMisfit } from '../src/base.ts';

const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
type Out = { code: number; stdout: string; stderr: string };
const baseEnv = (dir: string): NodeJS.ProcessEnv => ({ ...process.env, SLCODE_DIR: dir, SLCODE_GRACE_SECS: '1', SLCODE_SESSION_ID: undefined, SUPERLITE_SOCK: undefined, SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}` });
function run(dir: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Out> {
  return new Promise((resolve) => execFile(process.execPath, ['--import', TSX, CLI, ...args], { cwd: opts.cwd, env: { ...baseEnv(dir), ...opts.env } }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
}
/** 세션 프로세스 하나 — 첫 stdout 줄(소켓 경로)이 나오면 돌려주고, stop 은 SIGINT 로 닫는다 */
async function live(dir: string, args: string[]) {
  const child = spawn(process.execPath, ['--import', TSX, CLI, ...args], { env: baseEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise((r) => child.on('exit', r));
  let out = '', err = '';
  child.stdout!.setEncoding('utf8'); child.stdout!.on('data', (d: string) => { out += d; });
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => { err += d; });
  const t0 = Date.now(); while (!out.includes('\n') && child.exitCode === null && Date.now() - t0 < 15000) await sleep(50);
  assert.ok(out.includes('\n'), err);
  return { stop: async () => { if (child.exitCode === null) child.kill('SIGINT'); await exit; } };
}
/** 가짜 superlite 심 — 받은 인자를 한 줄씩 적고 카드 id 를 찍는다 */
function fakeShim() {
  const bin = tmp('slcode-shim-');
  const calls = path.join(bin, 'calls');
  fs.writeFileSync(path.join(bin, 'superlite'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\necho s-card-1\n`, { mode: 0o755 });
  return { env: { SUPERLITE_SOCK: '/tmp/fake.sock', PATH: `${bin}:${process.env.PATH}` }, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter((l) => l.startsWith('slcode.')) : []) };
}
const metaOf = (dir: string, title: string) => EventLog.list(corePaths(dir).sessionsDir).find((m) => m.title === title);
async function events(dir: string, s: string) {
  return (await run(dir, ['log', s, '--json'])).stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).ev);
}
async function until(f: () => Promise<boolean>, ms = 10000) { const t0 = Date.now(); while (!(await f()) && Date.now() - t0 < ms) await sleep(100); }

test('effortMisfit: 지금 모델에 없는 effort 면 그 모델의 efforts, 맞거나 알 수 없으면 null', () => {
  const models = [
    { value: 'default', displayName: 'Default', description: '', efforts: ['low', 'medium', 'high'] },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-4-7[1m]', displayName: 'Opus', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', description: '' },
  ];
  const r = (current: string | null) => ({ current, effort: null, models });
  assert.equal(effortMisfit(r('opus[1m]'), 'max'), null);
  assert.equal(effortMisfit(r('claude-opus-4-7'), 'max'), null, '[..] 를 뗀 resolvedModel 로도 찾는다');
  assert.deepEqual(effortMisfit(r(null), 'max'), ['low', 'medium', 'high'], '지금 모델을 모르면 default');
  assert.equal(effortMisfit(r('haiku'), 'max'), null, 'efforts 가 없는 모델은 알 수 없다');
  assert.equal(effortMisfit(r('gpt-x'), 'max'), null, '목록에 없는 모델은 알 수 없다');
});

test('카드 경로: --effort·-- 뒤 첫 프롬프트를 slcode.new 에 넘긴다, Claude effort 오타는 아무것도 열지 않는다', async () => {
  const dir = tmp('slcode-newopt-');
  const work = fs.realpathSync(tmp('slcode-work-'));
  const shim = fakeShim();
  const a = await run(dir, ['--effort', 'high', '--model', 'opus', '--', 'fix', 'the', 'login bug'], { cwd: work, env: shim.env });
  assert.equal(a.code, 0, a.stderr); assert.equal(a.stdout.trim(), 's-card-1');
  const b = await run(dir, ['new', work, '--vendor', 'codex', '--effort', 'turbo', '--', '-x', '--title', 'y'], { env: shim.env });
  assert.equal(b.code, 0, b.stderr);
  const bad = await run(dir, ['new', work, '--effort', 'hgih', '--', 'go'], { env: shim.env });
  assert.equal(bad.code, 2); assert.match(bad.stderr, /unknown effort 'hgih' for claude \(low\|medium\|high\|xhigh\|max\)/);
  assert.deepEqual(shim.calls(), [
    `slcode.new --cwd ${work} --model opus --effort high --prompt fix the login bug`,
    `slcode.new --cwd ${work} --vendor codex --effort turbo --prompt -x --title y`, // -- 뒤는 옵션처럼 보여도 프롬프트, Codex 는 이름을 보지 않는다
  ]);
  // --model <공급자>:<모델> 은 벤더도 고른다 (임시) — 다른 앞머리는 이름 전체가 모델, --vendor 와 어긋나면 거절
  const before = shim.calls().length;
  assert.equal((await run(dir, ['new', work, '--model', 'openai:gpt-5.6-sol', '--effort', 'turbo'], { env: shim.env })).code, 0);
  assert.equal((await run(dir, ['new', work, '--model', 'anthropic:claude-x'], { env: shim.env })).code, 0);
  assert.equal((await run(dir, ['new', work, '--model', 'anthropic.claude-v2:0'], { env: shim.env })).code, 0);
  const clash = await run(dir, ['new', work, '--vendor', 'claude', '--model', 'openai:gpt-x'], { env: shim.env });
  assert.equal(clash.code, 2); assert.match(clash.stderr, /--model openai:gpt-x is a codex model but --vendor is claude/);
  assert.equal((await run(dir, ['new', work, '--model', 'openai:'], { env: shim.env })).code, 2);
  assert.deepEqual(shim.calls().slice(before), [
    `slcode.new --cwd ${work} --vendor codex --model gpt-5.6-sol --effort turbo`,
    `slcode.new --cwd ${work} --vendor claude --model claude-x`,
    `slcode.new --cwd ${work} --model anthropic.claude-v2:0`,
  ]);
  // 다른 동사의 -- 뒤는 지금처럼 위치 인자
  const p = await run(dir, ['prompt', 'nobody', '--', '-x']);
  assert.equal(p.code, 1); assert.match(p.stderr, /nobody/);
});

test('이어받는 세션에 --model·--effort·첫 프롬프트를 주면 아무것도 열지 않고 거절, 꺼진 세션이 없는 continue 는 새 세션 옵션으로', async () => {
  const dir = tmp('slcode-newopt-');
  const work = fs.realpathSync(tmp('slcode-work-'));
  EventLog.create(corePaths(dir).sessionsDir, { id: 'old11111', vendor: 'claude', cwd: work, title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false, closedAt: 5 }).close();
  const shim = fakeShim();
  for (const args of [['resume', 'old11111', '--effort', 'high'], ['resume', '--model', 'opus'], ['continue', '--', 'go'], ['import', 'v-1', '--effort', 'low']]) {
    const r = await run(dir, args, { cwd: work, env: shim.env });
    assert.equal(r.code, 2, args.join(' ')); assert.match(r.stderr, /only for a new session/, args.join(' '));
  }
  const r = await run(dir, ['resume', 'old11111', '--model', 'x', '--effort', 'low', '--', 'hi'], { env: shim.env });
  assert.match(r.stderr, /--model, --effort, -- <prompt> are only for a new session/);
  const empty = fs.realpathSync(tmp('slcode-work-'));
  const c = await run(dir, ['continue', '--effort', 'low', '--', 'go'], { cwd: empty, env: shim.env });
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(shim.calls(), [`slcode.new --cwd ${empty} --effort low --prompt go`]);
});

test('살아 있는 세션: --effort 는 meta.effort 로 시작하고 첫 프롬프트는 곧바로 첫 턴, 모델에 없는 effort 는 알린 뒤 벤더 기본', async (t) => {
  const dir = tmp('slcode-newopt-');
  const ok = await live(dir, ['new', tmp('slcode-work-'), '--no-web', '--vendor', 'codex', '--title', 'fit', '--effort', 'high', '--', 'hello', 'there']);
  t.after(ok.stop);
  assert.equal(metaOf(dir, 'fit')?.effort, 'high');
  await until(async () => (await events(dir, 'fit')).some((e) => e.kind === 'turn.start'));
  const ev = await events(dir, 'fit');
  assert.deepEqual(ev.filter((e) => e.kind === 'turn.start').map((e) => e.text), ['hello there'], '첫 프롬프트가 첫 턴');
  assert.ok(!ev.some((e) => e.kind === 'error'), JSON.stringify(ev));
  assert.equal(JSON.parse((await run(dir, ['status', 'fit', '--json'])).stdout).effort, 'high');

  const mis = await live(dir, ['new', tmp('slcode-work-'), '--no-web', '--vendor', 'codex', '--title', 'misfit', '--effort', 'max']);
  t.after(mis.stop);
  await until(async () => (await events(dir, 'misfit')).some((e) => e.kind === 'session.ready'));
  const ev2 = await events(dir, 'misfit');
  assert.ok(ev2.some((e) => e.kind === 'error' && /effort max 는 fake-model 모델에서 쓸 수 없습니다 \(low\|high\)/.test(e.message)), JSON.stringify(ev2));
  assert.equal(metaOf(dir, 'misfit')?.effort, null, 'meta.effort 를 비운다');
  assert.equal(JSON.parse((await run(dir, ['status', 'misfit', '--json'])).stdout).effort, 'medium', 'thread 의 effort(벤더 기본)');
  assert.ok(!ev2.some((e) => e.kind === 'turn.start'), '첫 프롬프트가 없으면 턴도 없다');
});
