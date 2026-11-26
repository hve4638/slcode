// 세션 구성 (ticket slcode-sidebar-revamp) — system prompt 출처 나누기·훅 목록·출처 이름 맞추기(preview.ts), 폴더 목록(file.list), 그리고 실제 claude CLI 를 가짜 Messages API 로 돌려(가짜 키, 비용 없음)
// session.promptPreview 가 세션이 보내는 것과 같은 system 을 주는지, session.sources 가 훅·스킬·서브에이전트·지시 파일의 출처를 주는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { labelSystem, listHooks, listStyles, originOf } from '../src/preview.ts';
import { fileList } from '../src/serve.ts';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `slcode-pv-${p}-`));
const write = (f: string, j: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j)); };

test('labelSystem: slcode 가 넣은 글을 찾아 자르고 나머지는 벤더 글, 빈 조각은 버린다', () => {
  const sys = ['billing', 'You are Claude Code.', 'STATIC', 'DYN\n\nSLCODE\n\nTEAM\n\ntail'];
  assert.deepEqual(labelSystem(sys, [{ source: 'slcode', text: 'SLCODE' }, { source: 'team', text: 'TEAM\n' }, { source: 'plugin', text: '' }]), [
    { source: 'vendor', text: 'billing' }, { source: 'vendor', text: 'You are Claude Code.' }, { source: 'vendor', text: 'STATIC' },
    { source: 'vendor', text: 'DYN' }, { source: 'slcode', text: 'SLCODE' }, { source: 'team', text: 'TEAM' }, { source: 'vendor', text: 'tail' },
  ]);
  assert.deepEqual(labelSystem(['AB'], [{ source: 'prompt', text: 'AB' }, { source: 'slcode', text: 'B' }]), [{ source: 'prompt', text: 'AB' }], '겹치면 앞서 잡힌 것');
});

test('listHooks: 실린 설정 범위의 파일·플러그인 hooks.json·plugin.json·에이전트 플러그인 js 훅', () => {
  const config = tmp('cfg'), cwd = tmp('cwd'), plug = tmp('plug'), agentPlug = tmp('agent');
  write(path.join(config, 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }] } });
  write(path.join(cwd, '.claude/settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } });
  write(path.join(cwd, '.claude/settings.local.json'), { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'check it' }] }] } });
  write(path.join(plug, 'hooks/hooks.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/start.sh' }] }] } });
  write(path.join(plug, '.claude-plugin/plugin.json'), { name: 'p', hooks: './extra.json' });
  write(path.join(plug, 'extra.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'extra' }] }] } });
  write(path.join(agentPlug, 'hooks/hooks.json'), { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] }] } });
  const all = listHooks({ settingSources: ['user', 'project', 'local'], configDir: config, cwd, plugins: [{ name: 'p', path: plug }, { name: 'orch@inline', path: agentPlug }], agent: ['orch'], scripts: [{ plugin: 'orch', regs: [{ event: 'UserPromptSubmit', matcher: null }] }] });
  assert.deepEqual(all, [
    { event: 'Stop', matcher: null, what: 'notify.sh', source: 'user', name: null },
    { event: 'PreToolUse', matcher: 'Bash', what: 'guard', source: 'project', name: null },
    { event: 'UserPromptSubmit', matcher: null, what: 'check it', source: 'local', name: null },
    { event: 'SessionStart', matcher: null, what: '${CLAUDE_PLUGIN_ROOT}/start.sh', source: 'plugin', name: 'p' },
    { event: 'Stop', matcher: null, what: 'extra', source: 'plugin', name: 'p' },
    { event: 'PostToolUse', matcher: 'Edit', what: 'fmt', source: 'agent', name: 'orch' },
    { event: 'UserPromptSubmit', matcher: null, what: 'js', source: 'agent', name: 'orch' },
  ]);
  assert.deepEqual(listHooks({ settingSources: ['user'], configDir: config, cwd, plugins: [], agent: [], scripts: [] }).map((h) => h.source), ['user'], '프로필이 끈 범위는 읽지 않는다');
});

test('originOf: Claude Code 가 준 출처 글을 맞춘다 — 에이전트 플러그인 이름이면 agent, SDK 옵션으로 넣은 MCP(sdk·dynamic)는 slcode, 모르는 글은 other', () => {
  const ag = ['orch'];
  assert.deepEqual(['userSettings', 'projectSettings', 'localSettings', 'policySettings', 'built-in', 'User', 'Project', 'Managed', 'sdk', 'dynamic', 'user', 'project', 'claudeai', 'agent', undefined].map((r) => originOf(r, null, ag)),
    ['user', 'project', 'local', 'managed', 'builtin', 'user', 'project', 'managed', 'slcode', 'slcode', 'user', 'project', 'claudeai', 'other', 'other']);
  assert.deepEqual([originOf('plugin', 'orch', ag), originOf('plugin', 'core', ag), originOf('plugin', null, ag)], ['agent', 'plugin', 'plugin']);
});

test('listStyles: 실린 설정 범위의 output-styles 파일 — 이름은 frontmatter name, 없으면 파일 이름', () => {
  const config = tmp('cfg'), cwd = tmp('cwd');
  fs.mkdirSync(path.join(config, 'output-styles'), { recursive: true });
  fs.writeFileSync(path.join(config, 'output-styles/terse.md'), '---\nname: Terse Style\ndescription: d\n---\nbody\n');
  fs.mkdirSync(path.join(cwd, '.claude/output-styles'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.claude/output-styles/plain.md'), 'no frontmatter\n');
  const base = { configDir: config, cwd, plugins: [], agent: [], scripts: [] };
  assert.deepEqual(listStyles({ ...base, settingSources: ['user', 'project', 'local'] }), [
    { name: 'Terse Style', source: 'user', plugin: null, path: path.join(config, 'output-styles/terse.md') },
    { name: 'plain', source: 'project', plugin: null, path: path.join(cwd, '.claude/output-styles/plain.md') },
  ]);
  assert.deepEqual(listStyles({ ...base, settingSources: ['project'] }).map((x) => x.name), ['plain'], '싣지 않은 범위는 뺀다');
});

test('file.list: 폴더 아래 파일을 하위 폴더까지 상대 경로로 — 숨김 항목·링크된 폴더는 빼고, 폴더가 아니면 던진다', () => {
  const d = tmp('list');
  fs.writeFileSync(path.join(d, 'SKILL.md'), 'abc');
  fs.mkdirSync(path.join(d, 'scripts/deep'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts/deep/a.sh'), 'x');
  fs.writeFileSync(path.join(d, '.hidden'), 'x');
  fs.symlinkSync(d, path.join(d, 'loop'));
  assert.deepEqual(fileList(d), { files: [{ path: 'SKILL.md', size: 3 }, { path: 'scripts/deep/a.sh', size: 1 }], truncated: false });
  assert.throws(() => fileList(path.join(d, 'SKILL.md')), /not a folder/);
  assert.throws(() => fileList('rel/path'), /absolute/);
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
  const messages: { role: string; content: string | { type: string; text?: string }[] }[][] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j: any = null; try { j = JSON.parse(body); } catch {}
      if (req.url?.startsWith('/v1/messages') && !req.url.includes('count_tokens')) {
        if (j?.stream && j.tools?.length) { systems.push(j.system.map((s: { text: string }) => s.text)); messages.push(j.messages); }
        if (j?.stream) res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(msg));
      } else res.writeHead(200, { 'content-type': 'application/json' }).end(req.url?.includes('count_tokens') ? '{"input_tokens":5}' : '{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { srv, systems, messages, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}` };
}

test('claude: session.promptPreview 는 세션이 실제로 보내는 system 과 같은 글을 출처를 달아 주고, session.sources 는 훅·스킬·서브에이전트·CLAUDE.md 의 출처를 준다', { timeout: 180000 }, async () => {
  const api = await fakeApi();
  const saved = { ...process.env };
  const home = tmp('home'), dir = tmp('state'), work = tmp('work');
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE') || k.startsWith('ANTHROPIC')) delete process.env[k];
  Object.assign(process.env, { HOME: home, ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEKEYFAKEKEY', ANTHROPIC_BASE_URL: api.url, SLCODE_GRACE_SECS: '1' });
  // 훅은 미리 보기 실행에서 돌지 않는다 — 돌면 이 파일이 생긴다
  const ran = path.join(home, 'hook-ran');
  write(path.join(home, '.claude/settings.json'), { outputStyle: 'my-style', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch ${ran}` }] }] } });
  fs.mkdirSync(path.join(home, '.claude/output-styles'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/output-styles/my-style.md'), '---\nname: my-style\ndescription: d\n---\nMY-STYLE-BODY\n');
  fs.mkdirSync(path.join(home, '.claude/skills/my-skill'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/skills/my-skill/SKILL.md'), '---\nname: my-skill\ndescription: test skill\n---\n\nbody\n');
  fs.mkdirSync(path.join(home, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/agents/my-agent.md'), '---\nname: my-agent\ndescription: test agent\n---\n\nbody\n');
  fs.writeFileSync(path.join(home, '.claude/CLAUDE.md'), '# mine\n');
  const { runCore } = await import('../src/core.ts');
  const { connectSession } = await import('../src/client.ts');
  const { SLCODE_PROMPT } = await import('../src/prompt.ts');
  const h = await runCore({ dir, cwd: work, permissionMode: 'bypassPermissions' });
  const c = await connectSession(h.sock);
  try {
    const id = h.session.id;
    await c.request('session.attach', { id });
    const pv = await c.request('session.promptPreview', { id }) as { blocks: { source: string; text: string }[]; context: string[] };
    assert.equal(fs.existsSync(ran), false, '미리 보기는 훅을 돌리지 않는다');
    assert.deepEqual(pv.blocks.filter((b) => b.source === 'slcode').map((b) => b.text), [SLCODE_PROMPT.trim()], 'slcode 지시는 한 조각');
    assert.ok(pv.blocks.some((b) => b.source === 'vendor' && /You are Claude Code/.test(b.text)), '벤더 글');
    // 세션이 실제로 보내는 글과 같다 — 조각을 이으면 받은 system 의 글이 모두 들어 있다(조각 사이 빈 줄만 뺀다)
    const n = (t: string) => t.replace(/\s+/g, '');
    const before = api.systems.length;
    let done!: () => void;
    const end = new Promise<void>((r) => (done = r));
    c.onEvent((m: any) => { if (m.event === 'session.event' && m.params.ev.kind === 'turn.end') done(); });
    await c.request('session.send', { id, text: 'one' });
    await end;
    const sent = api.systems.slice(before).at(-1)!;
    assert.equal(n(pv.blocks.map((b) => b.text).join('')), n(sent.join('')), '미리 본 글 = 첫 턴이 보낸 글');
    // messages 에 붙은 글도 같다 — 첫 턴의 messages 에서 우리가 친 글만 뺀 것
    const texts = api.messages.slice(before).at(-1)!.flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.filter((b) => b.type === 'text').map((b) => b.text ?? ''))).filter((t) => t !== 'one' && t.trim());
    assert.deepEqual(pv.context, texts, '미리 본 context = 첫 턴 messages 에 붙은 글');
    assert.ok(texts.some((t) => t.includes('# mine')), 'CLAUDE.md 는 context 에');
    assert.ok(texts.some((t) => t.includes('# Output Style: my-style\nMY-STYLE-BODY')), 'output style 은 system 이 아니라 context 에');
    const hk = await c.request('session.sources', { id }) as { supported: boolean; hooks: { event: string; source: string; what: string }[]; skills: { name: string; source: string; path: string | null }[]; agents: { name: string; source: string; path: string | null }[]; memory: { path: string; source: string }[]; styles: { name: string; source: string; path: string }[] };
    assert.equal(hk.supported, true);
    assert.deepEqual(hk.hooks.filter((x) => x.source === 'user').map((x) => [x.event, x.what]), [['UserPromptSubmit', `touch ${ran}`]]);
    assert.deepEqual(hk.skills.filter((x) => x.source !== 'builtin'), [{ name: 'my-skill', source: 'user', plugin: null, path: path.join(home, '.claude/skills/my-skill/SKILL.md') }], '사용자 스킬은 파일, 나머지는 내장');
    assert.ok(hk.skills.length > 1, 'Claude Code 내장 스킬도 목록에');
    assert.deepEqual(hk.agents.filter((x) => x.source !== 'builtin'), [{ name: 'my-agent', source: 'user', plugin: null, path: path.join(home, '.claude/agents/my-agent.md') }], '사용자 서브에이전트는 파일, 나머지는 내장');
    assert.ok(hk.agents.some((x) => x.source === 'builtin'), 'Claude Code 내장 서브에이전트');
    assert.deepEqual(hk.memory, [{ path: path.join(home, '.claude/CLAUDE.md'), source: 'user' }], '첫 메시지에 붙는 지시 파일');
    assert.deepEqual(hk.styles, [{ name: 'my-style', source: 'user', plugin: null, path: path.join(home, '.claude/output-styles/my-style.md') }], 'output style 파일');
  } finally {
    c.close();
    await h.close('test');
    api.srv.close(); api.srv.closeAllConnections();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
