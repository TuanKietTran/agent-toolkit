// Minify every extension except core/ into dist/. core/ is copied verbatim: it loads
// rules.md, contexts.md and commands.md at runtime and its prompts must stay readable.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const bridgeProtocol = join(root, "browser-control", "bridge-protocol.mjs");
const keep = new Set(["core", "dist", "node_modules", "scripts", "tests"]);
const skipFile = (path) => /(?:\.test\.(?:ts|mjs)|\/live-[^/]+\.ts)$/.test(path)
  || /(?:^|\/)(?:\.build|target|node_modules)(?:\/|$)/.test(path)
  || /(?:^|\/)(?:\.DS_Store)$/.test(path);

const exists = (path) => stat(path).then(() => true, () => false);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === root && keep.has(entry.name)) continue;
      if (!entry.name.startsWith(".")) yield* walk(path);
    } else if (!skipFile(relative(root, path))) yield path;
  }
}

const isCore = (path) => relative(root, path).split(sep)[0] === "core";

// A relative `.ts` import keeps its extension when it targets core/ (still TypeScript) and
// becomes `.js` when it targets another minified file.
function rewriteImports(code, file) {
  return code.replace(/(from\s*|import\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g, (all, head, quote, spec) =>
    isCore(resolve(dirname(file), `${spec}.ts`)) ? all : `${head}${quote}${spec}.js${quote}`);
}

await rm(out, { recursive: true, force: true });
await cp(join(root, "core"), join(out, "core"), {
  recursive: true,
  filter: (src) => !/\.test\.(?:ts|mjs)$/.test(src) && !/(?:^|[\\/])dev(?:[\\/]|$)/.test(src),
});

let before = 0;
let after = 0;
for await (const file of walk(root)) {
  const rel = relative(root, file);
  const dest = join(out, rel);
  await mkdir(dirname(dest), { recursive: true });
  if (file.endsWith(".ts") && !skipFile(rel)) {
    const source = await readFile(file, "utf8");
    const { code } = await transform(source, { loader: "ts", format: "esm", target: "es2022", minify: true, sourcefile: rel });
    const min = rewriteImports(code, file);
    await writeFile(join(out, rel.replace(/\.ts$/, ".js")), min);
    before += Buffer.byteLength(source);
    after += Buffer.byteLength(min);
  } else if (!/^(package(-lock)?|tsconfig)\.json$/.test(rel)) {
    await cp(file, dest, { recursive: false, preserveTimestamps: true });
  }
}

// The MV3 extension is loaded directly from its unpacked directory, so preserve its
// exact runtime files and put the canonical protocol module beside the service worker.
const helperSource = join(root, "browser-control", "helper-extension");
const helperOut = join(out, "browser-control", "helper-extension");
await mkdir(helperOut, { recursive: true });
const helperRuntimeAssets = ["service-worker.js", "popup.js", "popup.html", "manifest.json", "native-frame.mjs"];
for (const asset of helperRuntimeAssets) {
  await cp(join(helperSource, asset), join(helperOut, asset));
}
await cp(bridgeProtocol, join(out, "browser-control", "bridge-protocol.mjs"));
await cp(bridgeProtocol, join(helperOut, "bridge-protocol.mjs"));
const workerOut = join(helperOut, "service-worker.js");
const worker = await readFile(workerOut, "utf8");
await writeFile(workerOut, worker.replace(/from ([\"'])\.\.\/bridge-protocol\.mjs\1/g, "from $1./bridge-protocol.mjs$1"));

// Manifest for the minified package: every declared entry must have a built counterpart.
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const extensions = [];
for (const entry of pkg.pi.extensions) {
  const min = entry.replace(/\.ts$/, ".js");
  if (await exists(join(out, min))) extensions.push(min);
  else if (await exists(join(out, entry))) extensions.push(entry);
  else throw new Error(`Declared extension entry missing from dist: ${entry}`);
}
await writeFile(join(out, "package.json"), `${JSON.stringify({
  name: `${pkg.name}-min`, version: pkg.version, private: true, type: "module", license: pkg.license,
  dependencies: pkg.dependencies, pi: { extensions },
}, null, 2)}\n`);

const kb = (n) => (n / 1024).toFixed(1);
console.log(`minified ${kb(before)} KB -> ${kb(after)} KB (core/ copied unchanged)`);
console.log(`dist/package.json lists ${extensions.length} of ${pkg.pi.extensions.length} extensions`);
