// Codespace/CI end-to-end: start a MOCK DAC node, then drive its web UI with the pi browser-control
// CDP backend (virtual mouse + keyboard, headless Chromium; no display or real input device needed).
//   npm run e2e:codespace           (set PI_CDP_NO_SANDBOX=1 when running as root)
// Requires: npm ci in this package and in ../pi-agent-extensions, and its Chromium
// (`npx playwright-core install --with-deps chromium` run inside ../pi-agent-extensions).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
// @ts-ignore cross-package import of the extension's backend (type-stripped TS)
import { CdpSession, observePage, perform } from '../../pi-agent-extensions/browser-control/cdp.ts';

const port = process.env.E2E_PORT ?? '18893';
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(18).toString('hex'); // browser/user token (CHAT_TOKEN)
const work = await mkdtemp(join(tmpdir(), 'dac-e2e-'));
process.env.PI_CDP_PROFILE = join(work, 'profile');
if (process.getuid?.() === 0) process.env.PI_CDP_NO_SANDBOX = '1';

// Owner node (no UPSTREAM_URL) + one MOCK claude worker.
const node = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'scripts/node-up.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, UPSTREAM_URL: '', HOST: '127.0.0.1', PORT: port, NODE_NAME: 'e2e', AGENT_ID: 'claude', ROOM: 'demo', CLAUDE_TOKEN: randomBytes(18).toString('hex'), PI_TOKEN: randomBytes(18).toString('hex'), CHAT_TOKEN: token, DATA_DIR: join(work, 'data') },
});
let nodeLog = '';
node.stdout!.on('data', (d) => { nodeLog += d; });
node.stderr!.on('data', (d) => { nodeLog += d; });

const session = new CdpSession();
const log = (m: string) => console.log(`[e2e] ${m}`);
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(origin)).ok) break; } catch {} await delay(500); if (i === 59) throw new Error(`node did not start:\n${nodeLog}`); }
  const { page } = await session.ensure();
  await page.goto(origin);
  const view = page.viewportSize()!;

  // Every interaction is a coordinate action through the CDP backend: the same path the agent uses.
  const at = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox();
    assert.ok(box, `${selector} not visible`);
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  const click = async (selector: string) => perform(session, page, view, { action: 'click', ...(await at(selector)) });
  const type = (t: string) => perform(session, page, view, { action: 'type', text: t });

  assert.ok(await page.getByRole('heading', { name: 'What are we working on?' }).isVisible(), 'landing heading');
  await click('#open-connect');
  await click('#room');
  await perform(session, page, view, { action: 'key', key: 'a', modifiers: ['primary'] });
  await type('demo');
  await click('#token');
  await type(token);
  await click('#connect-submit');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Connected', undefined, { timeout: 15_000 });
  log('connected through virtual input');

  await click('#prompt');
  await type('hello from the codespace e2e');
  await perform(session, page, view, { action: 'key', key: 'enter' });
  await page.waitForFunction(() => [...document.querySelectorAll('.turn')].some((t) => t.querySelector('.reply-head')?.textContent?.includes('done') && (t.querySelector('.reply-text')?.textContent ?? '').trim().length > 0), undefined, { timeout: 60_000 });
  const reply = await page.locator('.turn .reply-text').last().innerText();
  log(`mock agent replied: ${reply.slice(0, 80)}`);

  const shot = await observePage(session, page);
  await mkdir('.deploy/screenshots', { recursive: true });
  await writeFile('.deploy/screenshots/codespace-e2e.jpg', shot.image);
  log('PASS (screenshot: .deploy/screenshots/codespace-e2e.jpg)');
} catch (error) {
  try { const { page } = await session.ensure(); await mkdir('.deploy/screenshots', { recursive: true }); await writeFile('.deploy/screenshots/codespace-e2e-fail.jpg', (await observePage(session, page)).image); console.error('[e2e] history:', await (await fetch(`${origin}/api/rooms/demo/history`, { headers: { Authorization: `Bearer ${token}` } })).text()); console.error('[e2e] page text:', (await page.locator('body').innerText()).slice(0, 800)); } catch {}
  console.error('[e2e] FAIL', error, '\n--- node log ---\n', nodeLog.slice(-2000));
  process.exitCode = 1;
} finally {
  await session.close();
  node.kill('SIGTERM');
  await rm(work, { recursive: true, force: true });
}
