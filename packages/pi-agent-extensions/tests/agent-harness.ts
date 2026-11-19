// End-to-end harness: a real pi AgentSession (real agent loop, real extension runner, real event
// emission) with this package's extensions, driven either by pi's faux provider (deterministic
// infrastructure tests) or by a real configured model (live tests).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai";
import browserControlCdp from "../browser-control/cdp/index.ts";
import { createController } from "../browser-control/cdp/controller.ts";
import { FAST_PACING, type Controller } from "../browser-control/cdp/contract.ts";
import remoteControl from "../remote-control.ts";
import type { AgentEvent } from "../runtime/events.ts";
import { getRuntime } from "../runtime/runtime.ts";

export { fauxAssistantMessage, fauxText, fauxToolCall };
export type Factory = (pi: ExtensionAPI) => void | Promise<void>;

export interface Harness {
  session: AgentSession;
  faux?: FauxProviderHandle;
  controller: Controller;
  dispose(): Promise<void>;
}

export async function startHarness(opts: {
  browserPort: number;
  responses?: FauxResponseStep[];
  /** Use a real configured model instead of the faux provider. */
  realModel?: { provider: string; id: string; authPath: string; modelsPath?: string };
  extraExtensions?: Factory[];
  tokensPerSecond?: number;
  controller?: Controller;
}): Promise<Harness> {
  process.env.PI_REMOTE_CONTROL_NO_CLIPBOARD = "1";
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-"));
  const controller = opts.controller ?? createController({ port: opts.browserPort, pacing: { ...FAST_PACING } });
  const faux = opts.realModel ? undefined : fauxProvider({ provider: "faux", models: [{ id: "faux-1", input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 }], tokensPerSecond: opts.tokensPerSecond ?? 400 });
  if (faux && opts.responses) faux.setResponses(opts.responses);
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } } as never);
  const factories: Factory[] = [
    ...(faux ? [(pi: ExtensionAPI) => pi.registerProvider(faux.provider)] : []),
    (pi: ExtensionAPI) => browserControlCdp(pi, { controller, agent: () => "harness" }),
    remoteControl,
    ...(opts.extraExtensions ?? []),
  ];
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories } as never);
  await loader.reload();
  const modelRuntime = await ModelRuntime.create(opts.realModel
    ? { authPath: opts.realModel.authPath, modelsPath: opts.realModel.modelsPath ?? null, allowModelNetwork: false }
    : { authPath: join(dir, "auth.json"), modelsPath: null, allowModelNetwork: false });
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), settingsManager, noTools: "builtin" });
  await session.bindExtensions({});
  const model = opts.realModel ? modelRuntime.getModel(opts.realModel.provider, opts.realModel.id) : modelRuntime.getModel("faux", "faux-1");
  if (!model) throw new Error("model not available");
  await session.setModel(model);
  return {
    session, faux, controller,
    async dispose() { session.dispose(); await controller.close(); },
  };
}

// ---------- remote-control client ----------

export interface RemoteClient {
  base: string;
  cookie: string;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown): Promise<Response>;
}

export async function startRemote(session: AgentSession): Promise<RemoteClient> {
  await session.prompt("/remote-control local");
  const st = (globalThis as Record<symbol, any>)[Symbol.for("pi.remote-control.state.v1")];
  const base = `http://127.0.0.1:${st.port}`;
  const pair = await fetch(base + "/api/pair", { method: "POST", headers: { authorization: "Bearer " + st.token } });
  if (!pair.ok) throw new Error("pairing failed");
  const cookie = (pair.headers.get("set-cookie") ?? "").split(";")[0];
  return {
    base, cookie,
    get: (path) => fetch(base + path, { headers: { cookie } }),
    post: (path, body) => fetch(base + path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
  };
}

/** Closes the remote-control HTTP server and its streams so the test process can exit. */
export function stopRemoteServer(): void {
  const st = (globalThis as Record<symbol, any>)[Symbol.for("pi.remote-control.state.v1")];
  if (!st?.server) return;
  for (const client of [...st.clients]) { client.unsubscribe(); clearInterval(client.heartbeat); try { client.res.end(); } catch {} }
  st.clients.clear();
  st.completionUnsubscribe?.(); st.completionUnsubscribe = undefined;
  st.server.closeAllConnections?.();
  st.server.close();
  st.server = undefined; st.port = undefined;
}

export interface Received { event: AgentEvent; receivedAt: number; sseId?: string; sseType: string }
export interface EventStreamClient { received: Received[]; frames: { type: string; data: string }[]; close(): void; closed: Promise<void>; waitFor(pred: (e: AgentEvent) => boolean, ms?: number): Promise<AgentEvent> }

/** Minimal SSE client (fetch-based so tests can send Last-Event-ID explicitly). */
export function openEvents(remote: RemoteClient, lastEventId?: string): EventStreamClient {
  const ac = new AbortController();
  const received: Received[] = [];
  const frames: { type: string; data: string }[] = [];
  const waiters: { pred: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void }[] = [];
  const headers: Record<string, string> = { cookie: remote.cookie };
  if (lastEventId) headers["last-event-id"] = lastEventId;
  const closed = (async () => {
    try {
      const res = await fetch(remote.base + "/api/events", { headers, signal: ac.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          let type = "message", data = "", id: string | undefined;
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) type = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
            else if (line.startsWith("id: ")) id = line.slice(4);
          }
          if (!data) continue;
          frames.push({ type, data });
          if (type === "reset") continue;
          const event = JSON.parse(data) as AgentEvent;
          received.push({ event, receivedAt: Date.now(), sseId: id, sseType: type });
          for (const w of [...waiters]) if (w.pred(event)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(event); }
        }
      }
    } catch {}
  })();
  return {
    received, frames, closed,
    close: () => ac.abort(),
    waitFor(pred, ms = 20000) {
      const found = received.find((r) => pred(r.event));
      if (found) return Promise.resolve(found.event);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (e: AgentEvent) => { clearTimeout(t); resolve(e); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error("timed out waiting for event")); }, ms);
        waiters.push(w);
      });
    },
  };
}

// ---------- faux-model helpers ----------

type ToolMessage = { role: string; toolName?: string; content?: { type: string; text?: string }[] };
export function lastToolText(ctx: { messages: readonly unknown[] }, toolName?: string): string {
  const m = (ctx.messages as ToolMessage[]).filter((x) => x.role === "toolResult" && (!toolName || x.toolName === toolName)).pop();
  return (Array.isArray(m?.content) ? m.content : []).map((c) => c.text ?? "").join("\n");
}
export function refIn(snapshot: string, name: string, role?: string): string {
  for (const line of snapshot.split("\n")) {
    if (!line.includes(`"${name}"`)) continue;
    if (role && !line.includes(`] ${role} "`)) continue;
    const m = line.match(/\[(e\d+)\]/);
    if (m) return m[1];
  }
  throw new Error(`no ref for ${role ?? ""} "${name}" in snapshot:\n${snapshot}`);
}
export function tabFrom(text: string): string { const m = text.match(/opened tab (\S+)/); if (!m) throw new Error("no tab id in: " + text); return m[1]; }

export function runtimeEvents(executionId?: string): AgentEvent[] {
  return getRuntime().log.all().filter((e) => !executionId || e.executionId === executionId);
}
export function lastExecutionId(): string | undefined {
  const all = getRuntime().log.all();
  return [...all].reverse().find((e) => e.type === "agent.started")?.executionId;
}
