import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { prompt } from "../md.ts";

test("shared response rules are extractable and preserve necessary detail", () => {
  const rules = prompt("rules.md", "response-rules");
  assert.ok(rules.startsWith("# Response rules"));
  assert.match(rules, /unless the user asks/);
  assert.match(rules, /neutral, factual/);
  assert.match(rules, /without narrating routine/);
  assert.match(rules, /required confirmation/);
  assert.match(rules, /truncate code\/data/);
  assert.ok(prompt("rules.md", "job-rules").startsWith("# Core job rules"));
  assert.ok(prompt("rules.md", "file-policy").startsWith("## File mutation policy"));
});

test("core includes response rules in its per-run system prompt without a model filter", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /RESPONSE_RULES_HEADING = "response-rules"/);
  assert.match(source, /rules: \[prompt\(RULES_FILE, JOB_RULES_HEADING\), prompt\(RULES_FILE, RESPONSE_RULES_HEADING\)\]/);
  assert.match(source, /BEFORE_AGENT_START[\s\S]*?cfg = loadConfig\(\);[\s\S]*?systemPrompt:.*cfg\.rules/);
});
