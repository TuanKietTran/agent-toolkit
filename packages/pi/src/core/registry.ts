import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtManifest, InstallerPlugin, LoadedExt } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Where extensions are discovered, in order:
 *   1. <repo>/exts        — the bundled extensions (or dist/exts once built)
 *   2. ~/.pi/exts         — user-dropped extensions
 *   3. $PI_EXTS_PATH      — extra roots, path-separator delimited
 *
 * The layout is symmetric: src/core/registry.ts resolves ../../exts to
 * <repo>/exts, and dist/src/core/registry.js resolves it to dist/exts.
 */
export function extRoots(): string[] {
  const roots = [resolve(here, "..", "..", "exts"), join(homedir(), ".pi", "exts")];
  const extra = process.env.PI_EXTS_PATH;
  if (extra) {
    for (const p of extra.split(process.platform === "win32" ? ";" : ":")) {
      if (p.trim()) roots.push(isAbsolute(p) ? p : resolve(process.cwd(), p));
    }
  }
  return roots.filter((r) => existsSync(r) && statSync(r).isDirectory());
}

function entryFile(dir: string, base: string): string | undefined {
  for (const ext of [".js", ".ts", ".mjs"]) {
    const candidate = join(dir, base + ext);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export class ExtLoadError extends Error {
  constructor(readonly extDir: string, message: string) {
    super(message);
    this.name = "ExtLoadError";
  }
}

async function loadOne(dir: string): Promise<LoadedExt> {
  const manifestFile = entryFile(dir, "manifest");
  const indexFile = entryFile(dir, "index");
  if (!manifestFile) throw new ExtLoadError(dir, `no manifest.(ts|js) in ${dir}`);
  if (!indexFile) throw new ExtLoadError(dir, `no index.(ts|js) in ${dir}`);

  const manifestMod = (await import(pathToFileURL(manifestFile).href)) as {
    manifest?: ExtManifest;
    default?: ExtManifest;
  };
  const manifest = manifestMod.manifest ?? manifestMod.default;
  if (!manifest?.name || !manifest.version) {
    throw new ExtLoadError(dir, `${manifestFile}: must export "manifest" with name and version`);
  }

  const pluginMod = (await import(pathToFileURL(indexFile).href)) as {
    plugin?: InstallerPlugin;
    default?: InstallerPlugin;
  };
  const plugin = pluginMod.plugin ?? pluginMod.default;
  if (!plugin || typeof plugin.check !== "function" || typeof plugin.install !== "function") {
    throw new ExtLoadError(dir, `${indexFile}: must export "plugin" with check() and install()`);
  }
  if (plugin.name !== manifest.name) {
    throw new ExtLoadError(
      dir,
      `name mismatch: manifest says "${manifest.name}", plugin says "${plugin.name}"`,
    );
  }
  return { manifest, plugin, dir };
}

export class Registry {
  private constructor(private readonly exts: Map<string, LoadedExt>, readonly errors: ExtLoadError[]) {}

  static async load(roots: string[] = extRoots()): Promise<Registry> {
    const exts = new Map<string, LoadedExt>();
    const errors: ExtLoadError[] = [];
    for (const root of roots) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        // Skip build leftovers and anything without an entry point.
        if (!entryFile(dir, "manifest")) continue;
        try {
          const loaded = await loadOne(dir);
          // First root wins, so bundled extensions are not shadowed silently.
          if (!exts.has(loaded.manifest.name)) exts.set(loaded.manifest.name, loaded);
        } catch (err) {
          errors.push(
            err instanceof ExtLoadError ? err : new ExtLoadError(dir, (err as Error).message),
          );
        }
      }
    }
    return new Registry(exts, errors);
  }

  list(): LoadedExt[] {
    return [...this.exts.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  has(name: string): boolean {
    return this.exts.has(name);
  }

  get(name: string): LoadedExt {
    const ext = this.exts.get(name);
    if (!ext) {
      const known = this.list().map((e) => e.manifest.name);
      const near = known.filter((n) => n.includes(name) || name.includes(n) || n === `${name}-ext`);
      throw new Error(
        `unknown extension "${name}".` +
          (near.length ? `\n  did you mean: ${near.join(", ")}?` : "") +
          `\n  available: ${known.join(", ") || "(none)"}`,
      );
    }
    return ext;
  }

  /**
   * Deep prerequisites for an extension, dependency-first order.
   * Runtime relationship only: nothing here imports anything.
   */
  requirementsOf(name: string): LoadedExt[] {
    const out: LoadedExt[] = [];
    const seen = new Set<string>();
    const stack: string[] = [];

    const visit = (current: string): void => {
      if (stack.includes(current)) {
        throw new Error(`circular requires: ${[...stack, current].join(" -> ")}`);
      }
      stack.push(current);
      const ext = this.get(current);
      for (const req of ext.manifest.requires ?? []) {
        if (!this.has(req)) {
          throw new Error(
            `${current} requires "${req}", which is not installed in this pi.\n` +
              `  extensions found: ${this.list().map((e) => e.manifest.name).join(", ")}`,
          );
        }
        visit(req);
      }
      stack.pop();
      if (current !== name && !seen.has(current)) {
        seen.add(current);
        out.push(ext);
      }
    };

    visit(name);
    return out;
  }
}
