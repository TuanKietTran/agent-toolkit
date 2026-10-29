#!/usr/bin/env node
// Per-package task runner. No dependencies; Node >= 20.
//   node tools/pkg.mjs list
//   node tools/pkg.mjs changed [base-ref]            # packages touched since base (default origin/main)
//   node tools/pkg.mjs <install|check|test|build|ci> <pkg...|--changed [base]|--all>
//   node tools/pkg.mjs matrix [base-ref]             # JSON matrix for CI (changed packages only)
import { readFileSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { packages } = JSON.parse(readFileSync(join(root, "packages.json"), "utf8"));
const names = Object.keys(packages);
const VERBS = ["install", "check", "test", "build"];
const GLOBAL_TRIGGERS = ["packages.json", "tools/", ".github/workflows/"];

const die = (m) => { console.error(m); process.exit(2); };

function changedPackages(base = "origin/main") {
  let files;
  try {
    const mergeBase = execSync(`git merge-base ${base} HEAD`, { cwd: root }).toString().trim();
    files = execSync(`git diff --name-only ${mergeBase}`, { cwd: root }).toString().split("\n").filter(Boolean);
  } catch { die(`cannot diff against ${base}`); }
  if (files.some((f) => GLOBAL_TRIGGERS.some((g) => f === g || f.startsWith(g)))) return names;
  const hit = new Set(files.map((f) => /^packages\/([^/]+)\//.exec(f)?.[1]).filter(Boolean));
  // pull in dependents (transitively)
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of names)
      if (!hit.has(n) && (packages[n].dependsOn ?? []).some((d) => hit.has(d))) { hit.add(n); grew = true; }
  }
  return names.filter((n) => hit.has(n) && existsSync(join(root, "packages", n)));
}

function run(pkg, verb) {
  const cmd = packages[pkg][verb];
  if (!cmd) { console.log(`- ${pkg}: no '${verb}' (skipped)`); return true; }
  console.log(`\n▶ ${pkg}: ${verb}  (${cmd})`);
  return spawnSync(cmd, { cwd: join(root, "packages", pkg), shell: true, stdio: "inherit" }).status === 0;
}

const [verb, ...rest] = process.argv.slice(2);
if (!verb) die("usage: pkg.mjs list | changed | matrix | <install|check|test|build|ci> <pkg...|--changed|--all>");

if (verb === "list") { for (const n of names) console.log(n); process.exit(0); }
if (verb === "changed") { for (const n of changedPackages(rest[0])) console.log(n); process.exit(0); }
if (verb === "matrix") {
  const include = changedPackages(rest[0]).filter((n) => VERBS.some((v) => packages[n][v]))
    .map((n) => ({ package: n, os: packages[n].os ?? "ubuntu-latest", toolchain: packages[n].toolchain ?? "none" }));
  console.log(JSON.stringify({ include })); process.exit(0);
}

const verbs = verb === "ci" ? VERBS : VERBS.includes(verb) ? [verb] : die(`unknown command '${verb}'`);
let targets;
if (rest[0] === "--all") targets = names;
else if (rest[0] === "--changed") targets = changedPackages(rest[1]);
else targets = rest;
if (!targets.length) die("no packages selected (name one, or use --changed / --all)");
for (const t of targets) if (!packages[t]) die(`unknown package '${t}' (try: list)`);

const failed = [];
for (const t of targets) for (const v of verbs) if (!run(t, v)) { failed.push(`${t}:${v}`); break; }
if (failed.length) { console.error(`\n✗ failed: ${failed.join(", ")}`); process.exit(1); }
console.log(`\n✓ ok: ${targets.join(", ")}`);
