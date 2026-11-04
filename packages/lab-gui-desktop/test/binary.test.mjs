import assert from "node:assert/strict";
import test from "node:test";
import { binaryName, extraDirs, findLabBinary, labEnv } from "../lib/binary.mjs";

const has = (...paths) => (p) => paths.includes(p);

test("macOS and Linux: PATH first, then the places a Finder-launched app does not see", () => {
  const home = "/home/u";
  assert.equal(findLabBinary({ platform: "darwin", home, env: { PATH: "/usr/bin:/bin" }, exists: has("/home/u/.cargo/bin/agent-cli-lab") }), "/home/u/.cargo/bin/agent-cli-lab");
  assert.equal(findLabBinary({ platform: "darwin", home, env: { PATH: "/opt/x" }, exists: has("/opt/x/agent-cli-lab", "/home/u/.cargo/bin/agent-cli-lab") }), "/opt/x/agent-cli-lab");
  assert.equal(findLabBinary({ platform: "darwin", home, env: { PATH: "" }, exists: has("/opt/homebrew/bin/agent-cli-lab") }), "/opt/homebrew/bin/agent-cli-lab");
  assert.equal(findLabBinary({ platform: "darwin", home, env: {}, exists: () => false }), null);
});

test("Windows: .exe names, backslash paths, cargo and per-user install folders", () => {
  assert.equal(binaryName("win32"), "agent-cli-lab.exe");
  const env = { Path: "C:\\Windows;C:\\Tools", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  const dirs = extraDirs({ platform: "win32", home: "C:\\Users\\u", env });
  assert.deepEqual(dirs, ["C:\\Users\\u\\.cargo\\bin", "C:\\Users\\u\\AppData\\Local\\Programs\\agent-cli-lab"]);
  assert.equal(findLabBinary({ platform: "win32", home: "C:\\Users\\u", env, exists: has("C:\\Tools\\agent-cli-lab.exe") }), "C:\\Tools\\agent-cli-lab.exe");
  assert.equal(findLabBinary({ platform: "win32", home: "C:\\Users\\u", env, exists: has("C:\\Users\\u\\.cargo\\bin\\agent-cli-lab.exe") }), "C:\\Users\\u\\.cargo\\bin\\agent-cli-lab.exe");
});

test("AGENT_CLI_LAB_BIN wins, and a wrong path is reported as not found rather than silently ignored", () => {
  assert.equal(findLabBinary({ platform: "darwin", env: { AGENT_CLI_LAB_BIN: "/x/lab", PATH: "/usr/bin" }, exists: has("/x/lab", "/usr/bin/agent-cli-lab") }), "/x/lab");
  assert.equal(findLabBinary({ platform: "darwin", env: { AGENT_CLI_LAB_BIN: "/nope", PATH: "/usr/bin" }, exists: has("/usr/bin/agent-cli-lab") }), null);
});

test("labEnv widens PATH once, keeps the rest, and uses the Windows spelling when that is what is set", () => {
  const e = labEnv({ platform: "darwin", home: "/h", env: { PATH: "/usr/bin:/opt/homebrew/bin", FOO: "1" } });
  assert.equal(e.FOO, "1");
  assert.deepEqual(e.PATH.split(":"), ["/usr/bin", "/opt/homebrew/bin", "/h/.local/bin", "/h/.cargo/bin", "/usr/local/bin", "/usr/bin"].filter((d, i, a) => a.indexOf(d) === i));
  const w = labEnv({ platform: "win32", home: "C:\\Users\\u", env: { Path: "C:\\Windows" } });
  assert.ok(w.Path.startsWith("C:\\Windows;") && w.Path.includes(".cargo"));
  assert.equal(w.PATH, undefined);
});
