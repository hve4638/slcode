// 입력창 history 가 쓰는 지난 입력 목록과 되돌린 턴의 판정 (ticket slcode-input-history-arrows, slcode-rewind-esc-picker)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptTurns, unrewound, visible } from '../src/eventLog.ts';
import type { LoggedEvent } from '../src/protocol.ts';

const log = (list: LoggedEvent['ev'][]): LoggedEvent[] => list.map((ev, i) => ({ seq: i + 1, at: 1000 + i, ev })) as LoggedEvent[];
const turn = (text: string, origin: string | null = null) => ({ kind: 'turn.start', text, origin }) as LoggedEvent['ev'];
const tool = (name: string, input: unknown) => ({ kind: 'tool.start', toolUseId: `t${Math.random()}`, name, input }) as LoggedEvent['ev'];
const rew = (seq: number, conversation: boolean) => ({ kind: 'turn.rewound', seq, conversation, files: !conversation, filesChanged: null }) as LoggedEvent['ev'];

test('promptTurns: 전문·고친 파일·플러그인 명령, 되돌린 턴은 빠진다', () => {
  const long = 'x'.repeat(500);
  const r = promptTurns(log([
    turn(long), tool('Write', { file_path: '/p/a' }), tool('Edit', { file_path: '/p/a' }), tool('Bash', { command: 'rm x' }), tool('NotebookEdit', { notebook_path: '/p/n.ipynb' }),
    { kind: 'agent.command', phase: 'attached', items: [] } as unknown as LoggedEvent['ev'],
    { kind: 'agent.command', plugin: 'p', name: 'p:deploy', args: 'now', outcome: 'ok', ms: 1, messages: [], warnings: [], context: [] } as unknown as LoggedEvent['ev'],
    turn('mail body', 'mail'),
  ]));
  assert.equal(r[0].text, long, '자르지 않는다');
  assert.deepEqual(r[0].edits, ['/p/a', '/p/n.ipynb'], '같은 파일은 한 번, Bash 는 세지 않는다');
  assert.equal(r[1].text, '/p:deploy now'); assert.equal(r[1].command, true);
  assert.equal(r[2].origin, 'mail');
  const cut = promptTurns(log([turn('a'), turn('b'), rew(2, true), turn('c')]));
  assert.deepEqual(cut.map((x) => x.text), ['a', 'c']);
});

test('코드만 되돌린 표지는 대화를 버리지 않는다', () => {
  const ev = log([turn('a'), turn('b'), rew(2, false), turn('c')]);
  assert.equal(unrewound(ev).filter((e) => e.ev.kind === 'turn.start').length, 3);
  assert.equal(visible(ev).filter((e) => e.ev.kind === 'turn.start').length, 3);
  assert.deepEqual(promptTurns(ev).map((x) => x.text), ['a', 'b', 'c']);
  const conv = log([turn('a'), turn('b'), rew(2, true), turn('c')]);
  assert.equal(unrewound(conv).filter((e) => e.ev.kind === 'turn.start').length, 2);
});
