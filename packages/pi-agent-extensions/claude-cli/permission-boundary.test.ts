import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("Claude subprocess cannot forward allow/deny permission prompts to Pi", () => {
  assert.match(source, /"--permission-mode",\s*"dontAsk"/);
  assert.match(source, /"--permission-prompts",\s*"none"/);
  assert.doesNotMatch(source, /"--permission-prompts",\s*"host"/);
});
