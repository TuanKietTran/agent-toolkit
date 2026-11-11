import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOwnership } from '../ownership.ts';

test('ownership: a registered tab belongs to its agent only', () => {
  const o = createOwnership();
  o.register('agent-a', 'tab-1');
  assert.equal(o.owner('tab-1'), 'agent-a');
  assert.equal(o.owns('agent-a', 'tab-1'), true);
  assert.equal(o.owns('agent-b', 'tab-1'), false);
  assert.deepEqual(o.list('agent-a'), ['tab-1']);
  assert.deepEqual(o.list('agent-b'), []);
});

test('ownership: unknown tabs have no owner', () => {
  const o = createOwnership();
  assert.equal(o.owner('nope'), undefined);
  assert.equal(o.owns('agent-a', 'nope'), false);
  assert.deepEqual(o.list('agent-a'), []);
});

test('ownership: lists are per-agent and complete', () => {
  const o = createOwnership();
  o.register('agent-a', 'tab-1');
  o.register('agent-a', 'tab-2');
  o.register('agent-b', 'tab-3');
  assert.deepEqual([...o.list('agent-a')].sort(), ['tab-1', 'tab-2']);
  assert.deepEqual(o.list('agent-b'), ['tab-3']);
});

test('ownership: assign gives an existing tab to an agent (user action)', () => {
  const o = createOwnership();
  o.assign('agent-b', 'user-tab');
  assert.equal(o.owner('user-tab'), 'agent-b');
  assert.equal(o.owns('agent-b', 'user-tab'), true);
  assert.equal(o.owns('agent-a', 'user-tab'), false);
});

test('ownership: release drops the tab for everyone', () => {
  const o = createOwnership();
  o.register('agent-a', 'tab-1');
  o.release('tab-1');
  assert.equal(o.owner('tab-1'), undefined);
  assert.equal(o.owns('agent-a', 'tab-1'), false);
  assert.deepEqual(o.list('agent-a'), []);
});

test('ownership: releasing an unknown tab does not throw', () => {
  const o = createOwnership();
  o.release('ghost');
  assert.deepEqual(o.list('agent-a'), []);
});

test('ownership: separate instances are independent', () => {
  const a = createOwnership();
  const b = createOwnership();
  a.register('agent-a', 'tab-1');
  assert.equal(b.owner('tab-1'), undefined);
});
