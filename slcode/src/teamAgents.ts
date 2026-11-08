// 팀원 에이전트 정의 (ticket slcode-team-agent, 사용자 결정 2026-11-09) — 팀원을 띄울 때 쓰는 설정 묶음에 붙인 이름 (`slcode team new --agent <이름>`).
// Markdown 파일 하나에 하나 (Claude Code .claude/agents/*.md 와 같은 꼴): 파일 이름이 에이전트 이름, frontmatter 는 description·model·effort·mode·relation·profile,
// 본문은 팀원에게 줄 지시문. 폴더에서 위로 올라가며 .slcode/agents/, 그다음 상태 폴더의 agents/ — 같은 이름은 가까운 것이 이긴다.
// 값의 검사는 쓰는 쪽(cli team new)이 한다.
import fs from 'node:fs';
import path from 'node:path';
import { frontmatter } from 'slcode-plugin/agentFormat';

export type AgentDef = {
  name: string; file: string; description: string; instructions: string;
  model?: string; effort?: string; mode?: string; relation?: string; profile?: string;
};
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function agentDirs(cwd: string, dir: string): string[] {
  const out: string[] = [];
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    out.push(path.join(d, '.slcode', 'agents'));
    if (path.dirname(d) === d) break;
  }
  return [...out, path.join(dir, 'agents')];
}

function readAgent(file: string, name: string): AgentDef | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { fields: f, body } = frontmatter(text);
  const opt = (k: string) => (f[k] ? { [k]: f[k] } : {});
  return { name, file, description: f.description ?? '', instructions: body.trim(), ...opt('model'), ...opt('effort'), ...opt('mode'), ...opt('relation'), ...opt('profile') };
}

export function listAgents(cwd: string, dir: string): AgentDef[] {
  const seen = new Map<string, AgentDef>();
  for (const d of agentDirs(cwd, dir)) {
    let names: string[];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      const name = n.endsWith('.md') ? n.slice(0, -3) : '';
      if (!NAME.test(name) || seen.has(name)) continue;
      const a = readAgent(path.join(d, n), name);
      if (a) seen.set(name, a);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgent(cwd: string, dir: string, name: string): AgentDef | null {
  if (!NAME.test(name)) return null;
  for (const d of agentDirs(cwd, dir)) { const a = readAgent(path.join(d, `${name}.md`), name); if (a) return a; }
  return null;
}
