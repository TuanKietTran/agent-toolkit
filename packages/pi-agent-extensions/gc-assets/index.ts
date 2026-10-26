import v8 from "node:v8";
import vm from "node:vm";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerReplay } from "./dev/replay.ts";
import { WIDGET_KEY, formatBytes, publish, setPanelVisible } from "./panel.ts";
import { ageDays, loadConfig, scan, state, sweep } from "./scanner.ts";

import { PI_EVENT } from "../core/events.ts";

// --- Constants: every local literal lives here. ---

const EXPOSE_GC_FLAG = "--expose-gc";
const GC_GLOBAL = "gc";
const QUIT = "quit";
const COMMAND_NAME = "gc";
const COMMAND_DESCRIPTION = "Memory GC and asset cleanup (status|scan|heap|sweep [sessions]|age <days>|hide|show)";
const ACTION_STATUS = "status";
const ACTION_SCAN = "scan";
const ACTION_HEAP = "heap";
const ACTION_AGE = "age";
const ACTION_HIDE = "hide";
const ACTION_SHOW = "show";
const ACTION_SWEEP = "sweep";
const ARG_SESSIONS = "sessions";
const SWEEP_AUTO = "auto";
const SWEEP_CONFIRM = "confirm";
const NOTE_INFO = "info";
const NOTE_WARNING = "warning";
const NOTE_AGE_USAGE = "Usage: /gc age <days>";
const NOTE_USAGE = "Usage: /gc [status|scan|heap|sweep [sessions]|age <days>|hide|show]";
const CONFIRM_TITLE = "Delete stale assets?";
const NOTHING_HINT = " (sessions excluded; use /gc sweep sessions)";
const noteAssets = (total: string, age: number, stale: string) => `Assets ${total} · stale >${age}d ${stale}`;
const noteHeap = (freed: string) => `Heap GC freed ${freed}`;
const noteNothing = (age: number, includeSessions: boolean) =>
  `Nothing older than ${age}d to sweep${includeSessions ? "" : NOTHING_HINT}`;
const targetLine = (label: string, files: number, size: string) => `${label}: ${files} files, ${size}`;
const confirmBody = (age: number, list: string, files: number, size: string) =>
  `Older than ${age} days:\n${list}\n\nTotal ${files} files, ${size}. This cannot be undone.`;
const noteSwept = (files: number, size: string) => `Swept ${files} files, ${size}`;

async function refresh(ctx: ExtensionContext | undefined): Promise<void> {
  try {
    await scan();
  } catch {
    // Scan failures must never disturb the agent turn.
  }
  publish(ctx ?? state.ctx);
}

function runGc(): number {
  const before = process.memoryUsage().heapUsed;
  let gc = (globalThis as { gc?: () => void })[GC_GLOBAL];
  if (!gc) {
    try {
      v8.setFlagsFromString(EXPOSE_GC_FLAG);
      gc = vm.runInNewContext(GC_GLOBAL) as () => void;
    } catch {}
  }
  gc?.();
  return Math.max(0, before - process.memoryUsage().heapUsed);
}

function start(): void {
  if (state.timer) return;
  // unref: this must never be the reason a pi session refuses to exit.
  state.timer = setInterval(() => void refresh(undefined), loadConfig().tick_ms);
  state.timer.unref?.();
  void refresh(undefined);
}

function stop(): void {
  if (state.timer) clearInterval(state.timer);
  state.timer = undefined;
}

export default function gcAssets(pi: ExtensionAPI): void {
  registerReplay(pi);

  pi.on(PI_EVENT.SESSION_START, async (_event, ctx) => {
    state.ctx = ctx;
    publish(ctx);
    start();
  });

  pi.on(PI_EVENT.TURN_END, async (_event, ctx) => {
    state.ctx = ctx;
    publish(ctx);
  });

  pi.on(PI_EVENT.SESSION_SHUTDOWN, async (event) => {
    state.ctx = undefined;
    if (event.reason === QUIT) stop();
  });

  pi.registerCommand(COMMAND_NAME, {
    description: COMMAND_DESCRIPTION,
    handler: async (args, ctx) => {
      state.ctx = ctx;
      const [action = ACTION_STATUS, arg] = args.trim().toLowerCase().split(/\s+/);

      if (action === ACTION_STATUS || action === ACTION_SCAN) {
        await refresh(ctx);
        const total = state.categories.reduce((sum, c) => sum + c.bytes, 0);
        ctx.ui.notify(noteAssets(formatBytes(total), ageDays(), formatBytes(state.categories.reduce((sum, c) => sum + c.staleBytes, 0))), NOTE_INFO);
        return;
      }

      if (action === ACTION_HEAP) {
        const freed = runGc();
        state.lastGc = { at: Date.now(), freedBytes: freed };
        publish(ctx);
        ctx.ui.notify(noteHeap(formatBytes(freed)), NOTE_INFO);
        return;
      }

      if (action === ACTION_AGE) {
        const days = Number(arg);
        if (!Number.isFinite(days) || days < 0) {
          ctx.ui.notify(NOTE_AGE_USAGE, NOTE_WARNING);
          return;
        }
        state.ageDays = days;
        await refresh(ctx);
        return;
      }

      if (action === ACTION_HIDE) {
        setPanelVisible(false);
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        return;
      }

      if (action === ACTION_SHOW) {
        setPanelVisible(true);
        await refresh(ctx);
        return;
      }

      if (action === ACTION_SWEEP) {
        await refresh(ctx);
        const age = ageDays();
        const includeSessions = arg === ARG_SESSIONS;
        const targets = state.categories.filter((c) => c.staleFiles > 0 && (c.sweep === SWEEP_AUTO || (includeSessions && c.sweep === SWEEP_CONFIRM)));
        const files = targets.reduce((sum, c) => sum + c.staleFiles, 0);
        const bytes = targets.reduce((sum, c) => sum + c.staleBytes, 0);
        if (files === 0) {
          ctx.ui.notify(noteNothing(age, includeSessions), NOTE_INFO);
          return;
        }
        const list = targets.map((c) => targetLine(c.label, c.staleFiles, formatBytes(c.staleBytes))).join("\n");
        if (!(await ctx.ui.confirm(CONFIRM_TITLE, confirmBody(age, list, files, formatBytes(bytes))))) return;
        const done = await sweep(targets, age);
        state.lastSweep = { at: Date.now(), ...done };
        runGc();
        await refresh(ctx);
        ctx.ui.notify(noteSwept(done.files, formatBytes(done.bytes)), NOTE_INFO);
        return;
      }

      ctx.ui.notify(NOTE_USAGE, NOTE_WARNING);
    },
  });
}
