// Actual HTTP verification of the running local celld fleet, not a runtime mock.
// Requires the two explicitly MOCK worker services; never invokes a real provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

type Run = { id: string; agent: string; text: string; status: string; mode: string; session_id: string; error: string };
async function main() {
  if (process.env.CONFIRM_FLEET_TEST !== 'YES') throw Error('Set CONFIRM_FLEET_TEST=YES to send synthetic messages to the local fleet.');
  const token = process.env.CHAT_TOKEN;
  if (!token) throw Error('CHAT_TOKEN required; use node --env-file=.env --import tsx scripts/verify-fleet.ts');
  const room = process.env.FLEET_TEST_ROOM || 'fleet-verify';
  assert.match(room, /^[a-zA-Z0-9_-]{1,64}$/);
  const origins = [process.env.CHAT_PORT_A || '18877', process.env.CHAT_PORT_B || '18878'].map(p => {
    assert.match(p, /^\d+$/); return `http://127.0.0.1:${p}`;
  });
  async function api(node: number, path: string, data?: unknown): Promise<any> {
    const response = await fetch(`${origins[node]}/api/rooms/${room}/${path}`, { method: data ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error(`Node ${node === 0 ? 'A' : 'B'} ${path.split('?')[0]} returned HTTP ${response.status}`);
    return response.json();
  }
  async function until<T>(fn: () => Promise<T | undefined>, label: string, timeout = 90000): Promise<T> {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = await fn(); if (result !== undefined) return result; await delay(100); }
    throw Error(`Timed out: ${label}`);
  }
  const before = await until(async () => {
    try { const [a,b] = await Promise.all([api(0, 'history'), api(1, 'history')]); assert.deepEqual(a,b); return a; }
    catch { return undefined; }
  }, 'both ingress nodes serving the same room');
  const prefix = randomUUID().slice(0, 8);
  const ids = [`${prefix}-pi`,`${prefix}-claude`,`${prefix}-resume`,`${prefix}-cancel`];
  const messages = [
    { id: ids[0], agent: 'pi', prompt: 'Synthetic fleet verification via node A. '.repeat(12) },
    { id: ids[1], agent: 'claude', prompt: 'Synthetic fleet verification via node B. '.repeat(12) }
  ];
  await Promise.all(messages.map((message, i) => api(i, 'send', message)));
  let incrementalObserved = false;
  await until(async () => {
    const runs: Run[] = (await api(1, 'history')).runs;
    const current = runs.filter(r => ids.slice(0,2).includes(r.id));
    if (current.some(r => r.status === 'running' && r.text.length > 0)) incrementalObserved = true;
    for (const r of current) assert.notEqual(r.status, 'error', `Agent failed: ${r.error}`);
    return current.length === 2 && current.every(r => r.status === 'done') ? true : undefined;
  }, 'two mock agents complete');
  assert.ok(incrementalObserved, 'Expected visible text before completion');
  const first = await api(0, 'history'); assert.deepEqual(first, await api(1, 'history'));
  const own: Run[] = first.runs.filter((r: Run) => ids.includes(r.id));
  assert.equal(own.length, 2);
  for (const r of own) { assert.equal(r.mode, 'mock'); assert.match(r.text, /\[MOCK/); }
  const events = (await api(0, `events?after=${before.cursor}`)).events;
  assert.ok(events.filter((e: any) => e.kind === 'delta' && ids.includes(e.run_id)).length > 5);
  // Retry an identical user send through the other ingress; it must not enqueue another turn.
  await api(1, 'send', messages[0]);
  await api(1, 'send', { id: ids[2], agent: 'pi', prompt: 'Synthetic session-continuity follow-up through node B.' });
  const resumed: Run = await until(async () => {
    const r = (await api(0, 'history')).runs.find((r: Run) => r.id === ids[2]);
    if (r?.status === 'error') throw Error('Resume run failed');
    return r?.status === 'done' ? r : undefined;
  }, 'same-session follow-up');
  assert.equal(resumed.session_id, own.find(r => r.agent === 'pi')!.session_id); assert.match(resumed.text, /resumed/);
  await api(0, 'send', { id: ids[3], agent: 'claude', prompt: 'Synthetic cancellation test. '.repeat(100) });
  await until(async () => (await api(1, 'history')).runs.some((r: Run) => r.id === ids[3] && r.status === 'running' && r.text.length > 0) ? true : undefined, 'stream before cancel');
  const cancelled = await api(1, 'cancel', { id: ids[3] });
  await delay(3000);
  const a = await api(0, 'history'), b = await api(1, 'history'); assert.deepEqual(a,b);
  const finalCancelled = a.runs.find((r: Run) => r.id === ids[3]);
  assert.equal(finalCancelled.status, 'cancelled'); assert.equal(finalCancelled.text, cancelled.text);
  assert.equal(a.runs.filter((r: Run) => ids.includes(r.id)).length, 4);
  assert.equal(a.runs.length, before.runs.length + 4, 'No automatic agent ping-pong');
  const result = { verifiedAt: new Date().toISOString(), runtime: 'actual celld fleet HTTP (not Miniflare)', origins, room,
    incrementalObserved, crossNodeHistoryIdentical: true, idempotentSend: true, sessionContinuity: true,
    cancellationFenced: true, noAutomaticPingPong: true,
    runs: a.runs.filter((r: Run) => ids.includes(r.id)).map((r: Run) => ({ id: r.id, agent: r.agent, status: r.status, mode: r.mode, session_id: r.session_id })) };
  await mkdir('.deploy', { recursive: true, mode: 0o700 });
  await writeFile('.deploy/fleet-verification.json', JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'Fleet verification failed'); process.exitCode = 1; });
