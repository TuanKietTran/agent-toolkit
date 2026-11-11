import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { CdpError, createCdpClient, discoverBrowser, isLoopbackHost } from "../cdp/client.ts";
import { createController } from "../cdp/controller.ts";
import { detectBlock } from "../cdp/detector.ts";
import { isSubmitLike } from "../cdp/guard.ts";
import { createOwnership } from "../cdp/ownership.ts";
import { DEFAULT_PACING, Pacer, createPacer, createPacing } from "../cdp/pacing.ts";
import { SnapshotStore, buildSnapshot, createSnapshotStore, isInteractive, isInteractiveRole } from "../cdp/snapshot.ts";

test("detector: clean page is not blocked", () => {
  assert.deepEqual(detectBlock({ url: "https://example.com/", title: "Example", text: "Hello world" }), { blocked: false });
});

test("detector: classifies traffic, rate limit, bot check, captcha, login", () => {
  assert.equal(detectBlock({ url: "https://x.test/", title: "", text: "Our systems have detected unusual traffic from this network" }).reason, "unusual_traffic");
  assert.equal(detectBlock({ url: "https://x.test/", title: "", text: "Error 429 from upstream" }).reason, "rate_limit");
  assert.equal(detectBlock({ url: "https://x.test/", title: "Just a moment...", text: "Checking your browser" }).reason, "bot_check");
  assert.equal(detectBlock({ url: "https://x.test/", title: "", text: "Complete the CAPTCHA to continue" }).reason, "captcha");
  const byUrl = detectBlock({ url: "https://example.com/login", title: "Home", text: "Welcome" });
  assert.equal(byUrl.reason, "login_wall");
  assert.equal(byUrl.evidence, "https://example.com/login");
  assert.equal(detectBlock({ url: "https://x.test/", title: "", text: "Username and password required" }).reason, "login_wall");
});

test("guard: submit-like detection with role and word boundaries", () => {
  assert.equal(isSubmitLike({ role: "button", name: "", inputType: "submit" }), true);
  assert.equal(isSubmitLike({ role: "button", name: "Place order" }), true);
  assert.equal(isSubmitLike({ role: "button", name: "Submit" }), true);
  assert.equal(isSubmitLike({ role: "link", name: "Pay now" }), true);
  assert.equal(isSubmitLike({ role: "textbox", name: "Submit" }), false);
  assert.equal(isSubmitLike({ role: "button", name: "Read more" }), false);
  assert.equal(isSubmitLike({ role: "button", name: "Payment settings" }), false);
  assert.equal(isSubmitLike({ role: "button", name: "" }), false);
});

test("ownership: register, assign, owns, list, release", () => {
  const o = createOwnership();
  o.register("agent-a", "tab-1");
  o.register("agent-a", "tab-2");
  o.register("agent-b", "tab-3");
  assert.equal(o.owner("tab-1"), "agent-a");
  assert.equal(o.owns("agent-a", "tab-2"), true);
  assert.equal(o.owns("agent-b", "tab-2"), false);
  assert.deepEqual(o.list("agent-a").sort(), ["tab-1", "tab-2"]);
  o.assign("agent-b", "tab-1");
  assert.equal(o.owner("tab-1"), "agent-b");
  assert.deepEqual(o.list("agent-a"), ["tab-2"]);
  o.release("tab-2");
  assert.equal(o.owner("tab-2"), undefined);
  assert.deepEqual(o.list("agent-a"), []);
});

test("pacing: injected sleep/random, defaults, serial run", async () => {
  assert.deepEqual(DEFAULT_PACING, { minDelayMs: 150, maxDelayMs: 700, minGapMs: 400 });
  assert.ok(createPacer() instanceof Pacer);
  assert.ok(createPacing() instanceof Pacer);
  const sleeps: number[] = [];
  const p = new Pacer({ minDelayMs: 10, maxDelayMs: 10, minGapMs: 0, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 });
  await p.pace();
  assert.deepEqual(sleeps, [10]);
  const events: string[] = [];
  const serial = new Pacer({ minDelayMs: 0, maxDelayMs: 0, minGapMs: 0, sleep: async () => {}, random: () => 0 });
  const a = serial.run(async () => { events.push("a-start"); await new Promise((r) => setTimeout(r, 15)); events.push("a-end"); return 1; });
  const b = serial.run(async () => { events.push("b-start"); events.push("b-end"); return 2; });
  assert.deepEqual(await Promise.all([a, b]), [1, 2]);
  assert.deepEqual(events, ["a-start", "a-end", "b-start", "b-end"]);
});

test("snapshot: stable refs, interactive filtering, text format", () => {
  const store = createSnapshotStore();
  assert.ok(store instanceof SnapshotStore);
  const nodes = [
    { nodeId: "r", childIds: ["b", "t", "h"], role: { value: "document" }, name: { value: "Page" } },
    { nodeId: "b", parentId: "r", backendDOMNodeId: 101, role: { value: "button" }, name: { value: "Go" } },
    { nodeId: "t", parentId: "r", backendDOMNodeId: 102, role: { value: "textbox" }, name: { value: "Search" }, value: { value: "query" } },
    { nodeId: "h", parentId: "r", backendDOMNodeId: 103, role: { value: "heading" }, name: { value: "Title" } },
  ] as any;
  const first = buildSnapshot(nodes, "https://example.com/", "Example", store);
  assert.match(first.text, /^# https:\/\/example\.com\/ Example/);
  assert.match(first.text, /\[e1\] button "Go"/);
  assert.match(first.text, /\[e2\] textbox "Search" value="query"/);
  assert.match(first.text, /heading "Title"/);
  assert.doesNotMatch(first.text, /\[e\d\] heading/);
  assert.equal(first.entries.length, 2);
  assert.deepEqual(first.entries[0], { ref: "e1", backendNodeId: 101, role: "button", name: "Go" });
  const second = buildSnapshot(nodes, "https://example.com/", "Example", store);
  assert.match(second.text, /\[e1\] button "Go"/);
  assert.equal(second.entries.length, 2);
  assert.equal(store.resolve("e2")?.backendNodeId, 102);
  assert.equal(store.issued("e1"), true);
  assert.equal(store.issued("e99"), false);
  assert.equal(store.issued("x1"), false);
  assert.equal(store.has("e1"), true);
  assert.equal(isInteractiveRole("Button"), true);
  assert.equal(isInteractiveRole("heading"), false);
  assert.equal(isInteractive({ role: { value: "generic" }, properties: [{ name: "focusable", value: { value: true } }] }), true);
  assert.equal(isInteractive({ role: { value: "generic" } }), false);
});

test("client: loopback check, error code, factory defaults", () => {
  for (const h of ["127.0.0.1", "localhost", "::1", "[::1]"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["192.168.0.1", "example.com", ""]) assert.equal(isLoopbackHost(h), false, h);
  const e = new CdpError("boom", "timeout");
  assert.equal(e.code, "timeout");
  assert.equal(e.name, "CdpError");
  const c = createCdpClient();
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 9222);
  assert.equal(createCdpClient({ host: "localhost", port: 9333 }).port, 9333);
});

test("client: discoverBrowser against a local fixture server", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/json/version") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ Browser: "FakeBrowser/1.0", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" })); }
    else { res.writeHead(404); res.end("nope"); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.deepEqual(await discoverBrowser("127.0.0.1", port), { browser: "FakeBrowser/1.0", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" });
  } finally { await new Promise<void>((r) => server.close(() => r())); }
  const notFound = createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise<void>((r) => notFound.listen(0, "127.0.0.1", r));
  const port2 = (notFound.address() as AddressInfo).port;
  try { await assert.rejects(discoverBrowser("127.0.0.1", port2), /discovery failed: HTTP 404/); }
  finally { await new Promise<void>((r) => notFound.close(() => r())); }
  await assert.rejects(discoverBrowser("192.0.2.1", 9222), /refusing non-loopback/);
});

test("controller: validation runs before any connection", async () => {
  const ctl = createController({ port: 59998 });
  assert.equal(ctl.halted(), undefined);
  ctl.resume();
  const cases: Array<[string, any, RegExp]> = [
    ["click", {}, /requires a tab id/],
    ["click", { tab: "t1" }, /click requires a ref/],
    ["type", { tab: "t1", ref: "e1" }, /type requires a ref and text/],
    ["press", { tab: "t1" }, /press requires a key/],
    ["select", { tab: "t1", ref: "e1" }, /select requires a ref and value/],
    ["navigate", { tab: "t1", url: "file:///etc/passwd" }, /http\(s\) or about:blank/],
    ["tab_open", { url: "javascript:alert(1)" }, /http\(s\) or about:blank/],
    ["scroll", { tab: "t1", direction: "diagonal" }, /direction up\|down\|left\|right/],
    ["upload", { tab: "t1", ref: "e1", file: "relative.txt" }, /absolute path of an existing file/],
    ["wait_for", { tab: "t1" }, /wait_for requires text or ref/],
  ];
  for (const [tool, params, re] of cases) {
    const r: any = await ctl.call("agent-1", tool as any, params);
    assert.equal(r.ok, false, tool);
    assert.equal(r.code, "invalid_param", tool);
    assert.match(r.message, re, tool);
  }
});

test("controller: non-loopback host and unreachable port", async () => {
  const bad: any = await createController({ host: "203.0.113.10", port: 59998 }).connect();
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid_param");
  assert.match(bad.message, /loopback/);
  const down: any = await createController({ port: 59998 }).call("agent-1", "tabs_list", {} as any);
  assert.equal(down.ok, false);
  assert.equal(down.code, "not_connected");
});
