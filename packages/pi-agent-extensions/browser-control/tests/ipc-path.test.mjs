import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultSocketPath, resolveSocketPath } from "../native-host/ipc-path.mjs";
import { startBroker } from "../native-host/bridge-host.mjs";

test("default IPC endpoint is deterministic and per-user", () => {
  const path = defaultSocketPath();
  if (process.platform === "win32") assert.match(path, /^\\\\\.\\pipe\\pi-browser-bridge-[a-f0-9]{32}$/);
  else {
    const uid = process.getuid();
    assert.equal(path, join(process.env.XDG_RUNTIME_DIR || "/tmp", `pi-browser-bridge-${uid}.sock`));
  }
});

test("Windows production broker refuses the unsecured Node named-pipe default", async () => {
  if (process.platform !== "win32") return;
  await assert.rejects(startBroker(defaultSocketPath()), /cannot apply the required current-user named-pipe DACL/i);
});

test("explicit and test override paths take precedence", () => {
  const envBefore = process.env.PI_BROWSER_BRIDGE_SOCKET;
  const testModeBefore = process.env.PI_BROWSER_BRIDGE_TEST_MODE;
  process.env.PI_BROWSER_BRIDGE_SOCKET = process.platform === "win32" ? "\\\\.\\pipe\\fixture" : "/tmp/fixture.sock";
  process.env.PI_BROWSER_BRIDGE_TEST_MODE = "1";
  try {
    assert.equal(resolveSocketPath(), process.env.PI_BROWSER_BRIDGE_SOCKET);
    const explicit = process.platform === "win32" ? "\\\\.\\pipe\\explicit" : "/tmp/explicit.sock";
    assert.equal(resolveSocketPath(explicit), explicit);
    process.env.PI_BROWSER_BRIDGE_TEST_MODE = "0";
    assert.throws(() => resolveSocketPath(), /test-only/i);
  } finally {
    if (envBefore === undefined) delete process.env.PI_BROWSER_BRIDGE_SOCKET;
    else process.env.PI_BROWSER_BRIDGE_SOCKET = envBefore;
    if (testModeBefore === undefined) delete process.env.PI_BROWSER_BRIDGE_TEST_MODE;
    else process.env.PI_BROWSER_BRIDGE_TEST_MODE = testModeBefore;
  }
});
