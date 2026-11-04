import assert from "node:assert/strict";
import test from "node:test";
import { CliError, createCli, isValidName } from "../lib/cli.mjs";

function recorder(stdout = "[]") {
  const calls = [];
  const exec = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { stdout, stderr: "" };
  };
  return { calls, cli: createCli({ bin: "lab", env: {}, exec }) };
}

test("lab names follow the CLI's own rule", () => {
  for (const ok of ["a", "pitokens-builder", "w1.2_x"]) assert.ok(isValidName(ok), ok);
  for (const bad of ["", ".hidden", "-x", "a b", "a/b", "a;rm", "x".repeat(41), undefined, 5]) assert.ok(!isValidName(bad), String(bad));
});

test("calls are plain argv arrays, text goes after --", async () => {
  const { calls, cli } = recorder();
  await cli.send("w1", "-rf; $(whoami)", { enter: true });
  assert.deepEqual(calls[0].args, ["send", "-n", "w1", "--paced", "-e", "--", "-rf; $(whoami)"]);
  await cli.send("w1", "no enter", { enter: false });
  assert.deepEqual(calls[1].args, ["send", "-n", "w1", "--paced", "--", "no enter"]);
  await cli.stop("w1");
  assert.deepEqual(calls[2].args, ["stop", "-n", "w1"]);
  await cli.attach("w1");
  assert.deepEqual(calls[3].args, ["foreground", "-n", "w1"]);
});

test("invalid names and keys never reach the binary", async () => {
  const { calls, cli } = recorder();
  await assert.rejects(cli.stop("a;b"), (e) => e instanceof CliError && e.status === 400);
  await assert.rejects(cli.key("w1", "Ctrl-D"), (e) => e.status === 400);
  await assert.rejects(cli.send("w1", "x".repeat(20001)), (e) => e.status === 400);
  assert.equal(calls.length, 0);
  await cli.key("w1", "Enter");
  assert.deepEqual(calls[0].args, ["key", "-n", "w1", "Enter"]);
});

test("typed text cannot smuggle control keys", async () => {
  const { calls, cli } = recorder();
  for (const bad of ["\x1b[A", "a\rb", "x\x03", "nul\x00"]) await assert.rejects(cli.send("w1", bad), (e) => e.status === 400, JSON.stringify(bad));
  assert.equal(calls.length, 0);
  await cli.send("w1", "line one\nline two\tindented");
  assert.equal(calls.length, 1);
});

test("screen tail is clamped and JSON output is parsed", async () => {
  const { calls, cli } = recorder('{"lines":["x"]}');
  assert.deepEqual(await cli.screen("w1", 99999), { lines: ["x"] });
  assert.equal(calls[0].args.at(-1), "200");
  await cli.screen("w1", "junk");
  assert.equal(calls[1].args.at(-1), "40");
});

test("non-JSON output is an error, not a crash", async () => {
  const { cli } = recorder("not json");
  await assert.rejects(cli.list(), /did not print JSON/);
});
