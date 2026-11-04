import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile } from "node:fs/promises";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import windowsBrowserControl from "../windows.ts";
import { WindowsNative } from "../windows-native.ts";
import { assertSameWindow, browserSetting, validatedUrl, windowPoint, type WindowsView } from "../windows-protocol.ts";

const view: WindowsView = { window_id: "123", process_id: 456, browser: "brave", title: "fixture", x: -1920, y: 0, width: 3840, height: 2160, image_width: 1920, image_height: 1080, foreground: false, minimized: false };

test("Windows screenshot coordinates scale once, exclude the far edge, and tolerate moved windows", () => {
  assert.deepEqual(windowPoint(view, 100, 200), { x: 200, y: 400 });
  assert.deepEqual(windowPoint(view, 1919, 1079), { x: 3838, y: 2158 });
  for (const point of [[-1, 0], [1920, 10], [10, 1080], [NaN, 1], [1, Infinity], [undefined, 1]]) assert.throws(() => windowPoint(view, ...point as [number, number]));
  assert.doesNotThrow(() => assertSameWindow(view, { ...view, x: 100, y: -1000 }));
  for (const patch of [{ width: 100 }, { height: 100 }, { process_id: 999 }, { window_id: "999" }, { minimized: true }, { browser: "zen" as const }]) assert.throws(() => assertSameWindow(view, { ...view, ...patch }), /observe/);
});

test("Windows URL and browser settings reject unsafe schemes, credentials, and unknown apps", () => {
  assert.equal(validatedUrl("https://example.com"), "https://example.com/");
  assert.equal(validatedUrl("about:blank"), "about:blank");
  for (const url of [undefined, "file:///C:/Windows", "javascript:alert(1)", "data:text/html,hi", "about:config", "https://user:secret@example.com"]) assert.throws(() => validatedUrl(url));
  assert.equal(browserSetting(undefined), undefined);
  assert.equal(browserSetting(" BRAVE "), "brave");
  assert.equal(browserSetting("zen"), "zen");
  assert.throws(() => browserSetting("chrome"));
});

test("Windows tools serialize input, enforce fresh observations/surface state, and never silently foreground", async () => {
  const original = WindowsNative.prototype.run;
  const oldSetting = process.env.PI_WIN_BROWSER_APP;
  delete process.env.PI_WIN_BROWSER_APP;
  const calls: Record<string, unknown>[] = [];
  let active = 0, maxActive = 0;
  WindowsNative.prototype.run = async function<T>(request: Record<string, unknown>): Promise<T> {
    calls.push(request); active++; maxActive = Math.max(maxActive, active);
    try {
      await new Promise(r => setTimeout(r, 5));
      if (request.action === "capture") { await writeFile(String(request.output), "test-image"); return { window: view, image_width: 1920, image_height: 1080 } as T; }
      if (request.action === "status") return { window: view, windows: [view] } as T;
      return { delivered: true, verified: false } as T;
    } finally { active--; }
  };
  const tools = new Map<string, { execute: Function }>();
  const events = new Map<string, Function>();
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const pi = {
    registerTool(tool: { name: string; execute: Function }) { tools.set(tool.name, tool); },
    registerCommand() {}, on(name: string, fn: Function) { events.set(name, fn); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    exec() { throw new Error("Mock must not spawn a native process"); },
  } as unknown as ExtensionAPI;
  try {
    windowsBrowserControl(pi);
    const ctx = { sessionManager: { getBranch: () => entries } };
    const run = (name: string, params: object, signal?: AbortSignal) => tools.get(`win_browser_${name}`)!.execute("test", params, signal, undefined, ctx);
    await assert.rejects(run("act", { action: "click", x: 100, y: 200 }), /observe/);
    await run("observe", { delay_ms: 0 });
    await Promise.all([run("act", { action: "click", x: 100, y: 200 }), run("act", { action: "move", x: 5, y: 10 })]);
    assert.equal(maxActive, 1);
    const click = calls.find(c => c.action === "click")!;
    assert.equal(click.x, 200); assert.equal(click.y, 400);
    assert.equal(click.window_id, "123"); assert.equal(click.expected, true);
    assert.notEqual(click.input_mode, "foreground");
    await run("surface", { action: "off" });
    await assert.rejects(run("act", { action: "type", text: "blocked" }), /off/);
    await assert.rejects(run("tabs", { action: "select_tab", tab_index: 1 }), /off/);
    await run("tabs", { action: "list_tabs" });
    await events.get("session_start")!({}, ctx);
    const restored = await run("surface", { action: "status" }); assert.equal(restored.details.enabled, false);
    await run("surface", { action: "on" });
    await assert.rejects(run("act", { action: "key", key: "a" }), /observe/);
    await run("observe", { delay_ms: 0 });
    await assert.rejects(run("tabs", { action: "new_tab", url: "https://example.com" }), /explicit/);
    await assert.rejects(run("tabs", { action: "new_tab", url: "javascript:evil", input_mode: "foreground" }), /HTTP/);
    await assert.rejects(run("tabs", { action: "new_tab", url: "https://example.com", input_mode: "foreground" }), /not active/);
    const controller = new AbortController(); controller.abort();
    const before = calls.length;
    await assert.rejects(run("act", { action: "click", x: 1, y: 1 }, controller.signal));
    assert.equal(calls.length, before);
    await run("tabs", { action: "select_tab", tab_index: 1 });
    await assert.rejects(run("act", { action: "click", x: 1, y: 1 }), /observe/);
  } finally {
    WindowsNative.prototype.run = original;
    if (oldSetting === undefined) delete process.env.PI_WIN_BROWSER_APP; else process.env.PI_WIN_BROWSER_APP = oldSetting;
  }
});

test("input cancellation is cooperative so the helper can release held keys/buttons", async () => {
  const controller = new AbortController();
  let cancelFile = "";
  const native = new WindowsNative(async (_command, args, options) => {
    assert.equal(options.signal, undefined, "input process must not be killed between down/up");
    const request = JSON.parse(Buffer.from(args[0], "base64").toString("utf8"));
    cancelFile = request.cancel_file;
    controller.abort();
    assert.equal(await readFile(cancelFile, "utf8"), "");
    return { code: 1, stdout: "", stderr: "Operation aborted after releasing input" };
  });
  native.helper = async () => "fake-native.exe";
  await assert.rejects(native.run({ expected: true, action: "drag" }, controller.signal), /abort/i);
  await assert.rejects(readFile(cancelFile), /ENOENT/);
});

test("Windows helper compiles and starts without requiring a browser or debug endpoint", { skip: process.platform !== "win32" }, async () => {
  const exec = promisify(execFile);
  const native = new WindowsNative(async (command, args, options) => {
    try { return { code: 0, ...await exec(command, args, { ...options, encoding: "utf8", windowsHide: true }) }; }
    catch (error) { const e = error as { code: number; stdout: string; stderr: string }; return e; }
  });
  assert.match(await native.helper(), /windows-controller\.exe$/);
  await assert.rejects(native.run({ action: "status", browser: "not-a-browser" }), /No running/);
});
