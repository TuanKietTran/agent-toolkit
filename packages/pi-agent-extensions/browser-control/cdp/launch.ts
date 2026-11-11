import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LaunchOptions } from "./contract.ts";
export type { LaunchOptions };
function candidates(): string[] {
  if (process.platform === "darwin") return ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", join(homedir(), "Applications/Brave Browser.app/Contents/MacOS/Brave Browser")];
  if (process.platform === "win32") return ["C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe", join(homedir(), "AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe")];
  return ["/usr/bin/brave", "/usr/bin/brave-browser", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/brave"];
}
export function resolveBravePath(): string | undefined { const env = process.env.PI_BC_BRAVE; if (env && existsSync(env)) return env; return candidates().find((p) => existsSync(p)); }
export async function launchBrave(o?: LaunchOptions): Promise<{ pid: number; port: number; profileDir: string }> {
  const bravePath = o?.bravePath ?? resolveBravePath();
  if (!bravePath) throw new Error("Brave not found (set PI_BC_BRAVE)");
  const port = o?.port ?? (process.env.PI_BC_PORT ? Number(process.env.PI_BC_PORT) : 9222);
  const profileDir = o?.profileDir ?? join(homedir(), ".pi", "browser-control-cdp", "profile");
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(bravePath, ["--remote-debugging-port=" + port, "--remote-debugging-address=127.0.0.1", "--user-data-dir=" + profileDir, "--no-first-run", "--no-default-browser-check"], { detached: true, stdio: "ignore" });
  child.unref();
  const pid = child.pid ?? 0;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { try { const r = await fetch("http://127.0.0.1:" + port + "/json/version", { signal: AbortSignal.timeout(1000) }); if (r.ok) return { pid, port, profileDir }; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("Brave did not open debugging port " + port + " within 10s");
}
