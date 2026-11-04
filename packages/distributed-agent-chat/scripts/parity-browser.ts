// Isolated current-source interaction suite. Run: npx tsx scripts/parity-browser.ts
// No live credentials, provider calls, API mocks, fleet server, or message sends.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium, type Page } from 'playwright';
import { html } from '../src/ui';

const requests: string[] = [];
const server = createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } else if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); }
  else { requests.push(`${req.method} ${req.url}`); res.writeHead(403); res.end('No backend in isolated parity suite'); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const sourceHash = createHash('sha256').update(html).digest('hex');
console.log(`Current exported UI SHA256 ${sourceHash}; isolated ephemeral loopback server`);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let failed = 0;
let total = 0;
const failures: string[] = [];
const rooms = ['zeta_room', 'alpha_room', 'middle_room'];
const metadata = { zeta_room: { label: 'Zebra local', pinned: false }, alpha_room: { label: 'Alpha local', pinned: false }, middle_room: { label: 'Middle local', pinned: false } };
async function focused(page: Page, selector: string) {
  await page.waitForFunction(selector => document.querySelector(selector) === document.activeElement, selector, { timeout: 4000 });
  assert.equal(await page.locator(selector).evaluate(el => el === document.activeElement), true, `Focus must return to ${selector}`);
}
async function caseTest(name: string, run: (page: Page) => Promise<void>, width = 1440) {
  assert.ok(browser);
  total++;
  const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const errors: string[] = [];
  const unexpected: string[] = [];
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await context.route('**/*', async route => {
    const request = route.request();
    if (request.url().startsWith(origin + '/') && request.method() === 'GET' && ['/', '/favicon.ico'].includes(new URL(request.url()).pathname)) await route.continue();
    else { unexpected.push(`${request.method()} ${new URL(request.url()).pathname}`); await route.abort(); }
  });
  await context.addInitScript(({ rooms, metadata }) => {
    if (!localStorage.getItem('parity.seeded')) {
      localStorage.setItem('session-code.rooms', JSON.stringify(rooms));
      localStorage.setItem('sc.room-meta', JSON.stringify(metadata));
      localStorage.setItem('parity.seeded', 'yes');
    }
  }, { rooms, metadata });
  try {
    await page.goto(origin);
    await run(page);
    assert.deepEqual(errors, [], 'No JavaScript or browser console errors');
    assert.deepEqual(unexpected, [], 'No API, external requests, or sends permitted');
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push(name);
    console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    if (errors.length) console.error(`JavaScript/console errors: ${JSON.stringify(errors)}`);
    if (unexpected.length) console.error(`Unexpected requests: ${JSON.stringify(unexpected)}`);
  } finally { await context.close(); }
}
try {
  browser = await chromium.launch({ executablePath: process.env.BROWSER_BINARY || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  await caseTest('desktop collapse/expand preserves draft and changes layout', async page => {
    await page.locator('#prompt').fill('Unsent local draft');
    const before = await page.locator('.main').boundingBox();
    assert.ok(before);
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'false');
    const collapsed = await page.locator('.main').boundingBox();
    assert.ok(collapsed && collapsed.x < before.x, 'Collapse widens main column');
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#sidebar-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#prompt').inputValue(), 'Unsent local draft');
    await focused(page, '#sidebar-toggle');
  });
  await caseTest('sidebar resize drag, keys, bounds and persisted width', async page => {
    const handle = page.getByRole('separator');
    const width = async () => Number(await handle.getAttribute('aria-valuenow'));
    const start = await width();
    const box = await handle.boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + 120, { steps: 6 });
    await page.mouse.up();
    assert.equal(await width(), start + 40);
    assert.ok(Math.abs((await page.locator('#sidebar').boundingBox())!.width - await width()) <= 1);
    await handle.focus();
    await handle.press('ArrowRight');
    assert.equal(await width(), start + 50);
    await handle.press('ArrowLeft');
    assert.equal(await width(), start + 40);
    await handle.press('Home');
    assert.equal(await width(), Number(await handle.getAttribute('aria-valuemin')));
    await handle.press('ArrowLeft');
    assert.equal(await width(), Number(await handle.getAttribute('aria-valuemin')));
    await handle.press('End');
    const max = Number(await handle.getAttribute('aria-valuemax'));
    assert.equal(await width(), max);
    await handle.press('ArrowRight');
    assert.equal(await width(), max);
    await page.reload();
    assert.equal(await width(), max);
  });
  await caseTest('recents collapse changes visibility and restores rows', async page => {
    assert.equal(await page.locator('.recent-open').count(), 3);
    await page.locator('#recents-toggle').click();
    assert.equal(await page.locator('#recents-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#recents').isVisible(), false);
    await page.locator('#recents-toggle').click();
    assert.equal(await page.locator('#recents-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#recents').isVisible(), true);
    assert.equal(await page.locator('.recent-open').count(), 3);
  });
  await caseTest('sort menu keyboard navigation, Escape and actual alphabetical order', async page => {
    await page.locator('#recents-sort').click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    assert.equal(await menu.evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('ArrowDown');
    assert.match(await page.locator(':focus').innerText(), /Name/);
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    await focused(page, '#recents-sort');
    assert.equal(await page.locator('#recents-sort').getAttribute('aria-expanded'), 'false');
    await page.locator('#recents-sort').click();
    await page.getByRole('menuitemradio', { name: 'Name A–Z', exact: true }).click();
    assert.deepEqual(await page.locator('.recent-name').allTextContents(), ['Alpha local', 'Middle local', 'Zebra local']);
  });
  await caseTest('search filters local display metadata and underlying room IDs', async page => {
    await page.locator('#search').fill('zEbRa');
    assert.deepEqual(await page.locator('.recent-name').allTextContents(), ['Zebra local']);
    await page.locator('#search').fill('alpha_room');
    assert.deepEqual(await page.locator('.recent-name').allTextContents(), ['Alpha local']);
    await page.locator('#search').fill('no_such_room');
    assert.equal(await page.locator('.recent-open').count(), 0);
    await page.locator('#search').fill('');
    assert.equal(await page.locator('.recent-open').count(), 3);
  });
  await caseTest('row menu open/Escape/focus and local pin persistence', async page => {
    const row = page.locator('.recent').filter({ hasText: 'Zebra local' });
    const trigger = row.locator('.row-menu-btn');
    await row.hover();
    await trigger.click();
    const menu = page.getByRole('menu');
    await menu.waitFor();
    assert.equal(await menu.evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0);
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sc.room-meta') || '{}'));
    assert.equal(stored.zeta_room.pinned, true);
    await page.reload();
    assert.equal(await page.locator('.group-label').first().textContent(), 'Pinned');
    assert.equal(await page.locator('.recent-name').first().textContent(), 'Zebra local');
    assert.ok(await page.locator('.recent-open').first().getAttribute('title'), 'Full room tooltip present');
  });
  await caseTest('connection dialog Escape/focus and synthetic token storage isolation', async page => {
    assert.equal(await page.locator('#sendButton').isDisabled(), true);
    await page.locator('#open-connect').click();
    await page.locator('#connection').waitFor();
    const marker = 'PARITY_SYNTHETIC_NOT_A_CREDENTIAL';
    await page.locator('#token').fill(marker); // Never submitted.
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#connection').isVisible(), false);
    await focused(page, '#open-connect');
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.equal(stored.includes(marker), false);
    assert.equal(page.url().includes(marker), false);
    await page.reload();
    assert.equal(await page.locator('#token').inputValue(), '');
    assert.equal(await page.locator('#sendButton').isDisabled(), true);
  });
  await caseTest('rename hostile HTML remains literal text, persists and keeps room ID', async page => {
    const hostile = '<img src=x onerror="window.parityInjected=true">';
    const row = page.locator('.recent').filter({ hasText: 'Zebra local' });
    await row.hover();
    await row.locator('.row-menu-btn').click();
    page.once('dialog', dialog => { void dialog.accept(hostile); });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    assert.equal(await page.locator('.recent-name').first().textContent(), hostile);
    assert.equal(await page.locator('#recents img').count(), 0);
    assert.equal(await page.evaluate(() => 'parityInjected' in window), false);
    const stored = await page.evaluate(() => ({ rooms: JSON.parse(localStorage.getItem('session-code.rooms') || '[]'), meta: JSON.parse(localStorage.getItem('sc.room-meta') || '{}') }));
    assert.deepEqual(stored.rooms, rooms);
    assert.equal(stored.meta.zeta_room.label, hostile);
    assert.equal(stored.meta.alpha_room.label, 'Alpha local');
    await page.reload();
    assert.equal(await page.locator('.recent-name').first().textContent(), hostile);
    await page.locator('.recent-open').first().click();
    assert.equal(await page.locator('#room').inputValue(), 'zeta_room');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#recents img').count(), 0);
  });
  await caseTest('pin/unpin scoped metadata survives reload', async page => {
    const row = page.locator('.recent').filter({ hasText: 'Middle local' });
    for (const action of ['Pin', 'Unpin']) {
      await row.hover();
      await row.locator('.row-menu-btn').click();
      await page.getByRole('menuitem', { name: action, exact: true }).click();
      await page.reload();
      const data = await page.evaluate(() => JSON.parse(localStorage.getItem('sc.room-meta') || '{}'));
      assert.equal(data.middle_room.pinned, action === 'Pin');
      assert.equal(data.alpha_room.pinned, false);
      assert.equal(data.zeta_room.pinned, false);
    }
  });
  await caseTest('archive/show archived/unarchive are local and persistent', async page => {
    const row = page.locator('.recent').filter({ hasText: 'Middle local' });
    await row.hover();
    await row.locator('.row-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    assert.equal(await row.count(), 0);
    await page.reload();
    assert.equal(await row.count(), 0);
    await page.locator('#show-archived').click();
    assert.equal(await page.locator('#show-archived').getAttribute('aria-pressed'), 'true');
    assert.equal(await row.count(), 1);
    assert.ok((await page.locator('.group-label').allTextContents()).includes('Archived'));
    await row.hover();
    await row.locator('.row-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Unarchive', exact: true }).click();
    await page.reload();
    assert.equal(await row.count(), 1);
    const data = await page.evaluate(() => JSON.parse(localStorage.getItem('sc.room-meta') || '{}'));
    assert.equal(data.middle_room.archived, false);
    assert.equal(data.alpha_room.archived, false);
  });
  await caseTest('delete from recents and undo restore original local order', async page => {
    const before = await page.locator('.recent-name').allTextContents();
    const row = page.locator('.recent').filter({ hasText: 'Alpha local' });
    await row.hover();
    await row.locator('.row-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Delete from recents', exact: true }).click();
    assert.equal(await row.count(), 0);
    assert.match(await page.locator('#notice').innerText(), /locally only.*Remote conversation is unchanged/i);
    await focused(page, '#undo-delete');
    const deleted = await page.evaluate(() => JSON.parse(localStorage.getItem('session-code.rooms') || '[]'));
    assert.deepEqual(deleted, ['zeta_room', 'middle_room']);
    await page.locator('#undo-delete').click();
    assert.deepEqual(await page.locator('.recent-name').allTextContents(), before);
    await page.reload();
    assert.deepEqual(await page.locator('.recent-name').allTextContents(), before);
  });
  await caseTest('metadata and preferences never persist synthetic token or draft', async page => {
    const tokenMarker = 'PARITY_NEVER_A_REAL_SECRET';
    const draftMarker = 'PARITY_UNSENT_DRAFT_NOT_METADATA';
    await page.locator('#open-connect').click();
    await page.locator('#token').fill(tokenMarker);
    await page.keyboard.press('Escape');
    await page.locator('#prompt').fill(draftMarker);
    const row = page.locator('.recent').filter({ hasText: 'Alpha local' });
    await row.hover();
    await row.locator('.row-menu-btn').click();
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    assert.equal(stored.includes(tokenMarker), false);
    assert.equal(stored.includes(draftMarker), false);
    assert.equal(page.url().includes(tokenMarker), false);
    await page.reload();
    assert.equal(await page.locator('#token').inputValue(), '');
    assert.equal(await page.locator('#prompt').inputValue(), '');
  });
  await caseTest('composer Add keyboard open/Escape/focus and code block insertion', async page => {
    await page.locator('#prompt').fill('selected code');
    await page.locator('#prompt').evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, el.value.length));
    await page.locator('#composer-add').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('menu').evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    await focused(page, '#composer-add');
    await page.locator('#composer-add').click();
    await page.getByRole('menuitem', { name: 'Insert code block', exact: true }).click();
    assert.equal(await page.locator('#prompt').inputValue(), '```\nselected code\n```');
    await focused(page, '#prompt');
    assert.equal(await page.locator('#sendButton').isDisabled(), true);
  });
  await caseTest('composer options keyboard toggle changes Enter drafting without send', async page => {
    await page.locator('#composer-options').focus();
    await page.keyboard.press('Enter');
    const option = page.getByRole('menuitemcheckbox', { name: 'Send with Enter', exact: true });
    assert.equal(await option.getAttribute('aria-checked'), 'true');
    await page.keyboard.press('Escape');
    await focused(page, '#composer-options');
    await page.locator('#composer-options').click();
    await option.click();
    await focused(page, '#prompt');
    await page.locator('#prompt').fill('line one');
    await page.locator('#prompt').press('End');
    await page.locator('#prompt').press('Enter');
    assert.equal(await page.locator('#prompt').inputValue(), 'line one\n');
    assert.match(await page.locator('#composer-hint').innerText(), /Ctrl/);
    await page.locator('#composer-options').click();
    assert.equal(await option.getAttribute('aria-checked'), 'false');
    await page.keyboard.press('Escape');
    await focused(page, '#composer-options');
  });
  for (const [selector, title, explanation] of [
    ['#environment-control', 'Environment', /separately configured worker hosts/],
    ['#permissions-control', 'Permissions', /configured on worker hosts/],
    ['#usage-control', 'Usage', /unavailable/],
    ['#account-control', 'Account and connection', /No provider account identity/],
    ['#agent-capabilities', 'Claude Code capabilities', /not exposed by this API/],
  ] as const) await caseTest(`${title} dialog keyboard open/Escape/Close restores trigger focus`, async page => {
    await page.locator(selector).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#ui-details').isVisible(), true);
    assert.equal(await page.locator('#ui-details-title').innerText(), title);
    assert.match(await page.locator('#ui-details-body').innerText(), explanation);
    assert.equal(await page.locator('#ui-details').evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    await focused(page, selector);
    assert.equal(await page.locator('#ui-details').isVisible(), false);
    await page.keyboard.press('Enter');
    await page.locator('#close-details').click();
    await focused(page, selector);
    if (selector === '#account-control') assert.equal(await page.locator('#disconnect-tab').isVisible(), false);
  });
  for (const width of [320, 390, 760]) await caseTest(`mobile ${width}px sidebar open/Escape/collapse, no horizontal overflow`, async page => {
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await noOverflow();
    await page.locator('#menu').click();
    assert.equal(await page.locator('#menu').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#sidebar').isVisible(), true);
    await focused(page, '#sidebar-toggle');
    await noOverflow();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#menu').getAttribute('aria-expanded'), 'false');
    await focused(page, '#menu');
    await page.locator('#menu').click();
    await page.locator('#sidebar-toggle').click();
    assert.equal(await page.locator('#menu').getAttribute('aria-expanded'), 'false');
    await focused(page, '#menu');
    await noOverflow();
  }, width);
  assert.deepEqual(requests, [], 'Isolated server received no backend requests');
  console.log(`RESULT ${total - failed}/${total} browser cases passed; source ${sourceHash}`);
  if (failed) { console.error(`Failed cases: ${failures.join('; ')}`); process.exitCode = 1; }
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
