// 프로필의 Claude system prompt 설정 (ticket slcode-profile-system-prompt, 사용자 결정 2026-11-17) — 블록 맞추기·조립(systemPrompt.ts), 프로필 저장(profiles.ts),
// 그리고 실제 claude CLI 를 가짜 Messages API 로 돌려(가짜 키, 비용 없음) 받아 오기·세션 적용·가져오기를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { agentPaths, readConfig, writeConfig } from 'slcode-plugin/agentPlugins';
import { addProfile, getProfile, profileSummary, sessionProfile, setProfile, setProfilePrompt } from '../src/profiles.ts';
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

test('profiles: 옛 프로필(systemPrompt 없음)은 그대로 열리고, 프롬프트 설정은 사용자 프로필에만 저장된다', async () => {
  const dir = tmp('dir'), ap = agentPaths(dir);
  // 이 기능 전의 config.json 꼴
  const old = { plugins: {}, rest: false, claude: { user: true, project: false, userMd: true, projectMd: true, builtinSkills: true } };
  writeConfig(ap, { ...readConfig(ap), profiles: { old } });
  assert.deepEqual(getProfile('old', dir), old);
  assert.equal(sessionProfile('old', dir).profile.claude.systemPrompt, undefined);
  assert.equal(profileSummary(getProfile('old', dir)!).includes('system prompt'), false);

  const spec = { pieces: [{ ...pieceKey('x', norm), off: true as const }], added: [] };
  await assert.rejects(setProfilePrompt('default', spec, dir), /built-in/);
  assert.deepEqual(await setProfilePrompt('default', spec, dir, 'lean'), { name: 'lean' });
  assert.deepEqual(getProfile('lean', dir)!.claude.systemPrompt, spec);
  assert.equal(getProfile('default', dir)!.claude.systemPrompt, undefined);
  await assert.rejects(setProfilePrompt('minimal', spec, dir, 'lean'), /already exists/);
  assert.match(profileSummary(getProfile('lean', dir)!), /system prompt 고침/);
  // 다른 설정을 바꿔도 프롬프트 설정은 남고, 새 프로필은 원본의 것을 물려받는다
  await setProfile('lean', ['claude.user=off'], dir);
  assert.deepEqual(getProfile('lean', dir)!.claude.systemPrompt, spec);
  await addProfile('lean2', 'lean', dir);
  assert.deepEqual(getProfile('lean2', dir)!.claude.systemPrompt, spec);
  // 비우면 필드가 사라진다 — 옛 프로필과 같은 꼴
  await setProfilePrompt('old', spec, dir);
  await setProfilePrompt('old', undefined, dir);
  assert.deepEqual(getProfile('old', dir), old);
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

test('claude: 편집 창이 받아 온 프롬프트로 저장한 설정이 세션에 적용되고, 프로필을 고쳐도 세션은 가져오기 전까지 그대로다', { timeout: 300000 }, async () => {
  const api = await fakeApi();
  const saved = { ...process.env };
  const home = tmp('home'), dir = tmp('state'), work = tmp('work');
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const { SLCODE_PROMPT } = await import('../src/prompt.ts');
  const { promptMethod } = await import('../src/promptMethods.ts');
  type View = { identity: string; items: PromptItem[]; tail: string; slcode: string };
  const turn = async (sock: string, id: string, text: string) => {
    const c = await connectSession(sock);
    let done!: () => void;
    const end = new Promise<void>((r) => (done = r));
    c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') done(); });
    try { await c.request('session.attach', { id }); await c.request('session.send', { id, text }); await end; return await c.request('session.plugins', { id }); } finally { c.close(); }
  };
  try {
    // 편집 창: 가져오기 → 블록 하나를 끄고, 하나를 고치고, 그 뒤에 글을 더해 새 프로필로 저장
    const view = await promptMethod(dir, work, 'prompt.fetch', { profile: 'default' }) as View;
    const pieces = view.items.filter((it): it is PromptItem & { kind: 'piece' } => it.kind === 'piece');
    assert.ok(pieces.filter((p) => p.known === 'builtin').length >= 10, `미리 나눠 둔 블록이 설치된 Claude Code 의 프롬프트에 맞는다 (${pieces.filter((p) => p.known === 'builtin').length}/${pieces.length})`);
    // tail(WebSearch 문단)은 원격 플래그가 넣는다 — 로그인 없는 이 격리 환경에서는 비어 있을 수 있다
    assert.equal(view.slcode, SLCODE_PROMPT);
    const off = pieces.find((p) => p.note === '보안 요청을 받는 기준')!, fix = pieces.find((p) => p.note === '사람을 가리키는 대명사')!;
    const list = edited(view.items, (it) => (it === off ? { off: true } : it === fix ? { edit: 'EDITED-PRONOUN-RULE' } : undefined));
    list.splice(view.items.indexOf(fix) + 1, 0, { kind: 'added', text: 'ADDED-BLOCK-TEXT' });
    assert.deepEqual(await promptMethod(dir, work, 'prompt.save', { profile: 'default', as: 'lean', items: list }), { name: 'lean' });
    assert.equal(JSON.stringify(getProfile('lean', dir)).includes(off.text.slice(0, 30)), false, '원문은 프로필에 남지 않는다');
    // 다시 열면 저장한 설정이 입혀져 보인다
    const reopened = (await promptMethod(dir, work, 'prompt.fetch', { profile: 'lean' }) as View).items;
    assert.equal(reopened.find((it) => it.kind === 'piece' && it.note === off.note)!.off, true);
    assert.equal(reopened.filter((it) => it.kind === 'added').length, 1);

    // 그 프로필의 세션 — 끈 블록은 빠지고 고친 글·더한 글·slcode 지시가 나간다. 정체성 한 줄과 Claude Code 가 붙이는 글은 그대로 한 번씩
    let h = await runCore({ dir, cwd: work, permissionMode: 'bypassPermissions', profile: 'lean' });
    const id = h.session.id;
    assert.equal((await turn(h.sock, id, 'one')).promptChanged, undefined);
    const sys = api.systems.at(-1)!, all = sys.join('\n\n');
    assert.match(sys[1], /^You are Claude Code/);
    assert.equal(all.includes(off.text), false);
    assert.equal(all.includes(fix.text), false);
    assert.ok(all.includes('EDITED-PRONOUN-RULE\n\nADDED-BLOCK-TEXT'));
    assert.ok(all.includes(SLCODE_PROMPT));
    if (view.tail) assert.equal(all.split(view.tail).length, 2, 'Claude Code 가 붙이는 글은 한 번만');
    const kept = pieces.find((p) => p.note === '에이전트 정체성')!;
    assert.ok(sys[2].includes(kept.text), '건드리지 않은 블록은 받은 글 그대로');
    await h.close('test');

    // 프로필에서 설정을 지웠다 — 세션을 다시 열어도 예전 프롬프트 그대로, 화면에는 바뀌었다고만
    await promptMethod(dir, work, 'prompt.save', { profile: 'lean', items: edited(view.items, () => undefined) });
    assert.equal(getProfile('lean', dir)!.claude.systemPrompt, undefined);
    h = await runCore({ dir, cwd: work, resume: id });
    assert.equal((await turn(h.sock, id, 'two')).promptChanged, true);
    assert.ok(api.systems.at(-1)!.join('\n\n').includes('EDITED-PRONOUN-RULE'));

    // 가져오기 — core 가 다시 뜨고 다음 턴부터 기본 프롬프트
    {
      const c = await connectSession(h.sock);
      await c.request('core.own', { pid: process.pid, follows: true });
      const replaced = new Promise<void>((r) => c.onEvent((m: any) => { if (m.event === 'core.replaced') r(); }));
      await c.request('session.pullPrompt', { id });
      await replaced;
      c.close();
    }
    await h.done;
    assert.equal((await turn(h.sock, id, 'three')).promptChanged, undefined);
    const back = api.systems.at(-1)!.join('\n\n');
    assert.equal(back.includes('EDITED-PRONOUN-RULE'), false);
    assert.ok(back.includes(off.text) && back.includes(SLCODE_PROMPT));
    { const c = await connectSession(h.sock); await c.request('session.close', { id }).catch(() => {}); c.close(); }
  } finally {
    api.srv.close(); api.srv.closeAllConnections();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
