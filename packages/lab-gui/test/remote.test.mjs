import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../lib/app.mjs";
import { createMonitor } from "../lib/monitor.mjs";
import { loadRemoteKey } from "../lib/serve.mjs";
import { TEAM, createFakeCli } from "./fakes.mjs";

const KEY = "pairing-key";
const AUTH = { authorization: `Bearer ${KEY}` };

async function boot({ remote, now } = {}) {
  const cli = createFakeCli(TEAM);
  let port = 0;
  const app = createApp({ cli, monitor: createMonitor({ cli }), key: KEY, token: "page-token", port: () => port, pollMs: 20, idleMs: 100, remote, now });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    cli,
    base,
    port,
    get: (path, headers = AUTH) => fetch(base + path, { headers }),
    post: (path, body, headers = AUTH) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
    close: async () => {
      app.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("remote mode: any Host is fine but only the bearer key opens the API", async () => {
  const s = await boot({ remote: { control: false } });
  try {
    assert.equal((await s.get("/api/labs", {})).status, 401);
    assert.equal((await s.get("/api/labs", { authorization: "Bearer nope" })).status, 401);
    assert.equal((await s.get("/api/labs", { cookie: `lab_gui=${KEY}` })).status, 401, "cookies do not count in remote mode");
    const ok = await s.get("/api/labs");
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).labs.length, 3);
    assert.equal((await s.get("/")).status, 404, "no web page remotely");
    assert.equal((await s.get(`/?key=${KEY}`, {})).status, 401, "no key-to-cookie exchange remotely");
  } finally {
    await s.close();
  }
});

test("remote mode is read-only until control is on, and never allows attach", async () => {
  const ro = await boot({ remote: { control: false } });
  try {
    assert.equal((await ro.get("/api/info")).status, 200);
    assert.deepEqual(await (await ro.get("/api/info")).json(), { name: "lab-gui", api: 1, remote: true, control: false, attach: false });
    assert.equal((await ro.get("/api/labs/lead/screen")).status, 200);
    for (const [path, body] of [["/api/labs/lead/send", { text: "hi" }], ["/api/labs/lead/key", { key: "enter" }], ["/api/labs/lead/stop", { confirm: "lead" }], ["/api/labs/lead/renew", { confirm: "lead" }]]) {
      assert.equal((await ro.post(path, body)).status, 403, path);
    }
    assert.deepEqual(ro.cli.calls.filter((c) => c[0] !== "screen"), []);
  } finally {
    await ro.close();
  }
  const rw = await boot({ remote: { control: true } });
  try {
    assert.equal((await rw.post("/api/labs/lead/send", { text: "hi" })).status, 200);
    assert.equal((await rw.post("/api/labs/lead/renew", { confirm: "wrong" })).status, 400, "renew still needs the name");
    assert.equal((await rw.post("/api/labs/lead/renew", { confirm: "lead" })).status, 200);
    assert.equal((await rw.post("/api/labs/lead/stop", { confirm: "wrong" })).status, 400, "stop still needs the name");
    assert.equal((await rw.post("/api/labs/lead/stop", { confirm: "lead" })).status, 200);
    assert.equal((await rw.post("/api/labs/scout/attach", {})).status, 403);
    assert.equal((await rw.post("/api/labs/scout/send", { text: "x" }, { ...AUTH, "content-type": "text/plain" })).status, 415);
  } finally {
    await rw.close();
  }
});

test("local mode accepts the bearer too, without the page token", async () => {
  const s = await boot();
  try {
    const foreign = await new Promise((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port: s.port, path: "/api/labs", headers: { host: "evil.example", ...AUTH } }, resolve);
      r.on("error", reject);
      r.end();
    });
    assert.equal(foreign.statusCode, 421, "DNS-rebinding guard still applies locally");
    foreign.resume();
    assert.equal((await s.get("/api/labs")).status, 200);
    assert.equal((await s.post("/api/labs/lead/send", { text: "hi" })).status, 200);
    assert.equal((await s.post("/api/labs/lead/send", { text: "hi" }, {})).status, 401);
    assert.equal((await s.get("/api/info").then((r) => r.json())).control, true);
  } finally {
    await s.close();
  }
});

test("repeated wrong keys lock the address out for a minute, then it recovers", async () => {
  let clock = 1_000_000;
  const s = await boot({ remote: { control: false }, now: () => clock });
  try {
    for (let i = 0; i < 20; i++) assert.equal((await s.get("/api/labs", { authorization: "Bearer bad" })).status, 401);
    assert.equal((await s.get("/api/labs")).status, 429, "even the right key waits");
    clock += 61_000;
    assert.equal((await s.get("/api/labs")).status, 200);
  } finally {
    await s.close();
  }
});

test("the remote key file is created private, reused, and rotated on request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lg-key-"));
  try {
    const file = join(dir, "sub", "remote-key");
    const first = await loadRemoteKey(file);
    assert.match(first, /^[0-9a-f]{48}$/);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await loadRemoteKey(file), first);
    const rotated = await loadRemoteKey(file, true);
    assert.notEqual(rotated, first);
    assert.equal((await readFile(file, "utf8")).trim(), rotated);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
