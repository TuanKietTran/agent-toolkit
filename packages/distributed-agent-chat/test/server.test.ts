import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const tsx = resolve('node_modules/tsx/dist/cli.mjs');
const server = resolve('scripts/server.ts');
const chat = 'synthetic-chat-token-long-enough-123';
const worker = 'synthetic-worker-token-long-enough-123';

function runWithSecrets(chatToken: string, agentTokens: Record<string, string>) {
  return spawnSync(process.execPath, [tsx, server], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      PATH: process.env.PATH ?? '',
      CHAT_HOST: '127.0.0.1',
      CHAT_TOKEN: chatToken,
      AGENT_TOKENS: JSON.stringify(agentTokens),
    },
  });
}

test('server rejects invalid secrets before Miniflare can listen', () => {
  const cases: Array<{ chatToken: string; agents: Record<string, string> }> = [
    { chatToken: chat, agents: { one: chat } },
    { chatToken: chat, agents: { one: worker, two: worker } },
    { chatToken: 'short', agents: { one: worker } },
    { chatToken: chat, agents: { one: 'short' } },
  ];

  for (const invalid of cases) {
    const result = runWithSecrets(invalid.chatToken, invalid.agents);
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, 'invalid secrets must stop startup');
    assert.match(output, /distinct random chat and worker tokens/);
    assert.doesNotMatch(output, /Miniflare coordinator listening/);
    for (const secret of [invalid.chatToken, ...Object.values(invalid.agents)]) {
      assert.ok(!output.includes(secret), `startup output must not disclose configured secret`);
    }
  }
});
