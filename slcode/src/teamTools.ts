// 팀원 도구 (ticket slcode-team-agent, 사용자 2026-11-08) — Claude 세션에 넣는 in-process MCP 서버. Claude 의 Agent·SendMessage 처럼 subagent 팀원을 띄우고 이어 시킨다.
// 도구는 CLI 를 부른다(`slcode team new --subagent --wait`, `slcode prompt --wait`) — 같은 일을 Bash 로도 하게 CLI 가 원본이다.
// Bash 도구는 최대 10분에 끊기지만 MCP 도구 호출은 서버별 timeout 까지 기다린다 — 그래서 답을 도구 결과로 받는 길은 MCP 다.
// 백그라운드(run_in_background)면 id 만 바로 돌려주고, 답은 끝날 때 kind=result 메시지로 온다. Esc 로 리더 턴을 멈추면 팀원의 턴도 멈춘다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/** setTimeout 의 상한 — SDK 는 MCP 도구 시간 제한을 이 값으로 자른다 (SDK 0.3.282 실측) */
const NO_LIMIT_MS = 2147483647;

/** 세션이 보는 도구 이름 — mcp__<서버 키>__<도구>. 서버 키 slcode 는 core 의 mcpServers 키다. 이 이름들은 승인을 묻지 않는다 */
export const TEAM_TOOL_NAMES = ['mcp__slcode__Subagent', 'mcp__slcode__ContinueSubagent'] as const;

type Run = { code: number; out: string; err: string };
export type TeamToolsOptions = {
  /** slcode CLI — dist/cli.js */
  cli: string;
  /** 리더 세션의 벤더 env — SLCODE_SESSION_ID 가 리더 */
  env: NodeJS.ProcessEnv;
  /** 리더의 작업 폴더 — 상대 폴더의 기준 */
  cwd: string;
};

/** input 은 파일로 stdin 에 — CLI 는 파이프·파일만 읽고 소켓(Node 의 자식 stdin 파이프)은 읽지 않는다. 인자로 넘기면 긴 지시가 인자 길이 상한(약 128KB)에 걸린다 */
function runCli(o: TeamToolsOptions, args: string[], input: string | null, signal: AbortSignal | undefined, onErr?: (text: string) => void): Promise<Run> {
  let tmp: string | null = null, fd: number | null = null;
  if (input !== null) {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slcode-team-'));
    const file = path.join(tmp, 'prompt');
    fs.writeFileSync(file, input, { mode: 0o600 });
    fd = fs.openSync(file, 'r');
  }
  const cleanup = () => { if (fd !== null) fs.closeSync(fd); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); fd = null; tmp = null; };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [o.cli, ...args], { cwd: o.cwd, env: o.env, stdio: [fd ?? 'ignore', 'pipe', 'pipe'], windowsHide: true });
    cleanup(); // 자식이 fd 를 물려받았다
    let out = '', err = '';
    child.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { err += d; onErr?.(err); });
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => { signal?.removeEventListener('abort', stop); resolve({ code: code ?? 1, out: out.trim(), err: err.trim() }); });
  });
}

const text = (s: string, isError = false) => ({ content: [{ type: 'text' as const, text: s }], ...(isError ? { isError: true } : {}) });
const signalOf = (extra: unknown) => (extra as { signal?: AbortSignal } | undefined)?.signal;

/** 기다리는 CLI 를 리더가 멈췄다(Esc) — 팀원의 턴도 멈춘다. 결과는 기다리지 않는다 */
function interrupt(o: TeamToolsOptions, id: string) {
  const c = spawn(process.execPath, [o.cli, 'interrupt', id], { cwd: o.cwd, env: o.env, stdio: 'ignore', detached: true, windowsHide: true });
  c.on('error', () => {});
  c.unref();
}

/** 기다린 끝의 결과 — 답과 이어 시키는 법 (Claude Agent 도구의 agentId 안내와 같은 자리) */
function answered(id: string, r: Run) {
  if (r.code !== 0) return text(r.err || `slcode exited with ${r.code}`, true);
  return text(`${r.out || '(no answer text)'}\n\n[subagent ${id} finished and closed. To give it more work with its context, call ContinueSubagent with to: "${id}".]`);
}

/** 도구 정의 — teamMcp 가 서버로 묶는다 (시험은 handler 를 바로 부른다) */
export function teamTools(o: TeamToolsOptions) {
  const subagent = tool(
    'Subagent',
    'Start a subagent: a separate slcode session, with its own agent and model, that does one task and returns its final answer as this tool result. '
      + 'It starts with no knowledge of this conversation, so the prompt must hold everything it needs. It cannot ask the user questions or start teammates. '
      + 'It closes after it answers; call ContinueSubagent to give it more work with its context. Launch several in one message to run them in parallel. '
      + 'Each subagent costs as much as a session of its own: for a short lookup use your built-in Agent tool.',
    {
      description: z.string().describe('A short (3-5 word) description of the task. It becomes the subagent name.'),
      prompt: z.string().describe('The task for the subagent to perform'),
      agent: z.string().optional().describe('An agent definition from the slcode agent list in your instructions. It gives the subagent that agent\'s instructions, and its model unless you set model'),
      model: z.string().optional().describe('A model name, or anthropic:<model> / openai:<model>. Defaults to the agent definition\'s model, else your model'),
      folder: z.string().optional().describe('The folder it works in. Defaults to your current folder'),
      run_in_background: z.boolean().optional().describe('Return at once with its id. Its answer arrives later as a <slcode-message kind="result">. Do not poll for it'),
    },
    async (a, extra) => {
      const bg = !!a.run_in_background;
      const args = ['team', 'new', a.folder ?? '.', '--subagent', '-n', a.description, ...(a.agent ? ['--agent', a.agent] : []), ...(a.model ? ['-m', a.model] : []), ...(bg ? [] : ['--wait'])];
      let id = '';
      const signal = signalOf(extra);
      const onAbort = () => { if (id) interrupt(o, id); };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const r = await runCli(o, args, a.prompt, signal, (err) => { id ||= /teammate ([0-9a-f]{8}) started/.exec(err)?.[1] ?? ''; });
        if (bg) return r.code === 0
          ? text(`Subagent ${r.out} started in the background. Its answer will arrive as a <slcode-message from="${r.out}" kind="result">. Do not poll for it; continue with other work.`)
          : text(r.err || `slcode exited with ${r.code}`, true);
        return answered(id || '?', r);
      } finally { signal?.removeEventListener('abort', onAbort); }
    },
  );
  const cont = tool(
    'ContinueSubagent',
    'Give more work to a subagent you started with the Subagent tool. It keeps its context from earlier tasks. Returns its final answer as this tool result.',
    {
      to: z.string().describe('The subagent id (or name)'),
      prompt: z.string().describe('The next task or follow-up'),
      run_in_background: z.boolean().optional().describe('Return at once. Its answer arrives later as a <slcode-message kind="result">'),
    },
    async (a, extra) => {
      const bg = !!a.run_in_background;
      const signal = signalOf(extra);
      const onAbort = () => interrupt(o, a.to);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const r = await runCli(o, ['prompt', a.to, ...(bg ? [] : ['--wait']), '--', a.prompt], null, signal);
        if (bg) return r.code === 0 ? text(`Sent to subagent ${a.to}. Its answer will arrive as a <slcode-message kind="result">. Do not poll for it.`) : text(r.err || `slcode exited with ${r.code}`, true);
        return answered(a.to, r);
      } finally { signal?.removeEventListener('abort', onAbort); }
    },
  );
  return [subagent, cont] as const;
}

export function teamMcp(o: TeamToolsOptions): McpSdkServerConfigWithInstance {
  // alwaysLoad — Agent 도구처럼 늘 보이게 (도구 검색 뒤로 미루지 않는다)
  return createSdkMcpServer({ name: 'slcode', tools: [...teamTools(o)], alwaysLoad: true, timeout: NO_LIMIT_MS });
}
