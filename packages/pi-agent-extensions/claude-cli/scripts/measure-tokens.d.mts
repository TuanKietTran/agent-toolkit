export interface Turn {
  tools: string[];
  textChars: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  costUsd: number;
  error?: string;
  apiTurns?: number;
  wallMs?: number;
}
export interface Totals {
  turns: number;
  toolCalls: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  costUsd: number;
  apiTurns: number;
  wallMs: number;
}
export interface Outcome {
  editApplied: boolean;
  notesWritten: boolean;
  testsPass: boolean;
}
export interface Run {
  code: number | null;
  turns: Turn[];
  totals: Totals;
  outcome?: Outcome;
  sizes?: Record<string, number>;
}
export const SCENARIO_STEPS: string[];
export const SCENARIO_PROMPT: string;
export const TOOL_EXTENSIONS: string[];
export function createScratchRepo(): string;
export function verifyScratchRepo(dir: string): Outcome;
export function collectTurns(lines: string[]): Turn[];
export function totals(turns: Turn[]): Totals;
export function renderReport(label: string, model: string, runs: Run[]): string;
