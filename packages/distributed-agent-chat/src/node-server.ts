// Portable Node server mode: runs the UNCHANGED Worker + Room code (src/worker.ts) outside Cloudflare.
//
//   STATE=local   (default)  this node OWNS its rooms: one SQLite file per room under DATA_DIR.
//   UPSTREAM_URL=https://... this node is a GATEWAY: it serves the UI, checks tokens, and forwards every
//                            room call to the owner node, so both nodes show the same room.
//
// Secrets come only from the environment (use `node --env-file=...`); they are never logged.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import worker, { Room } from './worker';
import { validateSecrets, type TokenEnv } from './auth';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

// Minimal Durable Object storage shim over node:sqlite (same SQL surface the Room class uses).
function sqliteStorage(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL');
  return {
    sql: { exec: (query: string, ...args: any[]) => { const rows = db.prepare(query).all(...args); return { toArray: () => rows }; } },
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close()
  };
}

export interface NodeConfig { tokens: TokenEnv; dataDir?: string; upstream?: string; name?: string }
// Same secret policy as the Miniflare server: distinct random tokens of at least 24 characters (CHAT_TOKEN + PI_TOKEN/CLAUDE_TOKEN or AGENT_TOKENS).
export const checkTokens = (t: TokenEnv) => validateSecrets(t);

export function createNode(config: NodeConfig) {
  checkTokens(config.tokens);
  const name = config.name || 'node', upstream = config.upstream?.replace(/\/$/, '');
  const stores: Array<{ close(): void }> = [];
  const rooms = new Map<string, Room>();
  const env: any = { ...config.tokens };
  if (upstream) {
    // Gateway: forward the already-authenticated, already-validated request to the owner node.
    env.ROOMS = { idFromName: (n: string) => n, get: () => ({ fetch: async (request: Request) => {
      const url = new URL(request.url);
      try {
        const r = await fetch(upstream + url.pathname + url.search, {
          method: request.method, redirect: 'error', signal: AbortSignal.timeout(8000),
          headers: { Authorization: request.headers.get('Authorization') || '', 'Content-Type': 'application/json' },
          body: request.method === 'GET' ? undefined : await request.text()
        });
        return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      } catch { return json({ error: 'Room owner node unavailable' }, 502); }
    } }) };
  } else {
    const dir = config.dataDir || '.node-data';
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    env.ROOMS = { idFromName: (n: string) => n, get: (n: string) => ({ fetch: (request: Request) => {
      let room = rooms.get(n);
      if (!room) {
        const storage = sqliteStorage(join(dir, `room-${n}.sqlite`)); stores.push(storage);
        room = new Room({ storage } as any, env); rooms.set(n, room);
      }
      return room.fetch(request);
    } }) };
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = req.url || '/';
    if (!path.startsWith('/') || path.startsWith('//')) { res.writeHead(400).end(); return; }
    if (path === '/healthz' && req.method === 'GET') { // no secrets, no room data
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ ok: true, node: name, mode: upstream ? 'gateway' : 'owner' })); return;
    }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 21000) { res.writeHead(413).end(); return; } chunks.push(chunk as Buffer); }
    const headers = new Headers();
    for (const h of ['authorization', 'content-type']) { const v = req.headers[h]; if (typeof v === 'string') headers.set(h, v); }
    const method = req.method || 'GET';
    const request = new Request(new URL(path, 'http://localhost'), { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks) });
    const response = await worker.fetch(request, env);
    const out: Record<string, string> = {}; response.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(response.status, out).end(Buffer.from(await response.arrayBuffer()));
  }
  const server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"Internal error"}'); }); });
  let closing: Promise<void> | undefined;
  const close = () => closing ||= new Promise<void>(done => server.close(() => { for (const s of stores) { try { s.close(); } catch { /* already closed */ } } done(); }));
  return { server, close };
}

// CLI entry: PORT, HOST, DATA_DIR, UPSTREAM_URL, NODE_NAME + the three tokens from the environment.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 18890), host = process.env.HOST || '127.0.0.1';
  const upstream = process.env.UPSTREAM_URL || undefined;
  if (upstream) { const u = new URL(upstream); if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw Error('Remote UPSTREAM_URL requires HTTPS'); }
  try {
    const node = createNode({ name: process.env.NODE_NAME || (upstream ? 'gateway' : 'owner'), dataDir: process.env.DATA_DIR, upstream,
      tokens: Object.fromEntries(['CHAT_TOKEN', 'PI_TOKEN', 'CLAUDE_TOKEN', 'AGENT_TOKENS'].filter(k => process.env[k]).map(k => [k, process.env[k]])) as TokenEnv });
    node.server.listen(port, host, () => console.log(`DAC node "${process.env.NODE_NAME || (upstream ? 'gateway' : 'owner')}" ${upstream ? `gateway -> ${new URL(upstream).origin}` : 'owner'} listening on ${host}:${port}`));
    const stop = () => { node.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (e) { console.error(`Startup failed: ${(e as Error).message}`); process.exitCode = 1; }
}
