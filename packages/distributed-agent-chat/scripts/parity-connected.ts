// LOCAL TEST-ONLY API FIXTURE: not provider/fleet/integration evidence.
// Run: npx tsx scripts/parity-connected.ts
// Unlike parity-browser.ts (no API traffic), this suite serves synthetic API
// responses on an ephemeral loopback server and submits synthetic messages.
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { html } from '../src/ui';

type Send = { id: string; agent: string; prompt: string };
type Captured = { data: Send; response: ServerResponse };
const syntheticToken = 'LOCAL_FIXTURE_ONLY_NOT_A_CREDENTIAL';
const sends: Captured[] = [];
const unexpected: string[] = [];
let waiter: ((send: Captured) => void) | undefined;
const queue: Captured[] = [];
let historyRequests = 0;
let eventRequests = 0;
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}
const server = createServer(async (request, response) => {
  const path = request.url || '';
  if (path === '/' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(html); return;
  }
  if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
  if (!/^\/api\/rooms\/(fixture_room|other_room)\/(history|events\?after=0|send)$/.test(path) || request.headers.authorization !== `Bearer ${syntheticToken}`) {
    unexpected.push(`${request.method} ${path}`); json(response, 403, { error: 'Unexpected fixture request' }); return;
  }
  if (path.endsWith('/history') && request.method === 'GET') {
    historyRequests++; json(response, 200, { runs: [], cursor: 0 }); return;
  }
  if (path.includes('/events?') && request.method === 'GET') {
    eventRequests++; json(response, 200, { events: [] }); return;
  }
  if (path.endsWith('/send') && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const captured = { data: JSON.parse(body) as Send, response };
    sends.push(captured);
    if (waiter) { const resolve = waiter; waiter = undefined; resolve(captured); }
    else queue.push(captured);
    return; // Test controls completion, including one deliberate transient 503.
  }
  unexpected.push(`${request.method} ${path}`); json(response, 405, { error: 'Wrong fixture method' });
});
async function nextSend(): Promise<Captured> {
  const queued = queue.shift();
  if (queued) return queued;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<Captured>(resolve => { waiter = resolve; }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Fixture did not receive send')), 5000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); waiter = undefined; }
}
function finish(send: Captured) {
  json(send.response, 201, { ...send.data, text: 'Synthetic fixture reply', status: 'done', mode: 'mock', session_id: 'fixture-session', error: '' });
}
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ executablePath: process.env.BROWSER_BINARY || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === origin) await route.continue();
    else { unexpected.push('external request blocked'); await route.abort(); }
  });
  await context.addInitScript(() => {
    localStorage.setItem('session-code.rooms', JSON.stringify(['fixture_room', 'other_room']));
  });
  const buttonState = async (disabled: boolean) => {
    await page.waitForFunction(disabled => (document.getElementById('sendButton') as HTMLButtonElement).disabled === disabled, disabled);
    assert.equal(await page.locator('#sendButton').isDisabled(), disabled);
  };
  const title = async (expected: string) => { await page.waitForFunction(expected => document.title === expected, expected); assert.equal(await page.title(), expected); };
  await page.goto(origin);
  await buttonState(true);
  await page.locator('#open-connect').click();
  await page.locator('#room').fill('fixture_room');
  await page.locator('#token').fill(syntheticToken);
  await page.locator('#connect-submit').click();
  await page.waitForFunction(() => document.getElementById('status')!.textContent === 'Connected');
  await title('fixture_room · Session Code');
  await buttonState(true);
  await page.locator('#prompt').fill(' \n\t ');
  await buttonState(true);
  // Explicit form event bypasses native validation; whitespace must still not send.
  await page.locator('#send').evaluate(el => el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(sends.length, 0);
  await page.locator('#prompt').fill('first synthetic message');
  await buttonState(false);
  await page.locator('#sendButton').click();
  const first = await nextSend();
  assert.equal(first.data.prompt, 'first synthetic message');
  await buttonState(true);
  await page.locator('#prompt').fill('edited while awaiting response');
  await buttonState(true);
  // An empty fixture poll must not re-enable sending while a response is held.
  await page.waitForResponse(response => response.url().includes('/events?'));
  await buttonState(true);
  finish(first);
  await page.waitForFunction(() => (document.getElementById('prompt') as HTMLTextAreaElement).value === '');
  await buttonState(true);
  assert.equal(await page.locator('.turn').count(), 1);
  console.log('PASS LOCAL FIXTURE connect, empty/whitespace/input/sending states and completion');

  await page.locator('#composer-add').click();
  await page.getByRole('menuitem', { name: 'Insert code block', exact: true }).click();
  assert.equal(await page.locator('#prompt').inputValue(), '```\n\n```');
  await buttonState(false);
  await page.locator('#prompt').fill('retry original payload');
  await page.locator('#sendButton').click();
  const transient = await nextSend();
  await buttonState(true);
  json(transient.response, 503, { error: 'Synthetic transient fixture failure' });
  await page.waitForFunction(() => document.getElementById('notice')!.textContent!.includes('retry the same message'));
  await buttonState(false);
  await page.locator('#prompt').fill('   ');
  await buttonState(true);
  await page.locator('#send').evaluate(el => el.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(sends.length, 2);
  await page.locator('#prompt').fill('edited draft must not replace pending retry');
  await buttonState(false);
  await page.locator('#sendButton').click();
  const retry = await nextSend();
  assert.deepEqual(retry.data, transient.data, 'Transient retry preserves ID, agent and original prompt even after whitespace submit and edit');
  assert.notEqual(retry.data.id, first.data.id);
  finish(retry);
  await page.waitForFunction(() => (document.getElementById('prompt') as HTMLTextAreaElement).value === '');
  await buttonState(true);
  console.log('PASS LOCAL FIXTURE codeblock state, 503 retry same pending ID/payload, whitespace guard');

  const currentRow = page.locator('.recent').filter({ hasText: 'fixture_room' });
  await currentRow.hover();
  await currentRow.locator('.row-menu-btn').click();
  const alias = 'Local fixture alias';
  page.once('dialog', dialog => { void dialog.accept(alias); });
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await title(alias + ' · Session Code');
  assert.equal(await page.locator('#room-footer').innerText(), 'fixture_room');
  await page.locator('.recent-open').filter({ hasText: 'other_room' }).click();
  await title('other_room · Session Code');
  await page.waitForFunction(() => document.getElementById('status')!.textContent === 'Connected');
  await page.locator('.recent-open').filter({ hasText: alias }).click();
  await title(alias + ' · Session Code');
  await page.waitForFunction(() => document.getElementById('status')!.textContent === 'Connected');
  await page.locator('#prompt').fill('unsent disconnect draft');
  await buttonState(false);
  await page.locator('#account-control').click();
  await page.locator('#disconnect-tab').click();
  await buttonState(true);
  assert.equal(await page.locator('#status').textContent(), 'Not connected');
  assert.equal(await page.locator('#token').inputValue(), '');
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.equal(stored.includes(syntheticToken), false);
  assert.equal(page.url().includes(syntheticToken), false);
  assert.equal(sends.length, 3);
  assert.ok(historyRequests >= 3 && eventRequests > 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  // Chromium logs the deliberately served 503; no other console error is allowed.
  assert.equal(consoleErrors.length, 1, 'Only the deliberate fixture 503 may log an error');
  assert.match(consoleErrors[0], /503/);
  console.log('PASS LOCAL FIXTURE connect/switch/rename tab titles, disconnect and token storage isolation');
  console.log(`RESULT LOCAL TEST-ONLY API FIXTURE PASS; exported HTML SHA256 ${createHash('sha256').update(html).digest('hex')}`);
} finally {
  await browser?.close();
  for (const send of sends) if (!send.response.writableEnded) send.response.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
