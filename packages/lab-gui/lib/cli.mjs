// Thin wrapper over the agent-cli-lab binary. Every call is an argv array handed to execFile,
// never a shell string, and lab names are validated before they reach the command line.
import { execFile } from "node:child_process";

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,39}$/;
/** Keys the GUI may press; anything else is refused. */
export const ALLOWED_KEYS = new Set(["Enter", "Esc", "Tab", "Up", "Down", "Ctrl-C"]);

export const isValidName = (name) => typeof name === "string" && NAME_RE.test(name);

export class CliError extends Error {
  constructor(message, { status = 502, stderr = "" } = {}) {
    super(message);
    this.status = status;
    this.stderr = stderr;
  }
}

export function realExec(bin, args, { env, timeout }) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new CliError(`${args[0]} failed: ${(stderr || error.message).trim().slice(0, 300)}`, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

function assertName(name) {
  if (!isValidName(name)) throw new CliError("invalid lab name", { status: 400 });
}

/** @param {{bin?: string, env?: NodeJS.ProcessEnv, exec?: typeof realExec, timeout?: number}} options */
export function createCli({ bin = process.env.AGENT_CLI_LAB_BIN || "agent-cli-lab", env = process.env, exec = realExec, timeout = 8000 } = {}) {
  const run = (args, extra = {}) => exec(bin, args, { env, timeout, ...extra });
  const json = async (args) => {
    const { stdout } = await run(args);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new CliError(`${args[0]} did not print JSON`);
    }
  };
  return {
    list: async () => {
      const labs = await json(["list", "--json"]);
      if (!Array.isArray(labs)) throw new CliError("list did not print an array");
      return labs;
    },
    status: (name) => (assertName(name), json(["status", "-n", name, "--json"])),
    screen: (name, tail = 40) => {
      assertName(name);
      const n = Math.min(Math.max(Number.parseInt(tail, 10) || 40, 1), 200);
      return json(["screen", "-n", name, "--json", "--tail", String(n)]);
    },
    send: async (name, text, { enter = true } = {}) => {
      assertName(name);
      if (typeof text !== "string" || text.length > 20000) throw new CliError("text must be a string of at most 20000 characters", { status: 400 });
      // Escape sequences and carriage returns would press keys that the key allow-list is there to limit.
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new CliError("text may not contain control characters", { status: 400 });
      await run(["send", "-n", name, "--paced", ...(enter ? ["-e"] : []), "--", text], { timeout: 60000 });
    },
    key: async (name, key) => {
      assertName(name);
      if (!ALLOWED_KEYS.has(key)) throw new CliError("key not allowed", { status: 400 });
      await run(["key", "-n", name, key]);
    },
    stop: async (name) => {
      assertName(name);
      await run(["stop", "-n", name], { timeout: 15000 });
    },
    attach: async (name) => {
      assertName(name);
      await run(["foreground", "-n", name]);
    },
  };
}
