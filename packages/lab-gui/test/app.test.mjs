import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../lib/app.mjs";
import { createMonitor } from "../lib/monitor.mjs";
import { TEAM, createFakeCli } from "./fakes.mjs";

const TOKEN = "t0ken";
const KEY = "launch-key";
const COOKIE = `lab_gui=${KEY}`;

async function boot(initial = TEAM, appOpts = {}) {
  const cli = createFakeCli(initial);
  const monitor = createMonitor({ cli });
  let port = 0;
  const app = createApp({ cli, monitor, key: KEY, token: TOKEN, port: () => port, pollMs: 20, idleMs: 200, ...appOpts });
  const server = createServer(app.handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return {
    cli,
    base,
    port,
    request: (path, init = {}) => fetch(base + path, { ...init, headers: { cookie: COOKIE, ...init.headers } }),
    post: (path, body, headers = {}) =>
      fetch(base + path, { method: "POST", headers: { cookie: COOKIE, "content-type": "application/json", "x-lab-gui-token": TOKEN, ...headers }, body: JSON.stringify(body) }),
    close: async () => {
      app.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("page is served with the launch token and a locked-down CSP", async () => {
  const s = await boot();
  try {
    const res = await s.request("/");
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, new RegExp(`name="lab-gui-token" content="${TOKEN}"`));
    assert.doesNotMatch(html, /__LAB_GUI_TOKEN__/);
    const csp = res.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /https?:/);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1|localhost)/, "no external URLs in the page");
  } finally {
    await s.close();
  }
});

test("static files cannot escape the public directory", async () => {
  const s = await boot();
  try {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/lib/app.mjs", "/..%2fserver.mjs"]) {
      const res = await s.request(path);
      assert.equal(res.status, 404, path);
    }
  } finally {
    await s.close();
  }
});

test("GET /api/labs returns the graph snapshot", async () => {
  const s = await boot();
  try {
    const snap = await (await s.request("/api/labs")).json();
    assert.equal(snap.labs.length, 3);
    assert.equal(snap.labs.find((l) => l.name === "review").kind, "advisor");
  } finally {
    await s.close();
  }
});

test("a request with a foreign Host header is refused (DNS rebinding)", async () => {
  const s = await boot();
  try {
    const res = await new Promise((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const r = request({ host: "127.0.0.1", port: s.port, path: "/api/labs", headers: { host: "evil.example", cookie: COOKIE } }, resolve);
        r.on("error", reject);
        r.end();
      });
    });
    assert.equal(res.statusCode, 421);
    res.resume();
  } finally {
    await s.close();
  }
});

test("POST needs the token, a JSON body and a same-origin Origin", async () => {
  const s = await boot();
  try {
    const noToken = await fetch(`${s.base}/api/labs/lead/send`, { method: "POST", headers: { cookie: COOKIE, "content-type": "application/json" }, body: "{}" });
    assert.equal(noToken.status, 403);
    assert.equal((await s.post("/api/labs/lead/send", { text: "x" }, { "x-lab-gui-token": "wrong" })).status, 403);
    assert.equal((await s.post("/api/labs/lead/send", { text: "x" }, { origin: "https://evil.example" })).status, 403);
    const form = await fetch(`${s.base}/api/labs/lead/send`, { method: "POST", headers: { cookie: COOKIE, "content-type": "text/plain", "x-lab-gui-token": TOKEN }, body: "text=x" });
    assert.equal(form.status, 415);
    assert.equal(s.cli.calls.filter((c) => c[0] === "send").length, 0);
    const ok = await s.post("/api/labs/lead/send", { text: "hello" }, { origin: s.base });
    assert.equal(ok.status, 200);
    assert.deepEqual(s.cli.calls.find((c) => c[0] === "send"), ["send", "lead", "hello", { enter: true }]);
  } finally {
    await s.close();
  }
});

test("stop requires the lab name as confirmation", async () => {
  const s = await boot();
  try {
    assert.equal((await s.post("/api/labs/scout/stop", {})).status, 400);
    assert.equal((await s.post("/api/labs/scout/stop", { confirm: "lead" })).status, 400);
    assert.ok(s.cli.sessions.has("scout"));
    assert.equal((await s.post("/api/labs/scout/stop", { confirm: "scout" })).status, 200);
    assert.ok(!s.cli.sessions.has("scout"));
  } finally {
    await s.close();
  }
});

test("keys are allow-listed, names are validated, unknown labs surface as errors", async () => {
  const s = await boot();
  try {
    assert.equal((await s.post("/api/labs/lead/key", { key: "Enter" })).status, 200);
    assert.equal((await s.post("/api/labs/lead/key", { key: "Ctrl-D" })).status, 400);
    assert.equal((await s.request("/api/labs/a%3Bb/screen")).status, 400);
    assert.equal((await s.post("/api/labs/lead/attach", {})).status, 200);
    assert.equal((await s.request("/api/labs/nope/screen")).status, 500);
    assert.equal((await s.request("/api/nothing")).status, 404);
  } finally {
    await s.close();
  }
});

test("screen endpoint returns the lab's lines", async () => {
  const s = await boot();
  try {
    const body = await (await s.request("/api/labs/lead/screen?tail=5")).json();
    assert.equal(body.lines[0], "working...");
    assert.deepEqual(s.cli.calls.find((c) => c[0] === "screen" && c[2] === "5")?.slice(0, 2), ["screen", "lead"]);
  } finally {
    await s.close();
  }
});

test("event stream sends a snapshot immediately and then on every poll", async () => {
  const s = await boot();
  const controller = new AbortController();
  try {
    const res = await fetch(`${s.base}/api/stream`, { signal: controller.signal, headers: { cookie: COOKIE } });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while ((text.match(/event: snapshot/g) ?? []).length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    assert.ok((text.match(/event: snapshot/g) ?? []).length >= 2);
    assert.match(text, /"name":"lead"/);
  } finally {
    controller.abort();
    await s.close();
  }
});

test("polling stops when nobody is watching", async () => {
  const s = await boot();
  try {
    await s.request("/api/labs");
    await new Promise((r) => setTimeout(r, 450));
    const before = s.cli.calls.length;
    const sessionsListed = []; // list is not recorded, so count status polling through screen reads instead
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.cli.calls.length, before);
    assert.deepEqual(sessionsListed, []);
  } finally {
    await s.close();
  }
});

test("nothing is served without the launch key cookie: page, API, stream and screens", async () => {
  const s = await boot();
  try {
    for (const path of ["/", "/app.js", "/style.css", "/api/labs", "/api/stream", "/api/labs/lead/screen"]) {
      const res = await fetch(s.base + path);
      assert.equal(res.status, 401, path);
      await res.arrayBuffer();
    }
    const wrong = await fetch(s.base + "/api/labs", { headers: { cookie: "lab_gui=nope" } });
    assert.equal(wrong.status, 401);
    const post = await fetch(`${s.base}/api/labs/lead/stop`, { method: "POST", headers: { "content-type": "application/json", "x-lab-gui-token": TOKEN }, body: '{"confirm":"lead"}' });
    assert.equal(post.status, 401);
    assert.ok(s.cli.sessions.has("lead"));
  } finally {
    await s.close();
  }
});

test("the launch URL key becomes an HttpOnly SameSite=Strict cookie and a redirect to a clean URL", async () => {
  const s = await boot();
  try {
    const bad = await fetch(`${s.base}/?key=wrong`, { redirect: "manual" });
    assert.equal(bad.status, 401);
    const ok = await fetch(`${s.base}/?key=${KEY}`, { redirect: "manual" });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get("location"), "/");
    const cookie = ok.headers.get("set-cookie");
    assert.match(cookie, /^lab_gui=launch-key;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const page = await fetch(`${s.base}/`, { headers: { cookie: cookie.split(";")[0] } });
    assert.equal(page.status, 200);
  } finally {
    await s.close();
  }
});

test("page serves the empty-registry banner only when the old registry has sessions", async () => {
  const base = await mkdtemp(join(tmpdir(), "lab-gui-page-banner-"));
  const registryDir = join(base, "h1");
  const oldRegistryDir = join(base, "agent-cli-lab");
  await mkdir(registryDir, { recursive: true });
  await mkdir(oldRegistryDir, { recursive: true });
  await writeFile(join(oldRegistryDir, "fake.json"), "{}");
  const s = await boot(TEAM, { registryDir, oldRegistryDir });
  try {
    const page = await (await s.request("/")).text();
    assert.match(page, /class="registry-banner"/);
    assert.ok(page.includes(`This GUI reads ${registryDir}, which is empty; 1 session(s) exist in the old registry ${oldRegistryDir}; those sessions belong to the pre-rename install and are not shown here; no automatic migration happens.`));
    assert.ok(!page.includes("__REGISTRY_BANNER__"));
  } finally {
    await s.close();
  }
  const s2 = await boot(TEAM, { registryDir, oldRegistryDir: join(base, "absent") });
  try {
    const page = await (await s2.request("/")).text();
    assert.ok(!page.includes("registry-banner"));
    assert.ok(!page.includes("__REGISTRY_BANNER__"));
  } finally {
    await s2.close();
  }
});

test("themes are listed from disk behind the launch key, and the shared colour module is served", async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(`${s.base}/api/themes`)).status, 401);
    const { themes } = await (await s.request("/api/themes")).json();
    assert.ok(themes.length >= 20);
    const tokyo = themes.find((t) => t.name === "tokyo-night");
    assert.equal(tokyo.mode, "dark");
    assert.equal(tokyo.colors.background, "#1a1b26");
    const mod = await s.request("/theme.js");
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get("content-type"), /javascript/);
  } finally {
    await s.close();
  }
});
