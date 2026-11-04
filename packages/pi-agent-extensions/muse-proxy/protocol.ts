/**
 * Text tool protocol for Muse.
 *
 * Muse refuses a "harness" framing and client-supplied tool definitions, but it
 * reliably follows a plain request to write one line per action when the user
 * says they will run it and paste the output back. Calls are captured from
 * `@@RUN {"name":...,"arguments":{...}}` lines (a `<run>{...}</run>` block is
 * accepted too) and pi runs them.
 */

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface RunCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedRuns {
  /** Text with the call markers removed. */
  text: string;
  calls: RunCall[];
  /** Human-readable problems the model can be asked to fix. */
  errors: string[];
}

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  description?: string;
}

function typeLabel(schema: Schema | undefined): string {
  if (!schema) return "any";
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 8) {
    return schema.enum.map((value) => JSON.stringify(value)).join("|");
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (union?.length) return [...new Set(union.map(typeLabel))].join("|");
  const type = Array.isArray(schema.type) ? schema.type.join("|") : schema.type;
  if (type === "array") return `${typeLabel(schema.items)}[]`;
  return type ?? "any";
}

export function signature(tool: ToolDef): string {
  const schema = (tool.parameters ?? {}) as Schema;
  const required = new Set(schema.required ?? []);
  const args = Object.entries(schema.properties ?? {}).map(
    ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${typeLabel(value)}`,
  );
  return `${tool.name}(${args.join(", ")})`;
}

function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.search(/(?<=[.!?])\s/);
  const sentence = cut > 0 ? flat.slice(0, cut) : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export function renderTools(tools: ToolDef[], descChars = 140): string {
  return tools
    .map((tool) => {
      const description = firstSentence(tool.description ?? "", descChars);
      return description ? `- ${signature(tool)} - ${description}` : `- ${signature(tool)}`;
    })
    .join("\n");
}

/** Index just past the JSON object that starts at `start`, or -1. */
function endOfJsonObject(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

function validate(raw: string, tools: Map<string, ToolDef>): RunCall | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `not valid JSON: ${raw.slice(0, 80)}`;
  }
  const call = parsed as { name?: unknown; arguments?: unknown };
  if (!call || typeof call.name !== "string") return 'missing "name"';
  const tool = tools.get(call.name);
  if (!tool) return `unknown tool "${call.name}" (available: ${[...tools.keys()].join(", ")})`;
  const args = call.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return `"arguments" for ${call.name} must be an object`;
  }
  const schema = (tool.parameters ?? {}) as Schema;
  const missing = (schema.required ?? []).filter((key) => !(key in (args as object)));
  if (missing.length > 0) return `${call.name} is missing required argument(s): ${missing.join(", ")}`;
  return { name: call.name, arguments: args as Record<string, unknown> };
}

export function parseRuns(text: string, tools: ToolDef[]): ParsedRuns {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const calls: RunCall[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  let remaining = "";

  const accept = (raw: string) => {
    const result = validate(raw, byName);
    if (typeof result === "string") { errors.push(result); return; }
    const key = `${result.name}\u0000${JSON.stringify(result.arguments)}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push(result);
  };

  let cursor = 0;
  const marker = /@@RUN\b[ \t]*/g;
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    remaining += text.slice(cursor, match.index);
    const start = match.index + match[0].length;
    if (text[start] !== "{") { errors.push("@@RUN must be followed by a JSON object"); cursor = start; marker.lastIndex = start; continue; }
    const end = endOfJsonObject(text, start);
    if (end < 0) { errors.push("unterminated JSON after @@RUN"); cursor = text.length; marker.lastIndex = text.length; break; }
    accept(text.slice(start, end));
    cursor = end;
    marker.lastIndex = end;
  }
  remaining += text.slice(cursor);

  remaining = remaining.replace(/<run>([\s\S]*?)<\/run>/g, (_all, body: string) => {
    accept(body.trim());
    return "";
  });

  return { text: remaining.replace(/\n{3,}/g, "\n\n").trim(), calls, errors };
}

export const FORMAT_REMINDER =
  'Reply again using exactly one line per call: @@RUN {"name":"<tool>","arguments":{...}} (JSON on one line, exact tool and argument names), or answer in plain text if no tool is needed.';

export function correctionMessage(errors: string[]): string {
  return `I could not run your request: ${errors.join("; ")}.\n${FORMAT_REMINDER}`;
}
