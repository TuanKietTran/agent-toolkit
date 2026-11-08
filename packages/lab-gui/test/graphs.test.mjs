import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { graphsDir, graphspecOf, loadGraphs, mergeGraphs, oldSessionDir, registryBanner, sessionDir, vaultEnvOf } from "../lib/graphs.mjs";

const node = (name, extra = {}) => ({ name, harness: "pi", role: null, parent: null, requested_model: null, model: null, model_label: null, pick: { via: null, rule: null, reason: null }, tools: [], ...extra });
const manifest = (extra = {}) => ({ version: 1, run: "run-1", team: "team.yah", source: null, root: "lead", created_ms: 100, nodes: [node("lead")], edges: [], ...extra });
const liveLab = (name, extra = {}) => ({ name, role: null, state: "working", ...extra });

test("sessionDir: H1_DIR wins, then platform rules", () => {
  assert.equal(sessionDir({ env: { H1_DIR: "/custom" }, platform: "linux" }), "/custom");
  assert.equal(sessionDir({ env: { LOCALAPPDATA: "C:/Users/x/AppData/Local" }, platform: "win32" }), join("C:/Users/x/AppData/Local", "h1", "sessions"));
  assert.equal(sessionDir({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, platform: "linux" }), join("/run/user/1000", "h1"));
  assert.equal(sessionDir({ env: { TMPDIR: "/var/tmp" }, platform: "darwin" }), join("/var/tmp", "h1"));
  assert.equal(sessionDir({ env: {}, platform: "linux" }), join(tmpdir(), "h1"));
  // Empty strings do not count as set.
  assert.equal(sessionDir({ env: { H1_DIR: "", XDG_RUNTIME_DIR: "/run" }, platform: "linux" }), join("/run", "h1"));
});

test("graphsDir appends graphs/ to the session dir, dir override passes through", () => {
  assert.equal(graphsDir({ env: { H1_DIR: "/s" }, platform: "linux" }), join("/s", "graphs"));
  assert.equal(graphsDir({ dir: "/given" }), "/given");
});

test("oldSessionDir mirrors sessionDir's base rule with the old name", () => {
  assert.equal(oldSessionDir({ env: { LOCALAPPDATA: "C:/Users/x/AppData/Local" }, platform: "win32" }), join("C:/Users/x/AppData/Local", "agent-cli-lab", "sessions"));
  assert.equal(oldSessionDir({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, platform: "linux" }), join("/run/user/1000", "agent-cli-lab"));
  assert.equal(oldSessionDir({ env: { TMPDIR: "/var/tmp" }, platform: "darwin" }), join("/var/tmp", "agent-cli-lab"));
});

test("registryBanner names the registry and counts its .json sessions; no warning when the old dir is absent", async () => {
  const base = await mkdtemp(join(tmpdir(), "lab-gui-banner-"));
  const registry = join(base, "h1");
  await mkdir(registry);
  await writeFile(join(registry, "a.json"), "{}");
  await writeFile(join(registry, "b.json"), "{}");
  await writeFile(join(registry, "a.sock"), "");
  await mkdir(join(registry, "graphs"));
  const lines = await registryBanner({ dir: registry, oldDir: join(base, "agent-cli-lab") });
  assert.deepEqual(lines, [`lab-gui: registry ${registry} (2 sessions)`]);
});

test("registryBanner warns exactly once when the old dir exists, with its entry count (0 included)", async () => {
  const base = await mkdtemp(join(tmpdir(), "lab-gui-banner-old-"));
  const registry = join(base, "h1");
  const old = join(base, "agent-cli-lab");
  await mkdir(registry);
  await mkdir(old);
  await writeFile(join(registry, "a.json"), "{}");
  await writeFile(join(old, "one.json"), "{}");
  await writeFile(join(old, "two.json"), "{}");
  assert.deepEqual(await registryBanner({ dir: registry, oldDir: old }), [
    `lab-gui: registry ${registry} (1 sessions)`,
    `lab-gui: old registry ${old} exists (2 sessions) - labs started by the old tool do not appear here; this server reads ${registry}`,
  ]);
  const empty = join(base, "empty-old");
  await mkdir(empty);
  const lines = await registryBanner({ dir: registry, oldDir: empty });
  assert.equal(lines.length, 2);
  assert.equal(lines[1], `lab-gui: old registry ${empty} exists (0 sessions) - labs started by the old tool do not appear here; this server reads ${registry}`);
});

test("registryBanner tolerates a missing registry dir (0 sessions, still named)", async () => {
  const base = await mkdtemp(join(tmpdir(), "lab-gui-banner-missing-"));
  const registry = join(base, "nope");
  assert.deepEqual(await registryBanner({ dir: registry, oldDir: join(base, "also-nope") }), [`lab-gui: registry ${registry} (0 sessions)`]);
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
  assert.deepEqual(gs, { team: "team.yah", run: "run-1", harness: "claude-cli", model: "claude-cli/claude-sonnet-5-5", model_label: "sonnet", requested_model: "sonnet", pick: { via: "system-one", rule: "r", reason: "why" }, tools: ["read"], vault_env: [] });
  gs.tools.push("bash"); gs.pick.via = "x"; gs.vault_env.push("FLEET_TOKEN");
  assert.deepEqual(n.tools, ["read"]); assert.equal(n.pick.via, "system-one"); assert.equal(n.vault_env, undefined);
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

test("R30 vault_env: names pass through the reader and graphspec, deduped in order", async () => {
  const m = manifest({ nodes: [node("lead", { vault_env: ["FLEET_TOKEN", "VAULT_API_KEY", "FLEET_TOKEN"] })] });
  const out = mergeGraphs([liveLab("lead")], [m]);
  assert.deepEqual(out.labs[0].graphspec.vault_env, ["FLEET_TOKEN", "VAULT_API_KEY"]);
  // The detail panel renders exactly those names under the exact title, and only when non-empty.
  const appJs = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.ok(appJs.includes('...(vaultNames.length ? [["Secrets (names only)", vaultNames.join(", ")]] : [])'));
  assert.ok(appJs.includes("/^[A-Za-z_][A-Za-z0-9_]*$/"));
});

test("R30 vault_env: a lab without vault_env gets an empty list (panel shows no Secrets row)", () => {
  const out = mergeGraphs([liveLab("lead")], [manifest()]);
  assert.deepEqual(out.labs[0].graphspec.vault_env, []);
  assert.deepEqual(vaultEnvOf(undefined), []);
  assert.deepEqual(vaultEnvOf("FLEET_TOKEN"), []);
});

test("R30 vault_env: value-shaped entries are dropped and never appear in any output", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lab-gui-vault-"));
  const bad = ["FLEET_TOKEN=abc123xyz", "bad name", "bad-name", "9LEADING", "dot.name", "", 123, null, {}, ["x"]];
  await writeFile(join(dir, "r.json"), JSON.stringify(manifest({ nodes: [node("lead", { vault_env: ["FLEET_TOKEN", ...bad] })] })));
  const loaded = await loadGraphs({ dir });
  assert.deepEqual(loaded[0].nodes[0].vault_env, ["FLEET_TOKEN"]);
  const out = mergeGraphs([liveLab("lead")], loaded);
  assert.deepEqual(out.labs[0].graphspec.vault_env, ["FLEET_TOKEN"]);
  const serialised = JSON.stringify(out);
  for (const leak of ["abc123xyz", "bad name", "bad-name", "9LEADING", "dot.name"]) assert.ok(!serialised.includes(leak), `leaked: ${leak}`);
});

test("mergeGraphs copes with non-array inputs", () => {
  assert.deepEqual(mergeGraphs(null, null), { labs: [], planned: [], edges: [], memberEdges: [], teams: [] });
  assert.equal(mergeGraphs([liveLab("x")], undefined).labs[0].graphspec, null);
});
