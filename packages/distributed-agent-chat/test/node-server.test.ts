import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import { createNode, checkTokens } from '../src/node-server';
import { agentWorker } from '../src/agent/worker';

// Throwaway test values, not credentials.
const tokens = { CHAT_TOKEN: 'test-user-token-not-a-credential-1', PI_TOKEN: 'test-pi-token-not-a-credential-22', CLAUDE_TOKEN: 'test-claude-token-not-a-credential-3' };
const listen = (node: ReturnType<typeof createNode>) => new Promise<string>(res => node.server.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${(node.server.address() as AddressInfo).port}`)));
const call = async (base: string, path: string, data?: unknown, token = tokens.CHAT_TOKEN) => {
  const r = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: r.status, body: await r.json() as any };
};
async function until(fn: () => Promise<boolean>, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(40); }
  assert.fail('Condition did not become true');
}

test('token policy refuses short or reused secrets', () => {
  assert.throws(() => checkTokens({ ...tokens, PI_TOKEN: 'short' }));
  assert.throws(() => checkTokens({ ...tokens, PI_TOKEN: tokens.CHAT_TOKEN }));
  checkTokens(tokens);
});

test('node mode: owner + gateway share one room; MOCK agent on each node answers; unauthenticated refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dac-node-'));
  const owner = createNode({ tokens, dataDir: dir, name: 'A' });
  const a = await listen(owner);
  const gateway = createNode({ tokens, upstream: a, name: 'B' });
  const b = await listen(gateway);
  const stop = new AbortController();
  const common = { room: 'poc', cwd: '.', dataDir: dir, pollMs: 50, heartbeatMs: 200, mockDelayMs: 1, mode: 'mock' as const };
  const workers = [
    agentWorker({ ...common, agent: 'pi', worker: 'pi-on-A', url: a, token: tokens.PI_TOKEN }, stop.signal),      // MOCK worker on node A (owner)
    agentWorker({ ...common, agent: 'claude', worker: 'claude-on-B', url: b, token: tokens.CLAUDE_TOKEN }, stop.signal) // MOCK worker on node B (gateway)
  ];
  try {
    assert.deepEqual((await (await fetch(a + '/healthz')).json()), { ok: true, node: 'A', mode: 'owner' });
    assert.deepEqual((await (await fetch(b + '/healthz')).json()), { ok: true, node: 'B', mode: 'gateway' });
    // unauthenticated, wrong-role and wrong-token access is refused on BOTH nodes
    for (const base of [a, b]) {
      assert.equal((await fetch(base + '/api/rooms/poc/history')).status, 401);
      assert.equal((await call(base, '/api/rooms/poc/history', undefined, 'x'.repeat(30))).status, 401);
      assert.equal((await call(base, '/api/rooms/poc/agent/pi/claim', { worker: 'w', mode: 'mock' }, tokens.CHAT_TOKEN)).status, 401);
      assert.equal((await call(base, '/api/rooms/poc/send', { id: 'u1', agent: 'pi', prompt: 'x' }, tokens.PI_TOKEN)).status, 401);
    }
    // message via node B reaches the pi worker on node A; message via node A reaches the claude worker on node B
    assert.equal((await call(b, '/api/rooms/poc/send', { id: 'm-via-b', agent: 'pi', prompt: 'hello from B' })).status, 201);
    assert.equal((await call(a, '/api/rooms/poc/send', { id: 'm-via-a', agent: 'claude', prompt: 'hello from A' })).status, 201);
    for (const base of [a, b]) await until(async () => {
      const runs = (await call(base, '/api/rooms/poc/history')).body.runs as any[];
      return runs.length === 2 && runs.every(r => r.status === 'done');
    });
    const [ha, hb] = await Promise.all([a, b].map(async base => (await call(base, '/api/rooms/poc/history')).body));
    assert.deepEqual(ha.runs, hb.runs, 'both nodes serve identical room history');
    const byId = Object.fromEntries(ha.runs.map((r: any) => [r.id, r]));
    assert.match(byId['m-via-b'].text, /^\[MOCK pi;.*hello from B$/);
    assert.equal(byId['m-via-b'].worker_id, 'pi-on-A');
    assert.match(byId['m-via-a'].text, /^\[MOCK claude;.*hello from A$/);
    assert.equal(byId['m-via-a'].worker_id, 'claude-on-B');
    // event cursor is shared as well
    assert.deepEqual((await call(a, '/api/rooms/poc/events?after=0')).body, (await call(b, '/api/rooms/poc/events?after=0')).body);
    // gateway reports owner loss instead of hanging
    stop.abort(); await Promise.allSettled(workers);
    await owner.close();
    assert.equal((await call(b, '/api/rooms/poc/history')).status, 502);
  } finally {
    stop.abort(); await Promise.allSettled(workers); await gateway.close(); await owner.close().catch(() => {}); await rm(dir, { recursive: true, force: true });
  }
});

test('owner state survives a restart (SQLite on disk)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dac-node-'));
  let node = createNode({ tokens, dataDir: dir }); let base = await listen(node);
  assert.equal((await call(base, '/api/rooms/keep/send', { id: 'k1', agent: 'pi', prompt: 'persist me' })).status, 201);
  await node.close();
  node = createNode({ tokens, dataDir: dir }); base = await listen(node);
  try { assert.equal((await call(base, '/api/rooms/keep/history')).body.runs[0].prompt, 'persist me'); }
  finally { await node.close(); await rm(dir, { recursive: true, force: true }); }
});
