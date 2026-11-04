import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTokens, validateSecrets } from '../src/auth';

const chat = 'chat-token-long-enough-for-security-123';
const workerA = 'worker-a-token-long-enough-for-security-123';
const workerB = 'worker-b-token-long-enough-for-security-123';

test('auth requires distinct chat and worker tokens, including distinct worker tokens', () => {
  assert.doesNotThrow(() => validateSecrets({ CHAT_TOKEN: chat, AGENT_TOKENS: JSON.stringify({ nodeA: workerA, nodeB: workerB }) }));
  assert.throws(() => validateSecrets({ CHAT_TOKEN: chat, AGENT_TOKENS: JSON.stringify({ nodeA: chat }) }), /distinct random chat and worker tokens/);
  assert.throws(() => validateSecrets({ CHAT_TOKEN: chat, AGENT_TOKENS: JSON.stringify({ nodeA: workerA, nodeB: workerA }) }), /distinct random chat and worker tokens/);
  assert.throws(() => validateSecrets({ CHAT_TOKEN: 'short', PI_TOKEN: workerA }), /distinct random chat and worker tokens/);
  assert.throws(() => validateSecrets({ CHAT_TOKEN: chat, PI_TOKEN: 'short' }), /distinct random chat and worker tokens/);
  assert.throws(() => validateSecrets({ CHAT_TOKEN: chat, PI_TOKEN: chat }), /distinct random chat and worker tokens/);
});

test('agent token map preserves dangerous-looking valid IDs as own properties', () => {
  const tokens = agentTokens({ AGENT_TOKENS: `{"constructor":"${workerA}","__proto__":"${workerB}"}` });
  assert.equal(Object.hasOwn(tokens, 'constructor'), true);
  assert.equal(tokens.constructor, workerA);
  assert.equal(Object.hasOwn(tokens, '__proto__'), true);
  assert.equal(tokens.__proto__, workerB);
});
