import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { nativeFeatures, piConfig, validateAgentBinary, validateExtraArgs } from '../src/agent/worker';
import { managedArgs } from '../src/agent/adapters';
import type { Task } from '../src/protocol';
const fixtureTask: Task = { id: 'test', agent: 'any-target', prompt: 'test', text: '', status: 'running', mode: 'pi', error: '', session_id: 'session-test', worker_id: 'worker', lease: 0, seq: 0, created: 0, resume: false };

const shell = process.platform === 'win32'
  ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].find(existsSync)
  : existsSync('/bin/sh') ? '/bin/sh' : undefined;
for (const file of ['scripts/exe-create.sh','scripts/run-celld.sh']) test(`${file} executes in ${shell || 'shell unavailable'} and refuses before external commands`, t => {
  if (!shell) { t.skip('No /bin/sh or supported installed Git Bash executable found'); return; }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: '/nonexistent' };
  delete env.CONFIRM_EXE_CREATE; delete env.CONFIRM_CELLD_RUN;
  const r = spawnSync(shell, [resolve(file)], { encoding: 'utf8', env });
  assert.equal(r.status, 1, `shell exit=${r.status}; stdout=${r.stdout}; stderr=${r.stderr}`);
  assert.match(r.stderr, /Disabled:/);
  assert.doesNotMatch(r.stderr + r.stdout, /not found|command not found|ssh:|celld:/i);
});
test('deployment helper refuses without opt-in', () => {
  const env = { ...process.env }; delete env.CONFIRM_FLEET_DEPLOY;
  const r = spawnSync(process.execPath, ['--import','tsx','scripts/deploy.ts'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Deployment disabled/);
});
test('Pi native config maps provider/model and constrained tool features to CLI flags', () => {
  assert.deepEqual(piConfig({ AGENT_PROVIDER: 'openai', AGENT_MODEL: 'gpt-test', AGENT_PI_TOOLS: 'read,grep' }), ['--tools', 'read,grep']);
  assert.deepEqual(piConfig({ AGENT_PI_PROVIDER: 'openai', AGENT_PI_MODEL: 'gpt-test' }), []);
  assert.throws(() => piConfig({ AGENT_PROVIDER: 'openai', AGENT_PI_PROVIDER: 'anthropic' }), /conflicts/);
  assert.deepEqual(piConfig({ AGENT_PI_NO_TOOLS: '1' }), ['--no-tools']);
  assert.throws(() => piConfig({ AGENT_PI_TOOLS: 'bash,arbitrary' }), /supported Pi tools/);
  assert.throws(() => piConfig({ AGENT_PI_PROVIDER: '   ' }), /invalid/);
  assert.throws(() => piConfig({ AGENT_PI_TRUSTED_NATIVE: 'true' }), /require AGENT_PI_TRUSTED_NATIVE=1/);
  assert.deepEqual(nativeFeatures({ AGENT_PI_TRUSTED_NATIVE: '1', AGENT_NATIVE_FEATURES: 'skills' }), ['skills']);
  assert.deepEqual(nativeFeatures({}), []);
  assert.throws(() => piConfig({ AGENT_NATIVE_FEATURES: 'extensions' }), /require AGENT_PI_TRUSTED_NATIVE=1/);
  assert.throws(() => piConfig({ AGENT_NATIVE_FEATURES: 'unknown', AGENT_PI_TRUSTED_NATIVE: '1' }), /unique list/);
  for (const flag of ['--extension=./x', '-e./x', '--skill=./x', '--prompt-template=./x', '-cmodel_provider=x', '-mfoo', '--session=x']) assert.throws(() => validateExtraArgs([flag]), /cannot contain CLI flags/);
  assert.deepEqual(validateExtraArgs(['fixture.mjs']), undefined);
  const base = { dataDir: '.agent-data', model: 'coder', provider: 'ollama' };
  const piArgs = managedArgs('pi', fixtureTask, base);
  assert.deepEqual(piArgs.slice(-4), ['--provider', 'ollama', '--model', 'coder']);
  const combinedPiArgs = [...piConfig({ AGENT_PROVIDER: 'ollama', AGENT_MODEL: 'coder' }), ...piArgs];
  assert.equal(combinedPiArgs.filter(arg => arg === '--provider').length, 1);
  assert.equal(combinedPiArgs.filter(arg => arg === '--model').length, 1);
  assert.ok(managedArgs('claude', fixtureTask, { ...base, provider: undefined }).includes('coder'));
  assert.throws(() => managedArgs('claude', fixtureTask, base), /ANTHROPIC_BASE_URL/);
  assert.ok(managedArgs('claude', fixtureTask, { ...base, providerEndpointConfigured: true }).includes('coder'));
  const codexArgs = managedArgs('codex', fixtureTask, base);
  assert.ok(codexArgs.includes('--oss'));
  assert.deepEqual(codexArgs.slice(codexArgs.indexOf('--local-provider'), codexArgs.indexOf('--local-provider') + 2), ['--local-provider', 'ollama']);
  assert.ok(managedArgs('opencode', fixtureTask, base).includes('ollama/coder'));
});
test('Windows native executable boundary is checked with injected platform', () => {
  assert.equal(validateAgentBinary('codex', 'C:\\Tools\\codex.exe', 'win32'), 'C:\\Tools\\codex.exe');
  assert.equal(validateAgentBinary('codex', '\\\\server\\share\\codex.exe', 'win32'), '\\\\server\\share\\codex.exe');
  assert.throws(() => validateAgentBinary('codex', 'C:\\Tools\\codex.cmd', 'win32'), /native .exe/);
  assert.throws(() => validateAgentBinary('codex', 'C:\\Tools\\codex.ps1', 'win32'), /native .exe/);
  assert.throws(() => validateAgentBinary('codex', undefined, 'win32'), /absolute native .exe/);
  assert.throws(() => validateAgentBinary('codex', 'codex.exe', 'win32'), /absolute native .exe/);
  assert.throws(() => validateAgentBinary('pi', undefined, 'win32'), /AGENT_BINARY/);
  assert.equal(validateAgentBinary('pi', 'D:\\Agents\\pi.exe', 'win32'), 'D:\\Agents\\pi.exe');
  assert.equal(validateAgentBinary('mock', undefined, 'win32'), undefined);
});
test('agent executable refuses implicit mock/backend mode', () => {
  const env = { ...process.env }; delete env.AGENT_MODE;
  const r = spawnSync(process.execPath, ['--import','tsx','src/agent/cli.ts'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /configuration or startup failed/);
});
