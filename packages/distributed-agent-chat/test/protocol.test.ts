import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { modes, validMode, type Agent, type Mode } from '../src/protocol';

test('mode allowlist includes implemented adapters only', () => {
  assert.deepEqual(modes, ['pi', 'claude', 'codex', 'opencode', 'mock']);
  for (const mode of modes) assert.equal(validMode(mode), true);
  for (const mode of ['unknown', '', null, undefined, 42]) assert.equal(validMode(mode), false);
});

test('Mode is the adapter mode union and Agent IDs remain arbitrary strings', () => {
  const mode: Mode = 'codex';
  const agent: Agent = 'customer-configured-target-42';
  assert.equal(validMode(mode), true);
  assert.equal(agent, 'customer-configured-target-42');
});
