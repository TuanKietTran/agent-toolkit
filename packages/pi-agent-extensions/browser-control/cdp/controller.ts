import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { ActionResult, BlockState, CallOptions, Controller, ControllerOptions, ControllerProgress, ErrorResult, OkResult, Ownership, PageFacts, StopResult, ToolName, ToolParams, Verification } from "./contract.ts";
import { OBSERVATION_TOOLS, REF_PATTERN } from "./contract.ts";
import { CdpClient, CdpError, isLoopbackHost } from "./client.ts";
import { detectBlock } from "./detector.ts";
import { isSubmitLike } from "./guard.ts";
import { createOwnership } from "./ownership.ts";
import { Pacer } from "./pacing.ts";
import { SnapshotStore, buildSnapshot, type AxNodeLike, type RefEntry } from "./snapshot.ts";

function err(code: ErrorResult["code"], message: string): ErrorResult { return { ok: false, stop: false, code, message }; }
function ok(text: string, data?: Record<string, unknown>, verification?: Verification): OkResult {
  const r: OkResult = { ok: true, text };
  if (data) r.data = data;
  if (verification) r.verification = verification;
  return r;
}
function stopRes(tab: string, url: string, reason: StopResult["reason"]): StopResult { return { ok: false, stop: true, reason, tab, url, message: "STOP: " + reason + " on " + url + " - stop acting on this tab and hand over to the user." }; }
function validUrl(u: unknown): u is string { if (typeof u !== "string" || !u) return false; if (u === "about:blank") return true; try { const p = new URL(u); return p.protocol === "http:" || p.protocol === "https:"; } catch { return false; } }
const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});
const quote = (s: string, n = 80): string => JSON.stringify(s.length > n ? s.slice(0, n) + "…" : s);

interface TargetInfo { targetId: string; type: string; url: string; title: string }
/** Page state read in one evaluation. */
interface PageState extends PageFacts { readyState: string; httpStatus?: number; scrollX: number; scrollY: number; active: string }
interface ElementState { tag: string; type: string; role: string; aria: string; text: string; value: string; checked?: boolean; pressed?: string; expanded?: string; selected?: string; open?: boolean; inForm: boolean; inSearchForm: boolean; contentEditable: boolean; x: number; y: number; w: number; h: number }
interface NavWatch { started: boolean; committed: boolean; stopped: boolean; loaded: boolean; sameDocument: boolean; url?: string; dispose(): void }
interface Dialog { type: string; message: string }
type Progress = (e: ControllerProgress) => void;

const KEYMAP: Record<string, { key: string; code: string; vk: number; text?: string }> = { Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" }, Tab: { key: "Tab", code: "Tab", vk: 9 }, Escape: { key: "Escape", code: "Escape", vk: 27 }, Esc: { key: "Escape", code: "Escape", vk: 27 }, Backspace: { key: "Backspace", code: "Backspace", vk: 8 }, Delete: { key: "Delete", code: "Delete", vk: 46 }, ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 }, ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 }, ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 }, ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 }, Home: { key: "Home", code: "Home", vk: 36 }, End: { key: "End", code: "End", vk: 35 }, PageDown: { key: "PageDown", code: "PageDown", vk: 34 }, PageUp: { key: "PageUp", code: "PageUp", vk: 33 }, " ": { key: " ", code: "Space", vk: 32, text: " " }, Space: { key: " ", code: "Space", vk: 32, text: " " } };

const PAGE_STATE_JS = `(function(){ var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {}; var a = document.activeElement; return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 8000), pw: !!document.querySelector('input[type=password]'), readyState: document.readyState, httpStatus: nav.responseStatus || 0, scrollX: window.scrollX, scrollY: window.scrollY, active: a && a !== document.body ? (a.tagName + '#' + (a.id || '') + ':' + ((a.getAttribute && a.getAttribute('aria-label')) || a.name || '')) : '' }; })()`;

const ELEMENT_STATE_FN = `function(){ var el=this; var r=el.getBoundingClientRect ? el.getBoundingClientRect() : {left:0,top:0,width:0,height:0}; var g=function(n){ return (el.getAttribute && el.getAttribute(n)) || ''; }; var form = el.closest ? el.closest('form') : null; var search = !!(el.closest && el.closest('[role=search], search')) || !!(form && (form.getAttribute('role') === 'search' || form.querySelector('input[type=search]'))); return { tag: el.tagName || '', type: g('type'), role: g('role'), aria: g('aria-label'), text: (el.innerText || el.textContent || '').slice(0,200), value: typeof el.value === 'string' ? el.value : '', checked: typeof el.checked === 'boolean' ? el.checked : undefined, pressed: g('aria-pressed'), expanded: g('aria-expanded'), selected: g('aria-selected'), open: typeof el.open === 'boolean' ? el.open : undefined, inForm: !!form, inSearchForm: search, contentEditable: !!el.isContentEditable, x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }`;

const ACTIVE_ELEMENT_JS = '(function(){ var el = document.activeElement; if (!el) return null; var form = el.closest ? el.closest("form") : null; return { tag: el.tagName || "", type: (el.getAttribute && el.getAttribute("type")) || "", role: (el.getAttribute && el.getAttribute("role")) || "", name: (((el.getAttribute && el.getAttribute("aria-label")) || el.innerText || el.value || "")).slice(0, 120), inSearchForm: !!(el.closest && el.closest("[role=search], search")) || !!(form && (form.getAttribute("role") === "search" || form.querySelector("input[type=search]"))) }; })()';

function lines(text: string): Set<string> { return new Set(text.split("\n").map((l) => l.trim()).filter(Boolean)); }
/** Up to 3 added and 2 removed visible-text lines: compact evidence of what an action changed. */
function textDiff(before: string, after: string): string {
  const a = lines(before), b = lines(after);
  const added = [...b].filter((l) => !a.has(l)).slice(0, 3).map((l) => "+" + quote(l, 100));
  const removed = [...a].filter((l) => !b.has(l)).slice(0, 2).map((l) => "-" + quote(l, 60));
  return [...added, ...removed].join(" ");
}

export class ControllerImpl implements Controller {
  readonly ownership: Ownership;
  private host: string; private port: number; private loadTimeoutMs: number;
  private client: CdpClient | null = null; private browserName = "";
  private pacer: Pacer;
  private sessions = new Map<string, string>();
  private mainFrames = new Map<string, string>();
  private stores = new Map<string, SnapshotStore>();
  private dialogs = new Map<string, Dialog>();
  private sessionListeners = new Map<string, (() => void)[]>();
  private haltState: BlockState | undefined;

  constructor(opts?: ControllerOptions) {
    this.host = opts?.host ?? "127.0.0.1";
    this.port = opts?.port ?? (process.env.PI_BC_PORT ? Number(process.env.PI_BC_PORT) : 9222);
    this.loadTimeoutMs = opts?.loadTimeoutMs ?? 15000;
    this.ownership = opts?.ownership ?? createOwnership();
    this.pacer = new Pacer(opts?.pacing);
  }

  async connect(): Promise<{ ok: true; browser: string } | ErrorResult> {
    if (this.client?.connected) return { ok: true, browser: this.browserName };
    if (!isLoopbackHost(this.host)) return err("invalid_param", "host must be loopback, got " + this.host);
    // Sessions belong to one websocket connection: after a drop every cached session id is invalid.
    this.resetSessions();
    try {
      const client = new CdpClient({ host: this.host, port: this.port });
      const r = await client.connect();
      this.client = client;
      this.browserName = r.browser;
      client.on("Target.detachedFromTarget", (p) => { for (const [tab, sid] of this.sessions) if (sid === p.sessionId) this.forgetSession(tab); });
      client.on("Target.targetDestroyed", (p) => { const tab = String(p.targetId); this.forgetSession(tab); this.stores.delete(tab); });
      return { ok: true, browser: r.browser };
    } catch (e) {
      this.client = null;
      return err("not_connected", "no browser on " + this.host + ":" + this.port + " (" + (e as Error).message + ")");
    }
  }

  async close(): Promise<void> { await this.client?.close(); this.client = null; this.resetSessions(); }
  halted(): BlockState | undefined { return this.haltState; }
  resume(): void { this.haltState = undefined; }

  private resetSessions(): void { for (const tab of [...this.sessions.keys()]) this.forgetSession(tab); this.dialogs.clear(); }
  private forgetSession(tab: string): void {
    this.sessions.delete(tab);
    this.mainFrames.delete(tab);
    this.dialogs.delete(tab);
    for (const off of this.sessionListeners.get(tab) ?? []) off();
    this.sessionListeners.delete(tab);
  }
  private c(): CdpClient { if (!this.client?.connected) throw new CdpError("not connected"); return this.client; }
  private async targets(): Promise<TargetInfo[]> { const r = await this.c().send("Target.getTargets"); return (r.targetInfos ?? []).filter((t: any) => t.type === "page"); }

  private async session(tab: string): Promise<string> {
    const existing = this.sessions.get(tab);
    if (existing) return existing;
    const c = this.c();
    const r = await c.send("Target.attachToTarget", { targetId: tab, flatten: true });
    const sid = String(r.sessionId);
    this.sessions.set(tab, sid);
    this.sessionListeners.set(tab, [
      c.on("Page.javascriptDialogOpening", (p) => this.dialogs.set(tab, { type: String(p.type ?? "alert"), message: String(p.message ?? "") }), sid),
      c.on("Page.javascriptDialogClosed", () => this.dialogs.delete(tab), sid),
    ]);
    for (const m of ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable"]) { try { await c.send(m, {}, sid); } catch {} }
    try { const ft = await c.send("Page.getFrameTree", {}, sid); this.mainFrames.set(tab, String(ft.frameTree?.frame?.id ?? tab)); } catch { this.mainFrames.set(tab, tab); }
    return sid;
  }

  /** Sends on the tab's session; if the browser dropped that session, re-attaches once (the rejected command never reached the page). */
  private async send(tab: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
    const sid = await this.session(tab);
    try { return await this.c().send(method, params, sid); }
    catch (e) {
      if (!/session with given id not found|no session with given id/i.test((e as Error).message)) throw e;
      this.forgetSession(tab);
      return await this.c().send(method, params, await this.session(tab));
    }
  }

  private async eval(tab: string, expression: string): Promise<any> {
    const r = await this.send(tab, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new CdpError("page evaluate failed: " + (r.exceptionDetails.text ?? ""));
    return r.result?.value;
  }

  private async pageState(tab: string): Promise<PageState> {
    const fallback = async (): Promise<PageState> => { const t = (await this.targets().catch(() => [])).find((x) => x.targetId === tab); return { url: t?.url ?? "", title: t?.title ?? "", text: "", readyState: "unknown", scrollX: 0, scrollY: 0, active: "" }; };
    // A JavaScript dialog blocks script evaluation until it is handled.
    if (this.dialogs.has(tab)) return await fallback();
    try {
      const v = await this.eval(tab, PAGE_STATE_JS);
      return { url: String(v?.url ?? ""), title: String(v?.title ?? ""), text: String(v?.text ?? "") + (v?.pw ? "\npassword" : ""), readyState: String(v?.readyState ?? ""), httpStatus: Number(v?.httpStatus) || undefined, scrollX: Number(v?.scrollX) || 0, scrollY: Number(v?.scrollY) || 0, active: String(v?.active ?? "") };
    } catch { return await fallback(); }
  }

  private async detect(tab: string): Promise<{ facts: PageState; blocked: boolean; reason?: StopResult["reason"] }> { const facts = await this.pageState(tab); const d = detectBlock(facts); return { facts, blocked: d.blocked, reason: d.reason }; }
  private store(tab: string): SnapshotStore { let s = this.stores.get(tab); if (!s) { s = new SnapshotStore(); this.stores.set(tab, s); } return s; }
  private async snapshotText(tab: string): Promise<string> { const r = await this.send(tab, "Accessibility.getFullAXTree", {}); const t = (await this.targets()).find((x) => x.targetId === tab); return buildSnapshot((r.nodes ?? []) as AxNodeLike[], t?.url ?? "", t?.title ?? "", this.store(tab)).text; }
  private async axBackends(tab: string): Promise<Set<number>> { const r = await this.send(tab, "Accessibility.getFullAXTree", {}); return new Set(((r.nodes ?? []) as AxNodeLike[]).map((n) => n.backendDOMNodeId).filter((x): x is number => x != null)); }
  private resolveRef(tab: string, ref: string): RefEntry | ErrorResult { if (!REF_PATTERN.test(ref)) return err("invalid_param", "bad ref: " + ref); const s = this.stores.get(tab); if (!s || !s.issued(ref)) return err("no_such_ref", "ref " + ref + " was never issued for this tab"); const e = s.resolve(ref); if (!e) return err("no_such_ref", "ref " + ref + " was never issued for this tab"); return e; }
  private async liveEntry(tab: string, ref: string): Promise<RefEntry | ErrorResult> { const e = this.resolveRef(tab, ref); if ("code" in e) return e; try { await this.send(tab, "DOM.describeNode", { backendNodeId: e.backendNodeId }); } catch { return err("stale_ref", "ref " + ref + " is gone; take a new snapshot"); } return e; }

  private async callOn(tab: string, e: RefEntry, fn: string, args: unknown[] = []): Promise<any> {
    const rn = await this.send(tab, "DOM.resolveNode", { backendNodeId: e.backendNodeId });
    const oid = rn.object?.objectId;
    if (!oid) throw new CdpError("cannot resolve node for " + e.ref);
    const r = await this.send(tab, "Runtime.callFunctionOn", { objectId: oid, functionDeclaration: fn, arguments: args.map((v) => ({ value: v })), returnByValue: true });
    if (r.exceptionDetails) throw new CdpError("element call failed: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? ""));
    return r.result?.value;
  }
  private async elState(tab: string, e: RefEntry): Promise<ElementState> { return (await this.callOn(tab, e, ELEMENT_STATE_FN)) ?? {}; }
  private async elStateOrNull(tab: string, e: RefEntry): Promise<ElementState | null> { try { return await this.elState(tab, e); } catch { return null; } }

  private async center(tab: string, e: RefEntry, info: ElementState): Promise<{ x: number; y: number }> {
    if (info.w > 0 && info.h > 0) return { x: info.x, y: info.y };
    try { const bm = await this.send(tab, "DOM.getBoxModel", { backendNodeId: e.backendNodeId }); const q: number[] = bm.model?.content ?? []; if (q.length >= 8) return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 }; } catch {}
    return { x: info.x || 0, y: info.y || 0 };
  }
  private async mouse(tab: string, type: string, x: number, y: number): Promise<void> { await this.untilDialog(tab, this.send(tab, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 })); }
  private async key(tab: string, spec: { key: string; code: string; vk: number; text?: string }): Promise<void> {
    if ((await this.untilDialog(tab, this.send(tab, "Input.dispatchKeyEvent", { type: "keyDown", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, ...(spec.text ? { text: spec.text } : {}) }))) === "dialog") return;
    await this.untilDialog(tab, this.send(tab, "Input.dispatchKeyEvent", { type: "keyUp", key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk }));
  }
  /**
   * Input dispatch only completes once the page handled the event; a handler that opens alert/confirm
   * blocks it until the dialog is closed. Stop waiting as soon as a dialog appears (the dispatch then
   * completes in the background once the dialog is handled).
   */
  private async untilDialog(tab: string, dispatch: Promise<unknown>): Promise<"done" | "dialog"> {
    dispatch.catch(() => undefined);
    let timer: ReturnType<typeof setInterval> | undefined;
    const dialog = new Promise<"dialog">((resolve) => { timer = setInterval(() => { if (this.dialogs.has(tab)) resolve("dialog"); }, 20); });
    try { return await Promise.race([dispatch.then(() => "done" as const), dialog]); }
    finally { clearInterval(timer); }
  }

  /** Records main-frame navigation events on the tab's session from now until dispose(). */
  private async watchNavigation(tab: string): Promise<NavWatch> {
    const sid = await this.session(tab);
    const main = this.mainFrames.get(tab) ?? tab;
    const c = this.c();
    const offs: (() => void)[] = [];
    const w: NavWatch = { started: false, committed: false, stopped: false, loaded: false, sameDocument: false, dispose: () => offs.forEach((off) => off()) };
    offs.push(
      c.on("Page.frameStartedLoading", (p) => { if (p.frameId === main) { w.started = true; w.stopped = false; } }, sid),
      c.on("Page.frameRequestedNavigation", (p) => { if (p.frameId === main) w.started = true; }, sid),
      c.on("Page.frameNavigated", (p) => { if (p.frame?.id === main) { w.committed = true; w.url = p.frame.url; } }, sid),
      c.on("Page.navigatedWithinDocument", (p) => { if (p.frameId === main) { w.sameDocument = true; w.url = p.url; } }, sid),
      c.on("Page.frameStoppedLoading", (p) => { if (p.frameId === main) w.stopped = true; }, sid),
      c.on("Page.loadEventFired", () => { w.loaded = true; }, sid),
    );
    return w;
  }

  private async waitUntil(cond: () => boolean, timeoutMs: number, signal?: AbortSignal, step = 50): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (!cond()) {
      if (signal?.aborted || Date.now() >= end) return cond();
      await sleepMs(step, signal);
    }
    return true;
  }

  /** After input: give the page a moment to start a navigation; if it did, wait for it to finish loading. */
  private async settle(tab: string, w: NavWatch, signal: AbortSignal | undefined, progress: Progress): Promise<void> {
    await this.waitUntil(() => w.started || w.committed || w.sameDocument || this.dialogs.has(tab), 400, signal, 25);
    if (this.dialogs.has(tab)) return;
    if (w.started || w.committed) {
      progress({ kind: "progress", message: "waiting for the navigation to finish loading" });
      await this.waitUntil(() => w.stopped || w.loaded || this.dialogs.has(tab), this.loadTimeoutMs, signal);
      await this.waitReadyComplete(tab, 2000, signal);
    } else {
      await sleepMs(120, signal); // synchronous handlers and the next frame
    }
  }

  private async waitReadyComplete(tab: string, ms: number, signal?: AbortSignal): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end && !signal?.aborted && !this.dialogs.has(tab)) {
      try { if ((await this.eval(tab, "document.readyState")) === "complete") return; } catch { return; }
      await sleepMs(100, signal);
    }
  }

  private async navigateAndWait(tab: string, url: string, signal: AbortSignal | undefined, progress: Progress): Promise<{ ok: true; state: PageState } | ErrorResult> {
    const w = await this.watchNavigation(tab);
    try {
      progress({ kind: "progress", message: "loading " + url });
      const r = await this.send(tab, "Page.navigate", { url });
      if (r.errorText) return err("navigation_failed", "could not load " + url + ": " + r.errorText);
      if (r.loaderId) {
        const done = await this.waitUntil(() => w.stopped || w.loaded || this.dialogs.has(tab), this.loadTimeoutMs, signal);
        if (signal?.aborted) return err("aborted", "aborted while loading " + url);
        if (!done) progress({ kind: "progress", message: "page still loading after " + this.loadTimeoutMs + "ms; continuing with the partial page" });
        await this.waitReadyComplete(tab, 2000, signal);
      }
      return { ok: true, state: await this.pageState(tab) };
    } finally { w.dispose(); }
  }

  private navigationEvidence(state: PageState, requested?: string): Verification {
    const status = state.httpStatus;
    const errorPage = (status != null && status >= 400) || state.url.startsWith("chrome-error://");
    const evidence = (errorPage ? "error page: " : "") + "at " + state.url + (status ? " (HTTP " + status + ")" : "") + (state.title ? " title " + quote(state.title) : "") + (state.readyState && state.readyState !== "complete" ? " readyState=" + state.readyState : "");
    return { verified: !errorPage && (!requested || requested === "about:blank" || state.url !== "about:blank"), evidence, url: state.url, title: state.title, navigated: true, ...(status ? { httpStatus: status } : {}) };
  }

  private async checkTab(agent: string, tab: string): Promise<TargetInfo | ErrorResult> { const t = (await this.targets()).find((x) => x.targetId === tab); if (!t) return err("no_such_tab", "no such tab: " + tab); if (!this.ownership.owns(agent, tab)) return err("not_owned", "tab " + tab + " is not owned by agent " + agent); return t; }

  private validate(tool: ToolName, p: any): ErrorResult | null {
    if (tool === "tabs_list") return null;
    if (tool === "tab_open") return p?.url == null || validUrl(p.url) ? null : err("invalid_param", "tab_open url must be http(s) or about:blank");
    if (!p || typeof p.tab !== "string" || !p.tab) return err("invalid_param", tool + " requires a tab id");
    switch (tool) {
      case "navigate": return validUrl(p.url) ? null : err("invalid_param", "navigate url must be http(s) or about:blank");
      case "click": return typeof p.ref === "string" && !!p.ref ? null : err("invalid_param", "click requires a ref");
      case "type": return typeof p.ref === "string" && !!p.ref && typeof p.text === "string" ? null : err("invalid_param", "type requires a ref and text");
      case "press": return typeof p.key === "string" && !!p.key ? null : err("invalid_param", "press requires a key");
      case "select": return typeof p.ref === "string" && !!p.ref && typeof p.value === "string" ? null : err("invalid_param", "select requires a ref and value");
      case "scroll": return ["up", "down", "left", "right"].includes(p.direction) && (p.amount == null || (typeof p.amount === "number" && p.amount >= 0)) ? null : err("invalid_param", "scroll requires direction up|down|left|right");
      case "upload": return typeof p.ref === "string" && !!p.ref && typeof p.file === "string" && isAbsolute(p.file) && existsSync(p.file) ? null : err("invalid_param", "upload requires a ref and an absolute path of an existing file");
      case "wait_for": return p.text != null || p.ref != null ? null : err("invalid_param", "wait_for requires text or ref");
      default: return null;
    }
  }

  private dialogError(tab: string): ErrorResult | null {
    const d = this.dialogs.get(tab);
    return d ? err("dialog_open", "a JavaScript " + d.type + " is open on tab " + tab + ": " + quote(d.message, 200) + " - press Enter to accept or Escape to dismiss it first") : null;
  }

  async call<T extends ToolName>(agent: string, tool: T, params: ToolParams[T], opts?: CallOptions): Promise<ActionResult> {
    const p: any = params ?? {};
    const signal = opts?.signal;
    const progress: Progress = (e) => { try { opts?.onProgress?.(e); } catch {} };
    const aborted = () => err("aborted", tool + " was not performed: the operation was aborted");
    try {
      if (signal?.aborted) return aborted();
      const v = this.validate(tool, p); if (v) return v;
      const conn = await this.connect(); if ((conn as ErrorResult).code) return conn as ErrorResult;
      if (tool === "tabs_list") {
        const ts = await this.targets();
        const owned = ts.filter((t) => this.ownership.owns(agent, t.targetId));
        return ok(owned.length ? owned.map((t) => t.targetId + " " + t.url + " " + t.title).join("\n") : "no owned tabs", { tabs: owned.map((t) => t.targetId) });
      }
      if (tool === "tab_open") return await this.openTab(agent, p.url ?? "about:blank", signal, progress);
      const chk = await this.checkTab(agent, String(p.tab)); if ("code" in chk) return chk as ErrorResult;
      const tab = String(p.tab);
      if (tool === "tab_close") {
        await this.c().send("Target.closeTarget", { targetId: tab });
        this.ownership.release(tab); this.forgetSession(tab); this.stores.delete(tab);
        if (this.haltState?.tab === tab) this.haltState = undefined;
        return ok("closed tab " + tab, { tab });
      }
      if ((OBSERVATION_TOOLS as readonly string[]).includes(tool)) return await this.observe(tab, tool, chk, progress);
      // An open dialog must be handled first; press Enter/Escape handles it.
      if (!(tool === "press" && this.dialogs.has(tab))) { const de = this.dialogError(tab); if (de) return de; }
      if (this.haltState) {
        const ht = this.haltState;
        const exists = (await this.targets()).some((x) => x.targetId === ht.tab);
        if (exists) { const d = await this.detect(ht.tab); if (d.blocked && d.reason) { this.haltState = { tab: ht.tab, url: d.facts.url, reason: d.reason }; return stopRes(ht.tab, d.facts.url, d.reason); } }
        this.haltState = undefined;
      }
      const pre = await this.detect(tab);
      if (pre.blocked && pre.reason) { this.haltState = { tab, url: pre.facts.url, reason: pre.reason }; return stopRes(tab, pre.facts.url, pre.reason); }
      if (signal?.aborted) return aborted();
      const target = p.ref ?? p.url ?? p.key ?? p.direction;
      progress({ kind: "computer.action", action: tool, status: "started", target });
      // Checked again inside the mutex: an action queued behind another never runs after abort.
      const res = await this.pacer.run(async () => (signal?.aborted ? aborted() : await this.perform(tab, tool, p, pre.facts, signal, progress)));
      if (!res.ok) { progress({ kind: "computer.action", action: tool, status: "failed", target, detail: "code" in res ? res.code : "stop" }); return res; }
      progress({ kind: "computer.action", action: tool, status: "completed", target });
      if (res.verification) progress({ kind: "computer.observation", url: res.verification.url, title: res.verification.title, navigated: res.verification.navigated, verified: res.verification.verified, evidence: res.verification.evidence });
      const post = this.dialogs.has(tab) ? null : await this.detect(tab).catch(() => null);
      if (post?.blocked && post.reason) { this.haltState = { tab, url: post.facts.url, reason: post.reason }; return stopRes(tab, post.facts.url, post.reason); }
      return res;
    } catch (e) {
      if (signal?.aborted) return aborted();
      const m = (e as Error).message ?? String(e);
      return /not connected|websocket closed/.test(m) ? err("not_connected", m) : err("cdp_error", m);
    }
  }

  private async openTab(agent: string, url: string, signal: AbortSignal | undefined, progress: Progress): Promise<ActionResult> {
    progress({ kind: "computer.action", action: "tab_open", status: "started", target: url });
    // Open blank, then navigate: Page.navigate reports load failures that Target.createTarget does not.
    const r = await this.c().send("Target.createTarget", { url: "about:blank" });
    const tab = String(r.targetId);
    this.ownership.register(agent, tab);
    await this.session(tab);
    let state: PageState;
    if (url === "about:blank") state = await this.pageState(tab);
    else {
      const nav = await this.navigateAndWait(tab, url, signal, progress);
      if (!nav.ok) { progress({ kind: "computer.action", action: "tab_open", status: "failed", target: url, detail: nav.code }); return err(nav.code, "opened tab " + tab + " but " + nav.message); }
      state = nav.state;
    }
    const verification = this.navigationEvidence(state, url);
    progress({ kind: "computer.action", action: "tab_open", status: "completed", target: tab });
    progress({ kind: "computer.observation", url: state.url, title: state.title, navigated: true, verified: verification.verified, evidence: verification.evidence });
    const d = detectBlock(state);
    if (d.blocked && d.reason) { this.haltState = { tab, url: state.url, reason: d.reason }; return stopRes(tab, state.url, d.reason); }
    return ok("opened tab " + tab + " " + (verification.verified ? "" : "(NOT verified) ") + verification.evidence, { tab, url: state.url, title: state.title }, verification);
  }

  private async observe(tab: string, tool: ToolName, chk: TargetInfo, progress: Progress): Promise<ActionResult> {
    const dialog = this.dialogs.get(tab);
    if (tool === "snapshot") {
      if (dialog) return ok("# " + chk.url + " " + chk.title + "\nDIALOG " + dialog.type + " " + quote(dialog.message, 300) + " - press Enter to accept or Escape to dismiss", { tab, url: chk.url, dialog });
      const text = await this.snapshotText(tab);
      const d = await this.detect(tab);
      progress({ kind: "computer.observation", url: d.facts.url, title: d.facts.title, evidence: "accessibility snapshot, " + text.split("\n").length + " lines" });
      if (d.blocked && d.reason) { this.haltState = { tab, url: d.facts.url, reason: d.reason }; return ok("BLOCKED: " + d.reason + "\n" + text, { tab, url: d.facts.url }); }
      return ok(text, { tab, url: d.facts.url || chk.url, title: d.facts.title || chk.title, ...(d.facts.httpStatus ? { httpStatus: d.facts.httpStatus } : {}) });
    }
    if (dialog) return this.dialogError(tab) as ErrorResult;
    const shot = await this.send(tab, "Page.captureScreenshot", { format: "png" });
    progress({ kind: "computer.observation", url: chk.url, title: chk.title, evidence: "screenshot captured" });
    return { ok: true, text: "screenshot of tab " + tab + " at " + chk.url, image: { mimeType: "image/png", data: String(shot.data ?? "") }, data: { tab, url: chk.url, title: chk.title } };
  }

  private async afterInput(tab: string, pre: PageState, w: NavWatch, signal: AbortSignal | undefined, progress: Progress): Promise<{ state: PageState; nav?: Verification; diff: string }> {
    await this.settle(tab, w, signal, progress);
    const state = await this.pageState(tab);
    const navigated = (w.committed && !w.sameDocument) || state.url !== pre.url;
    return { state, nav: navigated ? this.navigationEvidence(state) : undefined, diff: navigated ? "" : textDiff(pre.text, state.text) };
  }

  private dialogOpened(tab: string, what: string): OkResult {
    const d = this.dialogs.get(tab)!;
    return ok(what + "; it opened a JavaScript " + d.type + ": " + quote(d.message, 200) + " - press Enter to accept or Escape to dismiss", { tab, dialog: d }, { verified: true, evidence: d.type + " dialog opened", navigated: false });
  }

  private async perform(tab: string, tool: ToolName, p: any, pre: PageState, signal: AbortSignal | undefined, progress: Progress): Promise<ActionResult> {
    switch (tool) {
      case "navigate": {
        const nav = await this.navigateAndWait(tab, p.url, signal, progress);
        if (!nav.ok) return nav;
        const v = this.navigationEvidence(nav.state, p.url);
        return ok((v.verified ? "navigated tab " + tab + " " : "navigation of tab " + tab + " reached an error page (NOT verified): ") + v.evidence, { tab, url: nav.state.url, title: nav.state.title }, v);
      }
      case "click": {
        const e = await this.liveEntry(tab, p.ref); if ("code" in e) return e;
        const info = await this.elState(tab, e);
        if (isSubmitLike({ role: e.role || info.role || "", name: e.name || info.aria || info.text || "", inputType: info.type || undefined, inForm: !!info.inForm, inSearchForm: !!info.inSearchForm }) && !p.user_confirmed) return err("confirm_required", "click target looks like a submit/payment action; ask the user and retry with user_confirmed");
        try { await this.send(tab, "DOM.scrollIntoViewIfNeeded", { backendNodeId: e.backendNodeId }); } catch {}
        const before = await this.elState(tab, e);
        const c = await this.center(tab, e, before);
        const label = (e.role || "element") + (e.name ? " " + quote(e.name, 60) : "");
        const w = await this.watchNavigation(tab);
        try {
          await this.mouse(tab, "mouseMoved", c.x, c.y);
          await this.mouse(tab, "mousePressed", c.x, c.y);
          await this.mouse(tab, "mouseReleased", c.x, c.y);
          await sleepMs(30, signal);
          if (this.dialogs.has(tab)) return this.dialogOpened(tab, "clicked " + p.ref + " (" + label + ")");
          const after = await this.afterInput(tab, pre, w, signal, progress);
          if (this.dialogs.has(tab)) return this.dialogOpened(tab, "clicked " + p.ref + " (" + label + ")");
          const elAfter = after.nav ? null : await this.elStateOrNull(tab, e);
          const stateChange = elAfter ? (["checked", "pressed", "expanded", "selected", "open", "value"] as const).filter((k) => String(before[k] ?? "") !== String(elAfter[k] ?? "")).map((k) => k + " " + String(before[k] ?? "") + "→" + String(elAfter[k] ?? "")).join(", ") : "";
          const at = { url: after.state.url, title: after.state.title, navigated: false };
          const v: Verification = after.nav ? after.nav
            : stateChange ? { verified: true, evidence: label + " " + stateChange, ...at }
              : after.diff ? { verified: true, evidence: "page changed: " + after.diff, ...at }
                // Focus alone proves something only for fields: every clicked button takes focus.
                : after.state.active && after.state.active !== pre.active && /^(INPUT|TEXTAREA|SELECT)#/.test(after.state.active) ? { verified: true, evidence: "focus moved to " + after.state.active, ...at }
                  : { verified: false, evidence: "no observable change (URL, visible text and element state are the same" + (after.state.active !== pre.active ? "; only focus moved" : "") + "); the click may have missed or the effect may be delayed - snapshot or wait_for before assuming success", ...at };
          return ok("clicked " + p.ref + " (" + label + ") on tab " + tab + " -> " + (v.verified ? "" : "NOT verified: ") + v.evidence, { tab, url: after.state.url, title: after.state.title }, v);
        } finally { w.dispose(); }
      }
      case "type": {
        const e = await this.liveEntry(tab, p.ref); if ("code" in e) return e;
        const info = await this.elState(tab, e);
        if (String(info.type ?? "").toLowerCase() === "password") return err("password_field", "refusing to type into a password field");
        try { await this.send(tab, "DOM.scrollIntoViewIfNeeded", { backendNodeId: e.backendNodeId }); } catch {}
        // Focus and select the existing content so insertText replaces it, or put the caret at the end to append.
        await this.callOn(tab, e, "function(append){ this.focus(); var tag = this.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA') { if (append) { try { var n = this.value.length; this.setSelectionRange(n, n); } catch (x) {} } else if (typeof this.select === 'function') this.select(); } else if (this.isContentEditable) { var r = document.createRange(); r.selectNodeContents(this); if (append) r.collapse(false); var s = getSelection(); s.removeAllRanges(); s.addRange(r); } }", [!!p.append]);
        const expected = p.append ? info.value + p.text : p.text;
        if (p.text === "") { if (!p.append) await this.key(tab, KEYMAP.Delete); }
        else await this.send(tab, "Input.insertText", { text: p.text });
        await sleepMs(50, signal);
        const after = await this.elStateOrNull(tab, e);
        const actual = after ? (after.contentEditable ? after.text : after.value) : "";
        const verified = !!after && (after.contentEditable ? actual.includes(p.text) : actual === expected);
        const v: Verification = { verified, evidence: verified ? "field now contains " + quote(actual, 120) : "field contains " + quote(actual, 120) + " but " + quote(expected, 120) + " was expected", url: pre.url, title: pre.title, navigated: false };
        return ok((verified ? "typed into " : "typed into (NOT verified) ") + p.ref + " on tab " + tab + ": " + v.evidence, { tab }, v);
      }
      case "press": {
        const dialog = this.dialogs.get(tab);
        if (dialog) {
          if (p.key !== "Enter" && p.key !== "Escape" && p.key !== "Esc") return this.dialogError(tab)!;
          const accept = p.key === "Enter";
          await this.send(tab, "Page.handleJavaScriptDialog", { accept });
          this.dialogs.delete(tab);
          await sleepMs(100, signal);
          const st = await this.pageState(tab);
          return ok((accept ? "accepted" : "dismissed") + " the " + dialog.type + " " + quote(dialog.message, 120) + " on tab " + tab + "; page at " + st.url, { tab, url: st.url }, { verified: !this.dialogs.has(tab), evidence: "dialog " + (accept ? "accepted" : "dismissed") + "; page text now " + quote(st.text.split("\n").filter(Boolean).slice(-2).join(" / "), 120), url: st.url, title: st.title, navigated: false });
        }
        if (p.key === "Enter" && !p.user_confirmed) {
          const a = await this.eval(tab, ACTIVE_ELEMENT_JS).catch(() => null);
          if (a && isSubmitLike({ role: a.role || a.tag || "", name: a.name || "", inputType: a.type || undefined, inSearchForm: !!a.inSearchForm })) return err("confirm_required", "Enter on a submit-like element needs user_confirmed");
        }
        const spec = KEYMAP[p.key] ?? (p.key.length === 1 ? { key: p.key, code: /[a-zA-Z]/.test(p.key) ? "Key" + p.key.toUpperCase() : /[0-9]/.test(p.key) ? "Digit" + p.key : "", vk: p.key.toUpperCase().charCodeAt(0), text: p.key } : { key: p.key, code: p.key, vk: 0 });
        const w = await this.watchNavigation(tab);
        try {
          await this.key(tab, spec);
          await sleepMs(30, signal);
          if (this.dialogs.has(tab)) return this.dialogOpened(tab, "pressed " + p.key);
          const after = await this.afterInput(tab, pre, w, signal, progress);
          if (this.dialogs.has(tab)) return this.dialogOpened(tab, "pressed " + p.key);
          const at = { url: after.state.url, title: after.state.title, navigated: false };
          const v: Verification = after.nav ?? (after.diff ? { verified: true, evidence: "page changed: " + after.diff, ...at }
            : after.state.active !== pre.active ? { verified: true, evidence: "focus moved to " + (after.state.active || "the page"), ...at }
              : { verified: false, evidence: "no observable change after the key press", ...at });
          return ok("pressed " + p.key + " on tab " + tab + " -> " + (v.verified ? "" : "NOT verified: ") + v.evidence, { tab, url: after.state.url }, v);
        } finally { w.dispose(); }
      }
      case "select": {
        const e = await this.liveEntry(tab, p.ref); if ("code" in e) return e;
        const info = await this.elState(tab, e);
        if (String(info.tag ?? "").toUpperCase() !== "SELECT") return err("invalid_param", "select target " + p.ref + " is not a select element");
        const done = await this.callOn(tab, e, 'function(v){ var opts = Array.prototype.slice.call(this.options || []); var o = opts.find(function(x){ return x.value === v || (x.text || "").trim() === v || (x.label || "").trim() === v; }); if (!o) return null; this.value = o.value; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return { value: this.value, label: (this.options[this.selectedIndex] || {}).text || "", wanted: o.value }; }', [p.value]);
        if (!done) return err("invalid_param", "no option with value or label: " + p.value);
        const v: Verification = { verified: done.value === done.wanted, evidence: "selected value " + quote(done.value) + " (" + quote(done.label) + ")", url: pre.url, title: pre.title, navigated: false };
        return ok("selected " + p.value + " in " + p.ref + " on tab " + tab + ": " + v.evidence, { tab }, v);
      }
      case "scroll": {
        let x = 0, y = 0;
        let entry: RefEntry | undefined;
        if (p.ref) { const e = await this.liveEntry(tab, p.ref); if ("code" in e) return e; entry = e; const c = await this.center(tab, e, await this.elState(tab, e)); x = c.x; y = c.y; }
        else { const vp = await this.eval(tab, "({ x: window.innerWidth / 2, y: window.innerHeight / 2 })"); x = vp?.x ?? 0; y = vp?.y ?? 0; }
        const positions = async (): Promise<number[]> => {
          const win: number[] = await this.eval(tab, "[window.scrollX, window.scrollY]").catch(() => [0, 0]);
          const el: number[] = entry ? await this.callOn(tab, entry, "function(){ var n = this; while (n && n !== document.documentElement) { if (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) return [n.scrollLeft, n.scrollTop]; n = n.parentElement; } return [0, 0]; }").catch(() => [0, 0]) : [0, 0];
          return [...win, ...el];
        };
        const before = await positions();
        const amt = typeof p.amount === "number" ? p.amount : 600;
        const dx = p.direction === "left" ? -amt : p.direction === "right" ? amt : 0;
        const dy = p.direction === "up" ? -amt : p.direction === "down" ? amt : 0;
        await this.send(tab, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
        await sleepMs(250, signal);
        const after = await positions();
        const moved = after.some((n, i) => Math.abs(n - before[i]) >= 1);
        const v: Verification = { verified: moved, evidence: moved ? "scroll position " + before.join(",") + " -> " + after.join(",") : "scroll position unchanged (" + after.join(",") + "): already at the edge or nothing scrollable under the pointer", url: pre.url, title: pre.title, navigated: false };
        return ok("scrolled " + p.direction + " " + amt + "px on tab " + tab + ": " + v.evidence, { tab }, v);
      }
      case "upload": {
        const e = await this.liveEntry(tab, p.ref); if ("code" in e) return e;
        await this.send(tab, "DOM.setFileInputFiles", { files: [p.file], backendNodeId: e.backendNodeId });
        const files: string[] = await this.callOn(tab, e, "function(){ return Array.prototype.map.call(this.files || [], function(f){ return f.name; }); }").catch(() => []);
        const v: Verification = { verified: files.includes(basename(p.file)), evidence: "file input holds " + JSON.stringify(files), url: pre.url, title: pre.title, navigated: false };
        return ok("uploaded " + p.file + " to " + p.ref + " on tab " + tab + ": " + v.evidence, { tab }, v);
      }
      case "wait_for": {
        const timeout = Math.min(30000, Math.max(500, typeof p.timeout_ms === "number" ? p.timeout_ms : 10000));
        let entry: RefEntry | undefined;
        if (p.ref) { const r0 = this.resolveRef(tab, p.ref); if ("code" in r0) return r0; entry = r0; }
        const start = Date.now(), end = start + timeout;
        let lastReport = start;
        const what = (p.text != null ? quote(String(p.text)) : String(p.ref)) + (p.gone ? " to disappear" : "");
        for (;;) {
          if (signal?.aborted) return err("aborted", "wait_for aborted after " + (Date.now() - start) + "ms");
          const conds: boolean[] = [];
          let st: PageState | undefined;
          if (p.text != null) { st = await this.pageState(tab); conds.push(st.text.includes(String(p.text)) || st.title.includes(String(p.text))); }
          if (entry) { const set = await this.axBackends(tab); conds.push(set.has(entry.backendNodeId)); }
          const present = conds.length > 0 && conds.every(Boolean);
          if (p.gone ? !present : present) {
            const evidence = (p.text != null ? quote(String(p.text)) : String(p.ref)) + (p.gone ? " is gone" : " is present") + " after " + (Date.now() - start) + "ms";
            return ok("wait_for satisfied on tab " + tab + ": " + evidence, { tab }, { verified: true, evidence, url: st?.url, title: st?.title, navigated: false });
          }
          if (Date.now() >= end) return err("timeout", "wait_for timed out after " + timeout + "ms on tab " + tab + " waiting for " + what + (st ? " (page " + st.url + ")" : ""));
          if (Date.now() - lastReport >= 2000) { lastReport = Date.now(); progress({ kind: "progress", message: "still waiting for " + what + " (" + Math.round((Date.now() - start) / 1000) + "s of " + Math.round(timeout / 1000) + "s)", progress: (Date.now() - start) / timeout }); }
          await sleepMs(250, signal);
        }
      }
      default: return err("invalid_param", "unsupported action tool: " + tool);
    }
  }
}
export function createController(opts?: ControllerOptions): Controller { return new ControllerImpl(opts); }
