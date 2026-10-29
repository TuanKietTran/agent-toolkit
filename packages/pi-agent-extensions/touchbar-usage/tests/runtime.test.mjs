import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHome, writeAtomic } from "../src/runtime-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const feature = path.join(root, "touchbar-usage");

test("home resolution honors sandbox override then preserves passwd/fallback defaults", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const previous = process.env.PI_USAGE_HOME;
  process.env.PI_USAGE_HOME = home;
  try {
    assert.equal(resolveHome(), home);
    assert.equal(resolveHome({ userInfo: () => ({ homedir: "/account" }), homedir: () => "/env" }), home);
  } finally {
    if (previous === undefined) delete process.env.PI_USAGE_HOME;
    else process.env.PI_USAGE_HOME = previous;
  }
  assert.equal(resolveHome({ userInfo: () => ({ homedir: "/account" }), homedir: () => "/env" }), "/account");
  assert.equal(resolveHome({ userInfo: () => { throw Error("unavailable"); }, homedir: () => "/fallback" }), "/fallback");
});

test("atomic writes use private same-directory files and remove failed temporaries", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-files-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, "state.json");
  writeAtomic(target, "ok");
  assert.equal(fs.readFileSync(target, "utf8"), "ok");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const failed = {
    mkdirSync: fs.mkdirSync.bind(fs), writeFileSync: fs.writeFileSync.bind(fs),
    renameSync() { throw new Error("rename fixture"); }, unlinkSync: fs.unlinkSync.bind(fs),
  };
  assert.throws(() => writeAtomic(path.join(dir, "failed"), "no", { fsImpl: failed }), /rename fixture/);
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});

test("cached/stale rendering, lease contention, malformed state and fetch failure stay fail-soft", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const previous = process.env.PI_USAGE_HOME;
  process.env.PI_USAGE_HOME = home;
  let usage;
  try { usage = await import(`../src/usage.mjs?fixture=${Date.now()}`); }
  finally {
    if (previous === undefined) delete process.env.PI_USAGE_HOME;
    else process.env.PI_USAGE_HOME = previous;
  }
  assert.equal(usage.STATE_DIR, path.join(home, ".pi"));
  assert.ok(path.resolve(usage.STATE_DIR).startsWith(`${path.resolve(home)}${path.sep}`));
  assert.notEqual(path.resolve(usage.STATE_DIR), path.join(os.userInfo().homedir, ".pi"));
  fs.mkdirSync(usage.STATE_DIR, { recursive: true });
  const fresh = { updatedAt: Date.now(), claude: { ok: true, windows: [{ label: "5h", percent: 30 }] }, codex: null };
  fs.writeFileSync(usage.JSON_PATH, JSON.stringify(fresh));
  assert.deepEqual(await usage.refresh(), fresh);
  assert.match(usage.render({ ...fresh, updatedAt: Date.now() - 16 * 60_000 }), /!$/);
  fs.mkdirSync(path.join(usage.STATE_DIR, "usage-touchbar.lease"));
  fs.writeFileSync(path.join(usage.STATE_DIR, "usage-touchbar.lease", "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.deepEqual(await usage.refresh({ force: true }), usage.readPublished());
  fs.rmSync(path.join(usage.STATE_DIR, "usage-touchbar.lease"), { recursive: true, force: true });
  fs.writeFileSync(usage.JSON_PATH, "{");
  assert.equal(usage.readPublished(), null);
  const result = await usage.refresh({
    force: true,
    fetchClaudeFn: async () => ({ ok: false, error: "offline" }),
    fetchCodexFn: async () => ({ ok: false, error: "offline" }),
  });
  assert.equal(result.claude.error, "offline");
  assert.equal(result.codex.error, "offline");
});

test("scheduler dynamic usage URL resolves and feature registers shared events/panel", async () => {
  const scheduler = path.join(root, "usage-roundrobin.ts");
  const schedulerUrl = new URL("./touchbar-usage/src/usage.mjs", `file://${scheduler}`);
  assert.equal(fs.existsSync(fileURLToPath(schedulerUrl)), true, `missing ${schedulerUrl.href}`);
  const index = fs.readFileSync(path.join(feature, "index.ts"), "utf8");
  assert.match(index, /\.\.\/core\/events\.ts/);
  assert.match(index, /\.\.\/core\/right-panel\.ts/);
  assert.match(index, /PI_EVENT\.TURN_END/);
  assert.match(index, /registerTab\(/);
  assert.equal(fs.existsSync(path.join(feature, "pi-events.ts")), false);
});
