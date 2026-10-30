#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const socketPath = value("--socket") ?? await (async () => {
  const modulePath = resolve(here, "ipc-path.mjs");
  try { const { defaultSocketPath } = await import(pathToFileURL(modulePath)); return defaultSocketPath(); }
  catch { throw new Error("Default socket endpoint requires the transport-owned native-host/ipc-path.mjs; use --socket only for an isolated fixture"); }
})();
const windowsLauncher = platform() === "win32";
if (!fixture && mode !== "dry-run" && !extensionId) throw new Error("--extension-id is required; configure the exact installed helper extension ID (no default ID is assumed)");
if (extensionId && !/^[a-p]{32}$/.test(extensionId)) throw new Error("Invalid Chrome extension ID; expected exactly 32 characters a-p");

function manifestDirectory() {
  if (fixture) return resolve(fixture, "NativeMessagingHosts");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? homedir(), "PiBrowserBridge", "NativeMessagingHosts"); // registry registration remains manual
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  return join(homedir(), ".config", "google-chrome", "NativeMessagingHosts");
}
const directory = manifestDirectory();
const manifestPath = join(directory, `${HOST_NAME}.json`);
const windowsInstallRoot = windowsLauncher ? join(fixture ?? process.env.LOCALAPPDATA ?? homedir(), "PiBrowserBridge") : directory;
const launcherPath = windowsLauncher ? join(windowsInstallRoot, "bridge-launcher.exe") : join(directory, "bridge-launcher.sh");
const configPath = join(windowsInstallRoot, "host-config.json");
const manifest = {
  name: HOST_NAME,
  description: "Pi Browser Control Native Messaging host (Node.js >=20)",
  path: launcherPath,
  type: "stdio",
  allowed_origins: extensionId ? [`chrome-extension://${extensionId}/`] : ["chrome-extension://<SET_EXACT_32_CHAR_EXTENSION_ID>/"],
};
const registration = platform() === "win32" ? `Windows registry key (not written): HKEY_CURRENT_USER\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME} -> manifest path` : null;
function currentSid() {
  const whoami = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "whoami.exe");
  const output = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const sid = output.match(/S-\d-\d+(?:-\d+)+/i)?.[0];
  if (!sid) throw new Error("Unable to determine current user SID for secure config ACL");
  return sid;
}
let cachedSid;
function secureWindowsPath(path, directoryPath = false) {
  const icacls = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "icacls.exe");
  cachedSid ??= currentSid();
  const grant = directoryPath ? `*${cachedSid}:(OI)(CI)F` : `*${cachedSid}:F`;
  execFileSync(icacls, [path, "/inheritance:r", "/grant:r", grant], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
}
async function compileWindowsLauncher() {
  const framework = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  const defaultCsc = join(framework, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const csc = value("--csc") ?? defaultCsc;
  const result = await new Promise((resolveResult) => {
    const child = spawn(csc, ["-nologo", "-target:exe", "-reference:System.Web.Extensions.dll", `-out:${launcherPath}`, join(here, "bridge-launcher.cs")], { stdio: ["ignore", "pipe", "pipe"] });
    let error = ""; child.stdout.on("data", (chunk) => { error += chunk; }); child.stderr.on("data", (chunk) => { error += chunk; });
    child.once("error", (e) => resolveResult({ ok: false, error: e.message }));
    child.once("exit", (code) => resolveResult({ ok: code === 0, error }));
  });
  if (!result.ok) throw new Error(`Windows launcher compilation failed (${result.error}); provide .NET Framework csc.exe via --csc`);
}
async function writeInstallFiles() {
  await mkdir(directory, { recursive: true });
  if (windowsLauncher) secureWindowsPath(directory, true);
  if (windowsLauncher) {
    await mkdir(windowsInstallRoot, { recursive: true });
    secureWindowsPath(windowsInstallRoot, true);
    await writeFile(configPath, `${JSON.stringify({ nodeExecutable, hostScript, socketPath }, null, 2)}\n`, { mode: 0o600 });
    secureWindowsPath(configPath);
    await compileWindowsLauncher();
  } else {
    const shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
    await writeFile(launcherPath, `#!/bin/sh\nexec ${shellQuote(nodeExecutable)} ${shellQuote(hostScript)} --native\n`, { mode: 0o700 });
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
if (mode === "uninstall") {
  if (flag("--dry-run")) {
    console.log(JSON.stringify({ mode: "dry-run", wouldRemove: manifestPath, fixture: Boolean(fixture), registration, writesNothing: true }, null, 2));
  } else {
    await Promise.all([manifestPath, launcherPath, ...(windowsLauncher ? [configPath] : [])].map((path) => rm(path, { force: true })));
    console.log(JSON.stringify({ mode, manifestPath, fixture: Boolean(fixture), registrationCaveat: registration ? "Per-user Chrome registry registration is intentionally not changed; remove it manually." : undefined }, null, 2));
  }
} else if (mode === "dry-run" || flag("--dry-run")) {
  console.log(JSON.stringify({ mode: "dry-run", manifestPath, manifest, registration, fixture: Boolean(fixture), writesNothing: true }, null, 2));
} else {
  await writeInstallFiles();
  console.log(JSON.stringify({ mode, manifestPath, launcherPath, configPath: windowsLauncher ? configPath : undefined, fixture: Boolean(fixture), registration, registrationCaveat: registration ? "Register this manifest path under the per-user Chrome NativeMessagingHosts key yourself; script does not access registry." : "Chrome discovers the per-user manifest from this directory.", restartCaveat: "Restart Chrome after native-host registration; reload/restart the helper extension after changing its files." }, null, 2));
}
