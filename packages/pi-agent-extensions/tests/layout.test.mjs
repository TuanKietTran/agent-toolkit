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
  "browser-control/README.md", "claude-cli/README.md", "claude-cli/LICENSE",
];

async function assertManifestEntries(base, entries) {
  for (const entry of entries) await access(join(base, entry.replace(/^\.\//, "")));
}

test("source and built manifests resolve every declared extension", async () => {
  assert.equal(sourceManifest.pi.extensions.length, builtManifest.pi.extensions.length);
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
