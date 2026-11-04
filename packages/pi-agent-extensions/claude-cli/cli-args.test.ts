import assert from "node:assert/strict";
import test from "node:test";
import { advisorArgs } from "./cli-args.ts";

test("advisor flag is off unless the environment asks for it", () => {
  assert.deepEqual(advisorArgs({}), []);
  assert.deepEqual(advisorArgs({ PI_CLAUDE_CLI_ADVISOR: "  " }), []);
});

test("advisor model is passed through when it looks like a model name", () => {
  assert.deepEqual(advisorArgs({ PI_CLAUDE_CLI_ADVISOR: "opus" }), ["--advisor", "opus"]);
  assert.deepEqual(advisorArgs({ PI_CLAUDE_CLI_ADVISOR: "claude-opus-5-5" }), ["--advisor", "claude-opus-5-5"]);
});

test("anything that is not a plain model name is ignored", () => {
  assert.deepEqual(advisorArgs({ PI_CLAUDE_CLI_ADVISOR: "opus; rm -rf /" }), []);
  assert.deepEqual(advisorArgs({ PI_CLAUDE_CLI_ADVISOR: "--model" }), []);
});
