import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { agentWorker } from '../src/agent/worker';

const tokens = { CHAT_TOKEN: 'test-user-not-a-credential', PI_TOKEN: 'test-pi-not-a-credential', CLAUDE_TOKEN: 'test-claude-not-a-credential' };
async function setup() {
  await mkdir('.wrangler/test', { recursive: true });
  const dir = await mkdtemp(resolve('.wrangler/test/runtime-'));
  await build({ entryPoints: ['src/worker.ts'], bundle: true, format: 'esm', outfile: dir + '/worker.js' });
  const create = () => new Miniflare({ modules: true, scriptPath: dir + '/worker.js', compatibilityDate: '2025-10-11', durableObjects: { ROOMS: { className: 'Room', useSQLite: true } }, durableObjectsPersist: dir + '/state', bindings: tokens, port: 0 });
  let mf = create();
  await mf.ready;
  const request = async (op: string, data?: any, token = tokens.CHAT_TOKEN, room = 'test') => {
    const r = await mf.dispatchFetch(`http://localhost/api/rooms/${room}/${op}`, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: r.status, body: await r.json() as any };
  };
  return { request, url: () => mf.ready, close: () => mf.dispose(), restart: async () => { await mf.dispose(); mf = create(); await mf.ready; } };
}
async function until(fn: () => Promise<boolean>, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(40); }
  assert.fail('Condition did not become true');
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const closed = once(child, 'close'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  await closed; clearTimeout(timer);
}
test('real Workers SQLite runtime: auth, isolation, atomic claims, replay, fencing and restart', async () => {
  const s = await setup();
  try {
    assert.equal((await s.request('history', undefined, '')).status, 401);
    const configured = await s.request('agents');
    assert.deepEqual(configured.body.agents.map((a: any) => a.id).sort(), ['claude','pi']);
    assert.ok(configured.body.agents.every((a: any) => !('token' in a)));
    await assert.rejects(agentWorker({ mode: 'mock', agent: 'pi', worker: 'bad-auth', room: 'test', url: (await s.url()).origin, token: 'invalid', cwd: process.cwd(), dataDir: '.wrangler/test' }, new AbortController().signal), /401/);
    assert.equal((await s.request('send', { id: 'bad', agent: 'pi', prompt: 'x' }, tokens.PI_TOKEN)).status, 401);
    assert.equal((await s.request('send', { id: 'one', agent: 'pi', prompt: 'hello' })).status, 201);
    assert.equal((await s.request('send', { id: 'one', agent: 'pi', prompt: 'hello' })).status, 200);
    assert.equal((await s.request('send', { id: 'two', agent: 'pi', prompt: 'busy' })).status, 409);
    assert.equal((await s.request('history', undefined, tokens.CHAT_TOKEN, 'other')).body.runs.length, 0);
    assert.equal((await s.request('agent/pi/claim', { worker: 'p', mode: 'pi' }, tokens.CLAUDE_TOKEN)).status, 401);
    assert.equal((await s.request('agent/constructor/claim', { worker: 'phantom', mode: 'mock' }, tokens.PI_TOKEN)).status, 401);
    assert.equal((await s.request('agent/__proto__/claim', { worker: 'phantom', mode: 'mock' }, tokens.PI_TOKEN)).status, 401);
    const claims = await Promise.all([1,2].map(() => s.request('agent/pi/claim', { worker: 'p', mode: 'mock' }, tokens.PI_TOKEN)));
    assert.equal(claims.filter(r => r.body.task).length, 1);
    const t = claims.find(r => r.body.task)!.body.task;
    assert.equal(t.resume, false);
    assert.equal((await s.request('agent/pi/update', { worker: 'p', id: t.id, seq: 2, update: { kind: 'delta', text: 'gap' } }, tokens.PI_TOKEN)).status, 409);
    for (let i = 0; i < 2; i++) assert.equal((await s.request('agent/pi/update', { worker: 'p', id: t.id, seq: 1, update: { kind: 'delta', text: 'Hi' } }, tokens.PI_TOKEN)).status, 200);
    await s.request('agent/pi/update', { worker: 'p', id: t.id, seq: 2, update: { kind: 'session', providerSessionId: 'provider-session-1' } }, tokens.PI_TOKEN);
    await s.request('agent/pi/update', { worker: 'p', id: t.id, seq: 3, update: { kind: 'done' } }, tokens.PI_TOKEN);
    assert.equal((await s.request('history')).body.runs[0].text, 'Hi');
    await s.restart();
    assert.equal((await s.request('history')).body.runs[0].status, 'done');
    const events = (await s.request('events?after=0')).body.events;
    assert.equal(events.filter((e: any) => e.kind === 'delta').length, 1);
    assert.ok(events.every((e: any, i: number) => i === 0 || e.cursor > events[i - 1].cursor));
    await s.request('send', { id: 'next', agent: 'pi', prompt: 'continue' });
    assert.equal((await s.request('agent/pi/claim', { worker: 'other', mode: 'mock' }, tokens.PI_TOKEN)).status, 409);
    const resumed = (await s.request('agent/pi/claim', { worker: 'p', mode: 'mock' }, tokens.PI_TOKEN)).body.task;
    assert.equal(resumed.session_id, t.session_id); assert.equal(resumed.resume, true);
    assert.equal(resumed.provider_session_id, 'provider-session-1');
    await s.request('cancel', { id: 'next' });
    assert.equal((await s.request('agent/pi/heartbeat', { worker: 'p', id: 'next' }, tokens.PI_TOKEN)).body.cancel, true);
    assert.equal((await s.request('agent/pi/update', { worker: 'p', id: 'next', seq: 1, update: { kind: 'delta', text: 'late' } }, tokens.PI_TOKEN)).status, 409);
  } finally { await s.close(); }
});

test('agent activity API persists only safe summaries and rejects raw payload fields', async () => {
  const s = await setup();
  try {
    await s.request('send', { id: 'activity-run', agent: 'pi', prompt: 'inspect' });
    const task = (await s.request('agent/pi/claim', { worker: 'p', mode: 'mock' }, tokens.PI_TOKEN)).body.task;
    const update = (seq: number, activity: unknown) => s.request('agent/pi/update', { worker: 'p', id: task.id, seq, update: { kind: 'activity', activity } }, tokens.PI_TOKEN);
    assert.equal((await update(1, { type: 'tool', name: 'Read', status: 'started', arguments: 'secret prompt' })).status, 400);
    assert.equal((await update(1, { type: 'tool', name: 'Read', status: 'started' })).status, 200);
    assert.equal((await update(2, { type: 'usage', usage: { input: 12, output: 4, credential: 'secret' } })).status, 400);
    assert.equal((await update(2, { type: 'usage', usage: { input: 12, output: 4 } })).status, 200);
    const events = (await s.request('events?after=0')).body.events.filter((e: any) => e.kind === 'activity');
    assert.deepEqual(events.map((e: any) => JSON.parse(e.data)), [
      { type: 'tool', name: 'Read', status: 'started' },
      { type: 'usage', usage: { input: 12, output: 4 } }
    ]);
    assert.equal(JSON.stringify(events).includes('secret'), false);
  } finally { await s.close(); }
});

test('two executable MOCK agents: incremental output, continuity, cancellation, history, no ping-pong', async () => {
  const s = await setup(); const children: ChildProcess[] = [];
  try {
    const url = (await s.url()).origin;
    for (const agent of ['pi','claude']) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/agent/cli.ts'], {
        cwd: process.cwd(), env: { ...process.env, CHAT_URL: url, ROOM: 'test', AGENT_MODE: 'mock', AGENT_ID: agent, WORKER_ID: `${agent}-mock`, AGENT_TOKEN: agent === 'pi' ? tokens.PI_TOKEN : tokens.CLAUDE_TOKEN }, stdio: 'ignore'
      }); children.push(child);
    }
    await s.request('send', { id: 'pi-first', agent: 'pi', prompt: 'first message' });
    await s.request('send', { id: 'claude-first', agent: 'claude', prompt: 'second message' });
    await until(async () => { const runs = (await s.request('history')).body.runs; return runs.length === 2 && runs.every((r: any) => r.status === 'done'); });
    const before = (await s.request('history')).body;
    assert.ok(before.runs.every((r: any) => r.mode === 'mock' && r.text.includes('[MOCK')));
    assert.ok((await s.request('events?after=0')).body.events.filter((e: any) => e.kind === 'delta').length > 5);
    await delay(1000);
    assert.equal((await s.request('history')).body.runs.length, 2); // outputs cannot enqueue work
    await s.request('send', { id: 'pi-again', agent: 'pi', prompt: 'follow-up' });
    await until(async () => (await s.request('history')).body.runs.some((r: any) => r.id === 'pi-again' && r.status === 'done'));
    const next = (await s.request('history')).body.runs.find((r: any) => r.id === 'pi-again');
    assert.equal(next.session_id, before.runs.find((r: any) => r.agent === 'pi').session_id);
    assert.match(next.text, /resumed/);
    // Restart the external worker under the same identity; session metadata persists server-side.
    await stop(children[0]);
    children[0] = spawn(process.execPath, ['--import','tsx','src/agent/cli.ts'], { env: { ...process.env, CHAT_URL: url, ROOM: 'test', AGENT_MODE: 'mock', AGENT_ID: 'pi', WORKER_ID: 'pi-mock', AGENT_TOKEN: tokens.PI_TOKEN }, stdio: 'ignore' });
    await s.request('send', { id: 'cancel-me', agent: 'pi', prompt: 'long '.repeat(1000) });
    await until(async () => (await s.request('history')).body.runs.some((r: any) => r.id === 'cancel-me' && r.text.length > 0));
    await s.request('cancel', { id: 'cancel-me' });
    const cancelled = (await s.request('history')).body.runs.find((r: any) => r.id === 'cancel-me');
    await delay(2300);
    const after = (await s.request('history')).body.runs.find((r: any) => r.id === 'cancel-me');
    assert.equal(after.status, 'cancelled'); assert.equal(after.text, cancelled.text); assert.equal(after.session_id, next.session_id);
    for (const c of children) assert.equal(c.exitCode, null);
    const history = (await s.request('history')).body;
    await s.restart();
    assert.deepEqual((await s.request('history')).body, history);
  } finally { await Promise.all(children.map(stop)); await s.close(); }
});
