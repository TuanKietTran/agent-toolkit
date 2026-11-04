// Collects exactly what the packaged app needs into .stage/: this package's entry files plus a
// copy of the lab-gui server (code, page, themes). No node_modules: the app has no runtime dependencies.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const guiSource = join(root, "..", "lab-gui");

export async function stage(target = join(root, ".stage")) {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(
    join(target, "package.json"),
    `${JSON.stringify({ name: pkg.name, productName: "Lab Deck", version: pkg.version, description: pkg.description, type: "module", main: "main.mjs", license: pkg.license }, null, 2)}\n`,
  );
  await cp(join(root, "main.mjs"), join(target, "main.mjs"));
  await cp(join(root, "lib"), join(target, "lib"), { recursive: true });
  for (const dir of ["lib", "public", "themes"]) await cp(join(guiSource, dir), join(target, "gui", dir), { recursive: true });
  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`staged ${await stage()}`);
}
