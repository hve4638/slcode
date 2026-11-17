// .github/workflows/release.yml 의 step 하나의 run 셸 본문을 꺼낸다 (ticket slcode-release-check-script).
// release-check.mjs 의 판 대조와 test/releaseChannel.test.ts 의 publish 흉내가 Actions 와 같은 셸을 돌리려고 쓴다.
// YAML 해석기 없이 `- name: <이름>` 다음의 `run: |` 블록을 들여쓰기로 자른다. 찾지 못하면 throw.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const releaseYml = fileURLToPath(new URL('../../.github/workflows/release.yml', import.meta.url));

export function stepRun(name) {
  const lines = readFileSync(releaseYml, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (i < 0) throw new Error(`release.yml 에 step "${name}" 이 없다`);
  const key = lines[i].indexOf('-') + 2; // step 의 키(name·run…)가 놓이는 들여쓰기
  let j = i + 1;
  while (j < lines.length && !(lines[j].search(/\S/) === key && lines[j].slice(key).startsWith('run: |'))) {
    if (lines[j].trim() && lines[j].search(/\S/) < key) throw new Error(`step "${name}" 에 run: | 가 없다`);
    j++;
  }
  const body = [];
  for (j++; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() && l.search(/\S/) <= key) break;
    body.push(l.slice(key + 2));
  }
  return body.join('\n').trimEnd() + '\n';
}
