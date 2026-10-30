import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("../install.mjs", import.meta.url));
const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const socketPath = "\\\\.\\pipe\\pi-browser-bridge-0123456789abcdef0123456789abcdef";
function invoke(args) {
  const result = spawnSync(process.execPath, [installer, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("dry-run writes nothing and does not invent an extension id", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-bridge-package-"));
  try {
    const output = invoke(["--dry-run", "--fixture", fixture, "--socket", socketPath]);
    assert.equal(output.writesNothing, true);
    assert.match(output.manifest.allowed_origins[0], /SET_EXACT_32_CHAR_EXTENSION_ID/);
    assert.deepEqual(await readdir(fixture), []);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("fixture install emits exact host manifest and uninstall removes only fixture output", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-bridge-package-"));
  try {
    const output = invoke(["--install", "--fixture", fixture, "--extension-id", extensionId, "--socket", socketPath, "--csc", "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"]);
    const manifest = JSON.parse(await readFile(output.manifestPath, "utf8"));
    assert.equal(manifest.name, "com.pi_agent_extensions.browser_bridge");
    assert.equal(manifest.type, "stdio");
    assert.equal(typeof manifest.path, "string");
    assert.ok(manifest.path.length > 0);
    assert.deepEqual(Object.keys(manifest).sort(), ["allowed_origins", "description", "name", "path", "type"]);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
    invoke(["--uninstall", "--fixture", fixture, "--socket", socketPath]);
    await assert.rejects(readFile(output.manifestPath));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("Windows launcher compiled by fixture installer relays framed bytes without manifest args", { skip: process.platform !== "win32" }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi bridge launcher "));
  try {
    const tree = join(fixture, "browser-control", "native-host");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(tree, { recursive: true });
    const echoScript = join(tree, "bridge-host.mjs");
    await writeFile(echoScript, "process.stdin.pipe(process.stdout);\n");
    const csc = "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe";
    const output = invoke(["--install", "--fixture", fixture, "--extension-id", extensionId, "--socket", socketPath, "--node", process.execPath, "--host-script", echoScript, "--csc", csc]);
    const manifest = JSON.parse(await readFile(output.manifestPath, "utf8"));
    assert.deepEqual(Object.keys(manifest).sort(), ["allowed_origins", "description", "name", "path", "type"]);
    assert.equal(manifest.path, join(fixture, "PiBrowserBridge", "bridge-launcher.exe"));
    assert.deepEqual(JSON.parse(await readFile(join(fixture, "PiBrowserBridge", "host-config.json"))), { nodeExecutable: process.execPath, hostScript: echoScript, socketPath });
    const header = Buffer.alloc(4); const payload = Buffer.from(JSON.stringify({ type: "hello", version: 1 })); header.writeUInt32LE(payload.length);
    const framed = Buffer.concat([header, payload]);
    const child = spawnSync(manifest.path, [`chrome-extension://${extensionId}/`], { input: framed, env: { ...process.env, LOCALAPPDATA: fixture } });
    assert.equal(child.status, 0, child.stderr.toString());
    assert.deepEqual(child.stdout, framed, "launcher must relay the native-messaging frame byte-for-byte");
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("install rejects guessed or malformed extension IDs without writing", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pi-bridge-package-"));
  try {
    const result = spawnSync(process.execPath, [installer, "--install", "--fixture", fixture, "--extension-id", "placeholder", "--socket", socketPath], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid Chrome extension ID/);
    assert.deepEqual(await readdir(fixture), []);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
