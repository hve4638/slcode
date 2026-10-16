// slcode 가 모든 세션에 덧붙이는 지시 (ticket slcode-append-system-prompt, 사용자 결정 2026-10-17).
// 고정 문구만 — 사용자 문구는 CLAUDE.md·AGENTS.md 로. Claude 는 시스템 프롬프트 preset 의 append, Codex 는 thread/start·fork 의 developerInstructions.
// 웹(web/markdown.js)이 그리는 형식과 serve 의 file 경로가 이 문구의 약속이다 — 한쪽을 바꾸면 같이 바꾼다.

export const SLCODE_PROMPT = `# slcode display
The user reads your replies in slcode, a GUI that renders Markdown. Links and images in your reply are shown to the user:
- Image: ![description](https://example.com/a.png) or ![description](/absolute/path/to/a.png) is displayed in the reply.
- Link: [text](https://example.com) or [text](/absolute/path/to/file) opens when clicked (web page or file viewer).
An image takes a whole line on screen, so put each image on its own line (break the line after ![...](...)).
Local files must be absolute paths; write spaces as %20. Use this to show screenshots, generated images or charts, or files the user may want to open.`;
