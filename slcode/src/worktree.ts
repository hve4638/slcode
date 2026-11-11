// 팀원 worktree (ticket slcode-team-worktree, 사용자 결정 2026-11-11 — 최대한 Claude Code 의 `claude --worktree`·Agent `isolation: "worktree"` 에 가깝게).
// slcode 가 git 을 직접 부른다(git 이 범용이라 wtree 같은 도구에 맡기지 않는다). 리더 폴더가 속한 checkout 의 지금 HEAD 에서 새 브랜치 <이름> 을 만들어
// <원래 repo>.worktrees/<이름의 / 를 - 로> 에 꺼낸다 (wtree 와 같은 꼴 — 리더가 다른 worktree 안에 있어도 원래 repo 옆). 브랜치·폴더가 이미 있으면 오류 (Claude 처럼 다시 열지 않는다).
// 브랜치는 이름 그대로 (ticket slcode-team-worktree-self, 사용자 2026-11-11 — feat/x 를 받으려고 worktree- 앞머리를 없앴다). 가른 브랜치는 git config branch.<브랜치>.slcodeparent 에 —
// git branch -m 이면 따라가고 -D 면 함께 지워진다. 잃을 작업은 wtree 기준(src/repo.rs reflected_in_parent·confirmation_key): 커밋하지 않은 변경, 부모 브랜치에 반영되지 않은 커밋.
// .worktreeinclude 는 Claude 의 파일을 그대로 읽는다 — 패턴에 맞고 gitignore 된 파일만 복사한다.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 팀원 meta.worktree — 띄운 때의 값. removedAt 은 clean-worktree·리더 닫힘 정리가 지운 시각. 부모 브랜치는 meta 가 아니라 git config 에 (parentBranch) */
export type Worktree = {
  /** --worktree 의 이름 = 브랜치 이름 (폴더는 / 를 - 로) */
  name: string;
  branch: string;
  /** worktree 폴더 = 팀원의 cwd */
  path: string;
  /** 원래 repo — git worktree remove·브랜치 삭제를 여기서 */
  repo: string;
  /** 만든 checkout(리더 폴더가 속한 것) — 부모 브랜치가 없을 때(리더가 detached HEAD) "합쳐졌나" 의 기준은 그 HEAD */
  from: string;
  /** 가른 커밋 */
  base: string;
  removedAt?: number;
};

/** 부모 브랜치를 적는 git config 키 — branch.<브랜치>.<이것>. orchestration 플러그인도 읽는다 (사용자 2026-11-11) */
export const PARENT_KEY = 'slcodeparent';
/** 폴더 이름 — 브랜치 이름의 / 를 - 로. 그 밖의 규칙은 없다 (사용자 2026-11-11) */
export const folderOf = (name: string) => name.replace(/\//g, '-');

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
  const root = `${repo}.worktrees`;
  const taken = (n: string) => fs.existsSync(path.join(root, folderOf(n))) || git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${n}`]).code === 0;
  if (name !== undefined) {
    if (git(repo, ['check-ref-format', '--branch', name]).code !== 0 || name.startsWith('-')) throw new Error(`bad worktree name '${name}' — it is the branch name, so it must be a valid git branch name`);
    if (taken(name)) throw new Error(`worktree ${name} already exists (folder ${path.join(root, folderOf(name))} or branch ${name}) — pick another worktree name`);
  } else {
    const stem = nameFrom(hint) || `wt-${randomBytes(3).toString('hex')}`;
    name = stem;
    for (let i = 2; taken(name); i++) name = `${stem}-${i}`;
  }
  const branch = name, dir = path.join(root, folderOf(name));
  // <repo>.worktrees 를 repo 안에 두는 사람(…/repo/x.worktrees)도 있어 그 폴더는 통째로 무시된다
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(path.join(root, '.gitignore'))) fs.writeFileSync(path.join(root, '.gitignore'), '*\n');
  const add = git(from, ['worktree', 'add', '-b', branch, dir, base.out]);
  if (add.code !== 0) { dropRoot(root); throw new Error(`git worktree add failed: ${add.err}`); }
  const wt: Worktree = { name, branch, path: dir, repo, from, base: base.out };
  // 부모 브랜치 — 리더 checkout 이 브랜치 위에 있을 때만 (detached HEAD 면 적지 않고 그 HEAD 를 기준으로)
  const parent = git(from, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  try {
    if (parent.code === 0 && parent.out) { const c = git(repo, ['config', `branch.${branch}.${PARENT_KEY}`, parent.out]); if (c.code !== 0) throw new Error(c.err); }
    copyIncluded(from, dir);
  } catch (e) { removeWorktree(wt, true); throw new Error(`setting up the worktree failed: ${(e as Error).message}`); }
  return wt;
}

/** 가른 브랜치 — git config 의 slcodeparent. 없으면(리더가 detached HEAD, 옛 worktree) null */
export function parentBranch(wt: Worktree): string | null {
  const r = git(wt.repo, ['config', '--get', `branch.${wt.branch}.${PARENT_KEY}`]);
  return r.code === 0 && r.out ? r.out : null;
}

/** <repo>.worktrees 에 우리가 넣은 .gitignore 만 남았으면 폴더째 지운다 */
function dropRoot(root: string) {
  try {
    const left = fs.readdirSync(root);
    if (left.length === 1 && left[0] === '.gitignore') fs.rmSync(path.join(root, '.gitignore'));
    fs.rmdirSync(root);
  } catch { /* 다른 worktree 가 남아 있다 */ }
}

/** branch 의 작업이 parent 에 이미 있나 — wtree src/repo.rs reflected_in_parent 의 네 시험(같은 커밋, 조상, 갈라진 뒤 바꾼 것 없음, 합친 트리가 부모 트리와 같음 = squash) */
function reflected(repo: string, parent: string, branch: string): boolean {
  const oid = (rev: string) => git(repo, ['rev-parse', '--verify', '--quiet', rev]).out;
  if (oid(parent) === oid(branch)) return true;
  if (git(repo, ['merge-base', '--is-ancestor', branch, parent]).code === 0) return true;
  const base = git(repo, ['merge-base', parent, branch]);
  if (base.code === 0 && oid(`${base.out}^{tree}`) === oid(`${branch}^{tree}`)) return true;
  const merged = git(repo, ['merge-tree', '--write-tree', parent, branch]);
  return merged.code === 0 && merged.out.split('\n')[0].trim() === oid(`${parent}^{tree}`);
}

/** 확인 키 — wtree src/repo.rs confirmation_key 와 같은 재료(HEAD, HEAD 와의 diff, 추적하지 않는 파일 이름과 내용)의 해시 앞 5자리. 무엇이든 바뀌면 키도 바뀐다 */
function confirmationKey(wt: Worktree): string {
  const h = createHash('sha1');
  if (fs.existsSync(wt.path)) {
    const untracked = git(wt.path, ['ls-files', '--others', '--exclude-standard']).out;
    h.update([git(wt.path, ['rev-parse', 'HEAD']).out, git(wt.path, ['diff', 'HEAD']).out, untracked, untracked ? git(wt.path, ['hash-object', '--stdin-paths'], `${untracked}\n`).out : ''].join('\0'));
  } else h.update(git(wt.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`]).out);
  return h.digest('hex').slice(0, 5);
}

/** 지우면 잃는 것 — reasons 와 그것을 버리고 지울 확인 키 */
export type Loss = { reasons: string; key: string };

/** 잃을 작업 (wtree 기준) — 커밋하지 않은 변경(추적하지 않는 파일 포함)과 부모 브랜치에 반영되지 않은 브랜치 커밋. 부모 브랜치가 없으면 만든 checkout 의 지금 HEAD 가 기준.
 *  없으면 null. 브랜치가 이미 없으면 커밋은 보지 않는다 */
export function worktreeLoss(wt: Worktree): Loss | null {
  const why: string[] = [];
  if (fs.existsSync(wt.path)) {
    const st = git(wt.path, ['status', '--porcelain']);
    if (st.code !== 0) why.push(`git status failed in ${wt.path}: ${st.err}`);
    else if (st.out) why.push(`uncommitted changes in ${wt.path}`);
  }
  if (git(wt.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`]).code === 0) {
    const parent = parentBranch(wt);
    if (parent) {
      if (git(wt.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${parent}`]).code !== 0) why.push(`its parent branch ${parent} no longer exists`);
      else if (!reflected(wt.repo, parent, wt.branch)) why.push(`commits on ${wt.branch} not in ${parent}`);
    } else {
      const at = fs.existsSync(wt.from) ? wt.from : wt.repo;
      if (!reflected(at, 'HEAD', wt.branch)) why.push(`commits on ${wt.branch} not in the HEAD of ${at}`);
    }
  }
  return why.length ? { reasons: why.join('; '), key: confirmationKey(wt) } : null;
}

export function removeWorktree(wt: Worktree, force: boolean) {
  if (fs.existsSync(wt.path)) {
    const rm = git(wt.repo, ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path]);
    if (rm.code !== 0) throw new Error(`git worktree remove failed: ${rm.err}`);
  } else git(wt.repo, ['worktree', 'prune']);
  dropRoot(path.dirname(wt.path));
  // 반영됐는지는 worktreeLoss 가 부모 브랜치로 봤다 — -d 는 upstream·지금 브랜치 기준이라 -D. 브랜치의 slcodeparent 도 함께 지워진다
  const br = git(wt.repo, ['branch', '-D', wt.branch]);
  if (br.code !== 0 && git(wt.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`]).code === 0) throw new Error(`deleting branch ${wt.branch} failed: ${br.err}`);
}
