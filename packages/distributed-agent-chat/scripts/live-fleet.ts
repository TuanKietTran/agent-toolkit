// Opt-in end-to-end test against two already deployed celld nodes, using REAL agents.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { agentWorker } from '../src/agent/worker';
import type { Mode, Run } from '../src/protocol';

if (process.env.CONFIRM_LIVE_FLEET !== 'YES') throw Error('Set CONFIRM_LIVE_FLEET=YES to invoke real providers on the deployed fleet');
const a = process.env.FLEET_URL_A || 'http://127.0.0.1:18877';
const b = process.env.FLEET_URL_B || 'http://127.0.0.1:18878';
const room = `live_${randomUUID().replaceAll('-', '')}`;
const cwd = await mkdtemp(join(tmpdir(), 'session-chat-fleet-'));
const required = (key: string) => { const value = process.env[key]; if (!value) throw Error(`Missing ${key}`); return value; };
const token = required('CHAT_TOKEN');
async function api(url: string, op: string, data?: unknown) {
  const response = await fetch(`${url}/api/rooms/${room}/${op}`, { method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw Error(`Fleet API ${op} failed (${response.status})`);
  return response.json() as Promise<any>;
}
const shutdown = new AbortController();
const jobs: Promise<void>[] = [];
let workerFailure: unknown;
try {
  for (const agent of ['pi', 'claude'] as const satisfies readonly Mode[]) {
    const extraArgs = agent === 'pi' ? ['--provider', process.env.PI_PROVIDER || 'openai-codex', '--model', process.env.PI_MODEL || 'gpt-6.1-sol', '--no-tools', '--no-context-files'] : ['--tools', ''];
    jobs.push(agentWorker({ mode: agent, agent, worker: `${agent}-live`, room, url: agent === 'pi' ? a : b, token: required(agent === 'pi' ? 'PI_TOKEN' : 'CLAUDE_TOKEN'), cwd, dataDir: join(cwd, 'pi-sessions'), extraArgs, timeoutMs: 120000 }, shutdown.signal).catch(error => { workerFailure = error; shutdown.abort(); }));
  }
  for (const agent of ['pi', 'claude'] as const satisfies readonly Mode[]) {
    const marker = `recall_${randomUUID().replaceAll('-', '')}`;
    let session = '';
    for (const resume of [false, true]) {
      const id = randomUUID();
      const prompt = resume ? 'Reply with only the exact recall marker from my previous message. Do not use tools.' : `Remember the exact recall marker ${marker} for my next message. Reply with only that marker. Do not use tools.`;
      await api(a, 'send', { id, agent, prompt });
      let run: Run | undefined;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        if (workerFailure) throw workerFailure;
        run = (await api(b, 'history')).runs.find((value: Run) => value.id === id);
        if (run && ['done', 'error', 'cancelled'].includes(run.status)) break;
        await delay(500);
      }
      assert.equal(run?.status, 'done', `${agent}: run did not complete successfully`);
      assert.equal(run!.mode, agent);
      assert.ok(run!.text.includes(marker), `${agent}: recall failed`);
      if (resume) assert.equal(run!.session_id, session); else session = run!.session_id;
      assert.deepEqual(await api(a, 'history'), await api(b, 'history'), 'Nodes returned different durable room history');
      const events = (await api(b, 'events?after=0')).events;
      assert.ok(events.some((event: any) => event.run_id === id && event.kind === 'delta'), 'Missing incremental output');
      console.log(`${agent}: ${resume ? 'resumed recall' : 'new session'} across both celld nodes PASS`);
    }
  }
  assert.equal((await api(a, 'history')).runs.length, 4, 'Unexpected autonomous turns');
  console.log(`Live two-node celld + Pi + Claude PASS; room ${room}`);
} finally { shutdown.abort(); await Promise.all(jobs); }
