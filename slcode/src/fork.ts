// 세션 복제 (ticket slcode-session-fork, 사용자 결정 2026-11-07) — slcode 세션을 같은 폴더·같은 설정의 별도 세션으로 복제한다. 원본은 그대로 쓴다.
// 관계는 복제본 meta.parent {id, kind 'fork', seq}(원본 기록의 복제 지점), 복제본 고유의 일은 제 기록의 session.imported(fork) 뒤다 — 합치기(slcode-session-merge)가 쓴다.
// Claude 는 지금 SDK forkSession(upToMessageId)으로 가르고, Codex 는 복제본의 첫 기동이 thread/fork(lastTurnId)로 가른다(meta.forkFrom·forkAt).
// 화면 기록은 벤더 기록에서 옮겨 쓴다(pullHistory, slcode import 와 같다) — 되돌리기가 쓰는 uuid 가 복제본 벤더 세션의 것이어야 한다.
// `slcode fork`(cli.ts)와 화면의 /fork·응답 아래 복제 버튼(serve.fork)이 같이 쓴다
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventLog, unrewound } from './eventLog.js';
import { pullHistory } from './history.js';
import { forkClaude } from './vendor.js';
import { CoreError, ERR } from './protocol.js';

/** id 의 기록을 seq(그 턴의 turn.end)까지, 없으면 마지막으로 끝난 턴까지 복제한 새 세션의 로그(닫힌 채). 진행 중인 턴은 넣지 않는다 —
 *  복제 지점이 늘 벤더 쪽 마지막 항목의 uuid 라 턴 도중에 눌러도 반쯤 쓴 턴이 복제본에 들어가지 않는다. 제목은 없으면 "<원본 이름> (forked)", 둘째부터 "(forked N)" (사용자 2026-11-08: ⑂ 대신) */
export async function forkSession(sessionsDir: string, id: string, opts: { seq?: number; title?: string } = {}): Promise<EventLog> {
  const src = EventLog.open(sessionsDir, id);
  if (!src) throw new CoreError(ERR.badRequest, `no session ${id}`);
  const m = src.meta;
  // 복제 지점 — 턴 끝(turn.end)이나 가져온 표지(session.imported) 중 벤더 지점(uuid)이 있는 것. 되돌려 버린 턴은 벤더 쪽에도 없다
  const evs = unrewound(src.all);
  const marks = evs.filter((e) => (e.ev.kind === 'turn.end' || e.ev.kind === 'session.imported') && e.ev.uuid);
  const at = opts.seq === undefined ? marks.at(-1) : marks.find((e) => e.seq === opts.seq);
  if (!at || !m.vendorSessionId) throw new CoreError(ERR.badRequest, opts.seq === undefined ? `session ${m.id} has no finished turn to fork yet` : `no finished turn at seq ${opts.seq} in session ${m.id}`);
  if (!fs.existsSync(m.cwd)) throw new CoreError(ERR.badRequest, `session folder is gone: ${m.cwd}`);
  const point = (at.ev as { uuid: string }).uuid;
  const claude = m.vendor === 'claude';
  const vsid = claude ? await forkClaude(m.vendorSessionId, m.cwd, point) : null;
  const n = EventLog.list(sessionsDir).filter((x) => x.parent?.kind === 'fork' && x.parent.id === m.id).length + 1;
  const log = EventLog.create(sessionsDir, {
    id: randomUUID().slice(0, 8), vendor: m.vendor, cwd: m.cwd, title: opts.title ?? `${m.title ?? m.id} (forked${n > 1 ? ` ${n}` : ''})`, vendorSessionId: vsid, createdAt: Date.now(),
    permissionMode: m.permissionMode, raw: m.raw, model: m.model, effort: m.effort, profile: m.profile, env: m.env, params: m.params, agentPlugins: m.agentPlugins, inspect: m.inspect,
    ...(claude ? {} : { forkFrom: m.vendorSessionId, forkAt: point }),
    parent: { id: m.id, kind: 'fork', seq: at.seq },
  });
  // Claude 복제본은 이미 지점까지만 있고 uuid 가 새로 매겨졌다. Codex 는 원본 thread 를 지점까지 읽는다(turn id 는 thread/fork 뒤에도 같다)
  try { await pullHistory(log, vsid ?? m.vendorSessionId, { vendorSessionId: m.vendorSessionId, fork: true }, claude ? undefined : point); }
  catch (e) { log.close(); EventLog.remove(sessionsDir, log.meta.id); throw new CoreError(ERR.badRequest, `could not read ${m.vendor} session ${m.vendorSessionId}: ${(e as Error).message}`); }
  log.close();
  const tip = evs.filter((e) => e.ev.kind === 'turn.end' && e.seq <= at.seq).at(-1); // 지점이 가져온 표지면 그 앞의 턴
  if (claude && tip?.ev.kind === 'turn.end') keepTipTime(log, tip.at, tip.ev.durationMs);
  return log;
}

/** SDK forkSession 은 복제한 마지막 메시지의 시각을 복제한 때로 바꿔 쓴다(2026-11-07 실측, SDK 0.3.282) — 옮겨 쓴 기록의 마지막 턴 끝 시각·소요 시간이
 *  복제한 때 기준으로 보이므로 원본 기록의 값으로 되돌린다. 아직 아무도 열지 않은 새 로그라 파일을 다시 쓴다 */
function keepTipTime(log: EventLog, at: number, durationMs: number | null): void {
  const file = EventLog.eventsPath(log.dir);
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = JSON.parse(lines[i]);
    if (e.ev.kind !== 'turn.end') continue;
    lines[i] = JSON.stringify({ ...e, at, ev: { ...e.ev, durationMs } });
    break;
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 });
}
