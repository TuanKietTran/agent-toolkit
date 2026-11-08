import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../lib/app.mjs";
import { createMonitor } from "../lib/monitor.mjs";
import { createFakeCli } from "./fakes.mjs";

// Cross-check R6: the manifest below is the FIXTURE from packages/h1/src/graphspec.rs
// verbatim (the Rust reader's contract test data). It must survive the lab-gui
// reader (lib/graphs.mjs) and appear in the /api/labs payload (lib/app.mjs enrich)
// with nodes, resolved models and pick tags intact.
const FIXTURE = {
  version: 1, run: "run-1", team: "alpha", source: "/abs/team.yah",
  root: "cmdr", created_ms: 42, trace_dir: "/trace/run-1",
  nodes: [
    { name: "cmdr", harness: "commander", role: "commander", parent: null,
      requested_model: "system-one", model: "anthropic/claude-sonnet-5-5", model_label: "sonnet",
      pick: { via: "system-one", rule: "R3", reason: "strict constraints", degraded_level: 0 },
      tools: ["fs"], future_field: true },
    { name: "builder", harness: "worker", role: "worker", parent: "cmdr",
      requested_model: "system-one", model: "openai/gpt-6-luna", model_label: "luna",
      pick: { via: "fallback", rule: null, reason: "no strict match", degraded_level: 1 } },
  ],
  edges: [{ from: "cmdr", to: "builder", kind: "parent" }],
  unknown_top_level: 7,
};

// The tag both readers derive: Rust PickInfo::tag() and public/app.js pickTag()
// agree — system-one + rule -> `s1 <rule>`, otherwise the via string verbatim.
const tagOf = (pick) => (pick.via === "system-one" ? (pick.rule ? `s1 ${pick.rule}` : "s1") : pick.via);

const KEY = "launch-key";
const COOKIE = `lab_gui=${KEY}`;

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), "lab-gui-xcheck-"));
  await writeFile(join(dir, "run-1.json"), JSON.stringify(FIXTURE));
  const cli = createFakeCli([{ name: "cmdr", role: "commander", parent: null, model: "anthropic/claude-sonnet-5-5" }]);
  const monitor = createMonitor({ cli });
  let port = 0;
  const app = createApp({ cli, monitor, key: KEY, token: "t0ken", port: () => port, pollMs: 20, idleMs: 200, graphsDir: dir });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  return {
    labs: async () => (await fetch(`http://127.0.0.1:${port}/api/labs`, { headers: { cookie: COOKIE } })).json(),
    close: async () => { app.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

test("R6 cross-check: h1 graphspec.rs fixture nodes + resolved models reach /api/labs", async () => {
  const s = await boot();
  try {
    const snap = await s.labs();
    assert.deepEqual(snap.labs.map((l) => l.name), ["cmdr", "builder"]);
    const cmdr = snap.labs[0];
    assert.equal(cmdr.graphspec.team, "alpha");
    assert.equal(cmdr.graphspec.run, "run-1");
    assert.equal(cmdr.graphspec.harness, "commander");
    assert.equal(cmdr.graphspec.model, "anthropic/claude-sonnet-5-5");
    assert.equal(cmdr.graphspec.model_label, "sonnet");
    assert.equal(cmdr.graphspec.requested_model, "system-one");
    assert.deepEqual(cmdr.graphspec.tools, ["fs"]);
    const builder = snap.labs[1];
    assert.equal(builder.state, "planned");
    assert.equal(builder.parent, "cmdr");
    assert.equal(builder.role, "worker");
    assert.equal(builder.graphspec.harness, "worker");
    assert.equal(builder.graphspec.model, "openai/gpt-6-luna");
    assert.equal(builder.graphspec.model_label, "luna");
    assert.deepEqual(builder.graphspec.tools, []);
    assert.deepEqual(snap.planned.map((p) => p.name), ["builder"]);
    assert.deepEqual(snap.teams, [{ team: "alpha", run: "run-1", up: 1, total: 2 }]);
    assert.deepEqual(snap.memberEdges, []);
    assert.deepEqual(snap.edges, []);
  } finally { await s.close(); }
});

test("R6 cross-check: pick data in /api/labs yields the Rust pick tags s1 R3 + fallback", async () => {
  const s = await boot();
  try {
    const snap = await s.labs();
    const cmdr = snap.labs.find((l) => l.name === "cmdr");
    const builder = snap.labs.find((l) => l.name === "builder");
    assert.deepEqual(cmdr.graphspec.pick, { via: "system-one", rule: "R3", reason: "strict constraints" });
    assert.deepEqual(builder.graphspec.pick, { via: "fallback", rule: null, reason: "no strict match" });
    assert.equal(tagOf(cmdr.graphspec.pick), "s1 R3");
    assert.equal(tagOf(builder.graphspec.pick), "fallback");
  } finally { await s.close(); }
});
