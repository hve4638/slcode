// 입력창 history·Esc 두 번·되돌리기 창의 판정 (ticket slcode-input-history-arrows, slcode-rewind-esc-picker) — 화면 없이 입력칸 흉내로 본다. 실제 키 입력은 headless Chrome 으로 확인했다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptTurns, unrewound, visible } from '../src/eventLog.ts';
import type { LoggedEvent } from '../src/protocol.ts';
// @ts-ignore — 빌드 없는 웹 ES 모듈 (tsc 검사 밖)
import { escGate, inputHistory } from '../web/inputkeys.js';
// @ts-ignore
import { codeLine, editsLabel, optionsOf } from '../web/rewind.js';

function field(text = '') {
  const f = { value: text, selectionStart: text.length, selectionEnd: text.length, scrollTop: 0, scrollHeight: 0, setSelectionRange(a: number, b: number) { f.selectionStart = a; f.selectionEnd = b; } };
  return f;
}
function setup(items: string[]) {
  const f = field();
  const shown: (string | null)[] = [];
  const hist = inputHistory(f, (t: string) => { f.value = t; }, (pos: number | null, total: number) => shown.push(pos === null ? null : `${pos}/${total}`));
  hist.seed(items.map((text, i) => ({ seq: i + 1, text })));
  const up = () => hist.key({ key: 'ArrowUp' });
  const down = () => hist.key({ key: 'ArrowDown' });
  const type = (t: string) => { hist.key({ key: t }); f.value += t; f.setSelectionRange(f.value.length, f.value.length); };
  return { f, hist, up, down, type, label: () => shown.at(-1) };
}

test('history: 빈 입력에서 위로 — 넘어간 직후엔 여러 줄 기록도 건너뛰며 오가고, 맨 아래는 빈 입력', () => {
  const { f, up, down, label } = setup(['one', 'l1\nl2', 'three']);
  assert.equal(down(), false, '기록을 보고 있지 않으면 아래는 받지 않는다');
  assert.equal(up(), true); assert.equal(f.value, 'three'); assert.equal(f.selectionStart, 5, '위로 가면 글 끝'); assert.equal(label(), '3/3');
  up(); assert.equal(f.value, 'l1\nl2'); assert.equal(label(), '2/3');
  up(); assert.equal(f.value, 'one');
  assert.equal(up(), true, '맨 앞에서도 키는 받는다'); assert.equal(f.value, 'one');
  down(); assert.equal(f.value, 'l1\nl2'); assert.equal(f.selectionStart, 0, '아래로 가면 글 맨 앞');
  down(); down(); assert.equal(f.value, ''); assert.equal(label(), null);
});

test('history: 커서 규칙 — 글이 있으면 위는 맨 처음에서만, 아래는 맨 끝에서만. 넘어간 직후가 아니면 그대로 브라우저 몫', () => {
  const { f, hist, up, down, type } = setup(['one', 'two']);
  type('draft');
  assert.equal(up(), false, '글 끝에서 위는 넘어가지 않는다');
  f.setSelectionRange(2, 2); assert.equal(up(), false); assert.equal(down(), false);
  f.setSelectionRange(0, 5); assert.equal(up(), false, '선택 영역이 있으면 넘어가지 않는다');
  f.setSelectionRange(0, 0); assert.equal(up(), true); assert.equal(f.value, 'two');
  down(); assert.equal(f.value, 'draft', '맨 아래로 돌아오면 초안'); assert.equal(f.selectionStart, 0);
  assert.equal(hist.key({ key: 'ArrowUp', shiftKey: true }), false, 'Shift+위는 선택');
  assert.equal(hist.key({ key: 'ArrowUp', isComposing: true }), false, '조합 중');
});

test('history: 다른 조작을 하면 넘어간 직후 상태가 풀리고, 고친 글은 전송 전까지 그 항목에 남는다', () => {
  const { f, hist, up, down, type, label } = setup(['one', 'two']);
  up();
  hist.key({ key: 'ArrowLeft' }); f.setSelectionRange(1, 1);
  assert.equal(up(), false, '커서를 옮기면 다시 커서 규칙'); assert.equal(label(), null, '표시도 사라진다');
  f.setSelectionRange(3, 3); type('X'); assert.equal(f.value, 'twoX');
  assert.equal(down(), true, '고친 글 끝에서 아래는 넘어간다'); assert.equal(f.value, '');
  up(); assert.equal(f.value, 'twoX', '고친 글이 남아 있다');
  up(); assert.equal(f.value, 'one');
  hist.reset(); assert.equal(hist.nav, false);
  f.value = ''; up(); assert.equal(f.value, 'two', '보내면 고친 내용은 버린다');
});

test('history: 실시간 추가·서버 기록 맞추기·대화 되돌리기·지운 글', () => {
  const { f, hist, up, label } = setup(['one', 'two']);
  hist.add(5, 'live'); hist.add(5, 'live'); hist.add(6, '');
  hist.addCleared(5, 'gone'); hist.addCleared(5, 'gone');
  up(); assert.equal(f.value, 'gone', '지운 글은 그 시점 뒤에 선다'); assert.equal(label(), '4/4', '같은 글을 거듭 지워도 한 줄');
  up(); assert.equal(f.value, 'live');
  hist.seed([{ seq: 2, text: 'two' }]);
  assert.equal(label(), '2/3', '서버 기록에 없어진 앞 항목은 빠지고, 뒤에 온 것과 지운 글은 남는다');
  hist.cut(1, 3); up();
  assert.equal(f.value, 'live', '보던 항목이 남아 있고 앞 기록이 없으면 그대로');
  hist.cut(5, 7);
  assert.equal(hist.nav, false, '보던 항목이 사라지면 초안 자리로');
});

test('Esc 두 번: 800ms 안, 같은 상태에서만 — 세 번 눌러도 두 번째에서 끝나고, reset 하면 처음부터', () => {
  const e = escGate();
  assert.equal(e.press(0, 'empty'), false);
  assert.equal(e.press(700, 'empty'), true);
  assert.equal(e.press(800, 'empty'), false, '두 번으로 친 뒤엔 다시 첫 번째');
  assert.equal(e.press(1700, 'empty'), false, '900ms 는 두 번이 아니다');
  assert.equal(e.press(1800, 'text'), false, '상태가 바뀌면 첫 번째');
  e.reset(); assert.equal(e.press(1900, 'text'), false);
});

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

test('되돌리기 창: 코드 변화가 있으면 셋, 없으면 대화만, 못 되돌리면 취소만', () => {
  const labels = (p: unknown) => optionsOf(p).map((o: { label: string }) => o.label);
  assert.deepEqual(labels({ conversation: true, files: { changed: ['/p/b.txt'], insertions: 0, deletions: 2 } }), ['코드와 대화 되돌리기', '대화만 되돌리기', '코드만 되돌리기', '취소']);
  assert.deepEqual(labels({ conversation: true, files: { changed: [], insertions: 0, deletions: 0 } }), ['대화만 되돌리기', '취소']);
  assert.deepEqual(labels({ conversation: true, files: null }), ['대화만 되돌리기', '취소']);
  assert.deepEqual(labels({ conversation: false, files: null, error: 'x' }), ['취소']);
  assert.deepEqual(labels({ conversation: false, files: { changed: ['/a'], insertions: 1, deletions: 0 } }), ['코드만 되돌리기', '취소'], '가져온 대화 앞은 코드만');
  assert.equal(codeLine({ changed: ['/p/b.txt'], insertions: 0, deletions: 2 }), '코드는 b.txt -2 만큼 되돌아갑니다.');
  assert.equal(codeLine({ changed: ['/a', '/b'], insertions: 3, deletions: 1 }), '코드는 파일 2개 +3 -1 만큼 되돌아갑니다.');
  assert.equal(codeLine(null), '코드는 그대로입니다.');
  assert.equal(editsLabel([]), '코드 변경 없음'); assert.equal(editsLabel(['/p/a.txt']), 'a.txt'); assert.equal(editsLabel(['/a', '/b']), '파일 2개 변경');
});
