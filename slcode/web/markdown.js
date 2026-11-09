// 최소 마크다운 → HTML. 스트리밍 중 매 델타마다 전체를 다시 그리므로 가볍게 둔다.
// 지원: 제목, 코드 펜스, 인라인 코드, 굵게·기울임, 목록(-, *, 1. 중첩·항목 안 블록 포함), 인용, 링크, 이미지, 표, 단락.
// 링크·이미지는 웹 주소와 로컬 파일 절대 경로 — 에이전트에게 알리는 문구는 src/prompt.ts (ticket slcode-append-system-prompt). 형식을 바꾸면 같이 바꾼다.
// 상대 경로(./ ../ 맨 이름)와 <…> 로 감싼 주소도 받는다 — 고정 지시 없는 세션이 쓴다. 상대 경로는 세션 cwd 기준 절대 경로로 풀고, cwd 를 모르면 원문 (ticket slcode-markdown-relative-links).

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const unesc = (s) => s.replace(/&(amp|lt|gt|quot);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"' }[e]));

// 로컬 파일은 serve 의 file 경로로 — 상대 주소라 superlite /svc/<토큰>/ 아래에서도 돈다. 루프백 밖 웹이면 토큰을 붙인다 (index.html 이 넣는다)
let fileToken = '';
export function setFileToken(t) { fileToken = t; }
// 카드 모드(card.html)는 주소가 없다 — href 를 비우고(이미지는 src 없이) 화면이 data-open 경로로 file.get 을 불러 채운다
let fileUrls = true;
export function setNoFileUrls() { fileUrls = false; }
// <…> 는 공백까지 받는다 (이스케이프된 꼴로 맞춘다). 꺾쇠 없는 주소는 공백·) 에서 끝난다 — 문장 속 괄호는 대개 공백이 있어 원문으로 남는다
const URL_RE = String.raw`(?:&lt;(.*?)&gt;|([^)\s]+))`;
let cwd = '';
// cwd 기준으로 풀고 . .. 를 정리한다. Windows cwd 면 \ 로 잇는다
function resolve(rel) {
  const sep = cwd.includes('\\') ? '\\' : '/', out = cwd.split(/[\\/]+/).filter((x, i) => !i || x);
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === '..') { if (out.length > 1) out.pop(); }
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.length > 1 ? out.join(sep) : out[0] + sep;
}
/** 이스케이프된 주소 → { href, open, to } (모두 이스케이프된), 그릴 수 없으면(다른 scheme·앵커·cwd 모르는 상대 경로) null. href 는 브라우저가 여는 주소, open 은 superlite 카드가 open 동사에 넘길 대상
 *  (app.js 가 data-open 으로 가로챈다 — 웹 주소는 URL 탭, 파일은 에디터). 로컬 경로의 #L12 는 떼고, %20 같은 인코딩은 풀어 서버에 넘긴다.
 *  to 는 호버 팝오버에 보일 대상 — 풀린 절대 경로에 줄 번호(:12, #L12)를 남긴다 (ticket slcode-link-hover-target) */
function target(raw) {
  const u = unesc(raw);
  if (/^https?:\/\//.test(u)) return { href: raw, open: raw, to: raw };
  const abs = /^(\/|[A-Za-z]:[\\/])/.test(u);
  if (!abs && (/^[A-Za-z][\w+.-]*:|^#/.test(u) || !cwd)) return null;
  let p = u.replace(/#.*$/, ''), line = u.match(/#L\d+(-L?\d+)?$/)?.[0] ?? '';
  try { p = decodeURI(p); } catch {}
  if (!abs) p = resolve(p);
  // open 동사는 줄 번호를 받지 않는다 — Codex 꼴 a.ts:12 는 떼고 연다 (serve 의 file 은 스스로 뗀다)
  return { href: fileUrls ? esc(`file?path=${encodeURIComponent(p)}${fileToken ? `&token=${encodeURIComponent(fileToken)}` : ''}`) : '', open: esc(p.replace(/:\d+(:\d+)?$/, '')), to: esc(p + line) };
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
      .replace(IMG, (m, alt, a, b) => { const t = target(a ?? b); if (!t) return m; return `<a class="img" href="${t.href}" data-open="${t.open}" data-to="${t.to}" target="_blank" rel="noopener"><img${t.href ? ` src="${t.href}"` : ''} alt="${alt}"></a>`; })
      .replace(LINK, (m, s, a, b) => { const t = target(a ?? b); if (!t) return m; return `<a href="${t.href}" data-open="${t.open}" data-to="${t.to}" target="_blank" rel="noopener">${s}</a>`; });
  }
  return out;
}

// 표 — `|` 로 시작하는 줄 바로 아래가 구분 줄(|---|:--:|)일 때만. ponytail: 셀 안의 `|` 는 \\| 로만 (인라인 코드 안의 | 도 칸을 나눈다)
const SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isTable = (lines, i) => lines[i].trimStart().startsWith('|') && i + 1 < lines.length && lines[i + 1].includes('-') && SEP.test(lines[i + 1]);

// 목록 — 표지보다 깊게 들여쓴 줄(빈 줄 뒤라도)은 그 항목에 속해 블록으로 다시 그린다. CommonMark 는 내용 칸(1. 이면 3칸)까지 들여써야 하위로 보지만,
// 모델이 흔히 쓰는 2칸 하위 목록도 하위로 보도록 표지보다 한 칸이라도 깊으면 받는다 (ticket slcode-markdown-nested-list)
const LI = /^(\s*)([-*]|\d+\.)\s+/;
const indent = (l) => l.match(/^\s*/)[0].length;
const startsBlock = (l) => /^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|>)/.test(l);
function list(lines, i, html) {
  const m0 = lines[i].match(LI), base = m0[1].length, ordered = /\d/.test(m0[2]);
  const items = [];
  for (let m; i < lines.length && (m = lines[i].match(LI)) && m[1].length <= base && /\d/.test(m[2]) === ordered;) {
    const head = [lines[i++].slice(m[0].length)], body = [];
    for (let j = i; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (indent(lines[j]) <= base) break;
      while (i <= j) body.push(lines[i++]);
    }
    const cut = body.length ? indent(body.find((l) => l.trim())) : 0;
    const rest = body.map((l) => l.slice(Math.min(cut, indent(l))));
    while (rest.length && rest[0].trim() && !startsBlock(rest[0])) head.push(rest.shift());
    items.push(`<li>${inline(head.join('\n')).replace(/\n/g, '<br>')}${blocks(rest)}</li>`);
    // 빈 줄 뒤라도 같은 꼴의 다음 항목이면 한 목록으로 잇는다 — 끊으면 번호가 1. 부터 다시 시작한다 (사용자 결정 2026-11-02)
    let k = i;
    while (k < lines.length && !lines[k].trim()) k++;
    const n = lines[k]?.match(LI);
    if (n && n[1].length <= base && /\d/.test(n[2]) === ordered) i = k;
  }
  // 번호 목록은 원문의 첫 번호부터 — 사이에 다른 블록이 끼어 끊겨도 번호가 이어진다 (사용자 결정 2026-11-02)
  const start = ordered ? parseInt(m0[2], 10) : 1;
  html.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
  return i;
}

/** base: 세션 cwd — 상대 경로 링크·이미지를 풀 기준. 그리는 동안만 쓴다 */
export function renderMarkdown(src, base = '') {
  cwd = base;
  return blocks(src.split('\n'));
}

function blocks(lines) {
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
    if (LI.test(line)) { i = list(lines, i, html); continue; }
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
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(buf.length && isTable(lines, i))) buf.push(lines[i++]);
    html.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return html.join('');
}
