import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtConfig } from "./types.js";

/**
 * Config for one extension, merged lowest to highest precedence:
 *   1. ~/.pi/config.json    { "<ext>": { "<key>": "<value>" } }
 *   2. PI_<EXT>_<KEY> environment variables (dashes become underscores)
 *   3. --set key=value flags
 */
export function loadConfig(extName: string, overrides: Record<string, string>): ExtConfig {
  const merged: Record<string, string> = {
    ...fromFile(extName),
    ...fromEnv(extName),
    ...overrides,
  };

  return {
    all: () => ({ ...merged }),
    get: (key) => merged[key],
    require: (key) => {
      const v = merged[key];
      if (v === undefined || v === "") {
        throw new Error(
          `${extName}: missing required config "${key}".\n` +
            `  set it inline:  pi install ${extName} --set ${key}=<value>\n` +
            `  or persist it:  ${configPath()}  ->  { "${extName}": { "${key}": "<value>" } }`,
        );
      }
      return v;
    },
    string: (key, fallback) => merged[key] ?? fallback,
    bool: (key, fallback) => {
      const v = merged[key];
      if (v === undefined) return fallback;
      return ["1", "true", "yes", "on"].includes(v.toLowerCase());
    },
    list: (key, fallback = []) => {
      const v = merged[key];
      if (v === undefined || v.trim() === "") return fallback;
      return v.split(",").map((s) => s.trim()).filter(Boolean);
    },
  };
}

export function configPath(): string {
  return process.env.PI_CONFIG ?? join(homedir(), ".pi", "config.json");
}

function fromFile(extName: string): Record<string, string> {
  const path = configPath();
  if (!existsSync(path)) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`could not read config ${path}: ${(err as Error).message}`);
  }
  const section = parsed[extName];
  if (!section || typeof section !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(section as Record<string, unknown>)) {
    if (v !== null && v !== undefined) out[k] = String(v);
  }
  return out;
}

function fromEnv(extName: string): Record<string, string> {
  const prefix = `PI_${extName.replace(/-/g, "_").toUpperCase()}_`;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k.startsWith(prefix)) {
      out[k.slice(prefix.length).toLowerCase().replace(/_/g, "-")] = v;
    }
  }
  return out;
}
