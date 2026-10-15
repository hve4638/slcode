// 벤더 기록 → 이벤트 (ticket slcode-import-history) — 실제 기록(test/fixtures: 2026-10-15 에 claude -p·codex exec 로 만든 두 턴 세션.
// Claude 는 user·assistant 만 남기고 parentUuid 를 다시 이었다, 폴더는 __CWD__)으로 변환과 이어 붙이기를 본다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLog } from '../src/eventLog.ts';
import { claudeEvents, codexEvents, pullHistory } from '../src/history.ts';
import type { CoreEvent } from '../src/protocol.ts';

const FIX = path.join(import.meta.dirname, 'fixtures');
const CID = 'eca2ea0c-cd14-4216-b88c-558435351e88';
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rows = () => fs.readFileSync(path.join(FIX, 'claude-session.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const U = rows().map((r) => r.uuid); // 0 프롬프트1 … 4 답1, 5 프롬프트2 … 8 답2
const turns = () => JSON.parse(fs.readFileSync(path.join(FIX, 'codex-turns.json'), 'utf8'));

/** 가짜 CLAUDE_CONFIG_DIR 에 기록 하나 — 테스트마다 새 홈 */
function claudeHome(rs: object[]) {
  const work = tmp('slcode-h-work-'), home = tmp('slcode-h-claude-');
  const pd = path.join(home, 'projects', work.replace(/[^A-Za-z0-9-]/g, '-'));
  fs.mkdirSync(pd, { recursive: true });
  const file = path.join(pd, `${CID}.jsonl`);
  const write = (r: object[]) => fs.writeFileSync(file, r.map((o) => JSON.stringify(o).replaceAll('__CWD__', work)).join('\n') + '\n');
  write(rs);
  process.env.CLAUDE_CONFIG_DIR = home;
  return { work, write };
}
const newLog = (vendor: 'claude' | 'codex', cwd: string) =>
  EventLog.create(path.join(tmp('slcode-h-'), 'sessions'), { id: 'aaaa0001', vendor, cwd, title: null, vendorSessionId: null, createdAt: 1, permissionMode: null, raw: false });
const evs = (log: EventLog) => log.all.map((e) => e.ev);
const end = (e: CoreEvent) => e as Extract<CoreEvent, { kind: 'turn.end' }>;

test('claudeEvents: 실제 기록 — 프롬프트마다 turn.start, 도구 짝, turn.end 에 프롬프트 uuid·마지막 항목 uuid·사용량', async () => {
  const { getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk');
  const { work } = claudeHome(rows());
  const out = claudeEvents((await getSessionMessages(CID)) as any).map((e) => e.ev);
  assert.deepEqual(out.map((e) => e.kind), ['turn.start', 'tool.start', 'tool.end', 'text.delta', 'turn.end', 'turn.start', 'tool.start', 'tool.end', 'text.delta', 'turn.end'], '빈 thinking 은 버린다');
  assert.equal((out[0] as any).text, 'Create a file named hello.txt containing exactly the word hi. Then reply with one short sentence.');
  assert.deepEqual([(out[1] as any).name, (out[1] as any).input.file_path], ['Write', path.join(work, 'hello.txt')]);
  assert.equal((out[2] as any).ok, true);
  const [e1, e2] = [end(out[4]), end(out[9])];
  assert.deepEqual([e1.userUuid, e1.uuid, e2.userUuid, e2.uuid], [U[0], U[4], U[5], U[8]]);
  assert.equal((out[7] as any).summary, '1\thi');
  assert.ok(e1.usage && e1.usage.output > 0 && e1.durationMs! > 0, JSON.stringify(e1));
  assert.equal(e1.costUsd, null);
});

test('claudeEvents: SDK 가 주는 꼴 — compact 요약·로컬 명령·슬래시 명령·! 셸·중단·작업 알림·이미지', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, s)).toISOString();
  const u = (uuid: string, content: unknown, extra: object = {}) => ({ type: 'user', uuid, timestamp: at(0), message: { role: 'user', content }, ...extra });
  const a = (uuid: string, content: unknown[], s = 1) => ({ type: 'assistant', uuid, timestamp: at(s), message: { id: `m-${uuid}`, role: 'assistant', content, usage: { input_tokens: 1, output_tokens: 2 } } });
  const out = claudeEvents([
    u('cs', 'This session is being continued…', { isCompactSummary: true, is_meta: true }),
    a('pre', [{ type: 'text', text: 'kept' }]), // compact 이 남긴 앞 대화 — 프롬프트 없이 시작한다
    u('lc1', '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>', { isCompletedLocalCommand: true }),
    u('lc2', '<local-command-stdout>Set model</local-command-stdout>', { isCompletedLocalCommand: true }),
    u('p1', '<command-message>core:b</command-message>\n<command-name>/core:b</command-name>\n<command-args>fix it</command-args>', { origin: { kind: 'human' } }),
    u('meta', [{ type: 'text', text: 'skill body' }], { is_meta: true }),
    a('a1', [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    u('r1', [{ type: 'tool_result', tool_use_id: 't1', content: 'denied', is_error: true }, { type: 'text', text: '[Request interrupted by user for tool use]' }]),
    u('p2', '<bash-input>pwd</bash-input>'),
    u('o2', '<bash-stdout>/w</bash-stdout><bash-stderr></bash-stderr>'),
    u('p3', [{ type: 'text', text: 'look [Image #1]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]),
    a('a3', [{ type: 'text', text: 'a cat' }], 3),
    u('n4', '<task-notification>done</task-notification>', { origin: { kind: 'task-notification' } }),
    a('a4', [{ type: 'text', text: 'task finished' }], 5),
    u('p5', 'hello'),
    { type: 'assistant', uuid: 'a5', timestamp: at(6), error: 'authentication_failed', message: { id: 'm5', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } },
  ] as any).map((e) => e.ev as any);
  assert.deepEqual(out.map((e) => e.kind), ['context.compacted', 'text.delta', 'turn.end', 'turn.start', 'thinking.delta', 'tool.start', 'tool.end', 'turn.end', 'turn.start', 'text.delta', 'turn.end', 'turn.start', 'text.delta', 'turn.end', 'text.delta', 'turn.end', 'turn.start', 'turn.end']);
  assert.deepEqual([out[2].userUuid, out[2].uuid], [null, 'pre'], 'compact 뒤 남은 앞 대화는 turn.start 없는 턴');
  assert.equal(out[3].text, '/core:b fix it');
  assert.deepEqual([out[6].ok, out[7].interrupted, out[7].ok, out[7].uuid], [false, true, false, 'r1']);
  assert.deepEqual([out[8].text, out[9].text], ['! pwd', '```\n/w\n```']);
  assert.deepEqual(out[11].attachments, [{ name: 'image 1', mediaType: 'image/png', size: 3 }]);
  assert.equal(out[13].durationMs, 3000);
  assert.deepEqual([out[15].userUuid, out[15].uuid], ['n4', 'a4'], '작업 알림 턴은 말풍선 없이 응답만');
  assert.deepEqual([out[17].ok, out[17].error, out[17].errorKind], [false, 'Not logged in · Please run /login', 'auth'], '인증 실패 문구는 답변이 아니라 실패 (ticket slcode-auth-error-shown-as-answer)');
});

test('codexEvents: 실제 기록 — 턴마다 turn.start·도구 짝·turn.end(uuid 는 turn id), 진행 중 턴은 미룬다', () => {
  const t = turns();
  const fail = { id: 'bad', status: 'failed', error: { message: 'unexpected status 401 Unauthorized', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }, items: [{ type: 'userMessage', content: [{ type: 'text', text: 'y' }] }] };
  const out = codexEvents([...t, fail, { id: 'busy', status: 'inProgress', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'x' }] }] }]).map((e) => e.ev as any);
  assert.deepEqual(out.map((e) => e.kind), ['turn.start', 'text.delta', 'tool.start', 'tool.end', 'text.delta', 'turn.end', 'turn.start', 'text.delta', 'tool.start', 'tool.end', 'text.delta', 'turn.end', 'turn.start', 'turn.end'], '빈 reasoning 은 버린다');
  assert.deepEqual([out[13].ok, out[13].error, out[13].errorKind, out[13].uuid], [false, 'unexpected status 401 Unauthorized', 'auth', 'bad']);
  assert.equal(out[0].text, 'Create a file named hello.txt containing exactly the word hi using a shell command, then reply with one short sentence.');
  assert.equal(out[2].name, 'Bash');
  assert.deepEqual([out[9].ok, out[9].summary], [true, 'hi']);
  assert.deepEqual([out[5].uuid, out[11].uuid, out[5].durationMs, out[5].ok], [t[0].id, t[1].id, t[0].durationMs, true]);
});

test('pullHistory(claude): 처음엔 전부 + 표지, 다시 부르면 늘어난 턴만, 벤더 쪽 되돌림은 turn.rewound, 모르는 지점이면 null', async () => {
  const all = rows();
  const { work, write } = claudeHome(all.slice(0, 5)); // 첫 턴만
  const log = newLog('claude', work);
  assert.deepEqual(await pullHistory(log, CID, { vendorSessionId: 'orig', fork: true }), { turns: 1, rewound: false });
  assert.deepEqual(evs(log).at(-1), { kind: 'session.imported', vendor: 'claude', vendorSessionId: 'orig', uuid: U[4], fork: true });
  assert.equal(evs(log)[0].kind, 'turn.start');

  write(all); // 벤더에서 두 번째 턴을 더 했다
  const n = log.all.length;
  assert.deepEqual(await pullHistory(log, CID), { turns: 1, rewound: false });
  const added = evs(log).slice(n);
  assert.equal((added[0] as any).text, 'Read hello.txt and tell me its content in one word.');
  assert.deepEqual(added.at(-1), { kind: 'session.imported', vendor: 'claude', vendorSessionId: CID, uuid: U[8] });
  assert.deepEqual(await pullHistory(log, CID), { turns: 0, rewound: false }, '늘어난 것이 없으면 표지도 없다');
  assert.equal(log.all.length, n + added.length);

  // 벤더에서 첫 턴 뒤로 되돌리고 새 턴을 했다 — 두 번째 턴은 대화에서 빠진다 (SDK 는 파일에서 가장 뒤의 갈래를 고른다)
  const t2 = log.all.find((e) => e.ev.kind === 'turn.start' && (e.ev as any).text.startsWith('Read'))!.seq;
  write([...all, { ...all[5], uuid: 'n-1', parentUuid: U[4], message: { role: 'user', content: 'again' } }, { ...all[8], uuid: 'n-2', parentUuid: 'n-1', message: { ...all[8].message, id: 'msg-n2' } }]); // API 메시지 id 가 같으면 SDK 가 한 응답의 조각으로 본다
  const m = log.all.length;
  assert.deepEqual(await pullHistory(log, CID), { turns: 1, rewound: true });
  const after = evs(log).slice(m);
  assert.deepEqual(after[0], { kind: 'turn.rewound', seq: t2, conversation: true, files: false, filesChanged: null });
  assert.deepEqual([(after[1] as any).text, (after.at(-1) as any).uuid], ['again', 'n-2']);

  // 기록 파일의 API 오류 항목(isApiErrorMessage) — SDK 는 이 표지를 넘기지 않아 파일에서 읽는다
  write([...all, { ...all[5], uuid: 'n-1', parentUuid: U[4], message: { role: 'user', content: 'again' } }, { ...all[8], uuid: 'n-2', parentUuid: 'n-1', message: { ...all[8].message, id: 'msg-n2' } },
    { ...all[5], uuid: 'e-1', parentUuid: 'n-2', message: { role: 'user', content: 'once more' } },
    { ...all[8], uuid: 'e-2', parentUuid: 'e-1', isApiErrorMessage: true, error: 'rate_limit', message: { ...all[8].message, id: 'msg-e2', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] } }]);
  const k = log.all.length;
  assert.deepEqual(await pullHistory(log, CID), { turns: 1, rewound: false });
  const failed = evs(log).slice(k).find((e) => e.kind === 'turn.end') as any;
  assert.deepEqual([failed.ok, failed.error, failed.errorKind, failed.uuid], [false, "You've hit your limit", null, 'e-2']);
  assert.ok(!evs(log).slice(k).some((e) => e.kind === 'text.delta'), '오류 문구는 답변으로 안 낸다');

  const other = newLog('claude', work);
  other.append({ seq: 1, at: 1, ev: { kind: 'turn.end', ok: true, error: null, interrupted: false, costUsd: null, durationMs: null, usage: null, uuid: 'elsewhere' } });
  assert.equal(await pullHistory(other, CID), null, '아는 지점이 기록에 없고 compact 로 시작하지도 않는다');
});

test('pullHistory(codex): 가짜 app-server 의 thread/read — 처음엔 두 턴 + 표지(uuid 는 마지막 turn id), uuid 없는 옛 기록은 null', async () => {
  process.env.SLCODE_CODEX_BIN = `${process.execPath} ${path.join(FIX, 'fake-codex.mjs')}`;
  process.env.FAKE_CODEX_TURNS = path.join(FIX, 'codex-turns.json');
  const t = turns();
  const log = newLog('codex', tmp('slcode-h-work-'));
  assert.deepEqual(await pullHistory(log, 'thr-x', { vendorSessionId: 'thr-x', fork: true }), { turns: 2, rewound: false });
  assert.deepEqual(evs(log).at(-1), { kind: 'session.imported', vendor: 'codex', vendorSessionId: 'thr-x', uuid: t[1].id, fork: true });
  assert.deepEqual(await pullHistory(log, 'fork-thr-x'), { turns: 0, rewound: false }, 'fork 는 turn id 를 그대로 둔다');
  const old = newLog('codex', tmp('slcode-h-work-'));
  old.append({ seq: 1, at: 1, ev: { kind: 'session.imported', vendor: 'codex', vendorSessionId: 'thr-x', uuid: null } });
  assert.equal(await pullHistory(old, 'thr-x'), null);
  delete process.env.FAKE_CODEX_TURNS;
});
