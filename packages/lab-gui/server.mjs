#!/usr/bin/env node
// Local web GUI for agent-cli-lab. One command: `node server.mjs --open` (or `npm start`).
// Binds 127.0.0.1 only. No external requests, no telemetry.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadRemoteKey, startGui } from "./lib/serve.mjs";

function parseArgs(argv) {
  const opts = { port: Number(process.env.LAB_GUI_PORT) || 4317, open: false, listen: undefined, control: false, rotate: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") opts.port = Number(argv[++i]);
    else if (a === "--open") opts.open = true;
    else if (a === "--listen") opts.listen = argv[++i];
    else if (a === "--allow-control") opts.control = true;
    else if (a === "--new-key") opts.rotate = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: lab-gui [--port N] [--open] [--listen ADDR [--allow-control] [--new-key]]\n  Serves the lab board on http://127.0.0.1:N (default 4317; 0 picks a free port).\n  --listen ADDR  also serve the native phone/desktop clients on ADDR (for example a VPN address);\n                 clients authenticate with a saved pairing key, read-only unless --allow-control.\n                 The connection is plain HTTP: use a private network or an SSH tunnel.\n  Reads labs through the agent-cli-lab binary on PATH (override with AGENT_CLI_LAB_BIN);\n  AGENT_CLI_LAB_DIR selects which labs it sees.");
      process.exit(0);
    } else {
      console.error(`lab-gui: unknown option ${a}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error("lab-gui: --port must be 0-65535");
    process.exit(2);
  }
  if (opts.listen !== undefined && !opts.listen) {
    console.error("lab-gui: --listen needs an address");
    process.exit(2);
  }
  if ((opts.control || opts.rotate) && !opts.listen) {
    console.error("lab-gui: --allow-control and --new-key only apply with --listen");
    process.exit(2);
  }
  return opts;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

const opts = parseArgs(process.argv.slice(2));
let gui;
try {
  const keyFile = process.env.LAB_GUI_KEY_FILE || join(homedir(), ".config", "lab-gui", "remote-key");
  const remote = opts.listen ? { host: opts.listen, control: opts.control, key: await loadRemoteKey(keyFile, opts.rotate) } : undefined;
  gui = await startGui({ port: opts.port, remote });
} catch (error) {
  console.error(`lab-gui: ${error.message}`);
  process.exit(1);
}
if (opts.listen) {
  console.log(`lab-gui (remote): ${gui.origin}`);
  console.log(`  pairing key: ${gui.key}`);
  console.log(`  pairing link: labgui://pair?url=${encodeURIComponent(gui.origin)}&key=${gui.key}`);
  console.log(`  clients: ${opts.control ? "may send keys, type and stop labs" : "read-only (add --allow-control to let them type or stop)"}; plain HTTP, keep it on a private network`);
} else {
  console.log(`lab-gui: ${gui.url}  (Ctrl-C to stop; the link carries this launch's key)`);
  if (opts.open) openBrowser(gui.url);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    setTimeout(() => process.exit(0), 500).unref();
    gui.close().then(() => process.exit(0));
  });
}
