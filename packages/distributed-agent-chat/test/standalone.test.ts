import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const room = 'standalone-qa';
const secrets = { client: 'standalone-client-token-0123456789', nodeA: 'standalone-node-a-token-0123456789', nodeB: 'standalone-node-b-token-0123456789' };
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port; await new Promise<void>(r => server.close(() => r())); return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000); await closed; clearTimeout(timer);
}
test('standalone Miniflare accepts independent arbitrary target workers and enforces token scope', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'dac-standalone-'));
  const port = await freePort();
  const server = spawn(process.execPath, ['--import', 'tsx', 'scripts/server.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CHAT_HOST: '127.0.0.1', CHAT_PORT: String(port), CHAT_TOKEN: secrets.client,
      AGENT_TOKENS: JSON.stringify({ nodeA: secrets.nodeA, nodeB: secrets.nodeB }), CHAT_DATA_DIR: dir }
  });
  let output = ''; server.stdout?.on('data', b => output += b); server.stderr?.on('data', b => output += b);
  const children: ChildProcess[] = [];
  const origin = `http://127.0.0.1:${port}`;
  const request = async (path: string, token: string, body?: unknown) => fetch(`${origin}/api/rooms/${room}/${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const waitForServer = async () => {
    const end = Date.now() + 15000;
    while (Date.now() < end) {
      if (server.exitCode !== null) throw new Error(`Standalone server exited ${server.exitCode}: ${output}`);
      try { const r = await fetch(origin); if (r.status) return; } catch { /* starting */ }
      await delay(100);
    }
    throw new Error(`Standalone server did not start: ${output}`);
  };
  try {
    await waitForServer();
    const agents = await request('agents', secrets.client); assert.equal(agents.status, 200);
    assert.deepEqual((await agents.json() as any).agents.map((a: any) => a.id).sort(), ['nodeA', 'nodeB']);
    assert.equal((await request('history', secrets.nodeA)).status, 401);
    for (const target of ['nodeA', 'nodeB']) {
      const token = target === 'nodeA' ? secrets.nodeA : secrets.nodeB;
      children.push(spawn(process.execPath, ['--import', 'tsx', 'src/agent/cli.ts'], {
        cwd: process.cwd(), stdio: 'ignore',
        env: { ...process.env, CHAT_URL: origin, ROOM: room, AGENT_MODE: 'mock', AGENT_ID: target,
          WORKER_ID: `${target}-worker`, AGENT_TOKEN: token, CHAT_TOKEN: secrets.client,
          AGENT_TOKENS: JSON.stringify({ nodeA: secrets.nodeA, nodeB: secrets.nodeB }),
          AGENT_DATA_DIR: resolve(dir, target) }
      }));
    }
    // Credentials are scoped to their mapped target, even though workers are independent child processes.
    assert.equal((await request('agent/nodeA/claim', secrets.nodeB, { worker: 'intruder', mode: 'mock' })).status, 401);
    assert.equal((await request('agent/nodeB/claim', secrets.nodeA, { worker: 'intruder', mode: 'mock' })).status, 401);
    for (const target of ['nodeA', 'nodeB']) {
      assert.equal((await request('send', secrets.client, { id: `${target}-run`, agent: target, prompt: `synthetic ${target}` })).status, 201);
    }
    const waitRuns = async (predicate: (runs: any[]) => boolean) => {
      const end = Date.now() + 12000;
      while (Date.now() < end) {
        const runs = (await (await request('history', secrets.client)).json() as any).runs;
        if (predicate(runs)) return runs;
        await delay(40);
      }
      assert.fail(`Timed out waiting for worker output; server output: ${output}`);
    };
    const runs = await waitRuns(rs => rs.length === 2 && rs.every((r: any) => r.status === 'done'));
    assert.deepEqual(runs.map((r: any) => r.text).sort(), [
      '[MOCK nodeA; session ' + runs.find((r: any) => r.agent === 'nodeA').session_id + '; new] synthetic nodeA',
      '[MOCK nodeB; session ' + runs.find((r: any) => r.agent === 'nodeB').session_id + '; new] synthetic nodeB'
    ].sort());
    for (const target of ['nodeA', 'nodeB']) {
      const token = target === 'nodeA' ? secrets.nodeA : secrets.nodeB;
      const other = target === 'nodeA' ? 'nodeB' : 'nodeA';
      assert.equal((await request(`agent/${other}/claim`, token, { worker: 'intruder', mode: 'mock' })).status, 401);
    }
    const history = await request('history', secrets.client); assert.equal(history.status, 200);
    const finalRuns = (await history.json() as any).runs; assert.equal(finalRuns.length, 2);
    assert.ok(finalRuns.every((r: any) => r.text.includes('[MOCK') && r.text.includes('synthetic')));
    const events = await request('events?after=0', secrets.client); assert.equal(events.status, 200);
    const eventBody = await events.json() as any; assert.ok(eventBody.events.some((e: any) => e.kind === 'delta'));
    const cursor = eventBody.events.at(-1).cursor;
    assert.deepEqual((await (await request(`events?after=${cursor}`, secrets.client)).json() as any).events, []);
    // Follow-up task verifies session continuity through the separately running nodeA worker.
    assert.equal((await request('send', secrets.client, { id: 'nodeA-resume', agent: 'nodeA', prompt: 'resume' })).status, 201);
    const resumedRuns = await waitRuns(rs => rs.some((r: any) => r.id === 'nodeA-resume' && r.status === 'done'));
    const previousA = finalRuns.find((r: any) => r.agent === 'nodeA');
    const resumed = resumedRuns.find((r: any) => r.id === 'nodeA-resume');
    assert.equal(resumed.session_id, previousA.session_id); assert.match(resumed.text, /resumed/);
    // Cancel a long-running mock task; the child worker observes cancellation via heartbeat.
    assert.equal((await request('send', secrets.client, { id: 'nodeB-cancel', agent: 'nodeB', prompt: 'long '.repeat(300) })).status, 201);
    await waitRuns(rs => rs.some((r: any) => r.id === 'nodeB-cancel' && r.text.length > 0));
    assert.equal((await request('cancel', secrets.client, { id: 'nodeB-cancel' })).status, 200);
    const cancelledRuns = await waitRuns(rs => rs.some((r: any) => r.id === 'nodeB-cancel' && r.status === 'cancelled'));
    const cancelled = cancelledRuns.find((r: any) => r.id === 'nodeB-cancel');
    await delay(100); const after = (await (await request('history', secrets.client)).json() as any).runs.find((r: any) => r.id === 'nodeB-cancel');
    assert.equal(after.status, 'cancelled'); assert.equal(after.text, cancelled.text);
  } finally {
    await Promise.all(children.map(stop)); await stop(server); await rm(dir, { recursive: true, force: true });
  }
});
