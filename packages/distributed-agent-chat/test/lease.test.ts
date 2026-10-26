import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { setTimeout as delay } from 'node:timers/promises';

test('abandoned lease becomes durable error without automatic duplicate execution', async () => {
  const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, format: 'esm', write: false });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-10-11', durableObjects: { ROOMS: { className: 'Room', useSQLite: true } }, bindings: { CHAT_TOKEN: 'user-test', PI_TOKEN: 'pi-test', CLAUDE_TOKEN: 'claude-test' } });
  const api = async (path: string, data?: any, agent = false) => {
    const r = await mf.dispatchFetch('http://localhost/api/rooms/lease/' + path, { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + (agent ? 'pi-test' : 'user-test') }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    await api('send', { id: 'abandon', agent: 'pi', prompt: 'do not duplicate' });
    const claim = await api('agent/pi/claim', { worker: 'stable', mode: 'mock' }, true);
    assert.ok(claim.body.task);
    await delay(15200);
    const h = await api('history');
    assert.equal(h.body.runs[0].status, 'error'); assert.match(h.body.runs[0].error, /lease expired/);
    assert.equal((await api('agent/pi/claim', { worker: 'stable', mode: 'mock' }, true)).body.task, null);
    assert.equal((await api('agent/pi/update', { worker: 'stable', id: 'abandon', seq: 1, update: { kind: 'done' } }, true)).status, 409);
  } finally { await mf.dispose(); }
});
