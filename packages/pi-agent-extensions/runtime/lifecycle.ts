// Explicit execution state machine, pause gate and per-execution metrics. Pure module.
import type { ExecutionState } from "./events.ts";

export const TERMINAL_STATES: readonly ExecutionState[] = ["completed", "failed", "cancelled"];

const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  created: ["running", "failed", "cancelled"],
  running: ["waiting_for_tool", "paused", "completed", "failed", "cancelled"],
  waiting_for_tool: ["running", "paused", "completed", "failed", "cancelled"],
  paused: ["running", "waiting_for_tool", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  readonly from: ExecutionState;
  readonly to: ExecutionState;
  constructor(from: ExecutionState, to: ExecutionState) { super(`invalid execution transition ${from} -> ${to}`); this.name = "InvalidTransitionError"; this.from = from; this.to = to; }
}

export class ExecutionStateMachine {
  private current: ExecutionState = "created";
  readonly history: { state: ExecutionState; at: number; reason?: string }[] = [{ state: "created", at: Date.now() }];
  get state(): ExecutionState { return this.current; }
  get terminal(): boolean { return TERMINAL_STATES.includes(this.current); }
  /** Returns the previous state, or undefined when `to` equals the current state. Throws on an illegal transition. */
  transition(to: ExecutionState, reason?: string): ExecutionState | undefined {
    if (to === this.current) return undefined;
    if (!canTransition(this.current, to)) throw new InvalidTransitionError(this.current, to);
    const previous = this.current;
    this.current = to;
    this.history.push({ state: to, at: Date.now(), reason });
    return previous;
  }
}

/**
 * Pause gate. `wait()` resolves immediately while open; while paused it resolves on `resume()`,
 * or with "aborted" when the given signal aborts or `cancel()` is called.
 */
export class PauseGate {
  private paused = false;
  private waiters = new Set<(outcome: "resumed" | "aborted") => void>();
  get isPaused(): boolean { return this.paused; }
  get waiting(): number { return this.waiters.size; }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.release("resumed"); }
  /** Releases every waiter as aborted and opens the gate. */
  cancel(): void { this.paused = false; this.release("aborted"); }
  private release(outcome: "resumed" | "aborted"): void { const ws = [...this.waiters]; this.waiters.clear(); for (const w of ws) w(outcome); }
  async wait(signal?: AbortSignal, onHold?: () => void): Promise<"open" | "resumed" | "aborted"> {
    if (!this.paused) return "open";
    if (signal?.aborted) return "aborted";
    onHold?.();
    return await new Promise((resolve) => {
      const done = (outcome: "resumed" | "aborted") => { signal?.removeEventListener("abort", onAbort); this.waiters.delete(done); resolve(outcome); };
      const onAbort = () => done("aborted");
      this.waiters.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export interface ExecutionMetrics {
  executionId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: "completed" | "failed" | "cancelled";
  timeToFirstEventMs?: number;
  timeToFirstTokenMs?: number;
  toolCalls: number;
  toolFailures: number;
  toolLatencyMs: { count: number; mean: number; p95: number; max: number };
  browserActions: number;
  browserActionFailures: number;
  verifiedActions: number;
  unverifiedActions: number;
  /** Tool calls repeating an earlier call's name and arguments in the same execution. */
  retries: number;
  pausedMs: number;
}

const BROWSER_TOOLS = new Set(["tab_open", "navigate", "click", "type", "press", "select", "scroll", "upload", "wait_for", "tab_close", "mac_browser_act", "mac_browser_tabs"]);

export class MetricsRecorder {
  private latencies: number[] = [];
  private seenCalls = new Set<string>();
  private pausedSince?: number;
  readonly m: ExecutionMetrics;
  constructor(executionId: string, startedAt = Date.now()) {
    this.m = { executionId, startedAt, toolCalls: 0, toolFailures: 0, toolLatencyMs: { count: 0, mean: 0, p95: 0, max: 0 }, browserActions: 0, browserActionFailures: 0, verifiedActions: 0, unverifiedActions: 0, retries: 0, pausedMs: 0 };
  }
  firstEvent(at = Date.now()): void { this.m.timeToFirstEventMs ??= at - this.m.startedAt; }
  firstToken(at = Date.now()): void { this.m.timeToFirstTokenMs ??= at - this.m.startedAt; this.firstEvent(at); }
  toolStarted(name: string, args: unknown): void {
    this.m.toolCalls++;
    const key = name + ":" + stableJson(args);
    if (this.seenCalls.has(key)) this.m.retries++;
    this.seenCalls.add(key);
  }
  toolEnded(name: string, durationMs: number, failed: boolean, verified?: boolean): void {
    this.latencies.push(durationMs);
    if (failed) this.m.toolFailures++;
    if (BROWSER_TOOLS.has(name)) {
      this.m.browserActions++;
      if (failed) this.m.browserActionFailures++;
      if (verified === true) this.m.verifiedActions++;
      else if (verified === false) this.m.unverifiedActions++;
    }
    const sorted = [...this.latencies].sort((a, b) => a - b);
    this.m.toolLatencyMs = { count: sorted.length, mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length), p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], max: sorted[sorted.length - 1] };
  }
  paused(at = Date.now()): void { this.pausedSince ??= at; }
  resumed(at = Date.now()): void { if (this.pausedSince != null) { this.m.pausedMs += at - this.pausedSince; this.pausedSince = undefined; } }
  end(outcome: ExecutionMetrics["outcome"], at = Date.now()): void { this.resumed(at); this.m.outcome = outcome; this.m.endedAt = at; }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.keys(value as object).sort().map((k) => JSON.stringify(k) + ":" + stableJson((value as Record<string, unknown>)[k])).join(",") + "}";
}
