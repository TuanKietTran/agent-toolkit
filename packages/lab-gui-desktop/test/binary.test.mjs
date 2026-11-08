import assert from "node:assert/strict";
import test from "node:test";
import { binaryName, extraDirs, findLabBinary, labEnv } from "../lib/binary.mjs";

const has = (...paths) => (p) => paths.includes(p);

test("macOS and Linux: PATH first, then the places a Finder-launched app does not see", () => {
  const home = "/home/u";
  assert.equal(findLabBinary({ platform: "darwin", home, env: { PATH: "/usr/bin:/bin" }, exists: has("/home/u/.cargo/bin/h1") }), "/home/u/.cargo/bin/h1");
  assert.equal(findLabBinary({ platform: "darwin", home, env: { PATH: "/opt/x" }, exists: has("/opt/x/h1", "/home/u/.cargo/bin/h1") }), "/opt/x/h1");
  assert.equal(findLabBinary({ platform: "darwin", home, env: { PATH: "" }, exists: has("/opt/homebrew/bin/h1") }), "/opt/homebrew/bin/h1");
  assert.equal(findLabBinary({ platform: "darwin", home, env: {}, exists: () => false }), null);
});

test("Windows: .exe names, backslash paths, cargo and per-user install folders", () => {
  assert.equal(binaryName("win32"), "h1.exe");
  const env = { Path: "C:\\Windows;C:\\Tools", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  const dirs = extraDirs({ platform: "win32", home: "C:\\Users\\u", env });
  assert.deepEqual(dirs, ["C:\\Users\\u\\.cargo\\bin", "C:\\Users\\u\\AppData\\Local\\Programs\\h1"]);
  assert.equal(findLabBinary({ platform: "win32", home: "C:\\Users\\u", env, exists: has("C:\\Tools\\h1.exe") }), "C:\\Tools\\h1.exe");
  assert.equal(findLabBinary({ platform: "win32", home: "C:\\Users\\u", env, exists: has("C:\\Users\\u\\.cargo\\bin\\h1.exe") }), "C:\\Users\\u\\.cargo\\bin\\h1.exe");
});

test("H1_BIN wins, and a wrong path is reported as not found rather than silently ignored", () => {
  assert.equal(findLabBinary({ platform: "darwin", env: { H1_BIN: "/x/lab", PATH: "/usr/bin" }, exists: has("/x/lab", "/usr/bin/h1") }), "/x/lab");
  assert.equal(findLabBinary({ platform: "darwin", env: { H1_BIN: "/nope", PATH: "/usr/bin" }, exists: has("/usr/bin/h1") }), null);
});

test("labEnv widens PATH once, keeps the rest, and uses the Windows spelling when that is what is set", () => {
  const e = labEnv({ platform: "darwin", home: "/h", env: { PATH: "/usr/bin:/opt/homebrew/bin", FOO: "1" } });
  assert.equal(e.FOO, "1");
  assert.deepEqual(e.PATH.split(":"), ["/usr/bin", "/opt/homebrew/bin", "/h/.local/bin", "/h/.cargo/bin", "/usr/local/bin", "/usr/bin"].filter((d, i, a) => a.indexOf(d) === i));
  const w = labEnv({ platform: "win32", home: "C:\\Users\\u", env: { Path: "C:\\Windows" } });
  assert.ok(w.Path.startsWith("C:\\Windows;") && w.Path.includes(".cargo"));
  assert.equal(w.PATH, undefined);
});
