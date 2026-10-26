export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  target: "host" | "container";
  container?: string;
  set: Record<string, string>;
  dryRun: boolean;
  json: boolean;
  verbose: boolean;
  quiet: boolean;
  yes: boolean;
  force: boolean;
  skipRequires: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const KNOWN_FLAGS = new Set([
  "target", "container", "set", "dry-run", "json", "verbose", "quiet",
  "yes", "force", "skip-requires", "help", "version",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: undefined,
    positionals: [],
    target: "host",
    set: {},
    dryRun: false,
    json: false,
    verbose: false,
    quiet: false,
    yes: false,
    force: false,
    skipRequires: false,
    help: false,
    version: false,
  };

  let explicitTarget: "host" | "container" | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;

    if (arg === "-h") { out.help = true; continue; }
    if (arg === "-V") { out.version = true; continue; }
    if (arg === "-y") { out.yes = true; continue; }
    if (arg === "-n") { out.dryRun = true; continue; }

    if (!arg.startsWith("--")) {
      out.positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    let value = eq === -1 ? undefined : body.slice(eq + 1);

    if (!KNOWN_FLAGS.has(name)) {
      throw new UsageError(`unknown flag "--${name}". Run "pi help" to see the flags pi accepts.`);
    }

    // Allow the space form for flags that take a value: --target host
    const needsValue = name === "target" || name === "container" || name === "set";
    if (needsValue && value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`--${name} needs a value (e.g. --${name}=...)`);
      }
      value = next;
      i++;
    }

    switch (name) {
      case "target": {
        if (value !== "host" && value !== "container") {
          throw new UsageError(`--target must be "host" or "container", got "${value}"`);
        }
        out.target = value;
        explicitTarget = value;
        break;
      }
      case "container":
        out.container = value;
        break;
      case "set": {
        const idx = (value as string).indexOf("=");
        if (idx <= 0) {
          throw new UsageError(`--set expects key=value, got "${value}"`);
        }
        out.set[(value as string).slice(0, idx)] = (value as string).slice(idx + 1);
        break;
      }
      case "dry-run": out.dryRun = true; break;
      case "json": out.json = true; break;
      case "verbose": out.verbose = true; break;
      case "quiet": out.quiet = true; break;
      case "yes": out.yes = true; break;
      case "force": out.force = true; break;
      case "skip-requires": out.skipRequires = true; break;
      case "help": out.help = true; break;
      case "version": out.version = true; break;
    }
  }

  out.command = out.positionals.shift();

  // A container name implies a container target; a container target needs a name.
  if (out.container && explicitTarget === "host") {
    throw new UsageError(
      "--target=host and --container=<name> contradict each other. Drop one.",
    );
  }
  if (out.container) out.target = "container";
  if (out.target === "container" && !out.container) {
    throw new UsageError(
      '--target=container needs --container=<name> so pi knows where to exec.',
    );
  }

  return out;
}
