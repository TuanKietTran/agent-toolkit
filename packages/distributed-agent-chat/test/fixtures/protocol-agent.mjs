#!/usr/bin/env node
// Protocol fixture, NOT a real Pi or Claude backend.
import { createInterface } from 'node:readline';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (process.argv.includes('--mode')) {
  createInterface({ input: process.stdin }).on('line', line => {
    const r = JSON.parse(line);
    if (r.type === 'get_state') emit({ type: 'response', id: r.id, command: r.type, success: true, data: { sessionId: 'fixture' } });
    if (r.type === 'prompt') {
      emit({ type: 'response', id: r.id, command: 'prompt', success: true });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Pi fixture Δ\u2028text' } });
      emit({ type: 'agent_end', willRetry: true });
      setTimeout(() => {
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' after retry' } });
        emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
        emit({ type: 'agent_settled' });
      }, 25);
    }
  });
} else {
  let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', d => prompt += d);
  process.stdin.on('end', () => {
    emit({ type: 'system', subtype: 'init', session_id: 'fixture' });
    if (prompt === 'error') { emit({ type: 'result', subtype: 'error_during_execution', is_error: true }); return; }
    if (prompt === 'exit') return;
    if (prompt === 'hang') { setInterval(() => {}, 1000); return; }
    emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: process.argv.includes('--resume') ? 'Claude resumed' : 'Claude fixture' } } });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Do not duplicate' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'Do not duplicate' });
  });
}
