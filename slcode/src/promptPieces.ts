// 미리 나눠 둔 블록과 설명 (ticket slcode-profile-system-prompt) — scripts/prompt-pieces.mjs 가 만든다, 손으로 고치지 않는다.
// 받은 프롬프트에서 해시가 맞는 줄들에만 씌우는 보조다: 맞지 않으면 받은 대로 한 덩어리로 보인다. 원문은 여기에도 없다.
// Claude Code 2.1.322 (sonnet·haiku·opus·fable) 기준 — 판을 올려 다시 만들면 이 줄도 고친다.
import type { PromptPiece } from './systemPrompt.js';

export const BUILTIN_PIECES: readonly PromptPiece[] = [
  { head: '8202d4b4', lines: 1, hash: '8202d4b44e0a8f12', note: "에이전트 정체성" },
  { head: '10591efd', lines: 1, hash: '10591efdcea75a16', note: "보안 요청을 받는 기준" },
  { head: '45e4bd58', lines: 1, hash: '45e4bd587061fb27', note: "답은 터미널에 markdown 으로 보인다" },
  { head: '57f66414', lines: 1, hash: '57f664143d45b1ab', note: "권한 모드와 거절된 도구 호출" },
  { head: '5e36b6aa', lines: 1, hash: '5e36b6aa90cf962c', note: "대화 중 system 알림과 hook" },
  { head: '1c6916a5', lines: 1, hash: '1c6916a5997f1ad4', note: "붙여 넣은 글(pasted_content) 다루기" },
  { head: '5fc7063c', lines: 1, hash: '5fc7063c38d40c22', note: "전용 도구 우선 · 병렬 호출" },
  { head: '9f644245', lines: 1, hash: '9f644245e7d3885f', note: "코드 위치 표기(file:line)" },
  { head: '3fcd2b20', lines: 1, hash: '3fcd2b200896a716', note: "사람을 가리키는 대명사" },
  { head: '97244153', lines: 1, hash: '9724415357935973', note: "되돌리기 어려운 작업은 먼저 확인" },
  { head: '90ca9026', lines: 1, hash: '90ca9026ba395caa', note: "사용자 정보를 밖으로 보내지 않기" },
  { head: '33edcd97', lines: 1, hash: '33edcd9775b2c118', note: "/이름 을 치면 Skill 로 호출" },
  { head: '32e367d3', lines: 20, hash: 'ea4f387fc2b6394c', note: "파일 메모리 쓰는 법" },
  { head: '8cf22ff3', lines: 1, hash: '8cf22ff3194ae12a', note: "최신 Claude 모델 목록" },
  { head: '465985bc', lines: 1, hash: '465985bc2156eec3', note: "Claude Code 제품 안내(CLI·데스크톱·IDE)" },
  { head: '0ae4fa68', lines: 1, hash: '0ae4fa6881d79392', note: "fast mode 안내" },
  { head: '1c628de2', lines: 1, hash: '1c628de2023cb1b3', note: "긴 대화는 요약된다" },
  { head: '4e4e48fb', lines: 1, hash: '4e4e48fb23ceb764', note: "정보가 충분하면 바로 실행" },
  { head: '1f235867', lines: 1, hash: '1f23586747809764', note: "effort 는 생각의 양만 바꾼다 — 큰 일도 한 턴에" },
  { head: 'fad3a692', lines: 1, hash: 'fad3a69292ade70e', note: "할 수 있는 일이 남았으면 턴을 끝내지 않는다" },
  { head: 'be0514cc', lines: 1, hash: 'be0514cc0e445a2f', note: "시작 전에 묻는 기준" },
  { head: 'cf2e774e', lines: 1, hash: 'cf2e774e1a151f22', note: "작업 폴더의 파일 수정은 스스로 정한다" },
  { head: 'b2d51138', lines: 1, hash: 'b2d51138b958d9c3', note: "막힌 부분이 있어도 나머지를 마친다" },
  { head: '97215b26', lines: 1, hash: '97215b261ddf9763', note: "게임 만들기의 저작권 기준" },
  { head: 'f0c3c92d', lines: 1, hash: 'f0c3c92d83b7699a', note: "모델 소개(Fable·Mythos)" },
  { head: '523a5ff9', lines: 1, hash: '523a5ff9573c734f', note: "일부 분야의 능력 제한 안내" },
  { head: 'aacfdd91', lines: 1, hash: 'aacfdd913cccac18', note: "맡은 일이 남았으면 멈추지 않는다" },
  { head: 'be36a0e1', lines: 1, hash: 'be36a0e1cc534418', note: "작업 폴더 안 파일은 Read 없이 Edit" },
  { head: 'e330db6a', lines: 11, hash: '7bfee020c7636377', note: "메모리·노트에 남길 것의 기준" },
  { head: '635611b0', lines: 1, hash: '635611b0c245b2bd', note: "계획·분석 문서는 요청받을 때만" },
];
