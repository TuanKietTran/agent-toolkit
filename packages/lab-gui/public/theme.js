// Theme mechanism, modelled on Omarchy's: a theme is a flat `colors.toml` palette (mode, accent,
// background, foreground, red, ...), and one template maps those keys onto the page's CSS
// variables. This module has no DOM access, so the server tests and the page share it.
//
// Palettes come from many sources and not all are comfortable to read as UI text, so every
// derived colour is nudged toward the foreground until it reaches WCAG AA (4.5:1) against the
// page, surface and raised backgrounds.

const HEX = /^#?([0-9a-f]{6})$/i;

export function hexToRgb(hex) {
  const m = HEX.exec(String(hex).trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

export function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `amount` of `b` mixed into `a`. */
export function mix(a, b, amount) {
  const x = hexToRgb(a), y = hexToRgb(b);
  if (!x || !y) return a;
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * amount));
}

/** Move `color` toward `toward` in 4% steps until it has `min` contrast against every background. */
export function ensureContrast(color, backgrounds, toward, min = 4.5) {
  let out = hexToRgb(color) ? color : toward;
  for (let step = 0; step <= 25; step++) {
    if (backgrounds.every((bg) => contrast(out, bg) >= min)) return out;
    out = mix(color, toward, (step + 1) * 0.04);
  }
  return toward;
}

/** The text colour (black or white) that reads best on `background`. */
export const readableOn = (background) => (contrast("#ffffff", background) >= contrast("#000000", background) ? "#ffffff" : "#000000");

export const REQUIRED_KEYS = ["mode", "accent", "background", "foreground", "red", "yellow", "green", "cyan", "blue", "magenta"];

/**
 * The template: palette -> CSS variables of style.css. Missing optional keys fall back to
 * neighbours (no `orange`: use the bright yellow), so a theme can be as small as REQUIRED_KEYS.
 */
export function themeVars(colors) {
  const missing = REQUIRED_KEYS.filter((k) => !colors[k]);
  if (missing.length) throw new Error(`theme is missing: ${missing.join(", ")}`);
  const dark = colors.mode !== "light";
  const bg = colors.background;
  const fg = colors.foreground;
  const surface = mix(bg, fg, dark ? 0.05 : 0.035);
  const raised = mix(bg, fg, dark ? 0.1 : 0.07);
  const line = mix(bg, fg, dark ? 0.24 : 0.2);
  const grounds = [bg, surface, raised];
  const text = ensureContrast(fg, grounds, dark ? "#ffffff" : "#000000", 7);
  const pick = (color, fallback) => ensureContrast(color || fallback, grounds, text, 4.5);
  const primary = ensureContrast(colors.accent, [bg], text, 3);
  const vars = {
    "--bg": bg,
    "--surface": surface,
    "--raised": raised,
    "--line": line,
    "--text": text,
    "--muted": pick(colors.dark_foreground || mix(bg, fg, 0.6), mix(bg, fg, 0.6)),
    "--focus": pick(colors.bright_blue || colors.blue, colors.blue),
    "--builder": pick(colors.orange || colors.bright_yellow || colors.yellow, colors.yellow),
    "--explorer": pick(colors.cyan, colors.cyan),
    "--advisor": pick(colors.magenta, colors.magenta),
    "--commander": pick(colors.light_foreground || fg, fg),
    "--manager": pick(colors.bright_red || colors.red, colors.red),
    "--worker": pick(colors.blue, colors.blue),
    "--lab": pick(colors.dark_foreground || mix(bg, fg, 0.6), mix(bg, fg, 0.6)),
    "--working": pick(colors.green, colors.green),
    "--asking": pick(colors.yellow, colors.yellow),
    "--stalled": pick(colors.orange || colors.bright_yellow, colors.yellow),
    "--gone": pick(colors.red, colors.red),
    "--danger": pick(colors.red, colors.red),
    "--primary": primary,
    "--primary-text": readableOn(primary),
  };
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, hexToRgb(v) ? rgbToHex(hexToRgb(v)) : v]));
}
