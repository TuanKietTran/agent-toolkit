import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cdpBrowserControl, { CdpSession, checkPoint, normalizeKey, validatedUrl } from "../cdp.ts";

test("CDP key/modifier names normalize to Playwright chords", () => {
  assert.equal(normalizeKey("enter"), "Enter");
  assert.equal(normalizeKey("left"), "ArrowLeft");
  assert.equal(normalizeKey("f5"), "F5");
  assert.equal(normalizeKey("a", ["command", "shift"]), "Meta+Shift+a");
  assert.equal(normalizeKey("a", ["primary"]), "ControlOrMeta+a");
  assert.throws(() => normalizeKey("a", ["hyper"]), /modifier/);
});

test("CDP URL and coordinate validation reject unsafe input", () => {
  assert.equal(validatedUrl("http://127.0.0.1:18890/"), "http://127.0.0.1:18890/");
  assert.equal(validatedUrl("about:blank"), "about:blank");
  for (const u of [undefined, "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "https://u:p@example.com"]) assert.throws(() => validatedUrl(u));
  const view = { width: 100, height: 50 };
  assert.deepEqual(checkPoint("click", 99, 49, view), { x: 99, y: 49 });
  for (const [x, y] of [[-1, 0], [100, 0], [0, 50], [NaN, 1], [undefined, 1]]) assert.throws(() => checkPoint("click", x, y, view));
});

const PAGE = `<!doctype html><meta charset=utf-8><title>cdp fixture</title>
<body style="margin:0"><button id=b style="position:absolute;left:100px;top:100px;width:200px;height:60px">go</button>
<input id=i style="position:absolute;left:100px;top:200px;width:300px" autofocus>
<div style="height:3000px"></div>
<script>
window.log = [];
const rec = (type) => (e) => log.push({ type, trusted: e.isTrusted, x: e.clientX, y: e.clientY, key: e.key, button: e.button });
for (const t of ["mousedown", "click", "contextmenu", "dblclick"]) addEventListener(t, rec(t), true);
for (const t of ["keydown"]) addEventListener(t, rec(t), true);
</script>`;

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright-core");
    const { existsSync } = await import("node:fs");
    return existsSync(chromium.executablePath());
  } catch { return false; }
}

test("CDP tools drive a real Chromium with trusted, virtual input", { skip: !(await chromiumAvailable()) && "no Playwright Chromium installed (npx playwright-core install chromium)" }, async () => {
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(PAGE); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const profile = await mkdtemp(join(tmpdir(), "pi-cdp-test-"));
  const env = { PI_CDP_PROFILE: process.env.PI_CDP_PROFILE, PI_CDP_NO_SANDBOX: process.env.PI_CDP_NO_SANDBOX };
  process.env.PI_CDP_PROFILE = profile;
  if (process.getuid?.() === 0) process.env.PI_CDP_NO_SANDBOX = "1";
  const tools = new Map<string, { execute: Function }>();
  const pi = { registerTool: (t: { name: string; execute: Function }) => tools.set(t.name, t), registerCommand() {}, on() {} } as unknown as ExtensionAPI;
  const session = new CdpSession();
  cdpBrowserControl(pi, session);
  const run = (name: string, params: object) => tools.get(`cdp_browser_${name}`)!.execute("t", params, undefined, undefined, {});
  const log = async () => (await (await session.ensure()).page.evaluate(() => (window as any).log)) as any[];
  try {
    await assert.rejects(run("act", { action: "click", x: 1, y: 1 }), /observe/);
    await run("tabs", { action: "open", url });
    const obs = await run("observe", { delay_ms: 0 });
    assert.ok(obs.content.some((c: any) => c.type === "image" && c.data.length > 100));

    await run("act", { action: "click", x: 150, y: 120 });
    await run("act", { action: "right_click", x: 150, y: 120 });
    await run("act", { action: "double_click", x: 150, y: 120 });
    const events = await log();
    const click = events.find((e) => e.type === "click");
    assert.deepEqual([click.trusted, click.x, click.y], [true, 150, 120]);
    assert.ok(events.some((e) => e.type === "contextmenu" && e.trusted));
    assert.ok(events.some((e) => e.type === "dblclick" && e.trusted));

    await run("act", { action: "click", x: 200, y: 210 });
    await run("act", { action: "type", text: "hello\nworld" });
    await run("act", { action: "key", key: "a", modifiers: ["primary"] });
    const typed = await (await session.ensure()).page.inputValue("#i");
    assert.equal(typed, "helloworld");
    const keys = await log();
    assert.ok(keys.filter((e) => e.type === "keydown").every((e) => e.trusted));
    assert.ok(keys.some((e) => e.type === "keydown" && e.key === "Enter"));

    await run("act", { action: "scroll", x: 400, y: 400, delta_y: -600 });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(await (await session.ensure()).page.evaluate(() => scrollY) > 0, "wheel scrolled down");

    await assert.rejects(run("act", { action: "click", x: 5000, y: 5 }), /outside/);
    await assert.rejects(run("tabs", { action: "open", url: "file:///etc/passwd" }), /Only http/);
    const tabs = JSON.parse((await run("tabs", { action: "list_tabs" })).content[0].text);
    assert.equal(tabs.tabs.length, 1);
  } finally {
    await session.close();
    await new Promise((r) => server.close(r));
    await rm(profile, { recursive: true, force: true });
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});
