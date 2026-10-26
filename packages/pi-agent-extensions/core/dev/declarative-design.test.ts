import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRYPOINTS = [
  "core/index.ts",
  "gc-assets/index.ts",
  "thinking-control.ts",
  "usage-roundrobin.ts",
  "remote-control.ts",
  "claude-cli/index.ts",
  "cloud-admin/extensions/cloud-admin.ts",
  "macos-browser-control/extensions/macos-browser-control.ts",
  "odysseus-bridge/extensions/pi-odysseus-bridge.ts",
  "touchbar-usage/index.ts",
  "web-ui-vision/extensions/web-ui-vision.ts",
] as const;

const INLINE_EVENT = /\bpi\.on\(\s*["'`]/;
const INLINE_COMMAND = /\bpi\.registerCommand\(\s*["'`]/;

test("extension entry points use declarations for Pi registrations", () => {
  for (const relative of ENTRYPOINTS) {
    const source = readFileSync(resolve(ROOT, relative), "utf8");
    assert.doesNotMatch(source, INLINE_EVENT, `${relative} embeds a Pi event name`);
    assert.doesNotMatch(source, INLINE_COMMAND, `${relative} embeds a command name`);
  }
});
