import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('./', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
export interface FixtureServer { url: string; origin: string; port: number; close: () => Promise<void>; }
export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const name = u.pathname === '/' ? 'page.html' : decodeURIComponent(u.pathname.slice(1));
      const path = normalize(join(DIR, name));
      if (!path.startsWith(DIR) || !TYPES[extname(path)]) throw new Error('not found');
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': TYPES[extname(path)], 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const origin = `http://127.0.0.1:${port}`;
  return { url: origin, origin, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
export const startServer = startFixtureServer;
