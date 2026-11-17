// slcode 세션을 Claude Code 의 세션 목록에 올리고 메시지를 주고받는다 (ticket slcode-claude-peer-relay, 사용자 결정 2026-11-17).
// core 가 세션마다 Claude Code 등록 파일 <설정 폴더>/sessions/<pid>.json 을 쓰고 /tmp/cc-socks/<pid>.sock 을 연다 — Claude Code 의 ListAgents 에
// slcode-<제목> 으로 보이고 SendMessage 가 그 소켓에 JSON 한 줄로 온다. 공개 문서에 없는 형식이다 (Claude Code 2.1.326 실측, ws docs/report/slcode-claude-message-relay.md).
// 실측으로 정한 것:
//   - Claude Code 는 등록 파일의 pid·procStart 로 죽은 프로세스의 파일을 목록에서 뺀다 (지우지는 않는다). status 는 적힌 값을 그대로 보인다 (낡았는지 보지 않는다).
//   - 봉투 속성에는 escape 가 없다. 이름에 " < > 가 있으면 봉투로 읽히지 않아 from-mode 가 사라진다 — Claude Code 처럼 지운다.
//   - 보류·거절 통보(peer_message_status)는 from 소켓을 연 프로세스가 직접 보냈을 때만 돌아온다 — 그래서 CLI 가 아니라 core 가 보낸다.
//   - 설정 폴더가 다른 세션끼리는 서로 보이지 않는다.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VERSION } from './client.js';
import { CoreError, ERR } from './protocol.js';

export const CLAUDE_PREFIX = 'claude:';
const SOCK_DIR = '/tmp/cc-socks';
const TAG = 'cross-session-message';
const PROTOCOL = 1;

/** 그 env 의 Claude Code 설정 폴더 아래 sessions — 설정 폴더가 없으면 null (아무것도 하지 않는다). SLCODE_CLAUDE_PEER=0 은 테스트가 사용자 ~/.claude 에 쓰지 않게 끈다 */
export function peerDir(env: NodeJS.ProcessEnv): string | null {
  if (env.SLCODE_CLAUDE_PEER === '0') return null;
  const config = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return fs.existsSync(config) ? path.join(config, 'sessions') : null;
}

/** Claude Code 가 이름에 하는 것과 같게 — " < > 와 제어·서식 문자를 지운다 */
const clean = (s: string) => s.replace(/["<>]/g, '').replace(/[\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/gu, '').trim();

/** 등록 이름 — Claude Code 는 64자를 넘는 이름을 줄여 보이므로 그 안에 들게 자른다 */
export function peerName(title: string | null, id: string): string {
  const t = [...clean(title ?? '')].slice(0, 57).join('').trim();
  return `slcode-${/[\p{L}\p{N}]/u.test(t) ? t : id}`;
}

export type Envelope = { fromName: string | null; body: string };
const ENVELOPE_RE = new RegExp(`^<${TAG}((?: [\\w-]+="[^"]*")*)>\\n([\\s\\S]*)\\n</${TAG}>$`);
export function parseEnvelope(text: string): Envelope {
  const m = text.match(ENVELOPE_RE);
  if (!m) return { fromName: null, body: text };
  return { fromName: m[1].match(/ from-name="([^"]*)"/)?.[1] || null, body: m[2] };
}

/** /proc/<pid>/stat 의 22번째(프로세스 시작 시각) — Claude Code 가 pid 재사용을 가리는 값. /proc 이 없으면 null */
function procStart(pid: number): string | null {
  try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { return null; }
}

type Entry = { pid?: number; procStart?: string; name?: string; peerProtocol?: number; messagingSocketPath?: string; slcode?: string };
/** 등록 파일들 — live 는 그 프로세스가 살아 있는지 */
function entries(dir: string): { file: string; e: Entry; live: boolean }[] {
  let names: string[];
  try { names = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  return names.flatMap((f) => {
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Entry;
      return [{ file: path.join(dir, f), e, live: typeof e.pid === 'number' && !!e.procStart && procStart(e.pid) === e.procStart }];
    } catch { return []; }
  });
}

export type ClaudePeer = {
  /** 이름·상태가 바뀌었으면 등록 파일을 고쳐 쓴다 */
  sync(name: string, status: 'idle' | 'busy'): void;
  /** 그 이름의 Claude Code 세션에 한 통 */
  send(to: string, text: string): Promise<{ id: string; to: string }>;
  close(): void;
};

export function startPeer(o: {
  /** peerDir 의 값 — null 이면 등록하지 않고 send 는 거절한다 */
  dir: string | null; id: string; cwd: string; name: string;
  onMessage: (fromName: string | null, body: string) => void;
  onStatus: (fromName: string | null, status: string, reason: string) => void;
  /** 등록을 내렸다 (한 번) */
  onStop: (why: string) => void;
  log: (msg: string) => void;
}): ClaudePeer {
  const pid = process.pid, started = procStart(pid), sock = path.join(SOCK_DIR, `${pid}.sock`);
  const file = o.dir && started ? path.join(o.dir, `${pid}.json`) : null;
  let off: string | null = file ? null : 'this session has no Claude Code config folder';
  let name = o.name, status: 'idle' | 'busy' = 'idle';
  const startedAt = Date.now(), sessionId = randomUUID(); // Claude Code 의 sessionId 는 UUID 다 — slcode 세션 id 는 slcode 필드에
  let nameSince = startedAt, statusSince = startedAt;
  let server: net.Server | null = null;

  /** 살아 있는 Claude Code 세션 (slcode 가 쓴 것이 아니고 소켓이 적힌 것) */
  const claudes = () => entries(o.dir!).filter((x) => x.live && !x.e.slcode && x.e.messagingSocketPath).map((x) => x.e);
  const nameOf = (from: unknown) => (typeof from === 'string' ? claudes().find((e) => `uds:${e.messagingSocketPath}` === from)?.name ?? null : null);
  function down() {
    server?.close(); server = null;
    try { fs.unlinkSync(sock); } catch {}
    if (file) try { fs.unlinkSync(file); } catch {}
  }
  /** 살아 있는 Claude Code 세션들 — 다른 peerProtocol 이 보이면 등록을 내리고 한 번 알린다 */
  function check(): Entry[] {
    const all = claudes(), odd = all.find((e) => e.peerProtocol !== PROTOCOL);
    if (odd && !off) {
      off = `Claude Code session ${odd.name ?? odd.pid} uses peer protocol ${odd.peerProtocol}, this slcode knows ${PROTOCOL}`;
      down();
      o.onStop(off);
    }
    return all;
  }
  function write() {
    if (!file || off) return;
    const body = {
      pid, sessionId, cwd: o.cwd, startedAt, procStart: started, version: VERSION, peerProtocol: PROTOCOL, peerFeatures: [],
      kind: 'interactive', entrypoint: 'cli', messagingSocketPath: sock, name, nameSource: 'user', nameSince, status, updatedAt: Date.now(), statusUpdatedAt: statusSince, slcode: o.id,
    };
    try { fs.writeFileSync(`${file}.tmp`, JSON.stringify(body), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); }
    catch (e) { o.log(`claude peer: registration not written: ${(e as Error).message}`); }
  }
  function onLine(line: string) {
    let f: { type?: string; message?: { content?: unknown }; action?: string; status?: unknown; reason?: unknown; from?: unknown };
    try { f = JSON.parse(line); } catch { return; }
    if (f?.type === 'user') {
      const c = f.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => String(p.text)).join('\n') : '';
      if (!text) return;
      const env = parseEnvelope(text);
      o.onMessage(env.fromName ?? nameOf(f.from), env.body);
    } else if (f?.type === 'control' && f.action === 'peer_message_status' && typeof f.status === 'string') {
      o.onStatus(nameOf(f.from), f.status, typeof f.reason === 'string' ? f.reason : '');
    }
  }

  if (file) {
    try {
      // 죽은 slcode core 가 남긴 등록 파일과 소켓
      for (const x of entries(o.dir!)) if (x.e.slcode && !x.live) { try { fs.unlinkSync(x.file); } catch {} if (x.e.messagingSocketPath && path.dirname(x.e.messagingSocketPath) === SOCK_DIR) try { fs.unlinkSync(x.e.messagingSocketPath); } catch {} }
      check();
      if (!off) {
        fs.mkdirSync(o.dir!, { recursive: true, mode: 0o700 });
        fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
        try { fs.unlinkSync(sock); } catch {} // 같은 pid 를 쓰던 죽은 프로세스의 것
        const srv = net.createServer((c) => {
          let buf = '';
          c.setEncoding('utf8');
          c.on('data', (d: string) => { buf += d; for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) onLine(buf.slice(0, i)); });
          c.on('end', () => { if (buf.trim()) onLine(buf); c.end(); });
          c.on('error', () => {});
        });
        srv.on('error', (e) => { o.log(`claude peer: socket failed: ${e.message}`); off = `socket failed: ${e.message}`; down(); });
        srv.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch {} write(); });
        server = srv;
      }
    } catch (e) { off = (e as Error).message; o.log(`claude peer: not registered: ${off}`); down(); }
  }

  return {
    sync(n, s) {
      if (n === name && s === status) return;
      if (n !== name) { name = n; nameSince = Date.now(); }
      if (s !== status) { status = s; statusSince = Date.now(); }
      if (server?.listening) write();
    },
    async send(to, text) {
      const peers = off ? [] : check();
      if (off) throw new CoreError(ERR.badRequest, `messaging with Claude Code sessions is off: ${off}`);
      const hits = peers.filter((e) => e.name === to);
      if (!hits.length) {
        const names = [...new Set(peers.map((e) => e.name).filter(Boolean))];
        throw new CoreError(ERR.noSession, `no Claude Code session named "${to}"${names.length ? ` (live: ${names.join(', ')})` : ' (none is live in this Claude Code config folder)'}`);
      }
      if (hits.length > 1) throw new CoreError(ERR.badRequest, `ambiguous Claude Code session name "${to}": ${hits.length} live sessions have it`);
      const id = randomUUID();
      const content = `<${TAG} from="uds:${sock}" from-name="${name}" from-mode="bypass">\n${text.replace(new RegExp(`<(?=/${TAG})`, 'gi'), '<\\')}\n</${TAG}>`;
      const frame = { msgV: 1, msg_id: id, type: 'user', message: { role: 'user', content }, priority: 'next', from: `uds:${sock}` };
      await new Promise<void>((resolve, reject) => {
        const c = net.createConnection(hits[0].messagingSocketPath!);
        c.on('error', (e) => reject(new CoreError(ERR.noSession, `Claude Code session "${to}" did not take the message: ${e.message}`)));
        c.once('connect', () => c.end(`${JSON.stringify(frame)}\n`, () => resolve()));
      });
      return { id, to: CLAUDE_PREFIX + to };
    },
    close: down,
  };
}
