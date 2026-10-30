#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.pi_agent_extensions.browser_bridge";
const here = dirname(fileURLToPath(import.meta.url));
const defaultHost = resolve(here, "bridge-host.mjs");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const mode = flag("--install") ? "install" : flag("--uninstall") ? "uninstall" : "dry-run";
const fixture = value("--fixture");
const extensionId = value("--extension-id");
const nodeExecutable = resolve(value("--node") ?? process.execPath);
const hostScript = resolve(value("--host-script") ?? defaultHost);
if (!fixture && mode !== "dry-run" && !extensionId) throw new Error("--extension-id is required; configure the exact installed helper extension ID (no default ID is assumed)");
if (extensionId && !/^[a-p]{32}$/.test(extensionId)) throw new Error("Invalid Chrome extension ID; expected exactly 32 characters a-p");

function manifestDirectory() {
  if (fixture) return resolve(fixture, "NativeMessagingHosts");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? homedir(), "PiBrowserBridge", "NativeMessagingHosts"); // registry registration remains manual
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  return join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");
}
const directory = manifestDirectory();
const manifestPath = directory && join(directory, `${HOST_NAME}.json`);
const manifest = {
  name: HOST_NAME,
  description: "Pi Browser Control Native Messaging host (Node.js >=20)",
  path: nodeExecutable,
  args: [hostScript, "--native"],
  type: "stdio",
  allowed_origins: extensionId ? [`chrome-extension://${extensionId}/`] : ["chrome-extension://<SET_EXACT_32_CHAR_EXTENSION_ID>/"],
};
const registration = platform() === "win32" ? `Windows registry key (not written): HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME} -> manifest path` : null;
if (mode === "uninstall") {
  if (flag("--dry-run") || !fixture && platform() === "win32") {
    console.log(JSON.stringify({ mode: "dry-run", wouldRemove: manifestPath, fixture: Boolean(fixture), registration, writesNothing: true }, null, 2));
  } else {
    await rm(manifestPath, { force: true });
    console.log(JSON.stringify({ mode, manifestPath, fixture: Boolean(fixture), registrationCaveat: registration ? "Per-user Chrome registry registration is intentionally not changed; remove it manually." : undefined }, null, 2));
  }
} else if (mode === "dry-run" || flag("--dry-run")) {
  console.log(JSON.stringify({ mode: "dry-run", manifestPath, manifest, registration, fixture: Boolean(fixture), writesNothing: true }, null, 2));
} else if (fixture) {
  await mkdir(directory, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ mode, manifestPath, fixture: true }, null, 2));
} else {
  await mkdir(directory, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ mode, manifestPath, registration, registrationCaveat: registration ? "Register this manifest path under the per-user Chrome NativeMessagingHosts key yourself; script does not access registry." : "Chrome discovers the per-user manifest from this directory.", restartCaveat: "Restart Chrome after native-host registration; reload/restart the helper extension after changing its files." }, null, 2));
}
