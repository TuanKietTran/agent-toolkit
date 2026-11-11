export class CdpError extends Error { code?: string; constructor(message: string, code?: string) { super(message); this.name = "CdpError"; this.code = code; } }
export function isLoopbackHost(h: string): boolean { return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]"; }
export interface BrowserVersion { browser: string; webSocketDebuggerUrl: string }
export async function discoverBrowser(host: string, port: number): Promise<BrowserVersion> {
  if (!isLoopbackHost(host)) throw new CdpError("refusing non-loopback host: " + host);
  const res = await fetch("http://" + host + ":" + port + "/json/version", { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new CdpError("discovery failed: HTTP " + res.status);
  const j: any = await res.json();
  if (!j.webSocketDebuggerUrl) throw new CdpError("discovery response has no webSocketDebuggerUrl");
  return { browser: String(j.Browser ?? j.browser ?? "Brave"), webSocketDebuggerUrl: String(j.webSocketDebuggerUrl) };
}
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Listener = { method: string; sessionId?: string; fn: (params: any, sessionId?: string) => void };
export class CdpClient {
  readonly host: string; readonly port: number;
  browser = "";
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners: Listener[] = [];
  constructor(opts?: { host?: string; port?: number }) { this.host = opts?.host ?? "127.0.0.1"; this.port = opts?.port ?? 9222; }
  get connected(): boolean { return this.ws != null && (this.ws as any).readyState === 1; }
  async connect(): Promise<{ browser: string }> {
    if (this.connected) return { browser: this.browser };
    const info = await discoverBrowser(this.host, this.port); this.browser = info.browser;
    const ws = new WebSocket(info.webSocketDebuggerUrl); this.ws = ws as any;
    ws.addEventListener("message", (ev: any) => this.onMessage(ev.data));
    ws.addEventListener("close", () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new CdpError("websocket closed")); } this.pending.clear(); });
    await new Promise<void>((resolve, reject) => { const t = setTimeout(() => reject(new CdpError("websocket open timeout")), 5000); ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true }); ws.addEventListener("error", () => { clearTimeout(t); reject(new CdpError("websocket error")); }, { once: true }); });
    return { browser: this.browser };
  }
  private onMessage(data: unknown): void {
    let msg: any; try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) { const p = this.pending.get(msg.id)!; this.pending.delete(msg.id); clearTimeout(p.timer); if (msg.error) p.reject(new CdpError(msg.error.message ?? "cdp error", String(msg.error.code ?? ""))); else p.resolve(msg.result ?? {}); return; }
    if (msg.method) for (const l of this.listeners) if (l.method === msg.method && (l.sessionId == null || l.sessionId === msg.sessionId)) { try { l.fn(msg.params ?? {}, msg.sessionId); } catch {} }
  }
  async send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (!this.connected) throw new CdpError("not connected");
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params }; if (sessionId) payload.sessionId = sessionId;
    return await new Promise<T>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError("timeout waiting for " + method, "timeout")); }, 20000); this.pending.set(id, { resolve, reject, timer }); try { (this.ws as any).send(JSON.stringify(payload)); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); } });
  }
  on(method: string, fn: (params: any, sessionId?: string) => void, sessionId?: string): () => void { const l: Listener = { method, sessionId, fn }; this.listeners.push(l); return () => { this.listeners = this.listeners.filter((x) => x !== l); }; }
  async close(): Promise<void> { try { (this.ws as any)?.close(); } catch {} this.ws = null; }
}
export function createCdpClient(opts?: { host?: string; port?: number }): CdpClient { return new CdpClient(opts); }
export { CdpClient as CDPClient };
