import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

/**
 * CLI-level tests: run the real entrypoint the way a user would, and assert
 * on exit codes and the text people actually read.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "src", "cli.ts");
const fixtures = join(repo, "test", "fixtures", "exts");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function pi(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: repo,
      env: { ...process.env, NO_COLOR: "1", PI_CONFIG: join(repo, "test", "no-such-config.json"), ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test("no arguments prints help and exits 2", async () => {
  const r = await pi([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /USAGE/);
  assert.match(r.stderr, /pi <command>/);
});

test("help exits 0 and lists every command", async () => {
  const r = await pi(["help"]);
  assert.equal(r.code, 0);
  for (const cmd of ["list", "info", "check", "doctor", "install", "remove"]) {
    assert.match(r.stderr, new RegExp(`\\b${cmd}\\b`));
  }
});

test("version prints a bare version on stdout", async () => {
  const r = await pi(["--version"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("list shows the bundled extensions", async () => {
  const r = await pi(["list"]);
  assert.equal(r.code, 0);
  for (const name of ["pi-ext", "docker-ext", "zlib-ext", "ffmpeg-ext", "jellyfin-ext"]) {
    assert.match(r.stderr, new RegExp(name));
  }
});

test("list --json is valid JSON on stdout, with nothing else in the way", async () => {
  const r = await pi(["list", "--json"]);
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout) as { extensions: Array<{ name: string }>; errors: unknown[] };
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.extensions.length, 5);
});

test("info explains an extension's requirements and config", async () => {
  const r = await pi(["info", "jellyfin-ext"]);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /docker-ext, zlib-ext, ffmpeg-ext/);
  assert.match(r.stderr, /media-path/);
  assert.match(r.stderr, /required/);
});

test("an unknown extension suggests the closest name", async () => {
  const r = await pi(["check", "jellyfin"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /did you mean: jellyfin-ext/);
});

test("a command that needs an extension says so", async () => {
  const r = await pi(["install"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs an extension name/);
});

test("an unknown flag is a usage error, not a silent ignore", async () => {
  const r = await pi(["list", "--recursive"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag/);
});

test("a container target without a container name is refused", async () => {
  const r = await pi(["check", "zlib-ext", "--target=container"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--container/);
});

test("host-only extensions refuse container targets", async () => {
  const r = await pi(["check", "jellyfin-ext", "--container=whatever"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not support container targets/);
});

test("missing required config is reported with the flag that fixes it", async () => {
  const r = await pi(["install", "jellyfin-ext", "--skip-requires", "--dry-run"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing required config "media-path"/);
  assert.match(r.stderr, /--set media-path=/);
});

test("a container target that does not exist fails with one clear message", async () => {
  const r = await pi(["check", "zlib-ext", "--container=pi-nonexistent-container"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no container named|docker daemon|docker is not available/);
  // Not the misleading "zlib is not installed".
  assert.doesNotMatch(r.stderr, /is not installed on container/);
});

test("extensions outside the repo load from PI_EXTS_PATH", async () => {
  const r = await pi(["list", "--json"], { PI_EXTS_PATH: fixtures });
  const parsed = JSON.parse(r.stdout) as { extensions: Array<{ name: string }> };
  assert.ok(parsed.extensions.some((e) => e.name === "fixture-ext"));
});

test("dry run reports what it would do without doing it", async () => {
  const marker = join(tmpdir(), `pi-dryrun-${process.pid}-${Date.now()}.txt`);
  const env = { PI_EXTS_PATH: fixtures, PI_FIXTURE_EXT_MARKER: marker };

  const dry = await pi(["install", "fixture-ext", "--dry-run"], env);
  assert.equal(dry.code, 0);
  assert.match(dry.stderr, /would run/);
  assert.equal(existsSync(marker), false, "dry run must not touch the target");

  const real = await pi(["install", "fixture-ext"], env);
  assert.equal(real.code, 0);
  assert.equal(existsSync(marker), true);
  assert.match(real.stderr, /fixture-ext installed on host/);

  const again = await pi(["install", "fixture-ext"], env);
  assert.match(again.stderr, /already installed/);

  const removed = await pi(["remove", "fixture-ext", "--yes"], env);
  assert.equal(removed.code, 0);
  assert.equal(existsSync(marker), false);
});

test("config comes from the environment when no flag is given", async () => {
  const marker = join(tmpdir(), `pi-env-${process.pid}-${Date.now()}.txt`);
  const r = await pi(["check", "fixture-ext"], {
    PI_EXTS_PATH: fixtures,
    PI_FIXTURE_EXT_MARKER: marker,
  });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /not installed/);
});

test("jellyfin-ext refuses a public bind unless it is opted into", async () => {
  const r = await pi([
    "install", "jellyfin-ext", "--skip-requires", "--dry-run",
    "--set", "media-path=/tmp",
    "--set", "bind-address=0.0.0.0",
    "--set", "container-name=pi-test-nonexistent",
  ]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /every interface/);
  assert.match(r.stderr, /allow-public-bind=true/);
});

test("removing a container that is not there is a no-op, not an error", async () => {
  const r = await pi(["remove", "jellyfin-ext", "--yes", "--set", "container-name=pi-test-nonexistent"]);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /nothing to remove/);
});
