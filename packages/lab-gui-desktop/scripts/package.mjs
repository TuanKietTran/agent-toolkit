// Builds the desktop apps with @electron/packager: node scripts/package.mjs [darwin|win32] [arm64|x64]
// Defaults to the current platform and architecture. Output goes to out/ (ignored by git).
// Cross-building win32 from macOS works; the result is not code signed, nor is the macOS app.
import { packager } from "@electron/packager";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stage } from "./stage.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? process.arch;
if (!["darwin", "win32"].includes(platform)) throw new Error(`unsupported platform ${platform} (darwin or win32)`);

const dir = await stage();
const paths = await packager({
  dir,
  out: process.env.LAB_DECK_OUT ?? join(root, "out"),
  name: "Lab Deck",
  appBundleId: "dev.agent-toolkit.lab-deck",
  platform,
  arch,
  overwrite: true,
  asar: true,
  prune: false,
  quiet: true,
});
console.log(paths.join("\n"));
