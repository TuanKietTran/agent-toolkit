import { resolve } from 'node:path';
import { agentWorker, parseMode } from './worker';
import { validId } from '../protocol';

async function main() {
  const mode = parseMode(process.env.AGENT_MODE), agent = process.env.AGENT_ID;
  const room = process.env.ROOM || 'demo', worker = process.env.WORKER_ID;
  if ((agent !== 'pi' && agent !== 'claude') || !validId(room) || !validId(worker) || (mode !== 'mock' && mode !== agent)) throw Error('Set AGENT_ID=pi|claude, ROOM, stable WORKER_ID and matching AGENT_MODE');
  const token = process.env.AGENT_TOKEN;
  if (!token) throw Error('AGENT_TOKEN required');
  const url = new URL(process.env.CHAT_URL || 'http://127.0.0.1:18877');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:','https:'].includes(url.protocol)) throw Error('CHAT_URL must be an HTTP origin without credentials, path or query');
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Remote CHAT_URL requires HTTPS');
  const extraArgs: unknown = JSON.parse(process.env.AGENT_ARGS || '[]');
  if (!Array.isArray(extraArgs) || extraArgs.some(a => typeof a !== 'string')) throw Error('AGENT_ARGS must be a JSON string array (never put credentials here)');
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
  console.log(`Agent worker ${agent} mode=${mode === 'mock' ? 'MOCK (no LLM)' : mode}`);
  await agentWorker({ mode, agent, room, worker, url: url.origin, token,
    cwd: resolve(process.env.AGENT_CWD || '.'), dataDir: resolve(process.env.AGENT_DATA_DIR || `.agent-data/${worker}/${room}`),
    binary: process.env.AGENT_BINARY, extraArgs }, stop.signal);
}
main().catch(() => { console.error('Agent worker configuration or startup failed; verify environment (secrets are not logged).'); process.exitCode = 1; });
