import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { JsonLines, delta, managedArgs, runAdapter as adapterRun } from '../src/agent/adapters';
import type { Task, Update } from '../src/protocol';
const test: typeof nodeTest = ((name: string, options: any, fn?: any) => {
  if (typeof options === 'function') return nodeTest(name, { timeout: 10000 }, options);
  return nodeTest(name, { ...options, timeout: 10000 }, fn);
}) as typeof nodeTest;
const runAdapter: typeof adapterRun = ((...args: Parameters<typeof adapterRun>) => {
  args[1] = { ...args[1], timeoutMs: Math.min(args[1]?.timeoutMs ?? 3000, 3000) };
  return adapterRun(...args);
}) as typeof adapterRun;
const fixture = resolve('test/fixtures/protocol-agent.mjs');
const task = (prompt = 'test', resume = false): Task => ({ id: 'fixture', agent: 'pi', prompt, text: '', status: 'running', mode: 'pi', error: '', session_id: '709de4b8-04c9-439f-87ca-b93ff49a5f80', worker_id: 'fixture', lease: 0, seq: 0, created: 0, resume });
test('managed argv maps provider/model explicitly per harness and Pi trust opt-in fails closed by default', () => {
  const base = { dataDir: '.wrangler/adapter-test', timeoutMs: 3000, provider: 'ollama', model: 'qwen-coder' };
  assert.deepEqual(managedArgs('pi', task(), base).slice(-4), ['--provider', 'ollama', '--model', 'qwen-coder']);
  assert.ok(managedArgs('claude', task(), { ...base, provider: undefined }).includes('--model'));
  assert.ok(managedArgs('claude', task(), { ...base, provider: undefined }).includes('qwen-coder'));
  assert.throws(() => managedArgs('claude', task(), base), /ANTHROPIC_BASE_URL/);
  const codexArgs = managedArgs('codex', task(), base);
  assert.ok(codexArgs.includes('--skip-git-repo-check'));
  assert.ok(codexArgs.includes('--oss'));
  assert.deepEqual(codexArgs.slice(codexArgs.indexOf('--local-provider'), codexArgs.indexOf('--local-provider') + 2), ['--local-provider', 'ollama']);
  assert.equal(codexArgs.at(-1), '-');
  assert.deepEqual(managedArgs('opencode', task(), base).slice(-1), ['-']);
  const safe = managedArgs('pi', task(), { dataDir: '.wrangler/adapter-test' });
  assert.ok(safe.includes('--no-extensions') && safe.includes('--no-skills') && safe.includes('--no-prompt-templates'));
  const trusted = managedArgs('pi', task(), { dataDir: '.wrangler/adapter-test', trustedPiNative: true });
  assert.ok(!trusted.some(a => ['--no-extensions','--no-skills','--no-prompt-templates'].includes(a)));
});
test('Pi uses a deterministic native session path and resumes its file across invocations', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'adapter-pi-'));
  try {
    const args = managedArgs('pi', task(), { dataDir: dir });
    const session = args[args.indexOf('--session') + 1];
    await runAdapter(task(), { mode: 'pi', binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: dir, timeoutMs: 3000 }, async () => {}, new AbortController().signal);
    assert.equal(session, resolve(session));
    assert.equal(await readFile(session, 'utf8'), 'synthetic native session');
    const resumed = managedArgs('pi', task('again', true), { dataDir: dir });
    assert.equal(resumed[resumed.indexOf('--session') + 1], session);
    await runAdapter(task('again', true), { mode: 'pi', binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: dir, timeoutMs: 3000 }, async () => {}, new AbortController().signal);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('JSONL accepts fragmented UTF8, CRLF and Unicode separators; rejects truncation', () => {
  const records: any[] = [], parser = new JsonLines(r => records.push(r));
  for (const byte of Buffer.from('{"text":"Δ\u2028\u2029"}\r\n')) parser.push(Buffer.from([byte]));
  parser.end(); assert.equal(records[0].text, 'Δ\u2028\u2029');
  const truncated = new JsonLines(() => {}); truncated.push(Buffer.from('{')); assert.throws(() => truncated.end());
});
test('normalizers ignore tools, thinking, nested subagent and completed duplicate text', () => {
  assert.equal(delta('pi', { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hidden' } }), undefined);
  assert.equal(delta('claude', { type: 'stream_event', parent_tool_use_id: 'child', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'nested' } } }), undefined);
  assert.equal(delta('claude', { type: 'assistant', message: { content: [] } }), undefined);
});
for (const mode of ['pi','claude'] as const) test(`${mode} subprocess fixture streams and settles without duplicate final text`, async () => {
  const out: Update[] = [];
  await runAdapter(task(), { mode, binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 3000 }, async u => { out.push(u); }, new AbortController().signal);
  assert.equal(out[0].kind, 'session');
  const text = out.filter(u => u.kind === 'delta').map(u => u.text).join('');
  assert.equal(text, mode === 'pi' ? 'Pi fixture Δ\u2028text after retry' : 'Claude fixture');
  if (mode === 'pi') {
    assert.ok(out.some(u => u.kind === 'activity' && u.activity.type === 'tool' && u.activity.name === 'read' && u.activity.status === 'started'));
    assert.ok(out.some(u => u.kind === 'activity' && u.activity.type === 'usage' && Object.values(u.activity.usage).some(Number.isFinite)));
  } else {
    assert.ok(out.some(u => u.kind === 'activity' && u.activity.type === 'tool' && u.activity.name === 'Read' && u.activity.status === 'started'));
    assert.ok(out.some(u => u.kind === 'activity' && u.activity.type === 'tool' && u.activity.name === 'Read' && u.activity.status === 'completed'));
    assert.ok(out.some(u => u.kind === 'activity' && u.activity.type === 'usage' && Object.values(u.activity.usage).some(Number.isFinite)));
  }
  assert.ok(!JSON.stringify(out).includes('secret'));
});
test('Claude fixture resumes explicit session', async () => {
  let text = '';
  await runAdapter(task('test', true), { mode: 'claude', binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 3000 }, async u => { if (u.kind === 'delta') text += u.text; }, new AbortController().signal);
  assert.equal(text, 'Claude resumed');
});
for (const prompt of ['error','exit']) test(`Claude fixture ${prompt} is not success`, async () => {
  await assert.rejects(runAdapter(task(prompt), { mode: 'claude', binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 3000 }, async () => {}, new AbortController().signal));
});
test('child env filters application/provider secrets and retains only selected credentials', async () => {
  const keys = ['aGeNt_ToKeNs','CHAT_TOKEN','APP_SECRET','AWS_SECRET_ACCESS_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','ANTHROPIC_BASE_URL','SAFE_SETTING','FIXTURE_ENV_KEYS'];
  const saved = new Map(keys.map(k => [k, process.env[k]]));
  const runEnv = async (mode: 'pi' | 'codex', provider: string, expected: string) => {
    process.env.FIXTURE_ENV_KEYS = JSON.stringify(keys.filter(k => k !== 'FIXTURE_ENV_KEYS'));
    const out: Update[] = [];
    await runAdapter({ ...task('env-check'), mode }, { mode, provider, binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 3000 }, async u => { out.push(u); }, new AbortController().signal);
    assert.equal(out.filter(u => u.kind === 'delta').map(u => u.text).join(''), expected);
  };
  try {
    for (const k of keys) process.env[k] = `fixture-${k}`;
    await runEnv('pi', 'anthropic', 'ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL,SAFE_SETTING');
    await runEnv('codex', 'openai', 'OPENAI_API_KEY,ANTHROPIC_BASE_URL,SAFE_SETTING');
  } finally { for (const [k,v] of saved) v === undefined ? delete process.env[k] : process.env[k] = v; }
});
test('Claude Ollama env-check preserves only base URL and sentinel auth token', async () => {
  const keys = ['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','APP_SECRET','CHAT_TOKEN','AWS_SECRET_ACCESS_KEY','SAFE_SETTING','FIXTURE_ENV_KEYS'];
  const saved = new Map(keys.map(k => [k, process.env[k]]));
  try {
    for (const k of keys) process.env[k] = `fixture-${k}`;
    process.env.ANTHROPIC_BASE_URL = 'http://ollama.test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'ollama';
    process.env.FIXTURE_ENV_KEYS = JSON.stringify(keys.filter(k => k !== 'FIXTURE_ENV_KEYS'));
    const out: Update[] = [];
    await runAdapter({ ...task('env-check'), mode: 'claude' }, { mode: 'claude', provider: 'ollama', providerEndpointConfigured: true, binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 3000 }, async u => { out.push(u); }, new AbortController().signal);
    assert.equal(out.filter(u => u.kind === 'delta').map(u => u.text).join(''), 'ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,SAFE_SETTING');
  } finally { for (const [k,v] of saved) v === undefined ? delete process.env[k] : process.env[k] = v; }
});
test('Windows cancellation kills fixture descendants without leaving pipe cleanup hung', async t => {
  if (process.platform !== 'win32') { t.skip('Windows process-tree behavior'); return; }
  const dir = await mkdtemp(resolve(tmpdir(), 'adapter-tree-')), pidFile = resolve(dir, 'descendant.pid');
  const oldDesc = process.env.FIXTURE_DESCENDANT, oldPidFile = process.env.FIXTURE_PID_FILE;
  process.env.FIXTURE_DESCENDANT = '1'; process.env.FIXTURE_PID_FILE = pidFile;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 300);
  try {
    await assert.rejects(runAdapter({ ...task('hang'), mode: 'codex' }, { mode: 'codex', binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: dir, timeoutMs: 3000 }, async () => {}, controller.signal), /Cancelled/);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await new Promise(r => setTimeout(r, 300));
    assert.throws(() => process.kill(pid, 0));
  } finally {
    clearTimeout(timer); oldDesc === undefined ? delete process.env.FIXTURE_DESCENDANT : process.env.FIXTURE_DESCENDANT = oldDesc;
    oldPidFile === undefined ? delete process.env.FIXTURE_PID_FILE : process.env.FIXTURE_PID_FILE = oldPidFile;
    await rm(dir, { recursive: true, force: true });
  }
});
test('subprocess cancellation terminates a hanging fixture', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 150);
  try { await assert.rejects(runAdapter(task('hang'), { mode: 'claude', binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 3000 }, async () => {}, controller.signal), /Cancelled/); }
  finally { clearTimeout(timer); }
});
test('incomplete fixture closes stdout for parent while process remains alive', { timeout: 10000 }, async t => {
  if (process.platform === 'win32') { t.skip('Windows Node child stdio keeps the inherited stdout pipe open after closing fd 1 and the libuv handle'); return; }
  const child = spawn(process.execPath, [fixture, 'exec', '--json', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    const eof = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('fixture stdout EOF deadline exceeded')), 1500);
      child.stdout!.on('data', () => {});
      child.stdout!.once('end', () => { clearTimeout(timer); resolve(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    child.stdin!.end('incomplete');
    await eof;
    assert.equal(child.exitCode, null, 'fixture must remain alive after stdout EOF');
  } finally {
    child.kill('SIGKILL');
  }
});
for (const mode of ['codex','opencode'] as const) {
  const run = (prompt: string, resume = false, signal = new AbortController().signal, out: Update[] = []) => runAdapter({ ...task(prompt, resume), mode, ...(resume ? { provider_session_id: mode === 'codex' ? 'codex-new' : 'opencode-new' } : {}) }, {
    mode, binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 2000
  }, async u => { out.push(u); }, signal).then(() => out);
  const nativeId = mode === 'codex' ? 'codex-new' : 'opencode-new';
  test(`${mode} native fixture captures session ID, streams, and completes successfully`, { timeout: 10000 }, async () => {
    const out = await run('hello');
    assert.equal(out.find(u => u.kind === 'session')?.providerSessionId, nativeId);
    assert.equal(out.filter(u => u.kind === 'delta').map(u => u.text).join(''), mode === 'codex' ? 'Codex fixture' : 'OpenCode fixture');
    if (mode === 'codex') {
      assert.ok(out.some(u => u.kind === 'activity' && u.activity.type === 'tool' && u.activity.name === 'exec_command' && u.activity.status === 'started'));
      assert.ok(out.some(u => u.kind === 'activity' && u.activity.type === 'tool' && u.activity.name === 'exec_command' && u.activity.status === 'completed'));
    } else assert.ok(out.some(u => u.kind === 'activity' && u.activity.type === 'tool' && u.activity.name === 'read' && u.activity.status === 'started'));
    assert.ok(out.some(u => u.kind === 'activity' && u.activity.type === 'usage' && Object.values(u.activity.usage).some(Number.isFinite)));
    assert.ok(!JSON.stringify(out).includes('secret') && !JSON.stringify(out).includes('private argument') && !JSON.stringify(out).includes('private result'));
  });
  test(`${mode} native fixture resumes its provider session`, { timeout: 10000 }, async () => {
    const initial = await run('hello');
    const resumedTask = { ...task('hello', true), mode, provider_session_id: nativeId };
    const resumedOut: Update[] = [];
    await runAdapter(resumedTask, { mode, binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 2000 }, async u => { resumedOut.push(u); }, new AbortController().signal);
    const initialId = initial.find(u => u.kind === 'session')?.providerSessionId;
    const resumedId = resumedOut.find(u => u.kind === 'session')?.providerSessionId;
    assert.equal(resumedTask.provider_session_id, nativeId);
    assert.equal(initialId, nativeId);
    assert.equal(resumedId, nativeId);
    assert.equal(initialId, resumedId);
    const out = resumedOut;
    assert.equal(out.filter(u => u.kind === 'delta').map(u => u.text).join(''), mode === 'codex' ? 'Codex resumed' : 'OpenCode resumed');
  });
  for (const [name, prompt, pattern] of [
    ['failure', 'error', /run failed/], ['early exit', 'exit', mode === 'codex' ? /Codex stdout ended before completion/ : /stdout ended before session completion/],
    ['no terminal event', 'no-terminal', mode === 'codex' ? /Codex stdout ended before completion/ : /stdout ended before session completion/],
    ['open stdout without terminal event', 'incomplete', /stdout ended before session completion/],
    ['nonzero exit', 'nonzero', /exited unsuccessfully/]
  ] as const) test(`${mode} ${name} is not success`, { timeout: 10000 }, async t => {
    if (process.platform === 'win32' && prompt === 'incomplete') { t.skip('Windows Node child stdio does not expose live-process stdout EOF reliably'); return; }
    await assert.rejects(run(prompt), pattern);
  });
  test(`${mode} cancellation is bounded`, { timeout: 10000 }, async () => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
    try { await assert.rejects(run('hang', false, controller.signal), /Cancelled/); } finally { clearTimeout(timer); }
  });
  test(`${mode} deadline is bounded`, { timeout: 10000 }, async () => {
    const out: Update[] = [];
    await assert.rejects(runAdapter({ ...task('hang'), mode }, { mode, binary: process.execPath, extraArgs: [fixture], cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 2000 }, async u => { out.push(u); }, new AbortController().signal), /deadline exceeded/);
  });
}
test('missing binary reports startup failure', async () => {
  await assert.rejects(runAdapter(task(), { mode: 'pi', binary: '/nonexistent/protocol-fixture', cwd: process.cwd(), dataDir: '.wrangler/adapter-test', timeoutMs: 3000 }, async () => {}, new AbortController().signal), /could not start/);
});
