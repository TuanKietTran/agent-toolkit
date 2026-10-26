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
    const heartbeat = (async () => {
      while (!heartStopped && !controller.signal.aborted) {
        await delay(options.heartbeatMs ?? 2000);
        if (heartStopped) return;
        try { if ((await post('heartbeat', { id: task!.id })).cancel) controller.abort(); }
        catch { controller.abort(); } // stop executing on loss of lease connectivity
      }
    })();
    const emit = async (update: Update) => {
      controller.signal.throwIfAborted();
      const next = seq + 1;
      await post('update', { id: task!.id, seq: next, update }, true);
      seq = next;
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
      heartStopped = true; await heartbeat; shutdown.removeEventListener('abort', abort);
    }
  }
}
export function parseMode(value: string | undefined): Mode {
  if (value === 'pi' || value === 'claude' || value === 'mock') return value;
  throw Error('AGENT_MODE must explicitly be pi, claude or mock');
}
