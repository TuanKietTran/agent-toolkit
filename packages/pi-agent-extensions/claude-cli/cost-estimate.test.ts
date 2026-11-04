import assert from "node:assert/strict";
import test from "node:test";
import { estimateCostUsd } from "./cost-estimate.ts";

test("estimate matches a recorded Claude Code total for Haiku 5.5", () => {
  // From a real `claude -p` run: total_cost_usd 0.00059289
  const cost = estimateCostUsd("claude-haiku-5-5", { input: 2, cacheWrite: 2896, cacheRead: 649, output: 14 });
  assert.ok(cost !== undefined && Math.abs(cost - 0.00059289) / 0.00059289 < 0.01);
});

test("estimate matches a recorded Claude Code total for Haiku 4.5", () => {
  // total_cost_usd 0.013751
  const cost = estimateCostUsd("claude-haiku-4-5-20251001", { input: 10, cacheWrite: 6743, cacheRead: 0, output: 51 });
  assert.ok(cost !== undefined && Math.abs(cost - 0.013751) / 0.013751 < 0.01);
});

test("unknown models get no estimate rather than a guess", () => {
  assert.equal(estimateCostUsd("claude-fable-5", { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 }), undefined);
});
