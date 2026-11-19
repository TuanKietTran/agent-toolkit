// Genuine desktop computer-use test (Test 5): the mac_browser_* tools capture a real browser window
// with screencapture and deliver real Quartz mouse/keyboard events to it, inside a real pi session.
// The target is a throwaway "Google Chrome for Testing" instance (separate app, separate profile), never
// the user's own browser. The target is located by colour in the captured pixels (no DOM access by the
// agent), and the outcome is verified twice: on screen (pixels) and independently through CDP.
//
// Opt-in: requires macOS with Accessibility + Screen Recording granted to the terminal, a logged-in
// display, and Playwright's Chrome for Testing. Run with:
//   PI_DESKTOP_TESTS=1 node --test browser-control/tests/desktop-computer-use.test.ts
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startFixtureServer, type FixtureServer } from "../cdp/fixture/server.ts";
import { freePort } from "../cdp/tests/browser-harness.ts";

const APP_NAME = "Google Chrome for Testing";
function chromeForTesting(): string | undefined {
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  try {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
      for (const arch of ["chrome-mac-arm64", "chrome-mac"]) {
        const app = join(cache, dir, arch, `${APP_NAME}.app`);
        if (existsSync(app)) return app;
      }
    }
  } catch {}
  return undefined;
}
const appPath = platform() === "darwin" ? chromeForTesting() : undefined;
const enabled = process.env.PI_DESKTOP_TESTS === "1" && !!appPath;

// ---- pixel helpers: JPEG -> BMP with sips, then plain BMP parsing ----
type Img = { w: number; h: number; px: (x: number, y: number) => [number, number, number] };
function decode(base64Jpeg: string): Img {
  const dir = mkdtempSync(join(tmpdir(), "desk-px-"));
  try {
    writeFileSync(join(dir, "a.jpg"), Buffer.from(base64Jpeg, "base64"));
    execFileSync("sips", ["-s", "format", "bmp", join(dir, "a.jpg"), "--out", join(dir, "a.bmp")], { stdio: "ignore" });
    const b = readFileSync(join(dir, "a.bmp"));
    const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), bpp = b.readUInt16LE(28) / 8;
    const h = Math.abs(hRaw), row = Math.ceil((w * bpp) / 4) * 4;
    return { w, h, px: (x, y) => { const yy = hRaw > 0 ? h - 1 - y : y; const i = off + yy * row + x * bpp; return [b[i + 2], b[i + 1], b[i]]; } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function find(img: Img, match: (r: number, g: number, b: number) => boolean): { x: number; y: number; n: number } | undefined {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < img.h; y += 2) for (let x = 0; x < img.w; x += 2) { const [r, g, b] = img.px(x, y); if (match(r, g, b)) { sx += x; sy += y; n++; } }
  return n > 50 ? { x: Math.round(sx / n), y: Math.round(sy / n), n } : undefined;
}
const MAGENTA = (r: number, g: number, b: number) => r > 200 && g < 80 && b > 120 && b < 220;
const GREEN = (r: number, g: number, b: number) => g > 150 && r < 90 && b < 130;
const YELLOW = (r: number, g: number, b: number) => r > 220 && g > 200 && b < 90;

let fx: FixtureServer, cdpPort = 0, profile = "";

async function cdpEval(expression: string): Promise<unknown> {
  const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = list.find((t) => t.type === "page" && t.url.includes("desktop.html"));
  assert.ok(page, "test page is open");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  const result = await new Promise<any>((resolve) => { ws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)); if (m.id === 1) resolve(m.result?.result?.value); }); ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); });
  ws.close();
  return result;
}

before(async () => {
  if (!enabled) return;
  fx = await startFixtureServer();
  cdpPort = await freePort();
  profile = mkdtempSync(join(tmpdir(), "desk-profile-"));
  // -g: launch in the background so the user's frontmost app keeps focus; -n: a separate instance.
  const r = spawnSync("open", ["-g", "-n", "-a", appPath!, "--args", `--user-data-dir=${profile}`, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", "--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen", "--window-position=80,80", "--window-size=900,640", `${fx.origin}/desktop.html`]);
  assert.equal(r.status, 0, String(r.stderr));
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { try { if ((await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  await new Promise((r) => setTimeout(r, 1500));
  // Chromium drops synthetic input posted to an inactive app (see README "Safety"), so the throwaway
  // test app is made active. Input is still posted only to its PID, never to the shared HID stream.
  if (process.env.PI_DESKTOP_BACKGROUND !== "1") { spawnSync("open", ["-a", appPath!]); await new Promise((r) => setTimeout(r, 800)); }
});

after(async () => {
  if (!enabled) return;
  spawnSync("pkill", ["-f", profile]);
  await new Promise((r) => setTimeout(r, 800));
  rmSync(profile, { recursive: true, force: true });
  await fx?.close();
});

test("5 desktop computer use: capture the window, locate targets by pixels, click and type with OS input, and never claim an effect the screen does not show", { skip: enabled ? false : "set PI_DESKTOP_TESTS=1 on macOS with Chrome for Testing installed", timeout: 180_000 }, async () => {
  process.env.PI_MAC_BROWSER_APP = APP_NAME;
  const { default: browserControl } = await import("../index.ts");
  const { startHarness, fauxAssistantMessage: msg, fauxText: text, fauxToolCall: call } = await import("../../tests/agent-harness.ts");
  const { getRuntime } = await import("../../runtime/runtime.ts");
  type Msg = { role: string; toolName?: string; content?: { type: string; data?: string; text?: string }[] };
  type Ctx = { messages: readonly unknown[] };
  const lastResult = (ctx: Ctx, tool: string) => (ctx.messages as Msg[]).filter((x) => x.role === "toolResult" && x.toolName === tool).pop();
  const lastImage = (ctx: Ctx): string => { const img = lastResult(ctx, "mac_browser_observe")?.content?.find((c) => c.type === "image")?.data; assert.ok(img, "observe returned an image"); return img; };
  const verifiedOf = (ctx: Ctx) => /verified=true/.test(lastResult(ctx, "mac_browser_act")?.content?.map((c) => c.text ?? "").join("\n") ?? "");
  const helper = (): string => { const dir = join(homedir(), "Library/Caches/pi-macos-browser-control"); const d = readdirSync(dir).map((x) => join(dir, x, "macos-controller")).find((x) => existsSync(x)); assert.ok(d, "native helper compiled"); return d; };
  // Tab metadata and activation normally go through AppleScript, which would ask the user for Automation
  // consent for this throwaway app. Activation is emulated with `open -a` and only reported when the test
  // app really is frontmost, so a foreground click can never land on one of the user's windows.
  const shim = (pi: any) => browserControl(new Proxy(pi, { get: (t, k) => k !== "exec" ? t[k] : async (cmd: string, args: string[], o: unknown) => {
    if (cmd !== "osascript") return t.exec(cmd, args, o);
    if (args.includes("activate")) {
      spawnSync("open", ["-a", appPath!]);
      await new Promise((r) => setTimeout(r, 700));
      const front = JSON.parse(execFileSync(helper(), ["status", APP_NAME, ""]).toString()).frontmostApp;
      return { code: 0, stdout: `activated=${front === APP_NAME}`, stderr: "", killed: false };
    }
    return { code: 1, stdout: "", stderr: "AppleScript not used in this test", killed: false };
  } }));
  const claims: { step: string; verified: boolean; domChanged: boolean }[] = [];
  const evidence: Record<string, unknown> = {};
  let target = { x: 0, y: 0 }, field = { x: 0, y: 0 };
  const h = await startHarness({ browserPort: 1, extraExtensions: [shim], responses: [
    msg([call("mac_browser_observe", {})]),
    (ctx: Ctx) => { const img = decode(lastImage(ctx)); const t = find(img, MAGENTA); assert.ok(t, "magenta target visible in the capture"); target = t; evidence.capture = `${img.w}x${img.h}`; evidence.target = t; return msg([call("mac_browser_act", { action: "click", x: t.x, y: t.y })]); },
    async (ctx: Ctx) => {
      const ok = verifiedOf(ctx); const dom = (await cdpEval("document.getElementById('go').textContent")) === "Done";
      claims.push({ step: "background click", verified: ok, domChanged: dom });
      // Escalate only when the tool says the background click had no visible effect.
      return ok ? msg([call("mac_browser_observe", {})]) : msg([call("mac_browser_act", { action: "focus_click", x: target.x, y: target.y })]);
    },
    async (ctx: Ctx) => {
      if (lastResult(ctx, "mac_browser_act") && claims.length === 1 && !claims[0].verified) claims.push({ step: "focus_click", verified: verifiedOf(ctx), domChanged: (await cdpEval("document.getElementById('go').textContent")) === "Done" });
      return msg([call("mac_browser_observe", {})]);
    },
    (ctx: Ctx) => { const img = decode(lastImage(ctx)); evidence.greenOnScreen = !!find(img, GREEN); evidence.magentaGone = !find(img, MAGENTA); const f = find(img, YELLOW); assert.ok(f, "input visible"); field = f; return msg([call("mac_browser_act", { action: "focus_click", x: f.x, y: f.y })]); },
    msg([call("mac_browser_act", { action: "type", text: "hello desktop" })]),
    async (ctx: Ctx) => { claims.push({ step: "background type", verified: verifiedOf(ctx), domChanged: (await cdpEval("document.getElementById('field').value")) === "hello desktop" }); return msg([call("mac_browser_observe", {})]); },
    (ctx: Ctx) => msg(text(JSON.stringify({ ...evidence, claims }))),
  ] });
  try {
    const before = getRuntime().log.lastSeq;
    await h.session.prompt("Click the pink button, then type 'hello desktop' into the yellow field and verify the screen.");
    await h.session.waitForIdle();
    const events = getRuntime().log.since(before).events;
    evidence.domButton = await cdpEval("document.getElementById('go').textContent");
    evidence.domTyped = await cdpEval("document.getElementById('field').value");
    console.log("# desktop evidence " + JSON.stringify({ ...evidence, claims }));
    assert.deepEqual(events.filter((e) => e.type === "tool.failed"), []);
    assert.ok(events.some((e) => e.type === "computer.action" && (e as any).status === "completed"));
    assert.ok(events.some((e) => e.type === "computer.observation" && (e as any).verified !== undefined), "act results carry verification events");
    assert.ok(events.some((e) => e.type === "artifact.created" && (e as any).kind === "screenshot"));
    // The click reached the page through real OS input (background or, after a NOT verified result, foreground).
    assert.equal(evidence.domButton, "Done");
    assert.equal(evidence.greenOnScreen, true, "the change is visible in the captured window");
    // No claim contradicts reality: verified=true exactly when the DOM changed.
    for (const c of claims) assert.equal(c.verified, c.domChanged, `${c.step}: tool claimed verified=${c.verified} but DOM changed=${c.domChanged}`);
  } finally { await h.dispose(); }
});
