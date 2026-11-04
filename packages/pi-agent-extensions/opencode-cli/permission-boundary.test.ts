import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("run never auto-approves permissions and uses a private server", () => {
  assert.doesNotMatch(source, /"--auto"/);
  assert.match(source, /"--standalone"/);
});

test("the prompt travels on stdin and stdin is closed", () => {
  assert.match(source, /proc\.stdin\.end\(promptParts\.join/);
});

test("capture stops the run at the end of the step that issued the calls", () => {
  assert.match(source, /stepFinish" && capturedCalls\.length > 0/);
  assert.match(source, /id: `opencode_cli_mcp_\$\{randomUUID\(\)\}`/);
});

test("the temp directory is created lazily, only for image attachments", () => {
  assert.doesNotMatch(source, /workDir = mkdtempSync/);
  assert.match(source, /dir \?\?= mkdtempSync\(join\(tmpdir\(\), "pi-opencode-cli-"\)\)/);
});
