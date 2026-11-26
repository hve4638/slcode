// background 실행 (ticket slcode-background-run-tool, 사용자 결정 2026-11-23) — 서버·끝나지 않는 명령을 core 가 시간 제한 없이 맡는다.
// Claude Code 의 Bash run_in_background 는 SDK 세션에서 기본 30분·최대 2시간에 죽고 Esc·세션 닫기에 같이 죽는다 (ws docs/report/slcode-long-terminal-task-research.md).
// 원본은 CLI `slcode bg run|stop|list` — Claude 에는 그 CLI 를 부르는 MCP 도구(bgTools), Codex 는 셸에서 친다.
// 프로세스는 core 밖: 감싸는 sh 를 따로 된 프로세스 그룹으로 띄우고, sh 가 명령의 exit code 를 bg/<id>.exit 에 쓴다. 그래서 교체한 새 core 가 기록(bg/<id>.json)을 읽어 이어 맡는다.
// Esc 와는 무관하고, 세션 닫기는 closeAll 로 끈다. 상태 점·교체 판정에는 넣지 않는다 (끝나지 않는 서버가 막지 않게)
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CoreError, ERR, type BgTask } from './protocol.js';

/** 세션 폴더 안의 작업 폴더 */
export const BG_DIR = 'bg';
/** 승인을 묻지 않는 도구 — 이 세션이 띄운 작업만 멈춘다. BackgroundRun 은 Bash 처럼 묻는다 */
export const BG_STOP_TOOL = 'mcp__slcode__BackgroundStop';
/** tail 이 한 번에 주는 최대 바이트 — 화면의 출력 창이 이만큼만 쥔다 */
export const BG_TAIL_MAX = 131072;
/** stop 의 SIGTERM 뒤 SIGKILL 까지 */
const STOP_GRACE_MS = 5000;
/** 감싸는 sh — $1 명령, $2 exit 파일. trap 은 그룹에 보낸 SIGTERM 에 sh 가 먼저 죽지 않고 명령이 끝난 뒤 code 를 쓰게 한다.
 *  trap '' (무시)는 자식에게 무시가 물려져 쓰지 않는다. 임시 파일 뒤 이름 바꾸기 — 지켜보는 쪽이 빈 파일을 읽지 않게 */
const WRAP = 'trap : TERM INT HUP; bash -c "$1"; c=$?; echo $c > "$2.tmp" && mv "$2.tmp" "$2"';

type Stored = Omit<BgTask, 'output' | 'size'>;
type Live = { task: Stored; child?: ChildProcess; ended: Promise<void>; done: () => void };

/** 끝 알림 본문 (메일 from="bg:<id>" kind="exited") */
export function endText(t: BgTask): string {
  const how = t.code != null ? `exited with code ${t.code}` : t.signal ? `was killed by signal ${t.signal}` : 'ended; its exit code is unknown (it ended while slcode was not watching)';
  return `Background task ${t.id}${t.description ? ` ("${t.description}")` : ''} ${how}.\nCommand: ${t.command}\nOutput: ${t.output}`;
}

export class Background {
  private live = new Map<string, Live>();
  private watcher: fs.FSWatcher | null = null;
  /** onChange — 작업이 생기거나 끝날 때 (화면의 background 표시, core 가 session.bg 로 방송한다) */
  constructor(private o: { dir: string; env: NodeJS.ProcessEnv; onEnd: (t: BgTask) => void; onChange?: () => void; log: (m: string) => void }) {}

  private file = (id: string, ext: string) => path.join(this.o.dir, `${id}.${ext}`);
  private view = (t: Stored): BgTask => ({ ...t, output: this.file(t.id, 'log'), size: fs.statSync(this.file(t.id, 'log'), { throwIfNoEntry: false })?.size ?? 0 });
  private save(t: Stored) {
    const f = this.file(t.id, 'json');
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(t));
    fs.renameSync(`${f}.tmp`, f);
  }
  private read(id: string): Stored | null {
    try { return JSON.parse(fs.readFileSync(this.file(id, 'json'), 'utf8')); } catch { return null; }
  }
  private track(task: Stored, child?: ChildProcess) {
    let done!: () => void;
    const ended = new Promise<void>((r) => (done = r));
    this.live.set(task.id, { task, child, ended, done });
  }

  run(command: string, description: string, cwd: string): BgTask {
    if (process.platform === 'win32') throw new CoreError(ERR.badRequest, 'slcode bg is not supported on Windows');
    if (!command.trim()) throw new CoreError(ERR.badRequest, 'command required');
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new CoreError(ERR.badRequest, `not a folder: ${cwd}`);
    fs.mkdirSync(this.o.dir, { recursive: true });
    const id = randomBytes(4).toString('hex');
    const fd = fs.openSync(this.file(id, 'log'), 'a');
    let child: ChildProcess;
    // python 은 출력이 파일이면 stdout 을 버퍼에 쥐어 서버의 시작 줄 등이 파일에 오지 않는다 (데모 실측 2026-11-23: http.server 의 로그가 0바이트) — 주지 않았으면 끈다
    const env = { PYTHONUNBUFFERED: '1', ...this.o.env };
    try { child = spawn('sh', ['-c', WRAP, 'slcode-bg', command, this.file(id, 'exit')], { cwd, env, detached: true, stdio: ['ignore', fd, fd] }); }
    finally { fs.closeSync(fd); }
    if (!child.pid) throw new CoreError(ERR.badRequest, 'could not start sh');
    child.unref();
    const task: Stored = { id, command, description, cwd, pid: child.pid, startedAt: Date.now() };
    this.save(task);
    this.track(task, child);
    child.on('exit', (_code, signal) => this.ended(id, signal));
    this.o.log(`bg ${id} started (pid ${child.pid}): ${command}`);
    this.o.onChange?.();
    return this.view(task);
  }

  /** 끝남 — exit 파일이 있으면 그 code, 없으면 시그널(이 core 의 자식) 또는 모름 */
  private ended(id: string, signal: string | null = null) {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    const raw = (() => { try { return fs.readFileSync(this.file(id, 'exit'), 'utf8').trim(); } catch { return null; } })();
    const code = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
    const t: Stored = { ...l.task, endedAt: Date.now(), code, signal: code === null ? signal : null };
    try { this.save(t); } catch { /* 세션 폴더를 지웠다 */ }
    this.o.log(`bg ${id} ended: code ${code} signal ${t.signal}${t.stoppedBy ? ` (stopped by ${t.stoppedBy})` : ''}`);
    l.done();
    this.o.onChange?.();
    if (!t.stoppedBy) this.o.onEnd(this.view(t));
  }

  async stop(id: string, by: 'agent' | 'user' | 'close' = 'agent'): Promise<BgTask> {
    const l = this.live.get(id);
    if (!l) {
      const t = this.read(id);
      if (!t) throw new CoreError(ERR.badRequest, `no background task ${id}`);
      return this.view(t);
    }
    l.task.stoppedBy = by;
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-l.task.pid, sig); return true; } catch { return false; } };
    const within = (ms: number) => new Promise<boolean>((r) => { const t = setTimeout(() => r(false), ms); void l.ended.then(() => { clearTimeout(t); r(true); }); });
    if (!kill('SIGTERM')) this.ended(id); // 그룹이 이미 없다
    else if (!(await within(STOP_GRACE_MS))) {
      kill('SIGKILL');
      // 이 core 의 자식이면 exit 이벤트가 온다. 이어 맡은 것은 exit 파일 없이 죽어 알 길이 없다
      if (!(await within(1000))) this.ended(id, 'SIGKILL');
    }
    return this.view(this.read(id) ?? { ...l.task, endedAt: Date.now() });
  }

  /** 출력 파일의 조각 (화면의 출력 창, 사용자 2026-11-25). before 가 없으면 from(바이트) 뒤 — 많으면 끝 BG_TAIL_MAX 만(그때 start > from), 다음 from 은 end.
   *  before 가 있으면 그 앞 BG_TAIL_MAX 안에서 줄 머리부터(위로 올려 앞부분을 더 볼 때, end = before). 잘린 UTF-8 글자는 앞뒤에서 뺀다 */
  tail(id: string, from = 0, before?: number): { start: number; end: number; text: string } {
    if (!/^[0-9a-f]+$/.test(id) || !this.read(id)) throw new CoreError(ERR.badRequest, `no background task ${id}`);
    let fd: number;
    try { fd = fs.openSync(this.file(id, 'log'), 'r'); } catch { return { start: 0, end: 0, text: '' }; }
    try {
      const size = fs.fstatSync(fd).size;
      const back = before !== undefined;
      if (!(from >= 0 && from <= size)) from = 0; // 파일이 줄었다 — 처음부터
      const stop = back ? Math.min(Math.max(before, 0), size) : size;
      const start = back ? Math.max(0, stop - BG_TAIL_MAX) : Math.max(from, size - BG_TAIL_MAX);
      const buf = Buffer.alloc(stop - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let a = 0, b = buf.length;
      if (back ? start > 0 : start > from) while (a < b && (buf[a] & 0xc0) === 0x80) a++;
      if (back && start > 0) { const nl = buf.indexOf(10, a); a = nl < 0 ? b : nl + 1; }
      // 끝의 덜 쓴 글자 — 마지막 머리 바이트가 요구하는 길이보다 짧으면 다음에
      for (let i = b - 1; i >= a && i >= b - 4; i--) {
        if ((buf[i] & 0xc0) === 0x80) continue;
        const need = buf[i] >= 0xf0 ? 4 : buf[i] >= 0xe0 ? 3 : buf[i] >= 0xc0 ? 2 : 1;
        if (b - i < need) b = i;
        break;
      }
      return { start: start + a, end: start + b, text: buf.subarray(a, b).toString('utf8') };
    } finally { fs.closeSync(fd); }
  }

  list(): BgTask[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.o.dir).filter((n) => n.endsWith('.json')); } catch {}
    return names.flatMap((n) => { const t = this.read(n.slice(0, -5)); return t ? [this.view(t)] : []; }).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 세션 닫기 — 도는 것을 모두 끈다 (메일 없음) */
  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id, 'close')));
    this.release(); // 지켜보기(fs.watch)가 프로세스를 붙잡지 않게
  }

  /** core 교체 — 지켜보기만 그만둔다. 프로세스와 기록은 새 core 가 adopt 로 이어 맡는다 */
  release() {
    this.watcher?.close(); this.watcher = null;
    for (const l of this.live.values()) l.child?.removeAllListeners('exit');
    this.live.clear();
  }

  /** 기동 때 — 끝나지 않은 기록을 이어 맡는다. 지켜보기를 먼저 걸어 그사이 생긴 exit 파일을 놓치지 않는다 */
  adopt() {
    const open = this.list().filter((t) => t.endedAt === undefined);
    if (!open.length) return;
    this.watcher = fs.watch(this.o.dir, (_ev, name) => {
      const id = name?.endsWith('.exit') ? name.slice(0, -5) : null;
      // 이어 맡은 것만 — 이 core 가 띄운 것은 sh 가 끝나는 exit 이벤트로 (exit 파일은 sh 가 끝나기 직전에 생긴다)
      if (id && this.live.has(id) && !this.live.get(id)!.child && fs.existsSync(this.file(id, 'exit'))) this.ended(id);
    });
    this.watcher.on('error', () => {});
    for (const { output: _, size: __, ...t } of open) {
      this.track(t);
      if (fs.existsSync(this.file(t.id, 'exit')) || !this.ours(t)) this.ended(t.id);
      else this.o.log(`bg ${t.id} adopted (pid ${t.pid})`);
    }
  }

  /** pid 가 살아 있고 그 명령줄에 이 작업의 exit 파일이 있다 — pid 가 재사용된 남의 프로세스를 잡지 않게 */
  private ours(t: Stored): boolean {
    try { return execFileSync('ps', ['-p', String(t.pid), '-o', 'args='], { encoding: 'utf8' }).includes(this.file(t.id, 'exit')); } catch { return false; }
  }
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text' as const, text: s }], ...(isError ? { isError: true } : {}) });

/** MCP 도구 정의 — CLI 를 부른다 (같은 일을 셸로도 하게 CLI 가 원본, teamTools 와 같은 꼴). teamTools 가 이 모듈을 import 하므로 그쪽 runCli 를 쓰지 않는다 */
export function bgTools(o: { cli: string; env: NodeJS.ProcessEnv; cwd: string }) {
  const cli = (args: string[]) => new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile(process.execPath, [o.cli, ...args], { cwd: o.cwd, env: o.env, windowsHide: true }, (e, out, err) => resolve({ ok: !e, out: e ? (String(err).trim() || e.message) : String(out).trim() })));
  const run = tool(
    'BackgroundRun',
    'Run a shell command in the background with no time limit: a server, a watcher, or a command that may run longer than 30 minutes or must keep running after the user interrupts you. '
      + 'Returns at once with a task id and an output file that collects its stdout and stderr; read the file with Read. '
      + 'When the command ends you get a <slcode-message from="bg:<id>" kind="exited"> with its exit code. It keeps running when your turn ends or is interrupted, and stops when this session closes. '
      + 'For a short background wait, Bash run_in_background is fine.',
    {
      command: z.string().describe('The shell command to run (bash)'),
      description: z.string().describe('A short description of what it runs, for example "Start web server on 8080"'),
      cwd: z.string().optional().describe('The folder it runs in. Defaults to your current folder'),
    },
    async (a) => {
      const r = await cli(['bg', 'run', '-n', a.description, ...(a.cwd ? ['--cwd', a.cwd] : []), '--', a.command]);
      if (!r.ok) return text(r.out, true);
      const [id, output] = r.out.split('\n');
      return text(`Background task ${id} started. Output: ${output}\nWhen it ends you get a <slcode-message from="bg:${id}" kind="exited">. Do not poll for it. Stop it with BackgroundStop.`);
    },
  );
  const stop = tool(
    'BackgroundStop',
    'Stop a background task started with BackgroundRun: SIGTERM to its process group, then SIGKILL after 5 seconds. Returns how it ended. No message follows.',
    { id: z.string().describe('The task id') },
    async (a) => { const r = await cli(['bg', 'stop', a.id]); return text(r.out, !r.ok); },
  );
  return [run, stop] as const;
}
