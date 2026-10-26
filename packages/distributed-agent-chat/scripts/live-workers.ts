// Persistent, explicit opt-in chat workers. Provider credentials stay on this host.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { agentWorker } from '../src/agent/worker';
import type { Agent } from '../src/protocol';

if (process.env.CONFIRM_LIVE_WORKERS !== 'YES') throw Error('Set CONFIRM_LIVE_WORKERS=YES to serve real Pi and Claude sessions');
const room = process.env.ROOM || 'demo';
if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) throw Error('Invalid ROOM');
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
const tasks = (['pi', 'claude'] as Agent[]).map(async agent => {
  const cwd = resolve('.agent-data/live', agent, 'workspace');
  await mkdir(cwd, { recursive: true });
  const token = process.env[agent === 'pi' ? 'PI_TOKEN' : 'CLAUDE_TOKEN'];
  if (!token) throw Error(`Missing ${agent} token`);
  const extraArgs = agent === 'pi' ? ['--provider', process.env.PI_PROVIDER || 'openai-codex', '--model', process.env.PI_MODEL || 'gpt-6.1-sol', '--no-tools', '--no-context-files'] : ['--tools', ''];
  console.log(`Real ${agent} chat worker ready for room ${room}; coding tools disabled.`);
  await agentWorker({ mode: agent, agent, worker: `${agent}-host-live`, room, token, cwd, dataDir: resolve('.agent-data/live', agent, 'sessions'), url: agent === 'pi' ? (process.env.FLEET_URL_A || 'http://127.0.0.1:18877') : (process.env.FLEET_URL_B || 'http://127.0.0.1:18878'), extraArgs }, shutdown.signal);
});
try { await Promise.all(tasks); }
catch { console.error('Live chat worker stopped; check fleet availability, token configuration and room identity.'); shutdown.abort(); await Promise.allSettled(tasks); process.exitCode = 1; }
