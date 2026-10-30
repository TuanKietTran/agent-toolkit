import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { windowsMcpEnabled, WINDOWS_MCP_OPT_IN, WindowsMcpSession } from "../windows-mcp.mjs";
import { prepareWindowsAction } from "../windows-shared.mjs";

const window = { window_id: "123", process_id: 456, browser: "brave", title: "fixture", x: -10, y: 20, width: 2000, height: 1000, foreground: true, minimized: false };
const view = { ...window, image_width: 1000, image_height: 500 };

test("Windows foreground MCP is absent by default and requires exact operator opt-in", () => {
  assert.equal(windowsMcpEnabled({}, "win32"), false);
  assert.equal(windowsMcpEnabled({ [WINDOWS_MCP_OPT_IN]: "true" }, "win32"), false);
  assert.equal(windowsMcpEnabled({ [WINDOWS_MCP_OPT_IN]: "1" }, "linux"), false);
  assert.equal(windowsMcpEnabled({ [WINDOWS_MCP_OPT_IN]: "1" }, "win32"), true);
});

test("MCP session uses the same foreground request preparation as Pi and refuses stale/inactive windows", async () => {
  const requests = [];
  const backend = { async run(request) {
    requests.push(request);
    if (request.action === "status") return { window };
    if (request.action === "capture") { await writeFile(request.output, "mock-png"); return { window, image_width: 1000, image_height: 500 }; }
    return { delivered: true, verified: false };
  } };
  const session = new WindowsMcpSession({ backend, delayMs: 0 });
  await assert.rejects(session.call("windows_foreground_act", { action: "click", x: 100, y: 50 }), /surface input is off/);
  const surface = await session.call("windows_foreground_surface", { action: "on" });
  assert.match(surface.content[0].text, /\"enabled\":true/);
  const observed = await session.call("windows_foreground_observe", {});
  assert.equal(observed.content[1].type, "image");
  const result = await session.call("windows_foreground_act", { action: "click", x: 100, y: 50 });
  assert.equal(result.isError, false);
  const nativeAction = requests.at(-1);
  const piEquivalent = prepareWindowsAction(view, window, { action: "click", x: 100, y: 50, input_mode: "foreground" }, { requireForeground: true });
  for (const key of ["action", "input_mode", "window_id", "process_id", "expected", "x", "y"]) assert.equal(nativeAction[key], piEquivalent[key], `${key} shared policy parity`);
  assert.equal(nativeAction.input_mode, "foreground"); assert.equal(nativeAction.expected, true);
  session.view = undefined;
  await assert.rejects(session.call("windows_foreground_act", { action: "type", text: "x" }), /observe/);
  session.view = view;
  backend.run = async request => request.action === "status" ? { window: { ...window, foreground: false } } : { delivered: true };
  await assert.rejects(session.call("windows_foreground_act", { action: "click", x: 1, y: 1 }), /not active/);
  backend.run = async request => request.action === "status" ? { window: { ...window, width: 999 } } : { delivered: true };
  await assert.rejects(session.call("windows_foreground_act", { action: "click", x: 1, y: 1 }), /resized/);
});

test("foreground MCP cancellation is forwarded to shared backend for cooperative release", async () => {
  let release = 0;
  const backend = { async run(request, signal) {
    if (request.action === "status") return { window };
    if (request.action === "capture") { await writeFile(request.output, "mock"); return { window, image_width: 1000, image_height: 500 }; }
    if (request.action === "drag") return new Promise((resolve, reject) => signal.addEventListener("abort", () => { release++; reject(signal.reason); }, { once: true }));
    return { delivered: true };
  } };
  const session = new WindowsMcpSession({ backend, delayMs: 0 });
  await session.call("windows_foreground_surface", { action: "on" });
  await session.call("windows_foreground_observe", {});
  const controller = new AbortController();
  const call = session.call("windows_foreground_act", { action: "drag", x: 1, y: 1, target_x: 20, target_y: 20 }, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error("cancel test"));
  await assert.rejects(call, /cancel test/);
  assert.equal(release, 1);
});
