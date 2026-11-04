import { appendFileSync } from "fs";

/** One line per `claude` subprocess, written only when PI_CLAUDE_CLI_USAGE_LOG names a file. */
export interface SpawnUsageRecord {
  ts: string;
  model: string;
  /** Internal API round trips Claude Code made inside this one subprocess. */
  apiTurns: number | undefined;
  durationMs: number | undefined;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  costUsd: number | undefined;
  /** Size of what Pi sends in on every spawn, in characters. */
  appendChars: number;
  schemaChars: number;
  toolDefChars: number;
  tools: number;
  historyMessages: number;
}

export function writeUsageRecord(record: SpawnUsageRecord, path = process.env.PI_CLAUDE_CLI_USAGE_LOG): void {
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  } catch {
    /* diagnostics must never break a turn */
  }
}

/** Pull the per-spawn numbers out of a stream-json `result` event. */
export function recordFromResult(
  result: any,
  base: Omit<SpawnUsageRecord, "apiTurns" | "durationMs" | "input" | "cacheWrite" | "cacheRead" | "output" | "costUsd">,
): SpawnUsageRecord {
  const u = result?.usage ?? {};
  return {
    ...base,
    apiTurns: result?.num_turns,
    durationMs: result?.duration_ms,
    input: u.input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    costUsd: result?.total_cost_usd,
  };
}
