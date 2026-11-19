// End-to-end tests of the single-agent streaming runtime: a real pi AgentSession, the real CDP browser
// tools against local fixture pages in a headless browser, the remote-control SSE transport, and pi's
// faux provider scripting the model so every run is deterministic. Scenario numbers follow
// reports/test-results.md.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:net";
import { startFixtureServer, type FixtureServer } from "../browser-control/cdp/fixture/server.ts";
import { resolveTestBrowser, startTestBrowser, type TestBrowser } from "../browser-control/cdp/tests/browser-harness.ts";
import type { AgentEvent } from "../runtime/events.ts";
import { getRuntime } from "../runtime/runtime.ts";
import { fauxAssistantMessage as msg, fauxText as text, fauxToolCall as call, lastToolText, openEvents, refIn, startHarness, startRemote, stopRemoteServer, tabFrom, type Harness, type RemoteClient } from "./agent-harness.ts";

const hasBrowser = !!resolveTestBrowser();
let fx: FixtureServer, br: TestBrowser;
function e2e(name: string, fn: () => Promise<void>) { test(name, { skip: hasBrowser ? false : "no Chromium-family browser", timeout: 90_000 }, fn); }

before(async () => { if (!hasBrowser) return; fx = await startFixtureServer(); br = await startTestBrowser(); });
after(async () => { stopRemoteServer(); await br?.close(); await fx?.close(); });

type Ctx = Parameters<typeof lastToolText>[0];
const snap = (ctx: Ctx) => lastToolText(ctx, "snapshot");
let tab = "";
const openTab = (path: string) => msg([call("tab_open", { url: fx.origin + path })]);
const snapshotAfterOpen = (ctx: Ctx) => { tab = tabFrom(lastToolText(ctx, "tab_open")); return msg([call("snapshot", { tab })]); };

async function run(h: Harness, prompt: string): Promise<{ executionId: string; events: AgentEvent[] }> {
  const before = getRuntime().log.lastSeq;
  await h.session.prompt(prompt);
  await h.session.waitForIdle();
  const events = getRuntime().log.since(before).events;
  const started = events.find((e) => e.type === "agent.started");
  assert.ok(started, "an execution started");
  return { executionId: started.executionId!, events: events.filter((e) => e.executionId === started.executionId) };
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const finalText = (h: Harness) => (h.session.getLastAssistantText() ?? "");
async function tabState(h: Harness): Promise<{ url: string; title: string }> {
  const r: any = await h.controller.call("harness", "tabs_list", {} as never);
  const line = (r.text as string).split("\n").find((l) => l.startsWith(tab)) ?? "";
  const [, url = "", ...title] = line.split(" ");
  return { url, title: title.join(" ") };
}
function toolPairs(events: AgentEvent[]): { name: string; ok: boolean; verified?: boolean }[] {
  return events.filter((e) => e.type === "tool.completed" || e.type === "tool.failed").map((e) => ({ name: (e as any).toolName, ok: e.type === "tool.completed", verified: (e as any).verified }));
}

e2e("1 basic navigation: opens the site, navigates to the documentation page, reports completion with evidence", async () => {
  const h = await startHarness({ browserPort: br.port, responses: [
    openTab("/site.html"),
    snapshotAfterOpen,
    (ctx: Ctx) => msg([call("click", { tab, ref: refIn(snap(ctx), "Documentation") })]),
    (ctx: Ctx) => msg(text(lastToolText(ctx, "click").includes("Acme Documentation") ? "I am on the documentation page (title \"Acme Documentation\")." : "Navigation was not verified.")),
  ] });
  try {
    const { events } = await run(h, "Open the test website and navigate to its documentation page.");
    assert.deepEqual(toolPairs(events).map((t) => t.name), ["tab_open", "snapshot", "click"]);
    assert.ok(toolPairs(events).every((t) => t.ok));
    const nav = events.filter((e) => e.type === "computer.observation" && (e as any).navigated);
    assert.ok(nav.some((e) => String((e as any).url).endsWith("/docs.html") && (e as any).verified === true), "click navigation verified");
    assert.equal(types(events).at(-1), "agent.completed");
    assert.match((await tabState(h)).url, /\/docs\.html$/);
    assert.match(finalText(h), /documentation page/);
  } finally { await h.dispose(); }
});

e2e("2 search and interaction: types a term, submits, opens the first relevant result", async () => {
  const h = await startHarness({ browserPort: br.port, responses: [
    openTab("/search.html"),
    snapshotAfterOpen,
    (ctx: Ctx) => msg([call("type", { tab, ref: refIn(snap(ctx), "Search the catalog"), text: "rocket" }), call("press", { tab, key: "Enter" }), call("snapshot", { tab })]),
    (ctx: Ctx) => msg([call("click", { tab, ref: refIn(snap(ctx), "Rocket Skates", "link") })]),
    (ctx: Ctx) => msg(text("Opened: " + (lastToolText(ctx, "click").match(/title "([^"]+)"/)?.[1] ?? "unknown"))),
  ] });
  try {
    const { events } = await run(h, "Find the search field, search for 'rocket', and open the first relevant result.");
    const tools = toolPairs(events);
    assert.deepEqual(tools.map((t) => t.name), ["tab_open", "snapshot", "type", "press", "snapshot", "click"]);
    assert.ok(tools.every((t) => t.ok), JSON.stringify(tools));
    assert.equal(tools.find((t) => t.name === "type")?.verified, true);
    const st = await tabState(h);
    assert.match(st.url, /item\.html\?id=r7$/);
    assert.match(finalText(h), /Rocket Skates - Acme/);
  } finally { await h.dispose(); }
});

e2e("3 form interaction: maps fields, replaces pre-filled text, handles the submit guard, confirms submission", async () => {
  const h = await startHarness({ browserPort: br.port, responses: [
    openTab("/contact.html"),
    snapshotAfterOpen,
    (ctx: Ctx) => { const s = snap(ctx); return msg([
      call("type", { tab, ref: refIn(s, "Full name", "textbox"), text: "Ada Lovelace" }),
      call("type", { tab, ref: refIn(s, "Email address", "textbox"), text: "ada@example.com" }),
      call("select", { tab, ref: refIn(s, "Topic", "combobox"), value: "Billing" }),
      call("type", { tab, ref: refIn(s, "Message", "textbox"), text: "Invoice question" }),
      call("click", { tab, ref: refIn(s, "Submit request") }),
    ]); },
    (ctx: Ctx) => msg([call("click", { tab, ref: refIn(snap(ctx), "Submit request"), user_confirmed: true })]),
    (ctx: Ctx) => msg([call("snapshot", { tab })]),
    (ctx: Ctx) => msg(text(snap(ctx).includes("Request received") ? "Submitted; the confirmation page echoes the values." : "Not confirmed.")),
  ] });
  try {
    const { events } = await run(h, "Complete the local contact form (Ada Lovelace, ada@example.com, Billing, 'Invoice question') and submit it. I confirm the submission.");
    const tools = toolPairs(events);
    assert.deepEqual(tools.filter((t) => t.name === "type").map((t) => t.verified), [true, true, true]);
    const guarded = events.find((e) => e.type === "tool.failed" && (e as any).toolName === "click");
    assert.match(String((guarded as any)?.error), /user_confirmed/, "the first submit was held by the guard");
    const final = getRuntime().log.all().filter((e) => e.type === "tool.completed" && (e as any).toolName === "snapshot").at(-1) as any;
    assert.ok(final);
    const page: any = await h.controller.call("harness", "snapshot", { tab } as never);
    assert.match(page.text, /Name: Ada Lovelace \| Email: ada@example.com \| Topic: billing \| Message: Invoice question/);
    assert.match(finalText(h), /Submitted/);
  } finally { await h.dispose(); }
});

e2e("4 dynamic application: clicks, waits for the asynchronous update, reports the resulting state", async () => {
  const h = await startHarness({ browserPort: br.port, responses: [
    openTab("/dynamic.html"),
    snapshotAfterOpen,
    (ctx: Ctx) => msg([call("click", { tab, ref: refIn(snap(ctx), "Refresh status") }), call("wait_for", { tab, text: "All systems operational", timeout_ms: 8000 }), call("snapshot", { tab })]),
    (ctx: Ctx) => msg(text("Status: " + (snap(ctx).match(/All systems operational[^"]*/)?.[0] ?? "unknown"))),
  ] });
  try {
    const { events } = await run(h, "Open the live status page, refresh it, wait for the update and report the status.");
    const clickObs = events.find((e) => e.type === "computer.observation" && /Loading/.test(String((e as any).evidence)));
    assert.ok(clickObs, "the click's immediate effect (Loading…) was observed");
    assert.ok(events.some((e) => e.type === "tool.completed" && (e as any).toolName === "wait_for" && (e as any).verified === true));
    assert.match(finalText(h), /All systems operational \(check #1, 3 services healthy\)/);
  } finally { await h.dispose(); }
});

const multiStep = () => [
  openTab("/catalog.html"),
  snapshotAfterOpen,
  (ctx: Ctx) => msg([text("Opening the Rocket Sled detail page."), call("click", { tab, ref: refIn(snap(ctx), "Rocket Sled", "link") })]),
  (ctx: Ctx) => msg([call("snapshot", { tab })]),
  (ctx: Ctx) => {
    const s = snap(ctx);
    const field = (k: string) => { const ls = s.split("\n").map((l) => l.trim()); const i = ls.findIndex((l) => l.includes(`"${k}"`)); return ls.slice(i + 1).find((l) => /StaticText "/.test(l) && !l.includes(`"${k}"`))?.match(/"([^"]+)"/)?.[1]; };
    return msg(text(JSON.stringify({ item: s.match(/heading "([^"]+)"/)?.[1], price: field("price"), sku: field("sku"), stock: field("stock"), url: s.split("\n")[0].split(" ")[1] })));
  },
];

e2e("9 multi-step: finds an item, opens its detail page, extracts fields into a structured summary", async () => {
  const h = await startHarness({ browserPort: br.port, responses: multiStep() });
  try {
    const { events } = await run(h, "Visit the local catalog, find the Rocket Sled, open its detail page, and give me its price, SKU and stock as JSON.");
    assert.deepEqual(toolPairs(events).map((t) => t.name), ["tab_open", "snapshot", "click", "snapshot"]);
    const summary = JSON.parse(finalText(h));
    assert.deepEqual(summary, { item: "Rocket Sled", price: "$899.00", sku: "RKT-SL9", stock: "Out of stock", url: fx.origin + "/item.html?id=r9" });
  } finally { await h.dispose(); }
});

let remote: RemoteClient;

e2e("6 streaming: incremental deltas, tool/computer/artifact events, ordered and gap-free over SSE, low latency", async () => {
  const h = await startHarness({ browserPort: br.port, tokensPerSecond: 60, responses: [
    msg([text("I will open the documentation page and capture it so you can see it."), call("tab_open", { url: fx.origin + "/docs.html" })]),
    (ctx: Ctx) => { tab = tabFrom(lastToolText(ctx, "tab_open")); return msg([call("screenshot", { tab }), call("wait_for", { tab, text: "7311", timeout_ms: 3000 })]); },
    msg(text("The documentation says the default port is 7311.")),
  ] });
  try {
    remote = await startRemote(h.session);
    const client = openEvents(remote);
    await new Promise((r) => setTimeout(r, 100));
    const promptAt = Date.now();
    await run(h, "Open the documentation page and tell me the default port.");
    await client.waitFor((e) => e.type === "agent.completed");
    client.close();
    const got = client.received;
    const evs = got.map((r) => r.event);
    // Incremental model output: many deltas, spread over time, before the message completes.
    const deltas = got.filter((r) => r.event.type === "message.delta");
    assert.ok(deltas.length >= 5, `deltas: ${deltas.length}`);
    assert.ok(deltas.at(-1)!.receivedAt - deltas[0].receivedAt > 100, "deltas arrived over time, not in one burst");
    const firstCompleted = evs.findIndex((e) => e.type === "message.completed");
    assert.ok(evs.findIndex((e) => e.type === "message.delta") < firstCompleted);
    // Tool, computer and artifact events, correlated by toolCallId.
    for (const name of ["tab_open", "screenshot", "wait_for"]) {
      const started = evs.find((e) => e.type === "tool.started" && (e as any).toolName === name) as any;
      assert.ok(started, `${name} started`);
      const done = evs.find((e) => e.type === "tool.completed" && (e as any).toolCallId === started.toolCallId);
      assert.ok(done, `${name} completed`);
      assert.ok(evs.indexOf(started) < evs.indexOf(done!));
    }
    assert.ok(evs.some((e) => e.type === "computer.action" && (e as any).action === "tab_open" && (e as any).status === "completed"));
    assert.ok(evs.some((e) => e.type === "computer.observation" && (e as any).verified === true));
    const art = evs.find((e) => e.type === "artifact.created") as any;
    assert.equal(art?.kind, "screenshot");
    const img = await remote.get("/api/artifacts/" + art.artifactId);
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.ok((await img.arrayBuffer()).byteLength > 1000);
    // Integrity: contiguous seq, no duplicates, SSE id equals the event id, nothing missing vs the log.
    const seqs = evs.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, "no gap or reorder at " + i);
    assert.ok(got.every((r) => r.sseId === r.event.id && r.sseType === r.event.type));
    const log = getRuntime().log.since(seqs[0] - 1).events.filter((e) => e.seq <= seqs.at(-1)!);
    assert.equal(log.length, evs.length, "every logged event was delivered");
    // Latency from production to client receipt.
    const lat = got.map((r) => r.receivedAt - r.event.ts).sort((a, b) => a - b);
    const p50 = lat[Math.floor(lat.length / 2)], p95 = lat[Math.floor(lat.length * 0.95)];
    assert.ok(p95 < 100, `p95 delivery latency ${p95}ms`);
    const firstEventMs = got.find((r) => r.event.type === "agent.started")!.receivedAt - promptAt;
    const firstTokenMs = deltas[0].receivedAt - promptAt;
    console.log(`# streaming metrics: events=${evs.length} deltas=${deltas.length} latency_p50=${p50}ms latency_p95=${p95}ms time_to_first_event=${firstEventMs}ms time_to_first_token=${firstTokenMs}ms`);
    // Snapshots stay small: images are referenced, not inlined.
    const state = await (await remote.get("/api/state")).text();
    assert.ok(!state.includes("iVBORw0KGgo"), "state snapshot contains no base64 PNG");
  } finally { await h.dispose(); }
});

e2e("6b reconnect: a client that disconnects mid-run resumes with Last-Event-ID and misses nothing; the run is unaffected", async () => {
  const h = await startHarness({ browserPort: br.port, responses: multiStep() });
  try {
    remote = await startRemote(h.session);
    const a = openEvents(remote);
    await new Promise((r) => setTimeout(r, 100));
    const done = run(h, "Visit the catalog and summarise the Rocket Sled.");
    await a.waitFor((e) => e.type === "tool.completed");
    a.close();
    await a.closed;
    const lastSeen = a.received.at(-1)!.event;
    await done; // the execution finished although its only client went away
    assert.equal(getRuntime().status().recent[0].outcome, "completed");
    const b = openEvents(remote, lastSeen.id);
    await b.waitFor((e) => e.type === "agent.completed");
    b.close();
    const seqA = a.received.map((r) => r.event.seq), seqB = b.received.map((r) => r.event.seq);
    assert.equal(seqB[0], seqA.at(-1)! + 1, "replay starts right after the last event seen");
    const all = [...seqA, ...seqB];
    assert.equal(new Set(all).size, all.length, "no duplicates");
    for (let i = 1; i < all.length; i++) assert.equal(all[i], all[i - 1] + 1);
    // A client too far behind the retained window is told to resync instead of silently losing events.
    const c = openEvents(remote, getRuntime().log.logId + ":0");
    await new Promise((r) => setTimeout(r, 200));
    c.close();
    if (getRuntime().log.oldestSeq > 1) assert.equal(c.frames[0]?.type, "reset");
  } finally { await h.dispose(); }
});

e2e("7a pause/resume: no new tool or model step starts while paused; the held action runs after resume", async () => {
  const h = await startHarness({ browserPort: br.port, responses: [
    openTab("/dynamic.html"),
    snapshotAfterOpen,
    (ctx: Ctx) => msg([call("navigate", { tab, url: fx.origin + "/dynamic.html?delay=1200" }), call("snapshot", { tab })]),
    (ctx: Ctx) => msg([call("click", { tab, ref: refIn(snap(ctx), "Refresh status") })]),
    msg(text("Refreshed.")),
  ] });
  try {
    remote = await startRemote(h.session);
    const es = openEvents(remote);
    await new Promise((r) => setTimeout(r, 100));
    const done = run(h, "Reload the live status page and refresh it.");
    await es.waitFor((e) => e.type === "tool.started" && (e as any).toolName === "navigate");
    assert.equal((await remote.post("/api/pause")).status, 202);
    const paused = await es.waitFor((e) => e.type === "agent.paused") as any;
    assert.equal(paused.at, "tool_call");
    assert.equal(paused.toolName, "snapshot", "the call after the in-flight navigate is held");
    const status = await (await remote.get("/api/status")).json();
    assert.equal(status.state, "paused");
    const seqAtPause = getRuntime().log.lastSeq;
    await new Promise((r) => setTimeout(r, 1000));
    const during = getRuntime().log.since(seqAtPause).events;
    assert.ok(!during.some((e) => e.type === "computer.action" || e.type === "tool.started" || e.type === "message.delta"), "nothing ran while paused: " + types(during).join(","));
    assert.equal((await remote.post("/api/resume")).status, 202);
    await done;
    es.close();
    const evs = getRuntime().log.since(seqAtPause).events;
    assert.ok(evs.some((e) => e.type === "agent.resumed"));
    assert.ok(evs.some((e) => e.type === "tool.completed" && (e as any).toolName === "click"));
    assert.equal(getRuntime().status().recent[0].outcome, "completed");
    assert.ok(getRuntime().status().recent[0].pausedMs >= 900);
  } finally { await h.dispose(); }
});

e2e("7b cancel: cancelling during a long wait stops it at once and the queued click never runs", async () => {
  let pingRef = "";
  const h = await startHarness({ browserPort: br.port, responses: [
    openTab("/page.html"),
    snapshotAfterOpen,
    (ctx: Ctx) => { pingRef = refIn(snap(ctx), "Ping"); return msg([call("wait_for", { tab, text: "never appears", timeout_ms: 20000 }), call("click", { tab, ref: pingRef })]); },
    msg(text("should not be reached")),
  ] });
  try {
    remote = await startRemote(h.session);
    const es = openEvents(remote);
    await new Promise((r) => setTimeout(r, 100));
    const done = run(h, "Wait for the page and then click Ping.");
    await es.waitFor((e) => e.type === "tool.started" && (e as any).toolName === "wait_for");
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    assert.equal((await remote.post("/api/cancel")).status, 202);
    await es.waitFor((e) => e.type === "agent.cancelled");
    const cancelMs = Date.now() - t0;
    await done;
    es.close();
    assert.ok(cancelMs < 1500, `cancelled in ${cancelMs}ms`);
    const page: any = await h.controller.call("harness", "snapshot", { tab } as never);
    assert.ok(page.text.includes('"idle"'), "Ping was never clicked");
    assert.equal(getRuntime().status().recent[0].outcome, "cancelled");
    assert.equal(getRuntime().status().state, "idle");
  } finally { await h.dispose(); }
});

e2e("8 recovery: navigation failure, browser timeout, tool exception, invalid arguments and a dropped browser connection are reported and survived", async () => {
  const dead = await new Promise<number>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const a = s.address(); const p = typeof a === "object" && a ? a.port : 0; s.close(() => resolve(p)); }); });
  let h: Harness;
  h = await startHarness({ browserPort: br.port, extraExtensions: [(pi) => pi.registerTool({ name: "flaky", label: "flaky", description: "always throws", parameters: { type: "object", properties: {} } as never, async execute() { throw new Error("flaky tool exploded"); } } as never)], responses: [
    msg([call("tab_open", { url: `http://127.0.0.1:${dead}/` })]),
    (ctx: Ctx) => { tab = (lastToolText(ctx, "tab_open").match(/opened tab (\S+)/) ?? [])[1]; return msg([call("wait_for", { tab, text: "never", timeout_ms: 600 })]); },
    msg([call("flaky", {})]),
    msg([call("click", { tab })]),
    () => { void (h.controller as any).client?.close(); return msg([call("navigate", { tab, url: fx.origin + "/site.html" })]); },
    (ctx: Ctx) => msg(text("Recovered: " + lastToolText(ctx, "navigate").slice(0, 120))),
  ] });
  try {
    const { events } = await run(h, "Exercise failure handling.");
    const failed = events.filter((e) => e.type === "tool.failed").map((e) => [(e as any).toolName, (e as any).error] as [string, string]);
    assert.match(failed.find(([n]) => n === "tab_open")?.[1] ?? "", /navigation_failed|ERR_CONNECTION_REFUSED/i);
    assert.match(failed.find(([n]) => n === "wait_for")?.[1] ?? "", /timed out/);
    assert.match(failed.find(([n]) => n === "flaky")?.[1] ?? "", /flaky tool exploded/);
    assert.match(failed.find(([n]) => n === "click")?.[1] ?? "", /ref|validat|required/i);
    const nav = events.find((e) => e.type === "tool.completed" && (e as any).toolName === "navigate") as any;
    assert.ok(nav, "navigate succeeded after the browser connection was dropped");
    assert.equal(nav.verified, true);
    assert.equal(types(events).at(-1), "agent.completed");
    assert.match(finalText(h), /^Recovered: navigated/);
  } finally { await h.dispose(); }
});

e2e("6c slow consumer: a client that stops reading is disconnected instead of growing pi's memory; others keep streaming", async () => {
  const { connect } = await import("node:net");
  const h = await startHarness({ browserPort: br.port, responses: [msg(text("ok"))] });
  try {
    remote = await startRemote(h.session);
    const port = Number(new URL(remote.base).port);
    const stalled = connect(port, "127.0.0.1");
    stalled.pause(); // never read: the kernel buffers fill, then pi's socket buffer grows
    stalled.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${remote.cookie}\r\n\r\n`);
    const healthy = openEvents(remote);
    await new Promise((r) => setTimeout(r, 200));
    const before = (await (await remote.get("/api/status")).json()).droppedSlowClients;
    const chunk = "x".repeat(2000);
    // 7 MB of events in batches of 50 (a realistic burst rate), yielding to the event loop between batches.
    for (let i = 0; i < 70; i++) { for (let j = 0; j < 50; j++) getRuntime().log.append({ type: "activity.updated", activity: chunk }); await new Promise((r) => setImmediate(r)); }
    const deadline = Date.now() + 10000;
    while (healthy.received.filter((r) => r.event.type === "activity.updated").length < 3500 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const status = await (await remote.get("/api/status")).json();
    assert.ok(status.droppedSlowClients > before, "the stalled client was dropped");
    assert.equal(healthy.received.filter((r) => r.event.type === "activity.updated").length, 3500, "a reading client got everything");
    healthy.close();
    stalled.destroy();
  } finally { await h.dispose(); }
});

e2e("6d web UI: the built-in remote page renders live tool activity, verification and the final state", async () => {
  const h = await startHarness({ browserPort: br.port, tokensPerSecond: 80, responses: [
    msg([call("tab_open", { url: fx.origin + "/docs.html" })]),
    msg(text("The documentation page is open.")),
  ] });
  try {
    remote = await startRemote(h.session);
    const token = (globalThis as Record<symbol, any>)[Symbol.for("pi.remote-control.state.v1")].token;
    // The UI is itself opened in a browser tab driven through the same CDP controller.
    const ui: any = await h.controller.call("ui-viewer", "tab_open", { url: `${remote.base}/#${token}` } as never);
    assert.equal(ui.ok, true, JSON.stringify(ui));
    const uiTab = ui.data.tab;
    const ready: any = await h.controller.call("ui-viewer", "wait_for", { tab: uiTab, text: "Connecting to Pi", gone: true, timeout_ms: 5000 } as never);
    assert.equal(ready.ok, true, JSON.stringify(ready));
    await run(h, "Open the documentation page.");
    for (const expected of ["tab_open", "verified: at", "completed", "The documentation page is open."]) {
      const r: any = await h.controller.call("ui-viewer", "wait_for", { tab: uiTab, text: expected, timeout_ms: 5000 } as never);
      assert.equal(r.ok, true, `UI shows ${expected}: ${JSON.stringify(r)}`);
    }
    await h.controller.call("ui-viewer", "tab_close", { tab: uiTab } as never);
  } finally { await h.dispose(); }
});

// ---------------------------------------------------------------------------------------------
// Lifecycle consistency: the model loop, the tool loop and the stream must describe the same run.
// For every tool call the test compares four views: the SSE stream (what a UI shows), pi's session
// tool-result message, the exact context the model received on its next request, and the browser.
// The model here is a policy that decides each step ONLY from the tool results it actually received,
// so a result that never reached the model would derail the run.
// ---------------------------------------------------------------------------------------------

type LlmMsg = { role: string; content?: any; toolCallId?: string; isError?: boolean; toolName?: string };
const textOfContent = (content: unknown): string => Array.isArray(content) ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n") : String(content ?? "");
function orphanToolCalls(messages: LlmMsg[]): string[] {
  const results = new Set(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId));
  return messages.filter((m) => m.role === "assistant").flatMap((m) => (Array.isArray(m.content) ? m.content : []).filter((c: any) => c.type === "toolCall").map((c: any) => c.id)).filter((id: string) => !results.has(id));
}

e2e("L lifecycle consistency + adaptation: stream, session and model context agree on every tool call while the agent adapts to a changing page", async () => {
  const contexts: LlmMsg[][] = [];
  let oldRef = "";
  let phase = "start";
  const policy = (ctx: { messages: readonly unknown[] }) => {
    const messages = structuredClone(ctx.messages) as LlmMsg[];
    contexts.push(messages);
    const last = [...messages].reverse().find((m) => m.role === "toolResult");
    const lastText = textOfContent(last?.content);
    switch (phase) {
      case "start": phase = "opened"; return msg([call("tab_open", { url: fx.origin + "/shop.html" })]);
      case "opened": tab = tabFrom(lastText); phase = "first-snapshot"; return msg([call("snapshot", { tab })]);
      case "first-snapshot": oldRef = refIn(lastText, "Add Rocket Skates to cart"); phase = "first-add"; return msg([call("click", { tab, ref: oldRef })]);
      case "first-add":
        // Adapt: the click did not add to the cart; the page showed a consent banner instead.
        assert.ok(!last?.isError && /We use cookies/.test(lastText), "the model received the banner evidence: " + lastText);
        phase = "banner-snapshot"; return msg([call("snapshot", { tab })]);
      case "banner-snapshot": phase = "accept"; return msg([call("click", { tab, ref: refIn(lastText, "Accept cookies") })]);
      case "accept": phase = "retry-old"; return msg([call("click", { tab, ref: oldRef })]); // naive retry with the old ref
      case "retry-old":
        // Adapt: the list was re-rendered; the old reference is reported stale and as an error.
        assert.equal(last?.isError, true, "the model received the stale ref as an error");
        assert.match(lastText, /no longer on the page/);
        phase = "resnapshot"; return msg([call("snapshot", { tab })]);
      case "resnapshot": phase = "add"; return msg([call("click", { tab, ref: refIn(lastText, "Add Rocket Skates to cart") })]);
      case "add":
        assert.match(lastText, /Cart: 1 item \(Rocket Skates\)/);
        phase = "noop"; return msg([call("scroll", { tab, direction: "up", amount: 100 })]); // already at the top: NOT verified
      case "noop":
        assert.match(lastText, /unchanged/);
        phase = "done"; return msg(text("Added Rocket Skates. The cart shows 1 item (Rocket Skates)."));
      default: throw new Error("unexpected extra model call in phase " + phase);
    }
  };
  const h = await startHarness({ browserPort: br.port, responses: Array.from({ length: 12 }, () => policy) });
  try {
    remote = await startRemote(h.session);
    const es = openEvents(remote);
    await new Promise((r) => setTimeout(r, 100));
    const { executionId } = await run(h, "Add the Rocket Skates to the cart in the local shop.");
    await es.waitFor((e) => e.type === "agent.completed" && e.executionId === executionId);
    es.close();
    assert.equal(phase, "done");
    const stream = es.received.map((r) => r.event).filter((e) => e.executionId === executionId);
    const session = (h.session.messages as LlmMsg[]).filter((m) => m.role === "toolResult");
    const requested = stream.filter((e) => e.type === "tool.requested") as any[];
    assert.equal(requested.length, 9);
    assert.equal(session.length, requested.length, "every requested call has exactly one result in the session");
    for (const req of requested) {
      const id = req.toolCallId;
      const mine = stream.filter((e) => (e as any).toolCallId === id);
      const kinds = mine.map((e) => e.type).filter((t) => t.startsWith("tool."));
      const terminal = kinds.filter((t) => t === "tool.completed" || t === "tool.failed");
      assert.equal(terminal.length, 1, `${req.toolName} ${id}: exactly one terminal event (${kinds.join(",")})`);
      assert.ok(kinds.indexOf("tool.requested") < kinds.indexOf("tool.started") && kinds.indexOf("tool.started") < kinds.indexOf(terminal[0]), `${id} ordered: ${kinds.join(",")}`);
      const result = session.find((m) => m.toolCallId === id)!;
      assert.ok(result, `${id} has a session result`);
      // The stream's verdict equals the flag the model sees.
      assert.equal(terminal[0] === "tool.failed", result.isError === true, `${req.toolName}: stream ${terminal[0]} vs isError ${result.isError}`);
      const end = mine.find((e) => e.type === terminal[0]) as any;
      const resultText = textOfContent(result.content);
      const shown = terminal[0] === "tool.failed" ? end.error : end.summary ?? "";
      assert.ok(resultText.startsWith(shown), `${req.toolName}: the stream shows what the model got`);
      const details = (h.session.messages as any[]).find((m) => m.role === "toolResult" && m.toolCallId === id).details;
      if (details?.verification) assert.equal(end.verified, details.verification.verified, `${req.toolName}: verified flag`);
      // The model actually received this exact result in its next request.
      const seenIn = contexts.find((c) => c.some((m) => m.role === "toolResult" && m.toolCallId === id));
      assert.ok(seenIn, `${req.toolName} ${id} result reached the model`);
      const seen = seenIn.find((m) => m.role === "toolResult" && m.toolCallId === id)!;
      assert.equal(textOfContent(seen.content), resultText, `${req.toolName}: model context text equals the session result`);
      assert.equal(!!seen.isError, !!result.isError, `${req.toolName}: model context error flag`);
    }
    for (const c of contexts) assert.deepEqual(orphanToolCalls(c), [], "no tool call without a result in any model request");
    const outcomes = requested.map((r) => { const t = stream.find((e) => (e.type === "tool.completed" || e.type === "tool.failed") && (e as any).toolCallId === r.toolCallId) as any; return r.toolName + (t.type === "tool.failed" ? "!" : t.verified === false ? "?" : ""); });
    // ! = failed (the model saw an error), ? = completed but NOT verified.
    assert.deepEqual(outcomes, ["tab_open", "snapshot", "click", "snapshot", "click", "click!", "snapshot", "click", "scroll?"]);
    // And the browser agrees with what the model concluded.
    const page: any = await h.controller.call("harness", "snapshot", { tab } as never);
    assert.match(page.text, /Cart: 1 item \(Rocket Skates\)/);
    assert.equal(stream.at(-1)!.type, "agent.completed");
  } finally { await h.dispose(); }
});

e2e("L2 cancel mid-batch leaves no tool call without a result, so the next instruction can continue the session", async () => {
  const contexts: LlmMsg[][] = [];
  let pingRef = "";
  const record = (ctx: { messages: readonly unknown[] }) => { contexts.push(structuredClone(ctx.messages) as LlmMsg[]); };
  const h = await startHarness({ browserPort: br.port, responses: [
    (ctx: Ctx) => { record(ctx); return openTab("/page.html"); },
    (ctx: Ctx) => { record(ctx); return snapshotAfterOpen(ctx); },
    (ctx: Ctx) => { record(ctx); pingRef = refIn(snap(ctx), "Ping"); return msg([call("wait_for", { tab, text: "never appears", timeout_ms: 20000 }), call("click", { tab, ref: pingRef })]); },
    (ctx: Ctx) => { record(ctx); return msg(text("Continuing after the cancel.")); },
  ] });
  try {
    remote = await startRemote(h.session);
    const es = openEvents(remote);
    await new Promise((r) => setTimeout(r, 100));
    const first = run(h, "Wait, then click Ping.");
    await es.waitFor((e) => e.type === "tool.started" && (e as any).toolName === "wait_for");
    await new Promise((r) => setTimeout(r, 200));
    await remote.post("/api/cancel");
    await first;
    await es.waitFor((e) => e.type === "agent.cancelled");
    es.close();
    await run(h, "Never mind the click. Just confirm you are still working.");
    const afterCancel = contexts.at(-1)!;
    const orphans = orphanToolCalls(afterCancel);
    assert.deepEqual(orphans, [], "the model's next request has a result for every earlier tool call");
    // The never-started click is explicit in both views: an error result for the model, tool.skipped on the stream.
    const clickCall = afterCancel.flatMap((m) => m.role === "assistant" && Array.isArray(m.content) ? m.content : []).find((c: any) => c.type === "toolCall" && c.name === "click") as any;
    const clickResult = afterCancel.find((m) => m.role === "toolResult" && m.toolCallId === clickCall.id)!;
    assert.equal(clickResult.isError, true);
    assert.match(textOfContent(clickResult.content), /Not executed.*NOT performed/);
    const skipped = es.received.map((r) => r.event).find((e) => e.type === "tool.skipped") as any;
    assert.equal(skipped?.toolCallId, clickCall.id);
    assert.match(skipped.reason, /cancelled/);
    assert.match(finalText(h), /Continuing/);
    const page: any = await h.controller.call("harness", "snapshot", { tab } as never);
    assert.ok(page.text.includes('"idle"'), "the cancelled click never ran");
  } finally { await h.dispose(); }
});
