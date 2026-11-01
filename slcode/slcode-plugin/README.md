# slcode-plugin

slcode 에이전트 플러그인(`slcode-plugin.json` 형식)을 설치하고, 터미널의 claude·codex 에 export 하고, export 한 훅을 돌린다. 의존성 없는 순수 JS 이고 node 20 이상에서 돈다.

```
node dist/cli.js add <폴더> | remove <이름> | set <이름> <part>=on|off <옵션>=<값> … | list [--json]
node dist/cli.js export <이름> --to claude --to codex [--remove] [--json]
node dist/cli.js --version
```

쓰는 쪽이 `package.json` 과 `dist/` 를 넣어 간다(slcode zip, superlite-for-agents). 상태 폴더는 `--dir`, `$SLCODE_DIR`, `~/.local/state/slcode` 순이고 slcode 와 함께 쓴다. 판이 다른 사본이 같은 상태 폴더를 써도 되게 형식은 하위호환으로만 바꾼다. export 한 훅 명령은 상태 폴더의 `agent-plugins/bin/hook` 을 부르고, 이 파일은 사본이 돌 때 새 판의 node·`hookMain.js` 로 맞춰진다.

part 에 `when` 을 적으면 세션 인자(`slcode new --param NAME=VALUE`, 짧게 `-P`)가 맞는 세션에서만 그 part 가 켜진다. 값은 `true`(있고 비어 있지 않음), `"값"`(같음), `["값", …]`(그중 하나)이고, 이름을 여럿 적으면 모두 맞아야 한다. 사용자가 끈 part 는 조건과 상관없이 꺼져 있다. export 판에는 세션 인자가 없어 조건 있는 part 가 빠진다. 훅은 값을 `hook.session.params.NAME`(js/ts)이나 env `SLCODE_PARAM_NAME`(command)으로 읽는다. 이 칸을 모르는 0.1.0 사본은 조건 없이 part 를 켠다.

```json
"parts": { "main": { "required": true }, "orchestration": { "when": { "param": { "ORCH_ROLE": true } } } }
```

esbuild(js/ts 훅을 묶을 때)와 typescript(훅 타입 검사)는 처음 필요할 때 npm 레지스트리에서 받는다. 판과 무결성은 고정이다. 받지 못하면 js/ts 훅만 빠지고 경고가 남으며, 다음 add·set 때 다시 받아 본다.

소스는 `src/`, 빌드는 slcode 폴더에서 `pnpm build`. `dist/` 는 커밋한다.
