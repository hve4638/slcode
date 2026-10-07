// 가짜 codex app-server — stdio JSON 줄 프로토콜의 최소 흉내 (테스트용, API 호출 없음).
// initialize·thread/start·thread/resume·thread/fork(새 id fork-<원본>)·model/list·turn/start·turn/interrupt·thread/compact/start 에 답하고, turn/start 뒤 델타 → 명령 승인 요청 → 완료 알림을 낸다.
import readline from 'node:readline';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const notify = (method, params) => out({ jsonrpc: '2.0', method, params });
let reqId = 100; const thread = { id: 'thr-1', cwd: process.cwd() };
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method === undefined) { // 우리 서버 요청에 대한 응답 (승인)
    if (m.id === 100) { notify('item/completed', { threadId: thread.id, turnId: 't-1', item: { type: 'commandExecution', id: 'exec-1', command: 'touch x', cwd: thread.cwd, status: m.result?.decision === 'accept' || m.result?.decision === 'acceptForSession' ? 'completed' : 'declined', exitCode: 0, aggregatedOutput: 'ok' } });
      notify('item/agentMessage/delta', { threadId: thread.id, turnId: 't-1', itemId: 'msg-2', delta: `decision=${m.result?.decision}` });
      notify('thread/tokenUsage/updated', { threadId: thread.id, turnId: 't-1', tokenUsage: { total: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 100, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 }, last: { totalTokens: 500, inputTokens: 450, cachedInputTokens: 50, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 0 }, modelContextWindow: 200000 } });
      notify('turn/completed', { threadId: thread.id, turn: { id: 't-1', status: 'completed', error: null, durationMs: 12, items: [] } }); }
    return;
  }
  const reply = (result) => out({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({ userAgent: 'fake/0.0.1 (test)', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' });
    case 'initialized': return;
    case 'thread/start': case 'thread/resume': return reply({ thread: { id: m.method === 'thread/resume' ? m.params.threadId : thread.id, turns: [] }, model: m.params.model ?? 'fake-model', modelProvider: 'fake', cwd: m.params.cwd, approvalPolicy: m.params.approvalPolicy, sandbox: {}, reasoningEffort: 'medium' });
    case 'thread/fork': return reply({ thread: { id: `fork-${m.params.threadId}`, turns: [] }, model: m.params.model ?? 'fake-model', modelProvider: 'fake', cwd: m.params.cwd, approvalPolicy: m.params.approvalPolicy, sandbox: {}, reasoningEffort: 'medium' });
    case 'model/list': return reply({ data: [{ id: 'fake-model', model: 'fake-model', displayName: 'Fake 1.0', description: 'test', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium' }], nextCursor: null });
    case 'account/rateLimits/read': return reply({ rateLimits: { primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1800500000 } } });
    case 'thread/compact/start': {
      reply({});
      notify('turn/started', { threadId: thread.id, turn: { id: 't-c' } });
      notify('item/started', { threadId: thread.id, turnId: 't-c', item: { type: 'contextCompaction', id: 'c-1' } });
      notify('item/completed', { threadId: thread.id, turnId: 't-c', item: { type: 'contextCompaction', id: 'c-1' } });
      notify('turn/completed', { threadId: thread.id, turn: { id: 't-c', status: 'completed', items: [] } });
      break;
    }
    case 'turn/start': {
      reply({ turn: { id: 't-1', status: 'inProgress' } });
      const text = m.params.input.find((i) => i.type === 'text')?.text ?? '';
      notify('turn/started', { threadId: thread.id, turn: { id: 't-1' } });
      notify('item/reasoning/summaryTextDelta', { threadId: thread.id, turnId: 't-1', itemId: 'rs-1', delta: 'thinking', summaryIndex: 0 });
      notify('item/agentMessage/delta', { threadId: thread.id, turnId: 't-1', itemId: 'msg-1', delta: `echo:${text.slice(0, 20)}` });
      notify('item/started', { threadId: thread.id, turnId: 't-1', item: { type: 'commandExecution', id: 'exec-1', command: 'touch x', cwd: thread.cwd, status: 'inProgress' } });
      out({ jsonrpc: '2.0', id: reqId, method: 'item/commandExecution/requestApproval', params: { kind: 'command', threadId: thread.id, turnId: 't-1', itemId: 'exec-1', command: 'touch x', cwd: thread.cwd, reason: 'outside sandbox', approvalPolicy: m.params.approvalPolicy, sandboxPolicy: m.params.sandboxPolicy } });
      return;
    }
    case 'turn/interrupt': reply({}); notify('turn/completed', { threadId: thread.id, turn: { id: 't-1', status: 'interrupted', error: null, durationMs: 1, items: [] } }); return;
    default: return out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
  }
});
