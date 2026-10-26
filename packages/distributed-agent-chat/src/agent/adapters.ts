import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Mode, Task, Update } from '../protocol';

// Strict LF framing, not readline (U+2028/U+2029 may occur inside strings).
export class JsonLines {
  private decoder = new StringDecoder('utf8'); private buffer = '';
  constructor(private consume: (record: any) => void) {}
  push(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk);
    let i: number;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).replace(/\r$/, ''); this.buffer = this.buffer.slice(i + 1);
      if (line.length > 8 * 1024 * 1024) throw Error('Protocol record exceeds limit');
      if (line.trim()) this.consume(JSON.parse(line));
    }
    if (this.buffer.length > 8 * 1024 * 1024) throw Error('Protocol record exceeds limit');
  }
  end() { this.buffer += this.decoder.end(); if (this.buffer.trim()) throw Error('Truncated protocol record'); }
}
export function delta(mode: 'pi' | 'claude', r: any): string | undefined {
  if (mode === 'pi' && r.type === 'message_update' && r.assistantMessageEvent?.type === 'text_delta') return r.assistantMessageEvent.delta;
  if (mode === 'claude' && r.type === 'stream_event' && !r.parent_tool_use_id && r.event?.type === 'content_block_delta' && r.event.delta?.type === 'text_delta') return r.event.delta.text;
}
export interface AdapterOptions { mode: Mode; cwd: string; dataDir: string; binary?: string; extraArgs?: string[]; timeoutMs?: number; mockDelayMs?: number }
function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
}
async function write(child: ChildProcess, value: unknown) {
  await new Promise<void>((res, rej) => child.stdin!.write(JSON.stringify(value) + '\n', error => error ? rej(Error('Agent stdin write failed')) : res()));
}
export async function runAdapter(task: Task, options: AdapterOptions, emit: (u: Update) => Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (options.mode === 'mock') {
    await emit({ kind: 'session' });
    const text = `[MOCK ${task.agent}; session ${task.session_id}; ${task.resume ? 'resumed' : 'new'}] ${task.prompt}`;
    for (const part of text.match(/.{1,12}/gs) || []) {
      await new Promise<void>((res, rej) => {
        const abort = () => { clearTimeout(t); rej(Error('Cancelled')); };
        const t = setTimeout(() => { signal.removeEventListener('abort', abort); res(); }, options.mockDelayMs ?? 20);
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      });
      await emit({ kind: 'delta', text: part });
    }
    return;
  }
  const mode = options.mode;
  await mkdir(options.dataDir, { recursive: true });
  const args = mode === 'pi'
    ? ['--mode', 'rpc', '--session-id', task.session_id, '--session-dir', resolve(options.dataDir), '--no-extensions', '--no-skills', '--no-prompt-templates']
    : ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', 'dontAsk', ...(task.resume ? ['--resume', task.session_id] : ['--session-id', task.session_id])];
  const child = spawn(options.binary || mode, [...args, ...(options.extraArgs || [])], {
    cwd: options.cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    // Chat authentication is never inherited by agent tools or provider subprocesses.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !['CHAT_TOKEN','PI_TOKEN','CLAUDE_TOKEN','AGENT_TOKEN','MINIO_ROOT_PASSWORD','AWS_SECRET_ACCESS_KEY'].includes(k)))
  });
  // Never forward raw stderr/protocol errors: providers can echo credentials/prompts.
  child.stderr!.resume(); child.stdin!.on('error', () => {});
  let chain = Promise.resolve(), failure: Error | undefined, finished = false, piError = false, streamed = false;
  let resolveDone!: () => void, rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });
  void done.catch(() => {}); // rejection may precede the spawn/write handshake
  const fail = (e: Error) => { failure ||= e; rejectDone(e); stop(child, 'SIGTERM'); };
  const send = (u: Update) => { chain = chain.then(() => emit(u)); chain.catch(() => fail(Error('Unable to persist output'))); };
  const parser = new JsonLines(r => {
    const d = delta(mode, r); if (d !== undefined) { streamed = true; send({ kind: 'delta', text: d }); }
    if (mode === 'pi') {
      if (r.type === 'response' && r.success === false) return fail(Error('Pi command rejected'));
      if (r.type === 'response' && r.id === 'state') {
        send({ kind: 'session' });
        chain = chain.then(() => write(child, { id: 'prompt', type: 'prompt', message: task.prompt }));
        chain.catch(() => fail(Error('Pi prompt write failed')));
      }
      if (r.type === 'message_end' && r.message?.role === 'assistant') piError = ['error','aborted'].includes(r.message.stopReason);
      if (r.type === 'extension_ui_request' && ['select','confirm','input','editor'].includes(r.method)) {
        chain = chain.then(() => write(child, { type: 'extension_ui_response', id: r.id, cancelled: true }));
        chain.catch(() => fail(Error('Pi UI response failed')));
      }
      if (r.type === 'agent_settled') { finished = true; if (piError) fail(Error('Pi provider failed or aborted')); else resolveDone(); }
    } else {
      if (r.type === 'system' && r.subtype === 'init') send({ kind: 'session' });
      if (r.type === 'result') {
        finished = true;
        if (r.is_error || r.subtype !== 'success') return fail(Error('Claude run failed'));
        if (!streamed && typeof r.result === 'string' && r.result) send({ kind: 'delta', text: r.result });
        resolveDone();
      }
    }
  });
  child.stdout!.on('data', chunk => { try { parser.push(chunk); } catch { fail(Error('Invalid agent JSONL')); } });
  child.stdout!.on('end', () => { try { parser.end(); } catch { fail(Error('Truncated agent JSONL')); } });
  child.on('error', () => fail(Error('Agent process could not start')));
  const exited = new Promise<void>(res => child.once('close', () => { if (!finished) fail(Error('Agent exited before completion')); res(); }));
  const abort = () => fail(Error('Cancelled'));
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const timer = setTimeout(() => fail(Error('Agent execution deadline exceeded')), options.timeoutMs ?? 600000);
  try {
    await new Promise<void>((res, rej) => { child.once('spawn', res); child.once('error', () => rej(Error('Agent process could not start'))); });
    if (mode === 'pi') await write(child, { id: 'state', type: 'get_state' });
    else child.stdin!.end(task.prompt);
    await done; await chain; if (failure) throw failure;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    child.stdin!.end(); stop(child, 'SIGTERM');
    const kill = setTimeout(() => stop(child, 'SIGKILL'), 1500);
    await exited; clearTimeout(kill);
  }
}
