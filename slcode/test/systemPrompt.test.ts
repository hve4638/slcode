// Claude system prompt (ticket slcode-profile-system-prompt 2026-11-17 → slcode-prompt-library 2026-11-19) — 블록 맞추기·조립(systemPrompt.ts), 목록·판(promptLibrary.ts),
// 옛 프로필 설정 옮기기(profiles.ts), 그리고 실제 claude CLI 를 가짜 Messages API 로 돌려(가짜 키, 비용 없음) 가져오기·저장·세션 적용·새 판 올리기·옛 세션 meta 를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { agentPaths, readConfig, writeConfig } from 'slcode-plugin/agentPlugins';
import { addProfile, getProfile, listProfiles, profileSummary, removePrompt, renamePrompt, sessionProfile, setProfile } from '../src/profiles.ts';
import { addVersion, copyPrompt, createPrompt, firstSpec, latestVersion, memoryDirOf, promptNames, readDescription, readVersion, sessionPrompt, writeDescription } from '../src/promptLibrary.ts';
import { BUILTIN_PIECES } from '../src/promptPieces.ts';
import { cleanSpec, compose, normalizer, pieceKey, sameSpec, segment, specOf, type EditedItem, type PromptItem, type PromptPiece } from '../src/systemPrompt.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-sp-${p}-`));
const norm = normalizer({ configDir: '/h/.claude', cwd: '/w/proj', home: '/h' });
const STATIC = '\nYou are an agent.\n\nIMPORTANT: be safe.\n\n# Harness\n - Output goes to a terminal.\n - Tools need permission.';
const DYNAMIC = 'Use they/them.\n\n# Memory\n\nMemory lives at `/h/.claude/projects/-w-proj/memory/`.\n\n```\nname: x\n\nbody\n```\n\nSave only facts.\n\n# Environment\n - Models: a, b.\n - Fast mode exists.';
const piece = (text: string, note: string): PromptPiece => ({ ...pieceKey(text, norm), note });
const BUILTIN = [
  piece('You are an agent.', '정체성'), piece('IMPORTANT: be safe.', '보안'), piece(' - Output goes to a terminal.', '터미널'), piece(' - Tools need permission.', '권한'),
  piece('Use they/them.', '대명사'), piece('Memory lives at `/h/.claude/projects/-w-proj/memory/`.\n\n```\nname: x\n\nbody\n```\n\nSave only facts.', '메모리'),
  piece(' - Models: a, b.', '모델'), piece(' - Fast mode exists.', 'fast'),
];
const edited = (items: PromptItem[], change: (it: PromptItem & { kind: 'piece' }) => Partial<EditedItem> | void): EditedItem[] =>
  items.map((it) => (it.kind === 'piece' ? { kind: 'piece', text: it.text, ...(it.note ? { note: it.note } : {}), ...(it.off ? { off: true } : {}), ...(it.edit !== undefined ? { edit: it.edit } : {}), ...change(it) } : { kind: it.kind, text: it.text }) as EditedItem);
const noted = (items: PromptItem[]) => items.map((it) => (it.kind === 'piece' ? it.note ?? '?' : it.kind === 'heading' ? it.text : '+'));

test('systemPrompt: 받은 글을 미리 나눠 둔 블록으로 맞추고, 아무것도 바꾸지 않으면 받은 글 그대로 조립한다', () => {
  const items = segment([STATIC, DYNAMIC], undefined, BUILTIN, norm);
  assert.deepEqual(noted(items), ['정체성', '보안', '# Harness', '터미널', '권한', '대명사', '# Memory', '메모리', '# Environment', '모델', 'fast']);
  assert.deepEqual(compose(items, 2), [STATIC, DYNAMIC]);
  // 표가 없으면 제목 줄 사이의 줄들이 한 덩어리 — 그래도 조립은 같다
  const bare = segment([STATIC, DYNAMIC], undefined, [], norm);
  assert.deepEqual(bare.map((it) => it.kind), ['piece', 'heading', 'piece', 'piece', 'heading', 'piece', 'heading', 'piece']);
  assert.deepEqual(compose(bare, 2), [STATIC, DYNAMIC]);
  // 해시는 세션마다 다른 경로를 자리표시로 바꾼 뒤 잰다 — 다른 홈·폴더의 같은 글이 같은 블록
  const other = normalizer({ configDir: '/home/u/.claude', cwd: '/src/app', home: '/home/u' });
  const moved = DYNAMIC.replace('/h/.claude/projects/-w-proj/memory/', '/home/u/.claude/projects/-src-app/memory/');
  assert.ok(segment([moved], undefined, BUILTIN, other).some((it) => it.kind === 'piece' && it.note === '메모리'));
});

test('systemPrompt: 끄기·고치기·더하기·나누기가 저장되고, 글이 바뀐 블록의 설정만 풀린다', () => {
  const items = segment([STATIC, DYNAMIC], undefined, BUILTIN, norm);
  const list = edited(items, (it) => (it.note === '메모리' || it.note === 'fast' ? { off: true } : it.note === '대명사' ? { edit: '한국어로 답한다.' } : undefined));
  list.splice(list.findIndex((it) => it.kind === 'piece' && it.text === 'Use they/them.') + 1, 0, { kind: 'added', text: '내가 더한 지침' });
  // 나누기 — '메모리' 를 첫 문단과 나머지로 (화면이 user 로 표시한다)
  const spec = specOf(list, norm)!;
  assert.deepEqual(spec.pieces.map((p) => [p.note, p.off ?? false, p.text ?? null]), [['대명사', false, '한국어로 답한다.'], ['메모리', true, null], ['fast', true, null]], '끄거나 고친 블록만 저장한다');
  assert.equal(JSON.stringify(spec).includes('Memory lives'), false, '받은 원문은 저장하지 않는다');
  assert.deepEqual(spec.added, [{ after: pieceKey('Use they/them.', norm).hash, text: '내가 더한 지침' }]);

  const out = compose(segment([STATIC, DYNAMIC], spec, BUILTIN, norm), 2);
  assert.equal(out[0], STATIC);
  assert.equal(out[1], '한국어로 답한다.\n\n내가 더한 지침\n\n# Environment\n - Models: a, b.', '끈 블록만 있는 절은 제목 줄도 빠진다');

  // Claude Code 가 메모리 블록의 문장 하나를 바꿨다 — 그 블록만 받은 글 그대로(끄기 풀림), 나머지 설정은 그대로
  const next = DYNAMIC.replace('Save only facts.', 'Save only durable facts.');
  const after = compose(segment([STATIC, next], spec, BUILTIN, norm), 2)[1];
  assert.ok(after.includes('Save only durable facts.') && after.includes('# Memory'));
  assert.ok(after.startsWith('한국어로 답한다.\n\n내가 더한 지침\n\n# Memory'));
  assert.equal(after.includes('Fast mode'), false);
  // 더한 글의 앞 블록이 바뀌어 없어지면 맨 끝에 둔다
  const gone = compose(segment([STATIC, DYNAMIC.replace('Use they/them.', 'Use they.')], spec, BUILTIN, norm), 2)[1];
  assert.ok(gone.startsWith('Use they.') && gone.endsWith('\n\n내가 더한 지침'));

  // 사용자가 나눈 블록은 설정이 없어도 저장되고, 저장된 블록이 미리 나눠 둔 것보다 먼저 맞는다
  const cut = edited(items, () => undefined);
  const at = cut.findIndex((it) => it.kind === 'piece' && it.text.startsWith('Memory lives'));
  cut.splice(at, 1, { kind: 'piece', text: 'Memory lives at `/h/.claude/projects/-w-proj/memory/`.', user: true, off: true }, { kind: 'piece', text: '```\nname: x\n\nbody\n```\n\nSave only facts.', user: true });
  const cutSpec = specOf(cut, norm)!;
  assert.equal(cutSpec.pieces.length, 2);
  const again = segment([STATIC, DYNAMIC], cutSpec, BUILTIN, norm).filter((it) => it.kind === 'piece' && it.known === 'profile');
  assert.equal(again.length, 2);
  assert.equal(compose(segment([STATIC, DYNAMIC], cutSpec, BUILTIN, norm), 2)[1].includes('Memory lives'), false);

  assert.equal(specOf(edited(items, () => undefined), norm), undefined, '바꾼 것이 없으면 저장할 것도 없다');
  assert.equal(cleanSpec({ pieces: [{ head: 1 }], added: [] }), undefined);
  assert.ok(sameSpec(undefined, { pieces: [], added: [] }) && !sameSpec(undefined, spec));
});

test('profiles: system-prompt 키로 고르고 되돌리며, 이름을 바꾸면 고른 프로필이 따르고, 고른 프로필이 있는 프롬프트는 지우지 못한다', async () => {
  const dir = tmp('dir');
  await addProfile('a', 'default', dir);
  await assert.rejects(setProfile('a', ['system-prompt=nope'], dir), /no system prompt nope/);
  createPrompt(dir, 'p1');
  assert.throws(() => createPrompt(dir, 'p1'), /already exists/);
  assert.throws(() => createPrompt(dir, '../x'), /prompt name/);
  await setProfile('a', ['system-prompt=p1'], dir);
  assert.equal(getProfile('a', dir)!.claude.prompt, 'p1');
  await addProfile('b', 'a', dir);
  assert.equal(getProfile('b', dir)!.claude.prompt, 'p1', '복제하면 같은 프롬프트를 고른다');
  // 복제는 판째·설명째, 이름 바꾸기는 고른 프로필도 고친다
  addVersion(dir, 'p1', { original: null, spec: null }); writeDescription(dir, 'p1', 'note');
  copyPrompt(dir, 'p1', 'p2');
  assert.deepEqual([latestVersion(dir, 'p2'), readDescription(dir, 'p2')], [1, 'note']);
  assert.throws(() => copyPrompt(dir, 'p1', 'p2'), /already exists/);
  await assert.rejects(renamePrompt('p1', 'p2', dir), /already exists/);
  await renamePrompt('p1', 'p0', dir);
  assert.deepEqual([getProfile('a', dir)!.claude.prompt, getProfile('b', dir)!.claude.prompt, latestVersion(dir, 'p1')], ['p0', 'p0', null]);
  await renamePrompt('p0', 'p1', dir);
  await assert.rejects(removePrompt('p1', dir), /used by profile a, b/);
  await setProfile('a', [], dir, ['system-prompt']);
  await setProfile('b', [], dir, ['system-prompt']);
  assert.equal(getProfile('a', dir)!.claude.prompt, undefined);
  assert.deepEqual(await removePrompt('p1', dir), { name: 'p1', removed: true });
  assert.equal(latestVersion(dir, 'p1'), null);
});

test('promptLibrary: 판은 하나씩 오르고, 처음 가져올 때 기본으로 끄는 블록을 끄고, 세션 글은 자리표시를 세션 값으로 바꾼다', () => {
  const dir = tmp('lib');
  createPrompt(dir, 'p');
  assert.equal(latestVersion(dir, 'p'), 0);
  assert.equal(latestVersion(dir, 'q'), null);
  const blocks = [STATIC, norm(DYNAMIC)];
  assert.ok(blocks[1].includes('<memory>/memory/'), '원본은 자리표시로 저장한다');
  const original = { fetchedAt: 1, model: 'haiku', identity: 'You are Claude Code.', blocks, tail: '' };
  assert.equal(addVersion(dir, 'p', { original: null, spec: null }).version, 1);
  assert.equal(addVersion(dir, 'p', { original, spec: { pieces: [{ ...pieceKey('Use they/them.', norm), text: 'Use <cwd> as home.' }], added: [] } }).version, 2);
  assert.equal(latestVersion(dir, 'p'), 2);
  assert.deepEqual(readVersion(dir, 'p', 2)!.original, original);

  // 세션 — 고친 글의 자리표시도 바뀐다. 메모리 자리는 git 이 아니면 작업 폴더로
  const cwd = tmp('cwd'), at = { configDir: '/u/.claude', cwd, home: '/u' };
  const out = sessionPrompt(dir, { name: 'p', version: 2 }, at);
  assert.ok('blocks' in out);
  assert.ok(out.blocks[1].startsWith(`Use ${cwd} as home.`));
  assert.ok(out.blocks[1].includes(`${memoryDirOf('/u/.claude', cwd)}/memory/`));
  assert.equal(memoryDirOf('/u/.claude', cwd), `/u/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, '-')}`);
  assert.match((sessionPrompt(dir, { name: 'p', version: 1 }, at) as { why: string }).why, /v1 이 비었습니다/);
  // 원본 없이 직접 쓴 판 — 더한 블록만 한 덩어리로, 끈 것은 빠진다
  addVersion(dir, 'p', { original: null, spec: { pieces: [], added: [{ after: null, text: 'Mine in <cwd>.' }, { after: null, text: 'Off.', off: true }, { after: null, text: 'Two.' }] } });
  assert.deepEqual(sessionPrompt(dir, { name: 'p', version: 3 }, at), { blocks: [`Mine in ${cwd}.\n\nTwo.`] });
  assert.match((sessionPrompt(dir, { name: 'p', version: 9 }, at) as { why: string }).why, /v9 이 없습니다/);
  assert.match((sessionPrompt(dir, { name: 'gone', version: 1 }, at) as { why: string }).why, /없습니다/);

  // 기본으로 끄는 블록 — 미리 나눠 둔 표의 off. 앞 판이 정한 블록은 앞 판의 것
  const offs = BUILTIN_PIECES.filter((b) => b.off);
  assert.ok(offs.length >= 1);
  const fake = offs.map((b) => b.note!); // 해시가 맞는 글은 없으니, 맞는 경우는 실제 claude 테스트에서 본다
  assert.equal(firstSpec([STATIC], null), undefined, `맞는 블록이 없으면 설정도 없다 (${fake.join(', ')})`);
  const prev = { pieces: [{ ...pieceKey('x', norm), off: true as const }], added: [] };
  assert.deepEqual(firstSpec([STATIC], prev), prev);
});

/** Messages API 흉내 — 본 요청(도구가 있는 것)의 system 글들을 모으고 "hi" 로 답한다 */
async function fakeApi() {
  const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } };
  const sse = [
    ['message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  const systems: string[][] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j: any = null; try { j = JSON.parse(body); } catch {}
      if (req.url?.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
        if (j?.stream && j.tools?.length) systems.push(j.system.map((s: { text: string }) => s.text));
        if (j?.stream) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(msg));
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.includes('count_tokens') ? '{"input_tokens":5}' : '{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, systems, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('claude: 가져온 원본이 판으로 저장되고, 세션은 그 판을 다시 받지 않고 보내며, 새 판은 사이드바에서 올린다', { timeout: 300000 }, async () => {
  const api = await fakeApi();
  const saved = { ...process.env };
  const home = tmp('home'), dir = tmp('state'), work = tmp('work');
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const { SLCODE_PROMPT } = await import('../src/prompt.ts');
  const { promptMethod } = await import('../src/promptMethods.ts');
  const { EventLog } = await import('../src/eventLog.ts');
  type View = { version: number; latest: number; description: string; original: boolean; fetchedAt: number | null; identity: string; items: PromptItem[]; tail: string; slcode: string };
  const call = (m: string, p: unknown) => promptMethod(dir, work, m as never, p);
  const turn = async (sock: string, id: string, text: string) => {
    const c = await connectSession(sock);
    let done!: () => void;
    const end = new Promise<void>((r) => (done = r));
    c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') done(); });
    try { await c.request('session.attach', { id }); await c.request('session.send', { id, text }); await end; return await c.request('session.systemPrompt', { id }) as any; } finally { c.close(); }
  };
  const setPrompt = async (sock: string, id: string, name: string | null) => {
    const c = await connectSession(sock);
    await c.request('core.own', { pid: process.pid, follows: true });
    const replaced = new Promise<void>((r) => c.onEvent((m: any) => { if (m.event === 'core.replaced') r(); }));
    await c.request('session.setSystemPrompt', { id, name });
    await replaced;
    c.close();
  };
  try {
    // 새 프롬프트 — 판 없음, 원본 없음
    assert.deepEqual(await call('prompt.create', { name: 'lean' }), { name: 'lean' });
    const empty = await call('prompt.get', { name: 'lean' }) as View;
    assert.deepEqual([empty.version, empty.original, empty.items.length], [0, false, 0]);
    // 가져오기 — 곧바로 v1, 기본으로 끄는 블록은 꺼진 채
    const view = await call('prompt.fetch', { name: 'lean' }) as View;
    assert.deepEqual([view.version, view.latest, view.original], [1, 1, true]);
    assert.match(view.description, /^from Claude on \d\d\.\d\d\.\d\d$/, '처음 가져오면 설명을 채운다');
    assert.equal(view.slcode, SLCODE_PROMPT);
    const pieces = view.items.filter((it): it is PromptItem & { kind: 'piece' } => it.kind === 'piece');
    assert.ok(pieces.filter((p) => p.known === 'builtin').length >= 10, `미리 나눠 둔 블록이 설치된 Claude Code 의 프롬프트에 맞는다 (${pieces.filter((p) => p.known === 'builtin').length}/${pieces.length})`);
    const offByDefault = pieces.filter((p) => BUILTIN_PIECES.some((b) => b.off && b.hash === p.hash));
    assert.ok(offByDefault.length >= 1 && offByDefault.every((p) => p.off), '처음 가져오면 기본으로 끄는 블록이 꺼져 있다');
    assert.equal(JSON.stringify(view.items).includes(home), false, '원본의 홈 경로는 자리표시로');
    // 설명은 언제든 고치고 판은 오르지 않는다
    assert.deepEqual(await call('prompt.describe', { name: 'lean', description: ' mine ' }), { name: 'lean', description: 'mine' });
    assert.deepEqual([(await call('prompt.get', { name: 'lean' }) as View).description, (await call('prompt.get', { name: 'lean' }) as View).latest], ['mine', 1]);
    // 다시 열면 받지 않고 같은 판
    const again = await call('prompt.get', { name: 'lean' }) as View;
    assert.deepEqual(again.items, view.items);

    // 끄고·고치고·더해 저장 — v2
    const off = pieces.find((p) => p.note === '보안 요청을 받는 기준')!, fix = pieces.find((p) => p.note === '사람을 가리키는 대명사')!;
    const list = edited(view.items, (it) => (it === off ? { off: true } : it === fix ? { edit: 'EDITED-PRONOUN-RULE in <cwd>' } : undefined));
    list.splice(view.items.indexOf(fix) + 1, 0, { kind: 'added', text: 'ADDED-BLOCK-TEXT' });
    const v2 = await call('prompt.save', { name: 'lean', base: 1, items: list }) as View;
    assert.equal(v2.version, 2);
    assert.equal((await call('prompt.get', { name: 'lean' }) as View).items.find((it) => it.kind === 'piece' && it.note === off.note)!.off, true);
    await assert.rejects(call('prompt.save', { name: 'lean', base: 9, items: list }), /has no v9/);
    // 직접 쓰기 — 원본 없이 더한 블록만의 판 (사용자 2026-11-21)
    await call('prompt.create', { name: 'own' });
    const own = await call('prompt.save', { name: 'own', base: 0, items: [{ kind: 'added', text: 'OWN-RULE', note: 'mine' }] }) as View;
    assert.deepEqual([own.version, own.original, own.items.map((it) => [it.kind, it.text, it.note])], [1, false, [['added', 'OWN-RULE', 'mine']]]);
    // 권장 설정 없이 가져오기 — 블록은 나누되 모두 켠 채
    await call('prompt.create', { name: 'raw' });
    const raw = await call('prompt.fetch', { name: 'raw', recommended: false }) as View;
    assert.ok(raw.items.some((it) => it.kind === 'piece' && it.known === 'builtin') && !raw.items.some((it) => it.kind !== 'heading' && it.off), '권장 설정을 끄면 꺼진 블록이 없다');
    await call('prompt.remove', { name: 'own' }); await call('prompt.remove', { name: 'raw' });

    // 프로필이 고르고, 그 프로필의 세션 — 끈 블록은 빠지고 고친 글(자리표시는 작업 폴더로)·더한 글·slcode 지시가 나간다
    await addProfile('lean', 'default', dir);
    await setProfile('lean', ['system-prompt=lean'], dir);
    assert.deepEqual(((await call('prompt.list', {})) as { prompts: unknown[] }).prompts, [{ name: 'lean', latest: 2, fetchedAt: view.fetchedAt, model: null, description: 'mine', usedBy: ['lean'] }]);
    let h = await runCore({ dir, cwd: work, permissionMode: 'bypassPermissions', profile: 'lean' });
    const id = h.session.id;
    assert.deepEqual(EventLog.open(path.join(dir, 'sessions'), id)!.meta.prompt, { name: 'lean', version: 2 });
    const st = await turn(h.sock, id, 'one');
    assert.deepEqual([st.current, st.latest, st.failed], [{ name: 'lean', version: 2 }, 2, null]);
    const sys = api.systems.at(-1)!, all = sys.join('\n\n');
    assert.match(sys[1], /^You are Claude Code/);
    assert.equal(all.includes(off.text), false);
    assert.equal(all.includes(fix.text), false);
    assert.ok(all.includes(`EDITED-PRONOUN-RULE in ${work}\n\nADDED-BLOCK-TEXT`), '고친 글의 <cwd> 는 세션의 작업 폴더로');
    assert.ok(all.includes(SLCODE_PROMPT));
    assert.equal(/<(memory|config|cwd|home)>/.test(all), false, '자리표시가 남지 않는다');
    if (view.tail) assert.equal(all.split(view.tail).length, 2, 'Claude Code 가 붙이는 글은 한 번만');
    assert.ok(sys[2].includes(pieces.find((p) => p.note === '에이전트 정체성')!.text), '건드리지 않은 블록은 받은 글 그대로');
    await h.close('test');

    // 모두 되돌린 v3 — 세션을 다시 열어도 v2 그대로, 사이드바에 새 판
    await call('prompt.save', { name: 'lean', base: 2, items: edited(view.items, () => ({ off: false })) });
    h = await runCore({ dir, cwd: work, resume: id });
    assert.deepEqual([(await turn(h.sock, id, 'two')).latest], [3]);
    assert.ok(api.systems.at(-1)!.join('\n\n').includes('EDITED-PRONOUN-RULE'));
    // 올리기 — core 가 다시 뜨고 다음 턴부터 v3
    await setPrompt(h.sock, id, 'lean');
    await h.done;
    assert.deepEqual((await turn(h.sock, id, 'three')).current, { name: 'lean', version: 3 });
    const back = api.systems.at(-1)!.join('\n\n');
    assert.equal(back.includes('EDITED-PRONOUN-RULE'), false);
    assert.ok(back.includes(off.text) && back.includes(SLCODE_PROMPT));
    { const c = await connectSession(h.sock); await c.request('session.close', { id }).catch(() => {}); c.close(); }
    // 올린 뒤의 core 는 다른 프로세스다 — 소켓이 닫힐 때까지 (상한 15초)
    for (const until = Date.now() + 15000; Date.now() < until;) {
      const c = await connectSession(h.sock).catch(() => null);
      if (!c) break;
      c.close(); await new Promise((r) => setTimeout(r, 100));
    }

    // 0.6.0 의 세션 meta(systemPrompt 블록 설정, prompt 없음) — 그대로 열리고 벤더 기본으로 뜬다
    const legacy = EventLog.open(path.join(dir, 'sessions'), id)!;
    const metaFile = path.join(legacy.dir, 'meta.json'), m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    delete m.prompt; m.systemPrompt = { pieces: [{ ...pieceKey('x', norm), off: true }], added: [] };
    fs.writeFileSync(metaFile, JSON.stringify(m));
    h = await runCore({ dir, cwd: work, resume: id });
    assert.deepEqual((await turn(h.sock, id, 'four')).current, null);
    const vendor = api.systems.at(-1)!.join('\n\n');
    assert.ok(vendor.includes(off.text));
    // auto memory 를 끈다 — 벤더 기본에도, 가져온 판에도 메모리 절이 없다 (ticket slcode-claude-auto-memory-off)
    const mem = (t: string) => t.match(/\S*\/projects\/[^\s/`]+\/memory\//)?.[0];
    assert.equal(mem(vendor), undefined, '벤더 기본에 메모리 절이 없다');
    assert.equal(mem(back), undefined, '가져온 판에 메모리 절이 없다');
    { const c = await connectSession(h.sock); await c.request('session.close', { id }).catch(() => {}); c.close(); }
  } finally {
    api.srv.close(); api.srv.closeAllConnections();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
