// 활동 기록 (ticket slcode-activity-state, 사용자 결정 2026-10-25~27 — /tmp 프로토타입으로 정함).
// 원자료는 세션 폴더의 activity.jsonl — 에이전트 상태 변화, 사람이 보낸 요청·처리한 질문(점), 화면 신호. 이벤트 로그에는 섞지 않는다.
// 판정은 classify 하나(순수 함수)라 규칙을 고쳐도 지난 기록을 다시 계산할 수 있다. 규칙:
//   사용자 차례(idle·asking)는 '확인 중' 또는 AFK 둘뿐이다. 포커스·마우스 움직임은 보지 않는다.
//   약한 신호(키·클릭·스크롤)와 강한 신호(1초 넘는 입력·보냄·답변·Esc·복사·글자 선택·버튼 클릭·먼 스크롤·응답 시작 근처로 스크롤)는 화면이 가른다.
//   AFK 들어가기: 마지막 신호 뒤 afkAfter 동안 신호가 없으면 — 시작은 마지막 신호 + afkLead. 응답 대기 동안에도 센다.
//   AFK 벗어나기: 강한 신호, 또는 weakWindow 안 약한 신호 weakCount 번. 그 묶음의 첫 신호에서 끝난다. 창을 넘긴 약한 신호는 잠깐 확인(peek).
//   약한 신호로 풀린 뒤 cancelWithin 안에 다시 AFK 면 그 해제를 없던 것으로 한다.
import fs from 'node:fs';
import path from 'node:path';
import { FILES, type ActivityAgentState, type ActivityRecord, type ActivityResult } from './protocol.js';

const MIN = 60e3;
export const THRESHOLDS = { afkAfter: 20 * MIN, afkLead: 5 * MIN, weakWindow: MIN, weakCount: 3, cancelWithin: MIN };
type Thresholds = typeof THRESHOLDS;

type Sig = { t: number; strong: boolean };

export function classify(records: readonly ActivityRecord[], now: number, th: Thresholds = THRESHOLDS): ActivityResult {
  const recs = records.filter((r) => r.t <= now);

  // 에이전트 줄
  const agent: ActivityResult['agent'] = [];
  for (const r of recs) if (r.type === 'agent') {
    const last = agent.at(-1);
    if (last && last.state === r.state) continue;
    if (last) last.to = r.t;
    agent.push({ from: r.t, to: now, state: r.state });
  }
  const points: ActivityResult['points'] = [];
  const sigs: Sig[] = [];
  for (const r of recs) {
    if (r.type === 'sent' || r.type === 'answered') { points.push({ t: r.t, kind: r.type }); sigs.push({ t: r.t, strong: true }); }
    else if (r.type === 'sig') sigs.push({ t: r.t, strong: r.strength === 'strong' });
  }

  // 자리 비움 구간 — 에이전트 상태와 무관하게 신호만으로
  const away: { from: number; to: number }[] = [];
  let peeks: { t: number }[] = [];
  let last = recs.length ? recs[0].t : now;
  let afkFrom: number | null = null;
  let pend: Sig[] = [];                                    // AFK 중 아직 조건을 못 채운 약한 신호
  let weakExit: { at: number; sigs: Sig[] } | null = null;  // 마지막 해제가 약한 신호였으면
  const enter = () => {
    // 약한 신호로 풀렸는데 해제 뒤 cancelWithin 도 못 가고 다시 AFK — 해제를 취소하고 앞 AFK 를 잇는다
    if (weakExit && last - weakExit.at < th.cancelWithin) {
      const prev = away.pop()!;
      peeks.push(...weakExit.sigs.map((s) => ({ t: s.t })));
      afkFrom = prev.from;
    } else afkFrom = last + th.afkLead;
    weakExit = null;
  };
  const expire = (at: number) => { pend = pend.filter((p) => { const keep = at - p.t <= th.weakWindow; if (!keep) peeks.push({ t: p.t }); return keep; }); };
  for (const s of sigs) {
    if (afkFrom === null && s.t - last >= th.afkAfter) enter();
    if (afkFrom === null) { last = s.t; weakExit?.sigs.push(s); continue; }
    expire(s.t);
    pend.push(s);
    if (s.strong || pend.length >= th.weakCount) {
      const at = pend[0].t;
      away.push({ from: afkFrom, to: at });
      weakExit = s.strong ? null : { at, sigs: [...pend] };
      afkFrom = null; pend = []; last = s.t;
    }
  }
  if (afkFrom === null && now - last >= th.afkAfter) enter();
  if (afkFrom !== null) { expire(now); away.push({ from: afkFrom, to: now }); }
  const exits = new Set(away.map((a) => a.to));
  peeks = peeks.filter((p) => !exits.has(p.t)); // 해제 시각이 된 신호는 점으로 남기지 않는다

  // 사람 줄 — 사용자 차례(idle·asking) 구간을 자리 비움으로 잘라 확인 중 / AFK
  const user: ActivityResult['user'] = [];
  let ai = 0; // away 는 시각순 — 지난 구간은 다시 보지 않는다
  for (const w of agent) {
    if (w.state === 'running' || w.state === 'exited') continue; // 사람 차례가 아니다
    while (ai < away.length && away[ai].to <= w.from) ai++;
    let c = w.from;
    for (let k = ai; k < away.length && away[k].from < w.to; k++) {
      const f = Math.max(away[k].from, w.from), t = Math.min(away[k].to, w.to);
      if (t <= f) continue;
      if (f > c) user.push({ from: c, to: f, label: 'active' });
      user.push({ from: f, to: t, label: 'afk' });
      c = t;
    }
    if (w.to > c) user.push({ from: c, to: w.to, label: 'active' });
  }

  // 지금 상태
  const a = agent.at(-1);
  let current: ActivityResult['current'] = null;
  if (a?.state === 'running') current = { agent: 'running', label: 'waiting', since: a.from, agentSince: a.from };
  else if (a) { const u = user.at(-1); current = { agent: a.state, label: u?.label ?? 'active', since: u?.from ?? a.from, agentSince: a.from }; }
  return { start: recs[0]?.t ?? null, now, agent, user, points, peeks, current };
}

/** from 뒤에 걸친 구간과 점만 */
export function clip(r: ActivityResult, from: number): ActivityResult {
  const seg = <T extends { to: number }>(xs: T[]) => xs.filter((x) => x.to > from);
  const pt = <T extends { t: number }>(xs: T[]) => xs.filter((x) => x.t >= from);
  return { ...r, agent: seg(r.agent), user: seg(r.user), points: pt(r.points), peeks: pt(r.peeks) };
}

/** 지금 상태 요약 (ticket slcode-sidebar-orca, `slcode list` 의 state·stateSince·seen) — 마지막 에이전트 상태와 그 시각, 그리고 "봤는가".
 *  seen 이 false 인 것은 턴이 끝나(running·asking → idle) 쉬는 중인데 그 뒤 사람 기록(신호·보냄·답변)이 없을 때뿐이다 — 새로 띄운 세션의 idle 은 본 것.
 *  기록이 없으면 null. 목록이 자주 부르므로 파일 끝 64KB 만 읽고, 거기에 에이전트 상태가 두 번 안 나오면 전체를 읽는다 */
export function summarize(dir: string): { state: ActivityAgentState; stateSince: number; seen: boolean } | null {
  const file = path.join(dir, FILES.activity);
  const parse = (text: string) => text.split('\n').flatMap((l) => { try { const r = JSON.parse(l); return typeof r?.t === 'number' ? [r as ActivityRecord] : []; } catch { return []; } });
  let recs: ActivityRecord[];
  try {
    const size = fs.statSync(file).size, TAIL = 64 * 1024;
    if (size <= TAIL) recs = parse(fs.readFileSync(file, 'utf8'));
    else {
      const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(TAIL);
      try { fs.readSync(fd, buf, 0, TAIL, size - TAIL); } finally { fs.closeSync(fd); }
      recs = parse(buf.toString('utf8')); // 첫 줄은 잘렸을 수 있다 — parse 가 버린다
      if (recs.filter((r) => r.type === 'agent').length < 2) recs = parse(fs.readFileSync(file, 'utf8'));
    }
  } catch { return null; }
  let i = recs.length - 1;
  while (i >= 0 && recs[i].type !== 'agent') i--;
  if (i < 0) return null;
  const last = recs[i] as Extract<ActivityRecord, { type: 'agent' }>;
  let prev: ActivityAgentState | null = null;
  for (let j = i - 1; j >= 0 && !prev; j--) { const r = recs[j]; if (r.type === 'agent') prev = r.state; }
  const ended = last.state === 'idle' && (prev === 'running' || prev === 'asking');
  const touched = recs.slice(i + 1).some((r) => r.type === 'sig' || r.type === 'sent' || r.type === 'answered');
  return { state: last.state, stateSince: last.t, seen: !ended || touched };
}

const WHAT = /^[a-z0-9-]{1,32}$/;
const AGENT: Record<string, ActivityAgentState> = { starting: 'idle', idle: 'idle', running: 'running', requires_action: 'asking', exited: 'exited' };

/** 세션 하나의 활동 기록 — 메모리에 들고 기록마다 파일 끝에 덧붙인다 */
export class Activity {
  readonly file: string;
  readonly records: ActivityRecord[] = [];
  private clock: () => number;

  private constructor(dir: string, clock: () => number) {
    this.file = path.join(dir, FILES.activity);
    this.clock = clock;
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch {}
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (typeof r?.t === 'number' && typeof r.type === 'string') this.records.push(r); } catch {}
    }
  }

  /** 크래시로 꺼짐을 못 적었으면(마지막이 exited·handoff 가 아니면) 마지막 기록 시각에 적는다 — slcode 가 꺼져 있던 시간도 세션 꺼짐이다 */
  static open(dir: string, clock: () => number = Date.now): Activity {
    const a = new Activity(dir, clock);
    const last = a.records.at(-1);
    if (last && !(last.type === 'handoff' || (last.type === 'agent' && last.state === 'exited'))) a.write({ t: last.t, type: 'agent', state: 'exited' });
    return a;
  }

  private write(r: ActivityRecord) {
    this.records.push(r);
    try { fs.appendFileSync(this.file, JSON.stringify(r) + '\n'); } catch { /* 세션 폴더가 지워졌다 */ }
  }
  private lastState(): ActivityAgentState | null {
    for (let i = this.records.length - 1; i >= 0; i--) { const r = this.records[i]; if (r.type === 'agent') return r.state; }
    return null;
  }

  /** session.state — 같은 상태가 이어지면 적지 않는다 */
  agent(state: string) {
    const s = AGENT[state];
    if (s && s !== this.lastState()) this.write({ t: this.clock(), type: 'agent', state: s });
  }
  sent() { this.write({ t: this.clock(), type: 'sent' }); }
  answered() { this.write({ t: this.clock(), type: 'answered' }); }
  signal(strength: unknown, what: unknown): boolean {
    if ((strength !== 'weak' && strength !== 'strong') || typeof what !== 'string' || !WHAT.test(what)) return false;
    this.write({ t: this.clock(), type: 'sig', strength, what });
    return true;
  }
  exited() { this.agent('exited'); }
  handoff() { this.write({ t: this.clock(), type: 'handoff' }); }

  result(from?: number): ActivityResult {
    const r = classify(this.records, this.clock());
    return from === undefined ? r : clip(r, from);
  }
}
