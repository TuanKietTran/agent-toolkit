import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const sourceManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const builtManifest = JSON.parse(await readFile(join(root, "dist/package.json"), "utf8"));
const resources = [
  "touchbar-usage/src/usage.mjs", "touchbar-usage/src/runtime-files.mjs",
  "touchbar-usage/host/main.swift", "touchbar-usage/host/build.sh", "touchbar-usage/bin/pi-usagebar",
  "browser-control/native/chrome-control.js", "browser-control/native/macos-controller.swift",
  "browser-control/bridge-protocol.mjs", "browser-control/NATIVE-HOST.md",
  "browser-control/native-host/install.mjs", "browser-control/native-host/bridge-launcher.cs",
  "browser-control/native-host/bridge-host.mjs",
  "browser-control/helper-extension/service-worker.js",
  "browser-control/helper-extension/popup.js", "browser-control/helper-extension/popup.html",
  "browser-control/helper-extension/manifest.json", "browser-control/helper-extension/native-frame.mjs",
  "browser-control/helper-extension/bridge-protocol.mjs",
  "browser-control/native/windows-controller.cs", "browser-control/windows-backend.mjs", "browser-control/windows-backend.d.mts",
  "browser-control/windows-shared.mjs", "browser-control/windows-shared.d.mts", "browser-control/windows-mcp.mjs",
  "browser-control/mcp-server.mjs", "browser-control/WINDOWS.md",
  "browser-control/README.md", "claude-cli/README.md", "claude-cli/LICENSE",
];

async function assertManifestEntries(base, entries) {
  for (const entry of entries) await access(join(base, entry.replace(/^\.\//, "")));
}

test("source and built manifests resolve every declared extension", async () => {
  const requiredFeatures = ["./touchbar-usage/index.ts", "./browser-control/index.ts", "./claude-cli/index.ts"];
  assert.equal(sourceManifest.pi.extensions.length, 7);
  assert.equal(builtManifest.pi.extensions.length, 7);
  for (const entry of requiredFeatures) {
    assert.equal(sourceManifest.pi.extensions.filter((item) => item === entry).length, 1, `${entry} must be declared once`);
  }
  assert.equal(sourceManifest.pi.extensions.length, builtManifest.pi.extensions.length);
  assert.equal(sourceManifest.bin["pi-browser-mcp"], "./browser-control/mcp-server.mjs");
  assert.deepEqual(builtManifest.bin, sourceManifest.bin);
  await assertManifestEntries(root, sourceManifest.pi.extensions);
  await assertManifestEntries(join(root, "dist"), builtManifest.pi.extensions);
});

test("runtime resources survive minification with executable modes", async () => {
  for (const resource of resources) {
    await access(join(root, resource));
    await access(join(root, "dist", resource));
  }
  for (const executable of ["touchbar-usage/bin/pi-usagebar", "touchbar-usage/host/build.sh"]) {
    assert.ok((await stat(join(root, "dist", executable))).mode & 0o111, `${executable} lost executable mode`);
  }
});

test("helper runtime assets, including the canonical native frame codec, survive build unchanged", async () => {
  for (const asset of ["popup.js", "popup.html", "manifest.json", "native-frame.mjs"])
    assert.deepEqual(await readFile(join(root, "browser-control/helper-extension", asset)), await readFile(join(root, "dist/browser-control/helper-extension", asset)), `${asset} must be packaged byte-for-byte`);
});

test("helper manifest declares native messaging and resolves each packaged runtime asset", async () => {
  for (const base of [root, join(root, "dist")]) {
    const helper = join(base, "browser-control/helper-extension");
    const manifest = JSON.parse(await readFile(join(helper, "manifest.json"), "utf8"));
    assert.ok(manifest.permissions.includes("nativeMessaging"));
    for (const asset of [manifest.background.service_worker, manifest.action.default_popup, "popup.js", "native-frame.mjs", "bridge-protocol.mjs"])
      await access(join(helper, asset));
  }
});

test("helper native frame codec loads unchanged from source and built layouts", async () => {
  const sourcePath = join(root, "browser-control/helper-extension/native-frame.mjs");
  const builtPath = join(root, "dist/browser-control/helper-extension/native-frame.mjs");
  assert.deepEqual(await readFile(sourcePath), await readFile(builtPath));
  const [sourceCodec, builtCodec] = await Promise.all([import(pathToFileURL(sourcePath).href), import(pathToFileURL(builtPath).href)]);
  const message = { type: "hello", version: 1, text: "frame ✓" };
  const sourceFrame = sourceCodec.encodeNativeFrame(message);
  assert.deepEqual(builtCodec.decodeNativeFrame(sourceFrame), message);
  assert.deepEqual(builtCodec.encodeNativeFrame(message), sourceFrame);
});

test("helper extension protocol imports resolve in source and built layouts", async () => {
  const source = join(root, "browser-control");
  const built = join(root, "dist/browser-control");
  const sourceWorker = await readFile(join(source, "helper-extension/service-worker.js"), "utf8");
  const builtWorker = await readFile(join(built, "helper-extension/service-worker.js"), "utf8");
  assert.match(sourceWorker, /from [\"']\.\.\/bridge-protocol\.mjs[\"']/);
  assert.match(builtWorker, /from [\"']\.\/bridge-protocol\.mjs[\"']/);
  const sourceProtocol = await import(pathToFileURL(join(source, "bridge-protocol.mjs")).href);
  const builtProtocol = await import(pathToFileURL(join(built, "bridge-protocol.mjs")).href);
  const helperProtocol = await import(pathToFileURL(join(built, "helper-extension/bridge-protocol.mjs")).href);
  assert.equal(sourceProtocol.PROTOCOL_VERSION, 1);
  assert.equal(builtProtocol.PROTOCOL_VERSION, sourceProtocol.PROTOCOL_VERSION);
  assert.deepEqual(await readFile(join(source, "bridge-protocol.mjs")), await readFile(join(built, "bridge-protocol.mjs")));
  assert.deepEqual(await readFile(join(built, "bridge-protocol.mjs")), await readFile(join(built, "helper-extension/bridge-protocol.mjs")));
});

test("source and built MCP adapter assets load on the Node runtime", async () => {
  for (const base of [root, join(root, "dist")]) {
    const adapter = await import(pathToFileURL(join(base, "browser-control/windows-mcp.mjs")));
    assert.equal(typeof adapter.WindowsMcpSession, "function");
    assert.ok(adapter.windowsMcpTools.some(tool => tool.name === "windows_foreground_act"));
  }
});
test("manifest extensions register against an inert fake Pi API", async () => {
  for (const [base, entries] of [[root, sourceManifest.pi.extensions], [join(root, "dist"), builtManifest.pi.extensions]]) {
    for (const entry of entries) {
      const url = pathToFileURL(join(base, entry.replace(/^\.\//, ""))).href;
      const extension = await import(url);
      assert.equal(typeof extension.default, "function", `${entry} must export an extension function`);
      const registrations = [];
      const noop = () => {};
      const api = new Proxy({
        on: (name) => (registrations.push(["event", name]), noop),
        registerTool: (tool) => registrations.push(["tool", tool.name]),
        registerCommand: (name) => registrations.push(["command", name]),
        registerProvider: (name) => registrations.push(["provider", name]),
      }, { get: (target, key) => key in target ? target[key] : noop });
      assert.doesNotThrow(() => extension.default(api), `${entry} registration`);
      assert.ok(registrations.length > 0, `${entry} registered nothing`);
    }
  }
});
