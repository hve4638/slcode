// pnpm test 끝에 전체 시간과 느린 파일 상위 5개를 출력하는 node:test 리포터 (ticket slcode-test-prune).
// 테스트 시간이 판마다 늘던 것을 숫자로 보이려는 것이라 실패시키지 않는다. 파일 시간은 프로세스가 끝날 때까지라 남은 타이머로 늦게 끝나는 파일도 드러난다.
export default async function* testTimes(source) {
  const files = [];
  let total = null;
  for await (const e of source) {
    const d = e.data;
    if (e.type === 'test:complete' && d.nesting === 0 && d.file?.endsWith(d.name)) files.push([d.name, d.details.duration_ms]);
    if (e.type === 'test:diagnostic' && /^duration_ms /.test(d.message)) total = Number(d.message.split(' ')[1]);
  }
  if (total === null) return;
  const s = (ms) => `${(ms / 1000).toFixed(1)}s`.padStart(7);
  yield `\ntest time ${s(total).trim()}, slowest files:\n`;
  for (const [name, ms] of files.sort((a, b) => b[1] - a[1]).slice(0, 5)) yield `${s(ms)}  ${name}\n`;
}
