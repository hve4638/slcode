#!/usr/bin/env node
// slcode-plugin 명령 (ticket slcode-plugin-split) — `slcode-plugin <add|remove|set|list|export|hook> …`. `slcode plugin …` 도 같은 함수(pluginCommand)를 부른다.
// 쓰는 쪽(superlite-for-agents)은 자기 폴더에 넣어 간 사본을 자기 node 로 부른다: `<node> <사본>/dist/cli.js add <폴더>`. 결과는 stdout JSON(list·export 는 --json 일 때).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPlugin, agentPaths, exportPlugin, listPlugins, refreshLauncher, removePlugin, scriptWarnings, setPlugin } from './agentPlugins.js';
import { defaultStateDir } from './paths.js';
import { PLUGIN_VERSION } from './launcher.js';

export type PluginFlags = { to?: string[]; remove?: boolean; json?: boolean };
const print = (o: unknown) => console.log(JSON.stringify(o, null, 2));

/** plugin 하위 명령 하나. usage 는 인자가 틀렸을 때 부른다(돌아오지 않는다). tag 는 stderr 경고 줄의 머리 */
export async function pluginCommand(sub: string | undefined, args: string[], flags: PluginFlags, dir: string, usage: (msg: string) => never, tag = 'slcode-plugin') {
  const err = (msg: string) => console.error(`[${tag}] ${msg}`);
  /** 빌드한 js/ts 훅의 보고 — 빼거나 고칠 것과 하네스별 tsc 검사 경고를 stderr 에 (ticket slcode-agent-plugin-script-portable). 경고일 뿐 빌드는 그대로 */
  const scriptReport = async (name: string, build: string) => {
    const lines = await scriptWarnings(name, build, dir);
    if (lines.length) err(`${name}: js/ts hooks\n${lines.join('\n')}`);
  };
  try { refreshLauncher(agentPaths(dir)); } catch {} // 이 사본의 node 로 훅 런처를 맞춘다 (launcher.ts)
  if (sub === 'add') { if (args.length !== 1) usage('plugin add <folder>'); const r = await addPlugin(args[0], dir); print(r); if (r.build) await scriptReport(r.name, r.build); return; }
  if (sub === 'remove') { if (args.length !== 1) usage('plugin remove <name>'); print(await removePlugin(args[0], dir)); return; }
  if (sub === 'set') { if (args.length < 2) usage('plugin set <name> <part>=on|off <option>=<value> ...'); const r = await setPlugin(args[0], args.slice(1), dir); print(r); await scriptReport(r.name, r.build); return; }
  if (sub === 'export') {
    if (args.length !== 1 || !flags.to?.length) usage('plugin export <name> --to claude|codex ... [--remove]');
    const rs = await exportPlugin(args[0], flags.to!, !!flags.remove, dir);
    if (flags.json) { print(rs); return; }
    for (const r of rs) {
      const lines = r.removed ? [`${r.harness}: ${r.name}@slcode export 를 해제했습니다`]
        : r.build ? [`${r.harness}${r.harness === 'codex' ? ' (restricted)' : ''}: ${r.name}@slcode 로 export 했습니다 (빌드 ${r.build})`] : [`${r.harness}: ${r.name} 는 export 되어 있지 않습니다`];
      if (r.build && r.harness === 'codex') lines.push('  일부 기능만 지원하며 의도대로 동작하지 않을 수 있습니다.', '  codex 를 띄울 때 나오는 훅 검토 화면에서 Trust all and continue 를 고르면 지시문과 훅이 돕니다. 플러그인을 리빌드한 뒤에도 한 번 더 묻습니다.');
      if (r.build && r.harness === 'claude') lines.push('  열린 claude 세션은 /reload-plugins 로 싣습니다. 지시문은 새 세션부터 적용됩니다.');
      if (r.excluded.length) lines.push(`  빠지거나 다르게 도는 것:`, ...r.excluded.map((x) => `    - ${x}`));
      lines.push(...r.notes.filter((n) => n !== 'not exported').map((n) => `  참고: ${n}`));
      console.log(lines.join('\n'));
    }
    return;
  }
  if (sub !== 'list') usage('plugin add|remove|set|list|export');
  const rows = listPlugins(dir);
  if (flags.json) { print(rows); return; }
  if (!rows.length) { console.log('(no agent plugins)'); return; }
  for (const r of rows) {
    const lost = Object.entries(r.lost).filter(([, l]) => l.length);
    const build = (h: 'claude' | 'codex') => {
      const rep = r.reports[h];
      return rep ? `  ${h} build ${rep.build}  instructions ${rep.instructions.used.length}${[rep.overridden.length && `overridden ${rep.overridden.join('; ')}`, rep.dropped.length && `dropped ${rep.dropped.join('; ')}`, rep.lost.length && `lost ${rep.lost.join('; ')}`].filter(Boolean).map((x) => ` · ${x}`).join('')}` : `  ${h} build -`;
    };
    console.log([
      `${r.name} ${r.version}  ${r.grade}`,
      `  parts    ${r.parts.map((x) => `${x.name}${x.required ? '(required)' : ''} ${x.on ? 'on' : 'off'}`).join(' · ') || '-'}`,
      ...(r.options.length ? [`  options  ${r.options.map((o) => `${o.name}=${JSON.stringify(o.value)}${o.label ? ` (${o.label})` : ''}`).join(' · ')}`] : []),
      ...lost.map(([h, l]) => `  lost in ${h}: ${l.join('; ')}`),
      build('claude'),
      build('codex'),
      `  export   ${r.exports.join(' · ') || '-'}`,
    ].join('\n'));
  }
}

const HELP = `slcode-plugin ${PLUGIN_VERSION} — slcode 에이전트 플러그인을 설치하고 터미널의 claude·codex 에 export 한다
  add <folder>                   slcode-plugin.json 이 있는 원본 폴더를 설치한다. 같은 내용이면 아무것도 하지 않는다
  remove <name>                  설치와 설정, export 를 지운다 (없어도 성공)
  set <name> <part>=on|off <option>=<value> ...
                                 플러그인 기본 설정을 바꾼다 (필수 part 는 끌 수 없다)
  list [--json]                  설치한 플러그인, 호환 등급(full|partial)과 빠지는 것, part·옵션 값, 마지막 빌드 보고, export
  export <name> --to claude|codex ... [--remove] [--json]
                                 터미널에서 직접 띄우는 claude·codex 에 기본 설정의 빌드를 등록한다(마켓플레이스 slcode). 바꾼 설정·새 판은 다시 export 하지 않아도 반영된다
  hook <claude|codex> <plugin folder> <event>
                                 export 한 플러그인의 js/ts 훅을 한 번 돌린다 (훅 입력 JSON 은 stdin) — 훅 명령이 부르는 것
상태 폴더: --dir D, 없으면 $SLCODE_DIR, 없으면 ~/.local/state/slcode (slcode 와 같은 폴더). --version [--json]`;

/** 단독 진입 — argv 는 node·스크립트 뒤 */
export async function main(argv: string[]): Promise<number> {
  const flags: PluginFlags & { dir?: string; help?: boolean; version?: boolean } = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') (flags.to ??= []).push(argv[++i] ?? '');
    else if (a === '--dir') flags.dir = argv[++i];
    else if (a === '--remove') flags.remove = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version') flags.version = true;
    else pos.push(a);
  }
  if (flags.version) { console.log(flags.json ? JSON.stringify({ version: PLUGIN_VERSION }) : PLUGIN_VERSION); return 0; }
  const [cmd, ...rest] = pos;
  if (!cmd || flags.help) { console.log(HELP); return 0; }
  if (cmd === 'hook') return (await import('./hookMain.js')).main(rest);
  class Usage extends Error {}
  try {
    await pluginCommand(cmd, rest, flags, flags.dir ? path.resolve(flags.dir) : defaultStateDir(), (m) => { throw new Usage(m.replace(/^plugin /, '')); });
    return 0;
  } catch (e) {
    if (e instanceof Usage) { console.error(`usage: slcode-plugin ${e.message}`); return 2; }
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
