import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordFromResult, writeUsageRecord } from "./usage-log.ts";

const base = {
  ts: "2026-01-01T00:00:00.000Z",
  model: "claude-haiku-5-5",
  appendChars: 10,
  schemaChars: 20,
  toolDefChars: 30,
  tools: 4,
  historyMessages: 2,
};

test("usage record maps the result event fields", () => {
  const rec = recordFromResult(
    {
      num_turns: 2,
      duration_ms: 1234,
      total_cost_usd: 0.01,
      usage: { input_tokens: 3, cache_creation_input_tokens: 400, cache_read_input_tokens: 5000, output_tokens: 60 },
    },
    base,
  );
  assert.equal(rec.apiTurns, 2);
  assert.equal(rec.cacheRead, 5000);
  assert.equal(rec.cacheWrite, 400);
  assert.equal(rec.output, 60);
  assert.equal(rec.costUsd, 0.01);
});

test("usage log is opt-in and appends one JSON line per record", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-log-test-"));
  try {
    const file = join(dir, "u.jsonl");
    writeUsageRecord(recordFromResult({}, base), undefined);
    writeUsageRecord(recordFromResult({ num_turns: 1 }, base), file);
    writeUsageRecord(recordFromResult({ num_turns: 2 }, base), file);
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.apiTurns), [1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable usage log path never throws", () => {
  assert.doesNotThrow(() => writeUsageRecord(recordFromResult({}, base), "/nonexistent-dir/x/u.jsonl"));
});
