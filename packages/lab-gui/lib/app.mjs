// HTTP layer: static page, JSON API and a server-sent-events stream. No framework.
// Guards, because this process can type into and stop real terminals:
//  - the server binds 127.0.0.1 only (see server.mjs) and every request must carry a loopback Host
//    header, which defeats DNS rebinding;
//  - every request needs the per-launch key: the URL the server prints carries it once, it is
//    exchanged for an HttpOnly SameSite=Strict cookie, and nothing (page, API, event stream) is
//    served without that cookie, so other local users and other websites get nothing;
//  - every POST also needs the per-launch token the page was served with, a JSON body and, when the
//    browser sends one, a same-origin Origin header;
//  - nothing is fetched from or sent to any other host, and the page's CSP forbids it too.
// Native apps authenticate with `Authorization: Bearer <key>` instead of the cookie. A browser never
// adds that header on its own and this server sends no CORS headers, so the bearer path needs no
// CSRF token. In remote mode (bound beyond loopback) ONLY the bearer is accepted, the web page is
// not served, "attach" is refused, and send/key/stop stay off unless control was switched on.
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_KEYS, CliError, isValidName } from "./cli.mjs";
import { loadThemes } from "./themes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "..", "public");
const THEMES_DIR = join(here, "..", "themes");
const MAX_BODY = 64 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const sameToken = (a, b) => {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new CliError("body too large", { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new CliError("body must be a JSON object", { status: 400 });
  }
}

/**
 * @param {{cli: ReturnType<import('./cli.mjs').createCli>, monitor: ReturnType<import('./monitor.mjs').createMonitor>,
 *          key: string, token: string, port: () => number, pollMs?: number, idleMs?: number}} options
 */
export function createApp({ cli, monitor, key, token, port, pollMs = 1500, idleMs = 20000, themesDir = THEMES_DIR, remote = null, now = Date.now }) {
  const failures = new Map(); // address -> {count, since, until}
  const throttled = (addr) => (failures.get(addr)?.until ?? 0) > now();
  const failed = (addr) => {
    const f = failures.get(addr);
    const entry = !f || now() - f.since > 60000 ? { count: 0, since: now(), until: 0 } : f;
    entry.count += 1;
    if (entry.count >= 20) entry.until = now() + 60000;
    failures.set(addr, entry);
    if (failures.size > 512) failures.delete(failures.keys().next().value);
  };
  const bearerKey = (req) => /^Bearer (\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
  const allowedHosts = () => new Set([`127.0.0.1:${port()}`, `localhost:${port()}`, `[::1]:${port()}`]);
  let lastDemand = 0;
  let loop;
  const streams = new Set();

  // Poll the CLI only while somebody is looking: idle means zero background work.
  function demand() {
    lastDemand = Date.now();
    if (loop) return;
    const run = async () => {
      if (Date.now() - lastDemand > idleMs && streams.size === 0) {
        loop = undefined;
        return;
      }
      const snap = await monitor.tick();
      const payload = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
      for (const res of streams) res.write(payload);
      loop = setTimeout(run, pollMs);
      loop.unref?.();
    };
    loop = setTimeout(run, 0);
    loop.unref?.();
  }

  async function serveStatic(res, urlPath) {
    const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + sep) || !TYPES[extname(file)]) return sendJson(res, 404, { error: "not found" });
    let body;
    try {
      body = await readFile(file, "utf8");
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
    if (rel === "index.html") body = body.replace("__LAB_GUI_TOKEN__", token);
    res.writeHead(200, { "content-type": TYPES[extname(file)], "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" });
    res.end(body);
  }

  const COOKIE = "lab_gui";
  const cookieKey = (req) => {
    for (const part of String(req.headers.cookie ?? "").split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === COOKIE) return rest.join("=");
    }
    return undefined;
  };

  async function handle(req, res) {
    if (!remote && !allowedHosts().has(String(req.headers.host ?? "").toLowerCase())) return sendJson(res, 421, { error: "unexpected host" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const addr = req.socket?.remoteAddress ?? "?";
    if (throttled(addr)) return sendJson(res, 429, { error: "too many failed attempts; wait a minute" });

    // First visit: trade the key in the URL for a cookie, then drop it from the address bar.
    if (!remote && req.method === "GET" && path === "/" && url.searchParams.has("key")) {
      if (!sameToken(url.searchParams.get("key"), key)) failed(addr);
      if (!sameToken(url.searchParams.get("key"), key)) return sendJson(res, 401, { error: "wrong key; open the URL printed by lab-gui" });
      res.writeHead(302, { location: "/", "set-cookie": `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store" });
      return res.end();
    }
    const viaBearer = sameToken(bearerKey(req), key);
    if (!viaBearer && (remote || !sameToken(cookieKey(req), key))) {
      failed(addr);
      return sendJson(res, 401, { error: remote ? "send the pairing key as Authorization: Bearer <key>" : "open the URL printed by lab-gui (it carries the launch key)" });
    }

    if (req.method === "GET" && !path.startsWith("/api/")) return remote ? sendJson(res, 404, { error: "not found" }) : serveStatic(res, path);

    if (req.method === "GET" && path === "/api/info") return sendJson(res, 200, { name: "lab-gui", api: 1, remote: Boolean(remote), control: remote ? Boolean(remote.control) : true, attach: !remote });

    if (req.method === "GET" && path === "/api/labs") {
      demand();
      const snap = monitor.snapshot();
      return sendJson(res, 200, snap.at ? snap : await monitor.tick());
    }

    // Read from disk on every request, like Omarchy's theme list: a theme folder dropped in shows up at once.
    if (req.method === "GET" && path === "/api/themes") return sendJson(res, 200, { themes: await loadThemes(themesDir) });

    if (req.method === "GET" && path === "/api/stream") {
      demand();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
      res.write(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify(monitor.snapshot())}\n\n`);
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }

    const m = /^\/api\/labs\/([^/]+)\/(screen|send|key|stop|attach)$/.exec(path);
    if (!m) return sendJson(res, 404, { error: "not found" });
    const name = decodeURIComponent(m[1]);
    const action = m[2];
    if (!isValidName(name)) return sendJson(res, 400, { error: "invalid lab name" });

    if (action === "screen" && req.method === "GET") {
      demand();
      const screen = await cli.screen(name, url.searchParams.get("tail") ?? 40);
      return sendJson(res, 200, { name, lines: screen.lines ?? [], cols: screen.cols ?? null, rows: screen.rows ?? null, title: screen.title ?? null });
    }

    if (req.method !== "POST" || action === "screen") return sendJson(res, 405, { error: "method not allowed" });
    if (remote && !remote.control) return sendJson(res, 403, { error: "remote control is off; restart lab-gui with --allow-control to send, press keys or stop" });
    if (remote && action === "attach") return sendJson(res, 403, { error: "attach opens a window on the host; not available remotely" });
    if (!viaBearer) {
      if (!sameToken(req.headers["x-lab-gui-token"], token)) return sendJson(res, 403, { error: "missing or wrong token" });
      const origin = req.headers.origin;
      if (origin && !new Set([...allowedHosts()].map((h) => `http://${h}`)).has(origin.toLowerCase())) return sendJson(res, 403, { error: "cross-origin request refused" });
    }
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return sendJson(res, 415, { error: "content-type must be application/json" });

    const body = await readJson(req);
    if (action === "send") {
      await cli.send(name, body.text, { enter: body.enter !== false });
    } else if (action === "key") {
      if (!ALLOWED_KEYS.has(body.key)) throw new CliError("key not allowed", { status: 400 });
      await cli.key(name, body.key);
    } else if (action === "stop") {
      if (body.confirm !== name) throw new CliError("stop needs {\"confirm\": \"<lab name>\"}", { status: 400 });
      await cli.stop(name);
    } else if (action === "attach") {
      await cli.attach(name);
    }
    return sendJson(res, 200, { ok: true, name, action });
  }

  const handler = (req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof CliError ? error.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    });
  };

  return {
    handler,
    close() {
      clearTimeout(loop);
      loop = undefined;
      for (const res of streams) res.end();
      streams.clear();
    },
  };
}
