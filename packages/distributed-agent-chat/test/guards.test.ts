import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const file of ['scripts/exe-create.sh','scripts/run-celld.sh']) test(`${file} refuses without opt-in before any external command`, () => {
  const r = spawnSync('/bin/sh', [file], { env: { PATH: '/nonexistent' }, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Disabled/);
});
test('deployment helper refuses without opt-in', () => {
  const env = { ...process.env }; delete env.CONFIRM_FLEET_DEPLOY;
  const r = spawnSync(process.execPath, ['--import','tsx','scripts/deploy.ts'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Deployment disabled/);
});
test('agent executable refuses implicit mock/backend mode', () => {
  const env = { ...process.env }; delete env.AGENT_MODE;
  const r = spawnSync(process.execPath, ['--import','tsx','src/agent/cli.ts'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /configuration or startup failed/);
});
