import type { PacingOptions } from "./contract.ts";

export type { PacingOptions };
export const DEFAULT_PACING: PacingOptions = { minDelayMs: 150, maxDelayMs: 700, minGapMs: 400 };
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Pacer {
  private chain: Promise<void> = Promise.resolve();
  private lastEnd = 0;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly minGapMs: number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;
  constructor(opts?: Partial<PacingOptions>) {
    this.minDelayMs = opts?.minDelayMs ?? DEFAULT_PACING.minDelayMs;
    this.maxDelayMs = opts?.maxDelayMs ?? DEFAULT_PACING.maxDelayMs;
    this.minGapMs = opts?.minGapMs ?? DEFAULT_PACING.minGapMs;
    this.sleepFn = opts?.sleep ?? realSleep;
    this.randomFn = opts?.random ?? Math.random;
  }
  async pace(): Promise<void> {
    const span = Math.max(0, this.maxDelayMs - this.minDelayMs);
    const delay = this.minDelayMs + this.randomFn() * span;
    const gapWait = this.lastEnd > 0 ? Math.max(0, this.minGapMs - (performance.now() - this.lastEnd)) : 0;
    const total = Math.max(delay, gapWait);
    if (total > 0) await this.sleepFn(total);
  }
  async wait(): Promise<void> { return this.pace(); }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.chain;
    this.chain = new Promise<void>((r) => { release = r; });
    await prev;
    try { await this.pace(); return await fn(); }
    finally { this.lastEnd = performance.now(); release(); }
  }
}

export function createPacer(opts?: Partial<PacingOptions>): Pacer { return new Pacer(opts); }
export function createPacing(opts?: Partial<PacingOptions>): Pacer { return new Pacer(opts); }
