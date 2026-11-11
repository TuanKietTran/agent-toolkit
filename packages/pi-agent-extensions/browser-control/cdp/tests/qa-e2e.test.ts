import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController, type Controller } from '../controller.ts';
import { resolveBravePath } from '../launch.ts';
import { FAST_PACING, REF_PATTERN } from '../contract.ts';
import { startFixtureServer, type FixtureServer } from '../fixture/server.ts';

const AGENT = 'qa-e2e';
const bravePath = resolveBravePath();
const hasBrave = !!bravePath && existsSync(bravePath);

let fixture: FixtureServer | undefined;
let base = '';
let brave: ChildProcess | undefined;
let profileDir = '';
let port = 0;
let ctl: Controller | undefined;
let tab = '';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
  });
}
async function waitForBrave(p: number): Promise<void> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${p}/json/version`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Brave debugging port never came up');
}
async function rawTargets(): Promise<any[]> {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}
// Simulates the USER driving their own tab (the controller is never involved).
async function rawNavigate(targetId: string, url: string): Promise<void> {
  const targets = await rawTargets();
  const t = targets.find((x) => x.id === targetId);
  assert.ok(t?.webSocketDebuggerUrl, 'target has a websocket url');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')); });
  let id = 0;
  const send = (method: string, params: object = {}) => new Promise<any>((resolve) => {
    const my = ++id;
    const onMsg = (ev: MessageEvent) => { const m = JSON.parse(String(ev.data)); if (m.id === my) { ws.removeEventListener('message', onMsg); resolve(m); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  await send('Page.enable');
  await send('Page.navigate', { url });
  ws.close();
  await new Promise((r) => setTimeout(r, 700));
}
async function userTabId(): Promise<string> {
  let targets = (await rawTargets()).filter((x) => x.type === 'page');
  let other = targets.find((x) => x.id !== tab);
  if (!other) {
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    await new Promise((r) => setTimeout(r, 400));
    targets = (await rawTargets()).filter((x) => x.type === 'page');
    other = targets.find((x) => x.id !== tab);
  }
  assert.ok(other, 'a tab not opened by the agent exists');
  return other.id;
}
const call = (tool: any, params: any): Promise<any> => (ctl as Controller).call(AGENT, tool, params);
async function snap(tabId: string): Promise<string> {
  const r = await call('snapshot', { tab: tabId });
  assert.equal(r.ok, true, `snapshot failed: ${JSON.stringify(r)}`);
  return r.text as string;
}
function refFor(text: string, name: string): string {
  for (const line of text.split('\n')) {
    if (line.includes(`"${name}"`)) { const m = line.match(/\[(e\d+)\]/); if (m) return m[1]; }
  }
  assert.fail(`no ref for "${name}" in snapshot:\n${text}`);
}
async function ensureTab(): Promise<string> {
  if (tab) return tab;
  const r = await call('tab_open', { url: `${base}/page.html` });
  assert.equal(r.ok, true, `tab_open failed: ${JSON.stringify(r)}`);
  tab = (r.data?.tab as string) ?? (r.data?.tabId as string) ?? '';
  assert.ok(tab, `tab_open returned no tab id: ${JSON.stringify(r)}`);
  return tab;
}
function e2e(name: string, fn: (t: any) => Promise<void>) {
  test(name, { skip: hasBrave ? false : 'Brave not installed (resolveBravePath found nothing)' }, async (t) => {
    if (!hasBrave || !ctl) return;
    await fn(t);
  });
}

before(async () => {
  if (!hasBrave) return;
  fixture = await startFixtureServer();
  base = fixture.origin;
  port = await freePort();
  profileDir = await mkdtemp(join(tmpdir(), 'bc-qa-e2e-'));
  brave = spawn(bravePath as string, ['--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  await waitForBrave(port);
  ctl = createController({ port, pacing: { ...FAST_PACING } });
  const c = await ctl.connect();
  assert.equal(c.ok, true, `connect failed: ${JSON.stringify(c)}`);
});

after(async () => {
  try { await ctl?.close(); } catch {}
  if (brave && !brave.killed) brave.kill('SIGTERM');
  if (brave) await Promise.race([new Promise((r) => (brave as ChildProcess).once('exit', r)), new Promise((r) => setTimeout(r, 4000))]);
  if (profileDir) await rm(profileDir, { recursive: true, force: true });
  await fixture?.close();
});

e2e('e2e: agent tab is listed, the user tab is invisible and untouchable', async () => {
  const id = await ensureTab();
  const list = await call('tabs_list', {});
  assert.equal(list.ok, true);
  assert.ok(JSON.stringify(list).includes(id), 'tabs_list includes the owned tab');
  const other = await userTabId();
  assert.ok(!JSON.stringify(list).includes(other), 'tabs_list must not include the user tab');
  const s = await call('snapshot', { tab: other });
  assert.equal(s.ok, false);
  assert.ok(['not_owned', 'no_such_tab'].includes(s.code), `snapshot on user tab: ${JSON.stringify(s)}`);
  const c = await call('press', { tab: other, key: 'a' });
  assert.equal(c.ok, false);
  assert.ok(['not_owned', 'no_such_tab'].includes(c.code), `press on user tab: ${JSON.stringify(c)}`);
});

e2e('e2e: snapshot has a header line and stable refs across snapshots', async () => {
  const id = await ensureTab();
  const s1 = await snap(id);
  const first = s1.split('\n')[0];
  assert.ok(first.startsWith('#'), `first line is a header: ${first}`);
  assert.ok(first.includes('page.html'), first);
  for (const m of s1.matchAll(/\[(e\d+)\]/g)) assert.ok(REF_PATTERN.test(m[1]), m[1]);
  const ping1 = refFor(s1, 'Ping');
  const order1 = refFor(s1, 'Place order');
  const name1 = refFor(s1, 'Full name');
  const s2 = await snap(id);
  assert.equal(refFor(s2, 'Ping'), ping1);
  assert.equal(refFor(s2, 'Place order'), order1);
  assert.equal(refFor(s2, 'Full name'), name1);
});

e2e('e2e: click, type and press work through CDP input', async () => {
  const id = await ensureTab();
  const s = await snap(id);
  const ping = await call('click', { tab: id, ref: refFor(s, 'Ping') });
  assert.equal(ping.ok, true, JSON.stringify(ping));
  const pong = await call('wait_for', { tab: id, text: 'pong', timeout_ms: 5000 });
  assert.equal(pong.ok, true, `wait_for pong: ${JSON.stringify(pong)}`);
  const t1 = await call('type', { tab: id, ref: refFor(s, 'Full name'), text: 'Ada Lovelace' });
  assert.equal(t1.ok, true, JSON.stringify(t1));
  const t2 = await call('type', { tab: id, ref: refFor(s, 'Email'), text: 'ada@example.test' });
  assert.equal(t2.ok, true, JSON.stringify(t2));
  const after = await snap(id);
  assert.ok(after.includes('Ada Lovelace'), `typed value visible in snapshot:\n${after}`);
  const pk = await call('press', { tab: id, key: 'Tab' });
  assert.equal(pk.ok, true, JSON.stringify(pk));
  const agree = await call('click', { tab: id, ref: refFor(after, 'I agree to the terms') });
  assert.equal(agree.ok, true, JSON.stringify(agree));
});

e2e('e2e: select, scroll, upload, wait_for and screenshot work', async () => {
  const id = await ensureTab();
  const s = await snap(id);
  const sel = await call('select', { tab: id, ref: refFor(s, 'Colour'), value: 'green' });
  assert.equal(sel.ok, true, JSON.stringify(sel));
  const sel2 = await call('select', { tab: id, ref: refFor(s, 'Colour'), value: 'Blue' });
  assert.equal(sel2.ok, true, `select by label: ${JSON.stringify(sel2)}`);
  const sc = await call('scroll', { tab: id, direction: 'down', amount: 600 });
  assert.equal(sc.ok, true, JSON.stringify(sc));
  const sc2 = await call('scroll', { tab: id, direction: 'up', amount: 300 });
  assert.equal(sc2.ok, true, JSON.stringify(sc2));
  const file = fileURLToPath(new URL('../fixture/upload.txt', import.meta.url));
  const up = await call('upload', { tab: id, ref: refFor(s, 'Attachment'), file });
  assert.equal(up.ok, true, JSON.stringify(up));
  const late = await call('wait_for', { tab: id, text: 'Delayed content loaded', timeout_ms: 8000 });
  assert.equal(late.ok, true, `wait_for delayed: ${JSON.stringify(late)}`);
  const absent = await call('wait_for', { tab: id, text: 'No such text xyzzy', timeout_ms: 600 });
  assert.equal(absent.ok, false);
  assert.equal(absent.code, 'timeout', JSON.stringify(absent));
  const shot = await call('screenshot', { tab: id });
  assert.equal(shot.ok, true, JSON.stringify(shot).slice(0, 200));
  assert.equal(shot.image?.mimeType, 'image/png');
  const bytes = Buffer.from(shot.image.data, 'base64');
  assert.ok(bytes.length > 500, 'png has real content');
  assert.deepEqual([...bytes.subarray(0, 4)], [137, 80, 78, 71], 'png magic bytes');
});

e2e('e2e: no focus stealing (no Page.bringToFront / Target.activateTarget on the wire)', async (t) => {
  const id = await ensureTab();
  await snap(id);
  const objs: any[] = [ctl, (ctl as any).client, (ctl as any).cdp, (ctl as any).connection, (ctl as any).browser];
  let log: any[] | undefined;
  for (const o of objs) {
    if (!o) continue;
    for (const k of ['sent', 'sentMessages', 'sentLog', 'messages', 'log', 'frames', 'calls']) {
      if (Array.isArray(o[k]) && o[k].length) { log = o[k]; break; }
    }
    if (log) break;
  }
  if (!log) { t.skip('controller exposes no CDP message tap; focus stealing not observable headless'); return; }
  const wire = JSON.stringify(log);
  assert.ok(!wire.includes('Page.bringToFront'), 'Page.bringToFront must never be sent');
  assert.ok(!wire.includes('Target.activateTarget'), 'Target.activateTarget must never be sent');
});

e2e('e2e: submit guard requires confirmation for Place order and Delete', async () => {
  const id = await ensureTab();
  const s = await snap(id);
  const del = await call('click', { tab: id, ref: refFor(s, 'Delete item') });
  assert.equal(del.ok, false, JSON.stringify(del));
  assert.equal(del.code, 'confirm_required', JSON.stringify(del));
  const delOk = await call('click', { tab: id, ref: refFor(s, 'Delete item'), user_confirmed: true });
  assert.equal(delOk.ok, true, JSON.stringify(delOk));
  const delSeen = await call('wait_for', { tab: id, text: 'deleted', timeout_ms: 5000 });
  assert.equal(delSeen.ok, true);
  const sub = await call('click', { tab: id, ref: refFor(s, 'Place order') });
  assert.equal(sub.ok, false, JSON.stringify(sub));
  assert.equal(sub.code, 'confirm_required', JSON.stringify(sub));
  const subOk = await call('click', { tab: id, ref: refFor(s, 'Place order'), user_confirmed: true });
  assert.equal(subOk.ok, true, JSON.stringify(subOk));
  const landed = await call('wait_for', { tab: id, text: 'Order placed', timeout_ms: 8000 });
  assert.equal(landed.ok, true, `after submit: ${JSON.stringify(landed)}`);
  const back = await call('navigate', { tab: id, url: `${base}/page.html` });
  assert.equal(back.ok, true, JSON.stringify(back));
});

e2e('e2e: typing into a password field is always refused', async () => {
  const id = await ensureTab();
  const nav = await call('navigate', { tab: id, url: `${base}/password.html` });
  assert.equal(nav.ok, true, JSON.stringify(nav));
  const s = await snap(id);
  const r = await call('type', { tab: id, ref: refFor(s, 'Secret'), text: 'hunter2' });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'password_field', JSON.stringify(r));
  const back = await call('navigate', { tab: id, url: `${base}/page.html` });
  assert.equal(back.ok, true, JSON.stringify(back));
});

e2e('e2e: captcha STOP, actions refuse while snapshot works, resume after leaving the page', async () => {
  const id = await ensureTab();
  const nav = await call('navigate', { tab: id, url: `${base}/captcha.html` });
  const s = await snap(id);
  const stopped = (nav.ok === false && nav.stop === true && nav.reason === 'captcha') || s.startsWith('BLOCKED:');
  assert.ok(stopped, `expected a captcha STOP, nav=${JSON.stringify(nav)} snap=${s.split('\n')[0]}`);
  if (nav.ok === false && nav.stop === true) assert.ok(nav.message.startsWith('STOP:'));
  assert.ok(s.includes('captcha'), `blocked snapshot names the reason:\n${s}`);
  const act = await call('press', { tab: id, key: 'a' });
  assert.equal(act.ok, false);
  assert.equal(act.stop, true, JSON.stringify(act));
  assert.equal(act.reason, 'captcha');
  const shot = await call('screenshot', { tab: id });
  assert.equal(shot.ok, true, 'screenshot stays available during a STOP');
  // The user leaves the page themselves; the next action must clear the halt and work.
  await rawNavigate(id, `${base}/page.html`);
  const s2 = await snap(id);
  const ping = await call('click', { tab: id, ref: refFor(s2, 'Ping') });
  assert.equal(ping.ok, true, `action after leaving blocked page: ${JSON.stringify(ping)}`);
});

e2e('e2e: login wall, rate limit, unusual traffic and bot check all STOP', async () => {
  const id = await ensureTab();
  const pages: Array<[string, string]> = [
    ['login.html', 'login_wall'],
    ['ratelimit.html', 'rate_limit'],
    ['traffic.html', 'unusual_traffic'],
    ['cloudflare.html', 'bot_check'],
  ];
  for (const [page, reason] of pages) {
    const nav = await call('navigate', { tab: id, url: `${base}/${page}` });
    const s = await snap(id);
    const stopped = (nav.ok === false && nav.stop === true && nav.reason === reason) || (s.startsWith('BLOCKED:') && s.includes(reason));
    assert.ok(stopped, `${page}: expected STOP ${reason}, nav=${JSON.stringify(nav)} snap=${s.split('\n')[0]}`);
    const act = await call('press', { tab: id, key: 'a' });
    assert.equal(act.ok, false, `${page}: action during STOP`);
    assert.equal(act.stop, true, `${page}: ${JSON.stringify(act)}`);
    assert.equal(act.reason, reason, `${page}`);
    const shot = await call('screenshot', { tab: id });
    assert.equal(shot.ok, true, `${page}: screenshot during STOP`);
    (ctl as Controller).resume();
    await rawNavigate(id, `${base}/page.html`);
    const s2 = await snap(id);
    const ping = await call('click', { tab: id, ref: refFor(s2, 'Ping') });
    assert.equal(ping.ok, true, `${page}: action after resume: ${JSON.stringify(ping)}`);
  }
});

e2e('e2e: default pacing spaces actions out', async () => {
  const ctl2 = createController({ port });
  const c = await ctl2.connect();
  assert.equal(c.ok, true, JSON.stringify(c));
  try {
    const open = await ctl2.call(AGENT, 'tab_open', { url: `${base}/page.html` });
    assert.equal(open.ok, true, JSON.stringify(open));
    const t2 = (open.data?.tab as string) ?? (open.data?.tabId as string);
    assert.ok(t2);
    const s = await ctl2.call(AGENT, 'snapshot', { tab: t2 });
    assert.equal(s.ok, true);
    const ref = refFor((s as any).text, 'Ping');
    const t0 = Date.now();
    const a = await ctl2.call(AGENT, 'click', { tab: t2, ref });
    const b = await ctl2.call(AGENT, 'click', { tab: t2, ref });
    const elapsed = Date.now() - t0;
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.ok(elapsed >= 350, `two default-paced actions took ${elapsed}ms; expected the 400ms minimum gap (50ms tolerance)`);
    await ctl2.call(AGENT, 'tab_close', { tab: t2 });
  } finally { await ctl2.close(); }
});

e2e('e2e: tab_close removes the tab and later calls fail cleanly', async () => {
  const id = await ensureTab();
  const close = await call('tab_close', { tab: id });
  assert.equal(close.ok, true, JSON.stringify(close));
  const after = await call('snapshot', { tab: id });
  assert.equal(after.ok, false);
  assert.ok(['no_such_tab', 'not_owned'].includes(after.code), JSON.stringify(after));
  const list = await call('tabs_list', {});
  assert.ok(!JSON.stringify(list).includes(id));
  tab = '';
});
