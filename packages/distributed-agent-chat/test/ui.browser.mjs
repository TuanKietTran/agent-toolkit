// Explicit opt-in: uses the running fleet and real standby agents; not part of npm test.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
if (process.env.CONFIRM_BROWSER_LIVE !== 'YES') throw Error('Set CONFIRM_BROWSER_LIVE=YES; this sends real provider messages');
if (!process.env.CHAT_TOKEN) throw Error('CHAT_TOKEN is required');
const browser = await chromium.launch({ executablePath: process.env.BROWSER_BINARY || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.name));
const origin = process.env.FLEET_URL_A || 'http://127.0.0.1:18877';
try {
  await page.goto(origin);
  await page.getByRole('heading', { name: 'What are we working on?' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#room').fill('demo');
  await page.locator('#token').fill(process.env.CHAT_TOKEN);
  await page.locator('#connect-submit').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === 'Connected');
  assert.equal(await page.locator('#connection').isVisible(), false);
  for (const agent of ['claude', 'pi']) {
    const marker = `ui_${agent}_${randomUUID().replaceAll('-', '')}`;
    await page.getByLabel('Target agent').selectOption(agent);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`Reply with only ${marker}. Do not use tools.`);
    await page.getByRole('textbox', { name: 'Message', exact: true }).press('Enter');
    await page.waitForFunction(marker => [...document.querySelectorAll('.turn')].some(turn => turn.querySelector('.reply-head').textContent.includes('done') && turn.querySelector('.reply-text').textContent.includes(marker)), marker, { timeout: 120000 });
    console.log(`Authenticated browser send and real ${agent} reply PASS`);
  }
  // Browser refresh must require reauthentication; room names, not tokens, may persist.
  const stored = await page.evaluate(() => ({ ...localStorage }));
  assert.ok(!JSON.stringify(stored).includes(process.env.CHAT_TOKEN));
  await mkdir('.deploy/screenshots', { recursive: true });
  await page.screenshot({ path: '.deploy/screenshots/session-code-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle session sidebar' }).click();
  assert.equal(await page.getByRole('button', { name: 'Toggle session sidebar' }).getAttribute('aria-expanded'), 'true');
  await page.getByRole('button', { name: 'Toggle session sidebar' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '.deploy/screenshots/session-code-mobile.png', fullPage: true });
  await page.reload();
  assert.equal(await page.getByRole('button', { name: 'Send message' }).isDisabled(), true);
  assert.deepEqual(errors, []);
  console.log('Mobile layout, sidebar, token-storage isolation, refresh and JavaScript checks PASS');
} finally { await browser.close(); }
