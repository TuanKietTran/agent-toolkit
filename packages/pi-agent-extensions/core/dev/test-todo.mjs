#!/usr/bin/env node
// End-to-end harness: loads core/todo.ts through Pi's own jiti + aliases and
// drives it with a fake ExtensionAPI that mirrors the host contracts it uses.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLoader } from "./pi-root.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const jiti = await createLoader(import.meta.url);
const todoPanel = await jiti.import(join(here, "..", "todo.ts"), { default: true });
const handoffModule = await jiti.import(join(here, "..", "handoff.ts"));

const theme = { fg: (_c, t) => t, bold: (t) => t, strikethrough: (t) => `~${t}~` };

function host(branch = []) {
  const h = { handlers: {}, tools: {}, commands: {}, shortcuts: [], branch, widget: undefined, status: undefined, notes: [], overlay: undefined };
  const api = {
    on: (event, fn) => ((h.handlers[event] ??= []).push(fn), () => {}),
    registerTool: (tool) => (h.tools[tool.name] = tool),
    registerCommand: (name, cmd) => (h.commands[name] = cmd),
    registerShortcut: (key, opts) => h.shortcuts.push({ key, ...opts }),
    appendEntry: (customType, data) => h.branch.push({ type: "custom", customType, data: structuredClone(data) }),
  };
  h.ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => h.branch },
    ui: {
      theme,
      setWidget: (key, lines, opts) => (h.widget = lines && { key, lines, opts }),
      setStatus: (key, text) => (h.status = text),
      notify: (msg, level) => h.notes.push({ msg, level }),
      custom: (factory, opts) => new Promise((done) => {
        h.overlay = { component: factory({ requestRender() {} }, theme, {}, done), opts };
      }),
    },
  };
  h.emit = async (event, payload = {}) => {
    let result;
    for (const fn of h.handlers[event] ?? []) {
      const next = await fn({ type: event, ...payload }, h.ctx);
      if (next) result = result ? { ...result, ...next } : next;
    }
    return result;
  };
  h.tool = (params) => h.tools.todo.execute("call", params, undefined, undefined, h.ctx);
  h.cmd = (args) => h.commands.todo.handler(args, h.ctx);
  h.order = () => h.lastState().todos.map((t) => t.id);
  h.lastState = () => h.branch.filter((e) => e.customType === "todo-panel-state").at(-1).data;
  todoPanel(api);
  handoffModule.default(api);
  return h;
}

const settle = (h, outcome = "completed") => h.emit("agent_before_settle", { outcome, entries: [], continue: false, context: { canContinue: true } });

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

await test("registers tool, command, shortcut", async () => {
  const h = host();
  assert.ok(h.tools.todo && h.commands.todo);
  assert.equal(h.shortcuts[0].key, "ctrl+shift+t");
  await h.emit("session_start");
  assert.equal(h.widget, undefined, "empty queue hides the panel widget");
});

await test("agent adds todos; right-panel widget and status update", async () => {
  const h = host();
  await h.emit("session_start");
  const res = await h.tool({ action: "add", items: ["one", "two"], text: "three" });
  assert.match(res.content[0].text, /Added #1, #2, #3/);
  assert.equal(h.widget.opts.placement, "aboveEditor");
  assert.match(h.widget.lines[0], /Todos 3\/3/);
  assert.equal(h.status, "☑ 3");
  await assert.rejects(h.tool({ action: "add", items: ["  "] }));
  await assert.rejects(h.tool({ action: "done", id: 99 }), /not found/);
});

const prompt = (h) => h.emit("before_agent_start", { prompt: "x" });

await test("queue snapshot is sent only when the model has not seen it", async () => {
  const h = host();
  await h.emit("session_start");
  assert.equal(await prompt(h), undefined, "empty queue adds nothing to the history");
  await h.cmd("add alpha");
  await h.cmd("add beta");
  const { message } = await prompt(h);
  assert.equal(message.display, false);
  assert.equal(message.content, '<todo_queue open="2" auto_feed="on">\n#1 [pending] alpha\n#2 [pending] beta\n</todo_queue>');
  assert.equal(await prompt(h), undefined, "an unchanged queue is not repeated");

  await h.tool({ action: "add", text: "gamma" });
  await h.tool({ action: "start", id: 1 });
  assert.equal(await prompt(h), undefined, "the model's own changes come back in tool results, not a snapshot");

  await h.cmd("move 3 1");
  const moved = await prompt(h);
  assert.match(moved.message.content, /#3 \[pending\] gamma\n#1 \[in_progress\] alpha\n#2 \[pending\] beta/);
  assert.equal(await prompt(h), undefined);

  await h.cmd("auto off");
  assert.match((await prompt(h)).message.content, /auto_feed="off"/);
});

await test("a human edit made while the model works is not marked as seen", async () => {
  const h = host();
  await h.emit("session_start");
  await h.tool({ action: "add", items: ["a", "b"] });
  assert.equal(await prompt(h), undefined, "the model made the queue, so it knows it");
  await h.cmd("add from the human");
  await h.tool({ action: "start", id: 1 });
  const { message } = await prompt(h);
  assert.match(message.content, /#3 \[pending\] from the human/);
  assert.match(message.content, /#1 \[in_progress\] a/);
});

await test("queue is shown again after compaction, resume and tree navigation; emptied queues are announced once", async () => {
  const h = host();
  await h.emit("session_start");
  await h.cmd("add a");
  await prompt(h);
  for (const event of ["session_compact", "session_start", "session_tree"]) {
    await h.emit(event);
    assert.match((await prompt(h)).message.content, /#1 \[pending\] a/, `after ${event}`);
    assert.equal(await prompt(h), undefined);
  }
  await h.cmd("remove 1");
  assert.equal((await prompt(h)).message.content, '<todo_queue open="0"/>');
  assert.equal(await prompt(h), undefined);
});

await test("a queue the model finished itself is cleared without another message", async () => {
  const h = host();
  await h.emit("session_start");
  await h.tool({ action: "add", items: ["a", "b"] });
  await h.tool({ action: "done", id: 1 });
  await h.tool({ action: "done", id: 2 });
  await h.emit("agent_settled");
  assert.deepEqual(h.order(), []);
  assert.equal(await prompt(h), undefined);
});

await test("tool results are compact; list returns the whole queue; snapshot is capped", async () => {
  const h = host();
  await h.emit("session_start");
  assert.equal((await h.tool({ action: "add", items: ["a", "b", "c"] })).content[0].text, "Added #1, #2, #3 (3 open)");
  assert.equal((await h.tool({ action: "start", id: 1 })).content[0].text, "Started #1 (3 open)");
  assert.equal((await h.tool({ action: "done", id: 1 })).content[0].text, "Completed #1 (2 open)");
  assert.equal((await h.tool({ action: "list" })).content[0].text, "3 todo(s)\n1. [done] #1 a\n2. [pending] #2 b\n3. [pending] #3 c");
  await h.cmd("add d");
  assert.equal((await prompt(h)).message.content.endsWith("#3 [pending] c\n#4 [pending] d\n(+1 done)\n</todo_queue>"), true, "done items are only counted");

  const big = host();
  await big.emit("session_start");
  await big.tool({ action: "add", items: Array.from({ length: 45 }, (_, i) => `item ${i}`) });
  await big.cmd("add human item");
  const lines = (await prompt(big)).message.content.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("#")).length, 40);
  assert.ok(lines.includes("… 6 more open"));
});

await test("handoff resumes into the next prompt and nudges when stale", async () => {
  const h = host();
  await h.emit("session_start");
  await h.tools.handoff.execute("call", { field: "goal", items: ["ship the fix"] }, undefined, undefined, h.ctx);
  const resumed = await h.emit("before_agent_start", { systemPrompt: "base" });
  assert.match(resumed.message.content, /ship the fix/);
  assert.equal(resumed.systemPrompt, undefined, "the summary never touches the cached system prompt");
  assert.equal(await h.emit("before_agent_start", { systemPrompt: "base" }), undefined, "an unchanged summary is not sent twice");
  await h.emit("session_compact");
  assert.match((await h.emit("before_agent_start", { systemPrompt: "base" })).message.content, /ship the fix/, "sent again after compaction");
  for (let i = 0; i < 5; i++) await h.emit("agent_start");
  assert.match(handoffModule.handoffNudge(), /turns old/);
  await h.tools.handoff.execute("call", { field: "verification", items: ["test passed"] }, undefined, undefined, h.ctx);
  assert.equal(handoffModule.handoffNudge(), undefined);
});

await test("auto-continues with next unfinished todo and stops without progress", async () => {
  const h = host();
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.tool({ action: "add", items: ["a", "b"] });
  let r = await settle(h);
  assert.equal(r.continue, true);
  assert.match(r.entries[0].content, /#1: a/);
  r = await settle(h);
  assert.equal(r, undefined, "no queue progress pauses auto-feed");
  assert.match(h.notes.at(-1).msg, /no queue progress/);
  await h.tool({ action: "start", id: 1 });
  await h.tool({ action: "done", id: 1 });
  r = await settle(h);
  assert.match(r.entries[0].content, /#2: b/);
  await h.tool({ action: "done", id: 2 });
  assert.equal(await settle(h), undefined, "empty open queue ends the run");
  assert.equal(await settle(h, "aborted"), undefined);
});

await test("in_progress item is preferred over earlier pending items", async () => {
  const h = host();
  await h.emit("session_start");
  await h.tool({ action: "add", items: ["a", "b"] });
  await h.tool({ action: "start", id: 2 });
  assert.match((await settle(h)).entries[0].content, /#2: b/);
});

await test("human reordering drives the next auto-continue", async () => {
  const h = host();
  await h.emit("session_start");
  await h.tool({ action: "add", items: ["a", "b", "c"] });
  await h.cmd("move 3 1");
  assert.deepEqual(h.order(), [3, 1, 2]);
  assert.match((await settle(h)).entries[0].content, /#3: c/);
  await h.cmd("move 3 9");
  assert.match(h.notes.at(-1).msg, /Usage: \/todo move/);
  await h.cmd("add human task");
  assert.equal(h.lastState().todos.at(-1).source, "human");
  await h.cmd("done 1");
  await h.cmd("remove 2");
  await h.cmd("clear-done");
  assert.deepEqual(h.order(), [3, 4]);
});

await test("auto-feed off stops continuation", async () => {
  const h = host();
  await h.emit("session_start");
  await h.tool({ action: "add", text: "a" });
  await h.cmd("auto off");
  assert.equal(await settle(h), undefined);
  const { message } = await h.emit("before_agent_start", { prompt: "x" });
  assert.match(message.content, /auto_feed="off"/);
});

await test("interactive manager reorders, cycles status, deletes, toggles auto", async () => {
  const h = host();
  await h.emit("session_start");
  await h.tool({ action: "add", items: ["a", "b", "c"] });
  const closed = h.cmd("");
  const m = h.overlay.component;
  assert.equal(h.overlay.opts.overlay, true);
  assert.match(m.render(60).join("\n"), /› ○ #1 a/);
  m.handleInput("J");
  m.handleInput("J");
  assert.deepEqual(h.order(), [2, 3, 1]);
  m.handleInput("K");
  assert.deepEqual(h.order(), [2, 1, 3]);
  m.handleInput(" ");
  assert.equal(h.lastState().todos[1].status, "in_progress");
  m.handleInput(" ");
  assert.equal(h.lastState().todos[1].status, "done");
  m.handleInput("k");
  m.handleInput("x");
  assert.deepEqual(h.order(), [1, 3]);
  m.handleInput("f");
  assert.equal(h.lastState().autoFeed, false);
  for (const line of m.render(20)) assert.ok(line.replace(/\x1b\[[0-9;]*m/g, "").length <= 20);
  m.handleInput("q");
  await closed;
});

await test("state persists in the session branch and restores on resume/tree", async () => {
  const a = host();
  await a.emit("session_start");
  await a.tool({ action: "add", items: ["a", "b"] });
  await a.tool({ action: "done", id: 1 });
  await a.cmd("move 2 1");
  const b = host([...a.branch]);
  await b.emit("session_start");
  const res = await b.tool({ action: "list" });
  assert.match(res.content[0].text, /1\. \[pending\] #2 b\n2\. \[done\] #1 a/);
  await b.tool({ action: "add", text: "c" });
  assert.equal(b.lastState().todos.at(-1).id, 3, "ids continue after restore");
  b.branch.splice(0, b.branch.length, ...a.branch.slice(0, 1));
  await b.emit("session_tree");
  assert.equal((await b.tool({ action: "list" })).details.todos.length, 2, "tree navigation restores that branch's queue");
});

await test("fully done queue auto-clears; agent clear drops done items", async () => {
  const h = host();
  await h.emit("session_start");
  await h.tool({ action: "add", items: ["a", "b", "c"] });
  await h.tool({ action: "done", id: 1 });
  const res = await h.tool({ action: "clear" });
  assert.match(res.content[0].text, /Cleared 1 done/);
  assert.deepEqual(h.order(), [2, 3]);
  await h.tool({ action: "done", id: 2 });
  await h.emit("agent_settled");
  assert.deepEqual(h.order(), [2, 3], "open work is kept");
  await h.tool({ action: "done", id: 3 });
  await h.emit("agent_settled");
  assert.deepEqual(h.order(), []);
  assert.equal(h.widget, undefined, "panel hides once cleared");

  const r = host([{ type: "custom", customType: "todo-panel-state", data: { todos: [{ id: 1, text: "x", status: "done", source: "agent" }], nextId: 2, autoFeed: true } }]);
  await r.emit("session_start");
  assert.equal(await prompt(r), undefined, "a restored all-done queue is cleared, and the model was never shown it");
  assert.deepEqual(r.order(), []);
});

console.log(`\n${passed} passed`);
