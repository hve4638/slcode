# slcode-plugin

slcode 에이전트 플러그인(`slcode-plugin.json` 형식)을 설치하고, 터미널의 claude·codex 에 export 하고, export 한 훅을 돌린다. 의존성 없는 순수 JS 이고 node 20 이상에서 돈다.

```
node dist/cli.js add <폴더> | remove <이름> | set <이름> <part>=on|off <옵션>=<값> … | list [--json]
node dist/cli.js export <이름> --to claude --to codex [--remove] [--json]
node dist/cli.js --version
```

쓰는 쪽이 `package.json` 과 `dist/` 를 넣어 간다(slcode zip, superlite-for-agents). 상태 폴더는 `--dir`, `$SLCODE_DIR`, `~/.local/state/slcode` 순이고 slcode 와 함께 쓴다. 판이 다른 사본이 같은 상태 폴더를 써도 되게 형식은 하위호환으로만 바꾼다. export 한 훅 명령은 상태 폴더의 `agent-plugins/bin/hook` 을 부르고, 이 파일은 사본이 돌 때 새 판의 node·`hookMain.js` 로 맞춰진다.

esbuild(js/ts 훅을 묶을 때)와 typescript(훅 타입 검사)는 처음 필요할 때 npm 레지스트리에서 받는다. 판과 무결성은 고정이다. 받지 못하면 js/ts 훅만 빠지고 경고가 남으며, 다음 add·set 때 다시 받아 본다.

소스는 `src/`, 빌드는 slcode 폴더에서 `pnpm build`. `dist/` 는 커밋한다.
