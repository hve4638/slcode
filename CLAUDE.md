# slcode

superlite 용 에이전트 하네스 slcode 와 그 superlite 플러그인(id `slcode`)을 함께 둔 repo 다. 루트의 `plugin.json`·`main.js` 가 플러그인 소스이고, 이 폴더가 그대로 superlite 의 "GitHub 에서 설치" 대상이다. 본체 소스는 `slcode/` 에 있다.

이 repo 는 wtree 로 브랜치를 관리한다 (main ← feat/*·fix/*·refactor/*·docs/*·chore/*, squash 합류). 브랜치 생성·merge·제거는 wtree 로만 하고 `git merge`/`git switch`/`git branch -d`/`git worktree` 를 직접 쓰지 않는다. 사용법은 `wtree llms.txt`.

- 플러그인 id 는 `slcode` 다 (2026-10-04 `agent` 에서 바뀜). 설정·storage·팔레트·사이드바 id 가 이 값을 따른다.
- 플러그인이 쓰는 API(`api.services`, `ServiceStartOptions`, `webUrl` 등)와 와이어는 superlite repo(code-superlight)의 `plugin-api/` 가 정한다. 이 repo 는 그 소비자다.
- 배포 구조(플러그인 소스 설치 + Releases 바이너리 자가 설치)의 결정 문서는 ws repo 의 `docs/report/slcode-distribution.html` 이다. ticket·보고서도 ws repo(code-superlight-ws)에 둔다.
- 빌드·테스트: `cd slcode && pnpm install && pnpm build && pnpm test`. 바이너리 zip 은 `slcode/scripts/release.sh` (자산 이름·zip 구조는 slcode/README.md "바이너리 배포", 플러그인 자가 설치가 그 규칙을 읽는다). `~/.local/bin/slcode` 는 이 체크아웃의 `slcode/dist/cli.js` 를 가리킨다 (재빌드 뒤 `chmod +x`).
- intentir 를 쓴다. 의도가 바뀌는 변경은 `.itir/` 를 먼저 고치고, 커밋 전에 `itir check` 를 통과시킨다 (error 0). `main.js`·`slcode/web/` 은 JS 라 검사 밖이다.
- 릴리스 버전 올림은 `plugin.json` 의 version·binary.version(`^<새 버전>`)과 `slcode/package.json` 의 version 을 바꾼다. 확인 범위는 아래로 좁힌다 (사용자 2026-10-16, 0.1.8 확인이 오래 걸려서).
  - CI 테스트 단계는 release.yml 을 읽어 판단한다. CI 를 흉내 낸 환경을 만들어 다시 돌리지 않는다.
  - superlite 카드 확인은 이미 빌드된 superlite 백엔드나 떠 있는 데모 서버가 있을 때만 한다. 없으면 빌드하지 않고 못 했다고 보고한다.
  - 업그레이드 호환 실측(옛 release zip 으로 띄운 세션에 새 바이너리로 다시 붙기·resume·close, 옛 serve 에 붙은 새 웹)은 한다. lockfile 이 같으면 새 바이너리는 옛 zip 의 node_modules 에 새 dist·web·package.json 을 얹은 폴더로 대신한다.
