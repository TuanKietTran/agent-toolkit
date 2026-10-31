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
const fixtureEvents: Array<{ cursor: number; run_id: string; kind: string; data: string }> = [];
const pendingFixtureEvents: typeof fixtureEvents = [];
let cancelBody: { id: string } | undefined;
let activeActivity: Captured | undefined;
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
  if (!/^\/api\/rooms\/(fixture_room|other_room)\/(history|events(?:\?after=\d+)?|agents|send|cancel)$/.test(path) || request.headers.authorization !== `Bearer ${syntheticToken}`) {
    unexpected.push(`${request.method} ${path}`); json(response, 403, { error: 'Unexpected fixture request' }); return;
  }
  if (path.endsWith('/agents') && request.method === 'GET') { json(response, 200, { agents: [{ id: 'fixture-agent', label: '<img src=x onerror=alert(1)>', mode: 'mock', online: true }, { id: 'target-42', label: 'Arbitrary target', mode: 'mock', online: true }, { id: 'pi', label: 'Pi', mode: 'pi', online: false }] }); return; }
  if (path.endsWith('/cancel') && request.method === 'POST') { let body = ''; for await (const chunk of request) body += chunk; const parsedCancelBody = JSON.parse(body) as { id: string }; cancelBody = parsedCancelBody; const cancelled = { cursor: fixtureEvents.length + 1, run_id: parsedCancelBody.id, kind: 'state', data: JSON.stringify({ id: parsedCancelBody.id, agent: 'fixture-agent', prompt: 'activity and cancel check', text: 'Stable streamed text + streamed', status: 'cancelled', mode: 'mock', error: '' }) }; fixtureEvents.push(cancelled); pendingFixtureEvents.push(cancelled); if (activeActivity && !activeActivity.response.writableEnded) json(activeActivity.response, 200, { ...activeActivity.data, text: 'Stable streamed text + streamed', status: 'cancelled', mode: 'mock', session_id: 'fixture-session', error: '' }); activeActivity = undefined; json(response, 200, { cancel: true }); return; }
  if (path.endsWith('/history') && request.method === 'GET') {
    historyRequests++; json(response, 200, { runs: [], cursor: 0 }); return;
  }
  if (path.includes('/events?') && request.method === 'GET') {
    eventRequests++; json(response, 200, { events: pendingFixtureEvents.splice(0) }); return;
  }
  if (path.endsWith('/send') && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const captured = { data: JSON.parse(body) as Send, response };
    sends.push(captured);
    if (captured.data.prompt === 'activity and cancel check') {
      activeActivity = captured;
      const run = { id: captured.data.id, agent: captured.data.agent, prompt: captured.data.prompt, text: 'Stable streamed text', status: 'running', mode: 'mock', error: '' };
      const activityEvents = [
        { cursor: fixtureEvents.length + 1, run_id: captured.data.id, kind: 'state', data: JSON.stringify(run) },
        { cursor: fixtureEvents.length + 2, run_id: captured.data.id, kind: 'activity', data: JSON.stringify({ activity: { type: 'tool', name: 'search_files', status: 'started' } }) },
        { cursor: fixtureEvents.length + 3, run_id: captured.data.id, kind: 'delta', data: JSON.stringify({ text: ' + streamed' }) },
      ]; fixtureEvents.push(...activityEvents); pendingFixtureEvents.push(...activityEvents);
    }
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
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Fixture did not receive send (captured ${sends.length}; unexpected ${unexpected.join(', ')})`)), 5000); }),
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
  const fixture503Responses: string[] = [];
  const eventResponseBodies: unknown[] = [];
  page.on('response', async response => { if (response.status() === 503 && new URL(response.url()).origin === origin) fixture503Responses.push(response.url()); if (response.url().includes('/events?')) { try { eventResponseBodies.push(await response.json()); } catch {} } });
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
  await page.locator('#open-connect').click();
  const roomPattern = await page.locator('#room').getAttribute('pattern');
  assert.ok(roomPattern);
  assert.doesNotThrow(() => new RegExp(`^(?:${roomPattern})$`, 'v'), 'Room pattern must compile with the browser v flag');
  await page.locator('#room').fill('bad room');
  assert.equal(await page.locator('#room').evaluate((input: HTMLInputElement) => input.validity.patternMismatch), true);
  await page.locator('#room').fill('valid-room_42');
  assert.equal(await page.locator('#room').evaluate((input: HTMLInputElement) => input.validity.valid), true);
  await buttonState(true);
  await page.locator('#room').fill('fixture_room');
  await page.locator('#token').fill(syntheticToken);
  await page.locator('#connect-submit').click();
  await page.waitForFunction(() => document.getElementById('status')!.textContent === 'Connected');
  await title('fixture_room · Session Code');
  assert.deepEqual(await page.locator('#agent option').evaluateAll(options => options.map(option => ({ value: (option as HTMLOptionElement).value, text: option.textContent }))), [{ value: 'fixture-agent', text: '<img src=x onerror=alert(1)>' }, { value: 'target-42', text: 'Arbitrary target' }, { value: 'pi', text: 'Pi' }]);
  assert.equal(await page.locator('#agent option').first().evaluate(option => option.querySelector('img')), null);
  await page.locator('#agent').selectOption('target-42');
  assert.equal(await page.locator('#agent-capabilities').textContent(), 'Arbitrary target · Capabilities');
  await page.locator('#agent').selectOption('fixture-agent');
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

  await page.locator('#prompt').fill('activity and cancel check');
  await buttonState(false);
  await page.locator('#sendButton').click();
  const activitySend = await nextSend();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.reply-activity')).at(-1)?.textContent === 'search_files started');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.reply-text')).at(-1)?.textContent === 'Stable streamed text + streamed');
  assert.equal(await page.locator('.reply-text').last().textContent(), 'Stable streamed text + streamed');
  await page.locator('.cancel').last().click();
  await page.waitForResponse(response => response.url().endsWith('/cancel') && response.ok());
  assert.deepEqual(cancelBody, { id: activitySend.data.id });
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.reply-head')).at(-1)?.textContent?.includes('cancelled')).catch(async error => { throw Error(`${error.message}; DOM=${await page.locator('#transcript').innerText()}; pending=${JSON.stringify(pendingFixtureEvents)}`); });
  assert.equal(await page.locator('.reply-text').last().textContent(), 'Stable streamed text + streamed', 'Activity and cancel state must not corrupt streamed text');
  console.log('PASS LOCAL FIXTURE activity rendering, streamed text isolation and cancel request');

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
  assert.equal(sends.length, 4);
  assert.ok(historyRequests >= 3 && eventRequests > 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  // Chromium logs the deliberately served 503; no other console error is allowed.
  assert.equal(fixture503Responses.length, 1, 'The fixture deliberately served exactly one 503');
  assert.ok(fixture503Responses[0].endsWith('/api/rooms/fixture_room/send'), 'The sole 503 must be the deliberate send retry fixture response');
  const known503Message = 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';
  const known503Errors = consoleErrors.filter(message => message === known503Message);
  assert.equal(known503Errors.length, 1, 'The console error must match the browser message for the correlated fixture 503');
  assert.equal(consoleErrors.length, 1, 'Unexpected console errors must be zero: ' + consoleErrors.filter(message => !/503/.test(message)).join(' | '));
  console.log('PASS LOCAL FIXTURE connect/switch/rename tab titles, disconnect and token storage isolation');
  console.log(`RESULT LOCAL TEST-ONLY API FIXTURE PASS; exported HTML SHA256 ${createHash('sha256').update(html).digest('hex')}`);
} finally {
  await browser?.close();
  for (const send of sends) if (!send.response.writableEnded) send.response.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
