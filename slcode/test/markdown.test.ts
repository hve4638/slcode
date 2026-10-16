// 웹 마크다운 렌더러(web/markdown.js) — 답변 속 링크·이미지 (ticket slcode-append-system-prompt). 화면 없이 HTML 문자열만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore — 빌드 없는 웹 ES 모듈 (tsc 검사 밖)
import { renderMarkdown, setFileToken } from '../web/markdown.js';

test('markdown: 이미지·링크 — 웹 주소는 그대로, 로컬 절대 경로는 file?path= 로 (토큰이 있으면 붙인다); data-open 은 superlite 카드가 open 동사에 넘길 대상', () => {
  setFileToken('');
  assert.equal(renderMarkdown('![shot](https://e.com/a.png?x=1&y=2)'),
    '<p><a class="img" href="https://e.com/a.png?x=1&amp;y=2" data-open="https://e.com/a.png?x=1&amp;y=2" target="_blank" rel="noopener"><img src="https://e.com/a.png?x=1&amp;y=2" alt="shot"></a></p>');
  assert.equal(renderMarkdown('see [doc](https://e.com/d)'), '<p>see <a href="https://e.com/d" data-open="https://e.com/d" target="_blank" rel="noopener">doc</a></p>');
  assert.equal(renderMarkdown('![](/tmp/my%20shot.png)'),
    '<p><a class="img" href="file?path=%2Ftmp%2Fmy%20shot.png" data-open="/tmp/my shot.png" target="_blank" rel="noopener"><img src="file?path=%2Ftmp%2Fmy%20shot.png" alt=""></a></p>');
  assert.equal(renderMarkdown('[a.ts](/w/a.ts#L12)'), '<p><a href="file?path=%2Fw%2Fa.ts" data-open="/w/a.ts" target="_blank" rel="noopener">a.ts</a></p>', '#L12 는 뗀다');
  assert.match(renderMarkdown('[a.ts:12](/w/a.ts:12)'), /href="file\?path=%2Fw%2Fa\.ts%3A12" data-open="\/w\/a\.ts"/, 'open 대상은 줄 번호를 뗀다');
  setFileToken('t&1');
  assert.match(renderMarkdown('[x](/w/x.txt)'), /href="file\?path=%2Fw%2Fx\.txt&amp;token=t%261"/);
  setFileToken('');
  assert.equal(renderMarkdown('[x](relative/x.txt) `![a](/b.png)`'), '<p>[x](relative/x.txt) <code>![a](/b.png)</code></p>', '상대 경로·인라인 코드는 원문');
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '<p>[x](javascript:alert(1))</p>');
  assert.equal(renderMarkdown('![a" onerror="x](/b.png)'),
    '<p><a class="img" href="file?path=%2Fb.png" data-open="/b.png" target="_blank" rel="noopener"><img src="file?path=%2Fb.png" alt="a&quot; onerror=&quot;x"></a></p>', '따옴표는 속성을 깨지 못한다');
});
