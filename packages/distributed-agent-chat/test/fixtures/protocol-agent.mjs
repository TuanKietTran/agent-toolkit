#!/usr/bin/env node
// Protocol fixture, NOT a real Pi or Claude backend.
import { createInterface } from 'node:readline';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeSync } from 'node:fs';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (process.argv.includes('--mode')) {
  const arg = name => process.argv[process.argv.indexOf(name) + 1];
  createInterface({ input: process.stdin }).on('line', async line => {
    const r = JSON.parse(line);
    if (r.type === 'get_state') emit({ type: 'response', id: r.id, command: r.type, success: true, data: { sessionId: arg('--session') } });
    if (r.type === 'prompt') {
      if (r.message === 'env-check') {
        const keys = JSON.parse(process.env.FIXTURE_ENV_KEYS || '["ANTHROPIC_API_KEY","SAFE_SETTING"]');
        const visible = keys.filter(k => Object.keys(process.env).some(present => present.toUpperCase() === k.toUpperCase())).join(',');
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: visible } }); emit({ type: 'agent_settled' }); return;
      }
      const dir = arg('--session-dir'); await mkdir(dir, { recursive: true });
      await writeFile(arg('--session'), 'synthetic native session');
      emit({ type: 'tool_execution_start', name: 'read' }); emit({ type: 'tool_execution_end', name: 'read', isError: false });
      emit({ type: 'response', id: r.id, command: 'prompt', success: true });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Pi fixture Δ\u2028text' } });
      emit({ type: 'agent_end', willRetry: true });
      setTimeout(() => {
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' after retry' } });
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', usage: { input: 7, output: 3, cacheRead: 1, cost: { total: 0.01 } } } });
        emit({ type: 'agent_settled' });
      }, 25);
    }
  });
} else if (process.argv.includes('exec')) {
  const resume = process.argv.includes('resume');
  const resumeId = resume ? process.argv[process.argv.indexOf('resume') + 1] : undefined;
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  emit({ type: 'thread.started', thread_id: resume ? resumeId : 'codex-new' });
  if (prompt === 'env-check') { const keys = JSON.parse(process.env.FIXTURE_ENV_KEYS || '[]'); emit({ type: 'item.completed', item: { id: 'env-item', type: 'agent_message', text: keys.filter(k => Object.keys(process.env).some(p => p.toUpperCase() === k.toUpperCase())).join(',') } }); emit({ type: 'turn.completed' }); }
  else if (prompt === 'incomplete') { emit({ type: 'item.completed', item: { id: 'fixture-item', type: 'agent_message', text: 'partial' } }); process.stdout.end(() => { process.stdout.destroy(); try { closeSync(1); } catch {} try { process.stdout._handle?.close(); } catch {} }); setInterval(() => {}, 1000); }
  else if (prompt === 'hang') { if (process.env.FIXTURE_DESCENDANT) { const { spawn } = await import('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); if (process.env.FIXTURE_PID_FILE) await writeFile(process.env.FIXTURE_PID_FILE, String(child.pid)); } setInterval(() => {}, 1000); }
  else if (prompt === 'exit' || prompt === 'no-terminal') { if (prompt === 'no-terminal') emit({ type: 'item.completed', item: { id: 'fixture-item', type: 'agent_message', text: 'incomplete' } }); process.exit(0); }
  else if (prompt === 'nonzero') { emit({ type: 'turn.completed' }); process.exit(3); }
  else if (prompt === 'error') emit({ type: 'turn.failed', error: { message: 'synthetic failure' } });
  else if (prompt === 'large') { emit({ type: 'item.completed', item: { id: 'large-item', type: 'agent_message', text: ('😀\u0001\n\t\u2028x').repeat(3000) } }); emit({ type: 'turn.completed' }); }
  else { emit({ type: 'item.started', item: { id: 'tool-1', type: 'command_execution', name: 'exec_command', command: 'secret args' } }); emit({ type: 'item.completed', item: { id: 'tool-1', type: 'command_execution', name: 'exec_command' } }); emit({ type: 'item.completed', item: { id: 'fixture-item', type: 'agent_message', text: resume ? 'Codex resumed' : 'Codex fixture' } }); emit({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 2 } }); }
} else if (process.argv.includes('run')) {
  const resume = process.argv.includes('--session');
  const resumeId = resume ? process.argv[process.argv.indexOf('--session') + 1] : undefined;
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  emit({ type: 'session.created', sessionID: resume ? resumeId : 'opencode-new' });
  if (prompt === 'env-check') { const keys = JSON.parse(process.env.FIXTURE_ENV_KEYS || '[]'); emit({ type: 'text', sessionID: 'env', part: { text: keys.filter(k => Object.keys(process.env).some(p => p.toUpperCase() === k.toUpperCase())).join(',') } }); emit({ type: 'step_finish', part: { reason: 'stop' } }); }
  else if (prompt === 'incomplete') { emit({ type: 'text', sessionID: 'incomplete', part: { text: 'partial' } }); process.stdout.end(() => { process.stdout.destroy(); try { closeSync(1); } catch {} try { process.stdout._handle?.close(); } catch {} }); setInterval(() => {}, 1000); }
  else if (prompt === 'hang') { if (process.env.FIXTURE_DESCENDANT) { const { spawn } = await import('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); if (process.env.FIXTURE_PID_FILE) await writeFile(process.env.FIXTURE_PID_FILE, String(child.pid)); } setInterval(() => {}, 1000); }
  else if (prompt === 'exit' || prompt === 'no-terminal') { if (prompt === 'no-terminal') emit({ type: 'text', sessionID: 'incomplete', part: { text: 'incomplete' } }); process.exit(0); }
  else if (prompt === 'nonzero') { emit({ type: 'step_finish', part: { reason: 'stop' } }); process.exit(3); }
  else if (prompt === 'error') emit({ type: 'session.error', error: { message: 'synthetic failure' } });
  else { emit({ type: 'text', sessionID: 'opencode-new', part: { text: resume ? 'OpenCode resumed' : 'OpenCode fixture' } }); emit({ type: 'tool', part: { tool: 'read', state: { status: 'running', input: { secret: true } } } }); emit({ type: 'tool', part: { tool: 'read', state: { status: 'completed', input: { secret: 'private argument' }, output: 'private result' } } }); emit({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 5, output: 3 } } }); emit({ type: 'session.status', status: { type: 'idle' } }); }
} else {
  let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => prompt += d);
  process.stdin.on('end', () => {
    emit({ type: 'system', subtype: 'init', session_id: 'fixture' });
    if (prompt === 'error') { emit({ type: 'result', subtype: 'error_during_execution', is_error: true }); return; }
    if (prompt === 'env-check') { const keys = JSON.parse(process.env.FIXTURE_ENV_KEYS || '[]'); emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: keys.filter(k => Object.keys(process.env).some(p => p.toUpperCase() === k.toUpperCase())).join(',') } } }); emit({ type: 'result', subtype: 'success', is_error: false }); return; }
    if (prompt === 'exit') return;
    if (prompt === 'hang') { setInterval(() => {}, 1000); return; }
    emit({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' } } });
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: process.argv.includes('--resume') ? 'Claude resumed' : 'Claude fixture' } } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', name: 'Read' }] } });
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'Do not duplicate', usage: { input_tokens: 3, output_tokens: 2 } });
  });
}
