// Explicit opt-in smoke test: spends real provider usage and saves local session artifacts.
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runAdapter } from '../src/agent/adapters';
import type { Mode, Task } from '../src/protocol';

if (process.env.CONFIRM_LIVE_AGENTS !== 'YES') throw Error('Set CONFIRM_LIVE_AGENTS=YES to invoke real providers');
const cwd = await mkdtemp(join(tmpdir(), 'session-chat-live-'));
for (const agent of ['pi', 'claude'] as const satisfies readonly Mode[]) {
  const session = randomUUID();
  const marker = `recall_${randomUUID().replaceAll('-', '')}`;
  const base: Task = { id: randomUUID(), agent, prompt: '', text: '', status: 'running', mode: agent, error: '', session_id: session, worker_id: `live-${agent}`, lease: Date.now() + 120000, seq: 0, created: Date.now(), resume: false };
  const extraArgs = agent === 'pi' ? ['--provider', process.env.PI_PROVIDER || 'openai-codex', '--model', process.env.PI_MODEL || 'gpt-6.1-sol', '--no-tools', '--no-context-files'] : ['--tools', ''];
  for (const resume of [false, true]) {
    let text = '', initialized = false, deltas = 0;
    const prompt = resume ? 'What exact recall marker did I ask you to remember? Reply with only the marker. Do not use tools.' : `Remember this exact recall marker for my next message: ${marker}. Reply with only the marker. Do not use tools.`;
    await runAdapter({ ...base, id: randomUUID(), prompt, resume }, { mode: agent, cwd, dataDir: join(cwd, 'pi-sessions'), extraArgs, timeoutMs: 120000 }, async update => {
      if (update.kind === 'delta') { text += update.text; deltas++; }
      if (update.kind === 'session') initialized = true;
    }, new AbortController().signal);
    assert.ok(initialized, `${agent}: session not initialized`);
    assert.ok(deltas > 0, `${agent}: no text output`);
    assert.ok(text.includes(marker), `${agent}: recall check failed`);
    console.log(`${agent}: ${resume ? 'resumed recall' : 'new session'} PASS (${deltas} output records)`);
  }
}
console.log('Live Pi and Claude adapter continuity PASS; session artifacts retained in a temporary directory.');
