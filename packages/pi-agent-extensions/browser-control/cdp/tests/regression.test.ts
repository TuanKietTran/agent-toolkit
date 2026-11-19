// Regression tests for failures reproduced against the original controller. Each test names the
// failure-matrix id it guards (see reports/failure-matrix.md). Real headless browser, local fixtures.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:net";
import { createController } from "../controller.ts";
import { FAST_PACING, type ActionResult, type Controller, type ControllerProgress, type OkResult } from "../contract.ts";
import { startFixtureServer, type FixtureServer } from "../fixture/server.ts";
import { resolveTestBrowser, startTestBrowser, type TestBrowser } from "./browser-harness.ts";

const hasBrowser = !!resolveTestBrowser();
let fx: FixtureServer, br: TestBrowser, ctl: Controller;
const A = "regression";
const call = (tool: any, params: any, opts?: any): Promise<any> => ctl.call(A, tool, params, opts);
const okr = (r: ActionResult): OkResult => { assert.equal(r.ok, true, JSON.stringify(r)); return r as OkResult; };
function refIn(snapshot: string, name: string, role?: string): string {
  for (const line of snapshot.split("\n")) {
    if (!line.includes(`"${name}"`) || (role && !line.includes(`] ${role} "`))) continue;
    const m = line.match(/\[(e\d+)\]/); if (m) return m[1];
  }
  throw new Error(`no ref for "${name}"\n${snapshot}`);
}
async function open(path: string): Promise<{ tab: string; snap: string }> {
  const r = okr(await call("tab_open", { url: fx.origin + path }));
  const tab = r.data!.tab as string;
  return { tab, snap: okr(await call("snapshot", { tab })).text };
}
async function closedPort(): Promise<number> {
  return await new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const a = s.address(); const p = typeof a === "object" && a ? a.port : 0; s.close(() => resolve(p)); }); });
}
function t(name: string, fn: () => Promise<void>) { test(name, { skip: hasBrowser ? false : "no Chromium-family browser" }, fn); }

before(async () => {
  if (!hasBrowser) return;
  fx = await startFixtureServer();
  br = await startTestBrowser();
  ctl = createController({ port: br.port, pacing: { ...FAST_PACING } });
});
after(async () => { await ctl?.close(); await br?.close(); await fx?.close(); });

t("F1: navigate to an unreachable URL fails with navigation_failed instead of claiming success", async () => {
  const { tab } = await open("/site.html");
  const port = await closedPort();
  const r = await call("navigate", { tab, url: `http://127.0.0.1:${port}/` });
  assert.equal(r.ok, false);
  assert.equal(r.code, "navigation_failed");
  assert.match(r.message, /ERR_CONNECTION_REFUSED/);
});

t("F2/F13: tab_open and navigate return only after the slow page loaded, with evidence", async () => {
  const t0 = Date.now();
  const r = okr(await call("tab_open", { url: fx.origin + "/docs.html?delay=1200" }));
  assert.ok(Date.now() - t0 >= 1100, "tab_open waited for the response");
  assert.equal(r.verification?.verified, true);
  assert.equal(r.verification?.httpStatus, 200);
  assert.equal(r.data?.title, "Acme Documentation");
  const n = okr(await call("navigate", { tab: r.data!.tab, url: fx.origin + "/site.html?delay=800" }));
  assert.equal(n.data?.title, "Acme Test Site");
});

t("F14: an HTTP 404 page is reported as NOT verified", async () => {
  const { tab } = await open("/site.html");
  const r = okr(await call("navigate", { tab, url: fx.origin + "/missing-page.html" }));
  assert.equal(r.verification?.verified, false);
  assert.equal(r.verification?.httpStatus, 404);
  assert.match(r.text, /NOT verified/);
});

t("F4: type replaces pre-filled content and verifies the resulting value; append=true appends", async () => {
  const { tab, snap } = await open("/contact.html");
  const name = refIn(snap, "Full name", "textbox");
  const r = okr(await call("type", { tab, ref: name, text: "Ada Lovelace" }));
  assert.equal(r.verification?.verified, true);
  assert.match(r.text, /"Ada Lovelace"/);
  const a = okr(await call("type", { tab, ref: name, text: " Byron", append: true }));
  assert.equal(a.verification?.verified, true);
  assert.match(a.text, /"Ada Lovelace Byron"/);
  const snap2 = okr(await call("snapshot", { tab })).text;
  assert.match(snap2, /textbox "Full name" value="Ada Lovelace Byron"/);
});

t("F3: click on a link that navigates (slow) reports the destination it waited for", async () => {
  const { tab, snap } = await open("/site.html");
  const r = okr(await call("click", { tab, ref: refIn(snap, "Slow documentation") }));
  assert.equal(r.verification?.navigated, true);
  assert.equal(r.verification?.verified, true);
  assert.equal(r.data?.title, "Acme Documentation");
});

t("F-verify: a click with no observable effect is reported as NOT verified; a real effect is verified", async () => {
  const page = await open("/dynamic.html");
  const noop = okr(await call("click", { tab: page.tab, ref: refIn(page.snap, "Do nothing") }));
  assert.equal(noop.verification?.verified, false, noop.text);
  assert.match(noop.text, /NOT verified/);
  const toggle = okr(await call("click", { tab: page.tab, ref: refIn(page.snap, "Show details") }));
  assert.equal(toggle.verification?.verified, true, toggle.text);
  assert.match(toggle.verification!.evidence, /pressed false→true/);
});

t("F-verify: dynamic update shows the immediate change and wait_for confirms the async result", async () => {
  const { tab, snap } = await open("/dynamic.html");
  const c = okr(await call("click", { tab, ref: refIn(snap, "Refresh status") }));
  assert.match(c.verification!.evidence, /Loading/);
  const progress: ControllerProgress[] = [];
  const w = okr(await call("wait_for", { tab, text: "All systems operational", timeout_ms: 5000 }, { onProgress: (e: ControllerProgress) => progress.push(e) }));
  assert.equal(w.verification?.verified, true);
});

t("F-guard: a search form submits without confirmation; consequential submits still need it", async () => {
  const s = await open("/search.html");
  okr(await call("type", { tab: s.tab, ref: refIn(s.snap, "Search the catalog"), text: "rocket" }));
  const go = okr(await call("click", { tab: s.tab, ref: refIn(s.snap, "Search", "button") }));
  assert.match(String(go.data?.url), /q=rocket/);
  const f = await open("/page.html");
  const r = await call("click", { tab: f.tab, ref: refIn(f.snap, "Place order") });
  assert.equal(r.code, "confirm_required");
});

t("F7: after the CDP websocket drops, calls on existing tabs reconnect instead of failing forever", async () => {
  const { tab } = await open("/site.html");
  await (ctl as any).client.close();
  const s = await call("snapshot", { tab });
  assert.equal(s.ok, true, JSON.stringify(s));
  const n = okr(await call("navigate", { tab, url: fx.origin + "/docs.html" }));
  assert.equal(n.verification?.verified, true);
});

t("F6: a pre-aborted signal performs nothing; abort interrupts wait_for promptly", async () => {
  const { tab, snap } = await open("/page.html");
  const ac = new AbortController(); ac.abort();
  const r = await call("click", { tab, ref: refIn(snap, "Ping") }, { signal: ac.signal });
  assert.equal(r.code, "aborted");
  const out = okr(await call("snapshot", { tab })).text;
  assert.ok(out.includes('"idle"'), "Ping was not clicked");
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 300);
  const t0 = Date.now();
  const w = await call("wait_for", { tab, text: "never appears", timeout_ms: 10000 }, { signal: ac2.signal });
  assert.equal(w.code, "aborted");
  assert.ok(Date.now() - t0 < 1500, `wait_for stopped after ${Date.now() - t0}ms`);
});

t("F6b: an action queued behind a running one does not run once aborted", async () => {
  const { tab, snap } = await open("/page.html");
  const ping = refIn(snap, "Ping");
  const ac = new AbortController();
  const waiting = call("wait_for", { tab, text: "never appears", timeout_ms: 1500 });
  const queued = call("click", { tab, ref: ping }, { signal: ac.signal });
  ac.abort();
  const [, q] = await Promise.all([waiting, queued]);
  assert.equal(q.code, "aborted");
  assert.ok(okr(await call("snapshot", { tab })).text.includes('"idle"'));
});

t("F-dialog: a JavaScript confirm is reported, blocks other actions, and is handled with press", async () => {
  const { tab, snap } = await open("/dialog.html");
  const c = okr(await call("click", { tab, ref: refIn(snap, "Remove draft") }));
  assert.match(c.text, /confirm/);
  const blocked = await call("click", { tab, ref: refIn(snap, "Notify me") });
  assert.equal(blocked.code, "dialog_open");
  const s = okr(await call("snapshot", { tab }));
  assert.match(s.text, /DIALOG confirm "Remove the draft\?"/);
  const d = okr(await call("press", { tab, key: "Escape" }));
  assert.match(d.text, /dismissed/);
  const after = okr(await call("snapshot", { tab })).text;
  assert.ok(after.includes("Draft kept (cancelled)"), after);
  const cb = okr(await call("click", { tab, ref: refIn(after, "Notify me") }));
  assert.match(cb.verification!.evidence, /checked false→true/);
});

t("F-scroll: scroll reports movement, and reports no movement at the edge", async () => {
  const { tab } = await open("/page.html");
  const down = okr(await call("scroll", { tab, direction: "down", amount: 400 }));
  assert.equal(down.verification?.verified, true, down.text);
  const up = okr(await call("scroll", { tab, direction: "up", amount: 5000 }));
  assert.equal(up.verification?.verified, true);
  const again = okr(await call("scroll", { tab, direction: "up", amount: 100 }));
  assert.equal(again.verification?.verified, false, "already at the top");
});

t("F-progress: actions emit started/completed computer events and an observation with the verification", async () => {
  const { tab, snap } = await open("/page.html");
  const events: ControllerProgress[] = [];
  okr(await call("click", { tab, ref: refIn(snap, "Ping") }, { onProgress: (e: ControllerProgress) => events.push(e) }));
  const kinds = events.map((e) => e.kind === "computer.action" ? `action:${e.status}` : e.kind);
  assert.deepEqual(kinds.filter((k) => k !== "progress"), ["action:started", "action:completed", "computer.observation"]);
  const obs = events.find((e) => e.kind === "computer.observation") as Extract<ControllerProgress, { kind: "computer.observation" }>;
  assert.equal(obs.verified, true);
  assert.match(String(obs.evidence), /pong/);
});
