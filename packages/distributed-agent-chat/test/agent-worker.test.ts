import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { agentWorker } from '../src/agent/worker';

test('Codex full-text output is safely chunked and preserved', { timeout: 10_000 }, async t => {
  const originalFetch = globalThis.fetch;
  const shutdown = new AbortController();
  const expected = ('😀\u0001\n\t\u2028x').repeat(3000);
  const bodies: Array<{ seq: number; update: any; serialized: string }> = [];
  let claimed = false;
  const watchdog = setTimeout(() => shutdown.abort(), 7000);
  globalThis.fetch = async (_input: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (String(_input).endsWith('/claim')) {
      if (claimed) return Response.json({ task: null });
      claimed = true;
      return Response.json({ task: { id: 'large', seq: 0, agent: 'a', prompt: 'large', session_id: 's', resume: false } });
    }
    if (String(_input).endsWith('/update')) {
      bodies.push({ seq: body.seq, update: body.update, serialized: String(init?.body) });
      if (body.update.kind === 'done') shutdown.abort();
      return Response.json({ ok: true });
    }
    return Response.json({ cancel: false });
  };
  try {
    await agentWorker({ url: 'http://worker', room: 'r', agent: 'a', worker: 'w', token: 't', mode: 'codex', cwd: '.', dataDir: '.', binary: process.execPath, extraArgs: [resolve('test/fixtures/protocol-agent.mjs')], heartbeatMs: 1000, pollMs: 50 }, shutdown.signal);
    const deltas = bodies.filter(x => x.update.kind === 'delta');
    assert.equal(deltas.map(x => x.update.text).join(''), expected);
    assert.ok(deltas.length > 1);
    const maxSerializedBodyBytes = Math.max(...deltas.map(d => Buffer.byteLength(d.serialized)));
    assert.ok(maxSerializedBodyBytes <= 20_480);
    t.diagnostic(`Maximum serialized delta update body: ${maxSerializedBodyBytes} bytes`);
    for (const d of deltas) {
      assert.ok(Buffer.byteLength(d.serialized) <= 20 * 1024);
      assert.ok([...d.update.text].length <= 16000);
    }
    assert.deepEqual(bodies.map(x => x.seq), bodies.map((_, i) => i + 1));
  } finally { clearTimeout(watchdog); globalThis.fetch = originalFetch; shutdown.abort(); }
});
