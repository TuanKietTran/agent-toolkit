// Playwright-facing core of the CDP backend, shared by the Pi tools in cdp.ts and
// the stdio MCP server (mcp-server.mjs). Plain .mjs so the MCP server can import it
// with no build step; cdp-core.d.mts carries the types for cdp.ts.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const CDP_ACTIONS = ["move", "click", "double_click", "right_click", "drag", "scroll", "type", "key", "wait", "reset_trail"];
const CDP_TAB_ACTIONS = ["status", "list_tabs", "open", "new_tab", "select_tab", "close_tab", "back", "forward", "reload"];
const MAX_TEXT = 32e3;
const TRAIL_LENGTH = Number(process.env.PI_CDP_TRAIL_LENGTH ?? 24);
export const VIEWPORT = { width: Number(process.env.PI_CDP_WIDTH ?? 1280), height: Number(process.env.PI_CDP_HEIGHT ?? 800) };
const KEY_ALIASES = {
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown"
};
const MODIFIER_ALIASES = { primary: "ControlOrMeta", controlormeta: "ControlOrMeta", command: "Meta", cmd: "Meta", meta: "Meta", control: "Control", ctrl: "Control", shift: "Shift", option: "Alt", alt: "Alt" };
function normalizeKey(key, modifiers = []) {
  const base = KEY_ALIASES[key.toLowerCase()] ?? (/^f\d{1,2}$/i.test(key) ? key.toUpperCase() : key);
  const mods = modifiers.map((m) => {
    const mapped = MODIFIER_ALIASES[m.toLowerCase()];
    if (!mapped) throw new Error(`Unknown modifier: ${m}`);
    return mapped;
  });
  return [...new Set(mods), base].join("+");
}
function validatedUrl(raw) {
  if (typeof raw !== "string" || !raw) throw new Error("This action requires url");
  if (raw === "about:blank") return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http://, https://, and about:blank URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  return url.href;
}
function checkPoint(label, x, y, view) {
  if (typeof x !== "number" || typeof y !== "number") throw new Error(`${label} requires x and y`);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${label} coordinates must be finite`);
  if (x < 0 || y < 0 || x >= view.width || y >= view.height) throw new Error(`${label} (${x},${y}) is outside the ${view.width}x${view.height} screenshot`);
  return { x, y };
}
export const text = (value) => {
  const output = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return [{ type: "text", text: Buffer.byteLength(output) <= MAX_TEXT ? output : `${Buffer.from(output).subarray(0, MAX_TEXT).toString("utf8")}
[Output truncated at 32KB]` }];
};
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => {
    clearTimeout(timer);
    reject(signal?.reason ?? new Error("Aborted"));
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", abort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", abort, { once: true });
});
const OVERLAY_ID = "__pi_cdp_overlay__";
const drawOverlay = (args) => {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.id = args.id;
  svg.setAttribute("style", "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647");
  const last = args.trail[args.trail.length - 1];
  if (args.trail.length > 1) {
    const line = document.createElementNS(NS, "polyline");
    line.setAttribute("points", args.trail.map((p) => `${p.x},${p.y}`).join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "rgba(255,40,40,.7)");
    line.setAttribute("stroke-width", "2");
    svg.appendChild(line);
  }
  if (last) {
    for (const [x1, y1, x2, y2] of [[last.x - 12, last.y, last.x + 12, last.y], [last.x, last.y - 12, last.x, last.y + 12]]) {
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", String(x1));
      l.setAttribute("y1", String(y1));
      l.setAttribute("x2", String(x2));
      l.setAttribute("y2", String(y2));
      l.setAttribute("stroke", "#ff2828");
      l.setAttribute("stroke-width", "2");
      svg.appendChild(l);
    }
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(last.x));
    c.setAttribute("cy", String(last.y));
    c.setAttribute("r", "5");
    c.setAttribute("fill", "none");
    c.setAttribute("stroke", "#ff2828");
    c.setAttribute("stroke-width", "2");
    svg.appendChild(c);
  }
  document.documentElement.appendChild(svg);
};
class CdpSession {
  browser;
  context;
  page;
  trail = [];
  readState = new Map();
  launching;
  load;
  constructor(load = () => import("playwright-core")) {
    this.load = load;
  }
  get connected() {
    return !!this.context;
  }
  async ensure() {
    if (!this.context) {
      this.launching ??= this.start().finally(() => {
        this.launching = void 0;
      });
      await this.launching;
    }
    if (!this.page || this.page.isClosed()) {
      const pages = this.context.pages();
      this.page = pages[pages.length - 1] ?? await this.context.newPage();
    }
    this.trackPage(this.page);
    return { context: this.context, page: this.page };
  }
  async start() {
    let pw;
    try {
      pw = await this.load();
    } catch {
      throw new Error("playwright-core is not installed; run `npm install` in packages/pi-agent-extensions");
    }
    const chromium = pw.chromium ?? pw.default?.chromium;
    const endpoint = process.env.PI_CDP_URL;
    if (endpoint) {
      this.browser = await chromium.connectOverCDP(endpoint);
      this.context = this.browser.contexts()[0] ?? await this.browser.newContext({ viewport: VIEWPORT });
    } else {
      const profile = process.env.PI_CDP_PROFILE ?? join(homedir(), ".cache", "pi-cdp-browser", "profile");
      await mkdir(profile, { recursive: true });
      const headed = process.env.PI_CDP_HEADED === "1";
      const executablePath = process.env.PI_CDP_BROWSER_PATH || void 0;
      const args = process.env.PI_CDP_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
      this.context = await chromium.launchPersistentContext(profile, { headless: !headed, viewport: VIEWPORT, executablePath, args });
      this.browser = this.context.browser?.() ?? void 0;
    }
    for (const p of this.context.pages?.() ?? []) this.trackPage(p);
    this.context.on?.("page", (p) => this.trackPage(p));
    this.context.on?.("close", () => {
      this.context = void 0;
      this.page = void 0;
      this.browser = void 0;
    });
  }
  select(page) {
    this.page = page;
    this.trail = [];
    this.trackPage(page);
  }
  trackPage(page) {
    if (!page || typeof page.on !== "function" || this.readState.has(page)) return;
    const state = { errors: [], dialogs: [] };
    this.readState.set(page, state);
    const push = (entry) => { state.errors.push(entry); if (state.errors.length > 200) state.errors.shift(); };
    page.on("console", (msg) => { try { if (msg.type() === "error") push({ kind: "console", text: msg.text() }); } catch {} });
    page.on("pageerror", (err) => { push({ kind: "pageerror", text: String(err?.message ?? err) }); });
    page.on("dialog", async (dialog) => { state.dialogs.push({ type: dialog.type(), message: dialog.message(), default_value: String(dialog.defaultValue?.() ?? ""), dismissed: true }); await dialog.dismiss().catch(() => {}); });
  }
  readData(page) {
    return this.readState.get(page) ?? { errors: [], dialogs: [] };
  }
  async close() {
    const ctx = this.context, browser = this.browser;
    this.context = this.page = this.browser = void 0;
    this.trail = [];
    this.readState.clear();
    if (process.env.PI_CDP_URL) {
      await browser?.close?.().catch(() => {
      });
      return;
    }
    await ctx?.close?.().catch(() => {
    });
  }
  remember(p) {
    this.trail.push(p);
    if (this.trail.length > TRAIL_LENGTH) this.trail.shift();
  }
}
const READ_TEXT_MAX = 16384;
const READ_ELEMENTS_MAX = 200;
async function readPage(session, page) {
  session.trackPage?.(page);
  const data = await page.evaluate(() => {
    const roleFor = (el) => { const explicit = el.getAttribute("role"); if (explicit) return explicit; const tag = el.tagName.toLowerCase(); if (tag === "a") return "link"; if (tag === "button") return "button"; if (tag === "select") return "combobox"; if (tag === "textarea") return "textbox"; if (tag === "input") { const t = (el.getAttribute("type") || "text").toLowerCase(); return t === "checkbox" ? "checkbox" : t === "radio" ? "radio" : ["button", "submit", "reset"].includes(t) ? "button" : t === "search" ? "searchbox" : "textbox"; } if (/^h[1-6]$/.test(tag)) return "heading"; if (tag === "img") return "img"; return tag; };
    const nameFor = (el) => { const aria = el.getAttribute("aria-label"); if (aria?.trim()) return aria.trim(); const by = el.getAttribute("aria-labelledby"); if (by) { const joined = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim(); if (joined) return joined; } const lab = el.labels?.[0]?.textContent || document.querySelector(`label[for="${el.id}"]`)?.textContent || ""; if (lab.trim()) return lab.trim(); return String(el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || "").trim().replace(/\s+/g, " "); };
    const selector = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="textbox"],[role="combobox"],[role="tab"],[role="menuitem"],[tabindex],[contenteditable=""],[contenteditable="true"],summary';
    const items = [];
    for (const el of document.querySelectorAll(selector)) { const rect = el.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) continue; const style = getComputedStyle(el); if (style.display === "none" || style.visibility === "hidden") continue; items.push({ role: roleFor(el), name: nameFor(el).slice(0, 200), center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }, bbox: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }, in_viewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth }); }
    return { text: document.body?.innerText || "", viewport: { width: innerWidth, height: innerHeight }, items };
  });
  const inViewport = data.items.filter((item) => item.in_viewport);
  const raw = data.text || "";
  const truncatedText = Buffer.byteLength(raw) > READ_TEXT_MAX;
  const state = session.readData ? session.readData(page) : { errors: [], dialogs: [] };
  return { url: page.url(), title: await page.title().catch(() => ""), viewport: data.viewport, text: truncatedText ? Buffer.from(raw).subarray(0, READ_TEXT_MAX).toString("utf8") : raw, text_truncated: truncatedText, elements: inViewport.slice(0, READ_ELEMENTS_MAX), element_count: Math.min(inViewport.length, READ_ELEMENTS_MAX), offscreen_count: data.items.length - inViewport.length, elements_truncated: inViewport.length > READ_ELEMENTS_MAX, errors: state.errors.slice(-50), dialogs: [...state.dialogs] };
}
async function observePage(session, page) {
  const size = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const trail = [...session.trail];
  if (trail.length) await page.evaluate(drawOverlay, { trail, id: OVERLAY_ID }).catch(() => {
  });
  let image;
  try {
    image = await page.screenshot({ type: "jpeg", quality: 80, scale: "css" });
  } finally {
    if (trail.length) await page.evaluate((id) => document.getElementById(id)?.remove(), OVERLAY_ID).catch(() => {
    });
  }
  return { image, view: { width: size.width, height: size.height, url: page.url(), title: await page.title().catch(() => "") } };
}
async function perform(session, page, view, params, signal) {
  const { mouse, keyboard } = page;
  const duration = Math.max(0, Math.min(params.duration_ms ?? 200, 1e4));
  const steps = Math.max(1, Math.round(duration / 16));
  const glide = async (to) => {
    await mouse.move(to.x, to.y, { steps });
    session.remember(to);
  };
  switch (params.action) {
    case "move":
      await glide(checkPoint("move", params.x, params.y, view));
      break;
    case "click":
    case "double_click":
    case "right_click": {
      const p = checkPoint(params.action, params.x, params.y, view);
      await glide(p);
      await mouse.click(p.x, p.y, { button: params.action === "right_click" ? "right" : "left", clickCount: params.action === "double_click" ? 2 : 1 });
      break;
    }
    case "drag": {
      const from = checkPoint("drag start", params.x, params.y, view);
      const to = checkPoint("drag target", params.target_x, params.target_y, view);
      await glide(from);
      await mouse.down();
      await glide(to);
      await mouse.up();
      break;
    }
    case "scroll": {
      const p = checkPoint("scroll", params.x, params.y, view);
      await glide(p);
      await mouse.wheel(params.delta_x ?? 0, -(params.delta_y ?? 0));
      break;
    }
    case "type": {
      if (typeof params.text !== "string" || !params.text) throw new Error("type requires text");
      const parts = params.text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]) await keyboard.type(parts[i], { delay: params.interval_ms ?? 0 });
        if (i < parts.length - 1) await keyboard.press("Enter");
      }
      break;
    }
    case "key": {
      if (typeof params.key !== "string" || !params.key) throw new Error("key requires key");
      await keyboard.press(normalizeKey(params.key, params.modifiers));
      break;
    }
    case "wait":
      await sleep(params.wait_ms ?? 1e3, signal);
      break;
    case "reset_trail":
      session.trail = [];
      break;
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
  return { delivered: true, input: "cdp (virtual; OS pointer and keyboard untouched)", action: params.action, cursor: session.trail[session.trail.length - 1] };
}
export {
  CDP_ACTIONS,
  CDP_TAB_ACTIONS,
  CdpSession,
  checkPoint,
  normalizeKey,
  observePage,
  perform,
  readPage,
  validatedUrl
};
