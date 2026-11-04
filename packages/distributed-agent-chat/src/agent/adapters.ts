import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
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
export function delta(mode: 'pi' | 'claude' | 'codex' | 'opencode', r: any): string | undefined {
  if (mode === 'pi' && r.type === 'message_update' && r.assistantMessageEvent?.type === 'text_delta') return r.assistantMessageEvent.delta;
  if (mode === 'claude' && r.type === 'stream_event' && !r.parent_tool_use_id && r.event?.type === 'content_block_delta' && r.event.delta?.type === 'text_delta') return r.event.delta.text;
  if (mode === 'codex' && r.type === 'item.completed' && r.item?.type === 'agent_message' && typeof r.item.text === 'string') return r.item.text;
  if (mode === 'opencode' && r.type === 'text' && typeof r.part?.text === 'string') return r.part.text;
}
export interface AdapterOptions { mode: Mode; cwd: string; dataDir: string; binary?: string; extraArgs?: string[]; timeoutMs?: number; mockDelayMs?: number; model?: string; provider?: string; trustedPiNative?: boolean; nativeFeatures?: string[]; providerEndpointConfigured?: boolean }
export function managedArgs(mode: Exclude<Mode, 'mock'>, task: Task, options: Pick<AdapterOptions, 'dataDir' | 'model' | 'provider' | 'trustedPiNative' | 'nativeFeatures' | 'providerEndpointConfigured'>): string[] {
  const provider = options.provider, model = options.model;
  if (mode === 'pi') {
    const enabled = new Set(options.trustedPiNative ? options.nativeFeatures ?? ['extensions','skills','prompt-templates'] : []);
    const stable = createHash('sha256').update(`${task.agent}:${task.session_id}`).digest('hex');
    const session = resolve(options.dataDir, task.agent, `${stable}.jsonl`);
    return ['--mode', 'rpc', '--session', session, '--session-dir', resolve(options.dataDir, task.agent, stable), ...(!enabled.has('extensions') ? ['--no-extensions'] : []), ...(!enabled.has('skills') ? ['--no-skills'] : []), ...(!enabled.has('prompt-templates') ? ['--no-prompt-templates'] : []), ...(provider ? ['--provider', provider] : []), ...(model ? ['--model', model] : [])];
  }
  if (mode === 'claude') {
    if (provider && (provider !== 'ollama' || !options.providerEndpointConfigured)) throw Error('Claude AGENT_PROVIDER=ollama requires worker-side ANTHROPIC_BASE_URL');
    return ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--permission-mode', 'dontAsk', ...(model ? ['--model', model] : []), ...(task.resume ? ['--resume', task.provider_session_id || task.session_id] : ['--session-id', task.provider_session_id || task.session_id])];
  }
  if (mode === 'codex') return ['exec', ...(task.resume && task.provider_session_id ? ['resume', task.provider_session_id] : []), '--json', '--skip-git-repo-check', ...(provider?.toLowerCase() === 'ollama' ? ['--oss', '--local-provider', 'ollama'] : provider ? ['-c', `model_provider=${JSON.stringify(provider)}`] : []), ...(model ? ['--model', model] : []), '-'];
  return ['run', '--format', 'json', ...(task.resume && task.provider_session_id ? ['--session', task.provider_session_id] : []), ...(model ? ['--model', provider ? `${provider}/${model}` : model] : provider ? ['--model', `${provider}/default`] : []), '-'];
}
function stop(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // taskkill is invoked directly (never through a shell) and /T includes descendants.
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
    killer.on('error', () => { try { child.kill(signal); } catch { /* already exited */ } });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { /* already exited */ }
}
function childEnvironment(mode: Mode, provider?: string): NodeJS.ProcessEnv {
  // Provider API-key environment variables are passed only for an explicitly selected provider.
  const selectedProvider = provider?.toLowerCase();
  const providerCredentials: Record<string, RegExp> = {
    anthropic: /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/i,
    openai: /^(OPENAI_API_KEY|OPENAI_ORG_ID|OPENAI_PROJECT_ID)$/i,
    google: /^(GEMINI_API_KEY|GOOGLE_API_KEY)$/i,
  };
  const selected = selectedProvider ? providerCredentials[selectedProvider] : undefined;
  const secret = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE.?KEY|API.?KEY)/i;
  const infrastructure = /^(CHAT_|AGENT_|WORKER_|MINIO_|AWS_|S3_|R2_|CELLD_|CLOUDFLARE_|WRANGLER_|DATABASE_|DB_)/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => {
    const k = key.toUpperCase();
    if (mode === 'claude' && provider?.toLowerCase() === 'ollama' && k === 'ANTHROPIC_AUTH_TOKEN' && value === 'ollama') return true;
    if (selected?.test(k)) return true;
    return !secret.test(k) && !infrastructure.test(k);
  })) as NodeJS.ProcessEnv;
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
  if (!['pi', 'claude', 'codex', 'opencode'].includes(mode)) throw Error('Unsupported agent adapter mode');
  await mkdir(options.dataDir, { recursive: true });
  const args = managedArgs(mode as Exclude<Mode, 'mock'>, task, options);
  if (mode === 'pi') await mkdir(args[args.indexOf('--session-dir') + 1], { recursive: true });
  const env = childEnvironment(mode, options.provider);
  // Node-based test fixtures need the script path before CLI arguments.
  const launchArgs = options.binary === process.execPath && options.extraArgs?.length
    ? [...options.extraArgs, ...args]
    : [...args, ...(options.extraArgs || [])];
  const child = spawn(options.binary || mode, launchArgs, {
    cwd: options.cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], shell: false, env
  });
  // Never forward raw stderr/protocol errors: providers can echo credentials/prompts.
  child.stderr!.resume(); child.stdin!.on('error', () => {});
  let chain = Promise.resolve(), failure: Error | undefined, finished = false, piError = false, streamed = false;
  let resolveFailure!: () => void;
  const failed = new Promise<void>(resolve => { resolveFailure = resolve; });
  let resolveDone!: () => void, rejectDone!: (e: Error) => void;
  const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });
  void done.catch(() => {}); // rejection may precede the spawn/write handshake
  const fail = (e: Error) => { if (!failure) { failure = e; resolveFailure(); } rejectDone(e); stop(child, 'SIGTERM'); };
  const send = (u: Update) => { chain = chain.then(() => emit(u)); chain.catch(() => fail(Error('Unable to persist output'))); };
  const activity = (type: 'tool' | 'usage', value: any) => {
    if (type === 'tool') {
      const name = typeof value.name === 'string' ? value.name : '';
      if (/^[A-Za-z0-9_.:-]{1,128}$/.test(name) && ['started','completed','error'].includes(value.status)) send({ kind: 'activity', activity: { type, name, status: value.status } });
    } else {
      const usage = Object.fromEntries(['input','output','cached','cost'].filter(k => typeof value[k] === 'number' && Number.isFinite(value[k]) && value[k] >= 0).map(k => [k, value[k]]));
      if (Object.keys(usage).length) send({ kind: 'activity', activity: { type, usage } });
    }
  };
  const completedItems = new Set<string>();
  const claudeTools = new Map<string, string>();
  const parser = new JsonLines(r => {
    const itemId = typeof r.item?.id === 'string' ? r.item.id : typeof r.item_id === 'string' ? r.item_id : undefined;
    const duplicateCompletion = mode === 'codex' && r.type === 'item.completed' && itemId !== undefined && completedItems.has(itemId);
    if (mode === 'codex' && r.type === 'item.completed' && itemId !== undefined) completedItems.add(itemId);
    const d = duplicateCompletion ? undefined : delta(mode as 'pi' | 'claude' | 'codex' | 'opencode', r); if (d !== undefined) { streamed = true; send({ kind: 'delta', text: d }); }
    if (mode === 'pi') {
      if (r.type === 'tool_execution_start') activity('tool', { name: r.name, status: 'started' });
      if (r.type === 'tool_execution_end') activity('tool', { name: r.name, status: r.isError ? 'error' : 'completed' });
      if (r.type === 'message_end' && r.message?.usage) activity('usage', { input: r.message.usage.input, output: r.message.usage.output, cached: r.message.usage.cacheRead, cost: r.message.usage.cost?.total });
      if (r.type === 'response' && r.success === false) return fail(Error('Pi command rejected'));
      if (r.type === 'response' && r.id === 'state') {
        send({ kind: 'session', ...(typeof r.data?.sessionId === 'string' ? { providerSessionId: r.data.sessionId } : {}) });
        chain = chain.then(() => write(child, { id: 'prompt', type: 'prompt', message: task.prompt }));
        chain.catch(() => fail(Error('Pi prompt write failed')));
      }
      if (r.type === 'message_end' && r.message?.role === 'assistant') piError = ['error','aborted'].includes(r.message.stopReason);
      if (r.type === 'extension_ui_request' && ['select','confirm','input','editor'].includes(r.method)) {
        chain = chain.then(() => write(child, { type: 'extension_ui_response', id: r.id, cancelled: true }));
        chain.catch(() => fail(Error('Pi UI response failed')));
      }
      if (r.type === 'agent_settled') { finished = true; if (piError) fail(Error('Pi provider failed or aborted')); else resolveDone(); }
    } else if (mode === 'claude') {
      if (r.type === 'stream_event' && r.event?.type === 'content_block_start' && r.event.content_block?.type === 'tool_use') {
        const tool = r.event.content_block;
        if (typeof tool.id === 'string' && typeof tool.name === 'string') claudeTools.set(tool.id, tool.name);
        activity('tool', { name: tool.name, status: 'started' });
      }
      if (r.type === 'user' && Array.isArray(r.message?.content)) for (const block of r.message.content) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') activity('tool', { name: claudeTools.get(block.tool_use_id), status: block.is_error ? 'error' : 'completed' });
      }
      if (r.type === 'result' && r.usage) activity('usage', { input: r.usage.input_tokens, output: r.usage.output_tokens, cached: r.usage.cache_read_input_tokens, cost: r.total_cost_usd });
      if (r.type === 'system' && r.subtype === 'init') send({ kind: 'session', ...(typeof r.session_id === 'string' ? { providerSessionId: r.session_id } : {}) });
      if (r.type === 'result') {
        finished = true;
        if (r.is_error || r.subtype !== 'success') return fail(Error('Claude run failed'));
        if (!streamed && typeof r.result === 'string' && r.result) send({ kind: 'delta', text: r.result });
        resolveDone();
      }
    } else if (mode === 'codex') {
      if ((r.type === 'item.started' || r.type === 'item.completed') && r.item?.type !== 'agent_message') activity('tool', { name: r.item?.name || r.item?.type, status: r.type === 'item.started' ? 'started' : 'completed' });
      if (r.type === 'turn.completed' && r.usage) activity('usage', { input: r.usage.input_tokens, output: r.usage.output_tokens, cached: r.usage.cached_input_tokens, cost: r.usage.cost });
      if (r.type === 'thread.started' && typeof r.thread_id === 'string') send({ kind: 'session', providerSessionId: r.thread_id });
      if (r.type === 'turn.completed') { finished = true; resolveDone(); }
      if (r.type === 'turn.failed') { finished = true; fail(Error('Codex run failed')); }
    } else {
      if (r.type === 'tool' && r.part?.state?.status) activity('tool', { name: r.part.tool, status: r.part.state.status === 'running' ? 'started' : r.part.state.status === 'error' ? 'error' : 'completed' });
      if (r.type === 'step_finish' && r.part?.tokens) activity('usage', { input: r.part.tokens.input, output: r.part.tokens.output, cached: r.part.tokens.cache?.read });
      if (typeof r.sessionID === 'string' && (r.type === 'session.created' || r.type === 'text' || r.type === 'step_start' || r.type === 'step_finish')) send({ kind: 'session', providerSessionId: r.sessionID });
      if (r.type === 'session.error' || r.type === 'step_error' || r.type === 'error') { finished = true; fail(Error('OpenCode run failed')); }
      if (r.type === 'session.status' && r.status?.type === 'idle') { finished = true; resolveDone(); }
    }
  });
  child.stdout!.on('data', chunk => { try { parser.push(chunk); } catch { fail(Error('Invalid agent JSONL')); } });
  child.stdout!.on('end', () => {
    try { parser.end(); } catch { fail(Error('Truncated agent JSONL')); return; }
    stdoutEnded = true;
    if (mode === 'codex' && !finished) fail(Error('Codex stdout ended before completion'));
    if (mode === 'opencode' && !finished && didClose) fail(exitCode !== 0 ? Error('OpenCode exited unsuccessfully') : Error('OpenCode stdout ended before session completion'));
    if (mode === 'opencode' && !finished && !didClose) setTimeout(() => {
      if (!finished && !didClose) fail(Error('OpenCode stdout ended before session completion'));
    }, 25).unref();
  });
  child.on('error', () => fail(Error('Agent process could not start')));
  let exitCode: number | null = null;
  let didClose = false, stdoutEnded = false;
  const exited = new Promise<void>(res => child.once('close', code => {
    exitCode = code; didClose = true;
    if (!finished && mode === 'opencode' && stdoutEnded) fail(code !== 0 ? Error('OpenCode exited unsuccessfully') : Error('OpenCode stdout ended before session completion'));
    else if (!finished && !(mode === 'opencode' && code !== 0)) fail(Error('Agent exited before completion'));
    if (mode === 'opencode' && code !== 0 && !failure) fail(Error('OpenCode exited unsuccessfully'));
    res();
  }));
  const abort = () => fail(Error('Cancelled'));
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const timer = setTimeout(() => fail(Error('Agent execution deadline exceeded')), options.timeoutMs ?? 600000);
  try {
    await new Promise<void>((res, rej) => { child.once('spawn', res); child.once('error', () => rej(Error('Agent process could not start'))); });
    if (mode === 'pi') await write(child, { id: 'state', type: 'get_state' });
    else child.stdin!.end(mode === 'claude' || mode === 'codex' || mode === 'opencode' ? task.prompt : undefined);
    await done;
    if (mode === 'codex' || mode === 'opencode') {
      await Promise.race([exited, failed]);
      if (failure) throw failure;
      if (exitCode !== 0) throw Error(`${mode === 'codex' ? 'Codex' : 'OpenCode'} exited unsuccessfully`);
      if (mode === 'opencode' && !finished) throw Error('OpenCode exited before session completion');
    }
    await chain; if (failure) throw failure;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', abort);
    child.stdin!.end();
    if (!didClose) {
      stop(child, 'SIGTERM');
      const kill = setTimeout(() => stop(child, 'SIGKILL'), 1000);
      await Promise.race([exited, new Promise<void>(res => setTimeout(res, 2500))]);
      clearTimeout(kill);
    }
    // Bound cleanup across process close, stream closure, and queued persistence.
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([exited, chain]), new Promise<void>(res => { cleanupTimer = setTimeout(res, 3000); })]);
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}
