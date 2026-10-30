import { readFile, stat } from "node:fs/promises";
import { defaultConfigPath, resolveSocketPath } from "./ipc-path.mjs";

const allowed = new Set(["nodeExecutable", "hostScript", "socketPath"]);
export async function loadRuntimeConfig(path, { required = false } = {}) {
  if (!path && process.platform === "win32") path = defaultConfigPath();
  if (!path) {
    if (required) throw new Error("Native host runtime config path is required");
    return { socketPath: resolveSocketPath() };
  }
  let info;
  try { info = await stat(path); }
  catch (error) { if (!required && error.code === "ENOENT") return { socketPath: resolveSocketPath() }; throw error; }
  if (process.platform !== "win32") {
    if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("Runtime config must be current-user owned and mode 0600");
  }
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > 16 * 1024) throw new Error("Runtime config exceeds 16 KiB");
  let config;
  try { config = JSON.parse(text); } catch { throw new Error("Runtime config is malformed JSON"); }
  if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some((key) => !allowed.has(key))) throw new Error("Runtime config contains unknown fields");
  if (config.socketPath !== undefined && (typeof config.socketPath !== "string" || !config.socketPath)) throw new Error("Runtime config socketPath must be a non-empty string");
  const socketPath = resolveSocketPath(config.socketPath);
  const local = process.platform === "win32" ? socketPath.startsWith("\\\\.\\pipe\\") : socketPath.startsWith("/");
  if (!local) throw new Error("Runtime config may only specify local IPC endpoints");
  return { ...config, socketPath };
}
