import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const mcp = resolve(import.meta.dirname, "../mcp-server.mjs");

const PAGE = `<!doctype html><meta charset=utf-8><title>cdp mcp fixture</title>
<body style="margin:0"><button id=b style="position:absolute;left:100px;top:100px;width:200px;height:60px">go</button>
<input id=i style="position:absolute;left:100px;top:200px;width:300px;height:30px" autofocus>
<script>
const rec = (type) => (e) => { const q = new URLSearchParams({ type, trusted: String(e.isTrusted), x: String(e.clientX ?? ""), y: String(e.clientY ?? ""), key: e.key ?? "", value: e.target?.value ?? "" }); fetch("/event?" + q, { keepalive: true }).catch(() => {}); };
for (const t of ["mousedown", "click", "keydown"]) addEventListener(t, rec(t), true);
document.getElementById("i").addEventListener("input", rec("input"));
</script>`;

async function chromiumAvailable() {
  try {
    const { chromium } = await import("playwright-core");
    const { existsSync } = await import("node:fs");
    return existsSync(chromium.executablePath());
  } catch { return false; }
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(fn, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) { if (fn()) return; if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for fixture event"); await delay(25); }
}

test("CDP MCP tools over stdio drive Chromium with trusted input", { skip: !(await chromiumAvailable()) && "no Playwright Chromium installed (npx playwright-core install chromium)", timeout: 60000 }, async (t) => {
  const events = [];
  const http = createHttpServer((req, res) => {
    const u = new URL(req.url, "http://fixture");
    if (u.pathname === "/event") { events.push(Object.fromEntries(u.searchParams)); res.end("ok"); return; }
    res.setHeader("content-type", "text/html"); res.end(PAGE);
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${http.address().port}/`;
  // Minimal broker stub: bridge-client connect() sends a framed hello and awaits a framed ready with the same id.
  const socketPath = join(tmpdir(), `pi-cdp-mcp-${randomUUID()}.sock`);
  const stub = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const size = buf.readUInt32LE(0);
        if (buf.length < size + 4) return;
        const msg = JSON.parse(buf.subarray(4, size + 4).toString());
        buf = buf.subarray(size + 4);
        if (msg.type === "hello") {
          const body = Buffer.from(JSON.stringify({ type: "ready", version: 1, id: msg.id, session: "stub-session" }));
          const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
          sock.write(Buffer.concat([head, body]));
        }
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => stub.listen(socketPath, r));
  const profile = await mkdtemp(join(tmpdir(), "pi-cdp-mcp-profile-"));
  const env = { ...process.env, PI_CDP_MCP: "1", PI_BROWSER_BRIDGE_SOCKET: socketPath, PI_BROWSER_BRIDGE_TEST_MODE: "1", PI_CDP_PROFILE: profile };
  delete env.PI_CDP_URL; delete env.PI_CDP_HEADED; delete env.PI_BROWSER_BRIDGE_CONFIG;
  if (process.getuid?.() === 0) env.PI_CDP_NO_SANDBOX = "1";
  const child = spawn(process.execPath, [mcp], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (b) => stderr += b);
  t.after(async () => {
    child.kill("SIGKILL"); stub.close(); http.close();
    await rm(profile, { recursive: true, force: true });
    await rm(socketPath, { force: true });
  });
  let buffer = ""; const waiters = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk; let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      waiters.get(m.id)?.(m); waiters.delete(m.id);
    }
  });
  let id = 0;
  const rpc = (method, params) => {
    const my = ++id;
    const p = new Promise((res2, rej) => { waiters.set(my, res2); setTimeout(() => rej(new Error(`RPC ${method} timed out; stderr: ${stderr}`)), 30000); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: my, method, ...(params !== undefined ? { params } : {}) })}\n`);
    return p;
  };
  const init = await rpc("initialize", {});
  assert.equal(init.result.serverInfo.name, "pi-browser-bridge");
  const list = await rpc("tools/list");
  const names = list.result.tools.map((x) => x.name).filter((n) => n.startsWith("cdp_")).sort();
  assert.deepEqual(names, ["cdp_click", "cdp_key", "cdp_navigate", "cdp_observe", "cdp_scroll", "cdp_tabs", "cdp_type"]);
  const nav = await rpc("tools/call", { name: "cdp_navigate", arguments: { url } });
  assert.equal(nav.error, undefined);
  assert.equal(JSON.parse(nav.result.content[0].text).url, url);
  const obs = await rpc("tools/call", { name: "cdp_observe", arguments: {} });
  assert.equal(obs.error, undefined);
  assert.ok(obs.result.content.some((c) => c.type === "image"), "observe returns a screenshot");
  const click = await rpc("tools/call", { name: "cdp_click", arguments: { x: 200, y: 130 } });
  assert.equal(click.error, undefined);
  await rpc("tools/call", { name: "cdp_click", arguments: { x: 250, y: 215 } });
  await rpc("tools/call", { name: "cdp_type", arguments: { text: "hi" } });
  await eventually(() => events.some((e) => e.type === "click" && e.x === "200" && e.y === "130"));
  await eventually(() => events.some((e) => e.type === "input" && e.value === "hi"));
  assert.ok(events.length > 0 && events.every((e) => e.trusted === "true"), `all fixture events trusted: ${JSON.stringify(events)}`);
  child.stdin.end();
  await Promise.race([new Promise((r) => child.once("exit", r)), delay(5000)]);
});
