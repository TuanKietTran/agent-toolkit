import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "./session.ts";

export const DEFAULT_BASE_URL = "http://pi4:8766/v1";
export const CONFIG_FILE = join(homedir(), ".pi", "agent", "muse-proxy.json");

export interface MuseConfig {
  baseUrl: string;
  apiKey: string;
  maxChars: number;
  rotateTurns: number;
  minGapMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, file = CONFIG_FILE): MuseConfig {
  let fromFile: { baseUrl?: string; apiKey?: string } = {};
  try {
    if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`muse-proxy: cannot parse ${file}`);
  }
  const apiKey = env.PI_MUSE_PROXY_KEY ?? fromFile.apiKey ?? "";
  if (!apiKey) {
    throw new Error(
      `muse-proxy: no API key. Set PI_MUSE_PROXY_KEY or put {"baseUrl","apiKey"} in ${file}.`,
    );
  }
  const baseUrl = (env.PI_MUSE_PROXY_URL ?? fromFile.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const maxChars = Number.parseInt(env.PI_MUSE_PROXY_MAX_CHARS ?? "", 10);
  const rotate = Number.parseInt(env.PI_MUSE_PROXY_ROTATE_TURNS ?? "", 10);
  const gap = Number.parseInt(env.PI_MUSE_PROXY_MIN_GAP_MS ?? "", 10);
  return {
    baseUrl,
    apiKey,
    maxChars: Number.isFinite(maxChars) && maxChars > 1000 ? maxChars : DEFAULT_LIMITS.maxChars,
    rotateTurns: Number.isFinite(rotate) && rotate >= 2 ? rotate : DEFAULT_LIMITS.rotateTurns ?? 14,
    minGapMs: Number.isFinite(gap) && gap >= 0 ? gap : 1500,
  };
}

export function errorMessageFromBody(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body);
    const detail = parsed?.error?.message ?? parsed?.message ?? parsed?.detail;
    if (typeof detail === "string" && detail) return `muse-proxy ${status}: ${detail}`;
  } catch { /* not JSON */ }
  return `muse-proxy ${status}: ${body.slice(0, 300) || "empty response"}`;
}
