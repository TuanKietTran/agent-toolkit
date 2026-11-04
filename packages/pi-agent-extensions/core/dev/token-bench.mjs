#!/usr/bin/env node
// Token and prefix-cache benchmark for the core extension.
//
//   node core/dev/token-bench.mjs [--core DIR] [--against DIR] [--posix] [--json]
//
// Loads DIR/index.ts (default: this core) through pi's own jiti, drives it with a
// fake host through one scripted session, and rebuilds every provider request the
// way pi would: tools, then system prompt, then persisted history. Reports what the
// extension adds to each request and how much of the previous request stays a valid
// cache prefix. `--against DIR` runs a second core (e.g. `git archive HEAD core`)
// and prints the delta. `--posix` makes /bin/sh look present, so a Windows host still
// registers the job tools and the numbers compare with a POSIX one.
//
// Tokens are chars/4, pi's own estimator: good for comparing variants, not billing.
// Cost units model Anthropic-style caching: 0.1 for a cached prefix, 1.25 to write
// the new tail, 1.0 for prefix that fell out of cache and must be re-sent uncached.

import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN, makeHost as makeCoreHost, setShell } from "./fake-host.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const coreDir = resolve(flag("--core") ?? join(here, ".."));
const againstDir = flag("--against") && resolve(flag("--against"));
const asJson = args.includes("--json");

if (args.includes("--posix")) setShell(true);

// --- Fixed parts of every request: identical across variants, so they cancel out. ---

const BASE_SYSTEM = "You are pi, a coding agent. ".repeat(220); // ~1.6k tokens, constant
const BUILTIN_SCHEMAS = BUILTIN.map((name) => JSON.stringify({ name, description: `built-in ${name}`.repeat(12), parameters: {} }));
const COST = { cached: 0.1, write: 1.25, uncached: 1 };

const est = (s) => Math.ceil(s.length / 4);
const blob = (label, chars) => {
  let out = "";
  for (let i = 0; out.length < chars; i++) out += `${label}/src/module_${i % 97}/file_${i}.ts:${i}: line ${i} of generated tool output\n`;
  return out.slice(0, chars);
};
const lcp = (a, b) => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
};

async function makeHost(dir) {
  const h = await makeCoreHost(dir);
  return Object.assign(h, { history: [], requests: [], system: BASE_SYSTEM, seq: 0 });
}

// --- Request model. ---

function request(h) {
  const coreTools = Object.values(h.tools).map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }));
  const messages = h.history.map((m) => `${m.role}: ${m.text}`).join("\n");
  const body = `${BUILTIN_SCHEMAS.join("\n")}\n${coreTools.join("\n")}\n#SYSTEM\n${h.system}\n#MESSAGES\n${messages}`;
  const prev = h.requests.at(-1);
  const total = est(body);
  const kept = prev ? Math.min(est(body.slice(0, lcp(prev.body, body))), prev.total) : 0;
  const lost = prev ? prev.total - kept : 0;
  h.requests.push({
    body, total, kept, lost,
    coreToolsTok: est(coreTools.join("\n")),
    coreSystemTok: est(h.system) - est(BASE_SYSTEM),
    coreMsgTok: h.history.filter((m) => m.core).reduce((n, m) => n + est(m.text), 0),
    cost: prev ? kept * COST.cached + lost * COST.uncached + (total - prev.total + lost) * COST.write : total * COST.write,
  });
}

async function startPrompt(h, text) {
  let system = BASE_SYSTEM;
  const injected = [];
  for (const fn of h.handlers.before_agent_start ?? []) {
    const r = await fn({ type: "before_agent_start", prompt: text, systemPrompt: system, systemPromptOptions: { selectedTools: [...BUILTIN, ...Object.keys(h.tools)] } }, h.ctx);
    if (r?.systemPrompt !== undefined) system = r.systemPrompt;
    if (r?.message) injected.push({ role: "user", text: r.message.content, core: true });
  }
  h.system = system;
  h.history.push(...injected, { role: "user", text });
  await h.emit("agent_start");
}

const openIds = (h) => h.branch.filter((e) => e.customType === "todo-panel-state").at(-1)?.data.todos.filter((t) => t.status !== "done").map((t) => t.id) ?? [];

async function step(h, s) {
  const toolCallId = `call-${++h.seq}`;
  let call;
  let content;
  let details;
  if (s.todo) {
    const params = { action: s.todo, ...(s.params ?? {}) };
    if (s.pick === "firstOpen") params.id = openIds(h)[0];
    if (s.pick === "lastOpen") params.id = openIds(h).at(-1);
    call = { name: "todo", args: params };
    const res = await h.tools.todo.execute(toolCallId, params, undefined, undefined, h.ctx).catch((e) => {
      throw new Error(`scenario step ${JSON.stringify(s)} failed with open ids [${openIds(h)}]: ${e.message}`);
    });
    content = res.content;
    details = res.details;
  } else {
    call = { name: s.tool, args: s.args ?? {} };
    content = [{ type: "text", text: blob(s.tool, s.chars) }];
  }
  const ev = { type: "tool_result", toolName: call.name, toolCallId, input: call.args, content, details, isError: false };
  for (const fn of h.handlers.tool_result ?? []) {
    const r = await fn(ev, h.ctx);
    if (r?.content) ev.content = r.content;
  }
  h.history.push(
    { role: "assistant", text: JSON.stringify({ tool_call: call }) },
    { role: "tool", text: ev.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), core: call.name === "todo" },
  );
  request(h);
}

const ANSWER = "Done. ".repeat(40);

/** One user prompt: turns, then settle; auto-feed continuations run the queued scripts. */
async function runPrompt(h, text, turns, continuations = []) {
  await startPrompt(h, text);
  request(h);
  for (const s of turns) await step(h, s);
  h.history.push({ role: "assistant", text: ANSWER });
  let queue = [...continuations];
  for (;;) {
    const r = await h.emit("agent_before_settle", { outcome: "completed", entries: [], continue: false, context: { canContinue: true } });
    if (!r?.continue || queue.length === 0) break;
    for (const e of r.entries ?? []) h.history.push({ role: "user", text: e.content, core: true });
    request(h);
    for (const s of queue.shift()) await step(h, s);
    h.history.push({ role: "assistant", text: ANSWER });
  }
  await h.emit("agent_settled");
}

const T = (tool, chars, args) => ({ tool, chars, args });
const D = (todo, extra = {}) => ({ todo, ...extra });

async function scenario(h) {
  // 1. Plan with the queue, then let auto-feed finish the remainder.
  await runPrompt(h, "Implement retry with backoff in client.ts and add tests", [
    D("add", { params: { items: ["add RetryPolicy type", "wrap fetch in client.ts", "unit tests for backoff", "update README"] } }),
    D("start", { pick: "firstOpen" }), T("read", 5200, { path: "client.ts" }), T("edit", 140),
    D("done", { pick: "firstOpen" }), D("start", { pick: "firstOpen" }),
    T("bash", 16500, { command: "ls -R" }), T("grep", 2400), T("edit", 160), D("done", { pick: "firstOpen" }),
  ], [
    [D("start", { pick: "firstOpen" }), T("read", 3000), T("write", 200), D("done", { pick: "firstOpen" })],
    [D("start", { pick: "firstOpen" }), T("bash", 4700, { command: "npm test" }), T("edit", 90), D("done", { pick: "firstOpen" })],
  ]);
  // 2. Plain Q&A with an empty queue.
  await runPrompt(h, "What does the retry config default to?", [T("grep", 1800)]);
  // 3. Another plan, left unfinished.
  await runPrompt(h, "Refactor logging in server.ts. Put the steps in the queue first.", [
    D("add", { params: { items: ["extract Logger", "replace console calls", "add log levels"] } }),
    D("start", { pick: "firstOpen" }), T("read", 9400), T("edit", 200), D("done", { pick: "firstOpen" }),
  ]);
  // 4. Human reorders and adds an item between prompts, then continues.
  await h.commands.todo.handler("move 7 1", h.ctx);
  await h.commands.todo.handler("add check the CI config", h.ctx);
  await runPrompt(h, "ok continue with the queue", [
    D("list"), D("start", { pick: "firstOpen" }), T("read", 2500), T("edit", 120), D("done", { pick: "firstOpen" }),
  ]);
  // 5-6. Questions while work is open and the queue is unchanged.
  await h.commands.todo.handler("auto off", h.ctx);
  await runPrompt(h, "quick question about the Logger type", [T("read", 1500)]);
  await runPrompt(h, "explain the last diff", [T("bash", 2200, { command: "git diff" })]);
  // 7. Finish everything.
  await runPrompt(h, "finish the remaining items", [
    D("start", { pick: "firstOpen" }), T("edit", 100), D("done", { pick: "firstOpen" }),
    D("start", { pick: "firstOpen" }), T("edit", 100), D("done", { pick: "firstOpen" }),
  ]);
  // 8. Summary with a cleared queue.
  await runPrompt(h, "thanks, summarize what changed", [T("bash", 1200, { command: "git log --stat" })]);
}

// --- Run and report. ---

async function measure(dir) {
  const h = await makeHost(dir);
  await scenario(h);
  const r = h.requests;
  const sum = (key) => r.reduce((n, x) => n + x[key], 0);
  const systems = new Set();
  // The system prompt each prompt started with; stable text means no cache break at the top.
  for (const q of r) systems.add(q.body.slice(q.body.indexOf("#SYSTEM"), q.body.indexOf("#MESSAGES")));
  const coreMsgs = h.history.filter((m) => m.core);
  return {
    dir,
    requests: r.length,
    tools: Object.keys(h.tools).join(","),
    toolTokens: Object.fromEntries(Object.values(h.tools).map((t) => [t.name, est(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }))])),
    fixedPerRequest: { coreTools: r[0].coreToolsTok, coreSystem: r[0].coreSystemTok },
    persistedCoreMessages: { count: coreMsgs.length, tokens: coreMsgs.reduce((n, m) => n + est(m.text), 0) },
    totalInputTokens: sum("total"),
    finalContextTokens: r.at(-1).total,
    prefixBreaks: r.filter((x) => x.lost > 0).length,
    prefixLostTokens: sum("lost"),
    distinctSystemPrompts: systems.size,
    costUnits: Math.round(sum("cost")),
  };
}

const main = await measure(coreDir);
const base = againstDir ? await measure(againstDir) : undefined;

if (asJson) {
  console.log(JSON.stringify({ core: main, against: base }, null, 2));
} else {
  const rows = [
    ["requests in session", "requests"],
    ["core tools registered", (m) => m.tools.split(",").length],
    ["core tool schemas / request (tok)", (m) => m.fixedPerRequest.coreTools],
    ["core system additions / request (tok)", (m) => m.fixedPerRequest.coreSystem],
    ["persisted core messages (count)", (m) => m.persistedCoreMessages.count],
    ["persisted core messages (tok)", (m) => m.persistedCoreMessages.tokens],
    ["final context size (tok)", "finalContextTokens"],
    ["total input tokens over session", "totalInputTokens"],
    ["cache-prefix breaks / tokens lost", (m) => `${m.prefixBreaks} / ${m.prefixLostTokens}`],
    ["distinct system prompts", "distinctSystemPrompts"],
    ["cache-weighted cost units", "costUnits"],
  ];
  const get = (m, k) => (typeof k === "function" ? k(m) : m[k]);
  const pad = (s, n) => String(s).padStart(n);
  console.log(`\n${"metric".padEnd(40)}${base ? pad("before", 14) + pad("after", 14) + pad("delta", 10) : pad("value", 14)}`);
  for (const [label, k] of rows) {
    const a = get(main, k);
    if (!base) { console.log(`${label.padEnd(40)}${pad(a, 14)}`); continue; }
    const b = get(base, k);
    const d = typeof a === "number" && typeof b === "number" && b !== 0 ? `${(((a - b) / b) * 100).toFixed(1)}%` : "";
    console.log(`${label.padEnd(40)}${pad(b, 14)}${pad(a, 14)}${pad(d, 10)}`);
  }
  const names = [...new Set([...Object.keys(base?.toolTokens ?? {}), ...Object.keys(main.toolTokens)])];
  console.log(`\ntool schema tokens${base ? " (before, after)" : ""}`);
  for (const name of names) console.log(`  ${name.padEnd(12)}${base ? pad(base.toolTokens[name] ?? "-", 8) : ""}${pad(main.toolTokens[name] ?? "-", 8)}`);
  console.log(base ? `\nbefore: ${base.dir}\nafter:  ${main.dir}` : `\ncore: ${main.dir}`);
}

// Invariants any version of core must keep: a static system prompt across prompts and no cache-prefix loss inside the session.
assert.equal(main.distinctSystemPrompts, 1, "system prompt must not change between prompts");
assert.equal(main.prefixBreaks, 0, "history must stay append-only");
