import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { JsonLines, delta, runAdapter } from '../src/agent/adapters';
import type { Task, Update } from '../src/protocol';
const fixture = resolve('test/fixtures/protocol-agent.mjs');
const task = (prompt = 'test', resume = false): Task => ({ id: 'fixture', agent: 'pi', prompt, text: '', status: 'running', mode: 'pi', error: '', session_id: '709de4b8-04c9-439f-87ca-b93ff49a5f80', worker_id: 'fixture', lease: 0, seq: 0, created: 0, resume });
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
  await runAdapter(task(), { mode, binary: fixture, cwd: process.cwd(), dataDir: '.wrangler/adapter-test' }, async u => { out.push(u); }, new AbortController().signal);
  assert.equal(out[0].kind, 'session');
  const text = out.filter(u => u.kind === 'delta').map(u => u.text).join('');
  assert.equal(text, mode === 'pi' ? 'Pi fixture Δ\u2028text after retry' : 'Claude fixture');
});
test('Claude fixture resumes explicit session', async () => {
  let text = '';
  await runAdapter(task('test', true), { mode: 'claude', binary: fixture, cwd: process.cwd(), dataDir: '.wrangler/adapter-test' }, async u => { if (u.kind === 'delta') text += u.text; }, new AbortController().signal);
  assert.equal(text, 'Claude resumed');
});
for (const prompt of ['error','exit']) test(`Claude fixture ${prompt} is not success`, async () => {
  await assert.rejects(runAdapter(task(prompt), { mode: 'claude', binary: fixture, cwd: process.cwd(), dataDir: '.wrangler/adapter-test' }, async () => {}, new AbortController().signal));
});
test('subprocess cancellation terminates a hanging fixture', async () => {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 150);
  try { await assert.rejects(runAdapter(task('hang'), { mode: 'claude', binary: fixture, cwd: process.cwd(), dataDir: '.wrangler/adapter-test' }, async () => {}, controller.signal), /Cancelled/); }
  finally { clearTimeout(timer); }
});
test('missing binary reports startup failure', async () => {
  await assert.rejects(runAdapter(task(), { mode: 'pi', binary: '/nonexistent/protocol-fixture', cwd: process.cwd(), dataDir: '.wrangler/adapter-test' }, async () => {}, new AbortController().signal), /could not start/);
});
