import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/** Stable per-user local endpoint shared by the interactive broker and native host. */
export function defaultSocketPath() {
  if (process.platform === "win32") {
    let who;
    const whoami = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "whoami.exe");
    try { who = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { throw new Error("Cannot determine current Windows user SID for bridge IPC"); }
    const sid = who.match(/S-\d-\d+(?:-\d+)+/i)?.[0];
    if (!sid) throw new Error("Current Windows user SID was not available");
    const digest = createHash("sha256").update(sid.toUpperCase()).digest("hex").slice(0, 32);
    return `\\\\.\\pipe\\pi-browser-bridge-${digest}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!Number.isInteger(uid)) throw new Error("Cannot determine current user ID for bridge IPC");
  return join(process.env.XDG_RUNTIME_DIR || "/tmp", `pi-browser-bridge-${uid}.sock`);
}

export function defaultConfigPath() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(process.env.USERPROFILE || homedir(), "AppData", "Local"), "PiBrowserBridge", "host-config.json");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pi-browser-bridge", "host-config.json");
}

export function resolveSocketPath(explicit) {
  if (explicit) return explicit;
  // This environment override is deliberately gated to prevent ambient browser/user
  // environment from silently selecting a production IPC endpoint.
  if (process.env.PI_BROWSER_BRIDGE_SOCKET) {
    if (process.env.PI_BROWSER_BRIDGE_TEST_MODE !== "1") throw new Error("PI_BROWSER_BRIDGE_SOCKET is test-only; set PI_BROWSER_BRIDGE_TEST_MODE=1 for fixtures");
    return process.env.PI_BROWSER_BRIDGE_SOCKET;
  }
  return defaultSocketPath();
}
