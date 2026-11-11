import assert from 'node:assert/strict';
import { test } from 'node:test';
import browserControlCdp from '../index.ts';
import { TOOL_NAMES } from '../contract.ts';

type Call = { agent: string; tool: string; params: any };
function setup(canned: (tool: string, params: any) => any, agent?: string) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const calls: Call[] = [];
  const controller: any = {
    ownership: undefined,
    async connect() { return { ok: true, browser: 'fake' }; },
    async close() {},
    halted() { return undefined; },
    resume() {},
    async call(a: string, tool: string, params: any) { calls.push({ agent: a, tool, params }); return canned(tool, params); },
  };
  const pi: any = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, def: any) { commands.set(name, def); },
    on() {},
  };
  browserControlCdp(pi, agent ? { controller, agent: () => agent } : { controller });
  const run = (name: string, args: object) => tools.get(name).execute('id', args, undefined, undefined, {});
  return { tools, commands, calls, run };
}
const ok = (text = 'done') => ({ ok: true, text });

test('tools: exactly the 13 contract tools are registered', () => {
  const { tools } = setup(() => ok());
  assert.deepEqual([...tools.keys()].sort(), [...TOOL_NAMES].sort());
  for (const name of TOOL_NAMES) assert.ok(tools.get(name).parameters, `${name} has a parameter schema`);
});

test('tools: the /bc slash command is registered', () => {
  const { commands } = setup(() => ok());
  assert.ok(commands.has('bc'));
});

test('tools: calls go to the controller with the deps agent id and verbatim params', async () => {
  const { calls, run } = setup(() => ok(), 'qa-agent');
  await run('click', { tab: 'tab-1', ref: 'e3', user_confirmed: true });
  await run('type', { tab: 'tab-1', ref: 'e4', text: 'hello' });
  await run('tabs_list', {});
  assert.deepEqual(calls.map((c) => c.tool), ['click', 'type', 'tabs_list']);
  assert.ok(calls.every((c) => c.agent === 'qa-agent'));
  assert.deepEqual(calls[0].params, { tab: 'tab-1', ref: 'e3', user_confirmed: true });
  assert.deepEqual(calls[1].params, { tab: 'tab-1', ref: 'e4', text: 'hello' });
});

test('tools: agent id falls back to H1_SELF, then to pi', async () => {
  const saved = process.env.H1_SELF;
  try {
    process.env.H1_SELF = 'env-agent';
    const a = setup(() => ok());
    await a.run('tabs_list', {});
    assert.equal(a.calls[0].agent, 'env-agent');
    delete process.env.H1_SELF;
    const b = setup(() => ok());
    await b.run('tabs_list', {});
    assert.equal(b.calls[0].agent, 'pi');
  } finally { if (saved === undefined) delete process.env.H1_SELF; else process.env.H1_SELF = saved; }
});

test('tools: ok results map to a text content block', async () => {
  const { run } = setup(() => ok('opened tab-9'));
  const r = await run('tab_open', { url: 'about:blank' });
  assert.equal(r.content[0].type, 'text');
  assert.match(r.content[0].text, /opened tab-9/);
});

test('tools: screenshot results include an image content block', async () => {
  const data = Buffer.from('png-bytes').toString('base64');
  const { run } = setup(() => ({ ok: true, text: 'screenshot', image: { mimeType: 'image/png', data } }));
  const r = await run('screenshot', { tab: 'tab-1' });
  const img = r.content.find((c: any) => c.type === 'image');
  assert.ok(img, 'expected an image block');
  assert.equal(img.data, data);
  assert.equal(img.mimeType, 'image/png');
});

test('tools: STOP results are surfaced as text + details, never thrown', async () => {
  const stop = { ok: false, stop: true, reason: 'captcha', tab: 'tab-1', url: 'http://127.0.0.1/captcha.html', message: 'STOP: captcha challenge on the page; hand over to the user.' };
  const { run } = setup(() => stop);
  const r = await run('click', { tab: 'tab-1', ref: 'e2' });
  assert.equal(r.content[0].type, 'text');
  assert.ok(r.content[0].text.startsWith('STOP:'));
  assert.deepEqual(r.details, stop);
});

test('tools: error results are surfaced as text + details with the code, never thrown', async () => {
  const err = { ok: false, stop: false, code: 'not_owned', message: 'tab-9 is not owned by this agent' };
  const { run } = setup(() => err);
  const r = await run('snapshot', { tab: 'tab-9' });
  assert.match(r.content[0].text, /not owned/);
  assert.equal(r.details.code, 'not_owned');
  assert.deepEqual(r.details, err);
});

test('tools: click/type schemas name tab and ref', () => {
  const { tools } = setup(() => ok());
  for (const name of ['click', 'type', 'select', 'upload']) {
    const schema = JSON.stringify(tools.get(name).parameters);
    assert.ok(schema.includes('tab'), `${name} schema mentions tab`);
    assert.ok(schema.includes('ref'), `${name} schema mentions ref`);
  }
});
