/**
 * Pure helpers for the `opencode run --format json` event stream.
 *
 * Observed events (opencode 2.2.5): `step_start`, `text`, `tool_use`,
 * `step_finish` (carries `reason`, `cost`, `tokens`) and `error`. The schema is
 * undocumented upstream, so every accessor is defensive and unknown events are
 * ignored rather than treated as failures.
 */

export interface TurnUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export type TurnAction =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "stepFinish"; reason: string }
  | { kind: "error"; message: string; retryAfterMs?: number }
  | { kind: "none" };

export function parseEventLine(line: string): any | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function newUsage(): TurnUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Fold one event into `usage` (steps accumulate) and say what the caller should do. */
export function applyEvent(ev: any, usage: TurnUsage): TurnAction {
  if (!ev || typeof ev !== "object") return { kind: "none" };

  switch (ev.type) {
    case "text": {
      const text = ev.part?.text;
      return typeof text === "string" && text ? { kind: "text", text } : { kind: "none" };
    }
    case "reasoning":
    case "thinking": {
      const text = ev.part?.text ?? ev.part?.thinking;
      return typeof text === "string" && text ? { kind: "thinking", text } : { kind: "none" };
    }
    case "step_finish": {
      const part = ev.part ?? {};
      const tokens = part.tokens ?? {};
      usage.input += num(tokens.input);
      usage.output += num(tokens.output);
      usage.reasoning += num(tokens.reasoning);
      usage.cacheRead += num(tokens.cache?.read);
      usage.cacheWrite += num(tokens.cache?.write);
      usage.cost += num(part.cost);
      return { kind: "stepFinish", reason: typeof part.reason === "string" ? part.reason : "" };
    }
    case "error": {
      const err = ev.error ?? {};
      const retry = typeof err.retryAfterMs === "number" ? err.retryAfterMs : undefined;
      let message = typeof err.message === "string" ? err.message : "opencode reported an error";
      if (retry !== undefined) message += ` (retry after ${formatDuration(retry)})`;
      return { kind: "error", message, retryAfterMs: retry };
    }
    default:
      return { kind: "none" };
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${Math.max(minutes, 1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export interface TextToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const TOOL_BLOCK = /<pi_tool_calls>\s*([\s\S]*?)\s*<\/pi_tool_calls>/g;

/**
 * Fallback protocol for models that do not reach the MCP bridge: the model
 * writes `<pi_tool_calls>[{"name":..,"arguments":{..}}]</pi_tool_calls>`.
 * Returns the text with the blocks removed plus the valid calls; calls naming
 * an inactive tool or carrying non-object arguments are dropped.
 */
export function extractTextToolCalls(
  text: string,
  activeNames: ReadonlySet<string>,
): { text: string; calls: TextToolCall[] } {
  const calls: TextToolCall[] = [];
  const stripped = text.replace(TOOL_BLOCK, (_match, body: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return "";
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const call = item as { name?: unknown; arguments?: unknown };
      if (!call || typeof call.name !== "string" || !activeNames.has(call.name)) continue;
      const args = call.arguments ?? {};
      if (typeof args !== "object" || args === null || Array.isArray(args)) continue;
      calls.push({ name: call.name, arguments: args as Record<string, unknown> });
    }
    return "";
  });
  return { text: stripped.trim(), calls };
}

/** Drop repeated identical calls: models retry when a capture reply looks odd. */
export function dedupeCalls<T extends { name: string; arguments: unknown }>(calls: T[]): T[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.name}\u0000${JSON.stringify(call.arguments)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Native OpenCode tools denied for every run; Pi owns tool execution. */
export const NATIVE_TOOLS = [
  "bash", "shell", "edit", "write", "patch", "apply_patch", "glob", "grep", "list",
  "webfetch", "websearch", "skill", "subagent", "task", "question",
  "todowrite", "todoread", "lsp", "external_directory",
] as const;

export type ReadPermission = "ask" | "deny";

/**
 * Agent permission map: everything native is denied except `execute` (the only
 * route to MCP tools in OpenCode 2.x). `read` defaults to "ask", which a
 * non-interactive run auto-rejects: the tool stays listed but can never run.
 * Set PI_OPENCODE_READ=deny to remove it entirely.
 */
export function buildPermissions(read: ReadPermission = "ask"): Record<string, string> {
  const permission: Record<string, string> = {};
  for (const name of NATIVE_TOOLS) permission[name] = "deny";
  permission.read = read;
  permission.execute = "allow";
  return permission;
}
