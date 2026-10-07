# slcode

에이전트 세션 하나를 쥐는 프로세스. `slcode` 를 치면 그 프로세스가 곧 세션이고, 세션 소켓과 웹 서버를 같이 연다. 세션 사이의 우편은 우체국 프로세스(머신에 하나, 없으면 뜨고 비면 내려간다)가 나른다. 벤더는 Claude(Agent SDK)와 Codex(사용자 PATH 의 `codex app-server`) 둘이고, 새 세션은 기본 Claude, `new --vendor codex` 면 Codex 다.

```
pnpm install && pnpm build
slcode [--vendor --title --mode …]      # 동사 없으면 slcode new . (옵션만, 폴더는 new <folder>). superlite 터미널 안이면 그 deck 에 카드로 연다 (--web 은 웹 강제)
cd /path/to/project && slcode new       # 이 프로세스가 이 폴더의 세션 하나 + 웹 서버 하나, URL 이 찍힌다. Ctrl-C 로 닫는다
slcode resume <s> | continue [folder]   # 닫은 세션을 이어간다 (살아 있으면 attach). continue 는 그 폴더의 최근 세션
slcode import <벤더 세션 id> [--fork]    # Claude Code·Codex 에서 하던 세션을 이어받는다 (폴더는 벤더 기록에서, 이전 대화는 화면에 없다). --fork 는 원본을 두고 복제본으로
slcode export <s>                       # 그 세션을 벤더에서 이어 갈 명령을 찍는다 (cd <폴더> && claude --resume <id> | codex resume <id>)
slcode new --host 0.0.0.0 --port 8798   # 밖으로 열면 URL 에 토큰이 붙는다 (기본 127.0.0.1·남는 포트·토큰 없음). --no-web 은 소켓만
slcode list [--all] | attach <s> | rename <s> <title> | close <s> | delete <s>
slcode prompt <s> <text> | interrupt <s>
slcode status <s> | pending <s> | last <s> [--turn N] | log <s> [--since N] [--tail N]   # 조회: 평문 기본, --json
slcode respond <s> <req> allow|deny [--remember] | respond <s> <req> --answer <text> | respond <s> <req> --json '<updatedInput>'
slcode mail <to> <text> [--from X] | inbox [<s>]                            # 우편 (세션 밖에서는 --from·<s> 필수)
slcode check | ask <to> <text> [--timeout S] | reply <우편 id> <text>        # 세션 안에서(SLCODE_SESSION)
slcode post status | post restart
pnpm test                               # 잠금·로그·우체국·세션 프로세스·CLI 동사 테스트
```

`<s>`·`<to>` 는 세션 id 또는 유일한 제목이다. 동사는 attach 만 빼고 한 번 부르고 끝난다 — 다른 에이전트·스크립트·superlite 카드가 세션을 조종하는 표면이다. 승인·질문은 `pending` 으로 요청 id 를 보고 `respond` 로 답한다. 열려 있지 않은 id 면 오류와 함께 지금 대기 중인 id 를 보여 준다 (미리 보관하지 않는다). `status`·`last`·`log` 는 꺼진 세션도 로그 파일에서 답한다.


세션마다 프로세스가 따로라 패키지를 갱신해도 떠 있는 세션은 옛 코드로 그대로 돌고, 새로 띄운 세션만 새 코드다. 프로세스를 내리면 세션의 벤더 프로세스도 닫히고 로그는 남는다. slcode 는 tmux 를 모른다 — 터미널을 닫아도 살려 두고 싶으면 바깥에서 tmux 에 띄운다 (superlite 카드가 그렇게 한다).

- 계약은 `src/protocol.ts` 하나. 프레임은 superlite 와이어 꼴 JSON 한 줄, 이벤트 15종 벤더 중립, `raw` 에 벤더 원문(옵션). 세션 소켓과 웹이 같은 메서드를 낸다. 우체국 계약은 `post.*`·`mail.*` 과 시그널 `mail` 뿐이고 버전이 달라도 깨지지 않게 늘리기만 한다.
- 파일은 `$SLCODE_DIR`(기본 `~/.local/state/slcode`): `sessions/<cwd 슬러그>/<id>/{meta.json,events.jsonl,sock}`(소켓 경로가 유닉스 상한을 넘는 긴 폴더는 `sock/<id>`), `post.sock`·`post.lock`·`post.pid`·`post.log`, `mail/<세션 id>/`, `slcode.token`. 옛 평탄 구조 `sessions/<id>/` 는 처음 뜰 때 옮긴다.
- 인증: UDS 는 소켓 권한(0600)이 전부. 웹은 루프백 바인드면 없음, 루프백 밖이면 `slcode.token`(URL 의 `?token=`, WS 첫 프레임 `core.auth`).
- 우편: 보내는 쪽은 우체국에 `mail.send`, 우체국은 디스크에 쓰고 받는 세션이 살아 있으면 시그널만 보낸다. 세션은 `mail.fetch` 로 가져와 다음 idle 에 한 턴(origin `mail`, 여러 통은 한 본문)으로 넣고 `mail.ack` 한다. 꺼진 세션 앞의 우편은 다음에 뜰 때 받는다. 폴링은 없다.
- 메시징(세션 사이): 벤더 자식 프로세스에 `SLCODE_SESSION=<세션 id>` 가 들어가 세션 안의 에이전트가 `slcode mail/check/ask/reply` 로 자기 이름을 안다. 우편 머리말은 `[mail <id> from <세션 id> (<제목>) at <iso> kind=<kind>]` 뒤에 `답장: slcode reply <id> <본문>` 한 줄. `ask` 는 kind=ask 로 보내고 kind=reply(re=<그 id>)가 올 때까지 기다린다(기본 무기한, `--timeout`) — 답장은 턴이 아니라 ask 의 출력으로 온다. `check` 는 진행 중 턴 안에서 밀린 우편을 지금 꺼낸다(꺼낸 것은 턴으로 다시 오지 않는다). superlite 등록부와의 연결은 없다(스탠드얼론, 사용자 2026-10-02).
- 비용: Codex 는 턴 비용을 알려 주지 않는다 (`turn.end.costUsd` 가 null). 그래서 Codex 세션은 `status` 와 웹 사이드바의 비용이 `$0` 으로 보이지만, 실제 비용이 0 이라는 뜻은 아니다.
- 우체국 수명: 등록 0·연결 0 이 `SLCODE_GRACE_SECS`(기본 10) 지속되면 종료. SIGHUP 무시.
- 웹 프런트 `web/` 는 빌드 없는 ES 모듈. 페이지는 서버에 `server.info` 로 세션 id 를 물어 그 세션에 붙는다. 세션 목록 화면은 없다. 이미지·PDF·텍스트 파일은 붙여넣기·끌어놓기·`+` 로 첨부한다 (`session.send.attachments`, 로그엔 이름만). 모델과 effort 는 작성창의 드롭다운으로 바꾼다 (`session.setModel`·`session.setEffort`, 다음 턴부터, `--resume` 뒤에도 유지). 말풍선에 마우스를 올리면 복사·돌아가기 버튼이 나온다. 돌아가기는 claude 의 Esc-Esc 로, 답변만·코드만·둘 다 중 고른다 (`session.rewind`).
- 설계 근거·결정은 ws `docs/report/agent-core-spike.md`, `docs/report/agent-core-standalone.md`, `docs/report/agent-core-split.md`.

## 바이너리 배포

플러그인(repo 루트의 `plugin.json`·`main.js`)이 처음 켜질 때 받는 zip 이다. GitHub release `v<버전>` 에 `slcode-<버전>-linux-x64.zip`, `slcode-<버전>-win-x64.zip` 두 자산을 올린다. 플러그인은 이 이름 규칙과 zip 안의 `bin/` 진입만 안다.

```
scripts/release.sh            # release/ 에 두 zip (Linux 한 머신에서 두 플랫폼)
scripts/release.sh win-x64    # 한 플랫폼만
scripts/release.sh --upload   # gh release create v<버전> (없으면, 태그는 HEAD) + gh release upload --clobber
```

gh 로그인이 없는 머신(지금의 개발 머신)에서는 웹으로 올린다. Releases 의 "Draft a new release" 에서 태그 `v<버전>`(target main)을 만들고, 두 zip 을 이름 그대로 첨부해 Publish 한다. draft·pre-release 로 두거나 태그의 `v` 를 빼면 플러그인이 찾지 못한다. 올린 뒤 `curl -s https://api.github.com/repos/hve4638/slcode/releases` 로 태그와 자산 이름을 대조한다.

플러그인은 받은 zip 을 플러그인 폴더의 `bin/<platform>/` 에 풀고, 그 안의 `manifest.json` 으로 설치 여부를 판단한다 (plugin.json `binary.version` 조건과 platform 대조). 원격 세션에서는 superlite 가 그 폴더를 원격에 올린 사본의 `bin/slcode` 를 쓴다.

zip 최상위에는 `manifest.json {version, platform, node}`, `bin/slcode`(sh)·`bin/slcode.cmd`, `runtime/node`(또는 `node.exe`), `dist/`·`web/`·`node_modules/`·`package.json` 이 있다. `bin/` 의 두 런처가 동봉 node 로 `dist/cli.js` 를 띄우므로 사용자 머신에 Node 가 없어도 된다. 의존성은 lockfile 그대로 대상 플랫폼 패키지만 받는다 (pnpm `supportedArchitectures`, hoisted). Node 는 `NODE_VERSION`(기본 현재 LTS)의 공식 배포에서 실행 파일과 LICENSE 만 꺼내고, 받은 파일은 SHASUMS256.txt 로 대조한다. Codex 는 넣지 않는다. Codex 세션은 사용자 PATH 의 `codex` 를 쓴다.

라이선스 조건 (Anthropic 의 Claude Code 법률 안내가 허용하는 동봉 배포):

- Claude Agent SDK 와 그 플랫폼 바이너리는 수정하지 않고 동봉한다. 내장 인증 수단을 빼거나 막지 않는다.
- 사용자가 자기 인증을 쓴다. 사용자 머신의 claude 로그인 상태 또는 자기 API 키다. 대신 결제하거나 중개하지 않는다.
- slcode 는 로그인 화면을 만들지 않고 Claude 토큰을 저장하지 않는다.
- 제품 이름과 로고에 Claude·Anthropic 의 이름이나 로고를 쓰지 않는다.
