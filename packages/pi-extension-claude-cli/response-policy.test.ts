import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { RESPONSE_POLICY, TEXT_OUTPUT_SCHEMA } from "./response-policy.ts";

test("Claude response defaults are concise but preserve requested detail and confirmation", () => {
  assert.match(RESPONSE_POLICY, /Explicit user requirements take precedence/);
  assert.match(RESPONSE_POLICY, /unless requested/);
  assert.match(RESPONSE_POLICY, /neutral, factual/);
  assert.match(RESPONSE_POLICY, /prefer empty text/);
  assert.match(RESPONSE_POLICY, /Never hide failures/);
  assert.match(RESPONSE_POLICY, /skip required confirmation/);
});

test("structured text guidance permits empty and complete answers without truncation", () => {
  assert.equal(TEXT_OUTPUT_SCHEMA.type, "string");
  assert.match(TEXT_OUTPUT_SCHEMA.description, /empty string/);
  assert.match(TEXT_OUTPUT_SCHEMA.description, /Preserve all requested details/);
  assert.ok(!("maxLength" in TEXT_OUTPUT_SCHEMA));
  assert.ok(!("minLength" in TEXT_OUTPUT_SCHEMA));
});

test("provider applies defaults after history and uses the text schema", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /text: TEXT_OUTPUT_SCHEMA/);
  assert.ok(source.indexOf("appendParts.push(createToolBridgePrompt(tools), RESPONSE_POLICY)") > source.indexOf("buildHistory(history)"));
  assert.match(source, /\{ text: "", toolCalls: capturedCalls \}/);
});
