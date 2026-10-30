import {
  PROTOCOL_VERSION, MAX_IMAGE_BASE64_BYTES, validateNativeRequest, validateNativeResponse,
  validateRequest, validateResponse,
} from "./bridge-protocol.mjs";

const HOST = "com.pi_agent_extensions.browser_bridge";
const MAX_BYTES = 1024 * 1024;
const grants = new Map();
const pending = new Map();
let nativePort;
let session;
let targets = new Map();
let ready = false;

const utf8Length = value => new TextEncoder().encode(JSON.stringify(value)).length;
function checked(value, validator) {
  if (utf8Length(value) > MAX_BYTES) throw new Error("message exceeds maximum size");
  return validator(value);
}
function send(value) {
  if (!nativePort) throw new Error("native host is disconnected");
  nativePort.postMessage(value);
}
function failResponse(request, code, message) {
  return { version: PROTOCOL_VERSION, id: request.id, session: request.session,
    ok: false, error: { code, message: message.slice(0, 512), retryable: false } };
}
function originOf(url) {
  try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) ? parsed.origin : null; }
  catch { return null; }
}

export function connectNative(chromeApi = chrome) {
  if (nativePort) return;
  nativePort = chromeApi.runtime.connectNative(HOST);
  nativePort.onMessage.addListener(message => { void onNativeMessage(message, chromeApi); });
  nativePort.onDisconnect.addListener(() => reset("native host disconnected"));
  chromeApi.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.url) invalidateTab(tabId, chromeApi, "navigation");
  });
  chromeApi.tabs.onRemoved?.addListener(tabId => invalidateTab(tabId, chromeApi, "closed"));
  send({ type: "hello", version: PROTOCOL_VERSION });
}

function invalidateTab(tabId, chromeApi, reason) {
  for (const [id, target] of targets) if (target.tabId === tabId) {
    targets.delete(id); grants.delete(id);
    for (const [requestId, state] of pending) if (state.target === id) state.cancelled = true;
    void chromeApi.debugger.detach({ tabId }).catch(() => {});
  }
  if (nativePort && ready) send({ type: "targets", session });
}

function reset(reason) {
  ready = false; session = undefined; targets = new Map(); grants.clear();
  for (const item of pending.values()) item.cancelled = true;
  pending.clear();
  nativePort = undefined;
  if (typeof chrome !== "undefined") chrome.runtime.sendMessage({ type: "helper-state", connected: false, targets: [], grants: [], reason }).catch(() => {});
}

export async function onNativeMessage(raw, chromeApi = chrome) {
  let message;
  try {
    message = checked(raw, value => {
      if (value?.type === "targets" && Array.isArray(value.targets)) return validateNativeResponse(value);
      if (["hello", "targets", "targetInventory", "authorize", "revoke", "executeResult", "cancelled"].includes(value?.type)) return validateNativeRequest(value);
      return validateNativeResponse(value);
    });
  } catch { return; }
  if (message.type === "ready") {
    grants.clear();
    session = message.session;
    targets = new Map(message.targets.map(target => [target.id, target]));
    ready = true;
    await chromeApi.runtime.sendMessage({ type: "helper-state", connected: true, targets: [...targets.values()], grants: [...grants.keys()] }).catch(() => {});
    return;
  }
  if (message.type === "targetsRequest") {
    if (message.session !== session || !ready) return;
    await refreshTargetInventory(chromeApi);
    return;
  }
  if (message.type === "targets") {
    if (message.session !== session) return;
    const previousTargets = targets;
    targets = new Map(message.targets.map(target => [target.id, target]));
    for (const [requestId, state] of pending) {
      const oldTarget = previousTargets.get(state.target), nextTarget = targets.get(state.target);
      if (!nextTarget || !oldTarget || nextTarget.tabId !== oldTarget.tabId || nextTarget.origin !== oldTarget.origin) state.cancelled = true;
    }
    for (const [targetId, grant] of grants) {
      const target = targets.get(targetId);
      if (!target || target.origin !== grant.origin) grants.delete(targetId);
    }
    await chromeApi.runtime.sendMessage({ type: "helper-state", connected: true, targets: [...targets.values()], grants: [...grants.keys()] }).catch(() => {});
    return;
  }
  if (message.type === "revoked") {
    if (message.session !== session) return;
    grants.delete(message.targetId);
    for (const state of pending.values()) if (state.target === message.targetId) state.cancelled = true;
    const tabId = targets.get(message.targetId)?.tabId;
    if (Number.isSafeInteger(tabId)) await chromeApi.debugger.detach({ tabId }).catch(() => {});
    await chromeApi.runtime.sendMessage({ type: "helper-state", connected: ready, targets: [...targets.values()], grants: [...grants.keys()] }).catch(() => {});
    return;
  }
  if (message.type === "authorized") {
    const target = targets.get(message.targetId);
    if (message.session !== session || !target || target.origin !== message.origin) return;
    try {
      const tab = await chromeApi.tabs.get(target.tabId);
      if (!ready || message.session !== session || targets.get(message.targetId) !== target || originOf(tab.url || "") !== message.origin) return;
      grants.set(message.targetId, { origin: message.origin });
      await chromeApi.runtime.sendMessage({ type: "helper-state", connected: ready, targets: [...targets.values()], grants: [...grants.keys()] }).catch(() => {});
    } catch { grants.delete(message.targetId); }
    return;
  }
  if (message.type === "cancel") {
    if (message.session !== session) return;
    const item = pending.get(message.id);
    const dispatched = !!item?.dispatched;
    if (item) item.cancelled = true;
    send({ type: "cancelled", session, id: message.id, dispatched });
    return;
  }
  if (message.type === "cancelled" || message.type === "revoked" || message.type === "error") return;
  if (message.type === "execute") {
    const response = await execute(message.request, chromeApi);
    send({ type: "executeResult", response });
  }
}

async function refreshTargetInventory(chromeApi) {
  const currentSession = session;
  const tabs = await chromeApi.tabs.query({});
  if (!ready || session !== currentSession) return;
  const inventory = [];
  for (const tab of tabs) {
    const origin = originOf(tab.url || "");
    if (Number.isSafeInteger(tab.id) && origin) inventory.push({ tabId: tab.id, origin, title: String(tab.title || "").slice(0, 4096) });
  }
  send({ type: "targetInventory", session: currentSession, tabs: inventory.slice(0, 256) });
}

async function liveTarget(request, chromeApi) {
  const target = targets.get(request.target);
  const grant = grants.get(request.target);
  if (!ready || request.session !== session || !target || !grant) throw new Error("UNAUTHORIZED");
  const tab = await chromeApi.tabs.get(target.tabId);
  const liveOrigin = originOf(tab.url || "");
  if (!liveOrigin || liveOrigin !== grant.origin || liveOrigin !== target.origin) {
    grants.delete(request.target);
    throw new Error("STALE_SESSION");
  }
  return { target, tab };
}

async function dispatch(request, chromeApi, tabId, state) {
  const target = { tabId };
  await chromeApi.debugger.attach(target, "1.3").catch(error => {
    if (!/Another debugger is already attached/i.test(String(error))) throw error;
  });
  const cdp = async (method, params = {}) => {
    if (!ready || state.cancelled || request.session !== session || targets.get(request.target)?.tabId !== tabId || !grants.has(request.target)) throw new Error(state.cancelled ? "CANCELLED" : "UNAUTHORIZED");
    const live = await chromeApi.tabs.get(tabId);
    if (!ready || state.cancelled || request.session !== session || targets.get(request.target)?.tabId !== tabId || grants.get(request.target)?.origin !== originOf(live.url || "") || targets.get(request.target)?.origin !== originOf(live.url || "")) throw new Error(state.cancelled ? "CANCELLED" : "STALE_SESSION");
    state.dispatched = true;
    return chromeApi.debugger.sendCommand(target, method, params);
  };
  try {
    switch (request.action) {
      case "observe": {
        const image = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 75, captureBeyondViewport: false });
        // Use the canonical decoded-image limit; the envelope validator enforces total wire size.
        if (typeof image.data !== "string" || image.data.length > MAX_IMAGE_BASE64_BYTES) throw new Error("TOO_LARGE");
        return { accepted: true, imageBase64: image.data, mimeType: "image/jpeg" };
      }
      case "click": {
        const { x, y, button = "left" } = request.args;
        try { await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 }); }
        finally { await chromeApi.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 }).catch(() => {}); }
        return { accepted: true };
      }
      case "drag": {
        const { start, end, button = "left" } = request.args;
        try {
          await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button, clickCount: 1 });
          await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: end.x, y: end.y, button, buttons: button === "left" ? 1 : button === "right" ? 2 : 4 });
        } finally {
          await chromeApi.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button, clickCount: 1 }).catch(() => {});
        }
        return { accepted: true };
      }
      case "type": await cdp("Input.insertText", { text: request.args.text }); return { accepted: true };
      case "key": {
        const modifiers = { Alt: 1, Ctrl: 2, Meta: 4, Shift: 8 };
        const modifierMask = (request.args.modifiers || []).reduce((mask, key) => mask | modifiers[key], 0);
        try { await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: request.args.key, modifiers: modifierMask }); }
        finally { await chromeApi.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", key: request.args.key, modifiers: modifierMask }).catch(() => {}); }
        return { accepted: true };
      }
      case "scroll": await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", ...request.args }); return { accepted: true };
      case "navigate": {
        const url = new URL(request.args.url);
        if (!["http:", "https:"].includes(url.protocol)) throw new Error("INVALID_REQUEST");
        if (url.origin !== targets.get(request.target).origin) throw new Error("UNAUTHORIZED");
        await cdp("Page.navigate", { url: url.href }); return { accepted: true };
      }
      default: throw new Error("UNSUPPORTED_ACTION");
    }
  } finally {
    // CDP attachment is target-scoped and detached after each bounded operation.
    await chromeApi.debugger.detach(target).catch(() => {});
  }
}

async function execute(request, chromeApi) {
  if (pending.has(request.id)) return validateResponse(failResponse(request, "INVALID_REQUEST", "Duplicate in-flight request id."));
  const state = { dispatched: false, cancelled: false, target: request.target };
  pending.set(request.id, state);
  try {
    validateRequest(request);
    const { target } = await liveTarget(request, chromeApi);
    if (state.cancelled || !ready || request.session !== session || grants.get(request.target)?.origin !== target.origin || targets.get(request.target) !== target) throw new Error(state.cancelled ? "CANCELLED" : "UNAUTHORIZED");
    const result = await dispatch(request, chromeApi, target.tabId, state);
    return validateResponse({ version: PROTOCOL_VERSION, id: request.id, session: request.session, ok: true, result });
  } catch (error) {
    const code = ["UNAUTHORIZED", "STALE_SESSION", "TOO_LARGE", "UNSUPPORTED_ACTION", "INVALID_REQUEST", "CANCELLED"].includes(error.message) ? error.message : "INTERNAL";
    return validateResponse(failResponse(request, code, "Browser action failed; dispatched effects may be uncertain."));
  } finally { pending.delete(request.id); }
}

export async function onUiMessage(message, chromeApi = chrome) {
  if (message?.type === "get-state") return { connected: ready, targets: [...targets.values()], grants: [...grants.keys()] };
  if (message?.type === "connect") { connectNative(chromeApi); return { connecting: true }; }
  if (!nativePort || !ready) throw new Error("native host is not ready");
  if (message.type === "targets-refresh") { send({ type: "targets", session }); return { requested: true }; }
  if (message.type === "grant") {
    const target = targets.get(message.targetId);
    if (!target || target.origin !== message.origin || !originOf(target.url || target.origin)) throw new Error("target origin changed");
    send({ type: "authorize", session, targetId: target.id, origin: target.origin });
    return { requested: true };
  }
  if (message.type === "revoke") {
    send({ type: "revoke", session, targetId: message.targetId });
    grants.delete(message.targetId);
    for (const state of pending.values()) if (state.target === message.targetId) state.cancelled = true;
    return { requested: true };
  }
  throw new Error("unsupported UI request");
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) { sendResponse({ error: "unauthorized sender" }); return; }
    onUiMessage(message).then(sendResponse, error => sendResponse({ error: error.message }));
    return true;
  });
}
