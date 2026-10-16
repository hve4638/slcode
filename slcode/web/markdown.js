// 최소 마크다운 → HTML. 스트리밍 중 매 델타마다 전체를 다시 그리므로 가볍게 둔다.
// 지원: 제목, 코드 펜스, 인라인 코드, 굵게·기울임, 목록(-, *, 1.), 인용, 링크, 이미지, 표, 단락. 중첩 목록은 원문 그대로.
// 링크·이미지는 웹 주소와 로컬 파일 절대 경로 — 에이전트에게 알리는 문구는 src/prompt.ts (ticket slcode-append-system-prompt). 형식을 바꾸면 같이 바꾼다.

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const unesc = (s) => s.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[e]));

// 로컬 파일은 serve 의 file 경로로 — 상대 주소라 superlite /svc/<토큰>/ 아래에서도 돈다. 루프백 밖 웹이면 토큰을 붙인다 (index.html 이 넣는다)
let fileToken = '';
export function setFileToken(t) { fileToken = t; }
const URL_RE = String.raw`(https?:\/\/[^)\s]+|\/[^)\s]*|[A-Za-z]:[\\/][^)\s]*)`;
/** 이스케이프된 주소 → { href, open } (둘 다 이스케이프된). href 는 브라우저가 여는 주소, open 은 superlite 카드가 open 동사에 넘길 대상
 *  (app.js 가 data-open 으로 가로챈다 — 웹 주소는 URL 탭, 파일은 에디터). 로컬 경로의 #L12 는 떼고, %20 같은 인코딩은 풀어 서버에 넘긴다 */
function target(raw) {
  const u = unesc(raw);
  if (/^https?:/.test(u)) return { href: raw, open: raw };
  let p = u.replace(/#.*$/, '');
  try { p = decodeURI(p); } catch {}
  // open 동사는 줄 번호를 받지 않는다 — Codex 꼴 a.ts:12 는 떼고 연다 (serve 의 file 은 스스로 뗀다)
  return { href: esc(`file?path=${encodeURIComponent(p)}${fileToken ? `&token=${encodeURIComponent(fileToken)}` : ''}`), open: esc(p.replace(/:\d+(:\d+)?$/, '')) };
}
const IMG = new RegExp(String.raw`!\[([^\]]*)\]\(${URL_RE}\)`, 'g');
const LINK = new RegExp(String.raw`\[([^\]]+)\]\(${URL_RE}\)`, 'g');

function inline(s) {
  let out = '';
  const parts = s.split(/(`[^`]*`)/);
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) { out += `<code>${esc(part.slice(1, -1))}</code>`; continue; }
    out += esc(part)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(IMG, (_, alt, u) => { const t = target(u); return `<a class="img" href="${t.href}" data-open="${t.open}" target="_blank" rel="noopener"><img src="${t.href}" alt="${alt}"></a>`; })
      .replace(LINK, (_, s, u) => { const t = target(u); return `<a href="${t.href}" data-open="${t.open}" target="_blank" rel="noopener">${s}</a>`; });
  }
  return out;
}

// 표 — `|` 로 시작하는 줄 바로 아래가 구분 줄(|---|:--:|)일 때만. ponytail: 셀 안의 `|` 는 \\| 로만 (인라인 코드 안의 | 도 칸을 나눈다)
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isTable = (lines, i) => lines[i].trimStart().startsWith('|') && i + 1 < lines.length && lines[i + 1].includes('-') && SEP.test(lines[i + 1]);

export function renderMarkdown(src) {
  const lines = src.split('\n');
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      html.push(`<pre><code${fence[1] ? ` class="lang-${esc(fence[1])}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { html.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (isTable(lines, i)) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      const cell = (tag) => (c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c)}</${tag}>`;
      const rows = []; i += 2;
      while (i < lines.length && lines[i].trimStart().startsWith('|')) rows.push(cells(lines[i++]));
      html.push(`<table><thead><tr>${head.map(cell('th')).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell('td')(r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (line.startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      html.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|>)/.test(lines[i]) && !(buf.length && isTable(lines, i))) buf.push(lines[i++]);
    html.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return html.join('');
}
