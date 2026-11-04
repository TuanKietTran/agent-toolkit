import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WindowsNativeBackend } from "./windows-backend.mjs";
import { browserSetting, prepareWindowsAction } from "./windows-shared.mjs";

export const WINDOWS_MCP_OPT_IN = "PI_BROWSER_MCP_ENABLE_WINDOWS_FOREGROUND";
const execFileAsync = promisify(execFile);
async function exec(command, args, options) {
  try {
    const result = await execFileAsync(command, args, { timeout: options.timeout, signal: options.signal, windowsHide: true, encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message ?? "" };
  }
}

export const windowsMcpTools = [
  { name: "windows_foreground_surface", description: "Enable or disable this MCP process's foreground-input surface. Starts off on every launch; setting PI_BROWSER_MCP_ENABLE_WINDOWS_FOREGROUND=1 only advertises these opt-in controls.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["on", "off", "status"] } }, required: ["action"], additionalProperties: false } },
  { name: "windows_foreground_observe", description: "Observe an existing Brave/Zen browser window. Read-only; does not focus it.", inputSchema: { type: "object", properties: { window_index: { type: "integer", minimum: 1 } }, additionalProperties: false } },
  { name: "windows_foreground_act", description: "Foreground input to the last observed, still-active Windows browser window. This interrupts the user. Only available after operator opt-in. Use explicit action call; no background retry or fallback.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["click", "drag", "scroll", "type", "key"] }, x: { type: "number" }, y: { type: "number" }, target_x: { type: "number" }, target_y: { type: "number" }, delta_x: { type: "integer", minimum: -12000, maximum: 12000 }, delta_y: { type: "integer", minimum: -12000, maximum: 12000 }, text: { type: "string", maxLength: 2048 }, key: { type: "string" }, modifiers: { type: "array", items: { type: "string", enum: ["control", "shift", "alt"] } }, duration_ms: { type: "integer", minimum: 0, maximum: 10000 }, interval_ms: { type: "integer", minimum: 0, maximum: 1000 } }, required: ["action"], additionalProperties: false } },
];

/** Adapter reuses the same native process backend and request preparation as Pi win_browser_* tools. */
export class WindowsMcpSession {
  constructor({ backend = new WindowsNativeBackend(exec), browser = browserSetting(process.env.PI_WIN_BROWSER_APP), delayMs = 150 } = {}) {
    this.backend = backend; this.browser = browser; this.delayMs = delayMs; this.view = undefined; this.enabled = false; this.queue = Promise.resolve();
  }
  serial(fn) { const result = this.queue.then(fn, fn); this.queue = result.catch(() => {}); return result; }
  async call(name, args = {}, signal) {
    if (name === "windows_foreground_surface") return this.serial(() => this.surface(args));
    if (name === "windows_foreground_observe") return this.serial(() => this.observe(args, signal));
    if (name === "windows_foreground_act") return this.serial(() => this.act(args, signal));
    throw Object.assign(new Error("Unknown Windows foreground tool"), { code: "INVALID_TOOL" });
  }
  surface(args) {
    if (!["on", "off", "status"].includes(args.action)) throw new Error("surface action must be on, off, or status");
    if (args.action !== "status") this.enabled = args.action === "on";
    return { content: [{ type: "text", text: JSON.stringify({ enabled: this.enabled, mode: "foreground only; never falls back" }) }] };
  }
  async observe(args, signal) {
    signal?.throwIfAborted();
    const status = await this.backend.run({ action: "status", browser: this.browser, window_index: args.window_index }, signal);
    const selected = status.window;
    const directory = await mkdtemp(join(tmpdir(), "pi-win-mcp-observe-"));
    try {
      const output = join(directory, "window.png");
      const capture = await this.backend.run({ action: "capture", browser: selected.browser, window_id: selected.window_id, output, max_edge: 1920 }, signal);
      const image = await readFile(output);
      this.view = { ...capture.window, image_width: capture.image_width, image_height: capture.image_height };
      return { content: [{ type: "text", text: JSON.stringify({ ...this.view, capture_mode: "PrintWindow (focus unchanged)" }) }, { type: "image", data: image.toString("base64"), mimeType: "image/png" }] };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async act(args, signal) {
    signal?.throwIfAborted();
    if (!this.enabled) throw new Error("Browser surface input is off; use windows_foreground_surface on");
    const observed = this.view;
    if (!observed) throw new Error("Call windows_foreground_observe before input");
    const status = await this.backend.run({ action: "status", browser: observed.browser, window_id: observed.window_id }, signal);
    const current = status.window;
    const request = prepareWindowsAction(observed, current, { ...args, input_mode: "foreground" }, { enabled: this.enabled, requireForeground: true });
    const result = await this.backend.run(request, signal);
    await new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
      const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error("Cancelled")); };
      const timer = setTimeout(finish, this.delayMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    return { content: [{ type: "text", text: JSON.stringify({ ...result, physical_cursor_ignored: false, input_mode: "foreground" }) }], isError: false };
  }
}
export function windowsMcpEnabled(env = process.env, platformName = process.platform) { return platformName === "win32" && env[WINDOWS_MCP_OPT_IN] === "1"; }
