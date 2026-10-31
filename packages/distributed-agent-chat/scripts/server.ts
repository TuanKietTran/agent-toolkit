import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { agentTokens, validateSecrets, type TokenEnv } from '../src/auth';

// Persistent single-coordinator local server. For remote access, put this behind TLS or SSH; never bind public cleartext.
const host = process.env.CHAT_HOST || '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host) && process.env.CHAT_ALLOW_INSECURE_BIND !== 'YES') {
  throw new Error('Non-loopback CHAT_HOST requires CHAT_ALLOW_INSECURE_BIND=YES and a trusted TLS proxy');
}
const port = Number(process.env.CHAT_PORT || '18877');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CHAT_PORT must be a valid TCP port');
validateSecrets(process.env as TokenEnv);
const configured = agentTokens(process.env as TokenEnv);
if (!process.env.CHAT_TOKEN || !Object.keys(configured).length) throw new Error('Configure CHAT_TOKEN and at least one agent token');
const dataDir = resolve(process.env.CHAT_DATA_DIR || '.data/miniflare');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const bindings: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if ((key === 'CHAT_TOKEN' || key === 'AGENT_TOKENS' || key.endsWith('_TOKEN')) && typeof value === 'string' && value) {
    bindings[key] = value;
  }
}
const mf = new Miniflare({
  name: 'distributed-agent-chat', scriptPath: resolve('dist/worker.js'), modules: true,
  compatibilityDate: '2025-10-11', host, port,
  durableObjects: { ROOMS: { className: 'Room', useSQLite: true } },
  durableObjectsPersist: dataDir,
  bindings,
});
let closing = false;
async function close() { if (closing) return; closing = true; await mf.dispose(); }
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
try {
  await mf.ready;
  console.log(`Miniflare coordinator listening on ${host}:${port}; data: ${dataDir}`);
} catch (error) { await close(); throw error; }
