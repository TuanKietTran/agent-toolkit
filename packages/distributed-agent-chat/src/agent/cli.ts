import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentWorker, nativeFeatures, parseMode, piConfig, validateAgentBinary, validateExtraArgs } from './worker';
import { validId } from '../protocol';

async function main() {
  const mode = parseMode(process.env.AGENT_MODE), agent = process.env.AGENT_ID;
  const room = process.env.ROOM || 'demo', worker = process.env.WORKER_ID;
  if (!validId(agent) || !validId(room) || !validId(worker)) throw Error('Set a valid AGENT_ID, ROOM and stable WORKER_ID; AGENT_MODE selects the runtime independently');
  const token = process.env.AGENT_TOKEN;
  if (!token) throw Error('AGENT_TOKEN required');
  const url = new URL(process.env.CHAT_URL || 'http://127.0.0.1:18877');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['http:','https:'].includes(url.protocol)) throw Error('CHAT_URL must be an HTTP origin without credentials, path or query');
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw Error('Remote CHAT_URL requires HTTPS');
  const extraArgs: unknown = JSON.parse(process.env.AGENT_ARGS || '[]');
  validateExtraArgs(extraArgs);
  for (const key of ['AGENT_MODEL', 'AGENT_PROVIDER'] as const) {
    const legacy = key === 'AGENT_MODEL' ? process.env.AGENT_PI_MODEL : process.env.AGENT_PI_PROVIDER;
    if (process.env[key] !== undefined && legacy !== undefined && process.env[key] !== legacy) throw Error(`${key} conflicts with legacy Pi setting`);
    if (process.env[key] === undefined && legacy !== undefined) process.env[key] = legacy;
    const value = process.env[key];
    if (value !== undefined && (!value.trim() || value.length > 200 || /[\0\r\n]/.test(value))) throw Error(`${key} is invalid`);
  }
  const piArgs = piConfig(process.env); // Validate Pi-specific options and trusted-native setting on every invocation.
  const configuredArgs = mode === 'pi' ? [...piArgs, ...(extraArgs as string[])] : extraArgs as string[];
  const configuredBinary = validateAgentBinary(mode, process.env.AGENT_BINARY, process.platform);
  if (process.env.AGENT_DOCTOR === '1') {
    const binary = configuredBinary || mode;
    const check = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
    if (check.error || check.status !== 0) throw Error('Doctor check failed: configured agent executable unavailable');
    console.log(`Agent configuration OK (${agent}; executable available; no provider request made).`);
    return;
  }
  if (process.env.AGENT_DOCTOR !== undefined) throw Error('AGENT_DOCTOR must be 1 when enabled');
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort()); process.once('SIGTERM', () => stop.abort());
  console.log(`Agent worker ${agent} mode=${mode === 'mock' ? 'MOCK (no LLM)' : mode}`);
  await agentWorker({ mode, agent, room, worker, url: url.origin, token,
    cwd: resolve(process.env.AGENT_CWD || '.'), dataDir: resolve(process.env.AGENT_DATA_DIR || `.agent-data/${worker}/${room}`),
    binary: configuredBinary, extraArgs: configuredArgs,
    model: process.env.AGENT_MODEL, provider: process.env.AGENT_PROVIDER,
    trustedPiNative: process.env.AGENT_PI_TRUSTED_NATIVE === '1', nativeFeatures: nativeFeatures(process.env),
    providerEndpointConfigured: Boolean(process.env.ANTHROPIC_BASE_URL) }, stop.signal);
}
main().catch(() => { console.error('Agent worker configuration or startup failed; verify environment (secrets are not logged).'); process.exitCode = 1; });
