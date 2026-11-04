import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadThemes, parseColors } from "../lib/themes.mjs";
import { contrast, ensureContrast, hexToRgb, mix, readableOn, themeVars } from "../public/theme.js";

const THEMES_DIR = fileURLToPath(new URL("../themes", import.meta.url));

test("colour maths: contrast of black on white is 21, mixing is linear", () => {
  assert.equal(Math.round(contrast("#000000", "#ffffff")), 21);
  assert.deepEqual(hexToRgb("#102030"), [16, 32, 48]);
  assert.equal(mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(readableOn("#ffffff"), "#000000");
  assert.equal(readableOn("#101010"), "#ffffff");
});

test("ensureContrast leaves good colours alone and rescues poor ones", () => {
  assert.equal(ensureContrast("#ffffff", ["#000000"], "#ffffff"), "#ffffff");
  const fixed = ensureContrast("#414868", ["#1a1b26"], "#c0caf5");
  assert.ok(contrast(fixed, "#1a1b26") >= 4.5);
});

test("parseColors reads the flat palette format and ignores the rest", () => {
  const c = parseColors('# comment\nmode = "dark"\n\naccent = "#7aa2f7"  # inline\n[section]\nname = \'x\'\nnot a pair\n');
  assert.deepEqual(c, { mode: "dark", accent: "#7aa2f7", name: "x" });
});

test("a theme missing a required key is refused by the template and skipped by the loader", async () => {
  assert.throws(() => themeVars({ mode: "dark" }), /missing/);
  const dir = await mkdtemp(join(tmpdir(), "themes-"));
  try {
    await mkdir(join(dir, "broken"));
    await writeFile(join(dir, "broken", "colors.toml"), 'mode = "dark"\n');
    await mkdir(join(dir, "Bad_Name"));
    assert.deepEqual(await loadThemes(dir), []);
    assert.deepEqual(await loadThemes(join(dir, "nope")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every shipped theme loads and every colour the page uses is readable (WCAG AA)", async () => {
  const themes = await loadThemes(THEMES_DIR);
  assert.ok(themes.length >= 20, `only ${themes.length} themes found`);
  for (const theme of themes) {
    const v = themeVars(theme.colors);
    const grounds = [v["--bg"], v["--surface"], v["--raised"]];
    for (const key of ["--text", "--muted", "--focus", "--builder", "--explorer", "--advisor", "--commander", "--manager", "--worker", "--lab", "--working", "--asking", "--stalled", "--gone", "--danger"]) {
      for (const ground of grounds) assert.ok(contrast(v[key], ground) >= 4.5, `${theme.name}: ${key} ${v[key]} on ${ground} is ${contrast(v[key], ground).toFixed(2)}`);
    }
    assert.ok(contrast(v["--primary-text"], v["--primary"]) >= 4.5, `${theme.name}: button text`);
    assert.ok(contrast(v["--primary"], v["--bg"]) >= 3, `${theme.name}: accent against the page`);
    assert.ok(contrast(v["--line"], v["--bg"]) > 1.2, `${theme.name}: borders are visible`);
    for (const value of Object.values(v)) assert.match(value, /^#[0-9a-f]{6}$/);
  }
});

test("the themes named by the user are present", async () => {
  const names = (await loadThemes(THEMES_DIR)).map((t) => t.name);
  for (const wanted of ["tokyo-night", "catppuccin", "catppuccin-latte", "gruvbox", "nord", "rose-pine", "dracula", "one-dark", "solarized-dark", "solarized-light", "monokai"]) assert.ok(names.includes(wanted), wanted);
});
