import v8 from "node:v8";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRightPanel } from "../core/right-panel.ts";
import { ageDays, state } from "./scanner.ts";

// --- Constants: every local literal lives here. ---

export const WIDGET_KEY = "gc-assets";
const PLACEMENT = "aboveEditor";
const BYTE_SUFFIX = "B";
const UNITS = ["K", "M", "G", "T"];
const BAR_FILLED = "█";
const BAR_EMPTY = "░";
const TONE_ERROR = "error";
const TONE_WARNING = "warning";
const TONE_SUCCESS = "success";
const TONE_DIM = "dim";
const TONE_ACCENT = "accent";
const TITLE = "Memory & Assets";
const TAB_ID = "memory";
const TAB_LABEL = "Memory";
const TAB_ORDER = 1;
const TRUNCATED_MARK = "+";
const LABEL_WIDTH = 11;
const SIZE_WIDTH = 5;
const NOTE_SCANNING = "scanning assets…";
const NOTE_NO_SCAN = "no scan yet · /gc scan";
const heapLine = (bar: string, used: string, limit: string) => `HEAP ${bar} ${used}/${limit}`;
const rssLine = (rss: string) => `RSS  ${rss}  `;
const extLabel = (external: string) => `ext ${external}`;
const categoryCounts = (files: number, more: string) => `${files}${more}f`;
const staleMark = (size: string) => ` ⟳${size}`;
const staleSummary = (age: number, size: string) => `stale >${age}d: ${size} · /gc sweep`;
const gcLine = (size: string) => `gc ${size} freed`;
const sweptLine = (files: number, size: string) => `swept ${files}f · ${size}`;

export function formatBytes(value: number): string {
  if (value < 1024) return `${value}${BYTE_SUFFIX}`;
  let n = value / 1024;
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)}${UNITS[i]}`;
}

function bar(ctx: ExtensionContext, percent: number, width = 10): string {
  const bounded = Math.max(0, Math.min(100, percent));
  const filled = Math.round((bounded / 100) * width);
  const tone = bounded >= 90 ? TONE_ERROR : bounded >= 70 ? TONE_WARNING : TONE_SUCCESS;
  return ctx.ui.theme.fg(tone, BAR_FILLED.repeat(filled)) + ctx.ui.theme.fg(TONE_DIM, BAR_EMPTY.repeat(width - filled));
}

function memory() {
  const usage = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return { rss: usage.rss, heapUsed: usage.heapUsed, heapLimit: heap.heap_size_limit, external: usage.external + usage.arrayBuffers };
}

function panel(ctx: ExtensionContext): string[] {
  const theme = ctx.ui.theme;
  const mem = memory();
  const age = ageDays();
  const heapPercent = (mem.heapUsed / mem.heapLimit) * 100;
  const lines = [
    theme.fg(TONE_ACCENT, TITLE),
    heapLine(bar(ctx, heapPercent), formatBytes(mem.heapUsed), formatBytes(mem.heapLimit)),
    rssLine(formatBytes(mem.rss)) + theme.fg(TONE_DIM, extLabel(formatBytes(mem.external))),
  ];
  if (state.categories.length === 0) {
    lines.push(theme.fg(TONE_DIM, state.scanning ? NOTE_SCANNING : NOTE_NO_SCAN));
    return lines;
  }
  let reclaimable = 0;
  for (const category of state.categories) {
    reclaimable += category.staleBytes;
    const stale = category.staleBytes > 0 ? theme.fg(TONE_WARNING, staleMark(formatBytes(category.staleBytes))) : "";
    const more = category.truncated ? TRUNCATED_MARK : "";
    lines.push(`${category.label.padEnd(LABEL_WIDTH)} ${formatBytes(category.bytes).padStart(SIZE_WIDTH)} ${theme.fg(TONE_DIM, categoryCounts(category.files, more))}${stale}`);
  }
  lines.push(theme.fg(reclaimable > 0 ? TONE_WARNING : TONE_DIM, staleSummary(age, formatBytes(reclaimable))));
  if (state.lastGc) lines.push(theme.fg(TONE_DIM, gcLine(formatBytes(state.lastGc.freedBytes))));
  if (state.lastSweep) lines.push(theme.fg(TONE_DIM, sweptLine(state.lastSweep.files, formatBytes(state.lastSweep.bytes))));
  return lines;
}

let panelContext: ExtensionContext | undefined;
let unregisterPanel: (() => void) | undefined;
let panelVisible = true;

export function setPanelVisible(visible: boolean): void {
  panelVisible = visible;
  if (!visible) {
    unregisterPanel?.();
    unregisterPanel = undefined;
  } else if (panelContext) {
    publish(panelContext);
  }
}

export function publish(ctx: ExtensionContext | undefined): void {
  if (!ctx) return;
  panelContext = ctx;
  if (panelVisible) unregisterPanel ??= getRightPanel().registerTab({
    id: TAB_ID,
    label: TAB_LABEL,
    order: TAB_ORDER,
    lines: () => (panelContext ? panel(panelContext) : []),
  });
  try {
    // The right-panel tab owns this content; keep the widget mounted there instead.
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  } catch {
    // The context goes stale across session replacement; the next event refreshes it.
  }
}
