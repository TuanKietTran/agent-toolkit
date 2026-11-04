import { setTimeout as delay } from 'node:timers/promises';
import type { Agent, Mode, Task, Update } from '../protocol';
import { runAdapter, type AdapterOptions } from './adapters';

export interface WorkerOptions extends AdapterOptions {
  url: string; room: string; agent: Agent; worker: string; token: string;
  pollMs?: number; heartbeatMs?: number;
}
export async function agentWorker(options: WorkerOptions, shutdown: AbortSignal) {
  const base = `${options.url.replace(/\/$/, '')}/api/rooms/${options.room}/agent/${options.agent}/`;
  async function post(op: string, data: Record<string, unknown>, retry = false): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(base + op, { method: 'POST', headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ worker: options.worker, ...data }), signal: AbortSignal.timeout(4000), redirect: 'error' });
        if (r.status >= 500) throw Error('Server unavailable');
        if (!r.ok) { const e = new Error(`Agent API rejected ${op} (${r.status})`); Object.assign(e, { permanent: true }); throw e; }
        return await r.json();
      } catch (e) {
        if (!retry || attempt >= 2 || (e as any).permanent) throw e;
        await delay(100 * 2 ** attempt);
      }
    }
  }
  while (!shutdown.aborted) {
    let task: Task | undefined;
    try { task = (await post('claim', { mode: options.mode })).task; }
    catch (e) {
      if ((e as any).permanent) throw e;
      if (!shutdown.aborted) await delay(options.pollMs ?? 1000); continue;
    }
    if (!task) { await delay(options.pollMs ?? 700); continue; }
    const controller = new AbortController();
    const abort = () => controller.abort(); shutdown.addEventListener('abort', abort, { once: true });
    if (shutdown.aborted) abort();
    let seq = task.seq, heartStopped = false;
    const heartbeatTimer = new AbortController();
    const heartbeat = (async () => {
      while (!heartStopped && !controller.signal.aborted) {
        try { await delay(options.heartbeatMs ?? 2000, undefined, { signal: heartbeatTimer.signal }); }
        catch (e) { if (heartStopped) return; throw e; }
        if (heartStopped) return;
        try { if ((await post('heartbeat', { id: task!.id })).cancel) controller.abort(); }
        catch { controller.abort(); } // stop executing on loss of lease connectivity
      }
    })();
    const emit = async (update: Update) => {
      if (update.kind !== 'delta') {
        controller.signal.throwIfAborted();
        const next = seq + 1;
        await post('update', { id: task!.id, seq: next, update }, true);
        seq = next;
        return;
      }
      // 2,000 code points bounds worst-case JSON control escaping to ~12 KB.
      let chunk = '', points = 0;
      for (const point of update.text) {
        controller.signal.throwIfAborted();
        chunk += point;
        if (++points === 2000) {
          const next = seq + 1;
          await post('update', { id: task!.id, seq: next, update: { kind: 'delta', text: chunk } }, true);
          seq = next; chunk = ''; points = 0;
        }
      }
      if (points) {
        controller.signal.throwIfAborted();
        const next = seq + 1;
        await post('update', { id: task!.id, seq: next, update: { kind: 'delta', text: chunk } }, true);
        seq = next;
      }
    };
    try {
      await runAdapter(task, options, emit, controller.signal);
      await emit({ kind: 'done' });
    } catch (e) {
      // No raw subprocess output, env values, prompts or token are logged.
      const error = controller.signal.aborted ? 'Worker interrupted or cancellation requested' :
        e instanceof Error && /^(Pi |Claude |Agent |Invalid agent|Truncated agent|Unable to persist)/.test(e.message) ? e.message : 'Agent execution failed';
      try { await post('update', { id: task.id, seq: seq + 1, update: { kind: 'error', error } }, true); } catch { /* terminal or lease expiry will record failure */ }
    } finally {
      heartStopped = true; heartbeatTimer.abort(); await heartbeat; shutdown.removeEventListener('abort', abort);
    }
  }
}
export function validateAgentBinary(mode: Mode, binary: string | undefined, platform = process.platform): string | undefined {
  if (mode === 'mock' || platform !== 'win32') return binary;
  if (!binary) throw Error('AGENT_BINARY must be an absolute native .exe path on Windows');
  if (/\.(?:cmd|ps1)$/i.test(binary)) throw Error('AGENT_BINARY must be a native .exe, not a .cmd or .ps1 shim');
  if (!/^[A-Za-z]:\\/.test(binary) && !/^\\\\/.test(binary)) throw Error('AGENT_BINARY must be an absolute native .exe path on Windows');
  if (!/\.exe$/i.test(binary)) throw Error('AGENT_BINARY must be an absolute native .exe path on Windows');
  return binary;
}
export function parseMode(value: string | undefined): Mode {
  if (value === 'pi' || value === 'claude' || value === 'codex' || value === 'opencode' || value === 'mock') return value;
  throw Error('AGENT_MODE must explicitly be pi, claude, codex, opencode or mock');
}

export function validateExtraArgs(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some(a => typeof a !== 'string')) throw Error('AGENT_ARGS must be a JSON string array (never put credentials here)');
  if (value.some(a => a.startsWith('-'))) throw Error('AGENT_ARGS cannot contain CLI flags; protocol, session, output, permission and native features are managed');
}
const piTools = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
export function nativeFeatures(env: NodeJS.ProcessEnv): string[] {
  const supported = new Set(['extensions', 'skills', 'prompt-templates']);
  const requested = env.AGENT_NATIVE_FEATURES === undefined ? [] : env.AGENT_NATIVE_FEATURES.split(',').map(x => x.trim());
  if (requested.some(x => !supported.has(x)) || new Set(requested).size !== requested.length) throw Error('AGENT_NATIVE_FEATURES must be a unique list of extensions,skills,prompt-templates');
  const trusted = env.AGENT_PI_TRUSTED_NATIVE === '1';
  if (!trusted && (requested.length || env.AGENT_PI_TRUSTED_NATIVE !== undefined && env.AGENT_PI_TRUSTED_NATIVE !== '0')) throw Error('Native features require AGENT_PI_TRUSTED_NATIVE=1');
  return trusted ? requested.length ? requested : [...supported] : [];
}
/** Build native Pi CLI options; never accept session/protocol overrides through AGENT_ARGS. */
export function piConfig(env: NodeJS.ProcessEnv): string[] {
  const args: string[] = [];
  for (const [key, legacy] of [['AGENT_PROVIDER', 'AGENT_PI_PROVIDER'], ['AGENT_MODEL', 'AGENT_PI_MODEL']] as const) {
    if (env[key] !== undefined && env[legacy] !== undefined && env[key] !== env[legacy]) throw Error(`${key} conflicts with ${legacy}`);
    const value = env[key] ?? env[legacy];
    if (value !== undefined && (!value.trim() || value.length > 200 || /[\0\r\n]/.test(value))) throw Error(`${key} is invalid`);
  }
  nativeFeatures(env); // Validate explicit trusted opt-in; adapter emits fail-closed flags.
  const tools = env.AGENT_PI_TOOLS;
  if (tools !== undefined) {
    const names = tools.split(',').map(x => x.trim());
    if (!names.length || names.some(x => !piTools.has(x)) || new Set(names).size !== names.length) throw Error('AGENT_PI_TOOLS must be a comma-separated list of supported Pi tools');
    args.push('--tools', names.join(','));
  } else if (env.AGENT_PI_NO_TOOLS === '1') args.push('--no-tools');
  else if (env.AGENT_PI_NO_TOOLS !== undefined && env.AGENT_PI_NO_TOOLS !== '0') throw Error('AGENT_PI_NO_TOOLS must be 1 or 0');
  return args;
}
