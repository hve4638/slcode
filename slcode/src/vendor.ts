// 벤더 하네스(Claude Code·Codex)가 직접 저장한 세션 찾기 — `slcode import` 가 쓴다 (ticket vendor-import, 2026-10-07).
//   claude  $CLAUDE_CONFIG_DIR(기본 ~/.claude)/projects/<cwd 슬러그>/<id>.jsonl — 줄마다 cwd 가 붙는다 (슬러그는 되돌릴 수 없어 본문에서 읽는다)
//   codex   $CODEX_HOME(기본 ~/.codex)/sessions/YYYY/MM/DD/rollout-<시각>-<id>.jsonl — 첫 줄 session_meta.payload.cwd
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import type { Vendor } from './protocol.js';

export type VendorSession = { vendor: Vendor; id: string; cwd: string; file: string };

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

/** 파일 앞부분(최대 1MB)의 완성된 줄들 — 세션 기록은 클 수 있어 통째로 읽지 않는다 */
function headLines(file: string, max = 1 << 20): string[] {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8').split('\n');
  } finally { fs.closeSync(fd); }
}

function findClaude(id: string): VendorSession | null {
  const root = path.join(claudeHome(), 'projects');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(root, d, `${id}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of headLines(file)) {
      try { const o = JSON.parse(line); if (typeof o.cwd === 'string') return { vendor: 'claude', id, cwd: o.cwd, file }; } catch {}
    }
  }
  return null;
}

function findCodex(id: string): VendorSession | null {
  const walk = (dir: string): string | null => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const f = walk(p); if (f) return f; }
      else if (e.name.startsWith('rollout-') && e.name.endsWith(`-${id}.jsonl`)) return p;
    }
    return null;
  };
  const file = walk(path.join(codexHome(), 'sessions'));
  if (!file) return null;
  try {
    const o = JSON.parse(headLines(file, 1 << 16)[0]);
    if (o.type === 'session_meta' && typeof o.payload?.cwd === 'string') return { vendor: 'codex', id, cwd: o.payload.cwd, file };
  } catch {}
  return null;
}

/** Claude 기록의 마지막 대화 항목 uuid (서브에이전트 곁가지 제외) — 가져온 세션의 첫 턴 되돌림 지점. 뒤쪽 1MB 만 본다 */
export function claudeLastUuid(file: string, max = 1 << 20): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(max, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const o = JSON.parse(lines[i]); if ((o.type === 'user' || o.type === 'assistant') && !o.isSidechain && typeof o.uuid === 'string') return o.uuid; } catch {}
    }
    return null;
  } finally { fs.closeSync(fd); }
}

/** 벤더 세션 id 로 기록 파일을 찾는다. vendor 를 주면 그쪽만 */
export function findVendorSession(id: string, vendor?: Vendor): VendorSession | null {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null; // 경로 조각이 될 수 없는 id
  return (vendor !== 'codex' ? findClaude(id) : null) ?? (vendor !== 'claude' ? findCodex(id) : null);
}

/** Claude 세션을 SDK forkSession 으로 갈라 새 세션 id 를 받는다 — 원본은 그대로, 메시지 uuid 는 새로 매겨진다(file-history 는 따라오지 않는다) */
export async function forkClaude(id: string, cwd: string): Promise<string> {
  return (await forkSession(id, { dir: cwd })).sessionId;
}

/** 벤더 하네스에서 이어 갈 명령 한 줄 — `slcode export` */
export function vendorResumeCommand(vendor: Vendor, cwd: string, id: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return `cd ${q(cwd)} && ${vendor === 'codex' ? 'codex resume' : 'claude --resume'} ${id}`;
}
