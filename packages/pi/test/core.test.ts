import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs, UsageError } from "../src/core/args.js";
import { loadConfig } from "../src/core/config.js";
import { createRunner, wrap, assertTarget, describeTarget } from "../src/core/exec.js";
import { Registry } from "../src/core/registry.js";
import type { ExecTarget } from "../src/core/types.js";

const HOST: ExecTarget = { kind: "host" };
const CONTAINER: ExecTarget = { kind: "container", containerName: "jellyfin" };

test("wrap: host commands pass through untouched", () => {
  assert.deepEqual(wrap(HOST, ["ffmpeg", "-version"]), ["ffmpeg", "-version"]);
});

test("wrap: container commands go through docker exec", () => {
  assert.deepEqual(wrap(CONTAINER, ["ffmpeg", "-version"]), [
    "docker", "exec", "jellyfin", "ffmpeg", "-version",
  ]);
  assert.deepEqual(wrap(CONTAINER, ["apt-get", "update"], { user: "0" }), [
    "docker", "exec", "-u", "0", "jellyfin", "apt-get", "update",
  ]);
});

test("wrap: sudo never applies to container targets", () => {
  assert.deepEqual(wrap(CONTAINER, ["apt-get", "update"], { sudo: true })[0], "docker");
});

test("assertTarget: a container target without a name is rejected", () => {
  assert.throws(() => assertTarget({ kind: "container" }), /container name/);
  assert.throws(() => wrap({ kind: "container" }, ["ls"]), /container name/);
});

test("describeTarget reads like a sentence", () => {
  assert.equal(describeTarget(HOST), "host");
  assert.equal(describeTarget(CONTAINER), "container jellyfin");
});

test("runner: captures stdout and exit code", async () => {
  const run = createRunner();
  const res = await run(HOST, ["node", "-e", "process.stdout.write('hi')"]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "hi");
});

test("runner: non-zero exit throws unless allowFailure", async () => {
  const run = createRunner();
  await assert.rejects(() => run(HOST, ["node", "-e", "process.exit(3)"]), /exit 3/);
  const res = await run(HOST, ["node", "-e", "process.exit(3)"], { allowFailure: true });
  assert.equal(res.code, 3);
});

test("runner: a missing binary is a 127, not a crash", async () => {
  const run = createRunner();
  const res = await run(HOST, ["definitely-not-a-real-binary-xyz"], { allowFailure: true });
  assert.equal(res.code, 127);
});

test("runner: dry run skips mutating commands but still runs probes", async () => {
  const seen: Array<[string, boolean]> = [];
  const run = createRunner({
    dryRun: true,
    onCommand: (argv, skipped) => seen.push([argv[0] as string, skipped]),
  });

  // A mutating command must not actually run.
  const marker = `pi-dryrun-${Date.now()}`;
  await run(HOST, ["node", "-e", `process.stdout.write("${marker}")`]);
  assert.deepEqual(seen.at(-1), ["node", true]);

  // A probe still executes, so check() can see real state.
  const probe = await run(HOST, ["node", "--version"], { readOnly: true });
  assert.match(probe.stdout, /^v\d/);
  assert.deepEqual(seen.at(-1), ["node", false]);
});

test("args: defaults", () => {
  const a = parseArgs(["list"]);
  assert.equal(a.command, "list");
  assert.equal(a.target, "host");
  assert.equal(a.dryRun, false);
});

test("args: both --flag=value and --flag value forms work", () => {
  assert.equal(parseArgs(["check", "zlib-ext", "--container=jf"]).container, "jf");
  assert.equal(parseArgs(["check", "zlib-ext", "--container", "jf"]).container, "jf");
});

test("args: --container implies a container target", () => {
  const a = parseArgs(["install", "zlib-ext", "--container=jf"]);
  assert.equal(a.target, "container");
  assert.equal(a.positionals[0], "zlib-ext");
});

test("args: contradictory target and container are rejected", () => {
  assert.throws(() => parseArgs(["check", "x", "--target=host", "--container=jf"]), UsageError);
});

test("args: --target=container without a name is rejected", () => {
  assert.throws(() => parseArgs(["check", "x", "--target=container"]), /--container/);
});

test("args: --set collects repeated key=value pairs", () => {
  const a = parseArgs(["install", "jellyfin-ext", "--set", "media-path=/srv/m", "--set=port=9000"]);
  assert.deepEqual(a.set, { "media-path": "/srv/m", port: "9000" });
});

test("args: unknown flags fail loudly instead of being ignored", () => {
  assert.throws(() => parseArgs(["list", "--colour"]), /unknown flag/);
});

test("args: short flags", () => {
  const a = parseArgs(["install", "x", "-n", "-y"]);
  assert.equal(a.dryRun, true);
  assert.equal(a.assumeYes ?? a.yes, true);
});

test("config: --set beats environment beats file", () => {
  process.env.PI_TESTEXT_ALPHA = "from-env";
  process.env.PI_TESTEXT_BETA = "from-env";
  const cfg = loadConfig("testext", { alpha: "from-flag" });
  assert.equal(cfg.get("alpha"), "from-flag");
  assert.equal(cfg.get("beta"), "from-env");
  delete process.env.PI_TESTEXT_ALPHA;
  delete process.env.PI_TESTEXT_BETA;
});

test("config: typed accessors", () => {
  const cfg = loadConfig("testext", { flag: "yes", items: "a, b ,c", empty: "" });
  assert.equal(cfg.bool("flag", false), true);
  assert.equal(cfg.bool("missing", true), true);
  assert.deepEqual(cfg.list("items"), ["a", "b", "c"]);
  assert.deepEqual(cfg.list("empty", ["fallback"]), ["fallback"]);
  assert.equal(cfg.string("missing", "default"), "default");
});

test("config: require() explains how to supply the value", () => {
  const cfg = loadConfig("jellyfin-ext", {});
  assert.throws(() => cfg.require("media-path"), /--set media-path=/);
});

test("registry: loads every bundled extension", async () => {
  const reg = await Registry.load();
  assert.deepEqual(reg.errors, []);
  const names = reg.list().map((e) => e.manifest.name);
  assert.deepEqual(names, ["docker-ext", "ffmpeg-ext", "jellyfin-ext", "pi-ext", "zlib-ext"]);
});

test("registry: unknown extension suggests near matches", async () => {
  const reg = await Registry.load();
  assert.throws(() => reg.get("jellyfin"), /did you mean: jellyfin-ext/);
});

test("registry: prerequisites resolve dependency-first", async () => {
  const reg = await Registry.load();
  const requires = reg.requirementsOf("jellyfin-ext").map((e) => e.manifest.name);
  assert.deepEqual(requires, ["docker-ext", "zlib-ext", "ffmpeg-ext"]);
  assert.deepEqual(reg.requirementsOf("zlib-ext"), []);
});

test("registry: every extension declares a name matching its directory", async () => {
  const reg = await Registry.load();
  for (const ext of reg.list()) {
    assert.ok(ext.dir.endsWith(ext.manifest.name), `${ext.dir} vs ${ext.manifest.name}`);
    assert.equal(ext.plugin.name, ext.manifest.name);
  }
});
