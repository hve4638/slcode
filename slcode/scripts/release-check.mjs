#!/usr/bin/env node
// 릴리스 확인 (ticket slcode-release-check-script). 판 번호를 올리고, 판마다 같은 확인을 돌려 항목마다 PASS/FAIL 표를 낸다.
//
//   scripts/release-check.mjs <옛 판> <새 판>      예: scripts/release-check.mjs 0.5.11 0.5.12
//
// 옛 판은 지난 공개판이다(태그 v<옛 판> 이 있어야 한다). 판이 아직 옛 판이면 plugin.json·slcode/package.json 의 version 과
// plugin.json binary.version(^<새 판>, 시험판은 판 그대로)을 고친다. 커밋·태그는 하지 않는다.
// superlite 데모·실제 벤더가 드는 e2e 확인은 넣지 않는다(사용자 결정 2026-11-17). 새 기능의 동작은 pnpm test 가 본다.
// 항목별 출력은 release/check-<새 판>/ 에 남는다. 모두 PASS 면 exit 0.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stepRun } from './workflowStep.mjs';

const SL = fileURLToPath(new URL('..', import.meta.url)); // slcode/
const ROOT = fileURLToPath(new URL('../..', import.meta.url)); // repo (plugin.json·main.js)
const PLATS = ['linux-x64', 'linux-arm64', 'win-x64'];

const [OLD, NEW] = process.argv.slice(2);
const { parseVersion, pickRelease, installState } = await import(ROOT + 'main.js');
if (!parseVersion(OLD ?? '') || !parseVersion(NEW ?? '')) {
  console.error('쓰는 법: scripts/release-check.mjs <옛 판> <새 판>   예: 0.5.11 0.5.12');
  process.exit(2);
}
const LOGS = `${SL}release/check-${NEW}/`;
mkdirSync(LOGS, { recursive: true });

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
const git = (...a) => sh('git', ['-C', ROOT, ...a]);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
class Fail extends Error {}
const fail = (msg) => { throw new Fail(msg); };

// ---- 표: 한글은 터미널에서 두 칸이다
const width = (s) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ㄰-㆏가-힣]/.test(c) ? 2 : 1), 0);
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const rows = [];
let stopped = false;
function item(no, name, fn, skip = stopped && '판 번호가 FAIL 이라 건너뜀') {
  let result, note;
  if (skip) [result, note] = ['-', skip];
  else {
    try { [result, note] = ['PASS', fn()]; } catch (e) { [result, note] = ['FAIL', e instanceof Fail ? e.message : String(e?.stack ?? e)]; }
  }
  rows.push(result);
  console.log(` ${no}  ${pad(name, 14)}  ${pad(result, 4)}  ${note}`);
  return result === 'PASS';
}
const logTo = (file, r) => { writeFileSync(LOGS + file, `${r.stdout ?? ''}${r.stderr ?? ''}`); return LOGS + file; };

console.log(`release-check ${OLD} → ${NEW}`);
console.log(` #  ${pad('항목', 14)}  결과  내용`);

// 1. 판 번호 — 고친 뒤 Actions 의 "태그와 버전 대조" 셸을 v<새 판> 으로 그대로 돌린다
stopped = !item(1, '판 번호', () => {
  if (git('rev-parse', '-q', '--verify', `refs/tags/v${OLD}`).status !== 0) fail(`태그 v${OLD} 가 없다 (git fetch --tags)`);
  if (cmp(parseVersion(NEW), parseVersion(OLD)) <= 0) fail(`새 판 ${NEW} 가 옛 판 ${OLD} 보다 크지 않다`);
  const cond = NEW.includes('-') ? NEW : `^${NEW}`;
  const plugin = readJson(ROOT + 'plugin.json'), pkg = readJson(SL + 'package.json');
  let note;
  if (plugin.version === NEW && pkg.version === NEW) note = `이미 ${NEW}, binary ${plugin.binary.version}`;
  else if (plugin.version === OLD && pkg.version === OLD) {
    bump(ROOT + 'plugin.json', [[/("version": )"[^"]*"/, `$1"${NEW}"`], [/("binary": \{[^}]*"version": )"[^"]*"/, `$1"${cond}"`]]);
    bump(SL + 'package.json', [[/("version": )"[^"]*"/, `$1"${NEW}"`]]);
    note = `${OLD} → ${NEW}, binary ${plugin.binary.version} → ${cond}`;
  } else fail(`plugin.json ${plugin.version}·slcode/package.json ${pkg.version} 가 옛 판도 새 판도 아니다`);
  const r = sh('bash', ['-e', '-c', stepRun('태그와 버전 대조')], { cwd: ROOT, env: { ...process.env, TAG: `v${NEW}` } });
  logTo('1-version.log', r);
  if (r.status !== 0) fail(`Actions 의 버전 대조 실패: ${r.stderr.trim().split('\n')[0]}`);
  return note;
});

// 2. slcode-plugin — sfa·lead-plugin 이 사본을 넣어 간다. 바뀌었으면 판도 올라야 superlite 가 Update 를 띄운다
item(2, 'slcode-plugin', () => {
  const dir = 'slcode/slcode-plugin';
  const was = JSON.parse(git('show', `v${OLD}:${dir}/package.json`).stdout).version;
  const now = readJson(SL + 'slcode-plugin/package.json').version;
  const files = git('diff', '--name-only', `v${OLD}`, '--', dir).stdout.trim().split('\n').filter(Boolean);
  if (!files.length) return `변경 없음 (${now})`;
  if (was === now) fail(`변경 ${files.length}개 파일인데 판이 ${now} 그대로다 — slcode-plugin/package.json 판을 올린다`);
  return `변경 있음 ${was} → ${now} (${files.length}개 파일) — sfa·lead-plugin 에 알린다`;
});

// 3. 판 비교 — 플러그인이 새 판 바이너리를 고르고 옛 판 설치를 업데이트 대상으로 보는가
item(3, '판 비교', () => {
  const cond = readJson(ROOT + 'plugin.json').binary.version;
  const rel = (v, prerelease = false) => ({ tag_name: `v${v}`, draft: false, prerelease, assets: PLATS.map((p) => ({ name: `slcode-${v}-${p}.zip`, browser_download_url: `http://x/${v}/${p}` })) });
  const n = parseVersion(NEW), next = `${n.major}.${n.minor}.${n.patch + 1}-beta.1`;
  const checks = [];
  const expect = (what, got, want) => checks.push([what, JSON.stringify(got), JSON.stringify(want)]);
  for (const order of [[OLD, NEW], [NEW, OLD]]) for (const p of PLATS) expect(`pickRelease ${order} ${p}`, pickRelease(order.map((v) => rel(v)), cond, p).version, NEW);
  expect(`pickRelease ${NEW} 없음`, 'error' in pickRelease([rel(OLD)], cond, 'linux-x64'), true);
  if (!NEW.includes('-')) expect(`pickRelease 시험판 ${next} 함께`, pickRelease([rel(next, true), rel(NEW), rel(OLD)], cond, 'linux-x64').version, NEW);
  expect(`installState ${OLD}`, installState(JSON.stringify({ version: OLD, platform: 'linux-x64' }), cond, 'linux-x64'), 'outdated');
  expect(`installState ${NEW}`, installState(JSON.stringify({ version: NEW, platform: 'linux-x64' }), cond, 'linux-x64'), 'installed');
  writeFileSync(LOGS + '3-versions.log', checks.map((c) => c.join('  ')).join('\n') + '\n');
  const bad = checks.filter(([, got, want]) => got !== want);
  if (bad.length) fail(bad.map(([w, g, x]) => `${w}: ${g} (기대 ${x})`).join('; '));
  return `단언 ${checks.length}개 (조건 ${cond})`;
});

// 4. 빌드 — release.sh 가 pnpm install·build 뒤 세 플랫폼 zip 을 만든다. 커밋한 slcode-plugin/dist 가 빌드와 같아야 한다(Actions 와 같은 대조)
let built = false;
item(4, '빌드', () => {
  const t = Date.now();
  const r = sh(SL + 'scripts/release.sh', [], { cwd: SL });
  const log = logTo('4-build.log', r);
  if (r.status !== 0) fail(`release.sh 실패 → ${log}`);
  built = true;
  const dirty = git('status', '--porcelain', '--', 'slcode/slcode-plugin/dist').stdout.trim();
  if (dirty) fail(`slcode-plugin/dist 가 src 와 다르다 — pnpm build 뒤 커밋: ${dirty.split('\n').length}개 파일`);
  return `zip ${PLATS.length}개, dist 대조 일치 (${Math.round((Date.now() - t) / 1000)}초)`;
});

// 5. zip — manifest 판·플랫폼, 동봉 node, 플랫폼별 claude 실행 파일, 이 머신 플랫폼 zip 의 연기 검사
const noBuild = () => stopped ? '판 번호가 FAIL 이라 건너뜀' : !built && 'release.sh 가 실패해 건너뜀';
item(5, 'zip', () => {
  const sdk = { 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64', 'win-x64': 'win32-x64' };
  const errs = [];
  for (const p of PLATS) {
    const zip = `${SL}release/slcode-${NEW}-${p}.zip`, exe = p === 'win-x64' ? '.exe' : '';
    const ls = sh('unzip', ['-Z1', zip]);
    if (ls.status !== 0) { errs.push(`${p}: zip 없음`); continue; }
    const names = new Set(ls.stdout.split('\n'));
    const m = JSON.parse(sh('unzip', ['-p', zip, 'manifest.json']).stdout || '{}');
    if (m.version !== NEW || m.platform !== p) errs.push(`${p}: manifest ${m.version}/${m.platform}`);
    for (const f of [`runtime/node${exe}`, 'bin/slcode', 'bin/slcode.cmd', `node_modules/@anthropic-ai/claude-agent-sdk-${sdk[p]}/claude${exe}`, 'node_modules/slcode-plugin/dist/hookMain.js']) {
      if (!names.has(f)) errs.push(`${p}: ${f} 없음`);
    }
  }
  const here = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  const r = sh(SL + 'scripts/smoke.sh', [`${SL}release/slcode-${NEW}-${here}.zip`], { cwd: SL });
  const log = logTo('5-smoke.log', r);
  if (r.status !== 0) errs.push(`${here} 연기 검사 실패 → ${log}`);
  if (errs.length) fail(errs.join('; '));
  return `${PLATS.join('·')} 목록 맞음, ${here} 연기 검사 통과`;
}, noBuild());

// 6. 테스트 — CI 와 같은 pnpm test. 새 기능의 동작 확인은 여기에 든다. publish 셸 흉내는 test/releaseChannel.test.ts
item(6, '테스트', () => {
  const t = Date.now();
  const r = sh('pnpm', ['test'], { cwd: SL, timeout: 10 * 60_000 });
  const log = logTo('6-test.log', r);
  const count = (k) => Number(new RegExp(`^ℹ ${k} (\\d+)$`, 'm').exec(r.stdout)?.[1] ?? NaN);
  const sum = `${count('tests')}개 중 통과 ${count('pass')}·실패 ${count('fail')}·skip ${count('skipped')} (${Math.round((Date.now() - t) / 1000)}초)`;
  if (r.error?.code === 'ETIMEDOUT') fail(`10분 넘음 → ${log}`);
  const failing = (r.stdout.split('✖ failing tests:')[1] ?? '').split('\n').filter((l) => l.startsWith('test at '));
  if (r.status !== 0) fail(`${sum}${failing.length ? ` [${failing.map((l) => l.slice(8)).join(', ')}]` : ''} → ${log}`);
  return sum;
}, noBuild());

const n = (r) => rows.filter((x) => x === r).length;
console.log(`${n('PASS')} PASS / ${n('FAIL')} FAIL${n('-') ? ` / ${n('-')} 건너뜀` : ''}   기록 ${LOGS}`);
process.exit(n('PASS') === rows.length ? 0 : 1);

function bump(file, edits) {
  let s = readFileSync(file, 'utf8');
  for (const [re, to] of edits) {
    if (!re.test(s)) fail(`${file} 에서 ${re} 를 찾지 못했다`);
    s = s.replace(re, to);
  }
  writeFileSync(file, s);
}
function cmp(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
    || (a.pre === b.pre ? 0 : a.pre === null ? 1 : b.pre === null ? -1 : a.pre < b.pre ? -1 : 1);
}
