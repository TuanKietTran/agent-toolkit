import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../install.mjs", import.meta.url));
const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
function invoke(args) {
  const result = spawnSync(process.execPath, [installer, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("dry-run writes nothing and does not invent an extension id", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-bridge-package-"));
  try {
    const output = invoke(["--dry-run", "--fixture", fixture]);
    assert.equal(output.writesNothing, true);
    assert.match(output.manifest.allowed_origins[0], /SET_EXACT_32_CHAR_EXTENSION_ID/);
    assert.deepEqual(await readdir(fixture), []);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("fixture install emits exact host manifest and uninstall removes only fixture output", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-bridge-package-"));
  try {
    const output = invoke(["--install", "--fixture", fixture, "--extension-id", extensionId]);
    const manifest = JSON.parse(await readFile(output.manifestPath, "utf8"));
    assert.equal(manifest.name, "com.pi_agent_extensions.browser_bridge");
    assert.equal(manifest.type, "stdio");
    assert.equal(manifest.path, process.execPath);
    assert.deepEqual(manifest.args, [resolve(dirname(installer), "bridge-host.mjs"), "--native"]);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    invoke(["--uninstall", "--fixture", fixture]);
    await assert.rejects(readFile(output.manifestPath));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("install rejects guessed or malformed extension IDs without writing", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-bridge-package-"));
  try {
    const result = spawnSync(process.execPath, [installer, "--install", "--fixture", fixture, "--extension-id", "placeholder"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid Chrome extension ID/);
    assert.deepEqual(await readdir(fixture), []);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
