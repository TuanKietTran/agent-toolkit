// Starts the desktop app against fake labs held in a throwaway directory and checks it paints them.
// node scripts/smoke.mjs [path-to-packaged-app-executable]   (default: electron from node_modules)
// Uses real throwaway labs, so it needs an h1 binary; it starts two tiny hosts and stops them.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { findLabBinary } from "../lib/binary.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lab = findLabBinary();
if (!lab) {
  console.error("smoke: h1 not found");
  process.exit(2);
}
const exe = process.argv[2] ?? createRequire(import.meta.url)("electron");
// Unix sockets have a short path limit, so the lab directory sits right under the temp root.
const labDir = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "ld-"));
const png = join(labDir, "smoke.png");
const env = { ...process.env, H1_DIR: labDir, H1_BIN: lab, LAB_GUI_DESKTOP_SMOKE: png };
delete env.H1_SELF;
const idle = process.platform === "win32" ? ["cmd", "/c", "ping -n 600 127.0.0.1 >nul"] : ["sleep", "600"];
let code = 1;
try {
  for (const [name, role, parent] of [["smoke-lead", "builder"], ["smoke-helper", "explorer", "smoke-lead"]]) {
    const args = ["open", "--detached", "-n", name, "--role", role, ...(parent ? ["--parent", parent] : []), "--", ...idle];
    const r = spawnSync(lab, args, { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`could not open ${name}: ${r.stderr}`);
  }
  const child = spawn(exe, process.argv[2] ? [] : [root], { env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  code = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
  console.log(out.trim());
  if (code === 0 && !(existsSync(png) && statSync(png).size > 2000)) code = 1;
} finally {
  for (const name of ["smoke-helper", "smoke-lead"]) spawnSync(lab, ["stop", "-n", name], { env, stdio: "ignore" });
  rmSync(labDir, { recursive: true, force: true });
}
console.log(code === 0 ? "smoke: ok" : `smoke: failed (exit ${code})`);
process.exit(code);
