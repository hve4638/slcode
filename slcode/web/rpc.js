// 캐리어 추상 — 프런트는 { request, onEvent, onStatus } 만 본다.
// WsTransport: 웹 모드. 끊기면 1s→5s 백오프로 재접속하고 core.auth 를 다시 한다. superlite 카드 모드는 같은 표면을
// apps.connect(또는 후속 background-service 통로) 위에 구현한다.

export class WsTransport {
  constructor(url, token) {
    this.url = url; this.token = token;
    this.nextId = 1; this.pending = new Map(); this.eventHandlers = new Set(); this.statusHandlers = new Set();
    this.ws = null; this.ready = false; this.delay = 1000; this.closed = false; this.generation = 0;
    this.connect();
  }
  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    const gen = ++this.generation;
    this.ws = ws;
    ws.onopen = async () => {
      this.delay = 1000;
      try {
        const r = await this.rawRequest(ws, 'core.auth', { token: this.token });
        this.ready = true;
        for (const h of this.statusHandlers) h({ connected: true, first: gen === 1 });
      } catch (e) {
        for (const h of this.statusHandlers) h({ connected: false, error: e.message, fatal: e.code === 'unauthorized' });
        if (e.code === 'unauthorized') this.closed = true;
        ws.close();
      }
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.resolve(m.result); }
      else if (m.event) for (const h of this.eventHandlers) h(m);
    };
    ws.onclose = () => {
      const wasReady = this.ready; this.ready = false; this.ws = null;
      for (const p of this.pending.values()) p.reject(Object.assign(new Error('connection closed'), { code: 'closed' }));
      this.pending.clear();
      if (wasReady) for (const h of this.statusHandlers) h({ connected: false });
      if (!this.closed) { setTimeout(() => this.connect(), this.delay); this.delay = Math.min(this.delay * 2, 5000); }
    };
    ws.onerror = () => {};
  }
  rawRequest(ws, method, params) {
    const id = this.nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  request(method, params) {
    if (!this.ws || !this.ready) return Promise.reject(Object.assign(new Error('not connected'), { code: 'closed' }));
    return this.rawRequest(this.ws, method, params);
  }
  onEvent(h) { this.eventHandlers.add(h); return () => this.eventHandlers.delete(h); }
  onStatus(h) { this.statusHandlers.add(h); if (this.ready) h({ connected: true, first: true }); return () => this.statusHandlers.delete(h); }
  close() { this.closed = true; this.ws?.close(); }
}
