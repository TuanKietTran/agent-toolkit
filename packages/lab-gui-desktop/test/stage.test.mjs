import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stage } from "../scripts/stage.mjs";

test("the staged app has its entry, the server, the page and the themes, and no dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stage-test-"));
  try {
    await stage(dir);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.main, "main.mjs");
    assert.equal(pkg.type, "module");
    assert.equal(pkg.productName, "Lab Deck");
    assert.equal(pkg.devDependencies, undefined);
    for (const f of ["main.mjs", "lib/binary.mjs", "lib/policy.mjs", "gui/lib/serve.mjs", "gui/lib/cli.mjs", "gui/public/index.html", "gui/public/theme.js", "gui/themes/tokyo-night/colors.toml"]) assert.ok(existsSync(join(dir, f)), f);
    assert.ok(!existsSync(join(dir, "node_modules")));
    assert.ok(!existsSync(join(dir, "gui", "test")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("main.mjs finds the staged server first and the sibling package otherwise", () => {
  const main = readFileSync(new URL("../main.mjs", import.meta.url), "utf8");
  assert.match(main, /path\.join\(here, "gui", "lib", "serve\.mjs"\)/);
  assert.match(main, /path\.join\(here, "\.\.", "lab-gui"\)/);
});
