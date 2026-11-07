import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { graphsDir, graphspecOf, loadGraphs, mergeGraphs, sessionDir } from "../lib/graphs.mjs";

const node = (name, extra = {}) => ({ name, harness: "pi", role: null, parent: null, requested_model: null, model: null, model_label: null, pick: { via: null, rule: null, reason: null }, tools: [], ...extra });
const manifest = (extra = {}) => ({ version: 1, run: "run-1", team: "team.yah", source: null, root: "lead", created_ms: 100, nodes: [node("lead")], edges: [], ...extra });
const liveLab = (name, extra = {}) => ({ name, role: null, state: "working", ...extra });

test("sessionDir: AGENT_CLI_LAB_DIR wins, then platform rules", () => {
  assert.equal(sessionDir({ env: { AGENT_CLI_LAB_DIR: "/custom" }, platform: "linux" }), "/custom");
  assert.equal(sessionDir({ env: { LOCALAPPDATA: "C:/Users/x/AppData/Local" }, platform: "win32" }), join("C:/Users/x/AppData/Local", "agent-cli-lab", "sessions"));
  assert.equal(sessionDir({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, platform: "linux" }), join("/run/user/1000", "agent-cli-lab"));
  assert.equal(sessionDir({ env: { TMPDIR: "/var/tmp" }, platform: "darwin" }), join("/var/tmp", "agent-cli-lab"));
  assert.equal(sessionDir({ env: {}, platform: "linux" }), join(tmpdir(), "agent-cli-lab"));
  // Empty strings do not count as set.
  assert.equal(sessionDir({ env: { AGENT_CLI_LAB_DIR: "", XDG_RUNTIME_DIR: "/run" }, platform: "linux" }), join("/run", "agent-cli-lab"));
});

test("graphsDir appends graphs/ to the session dir, dir override passes through", () => {
  assert.equal(graphsDir({ env: { AGENT_CLI_LAB_DIR: "/s" }, platform: "linux" }), join("/s", "graphs"));
  assert.equal(graphsDir({ dir: "/given" }), "/given");
});

test("loadGraphs reads a graphs folder directly, oldest first, skipping junk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-gui-graphs-"));
  await writeFile(join(dir, "b.json"), JSON.stringify(manifest({ run: "second", created_ms: 200 })));
  await writeFile(join(dir, "a.json"), JSON.stringify(manifest({ run: "first", created_ms: 50 })));
  await writeFile(join(dir, "bad.json"), "{not json");
  await writeFile(join(dir, "foreign.json"), JSON.stringify(manifest({ version: 2, run: "v2" })));
  await writeFile(join(dir, "notes.txt"), JSON.stringify(manifest({ run: "ignored" })));
  const out = await loadGraphs({ dir });
  assert.deepEqual(out.map((m) => m.run), ["first", "second"]);
  assert.equal(out[0].version, 1);
  assert.deepEqual(out[0].nodes.map((n) => n.name), ["lead"]);
});

test("loadGraphs accepts a session dir (reads its graphs/ subfolder) and tolerates a missing dir", async () => {
  const session = await mkdtemp(join(tmpdir(), "lab-gui-session-"));
  await mkdir(join(session, "graphs"));
  await writeFile(join(session, "graphs", "r.json"), JSON.stringify(manifest({ run: "via-session" })));
  assert.deepEqual((await loadGraphs({ dir: session })).map((m) => m.run), ["via-session"]);
  assert.deepEqual(await loadGraphs({ dir: join(session, "nope") }), []);
});

test("loadGraphs normalises nodes: nameless dropped, pick/tools defaulted, edge kinds lowercased", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-gui-norm-"));
  const raw = manifest({ nodes: [{ name: "lead", model: "m" }, { harness: "pi" }, { name: "w", pick: "nope", tools: ["read", 7] }], edges: [{ from: "lead", to: "w", kind: "MEMBER" }, { from: "lead" }, "junk"] });
  await writeFile(join(dir, "r.json"), JSON.stringify(raw));
  const [m] = await loadGraphs({ dir });
  assert.deepEqual(m.nodes.map((n) => n.name), ["lead", "w"]);
  assert.deepEqual(m.nodes[0].pick, { via: null, rule: null, reason: null });
  assert.deepEqual(m.nodes[1].tools, ["read"]);
  assert.deepEqual(m.edges, [{ from: "lead", to: "w", kind: "member" }]);
});

test("graphspecOf projects team/run and copies pick and tools", () => {
  const m = manifest();
  const n = node("lead", { harness: "claude-cli", model: "claude-cli/claude-sonnet-5-5", model_label: "sonnet", requested_model: "sonnet", pick: { via: "system-one", rule: "r", reason: "why" }, tools: ["read"] });
  const gs = graphspecOf(m, n);
  assert.deepEqual(gs, { team: "team.yah", run: "run-1", harness: "claude-cli", model: "claude-cli/claude-sonnet-5-5", model_label: "sonnet", requested_model: "sonnet", pick: { via: "system-one", rule: "r", reason: "why" }, tools: ["read"] });
  gs.tools.push("bash"); gs.pick.via = "x";
  assert.deepEqual(n.tools, ["read"]); assert.equal(n.pick.via, "system-one");
});

test("mergeGraphs enriches live labs and appends planned nodes", () => {
  const m = manifest({ nodes: [
    node("lead", { role: "commander", model: "claude-cli/claude-opus-5", model_label: "opus" }),
    node("builder-1", { role: "builder", parent: "lead", model: "claude-cli/claude-sonnet-5-5" }),
    node("ghost", { parent: "outside", model: null }),
  ], edges: [{ from: "lead", to: "builder-1", kind: "parent" }] });
  const out = mergeGraphs([liveLab("lead"), liveLab("solo")], [m]);
  assert.equal(out.labs.find((l) => l.name === "lead").graphspec.model, "claude-cli/claude-opus-5");
  assert.equal(out.labs.find((l) => l.name === "solo").graphspec, null);
  assert.deepEqual(out.planned.map((p) => p.name), ["builder-1", "ghost"]);
  const b = out.planned[0];
  assert.equal(b.state, "planned"); assert.equal(b.kind, "builder"); assert.equal(b.parent, "lead");
  assert.equal(b.modelLabel, "sonnet-5-5"); assert.equal(b.modelFamily, "sonnet");
  assert.equal(b.graphspec.team, "team.yah"); assert.deepEqual(b.samples, []); assert.equal(b.usage, null);
  // Parent not present in the same manifest is dropped from the link; kind is still inferred from the raw parent flag (has a parent, no kids -> worker).
  assert.equal(out.planned[1].parent, null); assert.equal(out.planned[1].kind, "worker");
  assert.deepEqual(out.labs.map((l) => l.name), ["lead", "solo", "builder-1", "ghost"]);
  assert.deepEqual(out.teams, [{ team: "team.yah", run: "run-1", up: 1, total: 3 }]);
});

test("mergeGraphs: planned parent gets children, member edges filtered and deduped", () => {
  const m = manifest({ nodes: [node("lead"), node("mgr", { parent: "lead" }), node("w1", { parent: "mgr" })], edges: [
    { from: "lead", to: "w1", kind: "member" }, { from: "lead", to: "w1", kind: "member" },
    { from: "lead", to: "mgr", kind: "parent" }, { from: "lead", to: "unknown", kind: "member" },
  ] });
  const out = mergeGraphs([liveLab("lead")], [m]);
  const mgr = out.planned.find((p) => p.name === "mgr");
  assert.deepEqual(mgr.children, ["w1"]); assert.equal(mgr.kind, "manager");
  assert.deepEqual(out.edges, [{ from: "lead", to: "w1", kind: "member" }]);
  assert.equal(out.memberEdges, out.edges);
});

test("mergeGraphs ignores stale manifests (no live nodes) and foreign versions", () => {
  const stale = manifest({ run: "old", nodes: [node("gone-1"), node("gone-2")] });
  const out = mergeGraphs([liveLab("lead")], [stale, manifest({ version: 2 })]);
  assert.deepEqual(out.teams, []); assert.deepEqual(out.planned, []); assert.deepEqual(out.edges, []);
  assert.deepEqual(out.labs, [{ name: "lead", role: null, state: "working", graphspec: null }]);
});

test("mergeGraphs dedupes a planned node shared by two active manifests", () => {
  const a = manifest({ run: "a", nodes: [node("lead"), node("shared", { parent: "lead" })] });
  const b = manifest({ run: "b", created_ms: 200, nodes: [node("lead"), node("shared", { parent: "lead" })] });
  const out = mergeGraphs([liveLab("lead")], [a, b]);
  assert.deepEqual(out.planned.map((p) => p.name), ["shared"]);
  assert.equal(out.teams.length, 2);
});

test("mergeGraphs copes with non-array inputs", () => {
  assert.deepEqual(mergeGraphs(null, null), { labs: [], planned: [], edges: [], memberEdges: [], teams: [] });
  assert.equal(mergeGraphs([liveLab("x")], undefined).labs[0].graphspec, null);
});
