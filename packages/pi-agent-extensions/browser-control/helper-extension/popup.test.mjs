import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class Element {
  constructor() { this.listeners = new Map(); this.children = []; this.attributes = {}; this.textContent = ""; this.disabled = false; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  async click() { await this.listeners.get("click")?.(); }
}

test("popup provides nativeMessaging permission and explicit connect, refresh, grant and revoke controls", async () => {
  const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.equal(manifest.action.default_popup, "popup.html");
  const html = await readFile(new URL("./popup.html", import.meta.url), "utf8");
  assert.match(html, /id="connect"/);
  assert.match(html, /id="refresh"/);
  assert.match(html, /src="popup\.js"/);

  const elements = new Map(["#state", "#targets", "#connect", "#refresh"].map(id => [id, new Element()]));
  const sent = [], runtimeListeners = [];
  let grants = [];
  globalThis.document = { querySelector: selector => elements.get(selector), createElement: () => new Element() };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = fn => { queueMicrotask(fn); return 0; };
  globalThis.chrome = { runtime: {
    sendMessage: async message => {
      sent.push(message);
      if (message.type === "get-state") return { connected: true, targets: [{ id: "opaque-id", origin: "https://safe.test", title: "Example" }], grants };
      if (message.type === "grant") grants = ["opaque-id"];
      if (message.type === "revoke") grants = [];
      return {};
    },
    onMessage: { addListener: fn => runtimeListeners.push(fn) },
  } };
  try {
    await import(new URL(`./popup.js?test=${Date.now()}`, import.meta.url).href);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(elements.get("#targets").children.length);
    await elements.get("#connect").click();
    const card = elements.get("#targets").children[0];
    const allow = card.children[2];
    await allow.click();
    assert.ok(sent.some(message => message.type === "connect"));
    await elements.get("#refresh").click();
    assert.ok(sent.some(message => message.type === "targets-refresh"));
    assert.ok(sent.some(message => message.type === "grant" && message.targetId === "opaque-id" && message.origin === "https://safe.test"));

    runtimeListeners[0]({ type: "helper-state", connected: true, targets: [{ id: "opaque-id", origin: "https://safe.test", title: "Example" }], grants: ["opaque-id"] });
    await new Promise(resolve => setImmediate(resolve));
    await elements.get("#targets").children[0].children[2].click();
    assert.ok(sent.some(message => message.type === "revoke" && message.targetId === "opaque-id"));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    delete globalThis.document;
    delete globalThis.chrome;
  }
});
