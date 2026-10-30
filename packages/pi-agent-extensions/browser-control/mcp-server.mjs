#!/usr/bin/env node
import { createInterface } from "node:readline";

const tools = [
  { name: "browser_targets", description: "List currently available browser targets (authorization is still required).", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "browser_observe", description: "Capture an observation of an authorized browser target.", inputSchema: { type: "object", properties: { targetId: { type: "string" } }, required: ["targetId"], additionalProperties: false } },
  { name: "browser_click", description: "Click at page coordinates on an authorized target.", inputSchema: { type: "object", properties: { targetId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "middle", "right"] } }, required: ["targetId", "x", "y"], additionalProperties: false } },
  { name: "browser_drag", description: "Drag within an authorized page.", inputSchema: { type: "object", properties: { targetId: { type: "string" }, start: { type: "object" }, end: { type: "object" }, button: { type: "string", enum: ["left", "middle", "right"] } }, required: ["targetId", "start", "end"], additionalProperties: false } },
  { name: "browser_type", description: "Type text into an authorized page.", inputSchema: { type: "object", properties: { targetId: { type: "string" }, text: { type: "string" } }, required: ["targetId", "text"], additionalProperties: false } },
  { name: "browser_key", description: "Send a key to an authorized page.", inputSchema: { type: "object", properties: { targetId: { type: "string" }, key: { type: "string" } }, required: ["targetId", "key"], additionalProperties: false } },
  { name: "browser_scroll", description: "Scroll an authorized page.", inputSchema: { type: "object", properties: { targetId: { type: "string" }, x: { type: "number" }, y: { type: "number" }, deltaX: { type: "number" }, deltaY: { type: "number" } }, required: ["targetId", "x", "y", "deltaY"], additionalProperties: false } },
  { name: "browser_navigate", description: "Navigate an authorized target to a validated HTTP(S) URL.", inputSchema: { type: "object", properties: { targetId: { type: "string" }, url: { type: "string" } }, required: ["targetId", "url"], additionalProperties: false } },
];
const actions = Object.fromEntries(tools.slice(1).map(t => [t.name, t.name.slice("browser_".length)]));
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function serve({ input = process.stdin, output = process.stdout, client } = {}) {
  if (!client) {
    const { createBridgeClient } = await import("./bridge-client.mjs");
    client = createBridgeClient({ socketPath: process.env.PI_BROWSER_BRIDGE_SOCKET });
  }
  let initialized = false, closed = false;
  const active = new Map();
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  const respondError = (id, e) => err(id, e?.code === "CANCELLED" ? -32800 : -32000, String(e?.message ?? "Bridge request failed").slice(0, 512));
  async function handle(m) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return send(err(m?.id ?? null, -32600, "Invalid Request"));
    const hasId = Object.hasOwn(m, "id");
    try {
      if (m.method === "notifications/initialized" || m.method === "notifications/cancelled") {
        if (m.method.endsWith("cancelled")) active.get(m.params?.requestId)?.abort(new Error("Cancelled"));
        return;
      }
      if (m.method === "initialize") {
        if (initialized) throw Object.assign(new Error("Already initialized"), { rpc: -32600 });
        await client.connect(); initialized = true;
        return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "pi-browser-bridge", version: "1.0.0" } } });
      }
      if (!initialized) throw Object.assign(new Error("Server not initialized"), { rpc: -32002 });
      if (m.method === "ping") return hasId && send({ jsonrpc: "2.0", id: m.id, result: {} });
      if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
      if (m.method !== "tools/call") throw Object.assign(new Error("Method not found"), { rpc: -32601 });
      const { name, arguments: args = {} } = m.params ?? {};
      if (name === "browser_targets") {
        const targets = await client.listTargets();
        return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(targets) }] } });
      }
      const action = actions[name];
      if (!action) throw Object.assign(new Error("Unknown tool"), { rpc: -32602 });
      const { targetId, ...actionArgs } = args;
      if (typeof targetId !== "string" || !targetId) throw Object.assign(new Error("targetId is required"), { rpc: -32602 });
      if (action === "click") { actionArgs.button ??= "left"; }
      if (action === "drag") actionArgs.button ??= "left";
      const controller = new AbortController(); if (hasId) active.set(m.id, controller);
      try {
        const response = await client.request(action, actionArgs, { targetId, signal: controller.signal });
        if (!response.ok) throw Object.assign(new Error(response.error?.message ?? "Browser action failed"), { code: response.error?.code });
        const result = response.result ?? {};
        const content = [];
        if (typeof result.text === "string") content.push({ type: "text", text: result.text });
        if (typeof result.image === "string") content.push({ type: "image", data: result.image, mimeType: result.mimeType ?? "image/png" });
        if (!content.length) content.push({ type: "text", text: JSON.stringify(result) });
        send({ jsonrpc: "2.0", id: m.id, result: { content, isError: false } });
      } finally { if (hasId) active.delete(m.id); }
    } catch (e) {
      if (hasId) send(e.rpc ? err(m.id, e.rpc, e.message) : respondError(m.id, e));
    }
  }
  const rl = createInterface({ input, crlfDelay: Infinity });
  const tasks = new Set();
  for await (const line of rl) {
    if (closed) break;
    if (Buffer.byteLength(line) > 1024 * 1024) { send(err(null, -32700, "Message too large")); continue; }
    let message;
    try { message = JSON.parse(line); } catch { send(err(null, -32700, "Parse error")); continue; }
    const task = handle(message).catch(e => { process.stderr.write(`browser MCP request failed: ${e?.message ?? e}\\n`); });
    tasks.add(task); task.finally(() => tasks.delete(task));
  }
  closed = true; for (const c of active.values()) c.abort();
  await Promise.allSettled(tasks);
  await client.close();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  serve({ client: createBridgeClient({ socketPath: process.env.PI_BROWSER_BRIDGE_SOCKET }) }).catch(e => { process.stderr.write(`browser MCP server: ${e?.message ?? e}\n`); process.exitCode = 1; });
}
