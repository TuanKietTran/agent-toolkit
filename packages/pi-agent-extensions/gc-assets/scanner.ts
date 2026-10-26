import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi reloads extensions in-process on session switch/fork; globalThis survives,
// so the scan timer and cached results live here to keep one poller per process.
// --- Constants: every local literal lives here. ---

const STATE_KEY = Symbol.for("pi.gc-assets.state.v1");
const DAY_MS = 86_400_000;
const CONFIG_FILE = "config.md";
const ENCODING = "utf8";
const JSON_BLOCK = /```json\s*\n([\s\S]*?)```/;
const TOKEN_TMP = "{tmp}";
const TOKEN_AGENT = "{agent}";
const TOKEN_HOME = "{home}";
const AGENT_SUBDIR = [".pi", "agent"];
const PREFIX_WILDCARD = "*";
const SWEEP_NEVER = "never";

export type Sweep = "auto" | "confirm" | "never";

export type CategoryDef = { id: string; label: string; sweep: Sweep; roots: string[]; exclude?: string[] };

export type GcConfig = { tick_ms: number; max_files: number; age_days: number; categories: CategoryDef[] };

export type Category = {
  id: string;
  label: string;
  sweep: Sweep;
  files: number;
  bytes: number;
  staleFiles: number;
  staleBytes: number;
  stale: string[];
  truncated: boolean;
};

export type GcState = {
  timer?: ReturnType<typeof setInterval>;
  ctx?: ExtensionContext;
  categories: Category[];
  ageDays?: number;
  scannedAt?: number;
  scanning: boolean;
  lastGc?: { at: number; freedBytes: number };
  lastSweep?: { at: number; files: number; bytes: number };
};

const globals = globalThis as typeof globalThis & { [STATE_KEY]?: GcState };
export const state: GcState = (globals[STATE_KEY] ??= { categories: [], scanning: false });

const EMPTY: GcConfig = { tick_ms: 60_000, max_files: 50_000, age_days: 7, categories: [] };

/** All tunables and category roots come from config.md. */
export function loadConfig(): GcConfig {
  try {
    const md = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), CONFIG_FILE), ENCODING);
    const m = md.match(JSON_BLOCK);
    return m ? { ...EMPTY, ...JSON.parse(m[1]) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function ageDays(cfg: GcConfig = loadConfig()): number {
  return state.ageDays ?? cfg.age_days;
}

function resolveToken(spec: string): string {
  return spec
    .replace(TOKEN_TMP, os.tmpdir())
    .replace(TOKEN_AGENT, path.join(os.homedir(), ...AGENT_SUBDIR))
    .replace(TOKEN_HOME, os.homedir());
}

async function expandRoots(def: CategoryDef): Promise<string[]> {
  const out: string[] = [];
  for (const spec of def.roots) {
    const p = resolveToken(spec);
    if (!p.endsWith(PREFIX_WILDCARD)) {
      out.push(p);
      continue;
    }
    const dir = path.dirname(p);
    const prefix = path.basename(p).slice(0, -1);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const name of names) if (name.startsWith(prefix)) out.push(path.join(dir, name));
  }
  const excluded = new Set((def.exclude ?? []).map(resolveToken));
  return out.filter((p) => !excluded.has(p));
}

async function walk(root: string, visit: (file: string, size: number, mtimeMs: number) => void, budget: { left: number }): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    // A root can be a single file, or missing entirely.
    try {
      const stat = await fs.lstat(root);
      if (stat.isFile()) visit(root, stat.size, stat.mtimeMs);
    } catch {}
    return;
  }
  for (const entry of entries) {
    if (budget.left <= 0) return;
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(full, visit, budget);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(full);
      budget.left--;
      visit(full, stat.size, stat.mtimeMs);
    } catch {}
  }
}

/** Pure scan: no shared state touched, so the dev replay can run it on a scratch config. */
export async function scanCategories(cfg: GcConfig, age: number): Promise<Category[]> {
  const cutoff = Date.now() - age * DAY_MS;
  const result: Category[] = [];
  for (const def of cfg.categories) {
    const category: Category = { id: def.id, label: def.label, sweep: def.sweep, files: 0, bytes: 0, staleFiles: 0, staleBytes: 0, stale: [], truncated: false };
    const budget = { left: cfg.max_files };
    for (const root of await expandRoots(def)) {
      await walk(
        root,
        (file, size, mtimeMs) => {
          category.files++;
          category.bytes += size;
          if (def.sweep !== SWEEP_NEVER && mtimeMs < cutoff) {
            category.staleFiles++;
            category.staleBytes += size;
            category.stale.push(file);
          }
        },
        budget,
      );
    }
    category.truncated = budget.left <= 0;
    result.push(category);
  }
  return result;
}

export async function scan(): Promise<void> {
  if (state.scanning) return;
  state.scanning = true;
  try {
    const cfg = loadConfig();
    state.categories = await scanCategories(cfg, ageDays(cfg));
    state.scannedAt = Date.now();
  } finally {
    state.scanning = false;
  }
}

export async function sweep(categories: Category[], age: number): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const cutoff = Date.now() - age * DAY_MS;
  for (const category of categories) {
    for (const file of category.stale) {
      try {
        // Re-stat: a file may have been touched since the scan.
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        await fs.unlink(file);
        files++;
        bytes += stat.size;
      } catch {}
    }
  }
  return { files, bytes };
}
