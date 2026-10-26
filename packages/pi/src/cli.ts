#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, UsageError, type ParsedArgs } from "./core/args.js";
import { loadConfig, configPath } from "./core/config.js";
import { assertReachable, createRunner, describeTarget, ExecError } from "./core/exec.js";
import { Registry } from "./core/registry.js";
import { color, createUi, renderCommand, sym, table, type Ui } from "./core/ui.js";
import type { ExecTarget, LoadedExt, PluginContext } from "./core/types.js";

/** Walk up from this module until package.json turns up: works in src/ and dist/. */
function version(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "pi") return pkg.version ?? "0.0.0";
    }
    dir = dirname(dir);
  }
  return "0.0.0";
}

/** Exit codes, documented in `pi help` so scripts can rely on them. */
const EXIT = { ok: 0, error: 1, usage: 2, checkFailed: 3, missingRequires: 4 } as const;

function helpText(): string {
  const b = color.bold;
  return `${b("pi")} ${color.dim(`v${version()}`)} - install things onto a host or a container, one extension at a time.

${b("USAGE")}
  pi <command> [extension] [flags]

${b("COMMANDS")}
  list                 show every extension pi can see
  info <ext>           what an extension does, needs, and can be configured with
  check <ext>          is it already installed on the target?
  doctor [ext]         check an extension and everything it requires (or all of them)
  install <ext>        verify prerequisites, then install
  remove <ext>         uninstall, for extensions that support it
  help, version

${b("FLAGS")}
  --target=host|container   where to run (default: host)
  --container=<name>        container to exec into; implies --target=container
  --set key=value           extension config; repeatable
  --dry-run, -n             print what would run, change nothing
  --force                   install even if check() already passes
  --skip-requires           install without checking prerequisites (escape hatch)
  --json                    machine-readable result on stdout
  --verbose                 stream command output
  --quiet                   only warnings and errors
  --yes, -y                 assume yes; never prompt

${b("EXAMPLES")}
  pi list
  pi check docker-ext
  pi install zlib-ext --container=jellyfin
  pi install jellyfin-ext --set media-path=/srv/media --set config-path=/srv/jellyfin
  pi doctor jellyfin-ext --json

${b("CONFIG")}
  ${configPath()}   ->   { "<ext>": { "<key>": "<value>" } }
  or PI_<EXT>_<KEY> in the environment, or --set on the command line.

${b("EXIT CODES")}
  0 ok   1 error   2 bad usage   3 check failed   4 prerequisites missing`;
}

interface Output {
  ui: Ui;
  json: boolean;
  emit(payload: unknown): void;
}

function makeContext(args: ParsedArgs, ext: LoadedExt, ui: Ui): PluginContext {
  const run = createRunner({
    dryRun: args.dryRun,
    verbose: args.verbose,
    onCommand: (argv, skipped) => {
      const rendered = renderCommand(argv);
      if (skipped) ui.info(`  ${color.yellow("would run")} ${color.dim(rendered)}`);
      else ui.debug(`$ ${rendered}`);
    },
  });
  return {
    log: {
      info: (m) => ui.info(`  ${m}`),
      step: (m) => ui.step(m),
      ok: (m) => ui.ok(m),
      warn: (m) => ui.warn(m),
      error: (m) => ui.error(m),
      debug: (m) => ui.debug(m),
    },
    run,
    config: loadConfig(ext.manifest.name, args.set),
    dryRun: args.dryRun,
    assumeYes: args.yes,
  };
}

function targetOf(args: ParsedArgs): ExecTarget {
  return args.target === "container"
    ? { kind: "container", containerName: args.container }
    : { kind: "host" };
}

function targetFlags(args: ParsedArgs): string {
  return args.target === "container" ? ` --container=${args.container}` : "";
}

/**
 * Resolve the target for a command: reject a target the extension does not
 * support (static, no I/O), then make sure a container target is actually
 * usable before any probe runs against it.
 */
async function resolveTarget(
  ext: LoadedExt | undefined,
  args: ParsedArgs,
  ui?: Ui,
): Promise<ExecTarget> {
  const target = targetOf(args);
  // The bundled extensions manage Linux targets; saying so once beats five
  // confusing "missing" lines.
  if (target.kind === "host" && process.platform === "win32") {
    ui?.warn(
      "this host is Windows, and pi installs Linux packages - target a container " +
        "with --container=<name>, or run pi on the target host itself.",
    );
  }
  if (ext) assertTargetSupported(ext, target);
  if (target.kind === "container") {
    await assertReachable(createRunner({ verbose: args.verbose }), target);
  }
  return target;
}

function assertTargetSupported(ext: LoadedExt, target: ExecTarget): void {
  const supported = ext.manifest.targets;
  if (supported && !supported.includes(target.kind)) {
    throw new Error(
      `${ext.manifest.name} does not support ${target.kind} targets ` +
        `(supports: ${supported.join(", ")}).`,
    );
  }
}

async function checkOne(
  ext: LoadedExt,
  target: ExecTarget,
  args: ParsedArgs,
  ui: Ui,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const ctx = makeContext(args, ext, ui);
    return { ok: await ext.plugin.check(target, ctx) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function cmdList(reg: Registry, out: Output): Promise<number> {
  const exts = reg.list();
  if (out.json) {
    out.emit({
      extensions: exts.map((e) => ({
        ...e.manifest,
        dir: e.dir,
        removable: typeof e.plugin.remove === "function",
      })),
      errors: reg.errors.map((e) => ({ dir: e.extDir, message: e.message })),
    });
    return EXIT.ok;
  }
  if (exts.length === 0) {
    out.ui.warn("no extensions found. Did you run `npm run build`?");
    return EXIT.error;
  }
  const rows = exts.map((e) => [
    color.cyan(e.manifest.name),
    color.dim(e.manifest.version),
    e.manifest.requires?.length ? color.dim(e.manifest.requires.join(", ")) : color.dim("-"),
    e.manifest.description ?? "",
  ]);
  out.ui.plain(table(rows, ["EXTENSION", "VERSION", "REQUIRES", "WHAT IT DOES"]));
  for (const err of reg.errors) out.ui.warn(`skipped ${err.extDir}: ${err.message}`);
  out.ui.plain("");
  out.ui.plain(color.dim(`  ${sym.dot} pi info <ext> for details, pi install <ext> to run it`));
  return EXIT.ok;
}

async function cmdInfo(reg: Registry, name: string, out: Output): Promise<number> {
  const ext = reg.get(name);
  const m = ext.manifest;
  if (out.json) {
    out.emit({ ...m, dir: ext.dir, removable: typeof ext.plugin.remove === "function" });
    return EXIT.ok;
  }
  out.ui.plain(`${color.bold(color.cyan(m.name))} ${color.dim(m.version)}`);
  if (m.description) out.ui.plain(`  ${m.description}`);
  out.ui.plain("");
  out.ui.plain(`  ${color.bold("targets")}   ${(m.targets ?? ["host", "container"]).join(", ")}`);
  out.ui.plain(
    `  ${color.bold("requires")}  ${m.requires?.length ? m.requires.join(", ") : color.dim("nothing")}`,
  );
  out.ui.plain(
    `  ${color.bold("remove")}    ${typeof ext.plugin.remove === "function" ? "supported" : color.dim("not implemented")}`,
  );
  out.ui.plain(`  ${color.bold("source")}    ${color.dim(ext.dir)}`);
  if (m.config?.length) {
    out.ui.plain("");
    out.ui.plain(`  ${color.bold("config")}`);
    out.ui.plain(
      table(
        m.config.map((c) => [
          `    ${color.cyan(c.key)}`,
          c.required ? color.yellow("required") : color.dim(`default: ${c.default ?? "-"}`),
          c.description,
        ]),
      ),
    );
    out.ui.plain("");
    out.ui.plain(color.dim(`  set with: pi install ${m.name} --set ${m.config[0]?.key}=<value>`));
  }
  return EXIT.ok;
}

async function cmdCheck(
  reg: Registry,
  name: string,
  args: ParsedArgs,
  out: Output,
): Promise<number> {
  const ext = reg.get(name);
  const target = await resolveTarget(ext, args, out.ui);
  const res = await checkOne(ext, target, args, out.ui);
  if (out.json) {
    out.emit({ extension: ext.manifest.name, target, installed: res.ok, error: res.error ?? null });
  } else if (res.ok) {
    out.ui.ok(`${ext.manifest.name} is installed on ${describeTarget(target)}`);
  } else {
    out.ui.error(`${ext.manifest.name} is not installed on ${describeTarget(target)}`);
    if (res.error) out.ui.plain(color.dim(`  ${res.error}`));
    out.ui.plain(color.dim(`  install it: pi install ${ext.manifest.name}${targetFlags(args)}`));
  }
  return res.ok ? EXIT.ok : EXIT.checkFailed;
}

async function cmdDoctor(
  reg: Registry,
  name: string | undefined,
  args: ParsedArgs,
  out: Output,
): Promise<number> {
  const target = await resolveTarget(undefined, args, out.ui);
  const exts = name ? [...reg.requirementsOf(name), reg.get(name)] : reg.list();

  const results: Array<{ name: string; installed: boolean; error?: string; skipped?: string }> = [];
  for (const ext of exts) {
    const supported = ext.manifest.targets;
    if (supported && !supported.includes(target.kind)) {
      results.push({
        name: ext.manifest.name,
        installed: false,
        skipped: `not applicable to ${target.kind}`,
      });
      continue;
    }
    const res = await checkOne(ext, target, args, out.ui);
    results.push({ name: ext.manifest.name, installed: res.ok, error: res.error });
  }

  if (out.json) {
    out.emit({ target, results });
  } else {
    out.ui.plain(`${color.bold("target")} ${describeTarget(target)}`);
    out.ui.plain("");
    out.ui.plain(
      table(
        results.map((r) => [
          r.skipped
            ? `  ${color.dim("-")}`
            : r.installed
              ? `  ${color.green(sym.ok)}`
              : `  ${color.red(sym.fail)}`,
          color.cyan(r.name),
          r.skipped
            ? color.dim(r.skipped)
            : r.installed
              ? color.dim("installed")
              : color.yellow("missing"),
          r.error ? color.dim(r.error.split("\n")[0] ?? "") : "",
        ]),
      ),
    );
    const missing = results.filter((r) => !r.installed && !r.skipped);
    out.ui.plain("");
    if (missing.length === 0) {
      out.ui.ok("everything checked is installed");
    } else {
      out.ui.plain(color.dim("  install the missing ones:"));
      for (const m of missing) {
        out.ui.plain(color.dim(`    pi install ${m.name}${targetFlags(args)}`));
      }
    }
  }
  return results.every((r) => r.installed || r.skipped) ? EXIT.ok : EXIT.checkFailed;
}

async function cmdInstall(
  reg: Registry,
  name: string,
  args: ParsedArgs,
  out: Output,
): Promise<number> {
  const ext = reg.get(name);
  const target = await resolveTarget(ext, args, out.ui);
  const ui = out.ui;

  ui.plain(
    `${color.bold(`install ${color.cyan(ext.manifest.name)}`)} ${color.dim(`v${ext.manifest.version}`)} ` +
      `${color.dim(`on ${describeTarget(target)}`)}${args.dryRun ? ` ${color.yellow("(dry run)")}` : ""}`,
  );

  // 1. Prerequisites: checked, never auto-installed - extensions stay independent.
  const requires = args.skipRequires ? [] : reg.requirementsOf(ext.manifest.name);
  const missing: string[] = [];
  if (args.skipRequires && (ext.manifest.requires ?? []).length > 0) {
    ui.warn(
      `skipping the prerequisite check for ${(ext.manifest.requires ?? []).join(", ")} - ` +
        "you are asserting the target already has what it needs",
    );
  }
  if (requires.length > 0) {
    ui.step(`checking prerequisites: ${requires.map((r) => r.manifest.name).join(", ")}`);
    for (const req of requires) {
      const supported = req.manifest.targets;
      if (supported && !supported.includes(target.kind)) {
        ui.info(
          `${color.dim("-")} ${req.manifest.name} ${color.dim(`skipped (not applicable to ${target.kind})`)}`,
        );
        continue;
      }
      const res = await checkOne(req, target, args, ui);
      if (res.ok) ui.info(`${color.green(sym.ok)} ${req.manifest.name}`);
      else {
        ui.info(`${color.red(sym.fail)} ${req.manifest.name} ${color.dim("missing")}`);
        missing.push(req.manifest.name);
      }
    }
  }
  if (missing.length > 0) {
    if (out.json) {
      out.emit({ extension: ext.manifest.name, installed: false, missingRequires: missing });
    } else {
      ui.plain("");
      ui.error(`${ext.manifest.name} needs ${missing.length} prerequisite(s) first`);
      for (const m of missing) ui.plain(color.dim(`    pi install ${m}${targetFlags(args)}`));
      ui.plain(
        color.dim("  pi does not install prerequisites for you: extension boundaries stay explicit."),
      );
    }
    return EXIT.missingRequires;
  }

  // 2. Idempotency: already-installed is a success, not a rerun.
  const before = await checkOne(ext, target, args, ui);
  if (before.ok && !args.force) {
    if (out.json) out.emit({ extension: ext.manifest.name, installed: true, changed: false });
    else {
      ui.ok(`${ext.manifest.name} is already installed on ${describeTarget(target)}`);
      ui.plain(color.dim("  use --force to run the install anyway"));
    }
    return EXIT.ok;
  }

  // 3. Install.
  const ctx = makeContext(args, ext, ui);
  await ext.plugin.install(target, ctx);

  // 4. Verify, unless this was a rehearsal.
  if (args.dryRun) {
    if (out.json) {
      out.emit({ extension: ext.manifest.name, dryRun: true, installed: false, changed: false });
    } else ui.ok("dry run complete - nothing was changed");
    return EXIT.ok;
  }

  const after = await checkOne(ext, target, args, ui);
  if (out.json) {
    out.emit({
      extension: ext.manifest.name,
      installed: after.ok,
      changed: true,
      error: after.error ?? null,
    });
  } else if (after.ok) {
    ui.ok(`${ext.manifest.name} installed on ${describeTarget(target)}`);
  } else {
    ui.error(`${ext.manifest.name} ran its install but check() still fails`);
    if (after.error) ui.plain(color.dim(`  ${after.error}`));
    ui.plain(color.dim("  rerun with --verbose to see the commands and their output"));
  }
  return after.ok ? EXIT.ok : EXIT.checkFailed;
}

async function cmdRemove(
  reg: Registry,
  name: string,
  args: ParsedArgs,
  out: Output,
): Promise<number> {
  const ext = reg.get(name);
  const target = await resolveTarget(ext, args, out.ui);
  const remove = ext.plugin.remove;
  if (typeof remove !== "function") {
    throw new Error(
      `${ext.manifest.name} does not implement remove().\n` +
        "  extensions opt into removal; this one has not.",
    );
  }
  // Anything that requires this extension would break.
  const dependents = reg
    .list()
    .filter((e) => (e.manifest.requires ?? []).includes(ext.manifest.name))
    .map((e) => e.manifest.name);
  if (dependents.length > 0 && !args.yes) {
    const verb = dependents.length === 1 ? "requires" : "require";
    out.ui.warn(`${dependents.join(", ")} ${verb} ${ext.manifest.name}`);
    out.ui.plain(color.dim("  rerun with --yes to remove it anyway"));
    return EXIT.error;
  }
  out.ui.plain(
    `${color.bold(`remove ${color.cyan(ext.manifest.name)}`)} ${color.dim(`from ${describeTarget(target)}`)}` +
      `${args.dryRun ? ` ${color.yellow("(dry run)")}` : ""}`,
  );
  const ctx = makeContext(args, ext, out.ui);
  await remove.call(ext.plugin, target, ctx);
  if (args.dryRun) {
    if (out.json) out.emit({ extension: ext.manifest.name, dryRun: true, removed: false });
    else out.ui.ok("dry run complete - nothing was changed");
    return EXIT.ok;
  }
  const after = await checkOne(ext, target, args, out.ui);
  if (out.json) out.emit({ extension: ext.manifest.name, removed: !after.ok });
  else if (!after.ok) out.ui.ok(`${ext.manifest.name} removed`);
  else out.ui.warn(`${ext.manifest.name} still reports as installed`);
  return EXIT.ok;
}

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${color.red(sym.fail)} ${err.message}\n`);
      return EXIT.usage;
    }
    throw err;
  }

  const ui = createUi({ verbose: args.verbose, quiet: args.quiet || args.json });
  const out: Output = {
    ui,
    json: args.json,
    emit: (payload) => process.stdout.write(JSON.stringify(payload, null, 2) + "\n"),
  };

  if (args.version || args.command === "version") {
    process.stdout.write(`${version()}\n`);
    return EXIT.ok;
  }
  if (args.help || args.command === undefined || args.command === "help") {
    process.stderr.write(helpText() + "\n");
    return args.command === undefined && !args.help ? EXIT.usage : EXIT.ok;
  }

  const needsExt = ["info", "check", "install", "remove"];
  const name = args.positionals[0];
  if (needsExt.includes(args.command) && !name) {
    ui.error(`"pi ${args.command}" needs an extension name.`);
    ui.plain(color.dim("  see what is available: pi list"));
    return EXIT.usage;
  }

  try {
    const reg = await Registry.load();
    switch (args.command) {
      case "list":
        return await cmdList(reg, out);
      case "info":
        return await cmdInfo(reg, name as string, out);
      case "check":
        return await cmdCheck(reg, name as string, args, out);
      case "doctor":
        return await cmdDoctor(reg, name, args, out);
      case "install":
        return await cmdInstall(reg, name as string, args, out);
      case "remove":
        return await cmdRemove(reg, name as string, args, out);
      default:
        ui.error(`unknown command "${args.command}"`);
        ui.plain(
          color.dim("  commands: list, info, check, doctor, install, remove, help, version"),
        );
        return EXIT.usage;
    }
  } catch (err) {
    const message = (err as Error).message;
    if (out.json) out.emit({ error: message });
    else {
      ui.error(message);
      // Only a failed command has output worth re-running for.
      if (err instanceof ExecError && !args.verbose) {
        ui.plain(color.dim("  rerun with --verbose to see the command output"));
      }
    }
    return EXIT.error;
  }
}

/** Run only when invoked as the entrypoint, so tests can import main(). */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: Error) => {
      process.stderr.write(`${color.red(sym.fail)} ${err.stack ?? err.message}\n`);
      process.exitCode = EXIT.error;
    });
}
