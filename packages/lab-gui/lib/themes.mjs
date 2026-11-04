// Themes live in themes/<name>/colors.toml, the same layout and keys Omarchy uses, so a theme
// can be copied in from there (or from anywhere) as is. The files are flat `key = "value"`.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { REQUIRED_KEYS } from "../public/theme.js";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Flat TOML subset: `key = "value"`, comments and blank lines. Anything else is ignored. */
export function parseColors(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(raw);
    if (m) out[m[1]] = m[2] ?? m[3];
  }
  return out;
}

export async function loadThemes(dir) {
  const themes = [];
  let names = [];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name).sort();
  } catch {
    return themes;
  }
  for (const name of names) {
    try {
      const colors = parseColors(await readFile(join(dir, name, "colors.toml"), "utf8"));
      if (REQUIRED_KEYS.every((k) => colors[k]) && ["dark", "light"].includes(colors.mode)) {
        themes.push({ name, title: name.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "), mode: colors.mode, colors });
      }
    } catch {
      /* a theme directory without a readable palette is skipped */
    }
  }
  return themes;
}
