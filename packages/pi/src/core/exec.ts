import { spawn } from "node:child_process";
import type { ExecResult, ExecTarget, RunOptions } from "./types.js";

export class ExecError extends Error {
  constructor(readonly result: ExecResult) {
    super(
      `command failed (exit ${result.code}): ${result.argv.join(" ")}` +
        (result.stderr.trim() ? `\n${result.stderr.trim()}` : ""),
    );
    this.name = "ExecError";
  }
}

export function describeTarget(target: ExecTarget): string {
  return target.kind === "container" ? `container ${target.containerName}` : "host";
}

/** Validate a target before anything is executed against it. */
export function assertTarget(target: ExecTarget): void {
  if (target.kind === "container" && !target.containerName) {
    throw new Error("container target requires a container name (--container=<name>)");
  }
}

function isRoot(): boolean {
  // getuid is absent on Windows; treat that as "not root, and no sudo either".
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  return typeof getuid === "function" ? getuid.call(process) === 0 : false;
}

/**
 * Turn an argv into the argv that actually runs, given the target.
 *
 * host      → the command itself (optionally sudo-prefixed)
 * container → docker exec [-u user] <name> <command>
 */
export function wrap(target: ExecTarget, argv: string[], opts: RunOptions = {}): string[] {
  assertTarget(target);
  if (argv.length === 0) throw new Error("empty command");

  if (target.kind === "container") {
    const flags = opts.user ? ["-u", opts.user] : [];
    return ["docker", "exec", ...flags, target.containerName as string, ...argv];
  }

  if (opts.sudo && !isRoot() && process.platform !== "win32") {
    return ["sudo", "-n", ...argv];
  }
  return argv;
}

export interface RunnerOptions {
  dryRun?: boolean;
  verbose?: boolean;
  onCommand?: (argv: string[], dryRun: boolean) => void;
}

/** Commands that only read state, so they still run under --dry-run. */
const READ_ONLY = new Set([
  "test", "which", "command", "dpkg", "dpkg-query", "ls", "cat", "docker-version",
  "uname", "readlink", "stat", "pkg-config", "ldconfig", "id", "true",
]);

function isReadOnly(argv: string[]): boolean {
  const head = argv[0];
  if (!head) return false;
  if (head === "docker") {
    const sub = argv[1];
    return sub === "inspect" || sub === "ps" || sub === "version" || sub === "info" ||
      sub === "volume" && argv[2] === "inspect" || sub === "image" && argv[2] === "inspect";
  }
  if (head === "sh" || head === "bash") {
    // `sh -c "<script>"` — inspect the first word of the script.
    const script = argv[argv.length - 1] ?? "";
    const first = script.trim().split(/\s+/)[0] ?? "";
    return READ_ONLY.has(first);
  }
  return READ_ONLY.has(head);
}

/**
 * Build a run() bound to a set of runner options (dry-run, verbosity).
 * Extensions receive this through PluginContext and never spawn directly.
 */
export function createRunner(runnerOpts: RunnerOptions = {}) {
  return async function run(
    target: ExecTarget,
    argv: string[],
    opts: RunOptions = {},
  ): Promise<ExecResult> {
    const finalArgv = wrap(target, argv, opts);
    // Probes still run under --dry-run: a rehearsal that cannot see the
    // target's real state would report nonsense.
    const mutating = opts.readOnly === true ? false : !isReadOnly(argv);

    runnerOpts.onCommand?.(finalArgv, runnerOpts.dryRun === true && mutating);

    if (runnerOpts.dryRun && mutating) {
      return { code: 0, stdout: "", stderr: "", argv: finalArgv };
    }

    const [cmd, ...args] = finalArgv as [string, ...string[]];
    const stream = opts.stream ?? runnerOpts.verbose === true;

    const result = await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: { ...process.env, ...(opts.env ?? {}), DEBIAN_FRONTEND: "noninteractive" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          child.kill("SIGKILL");
        },
        opts.timeoutMs ?? 15 * 60_000,
      );

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (stream) process.stderr.write(d);
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
        if (stream) process.stderr.write(d);
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === "ENOENT") {
          resolve({ code: 127, stdout, stderr: `${cmd}: not found`, argv: finalArgv });
        } else {
          reject(err);
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) stderr += "\n[pi] command timed out and was killed";
        resolve({ code: code ?? 1, stdout, stderr, argv: finalArgv });
      });
    });

    if (result.code !== 0 && !opts.allowFailure) throw new ExecError(result);
    return result;
  };
}

/**
 * Fail early, and in plain words, when a container target is not usable.
 * Without this every probe just fails and the extension reports "not
 * installed", which sends people looking in the wrong place.
 */
export async function assertReachable(
  run: (target: ExecTarget, argv: string[], opts?: RunOptions) => Promise<ExecResult>,
  target: ExecTarget,
): Promise<void> {
  assertTarget(target);
  if (target.kind !== "container") return;
  const name = target.containerName as string;

  const res = await run({ kind: "host" }, ["docker", "inspect", "-f", "{{.State.Running}}", name], {
    allowFailure: true,
    readOnly: true,
  });

  const stderr = res.stderr.toLowerCase();
  const firstLine = res.stderr.trim().split(/\r?\n/)[0] ?? "";

  if (res.code === 127 || stderr.includes("not found")) {
    throw new Error(
      "docker is not available on this machine, so pi cannot reach a container target.\n" +
        "  install it first:  pi install docker-ext",
    );
  }
  if (stderr.includes("cannot connect") || stderr.includes("permission denied")) {
    throw new Error(
      `cannot talk to the docker daemon: ${firstLine}\n` +
        "  check that it is running and that your user may use it (docker ps).",
    );
  }
  if (res.code !== 0) {
    throw new Error(
      `no container named "${name}" on this machine.\n  see what is there:  docker ps -a`,
    );
  }
  if (res.stdout.trim() !== "true") {
    throw new Error(
      `container "${name}" exists but is not running, so pi cannot exec into it.\n` +
        `  start it:  docker start ${name}`,
    );
  }
}

/** Convenience: did this command succeed? Never throws. */
export async function succeeds(
  run: (target: ExecTarget, argv: string[], opts?: RunOptions) => Promise<ExecResult>,
  target: ExecTarget,
  argv: string[],
  opts: RunOptions = {},
): Promise<boolean> {
  const res = await run(target, argv, { readOnly: true, ...opts, allowFailure: true });
  return res.code === 0;
}
