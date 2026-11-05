// 카드 화면 마운트 (ticket slcode-card-iframe-flatten). 플러그인 문서에 직접 그리는 1단 카드(views/session.js)와 옛 플러그인의 iframe 카드(card.html)가 같이 쓴다.
// port 는 serve 까지 이어진 MessagePort, ui 는 플러그인이 저장해 둔 화면 상태다. 바꾸면 포트로 {ui} 를 보내 플러그인이 저장한다 (sandbox 라 localStorage 가 없다).
import { PortTransport } from './rpc.js';
import { setNoFileUrls } from './markdown.js';
import { mountAgentFront } from './app.js';

export function mountCard(root, port, ui, opts) {
  setNoFileUrls();
  const transport = new PortTransport(port);
  const store = { get: (k) => ui[k] ?? null, set: (k, v) => { ui[k] = v; port.postMessage({ ui: { key: k, value: v } }); } };
  mountAgentFront(root, transport, { store, ...opts });
  // 답변 속 로컬 이미지 — 주소가 없으니 file.get 으로 받아 blob 주소로. 스트리밍 중 다시 그려도 같은 경로는 한 번만 받는다
  const blobs = new Map();
  const fill = (img) => {
    const p = img.parentElement?.dataset.open;
    if (!p) return;
    if (!blobs.has(p)) blobs.set(p, transport.request('file.get', { path: p }).then(async (r) => URL.createObjectURL(await (await fetch(`data:${r.mediaType};base64,${r.data}`)).blob()), () => { blobs.delete(p); return null; }));
    blobs.get(p).then((u) => { if (u && !img.src) img.src = u; });
  };
  const scan = () => { for (const img of root.querySelectorAll('a[data-open] > img:not([src])')) fill(img); };
  new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  transport.onStatus((s) => { if (s.connected) scan(); }); // 끊긴 사이 못 받은 이미지
}
