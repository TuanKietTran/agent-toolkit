// Shared dev loader: finds the pi package and returns a jiti that resolves pi's own
// modules, so core/*.ts can be imported outside of pi. Set PI_PACKAGE_DIR to override
// the Homebrew layout (e.g. a vendored node_modules/@earendil-works/pi-coding-agent).
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function piRoot() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  try {
    return resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
  } catch {
    const piBin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
    return resolve(dirname(piBin), "../libexec/lib/node_modules/@earendil-works/pi-coding-agent");
  }
}

export async function createLoader(parentUrl) {
  const root = piRoot();
  const require = createRequire(join(root, "package.json"));
  const { createJiti } = await import(pathToFileURL(require.resolve("jiti")).href);
  return createJiti(parentUrl, {
    alias: {
      "@earendil-works/pi-coding-agent": fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
      "@earendil-works/pi-ai": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")),
      "@earendil-works/pi-tui": fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")),
      typebox: require.resolve("typebox"),
    },
  });
}
