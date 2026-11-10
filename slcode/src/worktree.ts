// 팀원 worktree (ticket slcode-team-worktree, 사용자 결정 2026-11-11 — 최대한 Claude Code 의 `claude --worktree`·Agent `isolation: "worktree"` 에 가깝게).
// slcode 가 git 을 직접 부른다(git 이 범용이라 wtree 같은 도구에 맡기지 않는다). 리더 폴더가 속한 checkout 의 지금 HEAD 에서 새 브랜치 worktree-<이름> 을 만들어
// <원래 repo>.worktrees/<이름> 에 꺼낸다 (wtree 와 같은 꼴 — 리더가 다른 worktree 안에 있어도 원래 repo 옆). 브랜치·폴더가 이미 있으면 오류 (Claude 처럼 다시 열지 않는다).
// .worktreeinclude 는 Claude 의 파일을 그대로 읽는다 — 패턴에 맞고 gitignore 된 파일만 복사한다.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 팀원 meta.worktree — 띄운 때의 값. removedAt 은 clean-worktree·리더 닫힘 정리가 지운 시각 */
export type Worktree = {
  name: string;
  branch: string;
  /** worktree 폴더 = 팀원의 cwd */
  path: string;
  /** 원래 repo — git worktree remove·브랜치 삭제를 여기서 */
  repo: string;
  /** 만든 checkout(리더 폴더가 속한 것) — "리더 HEAD 에 합쳐졌나" 의 기준 */
  from: string;
  /** 가른 커밋 */
  base: string;
  removedAt?: number;
};

export const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type Run = { code: number; out: string; err: string };
function git(cwd: string, args: string[], input?: string): Run {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  // -z 출력은 다듬지 않는다 (이름 끝의 공백)
  const out = r.stdout ?? '';
  return { code: r.status ?? 1, out: args.includes('-z') ? out : out.trim(), err: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
}

function nameFrom(hint: string | undefined): string {
  return (hint ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 40).replace(/[-._]+$/, '');
}

function copyIncluded(from: string, to: string) {
  if (!fs.existsSync(path.join(from, '.worktreeinclude'))) return;
  const listed = git(from, ['ls-files', '-z', '--others', '--ignored', '--exclude-from=.worktreeinclude']);
  if (listed.code !== 0 || !listed.out) return;
  // 추적하지 않는 파일 중 gitignore 된 것만 (Claude: "Only files that match a pattern and are also gitignored are copied")
  const ignored = git(from, ['check-ignore', '-z', '--stdin'], listed.out);
  for (const rel of ignored.out.split('\0').filter(Boolean)) {
    const dst = path.join(to, rel);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(path.join(from, rel), dst);
  }
}

export function createWorktree(cwd: string, name: string | undefined, hint: string | undefined): Worktree {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new Error(`not a git repository: ${cwd} — --worktree needs one`);
  const from = top.out;
  const base = git(from, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (base.code !== 0) throw new Error(`${from} has no commit yet — a worktree starts from your HEAD, so commit once first`);
  const common = git(from, ['rev-parse', '--path-format=absolute', '--git-common-dir']).out;
  const repo = path.basename(common) === '.git' ? path.dirname(common) : from;
  const taken = (n: string) => fs.existsSync(path.join(`${repo}.worktrees`, n)) || git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/worktree-${n}`]).code === 0;
  if (name !== undefined) {
    if (!WORKTREE_NAME.test(name)) throw new Error(`bad worktree name '${name}' (letters, digits, . _ - — start with a letter or digit, 64 at most)`);
    if (taken(name)) throw new Error(`worktree ${name} already exists (folder ${path.join(`${repo}.worktrees`, name)} or branch worktree-${name}) — pick another worktree name`);
  } else {
    const stem = nameFrom(hint) || `wt-${randomBytes(3).toString('hex')}`;
    name = stem;
    for (let i = 2; taken(name); i++) name = `${stem}-${i}`;
  }
  const branch = `worktree-${name}`, dir = path.join(`${repo}.worktrees`, name);
  const add = git(from, ['worktree', 'add', '-b', branch, dir, base.out]);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.err}`);
  const wt: Worktree = { name, branch, path: dir, repo, from, base: base.out };
  try { copyIncluded(from, dir); } catch (e) { removeWorktree(wt, true); throw new Error(`copying .worktreeinclude files failed: ${(e as Error).message}`); }
  return wt;
}

export function worktreeLoss(wt: Worktree): string | null {
  if (!fs.existsSync(wt.path)) return null;
  const why: string[] = [];
  const st = git(wt.path, ['status', '--porcelain']);
  if (st.code !== 0) return `git status failed in ${wt.path}: ${st.err}`;
  if (st.out) why.push(`uncommitted changes in ${wt.path}`);
  const at = fs.existsSync(wt.from) ? wt.from : wt.repo;
  if (git(at, ['merge-base', '--is-ancestor', wt.branch, 'HEAD']).code !== 0) why.push(`commits on ${wt.branch} not merged into the HEAD of ${at}`);
  return why.length ? why.join('; ') : null;
}

export function removeWorktree(wt: Worktree, force: boolean) {
  if (fs.existsSync(wt.path)) {
    const rm = git(wt.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path]);
    if (rm.code !== 0) throw new Error(`git worktree remove failed: ${rm.err}`);
  } else git(wt.repo, ['worktree', 'prune']);
  try { fs.rmdirSync(path.dirname(wt.path)); } catch { /* 다른 worktree 가 남아 있다 */ }
  // 합쳐졌는지는 worktreeLoss 가 리더 HEAD 로 봤다 — -d 는 upstream·지금 브랜치 기준이라 -D
  const br = git(wt.repo, ['branch', '-D', wt.branch]);
  if (br.code !== 0 && git(wt.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`]).code === 0) throw new Error(`deleting branch ${wt.branch} failed: ${br.err}`);
}
