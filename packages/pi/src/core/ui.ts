/** Terminal output helpers. No dependencies: plain ANSI, honouring NO_COLOR. */

const ESC = "\x1b";

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  (process.env.FORCE_COLOR !== undefined || process.stderr.isTTY === true);

const paint = (code: string) => (s: string) =>
  useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s;

export const color = {
  bold: paint("1"),
  dim: paint("2"),
  red: paint("31"),
  green: paint("32"),
  yellow: paint("33"),
  blue: paint("34"),
  magenta: paint("35"),
  cyan: paint("36"),
};

/** ASCII fallbacks: legacy Windows consoles are unreliable with glyphs. */
const unicode = process.platform !== "win32" || process.env.WT_SESSION !== undefined;
export const sym = {
  ok: unicode ? "✓" : "+",
  fail: unicode ? "✗" : "x",
  arrow: unicode ? "→" : "->",
  dot: unicode ? "•" : "*",
};

/**
 * Human output goes to stderr so `--json` on stdout stays machine-readable
 * and pipeable.
 */
function write(line: string): void {
  process.stderr.write(line + "\n");
}

export interface UiOptions {
  verbose?: boolean;
  quiet?: boolean;
}

export function createUi(opts: UiOptions = {}) {
  const quiet = opts.quiet === true;
  return {
    info: (msg: string) => { if (!quiet) write(msg); },
    step: (msg: string) => { if (!quiet) write(`${color.blue(sym.arrow)} ${msg}`); },
    ok: (msg: string) => { if (!quiet) write(`${color.green(sym.ok)} ${msg}`); },
    warn: (msg: string) => write(`${color.yellow("!")} ${msg}`),
    error: (msg: string) => write(`${color.red(sym.fail)} ${msg}`),
    debug: (msg: string) => { if (opts.verbose && !quiet) write(color.dim(`  ${msg}`)); },
    plain: (msg: string) => { if (!quiet) write(msg); },
  };
}

export type Ui = ReturnType<typeof createUi>;

export function stripAnsi(s: string): string {
  return s.replace(new RegExp(`${ESC}\[[0-9;]*m`, "g"), "");
}

/** Left-aligned columns, used by `pi list`. */
export function table(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    });
  }
  const fmt = (row: string[]) =>
    row
      .map((cell, i) =>
        i === row.length - 1
          ? cell
          : cell + " ".repeat((widths[i] ?? 0) - stripAnsi(cell).length),
      )
      .join("  ")
      .trimEnd();
  const lines: string[] = [];
  if (headers) lines.push(color.dim(fmt(headers)));
  for (const row of rows) lines.push(fmt(row));
  return lines.join("\n");
}

/** Render an argv the way a shell would accept it, for display only. */
export function renderCommand(argv: string[]): string {
  return argv
    .map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.split("'").join(`'\\''`)}'`))
    .join(" ");
}
