#!/usr/bin/env node
import { createInterface } from "node:readline";
import { WindowsMcpSession, windowsMcpEnabled, windowsMcpTools } from "./windows-mcp.mjs";

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
const cdpTools = [
  { name: "cdp_observe", description: "Screenshot the dedicated virtual-input Chromium (headless; the one at PI_CDP_URL or launched by this server). Call before cdp_click/cdp_scroll; coordinates are screenshot pixels.", inputSchema: { type: "object", properties: { delay_ms: { type: "integer", minimum: 0, maximum: 10000 } }, additionalProperties: false } },
  { name: "cdp_click", description: "Click at screenshot coordinates in the virtual browser.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false } },
  { name: "cdp_type", description: "Type text into the focused element of the virtual browser (newlines press Enter).", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  { name: "cdp_key", description: "Press a key in the virtual browser, optionally with modifiers (primary, command, shift, option, control).", inputSchema: { type: "object", properties: { key: { type: "string" }, modifiers: { type: "array", items: { type: "string" } } }, required: ["key"], additionalProperties: false } },
  { name: "cdp_scroll", description: "Scroll the virtual browser at screenshot coordinates (positive delta_y scrolls up).", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, delta_x: { type: "integer" }, delta_y: { type: "integer" } }, required: ["x", "y"], additionalProperties: false } },
  { name: "cdp_navigate", description: "Navigate the active virtual-browser tab to a validated HTTP(S) URL.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
  { name: "cdp_tabs", description: "Manage virtual-browser tabs: status, list_tabs, open, new_tab, select_tab, close_tab, back, forward, reload.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["status", "list_tabs", "open", "new_tab", "select_tab", "close_tab", "back", "forward", "reload"] }, url: { type: "string" }, tab_index: { type: "integer", minimum: 1 } }, required: ["action"], additionalProperties: false } },
];
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function serve({ input = process.stdin, output = process.stdout, client, windowsAdapter } = {}) {
  if (!client) {
    const { createBridgeClient } = await import("./bridge-client.mjs");
    client = createBridgeClient({ socketPath: process.env.PI_BROWSER_BRIDGE_SOCKET, configPath: process.env.PI_BROWSER_BRIDGE_CONFIG });
  }
  if (!windowsAdapter && windowsMcpEnabled()) windowsAdapter = new WindowsMcpSession();
  const advertisedWindowsTools = windowsAdapter ? windowsMcpTools : [];
  let cdpCore, cdpSession, cdpView;
  if (process.env.PI_CDP_MCP === "1") {
    cdpCore = await import("./cdp-core.mjs");
    cdpSession = new cdpCore.CdpSession();
  }
  const advertisedCdpTools = cdpSession ? cdpTools : [];
  let cdpQueue = Promise.resolve();
  const cdpSerial = (fn) => { const next = cdpQueue.then(fn, fn); cdpQueue = next.catch(() => undefined); return next; };
  const cdpText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
  async function cdpPerform(params, signal) {
    const needsView = !["wait", "reset_trail", "type", "key"].includes(params.action);
    const { page } = await cdpSession.ensure();
    if (needsView && !cdpView) throw new Error("Call cdp_observe first");
    const size = page.viewportSize();
    if (needsView && size && (size.width !== cdpView.width || size.height !== cdpView.height)) { cdpView = undefined; throw new Error("The viewport changed; call cdp_observe again"); }
    const result = await cdpCore.perform(cdpSession, page, cdpView ?? size ?? cdpCore.VIEWPORT, params, signal);
    await cdpCore.sleep(100, signal);
    return cdpText(result);
  }
  async function callCdp(name, args, signal) {
    return cdpSerial(async () => {
      signal?.throwIfAborted();
      switch (name) {
        case "cdp_observe": {
          await cdpCore.sleep(args.delay_ms ?? 150, signal);
          const { page } = await cdpSession.ensure();
          const shot = await cdpCore.observePage(cdpSession, page);
          cdpView = { width: shot.view.width, height: shot.view.height };
          return { content: [{ type: "text", text: JSON.stringify({ ...shot.view, cursor: cdpSession.trail[cdpSession.trail.length - 1] ?? null }) }, { type: "image", data: shot.image.toString("base64"), mimeType: "image/jpeg" }], isError: false };
        }
        case "cdp_click": return cdpPerform({ action: "click", x: args.x, y: args.y }, signal);
        case "cdp_type": return cdpPerform({ action: "type", text: args.text }, signal);
        case "cdp_key": return cdpPerform({ action: "key", key: args.key, modifiers: args.modifiers }, signal);
        case "cdp_scroll": return cdpPerform({ action: "scroll", x: args.x, y: args.y, delta_x: args.delta_x, delta_y: args.delta_y }, signal);
        case "cdp_navigate": {
          const { page } = await cdpSession.ensure();
          await page.goto(cdpCore.validatedUrl(args.url), { waitUntil: "load", timeout: 30_000 });
          cdpView = undefined;
          return cdpText({ url: page.url() });
        }
        case "cdp_tabs": {
          const { context, page } = await cdpSession.ensure();
          const list = async () => Promise.all(context.pages().map(async (p, i) => ({ index: i + 1, active: p === page, url: p.url(), title: await p.title().catch(() => "") })));
          switch (args.action) {
            case "status": case "list_tabs": return cdpText({ tabs: await list() });
            case "open": await page.goto(cdpCore.validatedUrl(args.url), { waitUntil: "load", timeout: 30_000 }); cdpView = undefined; return cdpText({ url: page.url() });
            case "new_tab": { const next = await context.newPage(); cdpSession.select(next); await next.goto(cdpCore.validatedUrl(args.url), { waitUntil: "load", timeout: 30_000 }); cdpView = undefined; return cdpText({ url: next.url() }); }
            case "select_tab": { const target = context.pages()[(args.tab_index ?? 0) - 1]; if (!target) throw new Error("select_tab requires a valid tab_index"); await target.bringToFront(); cdpSession.select(target); cdpView = undefined; return cdpText({ selected: args.tab_index, url: target.url() }); }
            case "close_tab": { const target = args.tab_index ? context.pages()[args.tab_index - 1] : page; if (!target) throw new Error("No such tab"); await target.close(); cdpView = undefined; return cdpText({ closed: true }); }
            case "back": await page.goBack({ timeout: 30_000 }); cdpView = undefined; return cdpText({ url: page.url() });
            case "forward": await page.goForward({ timeout: 30_000 }); cdpView = undefined; return cdpText({ url: page.url() });
            case "reload": await page.reload({ timeout: 30_000 }); cdpView = undefined; return cdpText({ url: page.url() });
            default: throw new Error(`Unknown tab action: ${args.action}`);
          }
        }
        default: throw new Error(`Unknown tool: ${name}`);
      }
    });
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
      if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [...tools, ...advertisedWindowsTools, ...advertisedCdpTools] } });
      if (m.method !== "tools/call") throw Object.assign(new Error("Method not found"), { rpc: -32601 });
      const { name, arguments: args = {} } = m.params ?? {};
      if (name === "browser_targets") {
        const targets = await client.listTargets();
        return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(targets) }] } });
      }
      const action = actions[name];
      if (!action && advertisedWindowsTools.some(tool => tool.name === name)) {
        const controller = new AbortController(); if (hasId) active.set(m.id, controller);
        try { send({ jsonrpc: "2.0", id: m.id, result: await windowsAdapter.call(name, args, controller.signal) }); }
        finally { if (hasId) active.delete(m.id); }
        return;
      }
      if (!action && cdpSession && cdpTools.some(tool => tool.name === name)) {
        const controller = new AbortController(); if (hasId) active.set(m.id, controller);
        try { send({ jsonrpc: "2.0", id: m.id, result: await callCdp(name, args, controller.signal) }); }
        finally { if (hasId) active.delete(m.id); }
        return;
      }
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
        const imageBase64 = typeof result.imageBase64 === "string" ? result.imageBase64 : result.image;
        if (typeof imageBase64 === "string") content.push({ type: "image", data: imageBase64, mimeType: /^image\/(png|jpeg|webp)$/.test(result.mimeType ?? "") ? result.mimeType : "image/png" });
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
  await cdpSession?.close().catch(() => {});
  await client.close();
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\", "/")}`).href) {
  serve().catch(e => { process.stderr.write(`browser MCP server: ${e?.message ?? e}\n`); process.exitCode = 1; });
}
