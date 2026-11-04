// Finding `agent-cli-lab` from a desktop app. An app started from Finder or the Start menu does not
// get the PATH of a shell, so a plain lookup misses the places `cargo install` and Homebrew use.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const flavour = (platform) => (platform === "win32" ? path.win32 : path.posix);

export function binaryName(platform = process.platform) {
  return platform === "win32" ? "agent-cli-lab.exe" : "agent-cli-lab";
}

/** Directories searched after PATH, most likely first. */
export function extraDirs({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const p = flavour(platform);
  if (platform === "win32") {
    return [p.join(home, ".cargo", "bin"), env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, "Programs", "agent-cli-lab"), env.ProgramFiles && p.join(env.ProgramFiles, "agent-cli-lab")].filter(Boolean);
  }
  return [p.join(home, ".local", "bin"), p.join(home, ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
}

/** @returns {string | null} full path of the binary, or null when it cannot be found */
export function findLabBinary({ env = process.env, platform = process.platform, home = homedir(), exists = existsSync } = {}) {
  const p = flavour(platform);
  const explicit = env.AGENT_CLI_LAB_BIN?.trim();
  if (explicit) return exists(explicit) ? explicit : null;
  const sep = platform === "win32" ? ";" : ":";
  const dirs = [...(env.PATH ?? env.Path ?? "").split(sep).filter(Boolean), ...extraDirs({ platform, home, env })];
  for (const dir of dirs) {
    const candidate = p.join(dir, binaryName(platform));
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Environment for the lab binary and what it starts (pi, claude, ...): PATH widened with the same places. */
export function labEnv({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const sep = platform === "win32" ? ";" : ":";
  const key = platform === "win32" && env.Path !== undefined && env.PATH === undefined ? "Path" : "PATH";
  const have = (env[key] ?? "").split(sep).filter(Boolean);
  const merged = [...have, ...extraDirs({ platform, home, env }).filter((d) => !have.includes(d))];
  return { ...env, [key]: merged.join(sep) };
}
