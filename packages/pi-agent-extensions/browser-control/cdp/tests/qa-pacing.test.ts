import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as pacingNs from '../pacing.ts';
import { FAST_PACING } from '../contract.ts';

// The contract fixes PacingOptions/FAST_PACING and the semantics (serialized mutex,
// random delay in [min,max] before each action, minimum gap between actions, injectable
// sleep/random) but does not name the pacer export. makePacer resolves whichever
// factory/class the controller shipped; runAction resolves its run/wait/delay/acquire method.
// If neither exists this file fails loudly, which is the intended phase-2 signal.
function makePacer(opts: object): any {
  const ns: any = pacingNs as any;
  if (typeof ns.createPacer === 'function') return ns.createPacer(opts);
  if (typeof ns.createPacing === 'function') return ns.createPacing(opts);
  if (typeof ns.Pacer === 'function') return new ns.Pacer(opts);
  if (typeof ns.Pacing === 'function') return new ns.Pacing(opts);
  assert.fail('pacing.ts exports no pacer factory/class (createPacer/createPacing/Pacer/Pacing)');
}
async function runAction(p: any, fn: () => Promise<void>): Promise<void> {
  if (typeof p.run === 'function') return p.run(fn);
  if (typeof p.wait === 'function') { await p.wait(); return fn(); }
  if (typeof p.delay === 'function') { await p.delay(); return fn(); }
  if (typeof p.acquire === 'function') { const r = await p.acquire(); try { return await fn(); } finally { if (typeof r === 'function') r(); else if (typeof p.release === 'function') p.release(); } }
  assert.fail('pacer exposes none of run/wait/delay/acquire');
}

test('pacing: FAST_PACING disables all delays', () => {
  assert.equal(FAST_PACING.minDelayMs, 0);
  assert.equal(FAST_PACING.maxDelayMs, 0);
  assert.equal(FAST_PACING.minGapMs, 0);
});

test('pacing: delay before an action uses the injected sleep and stays in [min,max]', async () => {
  const slept: number[] = [];
  const p = makePacer({ minDelayMs: 100, maxDelayMs: 300, minGapMs: 0, sleep: async (ms: number) => { slept.push(ms); }, random: () => 0 });
  await runAction(p, async () => {});
  assert.ok(slept.length >= 1, 'expected the pacer to sleep via the injected sleep');
  for (const ms of slept) assert.ok(ms >= 100 && ms <= 300, `delay ${ms} outside [100,300]`);
  assert.equal(slept[0], 100, 'random()=0 should give the minimum delay');
});

test('pacing: random()=1 reaches the maximum delay', async () => {
  const slept: number[] = [];
  const p = makePacer({ minDelayMs: 100, maxDelayMs: 300, minGapMs: 0, sleep: async (ms: number) => { slept.push(ms); }, random: () => 1 });
  await runAction(p, async () => {});
  assert.ok(slept.length >= 1);
  assert.ok(slept[0] >= 100 && slept[0] <= 300, `delay ${slept[0]} outside [100,300]`);
  assert.ok(slept[0] > 250, `random()=1 should approach the maximum, got ${slept[0]}`);
});

test('pacing: actions are serialized, never overlapping', async () => {
  const p = makePacer({ ...FAST_PACING, sleep: async () => {} });
  let active = 0;
  let maxActive = 0;
  const job = async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 25)); active--; };
  await Promise.all([runAction(p, job), runAction(p, job), runAction(p, job)]);
  assert.equal(maxActive, 1);
});

test('pacing: minimum gap between actions is honoured', async () => {
  const p = makePacer({ minDelayMs: 0, maxDelayMs: 0, minGapMs: 90 });
  const t0 = Date.now();
  await runAction(p, async () => {});
  await runAction(p, async () => {});
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 70, `second action started after ${elapsed}ms, below the 90ms gap (20ms tolerance)`);
});
