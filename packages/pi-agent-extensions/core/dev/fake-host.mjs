// Fake pi host for the core dev scripts: loads <dir>/index.ts through pi's own jiti and
// records what the extension registers, so token-bench.mjs and test-core.mjs can drive it.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createLoader } from "./pi-root.mjs";

export const BUILTIN = ["read", "bash", "edit", "write"];
export const MODEL = { provider: "anthropic", id: "claude-sonnet-5-5", contextWindow: 200_000, maxTokens: 64_000 };

const SHELL = "/bin/sh";
const theme = { fg: (_c, t) => t, bold: (t) => t, strikethrough: (t) => `~${t}~` };
const jiti = await createLoader(import.meta.url);

// core registers its job tools only when SHELL exists, which is never true on native
// Windows. setShell(true|false) overrides that check for hosts loaded afterwards;
// setShell(undefined) goes back to the real file system.
const existsSync = fs.existsSync;
let shell;
fs.existsSync = (p) => (p === SHELL && shell !== undefined ? shell : existsSync(p));
syncBuiltinESMExports();
export const setShell = (present) => {
  shell = present;
};

/** Load `dir`/index.ts, run its default export against a fake ExtensionAPI and start a session. */
export async function makeHost(dir, { activeTools } = {}) {
  const core = await jiti.import(join(dir, "index.ts"), { default: true });
  const h = { handlers: {}, tools: {}, commands: {}, branch: [], steers: [] };
  const noop = () => {};
  const api = new Proxy({
    on: (event, fn) => ((h.handlers[event] ??= []).push(fn), noop),
    registerTool: (tool) => (h.tools[tool.name] = tool),
    registerCommand: (name, cmd) => (h.commands[name] = cmd),
    appendEntry: (customType, data) => h.branch.push({ type: "custom", customType, data: structuredClone(data) }),
    sendUserMessage: (text, opts) => h.steers.push({ text, opts }),
    getActiveTools: () => activeTools?.(h) ?? [...BUILTIN, ...Object.keys(h.tools)],
  }, { get: (target, key) => (key in target ? target[key] : noop) });
  h.ctx = {
    mode: "print", hasUI: true, cwd: "/work", model: MODEL,
    sessionManager: { getBranch: () => h.branch },
    getContextUsage: () => ({ tokens: 0 }),
    isIdle: () => true,
    compact: noop,
    ui: { theme, setWidget: noop, setStatus: noop, notify: noop, custom: async () => {} },
  };
  h.emit = async (event, payload = {}) => {
    let result;
    for (const fn of h.handlers[event] ?? []) result = (await fn({ type: event, ...payload }, h.ctx)) ?? result;
    return result;
  };
  core(api);
  await h.emit("session_start", { reason: "startup" });
  return h;
}
