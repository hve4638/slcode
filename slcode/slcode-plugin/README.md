# slcode-plugin

slcode 에이전트 플러그인(`slcode-plugin.json` 형식)을 설치하고, 터미널의 claude·codex 에 export 하고, export 한 훅을 돌린다. 의존성 없는 순수 JS 이고 node 20 이상에서 돈다.

```
node dist/cli.js add <폴더> | remove <이름> [--cascade] | set <이름> <part>=on|off <옵션>=<값> … | list [--json]
node dist/cli.js export <이름> --to claude --to codex [--remove] [--json]
node dist/cli.js --version
```

쓰는 쪽이 `package.json` 과 `dist/` 를 넣어 간다(slcode zip, superlite-for-agents). 상태 폴더는 `--dir`, `$SLCODE_DIR`, `~/.local/state/slcode` 순이고 slcode 와 함께 쓴다. 판이 다른 사본이 같은 상태 폴더를 써도 되게 형식은 하위호환으로만 바꾼다. export 한 훅 명령은 상태 폴더의 `agent-plugins/bin/hook` 을 부르고, 이 파일은 사본이 돌 때 새 판의 node·`hookMain.js` 로 맞춰진다.

part 에 `when` 을 적으면 조건이 맞는 세션에서만 그 part 가 켜진다. `part`·`param`·`env` 중 하나 이상을 적고, 적은 칸과 이름이 모두 맞아야 한다.

- `part`: 같은 플러그인의 part 가 켜졌는가. 값은 `true` 만 받는다. 대상 part 의 사용자 on/off 와 그 part 의 `when` 까지 반영한 최종 상태를 보므로 조건을 사슬로 이어도 된다. 없는 part 이름, 자기 참조, 순환은 add 가 거부한다.
- `param`: 세션 인자(`slcode new --param NAME=VALUE`, 짧게 `-P`). 값은 `true`(있고 비어 있지 않음), `"값"`(같음), `["값", …]`(그중 하나)이다.
- `env`: 세션 에이전트가 받는 env. 값의 꼴은 `param` 과 같다. 셸에서 물려받은 값과 `slcode new --env` 값을 보고, 플러그인 manifest `env` 는 보지 않는다. 셸 값은 저장되지 않아 resume 때 셸이 달라지면 켜지는 part 가 달라질 수 있다. 값이 섞이면 안 되는 조건에는 `param` 을 쓴다.

사용자가 끈 part 는 조건과 상관없이 꺼져 있고, 필수 part 도 조건이 거짓이면 꺼진다. export 판은 세션이 없어 `param`·`env` 조건이 있는 part 가 빠지고, `part` 조건만 있는 part 는 대상이 켜져 있으면 남는다. 훅은 세션 인자를 `hook.session.params.NAME`(js/ts)이나 env `SLCODE_PARAM_NAME`(command)으로 읽는다. 0.1.0 사본은 `when` 을 무시하고 part 를 켠다. 0.2.0·0.3.0 사본은 `part`·`env` 칸을 모르므로 이 꼴을 쓴 플러그인을 거부한다.

```json
"parts": { "main": { "required": true }, "orchestration": { "when": { "part": { "main": true }, "param": { "ORCH_ROLE": true }, "env": { "SOME_FLAG": "1" } } } }
```

part 의 `commands/<이름>/COMMAND.ts`(또는 `.js`) 하나가 명령 하나다. slcode 의 Claude 세션에서 사용자가 입력창에 `/<이름> <인자>` 를 치면 턴 없이 `run` 이 돈다. 모델이 답하는 중이면 그 답이 끝난 뒤에 돈다. 다른 플러그인의 명령·skill 과 짧은 이름이 겹치면 `/<플러그인>:<이름>` 으로 부른다. `cmd.state` 는 훅과 같은 상태이고 run 이 성공했을 때만 저장된다. `cmd.context()` 로 낸 글은 보관했다가 다음 턴에 UserPromptSubmit 훅 컨텍스트로 한 번 붙는다. 같은 명령을 다시 치면 앞의 보관분을 바꾼다. `complete` 는 칠 때마다 커서가 있는 낱말(`c.index` 번째, 앞부분 `c.value`)의 후보를 낸다. 따로 도는 worker 에서 저장된 상태의 읽기 전용 사본을 보므로 가볍게 쓴다. 이름은 소문자·숫자·`-` 이고, 같은 플러그인의 skill 이나 다른 part 의 명령과 이름이 같거나 `slcode.command()` 를 정확히 한 번 부르지 않으면 add 가 거부한다. Claude 내장 명령(`clear`·`compact`·`model` 등과 그 별칭)과 같은 이름도 add 가 거부한다. 목록에 없던 내장 명령과 겹치면 세션을 열 때 그 명령만 끄고 알린다. Codex 세션과 export 판에는 실리지 않는다.

```ts
import { slcode } from 'slcode/api';
slcode.command({
  description: '이 세션의 역할을 정한다', argumentHint: '<역할>',
  complete: (c) => c.index > 0 ? [] : (c.state.roles ?? []).filter((r: string) => r.startsWith(c.value)),
  run: (cmd) => { cmd.state.role = cmd.args; cmd.context(`당신의 역할은 ${cmd.args} 입니다`); cmd.message(`역할: ${cmd.args}`, { icon: 'flag' }); },
});
```

skill 의 `SKILL.md` 머리에 `aliases: [b]` 를 적으면 빌드 결과에 `skills/b/` 가 원본 폴더의 사본으로 생겨 slcode 의 Claude 세션과 export 한 Claude 에서 `/b` 로 부를 수 있다. 원본을 고치고 다시 add 하면 별칭에도 반영되고, 원본의 part 를 끄면 별칭도 빠진다. 별칭은 항상 모델에게서 숨기고, 설명 앞에 `[원본]` 을 붙인다. 이름은 소문자·숫자·`-` 이고, skill 자신이나 같은 플러그인의 skill·명령·다른 별칭, Claude 내장 명령과 같으면 add 가 거부한다. Codex 는 skill 을 `$b` 로 부른다. slcode 의 Codex 세션에서 `/b` 는 동작하지 않는다. 0.6.0 이전 사본은 `aliases` 를 모른다. add 는 받지만 별칭을 만들지 않아 원본만 실리고, 목록에 `skills/<이름>: aliases` 가 잃는 것으로 보인다. 옛 사본이 `add`(내용이 바뀐 경우)·`set` 하면 export 링크가 별칭 없는 빌드로 바뀌고, 0.6.0 이상의 `set` 이나 내용이 바뀐 `add` 때 돌아온다. 내용이 같은 `add` 는 아무것도 하지 않는다.

명령의 별칭은 형식이 따로 없다. `commands/rl/COMMAND.ts` 에 `import '../roleas/COMMAND.ts';` 한 줄만 쓰면 `/rl` 이 같은 명령으로 돌고 상태도 같다. 메뉴 설명은 원본과 같고, 보관 컨텍스트는 이름별이라 `/roleas A` 뒤의 `/rl B` 는 앞의 것을 바꾸지 않고 둘 다 다음 턴에 붙는다.

원본 폴더에 `slcode-plugin.json` 대신 `slcode-addon.json` 을 두면 애드온이다. 애드온은 베이스 플러그인에 합쳐 빌드되어, 스킬·명령·MCP 이름이 베이스 이름 아래에 들어간다(`/superlite:…`). 나머지 칸과 part 폴더의 꼴은 플러그인과 같다.

```json
{ "name": "orchestration", "version": "0.5.0", "addon": { "base": "superlite", "version": "^0.4.0" },
  "parts": { "orch": { "when": { "part": { "main": true }, "param": { "ORCH_ROLE": true } } } } }
```

- `addon.base` 는 플러그인이나 다른 애드온의 이름이다. 애드온의 애드온도 맨 아래 베이스 이름으로 들어간다.
- `addon.version` 은 베이스 판의 조건이다. `1.2.3`, `^1.2.3`, `~1.2.3`, `>=`·`>`·`<=`·`<`, `*` 를 쓰고, 공백으로 이으면 모두 맞아야 한다.
- 베이스가 없거나 판 조건이 맞지 않거나, part·옵션·skill·명령 이름이 베이스나 다른 애드온과 겹치면 add 가 거부한다. 다른 파일 경로와 MCP 서버 이름이 겹치면 part 끼리처럼 뒤의 것이 이기고 빌드 보고의 `overridden` 에 남는다.
- `when.part` 는 자기 part 와 베이스 쪽 사슬의 part 를 본다. 베이스에서 애드온 쪽, 형제 애드온 쪽은 볼 수 없다.
- 애드온은 켜고 끄는 단위가 아니다. 베이스를 실으면 함께 실리고, part 와 옵션은 `plugin set <베이스> <part>=off` 와 프로필의 `<베이스>.<part>` 로 바꾼다.
- 베이스를 갱신해 판 조건이 맞지 않거나 이름이 겹치게 되면 베이스는 갱신하고 그 애드온과 거기 의존하는 애드온만 빠진다. 사유는 `plugin list` 와 세션 알림에 보이고, 맞는 판이 되면 돌아온다.
- `remove <애드온>` 은 애드온만 지우고 베이스를 다시 빌드한다. 의존하는 애드온이 있으면 거부하고 `--cascade` 로 함께 지운다. 베이스도 같다. 제거하면 기본 설정과 프로필에 있던 그 애드온의 값이 함께 지워진다. 세션 meta 의 값은 남지만 쓰이지 않는다.
- 빌드 결과의 이름과 판은 베이스의 것이다. 애드온의 판은 `plugin list` 의 `addons` 줄에 보인다.

0.5.0 이전 사본은 `slcode-addon.json` 폴더의 add 를 거부하고, 상태 폴더의 애드온을 보지 못해 베이스만 싣는다. 옛 사본이 베이스를 지우면 애드온은 고아로 남아 목록에만 보이고, 베이스를 다시 add 하면 돌아온다. 옛 사본이 베이스를 `add`(내용이 바뀐 경우)·`set` 하면 export 링크가 베이스만의 빌드로 바뀌고, 0.5.0 이상의 `add`·`set` 때 다시 합쳐진다.

esbuild(js/ts 훅을 묶을 때)와 typescript(훅 타입 검사)는 처음 필요할 때 npm 레지스트리에서 받는다. 판과 무결성은 고정이다. 받지 못하면 js/ts 훅만 빠지고 경고가 남으며, 다음 add·set 때 다시 받아 본다.

소스는 `src/`, 빌드는 slcode 폴더에서 `pnpm build`. `dist/` 는 커밋한다.
