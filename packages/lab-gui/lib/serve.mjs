// Starts the GUI server and returns its link. Shared by the command line (server.mjs) and the
// desktop app, so both get the same guards. By default it binds loopback only; `remote` opts in to
// another address for the native phone and desktop clients (see README: bearer key, read-only unless
// control is switched on).
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createApp } from "./app.mjs";
import { createCli } from "./cli.mjs";
import { createMonitor } from "./monitor.mjs";

export const HOST = "127.0.0.1";

/**
 * Key kept in a 0600 file so a paired phone stays paired across restarts. `rotate` replaces it.
 * @param {string} file
 * @param {boolean} [rotate]
 */
export async function loadRemoteKey(file, rotate = false) {
  if (!rotate) {
    try {
      const existing = (await readFile(file, "utf8")).trim();
      if (/^[0-9a-f]{48}$/.test(existing)) return existing;
    } catch {
      /* first run */
    }
  }
  const fresh = randomBytes(24).toString("hex");
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${fresh}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return fresh;
}

/**
 * @param {{port?: number, cli?: ReturnType<typeof createCli>, themesDir?: string, pollMs?: number, idleMs?: number,
 *          remote?: {host: string, control?: boolean, key: string}}} [options]
 * @returns {Promise<{url: string, origin: string, port: number, key: string, close: () => Promise<void>}>}
 */
export function startGui({ port = 0, cli = createCli(), themesDir, pollMs, idleMs, remote } = {}) {
  const key = remote?.key ?? randomBytes(24).toString("hex"); // goes into the link, becomes a cookie (or the bearer)
  const token = randomBytes(24).toString("hex"); // embedded in the page, required on every POST
  const host = remote?.host ?? HOST;
  let boundPort = port;
  const app = createApp({
    cli,
    monitor: createMonitor({ cli }),
    key,
    token,
    port: () => boundPort,
    themesDir,
    pollMs,
    idleMs,
    remote: remote ? { control: Boolean(remote.control) } : null,
  });
  const server = createServer(app.handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      boundPort = server.address().port;
      const shownHost = host.includes(":") ? `[${host}]` : host;
      const origin = `http://${shownHost}:${boundPort}`;
      resolve({
        url: remote ? origin : `${origin}/?key=${key}`,
        origin,
        port: boundPort,
        key,
        close: () =>
          new Promise((done) => {
            app.close();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
