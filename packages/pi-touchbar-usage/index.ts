import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_EVENT } from "./pi-events.ts";
import { getRightPanel } from "../core/right-panel.ts";

// pi reloads extensions in-process on session switch/fork, so module state is
// rebuilt but globalThis is not. Parking the timer here keeps one poller per
// process instead of one per session reload.
const STATE_KEY = Symbol.for("pi.touchbar-usage.state.v1");
const TICK_MS = 15_000;
// --- Extension constants: local literals live together here. ---
const KEY = "touchbar-usage";
const PLACEMENT = "aboveEditor";
const COMMAND_DESCRIPTION = "Claude Code + Codex usage on the Touch Bar (start|stop|status|refresh)";
const ACTION_START = "start";
const ACTION_STOP = "stop";
const ACTION_STATUS = "status";
const ACTION_REFRESH = "refresh";
const QUIT = "quit";
const ENTRY_MESSAGE = "message";
const ROLE_ASSISTANT = "assistant";
const TONE_ACCENT = "accent";
const TONE_DIM = "dim";
const TONE_ERROR = "error";
const TONE_WARNING = "warning";
const TONE_SUCCESS = "success";
const NOTE_INFO = "info";
const NOTE_WARNING = "warning";
const BAR_FULL = "█";
const BAR_EMPTY = "░";
const PANEL_TITLE = "Usage";
const TAB_ID = "usage";
const TAB_ORDER = 2;
const LABEL_CC = "CC";
const LABEL_CX = "CX";
const NO_AUTH = "no-auth";
const ERROR_FALLBACK = "error";
const THOUSANDS_SUFFIX = "k";
const MILLIONS_SUFFIX = "m";
const NO_AUTH_MARK = "—";
const ERROR_MARK = "!";
const NOTE_STOPPED = "Usage polling stopped (Touch Bar keeps its own timer)";
const NOTE_STARTED = "Usage polling started";
const NOTE_MISSING = "No usage data yet — run bin/pi-usagebar --json to see why";
const NOTE_USAGE = "Usage: /touchbar-usage [start|stop|status|refresh]";
const resetMinutes = (minutes: number) => ` ↻${minutes}m`;
const resetHours = (hours: number, minutes: number) => ` ↻${hours}h${minutes % 60 ? String(minutes % 60).padStart(2, "0") : ""}`;
const resetDays = (days: number) => ` ↻${days}d`;
const contextLine = (bar: string, percent: number) => `CTX ${bar} ${Math.round(percent).toString().padStart(3)}%`;
const tokensLine = (input: string, output: string) => `TOK ↑${input}  ↓${output}`;
const windowLine = (label: string, name: string, bar: string, percent: number, reset: string) =>
  `${label} ${name.padEnd(2)} ${bar} ${Math.round(percent).toString().padStart(3)}%${reset}`;

type Core = typeof import("./src/usage.mjs");

type UsageState = {
  timer?: ReturnType<typeof setInterval>;
  ctx?: ExtensionContext;
  core?: Core;
  running: boolean;
};

const globals = globalThis as typeof globalThis & { [STATE_KEY]?: UsageState };
const state: UsageState = globals[STATE_KEY] ?? { running: false };
globals[STATE_KEY] = state;

// Loaded lazily so a broken core never stops the rest of pi from starting.
async function core(): Promise<Core> {
  state.core ??= (await import(new URL("./src/usage.mjs", import.meta.url).href)) as Core;
  return state.core;
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}${THOUSANDS_SUFFIX}`;
  return `${(value / 1_000_000).toFixed(1)}${MILLIONS_SUFFIX}`;
}

function resetIn(resetsAt: unknown): string {
  if (typeof resetsAt !== "number") return "";
  const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / 60_000));
  if (minutes <= 0) return "";
  if (minutes < 60) return resetMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return resetHours(hours, minutes);
  return resetDays(Math.round(hours / 24));
}

function progressBar(ctx: ExtensionContext, percent: number, width = 10): string {
  const bounded = Math.max(0, Math.min(100, percent));
  const filled = Math.round((bounded / 100) * width);
  const tone = bounded >= 90 ? TONE_ERROR : bounded >= 70 ? TONE_WARNING : TONE_SUCCESS;
  return ctx.ui.theme.fg(tone, BAR_FULL.repeat(filled)) + ctx.ui.theme.fg(TONE_DIM, BAR_EMPTY.repeat(width - filled));
}

function tokenTotals(ctx: ExtensionContext): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== ENTRY_MESSAGE || entry.message.role !== ROLE_ASSISTANT) continue;
    const message = entry.message as AssistantMessage;
    input += message.usage.input;
    output += message.usage.output;
  }
  return { input, output };
}

function usagePanel(ctx: ExtensionContext, published: any, width: number): string[] {
  const totals = tokenTotals(ctx);
  const contextPercent = ctx.getContextUsage()?.percent ?? 0;
  const windows: { label: string; name: string; percent: number; reset: string }[] = [];
  const errors: string[] = [];
  for (const [label, side] of [[LABEL_CC, published?.claude], [LABEL_CX, published?.codex]] as const) {
    if (!side) continue;
    if (!side.ok && !side.windows?.length) {
      errors.push(`${label} ${ctx.ui.theme.fg(TONE_DIM, side.error === NO_AUTH ? NO_AUTH_MARK : `${ERROR_MARK}${side.error ?? ERROR_FALLBACK}`)}`);
      continue;
    }
    for (const window of side.windows ?? []) {
      windows.push({ label, name: String(window.label), percent: Number(window.percent) || 0, reset: resetIn(window.resetsAt) });
    }
  }

  // Leave room for labels, percentages and reset times before sizing the bars.
  // All bars share one scale so equal percentages have equal visual lengths.
  const fixedWidth = Math.max(
    contextLine("", contextPercent).length,
    ...windows.map(({ label, name, percent, reset }) => windowLine(label, name, "", percent, reset).length),
  );
  const barWidth = Math.max(1, Math.min(20, width - fixedWidth));
  return [
    ctx.ui.theme.fg(TONE_ACCENT, PANEL_TITLE),
    contextLine(progressBar(ctx, contextPercent, barWidth), contextPercent),
    tokensLine(compactNumber(totals.input), compactNumber(totals.output)),
    ...windows.map(({ label, name, percent, reset }) =>
      windowLine(label, name, progressBar(ctx, percent, barWidth), percent, reset)),
    ...errors,
  ];
}

let usageContext: ExtensionContext | undefined;
let publishedUsage: any;
let unregisterUsage: (() => void) | undefined;

function publishPanel(ctx: ExtensionContext, published: any): void {
  usageContext = ctx;
  publishedUsage = published;
  unregisterUsage ??= getRightPanel().registerTab({
    id: TAB_ID,
    label: PANEL_TITLE,
    order: TAB_ORDER,
    lines: (width) => (usageContext && publishedUsage ? usagePanel(usageContext, publishedUsage, width) : []),
  });
  ctx.ui.setStatus(KEY, undefined);
  ctx.ui.setWidget(KEY, undefined);
}

async function tick(force = false): Promise<string | undefined> {
  try {
    const usage = await core();
    const published = await usage.refresh({ force });
    const line = published ? usage.render(published) : undefined;
    if (published && state.ctx) publishPanel(state.ctx, published);
    return line;
  } catch {
    // The Touch Bar host reads the published file directly, so it keeps
    // working even when the in-pi poller is unhappy.
    return undefined;
  }
}

function start(): void {
  if (state.timer) return;
  // unref: this must never be the reason a pi session refuses to exit.
  state.timer = setInterval(() => void tick(), TICK_MS);
  state.timer.unref?.();
  state.running = true;
  void tick();
}

function stop(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
  state.running = false;
}

export default function touchbarUsage(pi: ExtensionAPI) {
  pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => {
    state.ctx = ctx;
    start();
  });

  pi.on(PI_EVENT.TURN_END, async (_event, ctx) => {
    if (!state.running) return;
    try {
      const usage = await core();
      const published = usage.readPublished();
      if (published) publishPanel(ctx, published);
    } catch {
      // Keep usage display failures isolated from the agent turn.
    }
  });

  pi.on(PI_EVENT.SESSION_SHUTDOWN, async (event) => {
    state.ctx = undefined;
    usageContext = undefined;
    // Only tear down on a real quit. A session switching or forking inside a
    // tmux pane while other panes live on should leave the poller running.
    if (event.reason === QUIT) {
      stop();
      unregisterUsage?.();
      unregisterUsage = undefined;
    }
  });

  pi.registerCommand(KEY, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      state.ctx = ctx;
      const action = args.trim().toLowerCase() || ACTION_STATUS;

      if (action === ACTION_STOP) {
        stop();
        unregisterUsage?.();
        unregisterUsage = undefined;
        ctx.ui.setStatus(KEY, undefined);
        ctx.ui.setWidget(KEY, undefined);
        ctx.ui.notify(NOTE_STOPPED, NOTE_INFO);
        return;
      }

      if (action === ACTION_START) {
        start();
        ctx.ui.notify(NOTE_STARTED, NOTE_INFO);
        return;
      }

      if (action === ACTION_REFRESH || action === ACTION_STATUS) {
        const line = await tick(action === ACTION_REFRESH);
        if (!line) {
          ctx.ui.notify(NOTE_MISSING, NOTE_WARNING);
          return;
        }
        const usage = await core();
        const published = usage.readPublished();
        if (published) publishPanel(ctx, published);
        return;
      }

      ctx.ui.notify(NOTE_USAGE, NOTE_WARNING);
    },
  });
}
