/**
 * Shared contracts for pi core and every extension.
 *
 * Core knows nothing about Docker, zlib, ffmpeg or Jellyfin: it only knows
 * these types. Extensions are self-contained packages under exts/ that
 * implement InstallerPlugin and export an ExtManifest.
 */

/** Where an extension's commands are executed. */
export interface ExecTarget {
  kind: "host" | "container";
  /** Required when kind === "container". */
  containerName?: string;
}

/** Result of running a command through core/exec. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The argv actually executed, after target wrapping. */
  argv: string[];
}

export interface RunOptions {
  /** Elevate on the host with sudo when not already root. Default: false. */
  sudo?: boolean;
  /** For container targets: user to exec as (e.g. "0" for root). */
  user?: string;
  /** Do not fail the caller on a non-zero exit; just return the result. */
  allowFailure?: boolean;
  /** Extra environment for the command. */
  env?: Record<string, string>;
  /**
   * Force this command to be treated as a probe: it runs even under
   * --dry-run. succeeds() sets it; set it by hand for read-only commands
   * the heuristic does not recognise.
   */
  readOnly?: boolean;
  /** Milliseconds before the command is killed. Default: 15 minutes. */
  timeoutMs?: number;
  /** Stream child output to the terminal as it happens. Default: verbose-dependent. */
  stream?: boolean;
}

/** Structured logger handed to extensions so output stays consistent. */
export interface PluginLogger {
  info(msg: string): void;
  step(msg: string): void;
  ok(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

/**
 * Everything an extension is given at run time.
 *
 * This is the one deliberate widening of the original two-method contract:
 * extensions need a logger, a dry-run-aware exec, and their own config
 * (e.g. jellyfin-ext's host-specific device paths) without reaching into core.
 */
export interface PluginContext {
  log: PluginLogger;
  /** Run a command against the target. Honours dryRun. */
  run(target: ExecTarget, argv: string[], opts?: RunOptions): Promise<ExecResult>;
  /** Per-extension config from --set/PI_* env/config file. */
  config: ExtConfig;
  /** True when the user asked for a rehearsal: no mutating command runs. */
  dryRun: boolean;
  /** True when --yes was passed; extensions must not prompt. */
  assumeYes: boolean;
}

/** Typed accessor over an extension's key/value config. */
export interface ExtConfig {
  get(key: string): string | undefined;
  /** Throws a friendly error naming the key when it is missing. */
  require(key: string): string;
  string(key: string, fallback: string): string;
  bool(key: string, fallback: boolean): boolean;
  list(key: string, fallback?: string[]): string[];
  all(): Record<string, string>;
}

export interface InstallerPlugin {
  name: string;
  check(target: ExecTarget, ctx: PluginContext): Promise<boolean>;
  install(target: ExecTarget, ctx: PluginContext): Promise<void>;
  /** Optional: pi remove <ext> only works for extensions that implement it. */
  remove?(target: ExecTarget, ctx: PluginContext): Promise<void>;
}

/** A config key an extension understands, surfaced by `pi info <ext>`. */
export interface ConfigKeySpec {
  key: string;
  description: string;
  default?: string;
  required?: boolean;
}

export interface ExtManifest {
  name: string;
  version: string;
  description?: string;
  /**
   * Names of other extensions that must already be installed on the target.
   * Runtime check only — never a build-time import. Extensions stay
   * independent: pi reports what is missing and stops, it does not
   * auto-install prerequisites.
   */
  requires?: string[];
  /** Targets this extension supports. Default: both. */
  targets?: Array<ExecTarget["kind"]>;
  config?: ConfigKeySpec[];
}

/** A manifest plus its loaded plugin, as held by the registry. */
export interface LoadedExt {
  manifest: ExtManifest;
  plugin: InstallerPlugin;
  /** Directory the extension was loaded from. */
  dir: string;
}
