// 애드온을 세션과 CLI 로 (ticket slcode-plugin-addon) — 가짜 codex 세션에 베이스·애드온·애드온의 애드온을 실어 지시문·skill 이 베이스 이름 아래 들어가고 when.part 사슬이 이어지는 것,
// 판이 맞지 않는 애드온의 세션 알림, slcode plugin remove 의 --cascade, 프로필 키. 형식·빌드의 세부는 slcode-plugin/test/addon.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { serveSession } from '../src/serve.ts';
import { connectSession } from '../src/client.ts';
import { EventLog } from '../src/eventLog.ts';
import { corePaths } from '../src/paths.ts';
import { addProfile, getProfile, setProfile } from '../src/profiles.ts';
import { addPlugin, listPlugins } from 'slcode-plugin/agentPlugins';

const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const CLI = path.resolve(import.meta.dirname, '..', 'src', 'cli.ts');
const TSX = import.meta.resolve('tsx');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-pa-${p}-`));
async function until(f: () => boolean, ms = 10000) { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(100); assert.ok(f(), 'timed out'); }
function source(manifest: { name: string; addon?: object; parts: Record<string, object> }): string {
  const src = tmp('src');
  fs.writeFileSync(path.join(src, manifest.addon ? 'slcode-addon.json' : 'slcode-plugin.json'), JSON.stringify(manifest));
  for (const p of Object.keys(manifest.parts)) {
    fs.mkdirSync(path.join(src, p, 'instructions'), { recursive: true });
    fs.writeFileSync(path.join(src, p, 'instructions', `${p}.md`), `${p} rule`);
    fs.mkdirSync(path.join(src, p, 'skills', `${p}-skill`), { recursive: true });
    fs.writeFileSync(path.join(src, p, 'skills', `${p}-skill`, 'SKILL.md'), `---\ndescription: ${p}\n---\nbody`);
  }
  return src;
}
const BASE = { name: 'superlite', version: '0.4.0', parts: { main: { required: true } } };
const ORCH = { name: 'orchestration', version: '0.5.0', addon: { base: 'superlite', version: '^0.4.0' }, parts: { orch: { when: { part: { main: true }, param: { ROLE: true } } } } };
const DEEP = { name: 'deep', version: '0.1.0', addon: { base: 'orchestration', version: '^0.5.0' }, parts: { leaf: { when: { part: { orch: true } } } } };

test('가짜 codex 세션: 베이스·애드온·애드온의 애드온이 베이스 이름 하나로 실리고 when.part 사슬이 베이스까지 이어진다. 판이 맞지 않으면 빠지고 세션이 알린다', async () => {
  const saved = { ...process.env };
  const dir = tmp('state'), work = tmp('work');
  const calls = path.join(dir, 'calls.jsonl');
  Object.assign(process.env, { SLCODE_GRACE_SECS: '1', SLCODE_CODEX_BIN: `${process.execPath} ${FAKE}`, FAKE_CODEX_CALLS: calls });
  await addPlugin(source(BASE), dir);
  await addPlugin(source(ORCH), dir);
  await addPlugin(source(DEEP), dir);
  const open = async (params: Record<string, string> | undefined) => {
    fs.rmSync(calls, { force: true });
    const h = await serveSession({ dir, cwd: work, vendor: 'codex', web: false, ...(params ? { params } : {}) });
    try {
      await until(() => fs.existsSync(calls) && fs.readFileSync(calls, 'utf8').includes('thread/'));
      const c = await connectSession(h.sock);
      let p: any;
      try { await c.request('session.attach', { id: h.session.id }); p = await c.request('session.plugins', { id: h.session.id }); } finally { c.close(); }
      const start = JSON.parse(fs.readFileSync(calls, 'utf8').split('\n').find((l) => l.includes('thread/'))!);
      const links = path.join(EventLog.open(corePaths(dir).sessionsDir, h.session.id)!.dir, 'agent-plugins');
      return { p, developer: start.developerInstructions as string, links: fs.readdirSync(links), root: fs.readlinkSync(path.join(links, 'superlite')), id: h.session.id };
    } finally { await h.close(); }
  };
  try {
    const w = await open({ ROLE: 'w' });
    assert.deepEqual(w.p.plugins.map((x: any) => [x.name, x.version, x.values]), [['superlite', '0.4.0', 'part.leaf=1,part.main=1,part.orch=1']], '플러그인은 베이스 하나, 사슬이 모두 켜진다');
    assert.deepEqual(w.links, ['superlite'], '세션 링크도 베이스 이름 하나');
    for (const r of ['main rule', 'orch rule', 'leaf rule']) assert.ok(w.developer.includes(r), w.developer);
    for (const k of ['main', 'orch', 'leaf']) assert.ok(fs.existsSync(path.join(w.root, 'skills', `${k}-skill`, 'SKILL.md')), k);
    const none = await open(undefined);
    assert.equal(none.p.plugins[0].values, 'part.leaf=0,part.main=1,part.orch=0', '인자가 없으면 orch 가 꺼지고 거기 걸린 leaf 도 꺼진다');
    assert.ok(!none.developer.includes('leaf rule'));

    await addPlugin(source({ ...BASE, version: '0.5.0' } as typeof BASE), dir);
    const old = await open({ ROLE: 'w' });
    assert.equal(old.p.plugins[0].values, 'part.main=1', '베이스는 새 판, 애드온은 빠진다');
    assert.equal(old.p.plugins[0].version, '0.5.0');
    const log = EventLog.open(corePaths(dir).sessionsDir, old.id)!;
    const notices = log.since(0).filter((e: any) => e.ev.kind === 'error').map((e: any) => e.ev.message ?? '');
    assert.ok(notices.some((m: string) => m.includes('superlite: addon orchestration left out: needs superlite ^0.4.0, installed 0.5.0')), JSON.stringify(notices));
    assert.ok(notices.some((m: string) => m.includes('addon deep left out: base addon orchestration is left out')), JSON.stringify(notices));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('CLI: plugin remove 는 의존이 있으면 거절하고 --cascade 로 함께 지운다. list 는 애드온과 빠진 사유를 보인다', async () => {
  const dir = tmp('state');
  const run = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => execFile(process.execPath, ['--import', TSX, CLI, 'plugin', ...args, '--dir', dir], { env: { ...process.env, SLCODE_DIR: dir } }, (e, stdout, stderr) => resolve({ code: (e as { code?: number } | null)?.code ?? 0, stdout, stderr })));
  assert.equal((await run(['add', source(BASE)])).code, 0);
  assert.equal((await run(['add', source(ORCH)])).code, 0);
  const list = (await run(['list'])).stdout;
  assert.match(list, /orch on \(addon orchestration\) \(when part main param ROLE\)/);
  assert.match(list, /addons {3}orchestration 0\.5\.0/);
  const no = await run(['remove', 'superlite']);
  assert.notEqual(no.code, 0);
  assert.match(no.stderr, /orchestration depend on superlite: remove them first or use --cascade/);
  assert.equal(listPlugins(dir).length, 1, '거절이면 그대로');
  const yes = await run(['remove', 'superlite', '--cascade']);
  assert.equal(yes.code, 0, yes.stderr);
  assert.deepEqual(JSON.parse(yes.stdout), { name: 'superlite', removed: true, addons: ['orchestration'] });
  assert.equal(listPlugins(dir).length, 0);
});

test('프로필: 애드온은 고를 수 없고 안내 오류, part·옵션은 베이스 이름 아래 키로 받는다', async () => {
  const dir = tmp('state');
  await addPlugin(source(BASE), dir);
  await addPlugin(source({ ...ORCH, parts: { orch: {} } }), dir);
  await addProfile('p1', 'default', dir);
  await assert.rejects(setProfile('p1', ['orchestration=off'], dir), /orchestration is an addon of superlite and loads with it: use superlite\.<part>=on\|off/);
  await assert.rejects(setProfile('p1', ['orchestration.orch=off'], dir), /is an addon of superlite/);
  await setProfile('p1', ['superlite.orch=off'], dir);
  assert.deepEqual(getProfile('p1', dir)!.plugins.superlite, { parts: { orch: false } });
  await assert.rejects(setProfile('p1', ['superlite.nope=on'], dir), /no part or option named nope/);
});
