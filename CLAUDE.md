# slcode

superlite 용 에이전트 하네스 slcode 와 그 superlite 플러그인(id `slcode`)을 함께 둔 repo 다. 루트의 `plugin.json`·`main.js` 가 플러그인 소스이고, 이 폴더가 그대로 superlite 의 "GitHub 에서 설치" 대상이다. 본체 소스는 `slcode/` 에 있다.

이 repo 는 wtree 로 브랜치를 관리한다 (main ← feat/*·fix/*·refactor/*·docs/*·chore/*, squash 합류). 브랜치 생성·merge·제거는 wtree 로만 하고 `git merge`/`git switch`/`git branch -d`/`git worktree` 를 직접 쓰지 않는다. 사용법은 `wtree llms.txt`.

- 플러그인 id 는 `slcode` 다 (2026-10-04 `agent` 에서 바뀜). 설정·storage·팔레트·사이드바 id 가 이 값을 따른다.
- 플러그인이 쓰는 API(`api.services`, `ServiceStartOptions`, `webUrl` 등)와 와이어는 superlite repo(code-superlight)의 `plugin-api/` 가 정한다. 이 repo 는 그 소비자다.
- 배포 구조(플러그인 소스 설치 + Releases 바이너리 자가 설치)의 결정 문서는 ws repo 의 `docs/report/slcode-distribution.html` 이다. ticket·보고서도 ws repo(code-superlight-ws)에 둔다.
- 빌드·테스트: `cd slcode && pnpm install && pnpm build && pnpm test`. `~/.local/bin/slcode` 는 이 체크아웃의 `slcode/dist/cli.js` 를 가리킨다 (재빌드 뒤 `chmod +x`).
- intentir 를 쓴다. 의도가 바뀌는 변경은 `.itir/` 를 먼저 고치고, 커밋 전에 `itir check` 를 통과시킨다 (error 0). `main.js`·`slcode/web/` 은 JS 라 검사 밖이다.
