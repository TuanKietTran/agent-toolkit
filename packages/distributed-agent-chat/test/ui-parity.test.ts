import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';

// STRUCTURE ONLY: GET / does not execute client JavaScript. These assertions
// cannot prove interaction, focus, responsive layout, or rendered recent rows.
// scripts/parity-browser.ts covers those in an isolated current-source browser.
// test/ui.browser.mjs is a separate live opt-in integration test, not that suite.
const tokens = { CHAT_TOKEN: 'test-user-not-a-credential', PI_TOKEN: 'test-pi-not-a-credential', CLAUDE_TOKEN: 'test-claude-not-a-credential' };

test('UI parity: static response structure only', async t => {
  await mkdir('.wrangler/test', { recursive: true });
  const dir = await mkdtemp(resolve('.wrangler/test/parity-'));
  let mf: Miniflare | undefined;
  try {
    await build({ entryPoints: ['src/worker.ts'], bundle: true, format: 'esm', outfile: dir + '/worker.js' });
    mf = new Miniflare({ modules: true, scriptPath: dir + '/worker.js', compatibilityDate: '2025-10-11', durableObjects: { ROOMS: { className: 'Room', useSQLite: true } }, durableObjectsPersist: dir + '/state', bindings: tokens, port: 0 });
    await mf.ready;
    const response = await mf.dispatchFetch('http://localhost/');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    const html = await response.text();
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    // Parse individual opening tags so attributes on unrelated elements cannot
    // satisfy a control's assertion. Quoted attributes may contain > characters.
    const tags = [...markup.matchAll(/<([a-z][\w-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi)].map(m => ({ name: m[1].toLowerCase(), attrs: m[2] }));
    function element(id: string, name: string) {
      const found = tags.find(tag => new RegExp(`\\bid=["']${id}["']`).test(tag.attrs));
      assert.ok(found, `Required #${id} is absent`);
      assert.equal(found.name, name, `#${id} must be a ${name}`);
      return found;
    }
    await t.test('sidebar-toggle: required button', () => { element('sidebar-toggle', 'button'); });
    await t.test('recents-collapse: button has aria-expanded', () => {
      assert.match(element('recents-toggle', 'button').attrs, /\baria-expanded=["'](?:true|false)["']/);
    });
    await t.test('recents-row-menu: client construction marker (not rendered DOM)', () => {
      element('recents', 'nav');
      assert.match(html, /row-menu-btn/, 'Required row-menu construction is absent; browser test verifies rendered buttons');
    });
    await t.test('sort-control: required button', () => { element('recents-sort', 'button'); });
    await t.test('agent-select: pi and claude options belong to select', () => {
      element('agent', 'select');
      const select = markup.match(/<select\b[^>]*\bid=["']agent["'][^>]*>([\s\S]*?)<\/select>/i);
      assert.ok(select, '#agent select body missing');
      for (const agent of ['pi', 'claude']) assert.match(select[1], new RegExp(`<option\\b[^>]*\\bvalue=["']${agent}["']`));
    });
    await t.test('dynamic agent labels use text content and activity events stay separate from reply text', () => {
      assert.match(html, /option\.textContent=agent\.label/);
      assert.match(html, /e\.kind==='delta'[^;]*runs\.get\(e\.run_id\)\.text\+=/);
      assert.match(html, /e\.kind==='activity'&&runs\.has\(e\.run_id\)\)\{const value=data\.activity\|\|\{\};if\(value\.type==='tool'\)activities\.set\(e\.run_id/);
      assert.match(html, /n\.activity\.textContent=activities\.get\(r\.id\)/);
    });
    await t.test('send-button: this button is initially disabled', () => {
      assert.match(element('sendButton', 'button').attrs, /(?:^|\s)disabled(?:\s|=|$)/);
    });
    await t.test('connect-dialog: actual dialog element', () => {
      const found = tags.find(tag => tag.name === 'dialog' && /\bid=["'](?:connect-dialog|connection)["']/.test(tag.attrs));
      assert.ok(found, 'Required connection dialog missing');
    });
  } finally {
    if (mf) await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
