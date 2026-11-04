import assert from "node:assert/strict";
import test from "node:test";
import { classify, createMonitor, parseModel, parseUsage } from "../lib/monitor.mjs";
import { TEAM, createFakeCli } from "./fakes.mjs";

test("parseUsage reads Pi's footer counters", () => {
  const u = parseUsage(["", "  ↑6 ↓350 R31k W23k CH36.7% $0.005 9.0%/200k (auto)  c", "── CTX 9%"]);
  assert.deepEqual(u, { input: 6, output: 350, cacheRead: 31000, cacheWrite: 23000, cacheHitPct: 36.7, costUsd: 0.005, contextPct: 9, contextWindow: 200000 });
});

test("parseUsage copes with partial footers and non-Pi screens", () => {
  assert.equal(parseUsage(["$ ls", "total 0"]), undefined);
  const u = parseUsage(["↑1.2k ↓3 $0.50"]);
  assert.equal(u.input, 1200);
  assert.equal(u.cacheRead, undefined);
  assert.equal(u.costUsd, 0.5);
});

test("a context window cut off by the screen edge is dropped, not misread", () => {
  const u = parseUsage(["↑6 ↓399 R42k W11k CH36.8% $0.003 9.0%/200..."]);
  assert.equal(u.contextPct, 9);
  assert.equal(u.contextWindow, undefined);
  assert.equal(u.cacheRead, 42000);
  assert.equal(parseUsage(["↑6 ↓399 $0.003 9.0%/200"]).contextWindow, undefined);
});

test("parseUsage uses the newest footer on the screen", () => {
  assert.equal(parseUsage(["↑1 ↓1 $0.001", "text", "↑9 ↓9 $0.009"]).costUsd, 0.009);
});

test("models are split into provider, family and a short label", () => {
  assert.deepEqual(parseModel("claude-cli/claude-haiku-5-5"), { provider: "claude-cli", id: "claude-haiku-5-5", family: "haiku", label: "haiku-5-5" });
  assert.equal(parseModel("muse/muse").family, "muse");
  assert.equal(parseModel("opencode-cli/opencode/gpt-6-luna").family, "opencode");
  assert.equal(parseModel(null).family, "unknown");
});

test("roles: team roles are kept, others are inferred from the graph", () => {
  assert.equal(classify("builder", false, false), "builder");
  assert.equal(classify(null, true, false), "commander");
  assert.equal(classify(null, true, true), "manager");
  assert.equal(classify(undefined, false, true), "worker");
  assert.equal(classify(undefined, false, false), "lab");
});

test("tick builds the lead -> helpers graph with state, model and usage", async () => {
  const monitor = createMonitor({ cli: createFakeCli(TEAM) });
  const snap = await monitor.tick();
  const by = Object.fromEntries(snap.labs.map((l) => [l.name, l]));
  assert.deepEqual(by.lead.children, ["scout", "review"]);
  assert.equal(by.scout.parent, "lead");
  assert.equal(by.lead.kind, "builder");
  assert.equal(by.scout.kind, "explorer");
  assert.equal(by.review.kind, "advisor");
  assert.equal(by.review.state, "stalled");
  assert.equal(by.scout.modelLabel, "haiku-5-5");
  assert.equal(by.lead.usage.costUsd, 0.005);
  assert.equal(snap.totals.total, 3);
  assert.equal(snap.totals.stalled, 1);
  assert.ok(Math.abs(snap.totals.costUsd - 0.005) < 1e-9);
});

test("activity samples are byte deltas, newest last, and bounded", async () => {
  const cli = createFakeCli([{ name: "a", role: "worker" }]);
  const monitor = createMonitor({ cli, historyLen: 3 });
  await monitor.tick();
  for (const bytes of [100, 150, 150, 400]) {
    cli.sessions.get("a").bytes_out = bytes;
    await monitor.tick();
  }
  assert.deepEqual(monitor.snapshot().labs[0].samples, [50, 0, 250]);
});

test("a lab that disappears is shown as gone for a while, then dropped", async () => {
  let t = 0;
  const cli = createFakeCli(TEAM);
  const monitor = createMonitor({ cli, now: () => t, goneKeepMs: 1000 });
  await monitor.tick();
  cli.sessions.delete("scout");
  t = 10;
  const snap = await monitor.tick();
  const scout = snap.labs.find((l) => l.name === "scout");
  assert.equal(scout.state, "gone");
  assert.equal(snap.totals.gone, 1);
  t = 5000;
  assert.equal((await monitor.tick()).labs.find((l) => l.name === "scout"), undefined);
});

test("a failing CLI keeps the last snapshot and reports the error", async () => {
  const cli = createFakeCli(TEAM);
  const monitor = createMonitor({ cli });
  await monitor.tick();
  cli.list = async () => {
    throw new Error("agent-cli-lab not found");
  };
  const snap = await monitor.tick();
  assert.equal(snap.labs.length, 3);
  assert.match(snap.error, /not found/);
});

test("the footer is only re-read after the usage interval", async () => {
  let t = 0;
  const cli = createFakeCli(TEAM);
  const monitor = createMonitor({ cli, now: () => t, usageEveryMs: 5000 });
  await monitor.tick();
  t = 1000;
  await monitor.tick();
  assert.equal(cli.calls.filter((c) => c[0] === "screen" && c[1] === "lead").length, 1);
  t = 6000;
  await monitor.tick();
  assert.equal(cli.calls.filter((c) => c[0] === "screen" && c[1] === "lead").length, 2);
});

test("a lab whose status call fails but is still listed keeps its listed state instead of being called gone", async () => {
  const cli = createFakeCli(TEAM);
  const monitor = createMonitor({ cli });
  cli.status = async () => {
    throw new Error("socket busy");
  };
  const snap = await monitor.tick();
  assert.equal(snap.totals.gone, 0);
  assert.equal(snap.labs.find((l) => l.name === "lead").state, "working");
});
