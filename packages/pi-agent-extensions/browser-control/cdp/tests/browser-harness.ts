// Shared test harness: an isolated headless Chromium-family browser with a throwaway profile
// on a free loopback debugging port. Used by the e2e, regression and agent-loop tests.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBravePath } from '../launch.ts';

/** Brave, then Google Chrome, then a Playwright-cached Chromium. `PI_BC_TEST_BROWSER` overrides all. */
export function resolveTestBrowser(): string | undefined {
  const env = process.env.PI_BC_TEST_BROWSER;
  if (env && existsSync(env)) return env;
  const brave = resolveBravePath();
  if (brave) return brave;
  // Hosted CI images ship Google Chrome.
  const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"].find((p) => existsSync(p));
  if (chrome) return chrome;
  const cache = process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : join(homedir(), '.cache/ms-playwright');
  try {
    for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      const candidates = [
        join(cache, dir, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(cache, dir, 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'),
        join(cache, dir, 'chrome-linux/chrome'),
        join(cache, dir, 'chrome-win/chrome.exe'),
      ];
      const found = candidates.find((p) => existsSync(p));
      if (found) return found;
    }
  } catch {}
  return undefined;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}

async function waitForPort(port: number, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`browser debugging port ${port} never came up`);
}

export interface TestBrowser { port: number; path: string; process: ChildProcess; close(): Promise<void>; }

export async function startTestBrowser(opts?: { port?: number; profileDir?: string }): Promise<TestBrowser> {
  const path = resolveTestBrowser();
  if (!path) throw new Error('no Chromium-family browser found (install Brave or run `npx playwright install chromium`)');
  const port = opts?.port ?? await freePort();
  const ownProfile = !opts?.profileDir;
  const profileDir = opts?.profileDir ?? await mkdtemp(join(tmpdir(), 'bc-test-'));
  const child = spawn(path, ['--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  await waitForPort(port);
  return {
    port, path, process: child,
    async close() {
      if (!child.killed && child.exitCode == null) child.kill('SIGTERM');
      await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(r, 4000))]);
      if (ownProfile) await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
