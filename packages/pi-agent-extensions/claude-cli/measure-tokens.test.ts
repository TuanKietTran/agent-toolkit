import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SCENARIO_PROMPT, SCENARIO_STEPS, collectTurns, createScratchRepo, renderReport, totals, verifyScratchRepo } from "./scripts/measure-tokens.mjs";

const line = (message: unknown) => JSON.stringify({ type: "message_end", message });

test("scenario is about ten steps and ends without a tool call", () => {
  assert.equal(SCENARIO_STEPS.length, 10);
  assert.match(SCENARIO_PROMPT, /10\. Reply with a one-line summary/);
});

test("collectTurns keeps only assistant turns and reads Pi usage", () => {
  const turns = collectTurns([
    line({ role: "user", content: [{ type: "text", text: "hi" }] }),
    line({
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: {} }],
      usage: { input: 4, output: 100, cacheRead: 8000, cacheWrite: 400, cost: { total: 0.002 } },
    }),
    "not json",
    line({ role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 2, output: 7, cacheRead: 9000, cacheWrite: 0, cost: { total: 0.001 } } }),
  ]);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0].tools, ["read"]);
  const t = totals(turns);
  assert.equal(t.toolCalls, 1);
  assert.equal(t.cacheRead, 17000);
  assert.equal(t.output, 107);
  assert.ok(Math.abs(t.costUsd - 0.003) < 1e-9);
});

test("report lists per-turn rows, totals and per-tool-call figures", () => {
  const turns = collectTurns([line({ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } })]);
  turns[0].wallMs = 2000;
  const report = renderReport("x", "m", [{ code: 0, turns, totals: totals(turns) }]);
  assert.match(report, /\| 1 \| bash \| 1 \| 4 \| 3 \| 2 \|/);
  assert.match(report, /Per tool call: all tokens 10/);
});

test("scratch repo is a git repo with the buggy file and a failing test", () => {
  const dir = createScratchRepo();
  try {
    assert.ok(existsSync(join(dir, ".git")));
    assert.match(readFileSync(join(dir, "src/calc.js"), "utf8"), /a - b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification fails on a fresh scratch repo and passes once the steps are done", () => {
  const dir = createScratchRepo();
  try {
    assert.deepEqual(verifyScratchRepo(dir), { editApplied: false, notesWritten: false, testsPass: false });
    writeFileSync(join(dir, "src/calc.js"), "export function add(a, b) {\n  return a + b;\n}\nexport function mul(a, b) {\n  return a * b;\n}\n");
    writeFileSync(join(dir, "notes.txt"), "fixed add().\n");
    assert.deepEqual(verifyScratchRepo(dir), { editApplied: true, notesWritten: true, testsPass: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
