#!/usr/bin/env node
// 훅 명령의 가벼운 진입점 (ticket slcode-agent-plugin-script-portable) — export 한 hooks.json 이 `<slcode 의 node> <dist>/hookMain.js <claude|codex> <플러그인 폴더> <이벤트>` 로 부른다.
// cli.js 는 동사 전체를 싣느라 뜨는 데 오래 걸려(약 180ms, 2026-10-30 실측) 도구 호출마다 뜨는 훅에는 따로 둔다. `slcode hook …` 도 같은 함수를 부른다.
// --broker <소켓>: 세션 중간 프로세스로 뜬다(훅 명령이 detached 로 띄운다).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESSES, hookCommand, isHookEvent, serveBroker, type Harness } from './hookBroker.js';

const SELF = fileURLToPath(import.meta.url);

/** 이 설치를 가리키는 값 — 같은 세션이라도 slcode 설치가 다르면 중간 프로세스를 따로 둔다 */
const install = () => fs.realpathSync(path.dirname(SELF));

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const parts: Buffer[] = [];
    process.stdin.on('data', (d: Buffer) => parts.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

/** 중간 프로세스를 띄운다 — 이 진입점을 같은 node 로, 부모와 떨어진 새 그룹으로. 로그는 소켓 옆 파일 */
function spawnBroker(sock: string, cwd: string) {
  let out: number | 'ignore' = 'ignore';
  try { if (process.platform !== 'win32') fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 }); out = fs.openSync(process.platform === 'win32' ? path.join(process.env.TEMP ?? '.', 'slcode-hooks-broker.log') : `${sock}.log`, 'a'); } catch {}
  const p = spawn(process.execPath, [...process.execArgv, SELF, '--broker', sock], { cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true });
  p.unref();
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--broker' && argv[1]) {
    await serveBroker(argv[1], { log: (t) => console.log(`${new Date().toISOString()} ${t}`) });
    return 0;
  }
  const [harness, root, event] = argv;
  if (!HARNESSES.includes(harness as Harness) || !root || !event || !isHookEvent(event)) {
    console.error('usage: slcode hook <claude|codex> <plugin folder> <event>   (hook input JSON on stdin)');
    return 2;
  }
  const out = await hookCommand(harness as Harness, root, event, await readStdin(), process.env, { install: install(), spawnBroker });
  process.stdout.write(`${out}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
