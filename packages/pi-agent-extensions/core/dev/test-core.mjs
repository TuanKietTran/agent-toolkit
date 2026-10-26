#!/usr/bin/env node
// Loads core/index.ts against the fake host and checks what it puts in front of the
// model: the system prompt additions, which tools exist, and that the prompt stays
// byte-identical between runs (a changing prefix throws away the provider's cache).
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN, makeHost, setShell } from "./fake-host.mjs";

const core = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "BASE SYSTEM PROMPT";
const run = (h, systemPrompt = BASE) => h.emit("before_agent_start", { prompt: "x", systemPrompt });

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
  } finally {
    setShell(undefined);
  }
  passed++;
  console.log(`ok - ${name}`);
};

await test("system prompt gets the job and todo rules, once, after the base prompt", async () => {
  setShell(true);
  const h = await makeHost(core);
  assert.deepEqual(Object.keys(h.tools).sort(), ["cancel_job", "handoff", "job_logs", "job_status", "start_job", "todo"]);
  const { systemPrompt } = await run(h);
  assert.ok(systemPrompt.startsWith(`${BASE}\n\nJobs: `));
  assert.equal(systemPrompt.match(/Jobs: /g).length, 1);
  assert.equal(systemPrompt.match(/Todos: /g).length, 1);
  assert.ok(systemPrompt.indexOf("Jobs: ") < systemPrompt.indexOf("Todos: "));
  assert.doesNotMatch(systemPrompt, /job-context|Pi's loop stays turn-based/, "the old job-context block is gone");
});

await test("system prompt additions never change between runs", async () => {
  setShell(true);
  const h = await makeHost(core);
  const first = (await run(h)).systemPrompt;
  await h.commands.todo.handler("add something", h.ctx);
  await h.tools.todo.execute("c1", { action: "add", text: "queue changes" }, undefined, undefined, h.ctx);
  assert.equal((await run(h)).systemPrompt, first, "queue state must live in the history, not the system prompt");
  assert.equal((await run(h)).systemPrompt, first);
});

await test("a block is only sent while its tool is active", async () => {
  setShell(true);
  const onlyTodo = await makeHost(core, { activeTools: () => [...BUILTIN, "todo"] });
  const todoPrompt = (await run(onlyTodo)).systemPrompt;
  assert.match(todoPrompt, /Todos: /);
  assert.doesNotMatch(todoPrompt, /Jobs: /);

  const onlyJobs = await makeHost(core, { activeTools: () => [...BUILTIN, "start_job"] });
  const jobPrompt = (await run(onlyJobs)).systemPrompt;
  assert.match(jobPrompt, /Jobs: /);
  assert.doesNotMatch(jobPrompt, /Todos: /);

  const none = await makeHost(core, { activeTools: () => [] });
  assert.equal(await run(none), undefined, "no tools, no additions, and the base prompt is left untouched");
});

await test("without a POSIX shell the job tools and job rules are left out", async () => {
  setShell(false);
  const h = await makeHost(core);
  assert.deepEqual(Object.keys(h.tools).sort(), ["handoff", "todo"]);
  assert.ok(h.commands.jobs, "/jobs stays available");
  const { systemPrompt } = await run(h);
  assert.match(systemPrompt, /Todos: /);
  assert.doesNotMatch(systemPrompt, /Jobs: |start_job/);
});

await test("the per-request cost of core stays bounded", async () => {
  setShell(true);
  const h = await makeHost(core);
  const added = (await run(h)).systemPrompt.length - BASE.length;
  const schemas = Object.values(h.tools).map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length);
  // Both are resent with every request; a regression here is paid for on every turn of every session.
  assert.ok(added / 4 < 320, `system additions are ~${Math.round(added / 4)} tokens`);
  assert.ok(schemas.reduce((a, b) => a + b, 0) / 4 < 420, "tool schemas are under ~420 tokens") // 400 plus the handoff tool (~65 tokens);
});

console.log(`\n${passed} passed`);
